import { execFile, spawn, type ChildProcess, type ExecFileOptions, type PromiseWithChild } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";

// Type-only back-reference, the same shape build-check-events.ts uses: runScriptGroup's
// result carries the caller's run record (BuildCheckRun), and no runtime cycle is created —
// build-check.ts imports this module's runtime values, this file imports only the type.
import type { BuildCheckRun } from "./build-check.js";

/** Process-liveness probe shared by every place that decides whether a recorded pid still
 * belongs to a live process: the merge lock's stale-holder check (lock.ts) and the
 * orchestrator-alive status (state.ts). Also the host process-table reader behind doctor's
 * orphaned-worktree-process check (ProcessProbe, below). */

const execFileRaw = promisify(execFile);

/** The output ceiling every execFile the harness runs shares (git, tsc, the build check, the
 * ps/lsof probes): a busy macOS host's full-width process table is already ~250 KB — a quarter
 * of execFile's 1 MB default — and a long argv or two grows it fast. */
export const EXEC_MAX_BUFFER = 32 * 1024 * 1024;

/** The harness's one execFile helper: promisify(execFile) with the shared output ceiling baked
 * in as the default. Every module that shells out — git.ts, build-stage.ts, build-check.ts —
 * runs through this, so the ceiling and the child handle (a caller may end the spawned stdin,
 * as patch-id does) behave the same everywhere. */
export function execFileAsync(
  file: string,
  args: readonly string[],
  options: Omit<ExecFileOptions, "encoding"> = {},
): PromiseWithChild<{ stdout: string; stderr: string }> {
  return execFileRaw(file, args, { maxBuffer: EXEC_MAX_BUFFER, ...options });
}

/** True when a process with this pid exists — a signal-0 send, which cannot affect the
 * target. Any error reads as "not alive": no such process (ESRCH), or permission denied
 * (EPERM, e.g. the pid was recycled by another user's process) — the harness only probes
 * pids of its own fleet, so a live foreign holder must not be mistaken for one of ours.
 *
 * Anything that is not a positive integer reads as not alive without probing: signal 0
 * treats pid 0 as the caller's own process GROUP and a negative pid as another group
 * (kill(-1, 0) checks every process the user may signal), so both would report "alive" for
 * an id no process owns. A torn or foreign state/lock file (a pid field of 0, a negative or
 * fractional value) must not latch a dead holder as live — that would keep the merge lock
 * unbreakable for its full stale window, and make `tumwater run` refuse to start because a
 * phantom orchestrator looks alive. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** One row of the host's process table. `etime` (wall-clock since start) and `time`
 * (cumulative CPU) stay ps's own strings: BSD and procps format them differently, and the one
 * consumer (doctor's orphan report) prints them rather than doing arithmetic on them.
 * `command` is the full argv joined by spaces — ps cannot say where one argument ends. */
export interface ProcessRow {
  pid: number;
  ppid: number;
  uid: number;
  etime: string;
  time: string;
  command: string;
}

/** Reads the process table and processes' working directories — an interface so doctor's
 * orphan check runs against a fake table in tests, never against real spawned orphans. */
export interface ProcessProbe {
  /** Every process on the host. Rejects when the table cannot be read at all. */
  list(): Promise<ProcessRow[]>;
  /** The working directory of each given pid, as the kernel resolves it (symlink-free). Pids
   * that exited meanwhile, or that this user may not inspect, are simply absent; rejects only
   * when no lookup could run at all. */
  cwds(pids: number[]): Promise<Map<number, string>>;
}

/** Both lookups normally finish in well under a second; a wedged one must not hang doctor. */
const PROBE_TIMEOUT_MS = 10_000;

/** A header-less `ps -o pid=,ppid=,uid=,etime=,time=,command=` line: five fields, then the
 * argv (which may be empty for a zombie). */
const PS_ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/;

/** Parse the table `systemProcessProbe.list` reads. Lines that do not fit the shape are
 * skipped rather than failing the whole scan. */
export function parsePsOutput(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of stdout.split("\n")) {
    const m = PS_ROW.exec(line);
    if (!m) continue;
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      uid: Number(m[3]),
      etime: m[4] ?? "",
      time: m[5] ?? "",
      command: (m[6] ?? "").trimEnd(),
    });
  }
  return rows;
}

/** Parse `lsof -a -d cwd -Fn -p …` field output: a `p<pid>` line opens each process, its cwd
 * descriptor follows as `f cwd` then `n<path>`. A process lsof could not read has no `n` line
 * and is left out. */
