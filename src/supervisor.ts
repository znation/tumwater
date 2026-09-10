import { spawn } from "node:child_process";
import { RESTART_EXIT_CODE } from "./redeploy.js";

/** The respawn loop behind `tumwater run`. The command runs as two processes: this supervisor
 * (the one the operator started, holding the terminal) and a child that actually runs the
 * orchestrator. When the child rebuilt dist/ onto a newer main (redeploy.ts) it exits
 * RESTART_EXIT_CODE and the supervisor respawns it — the same script path, now holding the new
 * code — so a self-hosting fleet picks up its own changes without anyone at the keyboard. Any
 * other exit ends the supervisor with the child's code. Ctrl+C reaches both processes from the
 * terminal (same foreground group), so the supervisor forwards only SIGTERM, which a plain `kill`
 * delivers to it alone. */

/** Marks the child: `tumwater run` with this set runs the orchestrator instead of supervising. */
export const SUPERVISED_ENV = "TUMWATER_SUPERVISED";

/** Respawns within this window count toward the crash-loop guard. */
export const RESPAWN_WINDOW_MS = 60_000;
/** More rapid respawns than this in one window and the supervisor gives up (exit 1) — a new
 * build that restarts itself in a tight loop must not spin forever unattended. */
export const MAX_RAPID_RESPAWNS = 5;

export interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface SuperviseOptions {
  /** Start one child generation; resolves when it exits. `signal` aborts when the supervisor
   * was asked to stop (SIGTERM) — the implementation should terminate the child then. */
  spawnChild(signal: AbortSignal): Promise<ChildExit>;
  /** True once the operator asked the supervisor to stop: a restart request arriving after
   * that is honored as a plain exit, not a respawn. */
  stopping(): boolean;
  /** Called before each respawn with the generation number (2 for the first respawn). */
  onRespawn?(generation: number): void;
  /** Called when the crash-loop guard trips. */
  onCrashLoop?(): void;
  now?(): number;
}

/** The exit code a child's ChildExit maps to: its own code when it exited normally, or 1
 * when it died by signal (code null) — a killed child must not read as success. */
function exitCodeOf(exit: ChildExit): number {
  return exit.code ?? 1;
}

/** Run child generations until one exits with something other than a restart request, and
 * return the code the supervisor should exit with. Pure apart from the injected effects. */
export async function superviseRun(opts: SuperviseOptions, signal: AbortSignal): Promise<number> {
  const now = opts.now ?? Date.now;
  let generation = 1;
  const recentRespawns: number[] = [];
  for (;;) {
    const exit = await opts.spawnChild(signal);
    if (exit.code !== RESTART_EXIT_CODE || opts.stopping()) return exitCodeOf(exit);
    const t = now();
    while (recentRespawns.length > 0 && t - (recentRespawns[0] ?? t) > RESPAWN_WINDOW_MS) recentRespawns.shift();
    recentRespawns.push(t);
    if (recentRespawns.length > MAX_RAPID_RESPAWNS) {
      opts.onCrashLoop?.();
      return 1;
    }
    generation += 1;
    opts.onRespawn?.(generation);
  }
}

/** The production child spawner: the same node binary and cli.js script as this process with
 * `run` as the command, stdio shared (the child's event stream is what the operator sees), and
 * SUPERVISED_ENV set so it runs the orchestrator instead of supervising again. */
export function spawnRunChild(signal: AbortSignal): Promise<ChildExit> {
  return new Promise((resolve) => {
    const script = process.argv[1];
    if (!script) {
      resolve({ code: 1, signal: null });
      return;
    }
    const child = spawn(process.execPath, [script, "run"], {
      stdio: "inherit",
      env: { ...process.env, [SUPERVISED_ENV]: "1" },
    });
    const onAbort = () => child.kill("SIGTERM");
    signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", () => {
      signal.removeEventListener("abort", onAbort);
      resolve({ code: 1, signal: null });
    });
    child.on("exit", (code, sig) => {
      signal.removeEventListener("abort", onAbort);
      resolve({ code, signal: sig });
    });
  });
}
