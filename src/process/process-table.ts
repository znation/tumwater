/** The host's process table, read: the ps/lsof/top parsing behind doctor's orphan and
 * launchservicesd checks (systemProcessProbe, fakeable in tests via ProcessProbe). Split out
 * of process.ts — which keeps the spawn plumbing (execFileAsync), the pid-liveness probe, and
 * the LaunchServices preload — because this half only reads processes the table already found;
 * it never spawns or signals one, and its consumers (doctor's checks, the fleet's port watch)
 * share none of process.ts's child-management concerns. Acting on the table — the
 * TUMWATER_RUN environment markers every run stamps on its process tree and the cross-group
 * sweep that reaps them at exit — lives beside it in run-marker.ts, whose parsers this
 * probe's runMarkers check reads marks through. All table reads go through process.ts's
 * execFileAsync so the shared output ceiling applies. */

import fs from "node:fs";

import { execFileAsync } from "./process.js";
import { psEnvironTable, readProcEnvironEntries, runMarkersInEnviron, runMarkersInPs } from "./run-marker.js";

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
  /** How many Mach ports macOS's launchservicesd holds (see src/process/launch-services.ts). Null
   * off macOS, and when the count cannot be read; never rejects. */
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

/** Parse lsof's `-Fn` output through an injected runner: the gating suite must not read the
 * host's real `lsof` (BUGS.md 2026-10-08), so tests feed a canned stdout — or a failing
 * runner — while the real probe keeps the argv and the timeout at its call site, as
 * `readLaunchServicesPorts` does for `top`. lsof exits 1 whenever ANY named pid is absent or
 * unreadable — a pid that exited since ps ran is routine — and still prints everything it did
 * find, so a numeric exit status with stdout is an answer, not a failure. No lsof binary, a
 * timeout, or a signal is a real failure. */
export async function readLsofCwds(runLsof: () => Promise<string>): Promise<Map<number, string>> {
  try {
    return parseLsofCwds(await runLsof());
  } catch (err) {
    const e = err as { code?: unknown; stdout?: unknown };
    if (typeof e.code === "number" && typeof e.stdout === "string") return parseLsofCwds(e.stdout);
    throw err;
  }
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

/** launchServicesPorts' core, with the `top` runner injected: the gating suite must not hinge
 * on a live system sample (BUGS.md 2026-09-30), so tests feed a canned `top` output — or a
 * failing runner — and the real probe keeps the platform guard and the timeout here. Null off
 * macOS and when the sample cannot be read or parsed; never rejects. */
export async function readLaunchServicesPorts(runTop: () => Promise<string>): Promise<number | null> {
  if (process.platform !== "darwin") return null;
  try {
    return parseTopPorts(await runTop(), "launchservicesd");
  } catch {
    return null;
  }
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
    // The exit-1 trap (the qa GUI leak in BUGS.md was missed through exactly it) and the
    // parser live in readLsofCwds; only the real lsof argv and timeout stay here.
    return readLsofCwds(async () => {
      const { stdout } = await execFileAsync("lsof", ["-w", "-a", "-d", "cwd", "-Fn", "-p", pids.join(",")], {
        timeout: PROBE_TIMEOUT_MS,
      });
      return stdout;
    });
  },
  async runMarkers(pids) {
    if (pids.length === 0) return new Map();
    if (process.platform === "linux") {
      const marks = new Map<number, string[]>();
      for (const pid of pids) {
        if (pid === process.pid) continue;
        const entries = readProcEnvironEntries(pid);
        if (entries) {
          const values = runMarkersInEnviron(entries);
          if (values.length > 0) marks.set(pid, values);
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
    return readLaunchServicesPorts(async () => {
      const { stdout } = await execFileAsync("top", ["-l", "1", "-stats", "pid,command,ports"], {
        timeout: PROBE_TIMEOUT_MS,
      });
      return stdout;
    });
  },
};
