/** The git-level, language-neutral path findings of the staging self-check, split from
 * stage-check.ts (which gathers them with the merge gate's own checks): path drift after a
 * rename or delete, added lines naming paths absent from the resulting tree, a moved-source
 * file whose old path is still named. `gitLevelFindings` also stages the change (`git add -A`)
 * and restores the index to HEAD, and gathers the sibling findings this self-check family owns
 * — the identifier-reference checks (stale-name and moved-name, src/run/stage-name-checks.ts),
 * the diff-format and prose checks (lost newline, detached doc, garbled wording,
 * src/run/stage-prose-checks.ts), and the path checks here — into one list. The shared
 * diff/index reading helpers live in src/run/stage-checks-shared.ts so every check module reads
 * them from one place. The path checks skip record prose (isRecordProse), where an old or
 * not-yet-created path is correct as written. The gate does not run any of them. */

import { changeBaseRev } from "../git/git.js";
import { gitTry } from "../git/git-run.js";
import { pathTokens } from "../text/text.js";
import {
  MAX_STALE_HITS,
  MAX_STALE_PATHS,
  cappedList,
  diffPlusPath,
  diffRemovedAdded,
  gitGrepHits,
  hasStandalonePathOccurrence,
  isRecordProse,
} from "./stage-checks-shared.js";
import { movedNameFindings, staleNameFindings } from "./stage-name-checks.js";
import { detachedDocFindings, garbledWordingFindings, newlineFindings } from "./stage-prose-checks.js";

/** How many nonexistent added paths one finding names before it stops. */
const MAX_MISSING_PATHS = 10;
/** The shortest trimmed line that counts toward a move, so braces and `});` never do. */
const MOVED_LINE_MIN_CHARS = 12;
/** How many moved lines make a modified file a move source. */
const MOVED_LINES_MIN = 10;

/** One `git diff --name-status -M` entry: the status letter (`A`/`M`/`D`/`R`/`C`/`T`), the
 * destination (current) path, and — for a rename or copy — the origin path. */
interface NameStatusEntry {
  status: string;
  path: string;
  oldPath?: string;
}

/** Parse `git diff --cached -M --name-status` output: `M\tpath`, `D\tpath`, or
 * `R100\told\tnew`. Malformed lines are skipped. */
function parseNameStatus(out: string | null): NameStatusEntry[] {
  const entries: NameStatusEntry[] = [];
  for (const line of (out ?? "").split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    const status = (parts[0] ?? "").charAt(0);
    if (!status) continue;
    if (status === "R" || status === "C") {
      const oldPath = parts[1];
      const path = parts[2];
      if (oldPath && path) entries.push({ status, path, oldPath });
    } else if (parts[1]) {
      entries.push({ status, path: parts[1] });
    }
  }
  return entries;
}

/** Stage the change and run the git-level findings over the resulting index, then restore the
 * index to HEAD so the staging is invisible to the run's own change detection. Each check is
 * best-effort: a failed git command contributes nothing. */
export async function gitLevelFindings(wt: string, mainBranch: string): Promise<string[]> {
  await gitTry(wt, "add", "-A");
  try {
    const base = await changeBaseRev(wt, mainBranch);
    const entries = parseNameStatus(await gitTry(wt, "diff", "--cached", "-M", "--name-status", base));
    const findings = await staleReferenceFindings(wt, entries);
    const diff = (await gitTry(wt, "diff", "--cached", "-U0", base)) ?? "";
    findings.push(...(await missingPathFindings(wt, diff, entries)));
    findings.push(...newlineFindings(diff));
    findings.push(...garbledWordingFindings(diff));
    findings.push(...(await detachedDocFindings(wt, diff)));
    findings.push(...(await staleNameFindings(wt, diff)));
    findings.push(...(await movedSourceFindings(wt, diff, entries)));
    findings.push(...(await movedNameFindings(wt, diff)));
    return findings;
  } finally {
    // Restore the index to HEAD. Without this, the run's change detection (changedFiles and
    // stageRunMerge's "nothing left to merge" guard) reads the stale index and reports a
    // fix-up that reverted the whole change as still changed, so an empty tree would reach
    // commitAll instead of the run ending no_change.
    await gitTry(wt, "reset");
  }
}

/** `git grep --cached` for `needle`, returning its matching `file:line` strings that sit outside
 * record prose and (when given) `excludeFile`, and that name `needle` as a path of its own. The
 * single home of the two stale-reference sweeps, movedSourceFindings and staleReferenceFindings:
 * both run the same fixed-string grep and filter its hits the same way before capping at
 * MAX_STALE_HITS, so one helper keeps them from drifting. */
