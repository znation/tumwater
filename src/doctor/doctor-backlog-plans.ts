import { andMore, quoteHeading, readDoc, readBacklogChecked, FIX_CLAIMS_CHECKED, REFUSAL_NOTE_MAX } from "./doctor-backlog.js";
import { agree } from "../text/phrases.js";
import { cachedByStat, type StatKeyedValue } from "../files/stat-cache.js";
import { VALIDATION_GAP_TAGS } from "../roles/role-guidance.js";
import path from "node:path";
import { truncate } from "../text/text.js";
import { donePlans, fixedBugEntries, openBugEntries, plannedPlanEntries, type BacklogEntry } from "../backlog/backlog.js";
import { entryHold, entryKindLabel, isPlanStalled } from "../backlog/backlog-eligibility.js";
import { planDependencyProblems } from "../backlog/backlog-parts.js";
import { BACKLOG_FILES, validationGapTag } from "../backlog/backlog-md.js";
import { duplicateHeadings, strandedPlanEntriesFor } from "../backlog/backlog-structure.js";
import { liveFinishedHistory, liveFinishedRowList } from "../backlog/backlog-archive.js";

import { fixSymbols, isCommitRef, missingSymbolNames, cachedSourceHaystack, unbackedSymbols } from "../verdict/fix-claim.js";
import { type CheckOutcome, okOutcome, warnOutcome } from "./doctor-outcome.js";

/** The doctor's PLANS.md-structure and fix-claim checks, split out of doctor-backlog.ts: the
 * checks that re-verify BUGS.md's newest Fixed records against the tree (checkFixClaims,
 * checkValidationGaps) and the PLANS.md / backlog-file integrity checks that read sections and
 * clauses rather than a single document's entries (checkStrandedPlans, checkLiveFinished,
 * checkBacklogHeadings, checkStalledEntries, checkPlanDependencies). They import the shared helpers
 * (readDoc and its checked wrapper readBacklogChecked, andMore) from doctor-backlog.ts and the
 * heading-trim bounds,
 * and all of them warn instead of failing: damaged documentation is operator signal, not a
 * broken environment. doctor.ts composes them beside the open-item and queue checks; the shared
 * CheckOutcome shape is imported from doctor-outcome.ts. */

/** Fix claims — the standalone half of the merge gate's false-fix check (src/verdict/fix-claim.ts):
 * that gate fires only when an md-only diff moves a BUGS.md entry to Fixed, so a phantom fix that
 * reached main any other way (merged before the gate existed, or through a path it never sees) was
 * visible only to a human reading raw history. This re-verifies the newest Fixed records against
 * the tree at `root` — the primary checkout IS main's tree — with the gate's own parsing and
 * existence rules. Deliberately looser than the gate: a record warns only when EVERY symbol its Fix
 * paragraph names is absent (one live symbol passes — the phantom signature, not a half-stale
 * narrative), and a record naming no symbols is skipped, since pure-documentation fixes are
 * legitimate. A warn, never a fail (the checkFallbackModel precedent): a suspicious record is
 * operator signal, not a broken environment. */
export function checkFixClaims(root: string): CheckOutcome {
  const doc = readBacklogChecked(root, "BUGS.md");
  if (typeof doc !== "string") return doc;
  const problems = fixClaimProblems(root);
  const [first, ...rest] = problems;
  if (!first)
    return okOutcome(`newest ${fixClaimRecords(root).length} Fixed record(s) name code that exists on this tree`);
  // falseFixReason's message shape: the heading, then up to 3 missing names.
  const { heading, missing } = first;
  const names = missingSymbolNames(missing);
  // Every other suspect is still named, shortened: a doctor check is one line.
  const more = andMore(rest, (p) => quoteHeading(p.heading), agree(rest.length, "record", "records"));
  return warnOutcome(`BUGS.md records "${heading}" as Fixed, but none of the symbols its Fix paragraph names ` +
      `exist on this tree: ${names}${more} — land the fix or keep the bug Open / refresh a stale record`);
}

