/** The host's process table, read and acted on: the ps/lsof/top parsing behind doctor's
 * orphan and launchservicesd checks (systemProcessProbe, fakeable in tests via ProcessProbe),
 * and the TUMWATER_RUN environment markers every run stamps on its process tree plus the
 * cross-group sweep that reaps them at exit. Split out of process.ts — which keeps the spawn
 * plumbing (execFileAsync), the pid-liveness probe, and the LaunchServices preload — because
 * this half only reads or signals processes the table already found; it never spawns one, and
 * its consumers (doctor's checks, pi.ts's run stamping) share none of process.ts's
 * child-management concerns. All table reads go through process.ts's execFileAsync so the
 * shared output ceiling applies. */

import crypto from "node:crypto";
import fs from "node:fs";

import { execFileAsync } from "./process.js";

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
  /** The `TUMWATER_RUN` marks each given pid's environment carries, as the comma-separated
   * list of `<harness pid>-<nonce>` markers a run stamps (`runMarkerEnv`). Pids that exited
   * meanwhile, or that this user may not inspect, are simply absent; the reader's own pid is
   * never reported. On macOS `ps -E` hides platform binaries' environments (sleep, sh), so a
   * marked leak of those goes unseen — the same limit the sweep's scan carries; the leaks
   * that matter (servers, test workers) are userland binaries ps -E does report. Best-effort
   * by contract: a scan that cannot run at all answers an empty map rather than rejecting,
   * because the orphan check's argv/cwd evidence stands on its own and a dead environment
   * reader must not turn doctor red on its own. */
  runMarkers(pids: number[]): Promise<Map<number, string[]>>;
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
  async runMarkers(pids) {
    if (pids.length === 0) return new Map();
    if (process.platform === "linux") {
      const marks = new Map<number, string[]>();
      for (const pid of pids) {
        if (pid === process.pid) continue;
        try {
          const values = runMarkersInEnviron(fs.readFileSync(`/proc/${pid}/environ`).toString("utf8").split("\0"));
          if (values.length > 0) marks.set(pid, values);
        } catch {
          // Exited meanwhile, or another user's process: absent, per the contract.
        }
      }
      return marks;
    }
    try {
      const marks = runMarkersInPs(await psEnvironTable());
      return new Map(pids.flatMap((p): Array<[number, string[]]> => (marks.has(p) ? [[p, marks.get(p) as string[]]] : [])));
    } catch {
      // No ps, a wedged table: a miss, never a failed doctor — the argv/cwd half still ran.
      return new Map();
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

// ── Per-run environment markers (the cross-group sweep) ─────────────────────────────

/** The environment variable that names the pi run a process belongs to: runPi stamps pi's
 * environment with it before spawn, and every tool call pi starts — and everything a tool
 * call backgrounds — inherits it, whatever process group it ends up in. Process groups
 * cannot carry this attribution (BUGS.md 2026-09-30): pi 0.87.1's bash tool spawns each
 * command `detached`, a group leader in its own right, so a backgrounded grandchild sits in
 * a group whose leader is not pi and the group sweep's kill(-pi.pid) never reaches it. */
const RUN_MARKER_VAR = "TUMWATER_RUN";

/** A fresh marker for one pi run: `<harness pid>-<random hex>`. The pid prefix is what a
 * reader of a leaked process's environment needs to tell a live run's straggler (its own
 * sweep will reap it at exit) from a dead run's orphan (nothing will): a future doctor check
 * can report the latter wherever the leak's cwd is. The random half makes the marker unique
 * per run, so one run's sweep can never signal a concurrent sibling run's processes — a
 * machine running the fleet has several pi runs alive at once. */
export function makeRunMarker(pid = process.pid): string {
  return `${pid}-${crypto.randomBytes(6).toString("hex")}`;
}

/** `base` plus this run's marker APPENDED to any inherited one, comma-separated. A harness
 * run under test inside a pi run inherits the outer run's mark; keeping it means the inner
 * run's sweep reaps everything the inner run started while the outer mark survives on the
 * processes that predate the inner run, for the outer sweep to reap at its own exit. */
export function runMarkerEnv(base: NodeJS.ProcessEnv, marker: string): NodeJS.ProcessEnv {
  const prev = base[RUN_MARKER_VAR];
  return { ...base, [RUN_MARKER_VAR]: prev ? `${prev},${marker}` : marker };
}

/** True when a `TUMWATER_RUN=` value names `marker` as one of its comma-separated runs. */
function markerValueCarries(value: string, marker: string): boolean {
  return value.split(",").includes(marker);
}

/** The `TUMWATER_RUN` markers in an environment-entry list (NUL-separated `VAR=value`
 * strings), each value split into its comma-separated marks and duplicates dropped — the
 * reader half of the run mark, for anything that must see WHICH runs a process belongs to
 * rather than sweep by one (doctor's orphan check judges a mark's harness liveness). */
export function runMarkersInEnviron(entries: string[]): string[] {
  const values: string[] = [];
  for (const entry of entries) {
    if (!entry.startsWith(`${RUN_MARKER_VAR}=`)) continue;
    for (const marker of entry.slice(RUN_MARKER_VAR.length + 1).split(",")) {
      if (marker !== "" && !values.includes(marker)) values.push(marker);
    }
  }
  return values;
}

/** The `TUMWATER_RUN=…` assignments in one `ps -E` command column: with `-E`, ps appends
 * each process's launch environment to the command column, so one pass reads every
 * same-user environment. */
function psMarkerAssignments(command: string): string[] {
  return command.match(new RegExp(`${RUN_MARKER_VAR}=\\S*`, "g")) ?? [];
}

/** One `ps -wwE -A -o pid=,command=` pass: `-E` appends each process's launch environment
 * to the command column (the marker readers parse it from there), `-ww` keeps argv
 * untruncated, `-A` covers every same-user process. */
async function psEnvironTable(): Promise<string> {
  const { stdout } = await execFileAsync("ps", ["-wwE", "-A", "-o", "pid=,command="], {
    timeout: PROBE_TIMEOUT_MS,
  });
  return stdout;
}

/** The `TUMWATER_RUN` markers per pid in `ps -wwE -A -o pid=,command=` output. The sweep's
 * reader (pidsMarkedInPs) is membership-only in one marker; the orphan check needs the
 * values themselves, to judge each mark's harness. The reader's own pid is never reported —
 * it holds the mark's birthplace in memory, not in its environment. */
export function runMarkersInPs(stdout: string, ownPid = process.pid): Map<number, string[]> {
  const marks = new Map<number, string[]>();
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === ownPid) continue;
    const values = runMarkersInEnviron(psMarkerAssignments(m[2] ?? ""));
    if (values.length > 0) marks.set(pid, values);
  }
  return marks;
}

