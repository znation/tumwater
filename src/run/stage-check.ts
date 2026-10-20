// vocabulary: plain
/** The merge gate's deterministic checks, run BEFORE a changed run commits.
 *
 * The gate runs `backlogStructureReason` and `falseFixReason` at merge time, by which point
 * the author's session is over: a finding costs a queue slot, a verification, and a rejection that
 * discards the work (13 phantom-fix rejections between 2026-09-23 and 2026-10-02). Both checks
 * read the worktree and the change's merge-base, so the same questions can be asked at staging
 * time, while the authoring session can still be continued for one fix-up turn. This module
 * runs them over the run's uncommitted edits; the gate still has the final say.
 *
 * Scope mirrors the gate exactly: `backlogStructureReason` runs on every changed run, while
 * `falseFixReason` runs only for an exempt (doc-only) diff — the condition under which the gate
 * consults it.
 *
 * Part 2/2 appends git-level, language-neutral findings (PLANS.md "Pre-queue self-check, part
 * 2/2") for path drift, the organize role's main rejection cause: references left behind by a
 * rename or delete, added lines naming paths that do not exist in the resulting tree, and text
 * files whose final newline the change removed. These stage the change (`git add -A`) to read
 * the index with git only, then restore the index to HEAD before returning: staging is a read
 * aid for the checks, not a change to the run's state. A git hiccup yields no finding rather
 * than failing the run. Unlike the backlog checks above, the gate does not run these: they are
 * heuristics for what a reviewer tends to reject, so neither path check looks inside record
 * prose (isRecordProse), where an old or not-yet-created path is correct as written.
 *
 * A fourth check, `staleNameFindings`, reports a compound identifier the change removed from a
 * JS/TS file that a comment or doc still names (the compiler catches code, not prose). It
 * exempts a name the change re-declares (a move), a name another file still declares, an
 * occurrence inside a string literal (legacy-name tables and serialized keys keep old names on
 * purpose), a line marked `retired-name-ok`, and record prose, where history names old things.
 * A fifth, `detachedDocFindings`, reads the same `-U0` diff for a JSDoc block the change
 * separated from its declaration: code inserted between the two, or a declaration deleted
 * while its doc stayed.
 *
 * A fifth check, `garbledWordingFindings`, reports added lines (outside record prose) that carry
 * the broken participles and doubled "run" wording a word-swap rename leaves (has/have/had … ran,
 * a hyphen before ran, "run" repeated back to back). Like the path checks, the gate does not
 * run it.
 *
 * `planDependencyFinding` is staging-only: it is not part of the review gate or the in-lock
 * merge re-check, because `tumwater doctor`'s plan-dependency warning is the backstop for
 * anything that gets past the fix-up turn. `waitingNoteFinding` is staging-only and bugfix-only
 * for the same reason: it nudges a bugfix run that left a Progress note without the hold.
 * Like `planDependencyFinding`, `finishedDuplicateFindings` runs only at staging. The gate does
 * not run it, because the sweep that creates the second copy runs after it. */

import path from "node:path";
import { changedFiles } from "../git/git-diff.js";
import { conflictMarkerReason } from "../merge/merge-git.js";
import { isExemptDiff } from "../review/exemptions.js";
import { backlogStructureReason, finishedTitle, readdedHeadings } from "../backlog/backlog-structure.js";
import { protectedEditReason } from "../review/protected-edits.js";
import { secretLeakReason } from "../review/secret-leaks.js";
import { falseFixReason } from "../verdict/fix-claim.js";
import { changeBaseRev, fileContentAt } from "../git/git.js";
import { readTextOrNull } from "../files/files.js";
import { BACKLOG_FILES, FINISHED_ARCHIVES, finishedArchiveOf, parseEntryDetails, type FinishedArchive } from "../backlog/backlog-md.js";
import { DONE_DATE_RE, FIXED_DATE_RE } from "../backlog/backlog.js";
import { entryKey, planDependencyProblems, refusalNote, waitingNote } from "../backlog/backlog-eligibility.js";
import { baseRoleOf } from "../roles/runner-ids.js";
import { WAITING_FOR_FAILURE_NOTE } from "../roles/role-guidance.js";
import { gitTry } from "../git/git-run.js";
import { moreSuffix } from "../text/phrases.js";
import { collapseWhitespace, truncate } from "../text/text.js";

