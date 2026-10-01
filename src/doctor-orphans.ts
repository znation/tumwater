import fs from "node:fs";
import path from "node:path";
import { worktreesDir } from "./paths.js";
import { pidAlive } from "./process.js";
import { type ProcessProbe, type ProcessRow, systemProcessProbe } from "./process-table.js";
import { errorMessage, truncate } from "./text.js";
import { plural } from "./phrases.js";
import type { CheckOutcome } from "./doctor-checks.js";

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

/** True when an argv's RELATIVE worktree path (`node .tumwater/worktrees/qa/dist/src/cli.js
 * gui …`) is this repo's. Resolved against the process's cwd it must land here; one that lands
 * in a worktree that exists elsewhere belongs to another checkout's fleet and is not blamed on
 * this one. When the resolution lands nowhere — the cwd is unreadable, or is a scratch dir
 * since deleted (the leaked qa GUI's was), or the process chdir'd after exec — the worktree's
 * name is the evidence left: it counts only when this repo has a worktree by that name. */
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

/** How many processes descend from `pid`, given the table's parent → children map — an
 * orphaned test runner's workers keep the runner as their parent, so they are the orphan's
 * tree, not orphans of their own, and killing the runner alone leaves them running. */
function descendantCount(children: Map<number, number[]>, pid: number): number {
  const seen = new Set<number>();
  const stack = [...(children.get(pid) ?? [])];
  for (let p = stack.pop(); p !== undefined; p = stack.pop()) {
    if (seen.has(p) || p === pid) continue;
    seen.add(p);
    stack.push(...(children.get(p) ?? []));
  }
  return seen.size;
}

/** Orphaned worktree processes — the detector half of the grandchild-leak fix (BUGS.md
 * 2026-09-21): a process reparented to PID 1 that belongs to one of this repo's worktrees.
 * Leaks of this kind (a killed tick's tool-call grandchildren, a timed-out build check's test
 * tree, a pi run's backgrounded server, a stray orchestrator an orphaned suite started) hold
 * no lock, write no event and touch no state file, so nothing else in the harness can see
 * them. A process is this repo's when its argv names a path under `.tumwater/worktrees/`
 * (absolute; or relative, confirmed by cwd where it can be — relativeArgvIsOurs) or when its
 * cwd lies under it: a leaked `node dist/test/test-runner.js` names no worktree at all.
 *
 * PPID 1 is what keeps the live fleet out: a running orchestrator's pi runs and build checks
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
 * every mark names a harness pid that is no longer alive is this fleet's orphan: nothing
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
export async function checkOrphans(
  root: string,
  probe: ProcessProbe = systemProcessProbe,
): Promise<CheckOutcome> {
  let rows: ProcessRow[];
  try {
    rows = await probe.list();
  } catch (err) {
    return { level: "warn", detail: `could not scan the process table — ${errorMessage(err)}` };
  }
  const roots = rootSpellings(root);
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
  /** A mark's harness is dead (true), alive (false), or the mark names no harness (null —
   * a torn or foreign value judges nothing rather than counting as dead). */
  const harnessGone = (marker: string): boolean | null => {
    const m = /^(\d+)-/.exec(marker);
    return m ? !pidAlive(Number(m[1])) : null;
  };
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
  if (orphans.length === 0) {
    if (cwdProblem !== null)
      return {
        level: "warn",
        detail: `none named in argv, but process cwds are unreadable (${cwdProblem}) — an orphan started inside a worktree, like a leaked test runner, would be missed`,
      };
    return {
      level: "ok",
      detail: "none — no process reparented to PID 1 runs from .tumwater/worktrees/ or carries only dead runs' marks",
    };
  }
  const children = new Map<number, number[]>();
  for (const r of rows) {
    const siblings = children.get(r.ppid);
    if (siblings) siblings.push(r.pid);
    else children.set(r.ppid, [r.pid]);
  }
  // The root is cut from each shown command, longest spelling first: the resolved one can
  // contain the given one (/private/var/… holds /var/…).
  const cut = [...roots].sort((a, b) => b.length - a.length);
  const listed = orphans.slice(0, ORPHANS_LISTED_MAX).map((r) => {
    const n = descendantCount(children, r.pid);
    const tree = n > 0 ? `, +${plural(n, "descendant")}` : "";
    const command = cut.reduce((c, rt) => c.split(`${rt}/`).join(""), r.command);
    // A mark-caught orphan says which run marked it: the operator killing it wants to know
    // nothing else will, and the dead harness's pid is the evidence argv and cwd lacked.
    const mark = (marks.get(r.pid) ?? []).find((m) => harnessGone(m) === true);
    const marked = mark !== undefined ? ` (run ${mark}; harness ${mark.split("-")[0]} exited)` : "";
    return `pid ${r.pid} (age ${r.etime}, cpu ${r.time}${tree}) ${truncate(command, ORPHAN_COMMAND_MAX)}${marked}`;
  });
  const more = orphans.length - listed.length;
  const count = `${plural(orphans.length, "orphaned process", "orphaned processes")} (PPID 1)`;
  return {
    level: "fail",
    detail:
      `${count}: ${listed.join("; ")}${more > 0 ? `; and ${more} more` : ""}` +
      " — nothing reaps these; kill each with its descendants" +
      (cwdProblem !== null ? ` (process cwds unreadable — ${cwdProblem}; argv matched only)` : ""),
  };
}