async function pathGrepHits(wt: string, needle: string, excludeFile?: string): Promise<string[]> {
  // `git grep` exits 1 with no output when nothing matches — the common, clean case — and
  // gitTry maps that to null exactly as it maps a real failure, both of which mean "no hits".
  const out = await gitTry(wt, "grep", "-n", "-F", "-I", "--cached", "-e", needle);
  if (!out) return [];
  const hits: string[] = [];
  for (const { file, no, text } of gitGrepHits(out)) {
    if (file === excludeFile || isRecordProse(file)) continue;
    if (!hasStandalonePathOccurrence(text, needle)) continue;
    hits.push(`${file}:${no}`);
    if (hits.length >= MAX_STALE_HITS) break;
  }
  return hits;
}

/** One moved-source file's line delta: its removed `-` lines and its added `+` set, each line
 * trimmed and at least MOVED_LINE_MIN_CHARS long so braces and `});` never count toward a move. */
interface MovedLineDelta {
  removed: string[];
  added: Set<string>;
}

/** The moved-line delta per changed file, from `diffRemovedAdded(diff)`: each file's removed
 * lines and added set, trimmed and filtered at MOVED_LINE_MIN_CHARS. The single place the
 * walk and its threshold live, so a reader asking what counts as a moved line finds it here. */
function movedLineDeltas(diff: string): Map<string, MovedLineDelta> {
  const files = new Map<string, MovedLineDelta>();
  for (const f of diffRemovedAdded(diff)) {
    const removed = f.removed.map((l) => l.trim()).filter((l) => l.length >= MOVED_LINE_MIN_CHARS);
    const added = new Set(f.added.map((l) => l.trim()).filter((l) => l.length >= MOVED_LINE_MIN_CHARS));
    files.set(f.path, { removed, added });
  }
  return files;
}

/** Which files count as receivers of a move source: the other files whose added set contains
 * at least one of the source's removed lines, in diff order. */
function movedLineReceivers(
  src: MovedLineDelta,
  others: ReadonlyArray<[string, MovedLineDelta]>,
): string[] {
  return others.filter(([, v]) => src.removed.some((l) => v.added.has(l))).map(([f]) => f);
}

/** How many of the source's removed lines another file added verbatim. */
function movedLineCount(
  src: MovedLineDelta,
  others: ReadonlyArray<[string, MovedLineDelta]>,
): number {
  return src.removed.filter((l) => others.some(([, v]) => v.added.has(l))).length;
}

/** The moved-source finding wording: the source path, its moved-line count, the receiving
 * files (capped at MAX_STALE_PATHS) and the still-matching `file:line` hits to re-check. */
function movedSourceFinding(
  path: string,
  moved: number,
  receivers: string[],
  hits: string[],
): string {
  return (
    `${path} had ${moved} lines moved to ${cappedList(receivers, MAX_STALE_PATHS)}, but it is ` +
      `still named at: ${hits.join(", ")} — check each still describes what stays in ${path}, ` +
      `and point any that describes the moved code at its new file`
  );
}

/** (f) References to a file the change moved code out of. A modified (`M`) file is a source
 * when at least MOVED_LINES_MIN of its removed `-U0` lines (trimmed, at least MOVED_LINE_MIN_CHARS
 * long) were added verbatim to another file. Each hit of the source's path outside record prose
 * and the source itself, including in a receiver, is listed for the author to re-check. Record
 * prose is never a source: archiving a finished entry (PLANS.md → PLANS-DONE.md) or moving a
 * section between design docs moves an entry, not code, and a reference names the file, which
 * stays correct. Before this skip, each finished plan drew the finding on README.md and docs,
 * and revision runs that rightly changed nothing were rejected until the review chain ran out
 * (6 of 7 exhausted chains on 2026-10-20 and -21). */
async function movedSourceFindings(
  wt: string,
  diff: string,
  entries: NameStatusEntry[],
): Promise<string[]> {
  const files = movedLineDeltas(diff);
  const findings: string[] = [];
  for (const e of entries) {
    if (e.status !== "M" || isRecordProse(e.path)) continue;
    if (findings.length >= MAX_STALE_PATHS) break;
    const src = files.get(e.path);
    if (!src) continue;
    const others = [...files].filter(([f]) => f !== e.path);
    const moved = movedLineCount(src, others);
    if (moved < MOVED_LINES_MIN) continue;
    const hits = await pathGrepHits(wt, e.path, e.path);
    if (hits.length === 0) continue;
    findings.push(movedSourceFinding(e.path, moved, movedLineReceivers(src, others), hits));
  }
  return findings;
}