/** One problem found by the shared fix-claim scan (fixClaimProblems, below): a newest Fixed
 * record whose Fix paragraph names (`missing`) only symbols absent from the tree — the phantom
 * signature the review chain has burned on. `heading` is the record's title. The scan keeps
 * record order, so the first problem is the one the doctor's message names. */
interface FixClaimProblem {
  heading: string;
  missing: string[];
}

/** The fix-claim rows the doctor's check warns about: each newest Fixed
 * record classified through fixSymbols and unbackedSymbols — the gate's own parsing and
 * existence rules — against ONE cachedSourceHaystack built for the whole scan, keeping a record
 * only when EVERY symbol its Fix paragraph names is absent, and skipping a record that names no
 * symbols (pure-documentation fixes are legitimate). A commit id is a citation, not a symbol:
 * this synchronous scan cannot ask git whether it exists (the gate does), so a record that cites
 * only the commit it reviewed names nothing checkable. */
function classifyFixClaims(records: readonly BacklogEntry[], root: string): FixClaimProblem[] {
  const problems: FixClaimProblem[] = [];
  let haystack: string | undefined;
  for (const { title, body } of records) {
    const symbols = fixSymbols(body).filter((symbol) => !isCommitRef(symbol));
    if (symbols.length === 0) continue;
    haystack ??= cachedSourceHaystack(root);
    const missing = unbackedSymbols(root, symbols, haystack);
    if (missing.length === symbols.length) problems.push({ heading: title, missing });
  }
  return problems;
}

/** The ONE shared fix-claim scan: the newest Fixed records (bounded to FIX_CLAIMS_CHECKED so
 * pre-convention history never warns forever) as fixedBugEntries reads them — the stat-cached
 * section reader BUGS.md + BUGS-FIXED.md, bodies kept whole — classified through
 * classifyFixClaims. */
function fixClaimRecords(root: string): BacklogEntry[] {
  return fixedBugEntries(root).slice(0, FIX_CLAIMS_CHECKED);
}

/** The problems the ONE fix-claim scan found among the newest Fixed records at `root`
 * (empty when BUGS.md is unreadable or every newest Fixed record names at least one live
 * symbol). */
export function fixClaimProblems(root: string): FixClaimProblem[] {
  return classifyFixClaims(fixClaimRecords(root), root);
}

/** One problem found by the shared validation-gap scan (validationGapRecords, below): a newest
 * Fixed record whose `**Validation gap:**` line is missing (`missing`), names a tag outside the
 * closed vocabulary (`unrecognized`, with `tag` set), or declares `unclear-invariant` while
 * naming no docs/invariants.md section (`unpinned`). `title` is the record's heading. The scan
 * orders suspects first, then `unpinned`, so the first problem is the one the doctor's message
 * names. */
interface ValidationGapProblem {
  title: string;
  kind: "missing" | "unrecognized" | "unpinned";
  tag?: string;
}

/** The validation-gap rows the doctor's check warns about: each newest
 * Fixed record classified against the closed `**Validation gap:**` vocabulary through
 * validationGapTag, which is fence-aware — suspects (missing/unrecognized) first, then
 * `unpinned`, so the first row is the one the doctor's message names. */
function classifyValidationGaps(records: readonly BacklogEntry[]): ValidationGapProblem[] {
  const suspects: ValidationGapProblem[] = [];
  const unpinned: ValidationGapProblem[] = [];
  for (const { title, body } of records) {
    const tag = validationGapTag(body);
    if (tag === null) suspects.push({ title, kind: "missing" });
    else if (!VALIDATION_GAP_TAGS.includes(tag)) suspects.push({ title, kind: "unrecognized", tag });
    else if (tag === "unclear-invariant" && !body.toLowerCase().includes("docs/invariants.md"))
      unpinned.push({ title, kind: "unpinned" });
  }
  return [...suspects, ...unpinned];
}

/** The ONE scan the doctor's `validation gaps` check hands its rows from: the newest Fixed
 * records (bounded to FIX_CLAIMS_CHECKED so pre-convention history never warns forever) as
 * fixedBugEntries reads them — the stat-cached section reader BUGS.md + BUGS-FIXED.md, bodies
 * kept whole — classified through classifyValidationGaps. */
