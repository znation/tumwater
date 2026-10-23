import { andMore, readDoc, readDocChecked, FIX_CLAIMS_CHECKED, FIX_CLAIM_HEADING_MAX, REFUSAL_NOTE_MAX } from "./doctor-backlog.js";
import { VALIDATION_GAP_TAGS } from "../roles/role-guidance.js";
import fs from "node:fs";
import path from "node:path";
import { truncate } from "../text/text.js";
import { donePlans, plannedPlanEntries } from "../backlog/backlog.js";
import { entryHold, heldCount } from "../backlog/backlog-eligibility.js";
import { planDependencyProblems } from "../backlog/backlog-parts.js";
import { BACKLOG_FILES, validationGapTag } from "../backlog/backlog-md.js";
import { duplicateHeadings, strandedPlanEntriesFor } from "../backlog/backlog-structure.js";
import { liveFinishedHistory } from "../backlog/backlog-archive.js";
import { fixSymbols, fixedEntriesAt, missingSymbolNames, sourceHaystack, unbackedSymbols } from "../verdict/fix-claim.js";
import { plural } from "../text/phrases.js";
import { type CheckOutcome, okOutcome, warnOutcome } from "./outcome.js";

/** The doctor's PLANS.md-structure and fix-claim checks, split out of doctor-backlog.ts: the
 * checks that re-verify BUGS.md's newest Fixed records against the tree (checkFixClaims,
 * checkValidationGaps) and the PLANS.md / backlog-file integrity checks that read sections and
 * clauses rather than a single document's entries (checkStrandedPlans, checkLiveFinished,
 * checkBacklogHeadings, checkStalledPlans, checkPlanDependencies). They import the shared helpers
 * (readDoc and its checked wrapper readDocChecked, andMore) from doctor-backlog.ts and the
 * heading-trim bounds,
 * and all of them warn instead of failing: damaged documentation is operator signal, not a
 * broken environment. doctor.ts composes them beside the open-item and queue checks; the shared
 * CheckOutcome shape is imported from outcome.ts. */

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
  const doc = readDocChecked(path.join(root, "BUGS.md"), "BUGS.md", "no BUGS.md — nothing to verify");
  if (typeof doc !== "string") return doc;
  // One parse feeds every record's title and body: bugEntryBody re-parsed the whole document
  // per heading, and BUGS.md grows without bound, so the newest-10 scan paid 1 + 10 full-document
  // walks where one suffices.
  const records = fixedEntriesAt(root, doc).slice(0, FIX_CLAIMS_CHECKED);
  // The haystack walks src/, test/ and scripts/: build it only once a record names something.
  let haystack: string | undefined;
  const phantoms: Array<{ heading: string; missing: string[] }> = [];
  for (const { title: heading, body } of records) {
    const symbols = fixSymbols(body);
    if (symbols.length === 0) continue;
    haystack ??= sourceHaystack(root);
    const missing = unbackedSymbols(root, symbols, haystack);
    if (missing.length === symbols.length) phantoms.push({ heading, missing });
  }
  const [first, ...rest] = phantoms;
  if (!first)
    return okOutcome(`newest ${records.length} Fixed record(s) name code that exists on this tree`);
  // falseFixReason's message shape: the heading, then up to 3 missing names.
  const { heading, missing } = first;
  const names = missingSymbolNames(missing);
  // Every other suspect is still named, shortened: a doctor check is one line.
  const more = andMore(rest, (p) => `"${truncate(p.heading, FIX_CLAIM_HEADING_MAX)}"`, "record(s)");
  return warnOutcome(`BUGS.md records "${heading}" as Fixed, but none of the symbols its Fix paragraph names ` +
      `exist on this tree: ${names}${more} — land the fix or keep the bug Open / refresh a stale record`);
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
  const doc = readDocChecked(path.join(root, "BUGS.md"), "BUGS.md", "no BUGS.md — nothing to verify");
  if (typeof doc !== "string") return doc;
  const records = fixedEntriesAt(root, doc).slice(0, FIX_CLAIMS_CHECKED);
  const suspects: Array<{ title: string; problem: string; tag?: string }> = [];
  const unpinned: Array<{ title: string }> = [];
  for (const { title, body } of records) {
    const tag = validationGapTag(body);
    if (tag === null) suspects.push({ title, problem: "missing" });
    else if (!VALIDATION_GAP_TAGS.includes(tag)) suspects.push({ title, problem: "unrecognized", tag });
    else if (tag === "unclear-invariant" && !body.toLowerCase().includes("docs/invariants.md"))
      unpinned.push({ title });
  }
  const [first, ...rest] = suspects;
  if (!first) {
    if (unpinned.length > 0) {
      const up = unpinned[0]!;
      const more = andMore(unpinned.slice(1), (s) => `"${truncate(s.title, FIX_CLAIM_HEADING_MAX)}"`, "record(s)");
      return warnOutcome(`BUGS.md record "${up.title}" is an \`unclear-invariant\` fix but names no ` +
        `docs/invariants.md section — record the reconstructed guarantee there (a "Pinned by" line) in the ` +
        `same commit so the next bug in that area does not reconstruct it again${more}`);
    }
    return okOutcome(`newest ${records.length} Fixed record(s) carry a known Validation gap tag`);
  }
  const more = andMore(rest, (s) => `"${truncate(s.title, FIX_CLAIM_HEADING_MAX)}"`, "record(s)");
  const what = first.problem === "missing"
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
  const doc = readDocChecked(path.join(root, "PLANS.md"), "PLANS.md", "no PLANS.md — nothing to verify");
  if (typeof doc !== "string") return doc;
  // PLANS-DONE.md too: finished plans are archived there (plans/backlog-archive.md), and a plan
  // filed under its ## Done is as invisible as one under PLANS.md's. Each entry names its file.
  const stranded = strandedPlanEntriesFor(root);
  const clean = "no plan headings filed under the wrong PLANS.md section";
  if (stranded.length === 0) return okOutcome(clean);
  const [first, ...rest] = stranded;
  if (!first) return okOutcome(clean);
  const more = andMore(rest, (e) => `"${truncate(e.title, FIX_CLAIM_HEADING_MAX)}"`);
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
  const parts = live.map((l) => `${l.file} ## ${l.section} holds ${plural(l.entries, "finished entry", "finished entries")} (${Math.round(l.bytes / 1024)} KB)`);
  return warnOutcome(`${parts.join("; ")} — every run that reads the file pays for them; ` +
    "`tumwater archive` moves them to the archive files and commits them (a starting team does too)");
}

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
  const duplicates: string[] = [];
  for (const file of BACKLOG_FILES) {
    const p = path.join(root, file);
    if (!fs.existsSync(p)) continue; // Absent file (early repo): contributes nothing.
    const read = readDoc(p);
    if ("error" in read) {
      duplicates.push(`${file} (unreadable)`);
      continue;
    }
    const { doc } = read;
    for (const title of duplicateHeadings(doc)) duplicates.push(`${file} "## ${title}"`);
  }
  if (duplicates.length === 0)
    return okOutcome("no duplicated ## section headings in the backlog files");
  const [first, ...rest] = duplicates;
  const more = andMore(rest, (d) => d);
  return warnOutcome(`${first}${more} appears more than once — readers take the first section of a name, so ` +
      `later entries are invisible; keep one heading per name (the gate blocks only a merge ` +
      `that adds another copy — remove the duplicate in a deliberate edit)`);
}