/** (a) References left behind by a rename or delete: for each `D` path and each `R` origin,
 * `git grep --cached` the old path across the staged tree and report up to MAX_STALE_HITS
 * `file:line` hits outside record prose (isRecordProse). Renames report the path they moved to;
 * deletes report the deletion. */
async function staleReferenceFindings(
  wt: string,
  entries: NameStatusEntry[],
): Promise<string[]> {
  const findings: string[] = [];
  let reported = 0;
  for (const e of entries) {
    if (e.status !== "D" && e.status !== "R") continue;
    if (reported >= MAX_STALE_PATHS) break;
    const old = e.oldPath ?? e.path;
    const hits = await pathGrepHits(wt, old);
    if (hits.length === 0) continue;
    const moved = e.status === "R" ? `was renamed to ${e.path}` : "was deleted";
    findings.push(`${old} ${moved} but is still named at: ${hits.join(", ")}`);
    reported++;
  }
  return findings;
}

/** The staged tree as the added-path check needs it: the set of every tracked path and the set
 * of its top-level directories, from `git ls-files`. */
async function readStagedIndex(
  wt: string,
): Promise<{ staged: Set<string>; topDirs: Set<string> }> {
  const ls = await gitTry(wt, "ls-files");
  const staged = new Set<string>();
  const topDirs = new Set<string>();
  for (const p of (ls ?? "").split("\n")) {
    if (!p) continue;
    staged.add(p);
    const slash = p.indexOf("/");
    if (slash > 0) topDirs.add(p.slice(0, slash));
  }
  return { staged, topDirs };
}

/** The paths a change moved code away from and must not flag: every rename origin and every
 * deleted path in `entries`, which "moved from X" prose names legitimately. */
function renameOriginPaths(entries: NameStatusEntry[]): Set<string> {
  const oldPaths = new Set<string>();
  for (const e of entries) {
    if (e.oldPath) oldPaths.add(e.oldPath);
    if (e.status === "D") oldPaths.add(e.path);
  }
  return oldPaths;
}

/** The path-shaped tokens an added line names that are absent from the staged tree: a token whose
 * first segment is a tracked top-level directory, not a rename origin or deleted path, not
 * already staged, and not already seen. Each returned token is added to `seen` as it goes. */
function missingPathTokens(
  line: string,
  staged: Set<string>,
  topDirs: Set<string>,
  oldPaths: Set<string>,
  seen: Set<string>,
): string[] {
  const found: string[] = [];
  for (const p of pathTokens(line.slice(1))) {
    const top = p.slice(0, p.indexOf("/"));
    if (!topDirs.has(top) || oldPaths.has(p) || staged.has(p) || seen.has(p)) continue;
    seen.add(p);
    found.push(p);
  }
  return found;
}

/** Every added diff line's missing-path tokens, tracking the current file to spare added lines in
 * test/ and in record prose (isRecordProse). */
function missingPathsInDiff(
  diff: string,
  staged: Set<string>,
  topDirs: Set<string>,
  oldPaths: Set<string>,
): string[] {
  const seen = new Set<string>();
  const missing: string[] = [];
  let file: string | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      file = diffPlusPath(line);
      continue;
    }
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    // A test file's fixtures routinely name paths from the software under test, which need
    // not exist here, and record prose names the paths a plan proposes to create; the
    // added-nonexistent-path heuristic targets real references, so it spares added lines in
    // test/ and in record prose (isRecordProse).
    if (file !== null && (file.startsWith("test/") || isRecordProse(file))) continue;
    missing.push(...missingPathTokens(line, staged, topDirs, oldPaths, seen));
  }
  return missing;
}

/** (b) Nonexistent paths: every path-shaped token on an added diff line whose first segment is
 * a tracked top-level directory but which is absent from the staged tree. Rename origins and
 * deleted paths are excluded — "moved from X" prose names them legitimately. */
async function missingPathFindings(
  wt: string,
  diff: string,
  entries: NameStatusEntry[],
): Promise<string[]> {
  const { staged, topDirs } = await readStagedIndex(wt);
  const oldPaths = renameOriginPaths(entries);
  const missing = missingPathsInDiff(diff, staged, topDirs, oldPaths);
  if (missing.length === 0) return [];
  return [
    `added lines name paths that do not exist in the tree: ${cappedList(missing, MAX_MISSING_PATHS)}`,
  ];
}
