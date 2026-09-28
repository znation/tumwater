import { spawn } from "node:child_process";

// Type-only back-reference, the same shape build-check-events.ts uses: runScriptGroup's
// result carries the caller's run record (BuildCheckRun), and no runtime cycle is created —
// build-check.ts imports this module's runtime values, this file imports only the type.
import type { BuildCheckRun } from "./build-check.js";
import { signalTree, withoutLaunchServicesCheckIn } from "./process.js";

/** The detached process-group runner: runScriptGroup starts a command in its own process
 * group — exactly like pi — and settles exactly once, bounding a timed-out tree at its
 * deadline plus the SIGTERM → SIGKILL escalation grace. Split out of process.ts, whose other
 * residents (the exec helper, the liveness and process-table probes, the LaunchServices
 * preload) are generic child-process plumbing shared across the harness: this runner's only
 * runtime consumer is the build check (build-check.ts), and its result carries that caller's
 * run record, so it lives beside that boundary instead of inside the shared module. The
 * signals it escalates with come from process.ts's signalTree; the children it starts carry
 * withoutLaunchServicesCheckIn's preload, so its npm trees check in with launchservicesd
 * neither on macOS nor anywhere else. */

/** SIGTERM → SIGKILL escalation window once a run's timeout has FIRED: the whole process
 * group gets SIGTERM, and anything still alive this much later (a SIGTERM-trapping runner, a
 * wedged worker) is SIGKILLed — and the run settles then, whether or not the tree ever closed
 * its pipes, so a timed-out run is bounded at its deadline plus this grace. The default of
 * runBuildCheck's killGraceMs parameter (build-check.ts), which tests shrink — pinning that
 * the escalation is armed on timeout (never at spawn: a healthy run that merely outlasts the
 * grace period must run to completion), that a surviving grandchild is taken down before the
 * run settles, and that a tree the SIGTERM already took down does not wait out the grace. */
export const KILL_GRACE_MS = 10_000;

/** What one runScriptGroup attempt observed — enough for runBuildCheck to classify the
 * outcome exactly as execFile's rejection used to: how the process ended (exit code or
 * signal), whether the check's timeout fired, what the script printed, whether it never
 * spawned at all, and when it ran. */
interface ScriptGroupResult {
  code?: number;
  signal?: NodeJS.Signals;
  timedOut: boolean;
  spawnError?: NodeJS.ErrnoException;
  stdout: string;
  stderr: string;
  run: BuildCheckRun;
}

/** True while any process in the group led by `pid` still exists: a signal-0 probe of the
 * group, where EPERM still means a member exists. Local to runScriptGroup, whose timed-out
 * run settles on the whole group being gone, never on the leader's close alone. */