export function parseLsofCwds(stdout: string): Map<number, string> {
  const cwds = new Map<number, string>();
  let pid: number | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid !== null && Number.isInteger(pid)) cwds.set(pid, line.slice(1));
  }
  return cwds;
}

/** The host's real probe: one `ps` for the table, and for cwds one `lsof` call over every
 * asked pid (macOS and other non-Linux Unixes) or a readlink of `/proc/<pid>/cwd` each
 * (Linux, where the kernel suffixes a removed directory with " (deleted)"). `-A` and `-ww`
 * mean the same to BSD and procps ps: every process, argv never truncated to a width. */
export const systemProcessProbe: ProcessProbe = {
  async list() {
    const { stdout } = await execFileAsync(
      "ps",
      ["-A", "-ww", "-o", "pid=,ppid=,uid=,etime=,time=,command="],
      { timeout: PROBE_TIMEOUT_MS },
    );
    return parsePsOutput(stdout);
  },
  async cwds(pids) {
    if (pids.length === 0) return new Map();
    if (process.platform === "linux") {
      const cwds = new Map<number, string>();
      for (const pid of pids) {
        try {
          cwds.set(pid, fs.readlinkSync(`/proc/${pid}/cwd`).replace(/ \(deleted\)$/, ""));
        } catch {
          // Exited meanwhile, or another user's process: absent, per the contract.
        }
      }
      return cwds;
    }
    try {
      const { stdout } = await execFileAsync("lsof", ["-w", "-a", "-d", "cwd", "-Fn", "-p", pids.join(",")], {
        timeout: PROBE_TIMEOUT_MS,
      });
      return parseLsofCwds(stdout);
    } catch (err) {
      // lsof exits 1 whenever ANY named pid is absent or unreadable — a pid that exited since
      // ps ran is routine — and still prints everything it did find, so a numeric exit status
      // with stdout is an answer, not a failure (the qa GUI leak in BUGS.md was missed through
      // exactly this exit-1 trap). No lsof binary, a timeout, or a signal is a real failure.
      const e = err as { code?: unknown; stdout?: unknown };
      if (typeof e.code === "number" && typeof e.stdout === "string") return parseLsofCwds(e.stdout);
      throw err;
    }
  },
};

/** Terminate a detached child and everything it started: SIGTERM to the process group now,
 * escalating to SIGKILL after 10 s if any of it is still alive. The child is spawned detached
 * (its own process group leader — runPi does this for pi), so a negative PID reaches every
 * tool-call grandchild — which a single-PID kill leaves orphaned to launchd — while the
 * harness's own group is never in the blast radius. Shared by the tick-timeout,
 * quiet-watchdog, and harness-shutdown kills, and by the sweep every run gets once pi exits
 * (runPi's 'exit' handler), when the group holds only what pi's tool calls backgrounded.
 *
 * The escalation is armed only when the SIGTERM reached a live process: a group that died with
 * its leader — every clean run — gets no second signal, so nothing is sent 10 s later to a pgid
 * no process holds any more (the one state in which a recycled pid could make it another
 * group; the kernel never reissues the number while a member lives). The timer is unref'd and
 * never awaited: the run resolves as soon as pi's output is in, and only a SIGTERM-trapping
 * straggler waits on the escalation — holding every run up to 10 s for it would slow the fleet
 * to cover what the SIGTERM already covers, and a finished harness process is not kept alive
 * by it. */
export function terminateChild(child: ChildProcess): void {
  if (signalTree(child, "SIGTERM")) setTimeout(() => signalTree(child, "SIGKILL"), 10_000).unref();
}

/** Signal the child's whole process group, falling back to the child alone when the group is
 * already gone or the platform has no negative-PID kill (Windows). Returns whether the signal
 * reached a live process: false when nothing was left to receive it — ESRCH from a group that
 * died with its leader, the normal case once the child has exited. Never throws: a process
 * that died between the caller's decision and this call is the normal case. Shared by runPi's
 * teardown (pi.ts) and the process-group runner below (runScriptGroup) — the same "signal the
 * tree, not just the direct child" guarantee in one home, this module. */
export function signalTree(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (child.pid == null) return false;
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    try {
      return child.kill(signal);
    } catch {
      return false; // Already gone.
    }
  }
}

// ── Detached process-group runner ─────────────────────────────────────────────────────────

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
