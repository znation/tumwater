import { execFile, type ChildProcess, type ExecFileOptions, type PromiseWithChild } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";

/** Process-liveness probe shared by every place that decides whether a recorded pid still
 * belongs to a live process: the merge lock's stale-holder check (lock.ts) and the
 * orchestrator-alive status (fleet-state.ts). Also the host process-table reader behind doctor's
 * orphaned-worktree-process and launchservicesd checks (ProcessProbe, below), and the child
 * environment that keeps the harness's Node processes out of LaunchServices on macOS. */

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

/** Reads the process table, processes' working directories and launchservicesd's port count —
 * an interface so doctor's orphan and port checks (and the fleet's port watch) run against a
 * fake host in tests, never against real spawned orphans or the real Mac's daemon. */
export interface ProcessProbe {
  /** Every process on the host. Rejects when the table cannot be read at all. */
  list(): Promise<ProcessRow[]>;
  /** The working directory of each given pid, as the kernel resolves it (symlink-free). Pids
   * that exited meanwhile, or that this user may not inspect, are simply absent; rejects only
   * when no lookup could run at all. */
  cwds(pids: number[]): Promise<Map<number, string>>;
  /** How many Mach ports macOS's launchservicesd holds (see src/launch-services.ts). Null off
   * macOS, and when the count cannot be read; never rejects. */
  launchServicesPorts(): Promise<number | null>;
}

/** Every lookup normally finishes in well under a second; a wedged one must not hang doctor. */
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

/** The #PORTS of the process named `command` in macOS `top -l 1 -stats pid,command,ports`
 * output — the largest, should several share the name — or null when no row has it. top
 * appends a `+`/`-` trend mark to a count only between samples of one run; it is ignored. */
export function parseTopPorts(stdout: string, command: string): number | null {
  let ports: number | null = null;
  for (const line of stdout.split("\n")) {
    const [pid, name, count] = line.trim().split(/\s+/);
    if (name !== command || !/^\d+$/.test(pid ?? "")) continue;
    const n = Number.parseInt(count ?? "", 10);
    if (Number.isInteger(n) && (ports === null || n > ports)) ports = n;
  }
  return ports;
}

/** The host's real probe: one `ps` for the table, and for cwds one `lsof` call over every
 * asked pid (macOS and other non-Linux Unixes) or a readlink of `/proc/<pid>/cwd` each
 * (Linux, where the kernel suffixes a removed directory with " (deleted)"). `-A` and `-ww`
 * mean the same to BSD and procps ps: every process, argv never truncated to a width. The port
 * count is one `top` sample (~0.3 s of CPU, no root needed); nothing else reports it. */
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
  async launchServicesPorts() {
    if (process.platform !== "darwin") return null;
    try {
      const { stdout } = await execFileAsync("top", ["-l", "1", "-stats", "pid,command,ports"], {
        timeout: PROBE_TIMEOUT_MS,
      });
      return parseTopPorts(stdout, "launchservicesd");
    } catch {
      return null;
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
 * teardown (pi.ts) and the detached process-group runner (runScriptGroup, process-group.ts) —
 * the same "signal the tree, not just the direct child" guarantee in one home, this module. */
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

// ── LaunchServices check-ins (macOS) ──────────────────────────────────────────────────────

/** The NODE_OPTIONS entry that keeps a Node process from checking in with LaunchServices. On
 * macOS, assigning `process.title` runs libuv's uv_set_process_title, which registers the
 * process as an application (`_LSApplicationCheckIn`) so Activity Monitor and Force Quit can
 * show the title. launchservicesd keeps a Mach port for every process that ever checked in and
 * never releases it when the process exits (one port per process, measured on macOS 27.0 and
 * seen in 26.6.2's logs), and the kernel kills the daemon near 268K ports — which wedged the GUI session of
 * the Mac running the fleet on 2026-09-25 (BUGS.md 2026-09-28). npm sets its title on every run
 * and pi at startup; one `npm test` leaked ~140 ports through the npm processes of its
 * build-check tests alone.
 *
 * The preload swaps the property for a plain getter/setter before any program code runs, so an
 * assignment only stores the string: nothing registers, and ps shows the real argv instead of
 * the title. It has to be an ACCESSOR — `process.title` is a V8 native data property, and
 * redefining it with a `value` descriptor goes through the native setter, checking the process
 * in by itself. It is inline (a data: URL with no spaces or double quotes, which NODE_OPTIONS
 * would split on or strip) rather than a file, so no rebuild or swap of dist/ can leave the
 * flag naming a missing module — that would fail every Node process started under it. Node
 * accepts `--import` in NODE_OPTIONS from 18.18; tumwater itself needs 20.3. */
export const NO_LAUNCH_SERVICES_CHECK_IN =
  "--import=data:text/javascript,(t=>Object.defineProperty(process,'title',{get:()=>t,set:v=>{t=String(v)},enumerable:true,configurable:true}))(process.title)";

/** `base` for a child whose Node processes must not check in with LaunchServices (see
 * NO_LAUNCH_SERVICES_CHECK_IN): on macOS, the preload appended to NODE_OPTIONS after whatever
 * the caller set there — once, since a check started from inside a pi run inherits it already;
 * anywhere else `base` itself, since a title registers nothing there. The harness applies it to
 * the process trees that start Node in bulk: every pi run (so every tool call) and every build
 * check. */
export function withoutLaunchServicesCheckIn(
  base: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (platform !== "darwin") return base;
  const current = base.NODE_OPTIONS ?? "";
  if (current.includes(NO_LAUNCH_SERVICES_CHECK_IN)) return base;
  const nodeOptions = current.trim() === "" ? NO_LAUNCH_SERVICES_CHECK_IN : `${current} ${NO_LAUNCH_SERVICES_CHECK_IN}`;
  return { ...base, NODE_OPTIONS: nodeOptions };
}
