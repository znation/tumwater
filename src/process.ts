import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";

/** Process-liveness probe shared by every place that decides whether a recorded pid still
 * belongs to a live process: the merge lock's stale-holder check (lock.ts) and the
 * orchestrator-alive status (state.ts). Also the host process-table reader behind doctor's
 * orphaned-worktree-process check (ProcessProbe, below). */

const execFileAsync = promisify(execFile);

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

/** Output buffer for ps/lsof — the git.ts ceiling. A busy macOS host's full-width table is
 * already ~250 KB, a quarter of execFile's 1 MB default, and a long argv or two grows it fast. */
const PROBE_MAX_BUFFER = 32 * 1024 * 1024;

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
      { maxBuffer: PROBE_MAX_BUFFER, timeout: PROBE_TIMEOUT_MS },
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
        maxBuffer: PROBE_MAX_BUFFER,
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