function validationGapRecords(root: string): BacklogEntry[] {
  return fixedBugEntries(root).slice(0, FIX_CLAIMS_CHECKED);
}

/** The fixed-record validation-gap twin of checkFixClaims, standing in for plans/repair-traces.md's
 * invariant 2 ("the vocabulary is closed and lives in one place"): the bugfix guidance tells every
 * run to write exactly one `**Validation gap:**` line with a known tag, and `none` rather than no
 * line at all so a tally's denominator stays honest. Nothing checks that a Fixed entry actually
 * carries such a line or that its tag is one of the closed vocabulary — a typo like `no-reprod`
 * lands as its own key on `tumwater report`'s `Validation gaps` line and matches no
 * closed-vocabulary consumer that enumerates the six non-`none` tags, and an entry with no line at
 * all is invisible to every one of them. Re-reads the newest Fixed records with the same
 * FIX_CLAIMS_CHECKED bound (pre-convention history would otherwise warn forever) and warns on a
 * missing or unrecognized tag. An entry declaring `unclear-invariant` should also have pinned the
 * reconstructed guarantee in docs/invariants.md in the same commit — a fix that names no such
 * section warns with that nudge (informational: code-pinned or prose-that-skips-the-filename fixes
 * may spuriously warn). A warn, never a fail, like its sibling: a suspect record is
 * operator signal, not a broken environment. */
export function checkValidationGaps(root: string): CheckOutcome {
  // The doctor's check reads BUGS.md itself so it can return its no-file outcome (a missing
  // BUGS.md — nothing to verify); the classification then runs on the SAME fixedBugEntries
  // reader, so the problem set cannot drift. There is only one scan (validationGapRecords).
  const doc = readBacklogChecked(root, "BUGS.md");
  if (typeof doc !== "string") return doc;
  const problems = classifyValidationGaps(validationGapRecords(root));
  const suspects = problems.filter((p) => p.kind !== "unpinned");
  const unpinned = problems.filter((p) => p.kind === "unpinned");
  const [first, ...rest] = suspects;
  if (!first) {
    if (unpinned.length > 0) {
      const up = unpinned[0]!;
      const more = andMore(unpinned.slice(1), (s) => quoteHeading(s.title), agree(unpinned.slice(1).length, "record", "records"));
      return warnOutcome(`BUGS.md record "${up.title}" is an \`unclear-invariant\` fix but names no ` +
        `docs/invariants.md section — record the reconstructed guarantee there (a "Pinned by" line) in the ` +
        `same commit so the next bug in that area does not reconstruct it again${more}`);
    }
    return okOutcome(`newest ${validationGapRecords(root).length} Fixed record(s) carry a known Validation gap tag`);
  }
  const more = andMore(rest, (s) => quoteHeading(s.title), agree(rest.length, "record", "records"));
  const what = first.kind === "missing"
    ? `BUGS.md record "${first.title}" has no **Validation gap:** line`
    : `BUGS.md record "${first.title}" names unrecognized Validation gap tag "${first.tag}"`;
  const valid = VALIDATION_GAP_TAGS.join(", ");
  return warnOutcome(`${what}${more} — every Fixed entry writes exactly one of: ${valid}; ` +
      `write \`none\` rather than omitting the line (the bugfix role records it; see plans/repair-traces.md)`);
}

/** Stranded plans — plan headings filed under the wrong PLANS.md section (the stranded-plan
 * detector, src/backlog/backlog-structure.ts): a `(planned …)` heading sitting under `## Done` is
 * invisible to every Planned reader, and a done-dated heading still under `## Planned` invites
 * a second implementation. The clean role repairs these when it happens to run; this makes
 * the state visible to an operator without waiting for that run. Reads the tree at `root` —
 * the primary checkout IS main's tree — like checkFixClaims. A warn, never a fail: a misplaced
 * heading is operator signal, not a broken environment. */
