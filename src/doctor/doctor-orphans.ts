import fs from "node:fs";
import path from "node:path";
import { worktreesDir } from "../paths.js";
import { pidAlive } from "../process/process.js";
import { GROUP_POLL_MS, KILL_GRACE_MS } from "../process/process-group.js";
import { type ProcessProbe, type ProcessRow, systemProcessProbe } from "../process/process-table.js";
import { warnEventBestEffort, TUMWATER_SOURCE } from "../events/events.js";
import { errorMessage, truncate } from "../text/text.js";
import { plural } from "../text/phrases.js";
import { failOutcome, okOutcome, warnOutcome, type CheckOutcome } from "./doctor-outcome.js";

/** The orphan-process check of `tumwater doctor`, split out of doctor.ts: it is the one
 * doctor check that inspects the operating system's process table (argv, cwd, parent-child
 * tree) rather than the repo's own files, so it carries a different shape of logic — path
 * spelling matching, worktree-name resolution, descendant counting — from the environment
 * checks that stay in doctor.ts. */

/** How many orphans the doctor line itemizes before counting the rest: a check is one line,
 * and the 2026-09-21 incident this check exists for had five. */
const ORPHANS_LISTED_MAX = 8;

/** An itemized orphan's command is trimmed to this many characters, after the repo root is
 * cut from it — enough for the program, the script and its subcommand and flags. */
const ORPHAN_COMMAND_MAX = 80;

/** A RELATIVE worktree path in an argv: `.tumwater/worktrees/<name>/`, at the start of an
 * argument or after a relative prefix (`./`, `../../`, `sub/`), never after a leading `/` —
 * absolute paths are compared against this repo's dirs directly (argvNamesDir). Captures the
 * path up to the worktree dir, and the worktree's name. */
