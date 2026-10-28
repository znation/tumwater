import { spawn, type StdioOptions } from "node:child_process";
import { TUMWATER_SOURCE } from "../events/events.js";
import type { HarnessEventInput } from "../events/events.js";
import { RESTART_EXIT_CODE } from "../redeploy/redeploy-policy.js";
import { childEnv, runOnAbort } from "./process.js";
import { liveNodeBin } from "./node-bin.js";
import { parsePositiveInt } from "../text/text.js";

/** The respawn loop behind `tumwater start`. The command runs as two processes: this supervisor
 * (the one the operator started, holding the terminal) and a child that runs the orchestrator.
 * When the child rebuilt dist/ onto a newer main (src/redeploy/redeployer.ts) it exits
 * RESTART_EXIT_CODE and the supervisor respawns it — the same script path, now holding the new
 * code — so a self-hosting team picks up its own changes without anyone at the keyboard. Any
 * other exit ends the supervisor with the child's code — and when nobody asked for it, the team
 * is down with nobody at the keyboard either, so that exit is recorded first (onTeamDown). Ctrl+C
 * reaches both processes from the terminal (same foreground group), so the supervisor forwards only
 * SIGTERM, which a plain `kill` delivers to it alone. */

/** Marks the child: `tumwater start` with this set runs the orchestrator instead of supervising. */
export const SUPERVISED_ENV = "TUMWATER_SUPERVISED";

/** Names the supervisor's pid in a supervised child's environment, so the child's parent-death
 * watch compares against the pid the spawner handed down instead of its own first read. A
 * supervisor killed before that read — a SIGKILL during the child's startup, before the watch
 * arms — still counts as gone (the dashboard's DASHBOARD_CHILD_ENV carries the same mark for its
 * reload watch). */
export const SUPERVISOR_PID_ENV = "TUMWATER_SUPERVISOR_PID";

/** Marks a `run --for` window's start (epoch ms), set once by the supervisor and handed to every
 * orchestrator generation, so a self-redeploy continues the window instead of opening a new one. */
export const RUN_WINDOW_START_ENV = "TUMWATER_RUN_WINDOW_START";

/** The exit code of a `run --once` round that finished and found failed runs
 * (onceFailures in src/cli/cli-start-summary.ts): an asked-for ending, so the supervisor
 * passes it through without paging the team-down hook. */
export const ONCE_FAILED_EXIT_CODE = 3;

/** How often the supervised generation checks that its supervisor still lives (ms). */
const PARENT_POLL_MS = 5_000;

/** Registers the watch's poll and returns its stop. The default is an unref'd interval timer;
 * a test injects its own so the watch's verdict runs when the test drives the seam instead of
 * after a wall-clock budget. */
type ParentWatchPoll = (check: () => void) => () => void;

/** The default poll: `check` every `intervalMs`, on a timer unref'd so an idle watch never holds
 * the generation's event loop open. */