/** Where finished plans are archived (plans/backlog-archive.md). */
const PLANS_ARCHIVE = finishedArchiveOf("PLANS.md").archive;

/** How many `file:line` hits a single stale-reference finding lists before it stops. */
const MAX_STALE_HITS = 10;
/** How many renamed/deleted paths each stale-reference finding reports before stopping — the
 * cap that keeps a 40-file rename to a bounded finding list. */
const MAX_STALE_PATHS = 10;
/** How many nonexistent added paths one finding names before it stops. */
const MAX_MISSING_PATHS = 10;
/** How many files one lost-final-newline finding names before it stops. */
const MAX_NEWLINE_FILES = 10;
/** How many `file:line` sites one detached-doc finding names before it stops. */
const MAX_DETACHED_DOCS = 10;

/** The path a unified diff's `+++ b/<path>` header names. Strips the four-character `+++ `
 * marker and git's `b/` prefix. A deleted file's new side is `+++ /dev/null`, which carries no
 * `b/` prefix and is returned as `/dev/null`. */
function diffPlusPath(line: string): string {
  return line.slice(4).replace(/^b\//, "");
}

/** True for record prose: a backlog file (BACKLOG_FILES: PLANS.md, BUGS.md, QUESTIONS.md and the
 * finished-entry archives) or a markdown design doc under `plans/`. They record history and
 * describe planned work, so a path there is correct as written even when it is absent from the
 * tree: a finished entry names a file as it was, and a plan names the file it will create or
 * both sides of the move it describes. Asking a rename to sweep them rewrote "old → new" into
 * "new → new" and history into the present; that failure took five rejections on
 * one rename on 2026-10-18 and -19. */
function isRecordProse(file: string): boolean {
  const base = file.slice(file.lastIndexOf("/") + 1);
  return BACKLOG_FILES.has(base) || (file.startsWith("plans/") && file.endsWith(".md"));
}

/** The capped list a finding line appends: at most `max` entries joined by ", ", then
 * `moreSuffix` for the rest. Shared by the missing-path and lost-final-newline findings so both
 * cap and join identically. */
function cappedList(items: readonly string[], max: number): string {
  const shown = items.slice(0, max);
  return `${shown.join(", ")}${moreSuffix(items.length - shown.length)}`;
}

/** The finding for the heading `requires` clause problems that `head` (the edited PLANS.md)
 * adds over `base` (its text at the merge-base), or undefined when it adds none; `archivedTitles`
 * (PLANS-DONE.md's headings) count as existing headings on both sides. Only new
 * problems count: one already on main is not this run's fault and stays doctor's to report, so
 * the author is never asked to fix another run's heading. The most serious new problem is named
 * — cycle, then dangling, unparsed, then misworded — with a count of the rest. */
export function planDependencyFinding(head: string, base: string, archivedTitles: readonly string[] = []): string | undefined {
  const problems = (text: string) =>
    planDependencyProblems(
      parseEntryDetails(text, "Planned"),
      [...parseEntryDetails(text, "Done").map((e) => e.title), ...archivedTitles],
    );
  const was = problems(base);
  const now = problems(head);
  const newCycle = now.cycle !== null && was.cycle === null ? now.cycle : null;
  const newDangling = now.dangling.filter((d) => !was.dangling.some((b) => b.title === d.title && b.ref === d.ref));
  const newUnparsed = now.unparsed.filter((t) => !was.unparsed.includes(t));
  const newMisworded = now.misworded.filter((m) => !was.misworded.some((b) => b.title === m.title && b.ref === m.ref));
  const total = (newCycle !== null ? 1 : 0) + newDangling.length + newUnparsed.length + newMisworded.length;
  if (total === 0) return undefined;
  let first: string;
  if (newCycle !== null) {
    first = `PLANS.md's requires clauses now form a cycle: ${newCycle.join(" → ")} — every part on it stays blocked forever; ` + // vocabulary-ok: PLANS.md heading syntax
      "edit one heading's `requires … landed` clause to break it"; // vocabulary-ok: PLANS.md heading syntax
  } else if (newDangling.length > 0) {
    const d = newDangling[0]!;
    first = `PLANS.md plan "${d.title}" requires ${d.ref}, which no PLANS.md heading carries — the claim allocator ` +
      "ignores the clause and hands the plan out now; fix the series name or part number to match the prerequisite's heading";
  } else if (newUnparsed.length > 0) {
    first = `PLANS.md plan "${newUnparsed[0]!}" has a \`requires … landed\` clause that names no part the claim allocator can read — ` + // vocabulary-ok: PLANS.md heading syntax
      "it holds nothing; write each ref as `<Series> i/n` or `part i/n` after a `<Series>, part i/n:` heading prefix";
  } else {
    const w = newMisworded[0]!;
    first = `PLANS.md plan "${w.title}" names ${w.ref} as a prerequisite without a \`requires … landed\` clause — ` + // vocabulary-ok: PLANS.md heading syntax
      "the claim allocator ignores that wording and hands the part out now; write it as `requires part i/n landed` — fix it before this change commits"; // vocabulary-ok: PLANS.md heading syntax
  }
  return `${first}${moreSuffix(total - 1)}`;
}

/** A finished heading's identity across done dates: the title without its completion stamp and
 * its `(planned …)`/`(found …)` parenthetical, whitespace-collapsed. */
function finishedKey(title: string, dateRe: RegExp): string {
  return collapseWhitespace(finishedTitle(title, dateRe));
}

/** The findings for a finished entry that the change leaves in the archive too: a live
 * `## Done`/`## Fixed` entry the head archive already holds under another stamp (the sweep would
 * move it as a new entry, or leave it beside an edited copy), and an archive entry the change
 * added a second time under a new stamp. At most one finding per rule. An exact copy of an
 * archived entry (same heading and body) is skipped: the sweep drops it. A second copy under an
 * identical heading is skipped too: `backlogStructureReason` reports it. */
export function finishedDuplicateFindings(
  spec: FinishedArchive,
  live: { head: string; base: string },
  archive: { head: string; base: string },
): string[] {
  const dateRe = spec.file === "PLANS.md" ? DONE_DATE_RE : FIXED_DATE_RE;
  const keyed = (md: string) =>
    parseEntryDetails(md, spec.section).map((e) => ({ ...e, key: finishedKey(e.title, dateRe) }));
  const findings: string[] = [];
  const liveBase = new Set(keyed(live.base).map((e) => e.key));
  const archived = keyed(archive.head);
  const copy = keyed(live.head).find((e) => {
    if (liveBase.has(e.key)) return false;
    const held = archived.filter((a) => a.key === e.key);
    if (held.length === 0) return false;
    const heading = collapseWhitespace(e.title);
    return !held.some((a) => collapseWhitespace(a.title) === heading && a.body === e.body);
  });
  if (copy !== undefined) {
    findings.push(
      `${spec.file}'s "## ${spec.section}" entry "${truncate(copy.title, 160)}" is already archived in ${spec.archive} — ` +
        "the commit-time sweep would leave two copies; edit the archived entry in place (its text and its stamp) and delete this copy",
    );
  }
  if (readdedHeadings(archive.base, archive.head).length === 0) {
    const count = (entries: { key: string }[], key: string) => entries.filter((e) => e.key === key).length;
    const was = keyed(archive.base);
    const twice = archived.find((e) => count(archived, e.key) > 1 && count(archived, e.key) > count(was, e.key));
    if (twice !== undefined) {
      findings.push(
        `${spec.archive} holds "${truncate(twice.title, 160)}" ${count(archived, twice.key)} times — this change added a copy under a different heading or stamp; ` +
          "keep the archived entry once, edited in place, and delete the other copies",
      );
    }
  }
  return findings;
}

/** The number of `- **Progress …` lines in an entry body. */
function progressCount(body: string): number {
  return body.split("\n").filter((l) => /^-\s+\*\*Progress\b/.test(l.trim())).length;
}

/** The finding for a BUGS.md bug that `head` (the edited file) shows with more Progress notes
 * than `base` (its text at the merge-base) while it stays under `## Open` with neither a Waiting
 * note nor a Refused note — bugfix's step 2 asks a run that cannot reproduce a bug to write the
 * Waiting note, and runs that skip it leave the bug open to re-investigation. A newly filed bug
 * is not a re-investigation. Names the first such bug in file order, with a count of the rest. */
export function waitingNoteFinding(head: string, base: string): string | undefined {
  const was = new Map(parseEntryDetails(base, "Open").map((e) => [entryKey(e.title), e.body]));
  const counting = parseEntryDetails(head, "Open").filter((e) => {
    const before = was.get(entryKey(e.title));
    return (
      before !== undefined &&
      progressCount(e.body) > progressCount(before) &&
      waitingNote(e.body) === null &&
      refusalNote(e.body) === null
    );
  });
  if (counting.length === 0) return undefined;
  return (
    `BUGS.md bug "${counting[0]!.title}" gained a Progress note but stays open with no Waiting for the next ` +
    `failure note — if this run could not reproduce it, add ${WAITING_FOR_FAILURE_NOTE} as its own line under ` +
    `the heading so later runs wait for new evidence (bugfix's step 2); if it did reproduce, leave the entry ` +
    `as it is${moreSuffix(counting.length - 1)}`
  );
}

/** The findings likely to get this uncommitted change rejected at merge, or an empty list when
 * it is clean: the merge gate's own deterministic checks plus the staging-only heuristics (plan
 * dependencies, the bugfix Waiting note, path drift). Checks the worktree at `wt` against
 * `mainBranch`'s merge-base; `exemptPaths` are the config's review-exemption globs that scope
 * the false-fix check.
 *
 * Never throws: a check that fails yields no finding, so a git hiccup at staging time defers to
 * the gate instead of failing the run. */
export async function stageCheckFindings(
  wt: string,
  mainBranch: string,
  exemptPaths: string[],
  role: string,
): Promise<string[]> {
  const files = await changedFiles(wt).catch(() => null);
  if (files === null || files.length === 0) return [];
  const findings: string[] = [];
  const structure = await backlogStructureReason(wt, mainBranch, files).catch(() => undefined);
  if (structure) findings.push(structure);
  if (files.includes("PLANS.md")) {
    const head = readTextOrNull(path.join(wt, "PLANS.md")) ?? "";
    const base = await fileContentAt(wt, await changeBaseRev(wt, mainBranch), "PLANS.md").catch(() => undefined);
    // Finished plans are archived in PLANS-DONE.md (plans/backlog-archive.md): a requires clause
    // naming a merged part resolves there, on both sides of the comparison alike.
    const archived = parseEntryDetails(readTextOrNull(path.join(wt, PLANS_ARCHIVE)) ?? "", "Done").map((e) => e.title);
    const dependency = base === undefined ? undefined : planDependencyFinding(head, base, archived);
    if (dependency !== undefined) findings.push(dependency);
  }
  const baseRev = FINISHED_ARCHIVES.some((s) => files.includes(s.file) || files.includes(s.archive))
    ? await changeBaseRev(wt, mainBranch).catch(() => undefined)
    : undefined;
  for (const spec of FINISHED_ARCHIVES) {
    if (baseRev === undefined || !(files.includes(spec.file) || files.includes(spec.archive))) continue;
    const duplicates = await (async () => {
      const read = (f: string) => readTextOrNull(path.join(wt, f)) ?? "";
      const at = async (f: string) => (await fileContentAt(wt, baseRev, f)) ?? "";
      return finishedDuplicateFindings(
        spec,
        { head: read(spec.file), base: await at(spec.file) },
        { head: read(spec.archive), base: await at(spec.archive) },
      );
    })().catch(() => []);
    findings.push(...duplicates);
  }
  if (baseRoleOf(role) === "bugfix" && files.includes("BUGS.md")) {
    const head = readTextOrNull(path.join(wt, "BUGS.md")) ?? "";
    const base = await fileContentAt(wt, await changeBaseRev(wt, mainBranch), "BUGS.md").catch(() => undefined);
    const waiting = base === undefined ? undefined : waitingNoteFinding(head, base);
    if (waiting !== undefined) findings.push(waiting);
  }
  const protectedReason = await protectedEditReason(wt, mainBranch, files, role).catch(() => undefined);
  if (protectedReason) findings.push(protectedReason);
  const secretReason = await secretLeakReason(wt, mainBranch, files).catch(() => undefined);
  if (secretReason) findings.push(secretReason);
  if (isExemptDiff(files, exemptPaths)) {
    const falseFix = await falseFixReason(wt, mainBranch, files).catch(() => undefined);
    if (falseFix) findings.push(falseFix);
  }
  findings.push(...(await gitLevelFindings(wt, mainBranch).catch(() => [])));
  const markers = conflictMarkerReason(wt, files);
  if (markers !== undefined) findings.push(markers);
  return findings;
}

/** The staging finding for a run that holds a claim but moved a different backlog entry
 * (plans/parallel-work-instances.md "Claims", part 4/7): the assigned entry is the instance's
 * one task, so moving another is the same class of mistake `backlogStructureReason` catches
 * and costs one fix-up turn before the change commits. undefined when nothing moved or the
 * claimed entry itself moved — a merged entry is the expected way to release a claim. */
export function assignedMovedFinding(
  claimKey: string,
  moved: readonly { key: string; title: string }[],
): string | undefined {
  if (moved.length === 0 || moved.some((m) => m.key === claimKey)) return undefined;
  return `this run is assigned one backlog entry but moved a different one: "${moved[0]!.title}"`;
}

/** The staging finding for an unassigned run that moved a backlog entry a sibling instance
 * holds — one the poll listed in the run's `<held-entries>` note (RunnerState.heldElsewhere).
 * The note is advice the model can ignore; this is the deterministic backstop at the same
 * point as assignedMovedFinding (BUGS.md 2026-10-12: 24 of 29 staged claims duplicated a
 * sibling's held entry, and each duplicate cost a gate check, a review, and a conflict
 * resolver run holding the merge slot). The fix-up turn is asked to drop the duplicate work.
 * A change that held nothing else then ends with no change to merge. undefined when no moved
 * entry is held. */
export function heldMovedFinding(
  heldKeys: ReadonlySet<string>,
  moved: readonly { key: string; title: string }[],
): string | undefined {
  const dup = moved.find((m) => heldKeys.has(m.key));
  if (dup === undefined) return undefined;
  return (
    `this run moved a backlog entry another instance of this role is working on: "${dup.title}" — it is that ` +
    `instance's task (see <held-entries>), so revert every edit made for it, including the ` +
    `entry's move, and leave nothing behind if that was the whole change`
  );
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
 * restore the index to HEAD so the staging is invisible to the run's own change detection.
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
    findings.push(...garbledWordingFindings(diff));
    findings.push(...(await detachedDocFindings(wt, diff)));
    findings.push(...(await staleNameFindings(wt, diff)));
    return findings;
  } finally {
    // Restore the index to HEAD. Without this, the run's change detection (changedFiles and
    // stageRunMerge's "nothing left to merge" guard) reads the stale index and reports a
    // fix-up that reverted the whole change as still changed, so an empty tree would reach
    // commitAll instead of the run ending no_change.
    await gitTry(wt, "reset");
  }
}