/** Stalled plans — planned plans held by a **Needs review …** or **Needs replan …** note,
 * parked until the plan role splits or replans them. No role takes a held entry (the claim
 * gate refuses one) and nothing clears the note on its own, so the state is visible only as
 * the `[needs review]`/`[needs replan]` marks in the backlog listings; this names them so an
 * operator gets a single-line health signal from `tumwater doctor`. Reads the tree at `root`
 * — the primary checkout IS main's tree — like checkRefusedEntries, which is also where
 * refusal notes (a different hold) are surfaced. entryHold (src/backlog/backlog-eligibility.ts)
 * already classifies the notes, so this check adds no parsing: only the planned entries whose
 * hold is exactly needs-review, needs-replan, or held-for-operator are collected. A warn, never
 * a fail — the checkRefusedEntries precedent: a parked plan is operator signal, not a broken
 * environment; the plan role resolves the first two itself, and a held-for-operator plan is
 * the operator's to release (`tumwater plan --release`). */
export function checkStalledPlans(root: string): CheckOutcome {
  const planned = plannedPlanEntries(root);
  const stalled = planned.filter((entry) => {
    const hold = entryHold(entry, planned);
    return hold === "needs-review" || hold === "needs-replan" || hold === "held-for-operator"; // vocabulary-ok: the held-for-operator hold's key
  });
  const [first, ...rest] = stalled;
  if (!first) return okOutcome("no planned plan is held by a Needs-review, Needs-replan, or held-for-operator note"); // vocabulary-ok: names the held-for-operator hold
  const more = andMore(rest, (e) => `"${truncate(e.title, FIX_CLAIM_HEADING_MAX)}"`);
  const hold = entryHold(first, planned);
  const note = (first.body.split(/\n/).find(
    (line) => line.trimStart().startsWith("**Needs review ") || line.trimStart().startsWith("**Needs replan "),
  ) ?? "").replace(/^\s*\*\*/, "").replace("**", "");
  if (hold === "held-for-operator") { // vocabulary-ok: the held-for-operator hold's key
    return warnOutcome(`PLANS.md plan "${truncate(first.title, FIX_CLAIM_HEADING_MAX)}" is held for the operator ${heldCount(first.body)} times${more} — release it with tumwater plan --release`); // vocabulary-ok: a held-for-operator plan is the operator's to release
  }
  return warnOutcome(`PLANS.md plan "${truncate(first.title, FIX_CLAIM_HEADING_MAX)}" is held by a ${hold === "needs-review" ? "Needs review" : "Needs replan"} note ` +
      `(${truncate(note, REFUSAL_NOTE_MAX)})${more} — the plan role resolves it by splitting or replanning`);
}