/** The pids in `ps -wwE -A -o pid=,command=` output whose environment names `marker`, via
 * runMarkersInPs's one-pass parse. The harness's own pid is never a victim — it holds the
 * marker's birthplace in memory, not in its environment. */
export function pidsMarkedInPs(stdout: string, marker: string, ownPid = process.pid): number[] {
  return [...runMarkersInPs(stdout, ownPid)].flatMap(([pid, values]) => (values.includes(marker) ? [pid] : []));
}

/** True when a `/proc/<pid>/environ` entry list (NUL-separated `VAR=value` strings) names
 * `marker`. Linux's environ files are the reliable reader macOS lacks: ps -E hides the
 * environment of platform binaries (sleep, sh), so a marked leak of those goes unseen there —
 * the leaks that matter (servers, test workers) are userland binaries ps -E does report. */
export function procEnvironCarriesMarker(entries: string[], marker: string): boolean {
  return entries.some(
    (entry) =>
      entry.startsWith(`${RUN_MARKER_VAR}=`) &&
      markerValueCarries(entry.slice(RUN_MARKER_VAR.length + 1), marker),
  );
}

/** Every same-user process whose environment names `marker`. */
async function findMarkedPids(marker: string): Promise<number[]> {
  if (process.platform === "linux") {
    const pids: number[] = [];
    for (const name of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      if (pid === process.pid) continue;
      try {
        const environ = fs.readFileSync(`/proc/${pid}/environ`).toString("utf8");
        if (procEnvironCarriesMarker(environ.split("\0"), marker)) pids.push(pid);
      } catch {
        // Exited since the readdir, or another user's process: absent, per the contract.
      }
    }
    return pids;
  }
  return pidsMarkedInPs(await psEnvironTable(), marker);
}

/** SIGTERM every same-user process whose environment names `marker`, escalating to SIGKILL
 * after 10 s for any that survive — the run's cross-group leftovers: what a tool call
 * backgrounded into its own detached group, which the process-group sweep cannot reach
 * (BUGS.md 2026-09-30). Marker membership is per-run unique, so the blast radius is exactly
 * this run's tree even while sibling runs are live. Never throws: an unreadable table (no
 * ps, a wedged /proc) degrades to no sweep — the group sweep still ran — never a failed
 * tick. Fire-and-forget by design: the run resolves on pi's output, not on the sweep. */
export async function sweepRunMarker(marker: string): Promise<number> {
  let victims: number[];
  try {
    victims = await findMarkedPids(marker);
  } catch {
    return 0;
  }
  let signaled = 0;
  for (const pid of victims) {
    try {
      process.kill(pid, "SIGTERM");
      signaled++;
    } catch {
      // Already gone.
    }
  }
  if (signaled > 0) {
    setTimeout(() => {
      for (const pid of victims) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }, 10_000).unref();
  }
  return signaled;
}
