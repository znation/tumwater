import fs from "node:fs";
import path from "node:path";
import { errorMessage, truncate } from "../text/text.js";
import { openBugEntries, plannedPlanEntries } from "../backlog/backlog.js";
import { plannedPartKeys, prerequisitesLanded, refusalNote } from "../backlog/backlog-eligibility.js";
import { BACKLOG_FILES } from "../backlog/backlog-md.js";
import { duplicateHeadings, strandedPlanEntries } from "../backlog/backlog-structure.js";
import { fixSymbols, fixedEntries, missingSymbolNames, sourceHaystack, unbackedSymbols } from "../verdict/fix-claim.js";
import { type CheckOutcome, okOutcome, warnOutcome } from "./outcome.js";

/** The doctor's backlog-document checks, split out of doctor-checks.ts: the four checks that
 * read the project's tracked Markdown backlog (BUGS.md, PLANS.md, QUESTIONS.md) rather than the
 * environment doctor-checks.ts inspects — fix claims, stranded plans, duplicated `## `
 * headings, and refused entries. They share this module's helpers (readDoc and its checked wrapper readDocChecked,
 * andMore) and the heading-trim constant, and all four warn instead of failing: damaged
 * documentation is operator signal, not a broken environment. doctor.ts composes them beside
 * the environment checks; the shared CheckOutcome shape is imported from outcome.ts. */

/** How many Fixed records the fix-claims check verifies: the newest, since the section is
 * newest-first by template convention. Older records drift as the code evolves — a symbol
 * legitimately fixed long ago gets renamed later — so a whole-section scan would warn forever
 * on records nobody should rewrite. */
const FIX_CLAIMS_CHECKED = 10;

/** A second or later suspect record's heading is trimmed to this many characters in the warn —
 * the first is named in full, the rest only enough to find them in BUGS.md. */
const FIX_CLAIM_HEADING_MAX = 60;

/** A refused entry's note is trimmed to this many characters in the refusals warn. */
const REFUSAL_NOTE_MAX = 120;

/** The `(and N more …)` suffix three one-line doctor details append after naming their first
 * suspect (fix claims, stranded plans, duplicated headings): the rest stay visible but
 * shortened, since a doctor check renders one line. `render` makes each extra item's short
 * form — the fix-claim and stranded-plan sites quote a heading trimmed to
 * FIX_CLAIM_HEADING_MAX, the duplicate-headings site passes its items through as built;
 * `noun` names what the extras are ("record(s)" for fix claims, empty for the other two).
 * Empty string when there are no extras. */
function andMore<T>(rest: readonly T[], render: (item: T) => string, noun = ""): string {
  return rest.length > 0
    ? ` (and ${rest.length} more${noun ? ` ${noun}` : ""}: ${rest.map(render).join(", ")})`
    : "";
}

/** Read one backlog file for a check, or the failure message explaining why it could not be
 * read (text.ts's errorMessage). Callers shape the failure themselves — a returned warn for a
 * single-file check, an "(unreadable)" list entry for the multi-file heading sweep. */
