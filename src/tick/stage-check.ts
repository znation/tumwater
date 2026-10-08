/** The landing gate's deterministic checks, run BEFORE a changed tick commits.
 *
 * The gate runs `backlogStructureReason` and `falseFixReason` at landing time, by which point
 * the author's session is over: a finding costs a queue slot, a vet, and a rejection that
 * discards the work (13 phantom-fix rejections between 2026-09-23 and 2026-10-02). Both checks
 * read the worktree and the change's merge-base, so the same questions can be asked at staging
 * time, while the authoring session can still be continued for one fix-up turn. This module
 * runs them over the tick's uncommitted edits; the gate still has the final say.
 *
 * Scope mirrors the gate exactly: `backlogStructureReason` runs on every changed tick, while
 * `falseFixReason` runs only for an exempt (doc-only) diff — the condition under which the gate
 * consults it.
 *
 * Part 2/2 appends git-level, language-neutral findings (PLANS.md "Pre-queue self-check, part
 * 2/2") for path drift, the organize loop's main rejection cause: references left behind by a
 * rename or delete, added lines naming paths that do not exist in the resulting tree, and text
 * files whose final newline the change removed. These stage the change (`git add -A`) to read
 * the index with git only, then restore the index to HEAD before returning: staging is a read
 * aid for the checks, not a change to the tick's state. A git hiccup yields no finding rather
 * than failing the tick. */

import { changedFiles } from "../git/git-diff.js";
import { conflictMarkerReason } from "../landing/landing-git.js";
import { isExemptDiff } from "../review/exemptions.js";
import { backlogStructureReason } from "../backlog/backlog-structure.js";
import { falseFixReason } from "../verdict/fix-claim.js";
import { changeBaseRev } from "../git/git.js";
import { gitTry } from "../git/git-run.js";
import { moreSuffix } from "../text/phrases.js";

/** How many `file:line` hits a single stale-reference finding lists before it stops. */
const MAX_STALE_HITS = 10;
/** How many renamed/deleted paths each stale-reference finding reports before stopping — the
 * cap that keeps a 40-file rename to a bounded finding list. */
const MAX_STALE_PATHS = 10;
/** How many nonexistent added paths one finding names before it stops. */
const MAX_MISSING_PATHS = 10;
/** How many files one lost-final-newline finding names before it stops. */
const MAX_NEWLINE_FILES = 10;

/** The deterministic findings the landing gate would reject this uncommitted change for, or an
 * empty list when it is clean. Checks the worktree at `wt` against `mainBranch`'s merge-base;
 * `exemptPaths` are the config's review-exemption globs that scope the false-fix check.
 *
 * Never throws: a check that fails yields no finding, so a git hiccup at staging time defers to
 * the gate instead of failing the tick. */
export async function stageCheckFindings(
  wt: string,
  mainBranch: string,
  exemptPaths: string[],
): Promise<string[]> {
  const files = await changedFiles(wt).catch(() => null);
  if (files === null || files.length === 0) return [];
  const findings: string[] = [];
  const structure = await backlogStructureReason(wt, mainBranch, files).catch(() => undefined);
  if (structure) findings.push(structure);
  if (isExemptDiff(files, exemptPaths)) {
    const falseFix = await falseFixReason(wt, mainBranch, files).catch(() => undefined);
    if (falseFix) findings.push(falseFix);
  }
  findings.push(...(await gitLevelFindings(wt, mainBranch).catch(() => [])));
  const markers = conflictMarkerReason(wt, files);
  if (markers !== undefined) findings.push(markers);
  return findings;
}

/** The staging finding for a tick that holds a claim but moved a different backlog entry
 * (plans/parallel-work-instances.md "Claims", part 4/7): the assigned entry is the instance's
 * one task, so moving another is the same class of mistake `backlogStructureReason` catches
 * and costs one fix-up turn before the change commits. undefined when nothing moved or the
 * claimed entry itself moved — a landed entry is the expected way to release a claim. */
export function assignedMovedFinding(
  claimKey: string,
  moved: readonly { key: string; title: string }[],
): string | undefined {
  if (moved.length === 0 || moved.some((m) => m.key === claimKey)) return undefined;
  return `this tick is assigned one backlog entry but moved a different one: "${moved[0]!.title}"`;
}

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

/** Stage the change and run the three git-level path checks over the resulting index, then
 * restore the index to HEAD so the staging is invisible to the tick's own change detection.
 * Each check is best-effort: a failed git command contributes nothing. */
async function gitLevelFindings(wt: string, mainBranch: string): Promise<string[]> {
  await gitTry(wt, "add", "-A");
  try {
    const base = await changeBaseRev(wt, mainBranch);
    const entries = parseNameStatus(await gitTry(wt, "diff", "--cached", "-M", "--name-status", base));
    const findings = await staleReferenceFindings(wt, entries);
    const diff = (await gitTry(wt, "diff", "--cached", "-U0", base)) ?? "";
    findings.push(...(await missingPathFindings(wt, diff, entries)));
    findings.push(...newlineFindings(diff));
    return findings;
  } finally {
    // Restore the index to HEAD. Without this, the tick's change detection (changedFiles and
    // stageTickLanding's "nothing left to land" guard) reads the stale index and reports a
    // fix-up that reverted the whole change as still changed, so an empty tree would reach
    // commitAll instead of the tick ending no_change.
    await gitTry(wt, "reset");
  }
}