export function checkStrandedPlans(root: string): CheckOutcome {
  const doc = readBacklogChecked(root, "PLANS.md");
  if (typeof doc !== "string") return doc;
  // PLANS-DONE.md too: finished plans are archived there (plans/backlog-archive.md), and a plan
  // filed under its ## Done is as invisible as one under PLANS.md's. Each entry names its file.
  const stranded = strandedPlanEntriesFor(root);
  const clean = "no plan headings filed under the wrong PLANS.md section";
  if (stranded.length === 0) return okOutcome(clean);
  const [first, ...rest] = stranded;
  if (!first) return okOutcome(clean);
  const more = andMore(rest, (e) => quoteHeading(e.title));
  const file = first.file ?? "PLANS.md";
  return warnOutcome(`${file} has a plan stranded under ## ${first.section}: "${first.title}"${more} — ` +
      `move it under ## ${first.section === "Done" ? "Planned" : "Done"}${file === "PLANS.md" ? "" : " in PLANS.md"} ` +
      "(the clean role repairs these)");
}

/** Finished history still in the live backlog files (plans/backlog-archive.md): entries under
 * PLANS.md's `## Done` or BUGS.md's `## Fixed` that have not moved to PLANS-DONE.md or
 * BUGS-FIXED.md. Every run that reads the live file pays for them. A starting team archives them
 * unless that is refused (a dirty file, a checkout off the base branch), and a hand commit can put
 * new ones there between starts, so this names how many there are and the fix. A warn, never a
 * fail: the team works either way, only more expensively. */
export function checkLiveFinished(root: string): CheckOutcome {
  const live = liveFinishedHistory(root);
  if (live.length === 0) return okOutcome("PLANS.md and BUGS.md hold no finished entries — they are archived");
  return warnOutcome(`${liveFinishedRowList(live)} — every run that reads the file pays for them; ` +
    "`tumwater archive` moves them to the archive files and commits them (a starting team does too)");
}

/** The one loop over BACKLOG_FILES the doctor's `backlog headings` check scans for duplicated
 * `## ` titles. The per-file read is stat-cached (backlogHeadingFileCache) so repeated checks
 * pay one stat per unchanged file rather than re-reading the whole BACKLOG_FILES member — the
 * archives grow without bound (PLANS-DONE.md and BUGS-FIXED.md run to MBs) — and cachedByStat
 * serves an unchanged file from cache (dev/ino/mtime/size) and re-reads on a change. Absent
 * files (an early repo) contribute nothing, an existing file that cannot be read adds
 * `${file} (unreadable)` to `rows` (its duplicate headings, if any, are invisible to every
 * reader), and each duplicate `## ` title appears as `${file} "## ${title}"` in
 * `rows` — which therefore keeps BACKLOG_FILES order, the order the doctor's `backlog
 * headings` row lists its messages in. */
function scanBacklogHeadings(root: string): string[] {
  const rows: string[] = [];
  for (const file of BACKLOG_FILES) {
    const p = path.join(root, file);
    const scan = cachedByStat(
      backlogHeadingFileCache,
      p,
      p,
      () => {
        const read = readDoc(p);
        if ("error" in read) return { status: "unreadable", headings: [] };
        return { status: "ok", headings: duplicateHeadings(read.doc) };
      },
      (v) => ({ status: v.status, headings: [...v.headings] }),
    );
    if (scan === null) continue; // Absent file (early repo): contributes nothing.
    if (scan.status === "unreadable") {
      rows.push(`${file} (unreadable)`);
      continue;
    }
    for (const heading of scan.headings) {
      rows.push(`${file} "## ${heading}"`);
    }
  }
  return rows;
}

/** One stat-cached entry of scanBacklogHeadings per backlog file: whether the file was
 * read as unreadable, or its (otherwise empty) list of duplicated `## ` titles. Keyed by path
 * in backlogHeadingFileCache; a missing file never gets an entry (cachedByStat deletes it). */
interface BacklogHeadingFileScan {
  status: "unreadable" | "ok";
  headings: string[];
}
/** The module-level stat cache backing scanBacklogHeadings, so a repeated check never re-reads
 * an unchanged backlog or archive file. */
const backlogHeadingFileCache = new Map<string, StatKeyedValue<BacklogHeadingFileScan>>();