/** A line that can carry a doc comment: a keyword declaration or a class member or field. */
const DOC_TARGET = new RegExp(
  "^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?(?:async\\s+)?" +
    "(?:function\\b|const\\b|let\\b|var\\b|class\\b|interface\\b|type\\b|enum\\b)" +
    "|^\\s*(?:(?:public|private|protected|static|readonly|async|get|set|override)\\s+)*" +
    "#?[A-Za-z_$][\\w$]*\\??\\s*[(<:=]",
);

/** True when `lines[i]` (0-based) ends a JSDoc block: it ends with a block-comment close and the
 * nearest line at or above it containing a block-comment open starts, trimmed, with `/**`. */
function closesDocComment(lines: string[], i: number): boolean {
  if (!(lines[i] ?? "").trim().endsWith("*/")) return false;
  for (let j = i; j >= 0; j--) {
    if (lines[j]!.includes("/*")) return lines[j]!.trim().startsWith("/**");
  }
  return false;
}

/** (e) Doc comments the change detached from their declaration, read from the `-U0` diff of
 * JS/TS files. Insertion: a pure-add hunk lands code between a doc block and the declaration
 * below it, so the doc now describes the inserted code. Deletion: a pure-delete hunk removes a
 * declaration but leaves the doc block above it, which then documents the next declaration. */
