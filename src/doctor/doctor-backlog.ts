import fs from "node:fs";
import path from "node:path";
import { errorMessage, truncate } from "../text/text.js";
import { BACKLOG_FILES } from "../backlog/backlog-md.js";
import { duplicateHeadings, strandedPlanEntries } from "../backlog/backlog-structure.js";
import { bugEntryBody, fixSymbols, fixedHeadings, missingSymbolNames, sourceHaystack, unbackedSymbols } from "../verdict/fix-claim.js";
import type { CheckOutcome } from "./doctor-checks.js";

/** The doctor's backlog-document checks, split out of doctor-checks.ts: the three checks that
 * read the project's tracked Markdown backlog (BUGS.md, PLANS.md, QUESTIONS.md) rather than the
 * environment doctor-checks.ts inspects — fix claims, stranded plans, and duplicated `## `
 * headings. They share this module's helpers (readDoc and its checked wrapper readDocChecked,
 * andMore) and the heading-trim constant, and all three warn instead of failing: damaged
 * documentation is operator signal, not a broken environment. doctor.ts composes them beside
 * the environment checks; the shared CheckOutcome shape is type-imported from doctor-checks.ts. */

/** How many Fixed records the fix-claims check verifies: the newest, since the section is
 * newest-first by template convention. Older records drift as the code evolves — a symbol
 * legitimately fixed long ago gets renamed later — so a whole-section scan would warn forever
 * on records nobody should rewrite. */
const FIX_CLAIMS_CHECKED = 10;

/** A second or later suspect record's heading is trimmed to this many characters in the warn —
 * the first is named in full, the rest only enough to find them in BUGS.md. */
const FIX_CLAIM_HEADING_MAX = 60;

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
  if (!fs.existsSync(p)) return { outcome: { level: "ok", detail: missingDetail } };
  const read = readDoc(p);
  if ("error" in read) return { outcome: { level: "warn", detail: `cannot read ${file} — ${read.error}` } };
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
  const headings = fixedHeadings(doc).slice(0, FIX_CLAIMS_CHECKED);
  // The haystack walks src/, test/ and scripts/: build it only once a record names something.
  let haystack: string | undefined;
  const phantoms: Array<{ heading: string; missing: string[] }> = [];
  for (const heading of headings) {
    const symbols = fixSymbols(bugEntryBody(doc, heading));
    if (symbols.length === 0) continue;
    haystack ??= sourceHaystack(root);
    const missing = unbackedSymbols(root, symbols, haystack);
    if (missing.length === symbols.length) phantoms.push({ heading, missing });
  }
  const [first, ...rest] = phantoms;
  if (!first)
    return { level: "ok", detail: `newest ${headings.length} Fixed record(s) name code that exists on this tree` };
  // falseFixReason's message shape: the heading, then up to 3 missing names.
  const { heading, missing } = first;
  const names = missingSymbolNames(missing);
  // Every other suspect is still named, shortened: a doctor check is one line.
  const more = andMore(rest, (p) => `"${truncate(p.heading, FIX_CLAIM_HEADING_MAX)}"`, "record(s)");
  return {
    level: "warn",
    detail:
      `BUGS.md records "${heading}" as Fixed, but none of the symbols its Fix paragraph names ` +
      `exist on this tree: ${names}${more} — land the fix or keep the bug Open / refresh a stale record`,
  };
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
  if (stranded.length === 0) return { level: "ok", detail: clean };
  const [first, ...rest] = stranded;
  if (!first) return { level: "ok", detail: clean };
  const more = andMore(rest, (e) => `"${truncate(e.title, FIX_CLAIM_HEADING_MAX)}"`);
  return {
    level: "warn",
    detail:
      `PLANS.md has a plan stranded under ## ${first.section}: "${first.title}"${more} — ` +
      `move it under ## ${first.section === "Done" ? "Planned" : "Done"} (the clean loop repairs these)`,
  };
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
    return { level: "ok", detail: "no duplicated ## section headings in the backlog files" };
  const [first, ...rest] = duplicates;
  const more = andMore(rest, (d) => d);
  return {
    level: "warn",
    detail:
      `${first}${more} appears more than once — readers take the first section of a name, so ` +
      `later entries are invisible; keep one heading per name (the gate blocks only a landing ` +
      `that adds another copy — remove the duplicate in a deliberate edit)`,
  };
}