/** Duplicated `## ` headings already on main (the duplicate-heading half of the backlog-structure
 * check, src/backlog/backlog-structure.ts): a `## Done` a past merge or conflict resolution added
 * twice leaves every later entry after the first section invisible to the section readers, and
 * nothing repairs it on its own. Reads the tree at `root` — the primary checkout IS main's tree —
 * like checkFixClaims. A warn, never a fail: existing damage is operator signal, not a broken
 * environment, and a merge that adds another copy of the heading trips the gate's same rule (a) —
 * src/backlog/backlog-structure.ts fires only when a count EXCEEDS the merge-base's, so an edit
 * that leaves an existing duplicate alone passes and the duplicate itself needs a deliberate
 * removal edit. */
export function checkBacklogHeadings(root: string): CheckOutcome {
  const rows = scanBacklogHeadings(root);
  if (rows.length === 0)
    return okOutcome("no duplicated ## section headings in the backlog files");
  const [first, ...rest] = rows;
  const more = andMore(rest, (d) => d);
  return warnOutcome(`${first}${more} appears more than once — readers take the first section of a name, so ` +
      `later entries are invisible; keep one heading per name (the gate blocks only a merge ` +
      `that adds another copy — remove the duplicate in a deliberate edit)`);
}

/** Stalled entries — plans or bugs parked with the plan role by a **Needs review …** note
 * that the plan role clears by splitting or replanning (the feature role's too-large note, the
 * convergence hold, a final-round rejection). The bugfix role's wait-for-the-next-failure
 * parks ("by bugfix:") are excluded — selfcheck lifts them, not the plan role, so they are
 * not the plan role's stalled work. No role takes a held entry (the claim gate refuses one)
 * and nothing clears a plan-role note on its own, so the state is visible only as the
 * `[needs review]` marks in the backlog listings; this names them so an
 * operator gets a single-line health signal from `tumwater doctor`. Reads the tree at `root`
 * — the primary checkout IS main's tree — like checkRefusedEntries, which is also where
 * refusal notes (a different hold) are surfaced. entryHold + isPlanStalled
 * (src/backlog/backlog-eligibility.ts) already classify the notes, so this check adds no
 * parsing: only the entries whose hold is exactly needs-review and which isPlanStalled
 * accepts are collected, from both PLANS.md
 * and BUGS.md. A warn, never a fail — the checkRefusedEntries precedent: a parked entry is
 * operator signal, not a broken environment; the plan role resolves it by splitting or
 * replanning. */
export function checkStalledEntries(root: string): CheckOutcome {
  const planned = plannedPlanEntries(root);
  const collect = (entry: BacklogEntry, file: "plans" | "bugs"): { file: "plans" | "bugs"; entry: BacklogEntry } | null => {
    const hold = entryHold(entry, planned);
    return hold === "needs-review" && isPlanStalled(entry)
      ? { file, entry }
      : null;
  };
  const stalled = [
    ...planned.map((e) => collect(e, "plans")),
    ...openBugEntries(root).map((e) => collect(e, "bugs")),
  ].filter((x): x is { file: "plans" | "bugs"; entry: BacklogEntry } => x !== null);
  const [first, ...rest] = stalled;
  if (!first) return okOutcome("no planned plan or open bug is held by a Needs-review note");
  const more = andMore(rest, (s) => quoteHeading(s.entry.title));
  const kind = entryKindLabel(first.file); // "Bug" | "Plan"
  const head = `${first.file === "bugs" ? "BUGS.md" : "PLANS.md"} ${kind.toLowerCase()}`;
  const note = (first.entry.body.split(/\n/).find(
    (line) => line.trimStart().startsWith("**Needs review "),
  ) ?? "").replace(/^\s*\*\*/, "").replace("**", "");
  return warnOutcome(`${head} ${quoteHeading(first.entry.title)} is held by a Needs review note ` +
      `(${truncate(note, REFUSAL_NOTE_MAX)})${more} — the plan role resolves it by splitting or replanning`);
}

/** A broken plan-dependency clause in PLANS.md's planned entries, named once with the doctor's
 * exact message: `kind` is the most serious rule violated (cycle, then dangling, then unparsed,
 * then misworded) and `message` is byte-identical to what the doctor's `plan dependencies` row
 * shows. */