async function detachedDocFindings(wt: string, diff: string): Promise<string[]> {
  interface Hunk {
    c: number;
    d: number;
    removed: string[];
    added: string[];
  }
  const inserted: string[] = [];
  const deleted: string[] = [];
  const check = (file: string, hunks: Hunk[], lines: string[]): void => {
    const addedAt = new Set<number>();
    for (const h of hunks) for (let k = 0; k < h.d; k++) addedAt.add(h.c + k);
    for (const h of hunks) {
      if (h.removed.length === 0 && h.d > 0) {
        const target = lines[h.c + h.d - 1];
        if (
          h.c >= 2 && !addedAt.has(h.c - 1) && closesDocComment(lines, h.c - 2) &&
          h.added.some((l) => DOC_TARGET.test(l)) && target !== undefined && DOC_TARGET.test(target)
        ) inserted.push(`${file}:${h.c - 1}`);
      } else if (h.d === 0 && h.removed.some((l) => DOC_TARGET.test(l))) {
        if (h.c >= 1 && !addedAt.has(h.c) && closesDocComment(lines, h.c - 1)) deleted.push(`${file}:${h.c}`);
      }
    }
  };
  let file: string | null = null;
  let hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  const flush = async (): Promise<void> => {
    if (file !== null && hunks.length > 0) {
      const text = readTextOrNull(path.join(wt, file));
      if (text !== null) check(file, hunks, text.split("\n"));
    }
    file = null;
    hunks = [];
    cur = null;
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      await flush();
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = diffPlusPath(line);
      file = p !== "/dev/null" && JS_FILE.test(p) ? p : null;
      continue;
    }
    if (file === null) continue;
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) {
      cur = { c: Number(m[1]), d: m[2] === undefined ? 1 : Number(m[2]), removed: [], added: [] };
      hunks.push(cur);
    } else if (cur && line.startsWith("-")) cur.removed.push(line.slice(1));
    else if (cur && line.startsWith("+")) cur.added.push(line.slice(1));
  }
  await flush();
  const findings: string[] = [];
  if (inserted.length > 0) {
    findings.push(
      `code was inserted between a doc comment and the declaration it documents, so the doc now describes the inserted code: ${cappedList(inserted, MAX_DETACHED_DOCS)} — move the inserted code above the doc comment or below that declaration`,
    );
  }
  if (deleted.length > 0) {
    findings.push(
      `a declaration was deleted but its doc comment was kept, so the doc now documents the next declaration: ${cappedList(deleted, MAX_DETACHED_DOCS)} — delete the doc comment with it`,
    );
  }
  return findings;
}

