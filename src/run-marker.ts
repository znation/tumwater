/** The per-run environment markers every run stamps on its process tree, plus the
 * cross-group sweep that reaps them at exit: the `TUMWATER_RUN` variable runPi puts in
 * pi's environment, the readers that tell which processes carry which run's mark (the
 * probe's runMarkers check and doctor's orphan judgment), and the sweep that SIGTERMs
 * this run's leftovers whatever process group they ended up in. Split out of
 * process-table.ts — which keeps the doctor-facing probe interface and the ps/lsof/top
 * parsing it is made of — because this half serves pi.ts's run stamping and the exit
 * sweep, and shares none of the probe's table-parsing concerns; the probe reads marks
 * through the same parsers exported here. */

import crypto from "node:crypto";
import fs from "node:fs";

import { execFileAsync } from "./process/process.js";

/** Every lookup normally finishes in well under a second; a wedged one must not hang
 * its caller — the same ceiling process-table.ts's probe lookups carry. */
const PS_ENVIRON_TIMEOUT_MS = 10_000;

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
export async function psEnvironTable(): Promise<string> {
  const { stdout } = await execFileAsync("ps", ["-wwE", "-A", "-o", "pid=,command="], {
    timeout: PS_ENVIRON_TIMEOUT_MS,
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

/** One `/proc/<pid>/environ` read as its NUL-separated `VAR=value` entry list, or null when
 * the read fails (exited meanwhile, or another user's process: absent, per the contract).
 * The shared read for both Linux marker readers — run-marker's pid sweep and
 * process-table's runMarkers — so neither re-stakes the ENOENT-tolerance contract. */
export function readProcEnvironEntries(pid: number): string[] | null {
  try {
    return fs.readFileSync(`/proc/${pid}/environ`).toString("utf8").split("\0");
  } catch {
    return null;
  }
}

/** Every same-user process whose environment names `marker`. */
async function findMarkedPids(marker: string): Promise<number[]> {
  if (process.platform === "linux") {
    const pids: number[] = [];
    for (const name of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      if (pid === process.pid) continue;
      const environ = readProcEnvironEntries(pid);
      if (environ && procEnvironCarriesMarker(environ, marker)) pids.push(pid);
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