interface PlanDependencyProblem {
  kind: "cycle" | "dangling" | "unparsed" | "misworded";
  message: string;
}

/** Plan dependencies — mistakes in the planned plans' `requires … landed` clauses that the claim
 * allocator (entryHoldAgainst) cannot see: a ref naming no heading (the hold is void, so the
 * dependent is claimable now), a clause that parses to no refs (it holds nothing), and a
 * dependency cycle (every part on it stays blocked forever). Reads the tree at `root` through
 * planDependencyProblems. A warn, never a fail, like checkStalledEntries: the plan role writes the
 * clauses by hand and fixes them itself. The most serious kind is named — cycle, then dangling,
 * then unparsed — with a count of the other kinds. */
export function planDependencyProblem(root: string): PlanDependencyProblem | null {
  const { cycle, dangling, unparsed, misworded } = planDependencyProblems(plannedPlanEntries(root), donePlans(root));
  const [firstDangling, ...restDangling] = dangling;
  const [firstUnparsed, ...restUnparsed] = unparsed;
  const [firstMisworded, ...restMisworded] = misworded;
  const quote = quoteHeading;
  const others = (parts: Array<[number, string]>): string =>
    parts.some(([n]) => n > 0) ? ` (also ${parts.map(([n, noun]) => `${n} ${noun}`).join(", ")})` : "";
  const danglingMsg = (d: { title: string; ref: string }) =>
    `PLANS.md plan ${quote(d.title)} requires ${d.ref}, which no PLANS.md heading carries — the hold is void, ` +
    "so the plan is claimable now; fix the series name or part number";
  const unparsedMsg = (t: string) =>
    `PLANS.md plan ${quote(t)} has a \`requires … landed\` clause that names no part the allocator can read — ` + // vocabulary-ok: PLANS.md heading syntax
    "it holds nothing; write each ref as `<Series> i/n` or give the heading a `<Series>, part i/n:` prefix";
  const miswordedMsg = (w: { title: string; ref: string }) =>
    `PLANS.md plan ${quote(w.title)} names ${w.ref} as a prerequisite without a \`requires … landed\` clause — ` + // vocabulary-ok: PLANS.md heading syntax
    "the claim allocator ignores that wording and hands the part out now; write it as `requires part i/n landed`"; // vocabulary-ok: PLANS.md heading syntax
  if (cycle !== null) {
    return { kind: "cycle", message: `plan dependency cycle: ${cycle.join(" → ")} — every part on it stays blocked forever; ` +
      "edit one heading's `requires … landed` clause to break it" + // vocabulary-ok: PLANS.md heading syntax
      others([[dangling.length, "dangling ref(s)"], [unparsed.length, "unparsed clause(s)"], [misworded.length, "misworded dependency(ies)"]]) };
  }
  if (firstDangling) {
    return { kind: "dangling", message: danglingMsg(firstDangling) +
      andMore(restDangling, (d) => `${quote(d.title)} → ${d.ref}`, agree(restDangling.length, "ref", "refs")) +
      others([[unparsed.length, "unparsed clause(s)"], [misworded.length, "misworded dependency(ies)"]]) };
  }
  if (firstUnparsed) {
    return { kind: "unparsed", message: unparsedMsg(firstUnparsed) + andMore(restUnparsed, quote, agree(restUnparsed.length, "clause", "clauses")) +
      others([[misworded.length, "misworded dependency(ies)"]]) };
  }
  if (firstMisworded) {
    return { kind: "misworded", message: miswordedMsg(firstMisworded) +
      andMore(restMisworded, (w) => `${quote(w.title)} → ${w.ref}`, agree(restMisworded.length, "dependency", "dependencies")) };
  }
  return null;
}

/** The doctor's `plan dependencies` row: warn on the first problem planDependencyProblem finds
 * (sharing its problem set, severity order, and wording), ok when all four rules pass. A warn,
 * never a fail: a broken clause is operator signal, not a broken environment. */
export function checkPlanDependencies(root: string): CheckOutcome {
  const p = planDependencyProblem(root);
  return p ? warnOutcome(p.message) : okOutcome("every planned plan's requires clause names a known part, with no cycle or misworded dependency");
}