function intervalPoll(intervalMs: number): ParentWatchPoll {
  return (check) => {
    const timer = setInterval(check, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  };
}

interface ParentDeathWatchOptions {
  /** The parent-pid source; defaults to `process.ppid`. Tests inject a fake so the watch fires
   * without reparenting a real process. */
  ppid?: () => number;
  /** The poll interval for the default poll; defaults to PARENT_POLL_MS. */
  intervalMs?: number;
  /** The parent pid to expect, when the spawner handed it down: compared against instead of
   * the watch's own first read, so a parent that died before the watch started still counts
   * as gone. Defaults to the first `ppid()` read; when no expectation was handed down and
   * that first read is already 1 (PID 1 — launchd/init, never a real parent), the process
   * was reparented before the watch armed and is treated as orphaned immediately. */
  expectedPpid?: number;
  /** The poll seam; defaults to `intervalPoll(intervalMs)`. A test whose watch runs in another
   * process (where `t.mock.timers` cannot reach) injects a signal- or manually-driven poll, so
   * the verdict follows the test's advance rather than a real budget. */
  poll?: ParentWatchPoll;
}

/** Parent-death watch for the supervised generation. The supervisor forwards only SIGTERM —
 * SIGKILL (the OOM killer, `kill -9`) cannot be trapped or forwarded, and an uncaught supervisor
 * crash forwards nothing either — so a supervisor that dies outright leaves the generation
 * reparented (on macOS to launchd) and running the team unattended, with nothing left to sweep
 * it. The watch polls the parent pid on an interval: once it changes, the supervisor is gone
 * without having stopped the team, and `onGone` runs the same graceful stop a forwarded SIGTERM
 * would have run — a killed supervisor takes its team down with it. The timer is unref'd so it
 * never holds the generation's event loop open past its real work. Returns the stop that
 * disarms the watch (a no-op once it fired or was already stopped). */
export function startParentDeathWatch(onGone: () => void, opts: ParentDeathWatchOptions = {}): () => void {
  const ppid = opts.ppid ?? (() => process.ppid);
  const expectedGiven = opts.expectedPpid !== undefined;
  const original = expectedGiven ? opts.expectedPpid! : ppid();
  let cancel: (() => void) | undefined;
  let fired = false;
  // No expectation was handed down, so the baseline is the watch's own first read. A first
  // read of 1 (PID 1 — launchd/init, never a real parent) means the process was already
  // reparented before the watch armed: the shell that started it exited before this child's
  // first ppid read, the detached-`&` leak. There is no distinct parent left to watch, so
  // the child is already orphaned — fire immediately instead of pinning the baseline to 1,
  // where the watch could never observe a change. This is the same route the follow
  // commands' parent-death rule closes: a follow that cannot see a distinct parent ends now.
  if (!expectedGiven && original === 1) {
    fired = true;
    onGone();
    return () => {};
  }
  // Release the poll at most once: a fired watch, or an explicit stop, must leave nothing armed.
  const release = (): void => {
    const stopPoll = cancel;
    cancel = undefined;
    stopPoll?.();
  };
  const check = () => {
    // When an expectation was handed down, the first read may legitimately equal it even
    // when the parent is already gone (the expected pid is compared, not the first read);
    // otherwise the baseline IS the first read, so only a later change fires the watch.
    if (fired || ppid() === original) return;
    fired = true;
    release();
    onGone();
  };
  cancel = (opts.poll ?? intervalPoll(opts.intervalMs ?? PARENT_POLL_MS))(check);
  // A poll may run `check` synchronously while registering, firing before `cancel` was
  // assigned; release it now so such a watch still clears the poll it holds.
  if (fired) release();
  return () => {
    if (fired) return;
    fired = true;
    release();
  };
}

/** The supervisor pid a supervised child was handed, or undefined when the mark is absent or
 * names no process (a hex/exponent/whitespace spelling, or 1 — launchd/init, never a supervisor):
 * the watch's own first read stands instead. The mark is written as String(process.pid) (plain
 * decimal), so it is read by the shared plain-decimal rule, not Number()'s silent coercion. */
export function expectedSupervisorPid(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const mark = env[SUPERVISOR_PID_ENV];
  const pid = mark === undefined ? null : parsePositiveInt(mark);
  return pid !== null && pid > 1 ? pid : undefined;
}

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

/** Why supervision ended without the operator asking — what onTeamDown records. */
export interface TeamDown {
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
  /** Run exactly once after the loop ends, whatever ended it (a clean exit, a failure, a
   * crash loop, or an abort), before the supervisor returns — the production wiring restores a
   * build swap interrupted mid-rename so the next boot can load its own CLI
   * (build-stage.recoverInterruptedSwap). A hook that throws is ignored: the exit code must
   * stay the child's, and the hook's own reporting is its responsibility. */
  onDone?(): Promise<void> | void;
  /** Called — and awaited — right before the supervisor gives up on a team the operator did
   * not stop: a generation exited with a failure (not a restart request, not a clean exit, and not
   * while stopping) or the crash-loop guard tripped. Production logs a `supervisor_exit` event: on
   * 2026-09-22 a respawned generation exited "not initialized" and events.jsonl simply ended at the
   * previous generation's orchestrator_stop, 4 h 44 m of dead team with no trace (BUGS.md
   * 2026-09-23). A hook that throws is ignored — the trace is best-effort, and the exit code must
   * stay the child's. */
  onTeamDown?(down: TeamDown): Promise<void> | void;
  now?(): number;
}

/** The exit code a child's ChildExit maps to: its own code when it exited normally, or 1
 * when it died by signal (code null) — a killed child must not read as success. */
function exitCodeOf(exit: ChildExit): number {
  return exit.code ?? 1;
}

/** The code supervision must exit with when this generation ends it, or null when the
 * generation asked for a restart and the loop should respawn it. A restart request while the
 * operator is stopping is an asked-for ending, so it maps to the child's own code. */
function terminalExitCode(exit: ChildExit, stopping: boolean): number | null {
  if (exit.code === RESTART_EXIT_CODE && !stopping) return null;
  return exitCodeOf(exit);
}

/** Whether a terminal exit is a failure the operator did not ask for and so must be recorded
 * through onTeamDown: not a clean exit, not a `run --once` failed round, and not while stopping. */
function isUnaskedFailure(code: number, stopping: boolean): boolean {
  return code !== 0 && code !== ONCE_FAILED_EXIT_CODE && !stopping;
}

/** Record one respawn at `at`, drop the ones that aged out of RESPAWN_WINDOW_MS, and return
 * whether the rapid-respawn guard is now tripped. Mutates `recentRespawns`, the loop's window. */
function trackRespawn(recentRespawns: number[], at: number): boolean {
  while (recentRespawns.length > 0 && at - (recentRespawns[0] ?? at) > RESPAWN_WINDOW_MS) recentRespawns.shift();
  recentRespawns.push(at);
  return recentRespawns.length > MAX_RAPID_RESPAWNS;
}

/** Run a best-effort hook: a throwing hook must not change the supervisor's exit, so its error
 * is swallowed. Used for onTeamDown (the trace) and onDone (the build repair). */
async function runBestEffort(hook: (() => Promise<void> | void) | undefined): Promise<void> {
  try {
    await hook?.();
  } catch {
    // Best-effort: the hook's own reporting is its responsibility.
  }
}

/** Run child generations until one exits with something other than a restart request, and
 * return the code the supervisor should exit with. Pure apart from the injected effects. */
export async function superviseStart(opts: SuperviseOptions, signal: AbortSignal): Promise<number> {
  const now = opts.now ?? Date.now;
  let generation = 1;
  const recentRespawns: number[] = [];
  const teamDown = (down: TeamDown): Promise<void> => runBestEffort(() => opts.onTeamDown?.(down));
  try {
    for (;;) {
      const exit = await opts.spawnChild(signal);
      const stopping = opts.stopping();
      const terminal = terminalExitCode(exit, stopping);
      if (terminal !== null) {
        if (isUnaskedFailure(terminal, stopping)) await teamDown({ generation, exit, crashLoop: false });
        return terminal;
      }
      if (trackRespawn(recentRespawns, now())) {
        opts.onCrashLoop?.();
        await teamDown({ generation, exit, crashLoop: true });
        return 1;
      }
      generation += 1;
      opts.onRespawn?.(generation);
    }
  } finally {
    await runBestEffort(() => opts.onDone?.());
  }
}

/** The `supervisor_exit` event for a team that went down (see onTeamDown). `diagnosis` is the
 * startup gate re-asked after the death (startup-gates.ts's runStartupProblem): the likeliest
 * reason a generation dies right after a respawn is an environment that no longer boots, and the
 * child's own message reached only the terminal. Null when every precondition passes — the event
 * then carries no reason rather than a guess. A crash loop's reason is the guard itself. */
export function teamDownEvent(down: TeamDown, diagnosis: string | null): HarnessEventInput {
  const reason = down.crashLoop
    ? `restarted itself more than ${MAX_RAPID_RESPAWNS} times within ${RESPAWN_WINDOW_MS / 1000}s — giving up`
    : diagnosis;
  return {
    source: TUMWATER_SOURCE,
    type: "supervisor_exit",
    generation: down.generation,
    code: down.exit.code,
    ...(down.exit.signal ? { signal: down.exit.signal } : {}),
    ...(reason ? { reason } : {}),
  };
}

/** The production child spawner: the same node binary and cli.js script as this process with
 * `run` as the command — plus any flags the operator's original invocation carried (e.g.
 * `tumwater start --branch x`: the child IS the orchestrator generation, so it must target the
 * same branch) — stdio shared (the child's event stream is what the operator sees), and
 * SUPERVISED_ENV set so it runs the orchestrator instead of supervising again, plus
 * SUPERVISOR_PID_ENV naming this supervisor so the child's own parent-death watch fires even if
 * this process is killed before the child reads its first ppid. `env` carries extra marks, e.g.
 * RUN_WINDOW_START_ENV for a `--for` window. `stdio` defaults to `"inherit"` (the child's
 * event stream is what a plain `run` operator sees); `run --tui` passes silent stdio instead,
 * because the observer TUI owns the terminal and the child must not paint over its render. */
export function spawnStartChild(
  signal: AbortSignal,
  extraArgs: string[] = [],
  env: NodeJS.ProcessEnv = {},
  stdio: StdioOptions = "inherit",
): Promise<ChildExit> {
  // Spawn `run`, never `start`: the supervisor runs the build it started on, but each child
  // loads dist/src/cli.js, which a redeploy replaces with main's newest build. Every build from
  // the `start` rename on accepts `run`, and older builds accept only `run`, so `run` works
  // against whatever build the child meets, even after a rollback; spawning `start` would make
  // an updated supervisor's respawn fail with "unknown command" on a reverted build.
  return spawnSupervised(
    ["run", ...extraArgs],
    signal,
    {
      [SUPERVISED_ENV]: "1",
      [SUPERVISOR_PID_ENV]: String(process.pid),
      ...env,
    },
    stdio,
  );
}

/** The production dashboard spawner for `run --gui`: a `tumwater gui` child (on its defaults, or
 * on `--port <n>` when `extraArgs` carries the port), stdio shared so a terminal Ctrl+C reaches
 * it exactly as it reaches the orchestrator child — unless `--tui` is hosted, when the caller
 * passes silent stdio so the dashboard's `tumwater gui at http://…` banner cannot paint over the
 * observer TUI's full-screen render.
 * `env` carries the caller's mark — in production DASHBOARD_CHILD_ENV naming this supervisor's
 * pid — so the child's own reload watch (src/redeploy/self-reload.ts) both exits
 * RESTART_EXIT_CODE for a fresh generation on a redeploy and exits on its own if this supervisor
 * dies outright (SIGKILL, a crash), freeing the dashboard port. Deliberately not SUPERVISED_ENV:
 * the child must run `gui`, not supervise a team. Resolves like spawnStartChild — a failed spawn
 * is `{ code: 1, signal: null }` — so an EMFILE/ENOMEM here cannot throw an unhandled 'error'. */
export function spawnGuiChild(
  signal: AbortSignal,
  env: NodeJS.ProcessEnv = {},
  stdio: StdioOptions = "inherit",
  extraArgs: string[] = [],
): Promise<ChildExit> {
  return spawnSupervised(["gui", ...extraArgs], signal, env, stdio);
}

/** Spawn one supervised child (`commandArgs` after the cli.js script path) and resolve on its
 * exit, with the abort signal wiring and spawn-failure handling shared by spawnStartChild and
 * spawnGuiChild: the signal's abort sends SIGTERM, and a spawn that never starts resolves as a
 * failed exit instead of emitting an unhandled 'error'. */
function spawnSupervised(commandArgs: string[], signal: AbortSignal, env: NodeJS.ProcessEnv, stdio: StdioOptions = "inherit"): Promise<ChildExit> {
  return new Promise((resolve) => {
    const script = process.argv[1];
    if (!script) {
      resolve({ code: 1, signal: null });
      return;
    }
    const child = spawn(liveNodeBin(), [script, ...commandArgs], {
      stdio,
      env: childEnv(env),
    });
    // runOnAbort closes the register/abort race: an already-fired signal kills the child
    // now, so the dashboard never starts after a stop.
    const onAbort = () => child.kill("SIGTERM");
    runOnAbort(signal, onAbort);
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