function readDoc(p: string): { doc: string } | { error: string } {
  try {
    return { doc: fs.readFileSync(p, "utf8") };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

/** The single-file check's read prologue, shared by checkFixClaims and checkStrandedPlans:
 * an absent file is that check's own "nothing to verify" ok outcome, an unreadable one a warn
 * naming the file. Returns the document, or the outcome the caller should return as-is. */
function readDocChecked(p: string, file: string, missingDetail: string): { doc: string } | { outcome: CheckOutcome } {
  if (!fs.existsSync(p)) return { outcome: okOutcome(missingDetail) };
  const read = readDoc(p);
  if ("error" in read) return { outcome: warnOutcome(`cannot read ${file} — ${read.error}`) };
  return read;
}

/** Fix claims — the standalone half of the landing gate's false-fix check
 * (src/verdict/fix-claim.ts): that gate fires only when an md-only diff moves a BUGS.md entry
 * to Fixed, so a phantom fix
 * that reached main any other way (landed before the gate existed, or through a path it never
 * sees) was visible only to a human reading raw history. This re-verifies the newest Fixed
 * records against the tree at `root` — the primary checkout IS main's tree — with the gate's
 * own parsing and existence rules. Deliberately looser than the gate: a record warns only
 * when EVERY symbol its Fix paragraph names is absent (one live symbol passes — the phantom
 * signature, not a half-stale narrative), and a record naming no symbols is skipped, since
 * pure-documentation fixes are legitimate. A warn, never a fail (the checkFallbackModel
 * precedent): a suspicious record is operator signal, not a broken environment. */
export function checkFixClaims(root: string): CheckOutcome {
  const read = readDocChecked(path.join(root, "BUGS.md"), "BUGS.md", "no BUGS.md — nothing to verify");
  if ("outcome" in read) return read.outcome;
  const { doc } = read;
  // One parse feeds every record's title and body: bugEntryBody re-parsed the whole document
  // per heading, and BUGS.md grows without bound, so the newest-10 scan paid 1 + 10 full-document
  // walks where one suffices.
  const records = fixedEntries(doc).slice(0, FIX_CLAIMS_CHECKED);
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

/** Stranded plans — plan headings filed under the wrong PLANS.md section (the stranded-plan
 * detector, src/backlog/backlog-structure.ts): a `(planned …)` heading sitting under `## Done` is
 * invisible to every Planned reader, and a done-dated heading still under `## Planned` invites
 * a second implementation. The clean loop repairs these when it happens to tick; this makes
 * the state visible to an operator without waiting for that tick. Reads the tree at `root` —
 * the primary checkout IS main's tree — like checkFixClaims. A warn, never a fail: a misplaced
 * heading is operator signal, not a broken environment. */
export function checkStrandedPlans(root: string): CheckOutcome {
  const read = readDocChecked(path.join(root, "PLANS.md"), "PLANS.md", "no PLANS.md — nothing to verify");
  if ("outcome" in read) return read.outcome;
  const { doc } = read;
  const stranded = strandedPlanEntries(doc);
  const clean = "no plan headings filed under the wrong PLANS.md section";
  if (stranded.length === 0) return okOutcome(clean);
  const [first, ...rest] = stranded;
  if (!first) return okOutcome(clean);
  const more = andMore(rest, (e) => `"${truncate(e.title, FIX_CLAIM_HEADING_MAX)}"`);
  return warnOutcome(`PLANS.md has a plan stranded under ## ${first.section}: "${first.title}"${more} — ` +
      `move it under ## ${first.section === "Done" ? "Planned" : "Done"} (the clean loop repairs these)`);
}

/** Duplicated `## ` headings already on main (the duplicate-heading half of the backlog-structure
 * check, src/backlog/backlog-structure.ts): a `## Done` a past landing or conflict resolution added
 * twice leaves every later entry after the first section invisible to the section readers, and
 * nothing repairs it on its own. Reads the tree at `root` — the primary checkout IS main's tree
 * — like checkFixClaims. A warn, never a fail: existing damage is operator signal, not a broken
 * environment, and a landing that adds another copy of the heading trips the gate's same
 * rule (a) — src/backlog/backlog-structure.ts fires only when a count EXCEEDS the merge-base's,
 * so an edit that leaves an existing duplicate alone passes and the duplicate itself needs a
 * deliberate removal edit. */
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
      `later entries are invisible; keep one heading per name (the gate blocks only a landing ` +
      `that adds another copy — remove the duplicate in a deliberate edit)`);
}

/** Refused entries — planned plans and open bugs held by a **Refused …** note. No loop clears
 * a Refused note, so the entry stays parked until a human or the director edits it, or an
 * operator releases it with `--release <n>`, and the
 * only other signs are the `[refused]` marks in the backlog listings. Reads the tree at `root`
 * — the primary checkout IS main's tree — like checkFixClaims, in `--list` order (PLANS.md
 * Planned, then BUGS.md Open). A warn, never a fail: a refusal is operator signal, not a broken
 * environment. */
export function checkRefusedEntries(root: string): CheckOutcome {
  const planned = plannedPlanEntries(root);
  const parts = plannedPartKeys(planned);
  const sources = [
    { file: "PLANS.md", command: "plan", entries: planned },
    { file: "BUGS.md", command: "bug", entries: openBugEntries(root) },
  ];
  const held = sources.flatMap(({ file, command, entries }) =>
    entries.flatMap((entry, index) => {
      const note = refusalNote(entry.body);
      if (note === null) return [];
      const landed = prerequisitesLanded(entry.title, parts);
      return [{ file, command, position: index + 1, title: entry.title, note, landed }];
    }));
  const [first, ...rest] = held;
  if (!first) return okOutcome("no planned plan or open bug is held by a Refused note");
  const more = andMore(rest, (e) =>
    `${e.file} ${e.command} #${e.position} "${truncate(e.title, FIX_CLAIM_HEADING_MAX)}"` +
    (e.landed.length > 0 ? " [prerequisites no longer planned]" : ""));
  const stale = first.landed.length > 0
    ? `; its prerequisite(s) ${first.landed.map((r) => `${r.series} ${r.part}/${r.of}`).join(", ")} are no longer planned, so the refusal may be stale`
    : "";
  return warnOutcome(`${first.file} ${first.command} #${first.position} "${first.title}" is held by a Refused note ` +
      `(${truncate(first.note, REFUSAL_NOTE_MAX)})${stale}${more} — no loop takes a refused entry until it is edited: ` +
      `answer the objection and release the entry with \`tumwater ${first.command} --release ${first.position}\`, ` +
      `or retract it with \`tumwater ${first.command} --cancel ${first.position}\``);
}