const RELATIVE_WORKTREE_ARG = /(?:^|[\s"'=:])((?:[^\s"'=:/][^\s"'=:]*\/)?\.tumwater\/worktrees\/([^\s"'=:/]+))\//g;

/** The repo root in every spelling a process can report it: as given, and symlink-resolved —
 * lsof and /proc report a cwd resolved (macOS's /var is /private/var), while an argv holds
 * whatever path was typed. */
function rootSpellings(root: string): string[] {
  const given = path.resolve(root);
  try {
    const real = fs.realpathSync(given);
    return real === given ? [given] : [given, real];
  } catch {
    return [given];
  }
}

/** True when `p` is one of `dirs` or lies under one. */
function isUnder(p: string, dirs: string[]): boolean {
  return dirs.some((d) => p === d || p.startsWith(`${d}/`));
}

/** True when an argv names an absolute path under one of `dirs` — at the start of an
 * argument, so a different checkout whose path merely ends in this one's is not matched. */
function argvNamesDir(command: string, dirs: string[]): boolean {
  return dirs.some((d) => {
    const needle = `${d}/`;
    for (let i = command.indexOf(needle); i !== -1; i = command.indexOf(needle, i + 1))
      if (i === 0 || /[\s"'=:]/.test(command.charAt(i - 1))) return true;
    return false;
  });
}

/** True when an argv's RELATIVE worktree path (`node .tumwater/worktrees/qa/dist/src/cli.js gui …`)
 * is this repo's. Resolved against the process's cwd it must resolve here; one that resolves in a
 * worktree that exists elsewhere belongs to another checkout's team and is not blamed on this one.
 * When the resolution points nowhere — the cwd is unreadable, or is a scratch dir since deleted
 * (the leaked qa GUI's was), or the process chdir'd after exec — the worktree's name is the
 * evidence left: it counts only when this repo has a worktree by that name. */
function relativeArgvIsOurs(command: string, cwd: string | undefined, root: string, dirs: string[]): boolean {
  for (const [, rel = "", name = ""] of command.matchAll(RELATIVE_WORKTREE_ARG)) {
    if (cwd !== undefined) {
      const resolved = path.resolve(cwd, rel);
      if (isUnder(resolved, dirs)) return true;
      if (fs.existsSync(resolved)) continue; // Another checkout's live worktree.
    }
    if (fs.existsSync(path.join(worktreesDir(root), name))) return true;
  }
  return false;
}

/** The processes that descend from `pid`, given the table's parent → children map — an
 * orphaned test runner's workers keep the runner as their parent, so they are the orphan's
 * tree, not orphans of their own, and killing the runner alone leaves them running. */
function descendantPids(children: Map<number, number[]>, pid: number): number[] {
  const seen = new Set<number>();
  const stack = [...(children.get(pid) ?? [])];
  for (let p = stack.pop(); p !== undefined; p = stack.pop()) {
    if (seen.has(p) || p === pid) continue;
    seen.add(p);
    stack.push(...(children.get(p) ?? []));
  }
  return [...seen];
}

/** What the orphan scan found: the table it read, the orphans in it, each scanned process's
 * `TUMWATER_RUN` marks and why cwds could not be read (null when they could), or the reason the
 * table itself could not be read. Public so the always-on orphan alert feed (src/ui/alert-feeds.ts)
 * can stage a scan (a fake probe's) the same way `checkOrphans` reads it, without re-deriving the
 * orphan set — the alert and the doctor row cannot drift on what is an orphan. */
export type OrphanScan =
  | { rows: ProcessRow[]; orphans: ProcessRow[]; marks: Map<number, string[]>; cwdProblem: string | null }
  | { error: string };

/** A mark's harness is dead (true), alive (false), or the mark names no harness (null — a torn
 * or foreign value judges nothing rather than counting as dead). */
function harnessGone(marker: string): boolean | null {
  const m = /^(\d+)-/.exec(marker);
  return m ? !pidAlive(Number(m[1])) : null;
}

/** ps's elapsed-time field (`[[D-]HH:]MM:SS`, the string the doctor line already prints) in
 * milliseconds, the minimum-age gate the automatic reap uses so a just-leaked — still
 * possibly owned — process is not killed. Any shape that does not parse, or that carries an
 * out-of-range minute or second, reads 0: the conservative reading that keeps the reap from
 * acting on uncertain evidence. */
export function parseEtimeMs(etime: string): number {
  const m = /^(?:\d+-)?(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(etime.trim());
  if (!m) return 0;
  const hh = Number(m[1] ?? 0);
  const mm = Number(m[2]);
  const ss = Number(m[3]);
  if (mm > 59 || ss > 59) return 0;
  const days = /^(\d+)-/.exec(etime.trim());
  const d = days ? Number(days[1]) : 0;
  return ((d * 24 + hh) * 3600 + mm * 60 + ss) * 1000;
}

/** A parent pid → child pids map of the table. */
function childrenOf(rows: ProcessRow[]): Map<number, number[]> {
  const children = new Map<number, number[]>();
  for (const r of rows) {
    const siblings = children.get(r.ppid);
    if (siblings) siblings.push(r.pid);
    else children.set(r.ppid, [r.pid]);
  }
  return children;
}

/** An orphan's command with the repo root cut out, longest spelling first: the resolved one can
 * contain the given one (/private/var/… holds /var/…) — then trimmed to ORPHAN_COMMAND_MAX. */
function shownCommand(command: string, root: string): string {
  const cut = [...rootSpellings(root)].sort((a, b) => b.length - a.length);
  return truncate(cut.reduce((c, rt) => c.split(`${rt}/`).join(""), command), ORPHAN_COMMAND_MAX);
}

/** The detection half of checkOrphans, shared with killOrphans so the check and the kill cannot
 * disagree about the set. Exported so the always-on orphan alert feed (src/ui/alert-feeds.ts)
 * runs the exact same scan the doctor row reads — the alert and the row cannot drift on the
 * orphan set. */
export async function findOrphans(root: string, probe: ProcessProbe): Promise<OrphanScan> {
  const roots = rootSpellings(root);
  let rows: ProcessRow[];
  try {
    rows = await probe.list();
  } catch (err) {
    return { error: errorMessage(err) };
  }
  const dirs = roots.map(worktreesDir);
  // Never doctor itself, should it be run parentless from a worktree's build.
  const parentless = rows.filter((r) => r.ppid === 1 && r.pid !== process.pid);
  const byArgv = new Set(parentless.filter((r) => argvNamesDir(r.command, dirs)).map((r) => r.pid));
  const uid = process.getuid?.();
  const ask = parentless
    .filter((r) => !byArgv.has(r.pid) && (uid === undefined || uid === 0 || r.uid === uid))
    .map((r) => r.pid);
  let cwds = new Map<number, string>();
  let cwdProblem: string | null = null;
  if (ask.length > 0) {
    try {
      cwds = await probe.cwds(ask);
    } catch (err) {
      cwdProblem = errorMessage(err);
    }
  }
  let marks = new Map<number, string[]>();
  if (ask.length > 0) {
    try {
      marks = await probe.runMarkers(ask);
    } catch {
      // Best-effort per the probe contract: argv and cwd still carry the check alone.
    }
  }
  const byMark = new Set<number>();
  for (const r of parentless) {
    if (byArgv.has(r.pid)) continue;
    const verdicts = (marks.get(r.pid) ?? []).map(harnessGone);
    if (verdicts.length > 0 && verdicts.every((v) => v === true)) byMark.add(r.pid);
  }
  const orphans = parentless.filter((r) => {
    if (byArgv.has(r.pid) || byMark.has(r.pid)) return true;
    const cwd = cwds.get(r.pid);
    return (cwd !== undefined && isUnder(cwd, dirs)) || relativeArgvIsOurs(r.command, cwd, root, dirs);
  });
  return { rows, orphans, marks, cwdProblem };
}

/** Orphaned worktree processes — the detector half of the grandchild-leak fix (BUGS.md
 * 2026-09-21): a process reparented to PID 1 that belongs to one of this repo's worktrees.
 * Leaks of this kind (a killed run's tool-call grandchildren, a timed-out build check's test
 * tree, a pi run's backgrounded server, a stray orchestrator an orphaned suite started) hold
 * no lock, write no event and touch no state file, so nothing else in the harness can see
 * them. A process is this repo's when its argv names a path under `.tumwater/worktrees/`
 * (absolute; or relative, confirmed by cwd where it can be — relativeArgvIsOurs) or when its
 * cwd lies under it: a leaked `node dist/test/test-runner.js` names no worktree at all.
 *
 * PPID 1 is what keeps the live team out: a running orchestrator's pi runs and build checks
 * have the orchestrator as parent, and the orchestrator and its supervisor run from the repo
 * root, never from a worktree, even when a detached `nohup` launch leaves them parentless.
 * (macOS always reparents an orphan to launchd, PID 1; on Linux a process under a child
 * subreaper — `systemd --user` in a desktop session — is reparented to that instead, and is
 * not seen here.)
 *
 * A second kind of evidence closes the gap the 2026-09-30 sweep fix left (BUGS.md, part
 * 2/2): every process a run starts carries `TUMWATER_RUN=<harness pid>-<nonce>` in its
 * environment (appended to any inherited mark), wherever its cwd is — exactly where the
 * prompts send agents (scratch dirs under the system temp). A parentless process whose
 * every mark names a harness pid that is no longer alive is this team's orphan: nothing
 * will reap it, because the run sweep that would have dies with its harness. A mark naming
 * ANY live harness is not reported — that harness's own sweep kills everything carrying the
 * mark when its run folds. A pid that died and was recycled by an unrelated process reads
 * as live (pidAlive cannot tell), so such a straggler stays unseen here — the same limit the
 * merge lock's stale-holder check carries. An unparseable mark (a torn or foreign value
 * without a `<pid>-` prefix) judges nothing; on macOS ps -E hides platform binaries'
 * environments, so a marked sleep/sh leak stays unseen there, as the sweep's own scan does.
 *
 * Cheap by construction: one `ps`, then one cwd lookup covering only the parentless
 * processes argv did not already settle (and only those this user can inspect — lsof and
 * /proc cannot read anyone else's, root reads all). An unreadable table degrades to a warn,
 * never a crashed doctor; unreadable cwds degrade to the argv match and say so. Any orphan is
 * a fail — the exit code is the point: a scripted doctor must notice. `probe` is injectable so
 * tests run against a fake table. */
/** The orphan-problem sentence for the standing alert feed, shared with checkOrphans so the
 * alert and the doctor row cannot drift on the wording: the count, each listed orphan's pid,
 * age, cpu and command (with its descendant count and the run mark that caught it), and the
 * nothing-reaps-these remediation. null when the scan errored or found no orphans. Public so
 * the feed (src/ui/alert-feeds.ts) can stage a scan and get exactly the row's message. */
export function orphanFailDetail(root: string, scan: OrphanScan): string | null {
  if ("error" in scan) return null;
  const { rows, orphans, marks, cwdProblem } = scan;
  if (orphans.length === 0) return null;
  const children = childrenOf(rows);
  const listed = orphans.slice(0, ORPHANS_LISTED_MAX).map((r) => {
    const n = descendantPids(children, r.pid).length;
    const tree = n > 0 ? `, +${plural(n, "descendant")}` : "";
    // A mark-caught orphan says which run marked it: the operator killing it wants to know
    // nothing else will, and the dead harness's pid is the evidence argv and cwd lacked.
    const mark = (marks.get(r.pid) ?? []).find((m) => harnessGone(m) === true);
    const marked = mark !== undefined ? ` (run ${mark}; tumwater ${mark.split("-")[0]} exited)` : "";
    return `pid ${r.pid} (age ${r.etime}, cpu ${r.time}${tree}) ${shownCommand(r.command, root)}${marked}`;
  });
  const more = orphans.length - listed.length;
  const count = `${plural(orphans.length, "orphaned process", "orphaned processes")} (PPID 1)`;
  return `${count}: ${listed.join("; ")}${more > 0 ? `; and ${more} more` : ""}` +
      " — nothing reaps these; `tumwater doctor --kill-orphans` (or the dashboard Health card's Kill orphans, or the TUI Health tab's Ctrl+K pressed twice) kills each with its descendants" +
      (cwdProblem !== null ? ` (process cwds unreadable — ${cwdProblem}; argv matched only)` : "");
}

/** The doctor's `orphans` row. */
export async function checkOrphans(
  root: string,
  probe: ProcessProbe = systemProcessProbe,
): Promise<CheckOutcome> {
  const scan = await findOrphans(root, probe);
  if ("error" in scan) return warnOutcome(`could not scan the process table — ${scan.error}`);
  const { orphans, cwdProblem } = scan;
  if (orphans.length === 0) {
    if (cwdProblem !== null)
      return warnOutcome(`none named in argv, but process cwds are unreadable (${cwdProblem}) — an orphan started inside a worktree, like a leaked test runner, would be missed`);
    return okOutcome("none — no process reparented to PID 1 runs from .tumwater/worktrees/ or carries only dead runs' marks");
  }
  return failOutcome(orphanFailDetail(root, scan) as string);
}

/** The seams killOrphans signals through, injectable so tests send no real signal. */
export interface OrphanSignals {
  kill(pid: number, signal: NodeJS.Signals): void;
  alive(pid: number): boolean;
  graceMs: number;
  pollMs: number;
}

const systemSignals: OrphanSignals = {
  kill: (pid, signal) => void process.kill(pid, signal),
  alive: pidAlive,
  graceMs: KILL_GRACE_MS,
  pollMs: GROUP_POLL_MS,
};

/** What `doctor --kill-orphans` did: the orphans killed (with how many descendants went with
 * each), the pids that could not be signalled, or why the table could not be scanned. */
interface KilledOrphan { pid: number; command: string; descendants: number; }

export type OrphanKillReport =
  | { error: string }
  | {
      killed: KilledOrphan[];
      failed: { pid: number; reason: string }[];
    };

/** The lines `doctor --kill-orphans` prints for a report, shared with the dashboard's Kill
 * orphans toast. */
export function orphanKillLines(report: OrphanKillReport): string[] {
  if ("error" in report) return [`could not scan the process table — ${report.error}; nothing killed`];
  const lines = report.killed.map((k) => {
    const tree = k.descendants > 0 ? ` (+${plural(k.descendants, "descendant")})` : "";
    return `killed pid ${k.pid}${tree} ${k.command}`;
  });
  for (const f of report.failed) lines.push(`could not kill pid ${f.pid}: ${f.reason}`);
  if (lines.length === 0) lines.push("no orphaned processes to kill");
  return lines;
}

/** Kill the processes checkOrphans lists, each with its descendants from the same scan:
 * SIGTERM all, wait up to `graceMs` for them to go, SIGKILL what remains. A pid already gone
 * (ESRCH) counts as killed; any other refusal (EPERM) is reported and the rest are still
 * signalled. An orphan with a refused pid in its tree is reported failed, not killed. */
export async function killOrphans(
  root: string,
  probe: ProcessProbe = systemProcessProbe,
  signals: OrphanSignals = systemSignals,
): Promise<OrphanKillReport> {
  const scan = await findOrphans(root, probe);
  if ("error" in scan) return { error: scan.error };
  return killTrees(root, scan.rows, scan.orphans, signals);
}

/** The signal-and-wait half of killOrphans: SIGTERM each chosen row's tree from `rows`, wait,
 * SIGKILL the rest, and report what went. */
async function killTrees(
  root: string,
  rows: ProcessRow[],
  chosen: ProcessRow[],
  signals: OrphanSignals,
): Promise<{ killed: KilledOrphan[]; failed: { pid: number; reason: string }[] }> {
  const children = childrenOf(rows);
  const refused = new Map<number, string>();
  const send = (pid: number, signal: NodeJS.Signals): void => {
    try {
      signals.kill(pid, signal);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") refused.set(pid, errorMessage(err));
    }
  };
  const trees = chosen.map((r) => ({ r, pids: [r.pid, ...descendantPids(children, r.pid)] }));
  const all = [...new Set(trees.flatMap((t) => t.pids))];
  for (const pid of all) send(pid, "SIGTERM");
  const stillAlive = (): number[] => all.filter((pid) => !refused.has(pid) && signals.alive(pid));
  const deadline = Date.now() + signals.graceMs;
  while (stillAlive().length > 0 && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, signals.pollMs));
  for (const pid of stillAlive()) send(pid, "SIGKILL");
  const killed: KilledOrphan[] = [];
  const failed: { pid: number; reason: string }[] = [];
  for (const { r, pids } of trees) {
    const bad = pids.find((pid) => refused.has(pid));
    if (bad === undefined) killed.push({ pid: r.pid, command: shownCommand(r.command, root), descendants: pids.length - 1 });
    else failed.push({ pid: bad, reason: refused.get(bad) ?? "" });
  }
  return { killed, failed };
}

/** Team start's reap of a crashed predecessor's leaks: kill the parentless processes whose run
 * marks all name dead harnesses and at least one names `previousPid`, the orchestrator the
 * info file recorded. Safe without an operator's judgment: a mark proves a tumwater start
 * started the process, the previous-pid match scopes it to this repo, and the dead-harness
 * test excludes any run whose own sweep is still coming. A live `previousPid` (a hand-off
 * whose old orchestrator is draining) scans nothing. Orphans caught only by argv or cwd carry
 * no mark read (findOrphans asks marks only of processes argv did not settle) and stay for
 * `doctor --kill-orphans`. Returns the killed count; never throws. */
export async function reapPreviousTeamOrphans(
  root: string,
  previousPid: number,
  probe: ProcessProbe = systemProcessProbe,
  signals: OrphanSignals = systemSignals,
): Promise<number> {
  try {
    if (pidAlive(previousPid)) return 0;
    const scan = await findOrphans(root, probe);
    if ("error" in scan) return 0;
    const chosen = scan.orphans.filter((r) => {
      const marks = scan.marks.get(r.pid) ?? [];
      return marks.length > 0 && marks.every((m) => harnessGone(m) === true) &&
        marks.some((m) => m.startsWith(`${previousPid}-`));
    });
    if (chosen.length === 0) return 0;
    const { killed, failed } = await killTrees(root, scan.rows, chosen, signals);
    const items = killed.map((k) => {
      const tree = k.descendants > 0 ? ` (+${plural(k.descendants, "descendant")})` : "";
      return `pid ${k.pid}${tree} ${k.command}`;
    });
    const refused = failed.map((f) => `could not kill pid ${f.pid}: ${f.reason}`);
    warnEventBestEffort(
      root,
      TUMWATER_SOURCE,
      `killed ${plural(killed.length, "orphaned process", "orphaned processes")} left by tumwater ` +
        `${previousPid}'s runs at team start: ${[...items, ...refused].join("; ")}`,
    );
    return killed.length;
  } catch {
    return 0;
  }
}

/** How long an orphan must have been running before the automatic reap may kill it: a young
 * orphan may still be a live run's process that findOrphans read as parentless mid-hand-off,
 * and ten minutes is far longer than any such attribution would hold. The operator's
 * `--kill-orphans`/dashboard/TUI click bypasses this — doctors judge with their eyes. */
const ORPHAN_REAP_MIN_AGE_MS = 10 * 60 * 1000;

/** The orchestrator's once-per-interval sweep of the orphans `checkOrphans` already reports:
 * kill the same set the operator's `--kill-orphans` kills, once each is old enough that no
 * live run can still own it. Reuses findOrphans' attribution and killTrees' signal-and-wait,
 * so the automatic reap cannot drift from the doctor row or the operator kill and never
 * signals a process findOrphans does not list. An unreadable table, or no old-enough orphan,
 * kills nothing and logs nothing; it never throws. Returns the number of orphan trees killed. */
export async function reapAttributableOrphans(
  root: string,
  probe: ProcessProbe = systemProcessProbe,
  signals: OrphanSignals = systemSignals,
): Promise<number> {
  try {
    const scan = await findOrphans(root, probe);
    if ("error" in scan) return 0;
    const chosen = scan.orphans.filter((r) => parseEtimeMs(r.etime) >= ORPHAN_REAP_MIN_AGE_MS);
    if (chosen.length === 0) return 0;
    const { killed, failed } = await killTrees(root, scan.rows, chosen, signals);
    if (killed.length === 0) return 0;
    const items = killed.map((k) => {
      const tree = k.descendants > 0 ? ` (+${plural(k.descendants, "descendant")})` : "";
      return `pid ${k.pid}${tree} ${k.command}`;
    });
    const refused = failed.map((f) => `could not kill pid ${f.pid}: ${f.reason}`);
    warnEventBestEffort(
      root,
      TUMWATER_SOURCE,
      `reaped ${plural(killed.length, "orphaned process", "orphaned processes")}: ` +
        [...items, ...refused].join("; "),
    );
    return killed.length;
  } catch {
    return 0;
  }
}
