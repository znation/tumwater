import { spawn } from "node:child_process";
import type { HarnessEventInput } from "./events.js";
import { RESTART_EXIT_CODE } from "./redeploy.js";

/** The respawn loop behind `tumwater run`. The command runs as two processes: this supervisor
 * (the one the operator started, holding the terminal) and a child that actually runs the
 * orchestrator. When the child rebuilt dist/ onto a newer main (redeploy.ts) it exits
 * RESTART_EXIT_CODE and the supervisor respawns it — the same script path, now holding the new
 * code — so a self-hosting fleet picks up its own changes without anyone at the keyboard. Any
 * other exit ends the supervisor with the child's code — and when nobody asked for it, the fleet
 * is down with nobody at the keyboard either, so that exit is recorded first (onFleetDown). Ctrl+C
 * reaches both processes from the terminal (same foreground group), so the supervisor forwards
 * only SIGTERM, which a plain `kill` delivers to it alone. */

/** Marks the child: `tumwater run` with this set runs the orchestrator instead of supervising. */
export const SUPERVISED_ENV = "TUMWATER_SUPERVISED";

/** Respawns within this window count toward the crash-loop guard. */
export const RESPAWN_WINDOW_MS = 60_000;
/** More rapid respawns than this in one window and the supervisor gives up (exit 1) — a new
 * build that restarts itself in a tight loop must not spin forever unattended. */
export const MAX_RAPID_RESPAWNS = 5;

/** The exit of one supervised child generation: node's `child.on("exit")` pair, carried
 * together to exitCodeOf and the respawn decision. `code` is the exit status and is null when
 * the child died from a signal, which `signal` names (null on a normal exit). */
export interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** Why supervision ended without the operator asking — what onFleetDown records. */
export interface FleetDown {
  /** The generation whose exit ended it: 1 is the operator's own start, 2+ a respawn. */
  generation: number;
  exit: ChildExit;
  /** The crash-loop guard tripped: this generation asked for a restart, one too many that
   * minute. Otherwise it exited with a failure — a non-zero code or a signal death. */
  crashLoop: boolean;
}

interface SuperviseOptions {
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
  /** Called — and awaited — right before the supervisor gives up on a fleet the operator did not
   * stop: a generation exited with a failure (not a restart request, not a clean exit, and not
   * while stopping) or the crash-loop guard tripped. Production logs a `supervisor_exit` event:
   * on 2026-09-22 a respawned generation exited "not initialized" and events.jsonl simply ended
   * at the previous generation's orchestrator_stop, 4 h 44 m of dead fleet with no trace
   * (BUGS.md 2026-09-23). A hook that throws is ignored — the trace is best-effort, and the exit
   * code must stay the child's. */
  onFleetDown?(down: FleetDown): Promise<void> | void;
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
  const fleetDown = async (down: FleetDown): Promise<void> => {
    try {
      await opts.onFleetDown?.(down);
    } catch {
      // Best-effort (see onFleetDown): a trace that cannot be written must not change the exit.
    }
  };
  for (;;) {
    const exit = await opts.spawnChild(signal);
    if (exit.code !== RESTART_EXIT_CODE || opts.stopping()) {
      // A clean exit (a child stopped by its own SIGTERM logs orchestrator_stop) and anything
      // while the operator is stopping are asked-for endings; everything else is the fleet dying.
      if (exitCodeOf(exit) !== 0 && !opts.stopping()) await fleetDown({ generation, exit, crashLoop: false });
      return exitCodeOf(exit);
    }
    const t = now();
    while (recentRespawns.length > 0 && t - (recentRespawns[0] ?? t) > RESPAWN_WINDOW_MS) recentRespawns.shift();
    recentRespawns.push(t);
    if (recentRespawns.length > MAX_RAPID_RESPAWNS) {
      opts.onCrashLoop?.();
      await fleetDown({ generation, exit, crashLoop: true });
      return 1;
    }
    generation += 1;
    opts.onRespawn?.(generation);
  }
}

/** The `supervisor_exit` event for a fleet that went down (see onFleetDown). `diagnosis` is the
 * startup gate re-asked after the death (startup-gate.ts's runStartupProblem): the likeliest
 * reason a generation dies right after a respawn is an environment that no longer boots, and the
 * child's own message reached only the terminal. Null when every precondition passes — the event
 * then carries no reason rather than a guess. A crash loop's reason is the guard itself. */
export function fleetDownEvent(down: FleetDown, diagnosis: string | null): HarnessEventInput {
  const reason = down.crashLoop
    ? `restarted itself more than ${MAX_RAPID_RESPAWNS} times within ${RESPAWN_WINDOW_MS / 1000}s — giving up`
    : diagnosis;
  return {
    loop: "harness",
    type: "supervisor_exit",
    generation: down.generation,
    code: down.exit.code,
    ...(down.exit.signal ? { signal: down.exit.signal } : {}),
    ...(reason ? { reason } : {}),
  };
}

/** The production child spawner: the same node binary and cli.js script as this process with
 * `run` as the command — plus any flags the operator's original invocation carried (e.g.
 * `tumwater run --branch x`: the child IS the orchestrator generation, so it must target the
 * same branch) — stdio shared (the child's event stream is what the operator sees), and
 * SUPERVISED_ENV set so it runs the orchestrator instead of supervising again. */
export function spawnRunChild(signal: AbortSignal, extraArgs: string[] = []): Promise<ChildExit> {
  return new Promise((resolve) => {
    const script = process.argv[1];
    if (!script) {
      resolve({ code: 1, signal: null });
      return;
    }
    const child = spawn(process.execPath, [script, "run", ...extraArgs], {
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