function groupAlive(pid: number | undefined): boolean {
  if (pid == null) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** How often a timed-out run re-probes its process group between the deadline's SIGTERM and
 * the grace's SIGKILL. Nothing else wakes the check when the last member goes: a grandchild
 * that finishes a SIGTERM handler after the leader closed, or one launchd has not yet reaped,
 * has no event of its own. */
const GROUP_POLL_MS = 50;

/** Run `cmd args` detached — its own process group, exactly like pi — and settle exactly once.
 * The timeout is enforced GROUP-WIDE, never against the direct child alone: execFileAsync's
 * `timeout` option signalled npm and nothing else, so everything below it (`node --test` → one
 * worker per file) survived and reparented to PID 1 for as long as twelve days (BUGS.md
 * 2026-09-21). Before the deadline the run settles on the process's close. When the deadline
 * fires the whole group gets SIGTERM, and the run settles as soon as nothing in the group is
 * left (probed on the leader's close and every GROUP_POLL_MS) — or at killGraceMs after the
 * deadline, after SIGKILLing whatever survived (a SIGTERM-trapping runner, a wedged worker, a
 * grandchild still holding the pipes, so the close never comes), whichever is first. A
 * timed-out check is therefore bounded at timeoutMs + killGraceMs of the harness's own clock
 * whatever its tree does, and its tree is gone when the caller sees the outcome: no teardown
 * overlaps the caller's retry or the next check. At settle the pipes are destroyed and the
 * child unref'd, so a descendant that escaped the group cannot keep the harness's handles open.
 * The escalation is armed when the deadline fires, never at spawn: a healthy check that merely
 * outlasts the grace period must run to completion (the 2026-09-22 review-gate catch — a timer
 * armed at spawn SIGKILLed every healthy check longer than KILL_GRACE_MS and misclassified it
 * as a timeout, freezing all merge-scope checks). The run's spawn and settle times, and how
 * late the deadline timer actually fired, come back as `run`: the harness's own clock is not
 * the wall clock whenever the host sleeps or the event loop stalls (see BuildCheckRun), and the
 * discrepancy must be visible rather than hidden behind the configured bound. Captured output
 * is capped at maxBuffer per stream (further chunks are dropped — classification reads the
 * tail), so a chatty script can neither wedge the check nor balloon memory. Never throws; a
 * spawn failure (npm missing from PATH) is reported as spawnError. */
export function runScriptGroup(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; killGraceMs: number; maxBuffer: number },
): Promise<ScriptGroupResult> {
  return new Promise((resolve) => {
    const spawnedAt = Date.now();
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      // The check's own npm, and every npm a suite's build-check tests start under it, would
      // otherwise each leak a launchservicesd port on macOS.
      env: withoutLaunchServicesCheckIn(process.env),
    });
    let settled = false;
    // Set when the deadline fires — its presence IS "timed out".
    let deadlineLateMs: number | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let groupPoll: NodeJS.Timeout | undefined;
    let stdout = "";
    let stderr = "";
    let stdoutSize = 0;
    let stderrSize = 0;
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutSize < opts.maxBuffer) {
        stdoutSize += chunk.length;
        stdout += chunk;
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrSize < opts.maxBuffer) {
        stderrSize += chunk.length;
        stderr += chunk;
      }
    });
    const finish = (result: Pick<ScriptGroupResult, "code" | "signal" | "spawnError">) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      clearTimeout(killTimer);
      clearInterval(groupPoll);
      const timedOut = deadlineLateMs !== undefined;
      if (timedOut) {
        // Nothing more is read once the deadline has fired: a pipe holder that escaped the
        // group (a setsid'd daemon) must not keep the harness's handles, or the harness
        // itself, alive.
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
      }
      const run: BuildCheckRun = { spawnedAt, settledAt: Date.now(), timeoutMs: opts.timeoutMs };
      if (timedOut) run.deadlineLateMs = deadlineLateMs;
      resolve({ ...result, timedOut, stdout, stderr, run });
    };
    const deadlineTimer = setTimeout(() => {
      // Wall-clock lateness, the same clock the callers' durationMs is measured on: a deadline
      // the host slept through, or an event loop too busy to run it, fires late by exactly this.
      deadlineLateMs = Math.max(0, Date.now() - spawnedAt - opts.timeoutMs);
      signalTree(child, "SIGTERM");
      // The SIGTERM took the whole tree down: settle as soon as the group is gone instead of
      // waiting out the grace.
      groupPoll = setInterval(() => {
        if (!groupAlive(child.pid)) finish({ signal: "SIGTERM" });
      }, GROUP_POLL_MS);
      killTimer = setTimeout(() => {
        signalTree(child, "SIGKILL");
        finish({ signal: "SIGTERM" });
      }, opts.killGraceMs);
    }, opts.timeoutMs);
    child.on("error", (err: NodeJS.ErrnoException) => {
      // Before the deadline this is the spawn failing (npm missing from PATH). After it, it can
      // only be a teardown signal that could not be delivered: the run is a timeout either way,
      // settled by the group probe or the grace timer.
      if (deadlineLateMs === undefined) finish({ spawnError: err });
    });
    child.on("close", (code, signal) => {
      if (deadlineLateMs === undefined) {
        finish({ code: code ?? undefined, signal: signal ?? undefined });
      } else if (!groupAlive(child.pid)) {
        finish({ signal: "SIGTERM" });
      }
      // Otherwise something in the group outlived the leader: the poll settles the run when it
      // goes, or the grace timer SIGKILLs it and settles the run then.
    });
  });
}
