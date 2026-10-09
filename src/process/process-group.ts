import { spawn, type ChildProcess } from "node:child_process";

// Type-only back-reference, the same shape build/build-check-events.ts uses: runScriptGroup's
// result carries the caller's run record (BuildCheckRun), and no runtime cycle is created —
// build/build-check.ts imports this module's runtime values, this file imports only the type.
import type { BuildCheckRun } from "../build/build-check.js";
import { releaseChildHandles, signalTree, withoutLaunchServicesCheckIn } from "./process.js";
import { errCode } from "../errno.js";

/** The detached process-group runner: runScriptGroup starts a command in its own process
 * group — exactly like pi — and settles exactly once, bounding a timed-out tree at its
 * deadline plus the SIGTERM → SIGKILL escalation grace. Split out of process.ts, whose other
 * residents (the exec helper, the liveness and process-table probes, the LaunchServices
 * preload) are generic child-process plumbing shared across the harness: this runner's two
 * runtime consumers both sit in the build boundary — the build check (build/build-check.ts)
 * and the lockfile install (build/dep-install.ts) — and its result carries the build check's
 * run record, so it lives beside that boundary instead of inside the shared module. The
 * signals it escalates with come from process.ts's signalTree; the children it starts carry
 * withoutLaunchServicesCheckIn's preload, so its npm trees check in with launchservicesd
 * neither on macOS nor anywhere else. */

/** SIGTERM → SIGKILL escalation window once a run's timeout has FIRED: the whole process
 * group gets SIGTERM, and anything still alive this much later (a SIGTERM-trapping runner, a
 * wedged worker) is SIGKILLed — and the run settles then, whether or not the tree ever closed
 * its pipes, so a timed-out run is bounded at its deadline plus this grace. The default of
 * runBuildCheck's killGraceMs parameter (build/build-check.ts), which tests shrink — pinning that
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
 * group, where EPERM still means a member exists. armGroupDeadline probes with it for both
 * detached-process-group runners (runScriptGroup and git-run's execGitBounded), whose
 * timed-out runs settle on the whole group being gone, never on the leader's close alone. */
export function groupAlive(pid: number | undefined): boolean {
  if (pid == null) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return errCode(err) === "EPERM";
  }
}

/** How often a timed-out run re-probes its process group between the deadline's SIGTERM and
 * the grace's SIGKILL. Nothing else wakes the check when the last member goes: a grandchild
 * that finishes a SIGTERM handler after the leader closed, or one launchd has not yet reaped,
 * has no event of its own. armGroupDeadline's poll, shared by runScriptGroup and
 * execGitBounded, re-probes at this cadence. */
export const GROUP_POLL_MS = 50;

/** The handle armGroupDeadline returns: the deadline's state plus the one call that clears
 * its timers on the caller's settle path. */
interface GroupDeadline {
  /** True once the timeout deadline's timer has fired. */
  fired(): boolean;
  /** Milliseconds the deadline fired late — the wall clock minus startedAt+timeoutMs — or
   * undefined while it has not fired. */
  lateMs(): number | undefined;
  /** Settle a timed-out run if the deadline fired and no group member remains; a no-op while
   * it has not fired. Call from the child's close handler: a SIGTERM-trapping grandchild can
   * outlive the leader, so the leader's close alone must not settle the run. */
  settleIfGone(): void;
  /** Clear the deadline, poll, and kill timers. Call from the caller's single settle path. */
  dispose(): void;
}

/** Arm the group-wide timeout on a detached process-group child: at timeoutMs the whole group
 * is SIGTERMed, and `onTimedOut` fires as soon as nothing in the group remains (probed every
 * GROUP_POLL_MS) or at killGraceMs after the deadline once whatever survived is SIGKILLed —
 * whichever comes first, so the run is bounded at timeoutMs + killGraceMs whatever the tree
 * does. `startedAt` is the run's spawn time, the basis for lateMs's wall-clock lateness. Both
 * detached-process-group runners — runScriptGroup here and git-run's execGitBounded — drive
 * their deadline through this one home, so the SIGTERM → poll → SIGKILL invariant cannot
 * drift between them. The caller's own settle path must be idempotent: the poll, the grace
 * timer, and settleIfGone can each invoke onTimedOut, and it must call dispose(). */
export function armGroupDeadline(
  child: ChildProcess,
  opts: { timeoutMs: number; killGraceMs: number; startedAt?: number; onTimedOut: () => void },
): GroupDeadline {
  const startedAt = opts.startedAt ?? Date.now();
  let lateMs: number | undefined;
  let deadlineTimer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  let groupPoll: NodeJS.Timeout | undefined;
  deadlineTimer = setTimeout(() => {
    // Wall-clock lateness, the same clock the callers' durationMs is measured on: a deadline
    // the host slept through, or an event loop too busy to run it, fires late by exactly this.
    lateMs = Math.max(0, Date.now() - startedAt - opts.timeoutMs);
    signalTree(child, "SIGTERM");
    // The SIGTERM took the whole tree down: settle as soon as the group is gone instead of
    // waiting out the grace.
    groupPoll = setInterval(() => {
      if (!groupAlive(child.pid)) opts.onTimedOut();
    }, GROUP_POLL_MS);
    killTimer = setTimeout(() => {
      signalTree(child, "SIGKILL");
      opts.onTimedOut();
    }, opts.killGraceMs);
  }, opts.timeoutMs);
  return {
    fired: () => lateMs !== undefined,
    lateMs: () => lateMs,
    settleIfGone: () => {
      if (lateMs !== undefined && !groupAlive(child.pid)) opts.onTimedOut();
    },
    dispose: () => {
      clearTimeout(deadlineTimer);
      clearTimeout(killTimer);
      clearInterval(groupPoll);
    },
  };
}

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
    const deadline = armGroupDeadline(child, {
      startedAt: spawnedAt,
      timeoutMs: opts.timeoutMs,
      killGraceMs: opts.killGraceMs,
      onTimedOut: () => finish({ signal: "SIGTERM" }),
    });
    function finish(result: Pick<ScriptGroupResult, "code" | "signal" | "spawnError">): void {
      if (settled) return;
      settled = true;
      deadline.dispose();
      const timedOut = deadline.fired();
      if (timedOut) {
        // Nothing more is read once the deadline has fired: release the handles so a pipe
        // holder that escaped the group (a setsid'd daemon) cannot keep the harness alive.
        releaseChildHandles(child);
      }
      const run: BuildCheckRun = { spawnedAt, settledAt: Date.now(), timeoutMs: opts.timeoutMs };
      if (timedOut) run.deadlineLateMs = deadline.lateMs();
      resolve({ ...result, timedOut, stdout, stderr, run });
    }
    child.on("error", (err: NodeJS.ErrnoException) => {
      // Before the deadline this is the spawn failing (npm missing from PATH). After it, it can
      // only be a teardown signal that could not be delivered: the run is a timeout either way,
      // settled by the group probe or the grace timer.
      if (!deadline.fired()) finish({ spawnError: err });
    });
    child.on("close", (code, signal) => {
      // Before the deadline the leader's close settles the run. After it, settle only once the
      // whole group is gone: something in the group may outlive the leader, and the poll
      // settles the run when it goes, or the grace timer SIGKILLs it and settles then.
      if (deadline.fired()) deadline.settleIfGone();
      else finish({ code: code ?? undefined, signal: signal ?? undefined });
    });
  });
}