/** (a) References left behind by a rename or delete: for each `D` path and each `R` origin,
 * `git grep --cached` the old path across the staged tree and report up to MAX_STALE_HITS
 * `file:line` hits. Renames report the path they moved to; deletes report the deletion. */
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
    // `git grep` exits 1 with no output when nothing matches — the common, clean case — and
    // gitTry maps that to null exactly as it maps a real failure, both of which mean "no hits".
    const out = await gitTry(wt, "grep", "-n", "-F", "-I", "--cached", "-e", old);
    if (!out) continue;
    const hits: string[] = [];
    for (const line of out.split("\n")) {
      const m = /^([^:]+):(\d+):(.*)$/.exec(line);
      if (!m || !hasStandalonePathOccurrence(m[3] ?? "", old)) continue;
      hits.push(`${m[1]}:${m[2]}`);
      if (hits.length >= MAX_STALE_HITS) break;
    }
    if (hits.length === 0) continue;
    const moved = e.status === "R" ? `was renamed to ${e.path}` : "was deleted";
    findings.push(`${old} ${moved} but is still named at: ${hits.join(", ")}`);
    reported++;
  }
  return findings;
}

/** True when `needle` appears in `line` as a repo path of its own — not as one segment of a
 * longer path. `git grep -F` matches substrings, so a line naming a rename's destination
 * (`src/config.ts`) would otherwise read as a stale reference to an old root `config.ts`.
 * A preceding path character (or a following one that continues the token, as a `.` extension
 * or an alphanumeric does) disqualifies the occurrence; trailing sentence punctuation does not. */
function hasStandalonePathOccurrence(line: string, needle: string): boolean {
  const pathChar = /[A-Za-z0-9_./-]/;
  for (let i = line.indexOf(needle); i !== -1; i = line.indexOf(needle, i + 1)) {
    const before = i > 0 ? line[i - 1]! : "";
    if (before && pathChar.test(before)) continue;
    const after = line[i + needle.length] ?? "";
    if (/[A-Za-z0-9_/-]/.test(after)) continue;
    if (after === "." && /[A-Za-z0-9]/.test(line[i + needle.length + 1] ?? "")) continue;
    return true;
  }
  return false;
}

/** (b) Nonexistent paths: every path-shaped token on an added diff line whose first segment is
 * a tracked top-level directory but which is absent from the staged tree. Rename origins and
 * deleted paths are excluded — "moved from X" prose names them legitimately. */
async function missingPathFindings(
  wt: string,
  diff: string,
  entries: NameStatusEntry[],
): Promise<string[]> {
  const ls = await gitTry(wt, "ls-files");
  const staged = new Set<string>();
  const topDirs = new Set<string>();
  for (const p of (ls ?? "").split("\n")) {
    if (!p) continue;
    staged.add(p);
    const slash = p.indexOf("/");
    if (slash > 0) topDirs.add(p.slice(0, slash));
  }
  const oldPaths = new Set<string>();
  for (const e of entries) {
    if (e.oldPath) oldPaths.add(e.oldPath);
    if (e.status === "D") oldPaths.add(e.path);
  }
  const seen = new Set<string>();
  const missing: string[] = [];
  // A path-shaped token: at least one slash and a final `.<ext>` segment. Scanned inside the
  // line (not whitespace-split) so surrounding backticks, brackets, and sentence punctuation
  // fall away with the match.
  const tokenRe = /[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.[A-Za-z0-9]+/g;
  for (const line of diff.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    for (const m of line.slice(1).matchAll(tokenRe)) {
      const p = m[0];
      const top = p.slice(0, p.indexOf("/"));
      if (!topDirs.has(top) || oldPaths.has(p) || staged.has(p) || seen.has(p)) continue;
      seen.add(p);
      missing.push(p);
    }
  }
  if (missing.length === 0) return [];
  const shown = missing.slice(0, MAX_MISSING_PATHS);
  const more = moreSuffix(missing.length - shown.length);
  return [`added lines name paths that do not exist in the tree: ${shown.join(", ")}${more}`];
}

/** (c) Lost final newlines: a text file whose new diff side carries git's
 * `\ No newline at end of file` marker while its base side does not. Git emits the marker
 * immediately after the line it applies to, so a marker after a `+` line flags the new side and
 * one after a `-` line flags the base side; a new file (`+` only) counts. Binary files have no
 * line hunks and never appear. */
function newlineFindings(diff: string): string[] {
  const files: string[] = [];
  let path: string | null = null;
  let newLacks = false;
  let oldLacks = false;
  let prev = "";
  const flush = (): void => {
    if (path !== null && newLacks && !oldLacks) files.push(path);
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      path = null;
      newLacks = false;
      oldLacks = false;
      continue;
    }
    if (line.startsWith("+++ ")) {
      path = line.slice(4).replace(/^b\//, "");
      continue;
    }
    if (line.startsWith("\\ No newline at end of file")) {
      if (prev.startsWith("+")) newLacks = true;
      else if (prev.startsWith("-")) oldLacks = true;
      continue;
    }
    if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) prev = line;
  }
  flush();
  if (files.length === 0) return [];
  const shown = files.slice(0, MAX_NEWLINE_FILES);
  const more = moreSuffix(files.length - shown.length);
  return [`the change removes the final newline from: ${shown.join(", ")}${more}`];
}