/** Plan dependencies — mistakes in the planned plans' `requires … landed` clauses that the claim
 * allocator (entryHoldAgainst) cannot see: a ref naming no heading (the hold is void, so the
 * dependent is claimable now), a clause that parses to no refs (it holds nothing), and a
 * dependency cycle (every part on it stays blocked forever). Reads the tree at `root` through
 * planDependencyProblems. A warn, never a fail, like checkStalledPlans: the plan role writes the
 * clauses by hand and fixes them itself. The most serious kind is named — cycle, then dangling,
 * then unparsed — with a count of the other kinds. */
export function checkPlanDependencies(root: string): CheckOutcome {
  const { cycle, dangling, unparsed, misworded } = planDependencyProblems(plannedPlanEntries(root), donePlans(root));
  const [firstDangling, ...restDangling] = dangling;
  const [firstUnparsed, ...restUnparsed] = unparsed;
  const [firstMisworded, ...restMisworded] = misworded;
  const quote = (t: string) => `"${truncate(t, FIX_CLAIM_HEADING_MAX)}"`;
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
    return warnOutcome(`plan dependency cycle: ${cycle.join(" → ")} — every part on it stays blocked forever; ` +
      "edit one heading's `requires … landed` clause to break it" + // vocabulary-ok: PLANS.md heading syntax
      others([[dangling.length, "dangling ref(s)"], [unparsed.length, "unparsed clause(s)"], [misworded.length, "misworded dependency(ies)"]]));
  }
  if (firstDangling) {
    return warnOutcome(danglingMsg(firstDangling) +
      andMore(restDangling, (d) => `${quote(d.title)} → ${d.ref}`, "ref(s)") +
      others([[unparsed.length, "unparsed clause(s)"], [misworded.length, "misworded dependency(ies)"]]));
  }
  if (firstUnparsed) {
    return warnOutcome(unparsedMsg(firstUnparsed) + andMore(restUnparsed, quote, "clause(s)") +
      others([[misworded.length, "misworded dependency(ies)"]]));
  }
  if (firstMisworded) {
    return warnOutcome(miswordedMsg(firstMisworded) +
      andMore(restMisworded, (w) => `${quote(w.title)} → ${w.ref}`, "dependency(ies)"));
  }
  return okOutcome("every planned plan's requires clause names a known part, with no cycle or misworded dependency");
}