/** How many removed identifiers one stale-name check looks up. */
const MAX_STALE_NAMES = 40;

const JS_FILE = /\.(?:ts|tsx|js|mjs)$/;

/** The identifiers a source line declares: keyword declarations (`function`, `const`, `let`,
 * `var`, `class`, `interface`, `type`, `enum`) and a property or field signature at the start of
 * the line. A call line declares nothing. */
export function declaredNames(line: string): string[] {
  const names: string[] = [];
  const keyword = /\b(?:function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
  for (const m of line.matchAll(keyword)) names.push(m[1]!);
  const field = /^\s*(?:(?:readonly|public|private|protected|static)\s+)*([A-Za-z_$][\w$]*)\??\s*:/.exec(line);
  if (field) names.push(field[1]!);
  return names;
}

/** True for a name worth looking up: camelCase/PascalCase (a lowercase letter then an uppercase
 * one) or UPPER_SNAKE with an underscore, so common words never count. */
function isCompoundName(name: string): boolean {
  return /[a-z][A-Z]/.test(name) || /^[A-Z0-9_]+$/.test(name) && name.includes("_");
}

/** True when the occurrence starting at `index` sits inside a closed `"…"` or `'…'` literal on
 * `line`. An unclosed quote (an apostrophe in prose) does not count. */
function insideStringLiteral(line: string, index: number): boolean {
  let open: string | null = null;
  let openAt = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (open === null) {
      if (c === '"' || c === "'") {
        open = c;
        openAt = i;
      }
    } else if (c === "\\") {
      i++;
    } else if (c === open) {
      if (openAt < index && index < i) return true;
      open = null;
    }
  }
  return false;
}

/** (d) Compound identifiers the change removed from JS/TS source that a comment or doc still
 * names. Candidates come from removed `-U0` lines; one `git grep -w --cached` covers them all. */
async function staleNameFindings(wt: string, diff: string): Promise<string[]> {
  const removed: string[] = [];
  const added = new Set<string>();
  let jsFile = false;
  for (const line of diff.split("\n")) {
    const header = /^diff --git a\/.* b\/(.*)$/.exec(line);
    if (header) {
      jsFile = JS_FILE.test(header[1]!);
      continue;
    }
    if (!jsFile) continue;
    if (line.startsWith("-") && !line.startsWith("---")) {
      removed.push(...declaredNames(line.slice(1)));
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      for (const n of declaredNames(line.slice(1))) added.add(n);
    }
  }
  const candidates = [...new Set(removed)]
    .filter((n) => isCompoundName(n) && !added.has(n))
    .slice(0, MAX_STALE_NAMES);
  if (candidates.length === 0) return [];
  const out = await gitTry(wt, "grep", "-n", "-w", "-I", "--cached", ...candidates.flatMap((n) => ["-e", n]));
  if (!out) return [];
  const lines: { file: string; no: string; text: string }[] = [];
  for (const line of out.split("\n")) {
    const m = /^([^:]+):(\d+):(.*)$/.exec(line);
    if (m) lines.push({ file: m[1]!, no: m[2]!, text: m[3] ?? "" });
  }
  const findings: string[] = [];
  for (const name of candidates) {
    if (findings.length >= MAX_STALE_PATHS) break;
    const word = new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`, "g");
    const mine = lines.filter((l) => [...l.text.matchAll(word)].length > 0);
    // Another module may still own the name.
    if (mine.some((l) => JS_FILE.test(l.file) && declaredNames(l.text).includes(name))) continue;
    const hits: string[] = [];
    for (const l of mine) {
      if (isRecordProse(l.file) || l.text.includes("retired-name-ok")) continue;
      if ([...l.text.matchAll(word)].some((m) => !insideStringLiteral(l.text, m.index))) {
        hits.push(`${l.file}:${l.no}`);
      }
    }
    if (hits.length === 0) continue;
    findings.push(
      `\`${name}\` was removed by this change but is still named at: ${cappedList(hits, MAX_STALE_HITS)}`,
    );
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
    // `git grep` exits 1 with no output when nothing matches — the common, clean case — and
    // gitTry maps that to null exactly as it maps a real failure, both of which mean "no hits".
    const out = await gitTry(wt, "grep", "-n", "-F", "-I", "--cached", "-e", old);
    if (!out) continue;
    const hits: string[] = [];
    for (const line of out.split("\n")) {
      const m = /^([^:]+):(\d+):(.*)$/.exec(line);
      if (!m || isRecordProse(m[1]!) || !hasStandalonePathOccurrence(m[3] ?? "", old)) continue;
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

/** Each distinct path-shaped token in `text`, in first-appearance order: at least one slash and
 * a final `.<ext>` segment. Scanned inside the text (not whitespace-split) so surrounding
 * backticks, brackets, and sentence punctuation fall away with the match. */
export function pathTokens(text: string): string[] {
  const tokenRe = /[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.[A-Za-z0-9]+/g;
  return [...new Set([...text.matchAll(tokenRe)].map((m) => m[0]))];
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
    for (const p of pathTokens(line.slice(1))) {
      const top = p.slice(0, p.indexOf("/"));
      if (!topDirs.has(top) || oldPaths.has(p) || staged.has(p) || seen.has(p)) continue;
      seen.add(p);
      missing.push(p);
    }
  }
  if (missing.length === 0) return [];
  return [
    `added lines name paths that do not exist in the tree: ${cappedList(missing, MAX_MISSING_PATHS)}`,
  ];
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
      path = diffPlusPath(line);
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
  return [`the change removes the final newline from: ${cappedList(files, MAX_NEWLINE_FILES)}`];
}

/** Patterns for the garbled English a rote "tick" → "run" word swap leaves, in order: a broken
 * past participle after an auxiliary, "ran" hyphenated onto another word (the class stays a
 * letter range so this line does not match itself), "run" followed by a form of "to be" and
 * "running", and "run" stacked directly on "run". */
const GARBLED_WORDING: readonly RegExp[] = [
  /\b(?:has|have|had|having)\s+(?:\w+ly\s+|never\s+|not\s+|already\s+|just\s+)?ran\b/i,
  /[A-Za-z]-ran\b/i,
  /\bruns?\s+(?:is|are|was|were|already|still)\s+(?:still\s+|already\s+)?running\b/i,
  /\b(?:run|runs|running)\s+(?:a|the|no)\s+run\b/i,
];

/** (e) Added lines, outside record prose, that match GARBLED_WORDING: at most one hit per line,
 * reported as `file:line "matched text"` in a single finding. */
function garbledWordingFindings(diff: string): string[] {
  const hits: string[] = [];
  let file: string | null = null;
  let lineNo = 0;
  for (const line of diff.split("\n")) {
    const header = /^diff --git a\/.* b\/(.*)$/.exec(line);
    if (header) {
      file = header[1]!;
      continue;
    }
    const hunk = /^@@ .*\+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      lineNo = Number(hunk[1]);
      continue;
    }
    if (!line.startsWith("+") || line.startsWith("+++ ")) continue;
    if (file !== null && !isRecordProse(file)) {
      for (const re of GARBLED_WORDING) {
        const m = re.exec(line.slice(1));
        if (m) {
          hits.push(`${file}:${lineNo} "${m[0]}"`);
          break;
        }
      }
    }
    lineNo++;
  }
  if (hits.length === 0) return [];
  const lead = 'added lines carry garbled rename wording (reword them; a rote "tick" → "run" swap reads wrong here): '; // vocabulary-ok: quotes the retired word
  return [lead + cappedList(hits, MAX_STALE_HITS)];
}
