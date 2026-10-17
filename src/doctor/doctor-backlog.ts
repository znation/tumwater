// vocabulary: plain
import { roleLabel } from "../roles/role-labels.js";
import fs from "node:fs";
import path from "node:path";
import { errorMessage, truncate } from "../text/text.js";
import { ageInDays, donePlans, filingDate, openBugEntries, openQuestionEntries, plannedPlanEntries } from "../backlog/backlog.js";
import { questionFilingDate } from "../backlog/question-answer.js";
import { entryHold, planDependencyProblems, plannedPartKeys, plansWaitingOn, prerequisitesLanded, refusalNote, waitingNote } from "../backlog/backlog-eligibility.js";
import { BACKLOG_FILES, lastDate } from "../backlog/backlog-md.js";
import { duplicateHeadings, strandedPlanEntries } from "../backlog/backlog-structure.js";
import { fixSymbols, fixedEntries, missingSymbolNames, sourceHaystack, unbackedSymbols } from "../verdict/fix-claim.js";
import { briefFile } from "../brief/brief.js";
import type { TumwaterConfig } from "../config/config-schema.js";
import { currentBranch, targetBranch } from "../git/git.js";
import { gitTry } from "../git/git-run.js";
import { queuedMerges } from "../merge/merge-queue.js";
import { mergeChanges, readMergeMarker } from "../merge/merge-slot.js";
import { formatTimestamp, humanSeconds, secondsSince } from "../text/datetime.js";
import { readEventsSince } from "../events/event-window.js";
import type { HarnessEvent } from "../events/events.js";
import { stringList } from "../files/json-object.js";
import { type CheckOutcome, okOutcome, warnOutcome } from "./outcome.js";

/** The doctor's backlog-document checks, split out of doctor-checks.ts: the five checks that
 * read the project's tracked Markdown backlog (BUGS.md, PLANS.md, QUESTIONS.md) rather than the
 * environment doctor-checks.ts inspects — fix claims, stranded plans, duplicated `## `
 * headings, refused entries, stale open bugs, and uncommitted edits to the backlog files in
 * the primary checkout. They share this module's helpers (readDoc and its checked wrapper
 * readDocChecked, andMore) and the heading-trim constant, and all of them warn instead of
 * failing: damaged documentation is operator signal, not a broken environment. doctor.ts
 * composes them beside the environment checks; the shared CheckOutcome shape is imported from
 * outcome.ts. */

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

/** The whole days an open question may wait before the stale-questions check warns about it:
 * an opinionated default, matching the 7-day window the `--list` age is meant to surface.
 * A question awaiting a human answer is operator signal, so the value needs no knob. */
const STALE_QUESTION_DAYS = 7;

/** The whole days an open bug may wait before the stale-bugs check warns about it: an
 * opinionated default with no knob, like STALE_QUESTION_DAYS. Three days is long enough that a
 * bug filed late one evening and fixed the next day never warns. */
const STALE_BUG_DAYS = 3;

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
      `move it under ## ${first.section === "Done" ? "Planned" : "Done"} (the clean role repairs these)`);
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
      `later entries are invisible; keep one heading per name (the gate blocks only a merge ` +
      `that adds another copy — remove the duplicate in a deliberate edit)`);
}

/** Stalled plans — planned plans held by a **Needs review …** or **Needs replan …** note,
 * parked until the plan role splits or replans them. No loop takes a held entry (the claim
 * gate refuses one) and nothing clears the note on its own, so the state is visible only as
 * the `[needs review]`/`[needs replan]` marks in the backlog listings; this names them so an
 * operator gets a single-line health signal from `tumwater doctor`. Reads the tree at `root`
 * — the primary checkout IS main's tree — like checkRefusedEntries, which is also where
 * refusal notes (a different hold) are surfaced. entryHold (src/backlog/backlog-eligibility.ts)
 * already classifies the notes, so this check adds no parsing: only the planned entries whose
 * hold is exactly needs-review or needs-replan are collected. A warn, never a fail — the
 * checkRefusedEntries precedent: a parked plan is operator signal, not a broken environment,
 * and the plan role resolves it itself. */
export function checkStalledPlans(root: string): CheckOutcome {
  const planned = plannedPlanEntries(root);
  const stalled = planned.filter((entry) => {
    const hold = entryHold(entry, planned);
    return hold === "needs-review" || hold === "needs-replan";
  });
  const [first, ...rest] = stalled;
  if (!first) return okOutcome("no planned plan is held by a Needs-review or Needs-replan note");
  const more = andMore(rest, (e) => `"${truncate(e.title, FIX_CLAIM_HEADING_MAX)}"`);
  const hold = entryHold(first, planned);
  const note = (first.body.split(/\n/).find(
    (line) => line.trimStart().startsWith("**Needs review ") || line.trimStart().startsWith("**Needs replan "),
  ) ?? "").replace(/^\s*\*\*/, "").replace("**", "");
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

/** How long a queued landing may wait without its change starting before the stale-queued-landing
 * check warns: 6 hours, fixed. A vet plus a merge completes in minutes (plans/merge-queue.md), so
 * a full six-hour silence while the team is healthy — not on a hold, which doctor already reports
 * separately — is never a merely busy pipeline: it reads as a drain that has stalled. The one
 * opinionated default, like STALE_QUESTION_DAYS, so no knob. */
const LAND_QUEUE_STALE_MS = 6 * 60 * 60 * 1000;

/** Stale queued landings — a change that has sat in the durable land queue too long without
 * starting (plans/merge-queue.md). Every queued-change health fact is otherwise a hook into its
 * own role or stage: a vet under way reads in the team row, a team hold gets its own banner,
 * and team-alerts' STALL_RE catches a RUNNING stage frozen. But a change (or a batch behind the
 * single merge slot) that quietly never starts — neither vetted nor flagged — reads as healthy:
 * the header's `land queue: N` badge counts it and `tumwater queue` ages it, yet nothing calls it
 * out on its own. This names the single oldest queued landing that is NOT currently in-flight and
 * has waited past LAND_QUEUE_STALE_MS, so an operator sees a stalled drain instead of only a
 * growing depth. The in-flight marker (readMergeMarker via mergeChanges) contributes the set
 * of roles holding a change being vetted or merged right now — a slow review is not a stalled
 * drain, and an absent or never-throwing unreadable marker contributes the empty set. Reads the
 * tree at `root` with the already-exported readers, changing nothing in src/merge/. A warn,
 * never a fail — the checkStaleQuestions/checkStalledPlans precedent: a queued wait is legitimate
 * while the team is genuinely held, and those holds already warn separately. */
export function checkStaleQueuedLandings(root: string, now: number): CheckOutcome {
  const marker = readMergeMarker(root);
  const inFlight = new Set(marker ? mergeChanges(marker).map((c) => c.role) : []);
  const stale = queuedMerges(root)
    .filter((e) => !inFlight.has(e.role) && now - e.enqueuedAt > LAND_QUEUE_STALE_MS)
    .map((e) => ({ role: e.role, summary: e.summary, age: humanSeconds(secondsSince(e.enqueuedAt, now)) }));
  const [first, ...rest] = stale;
  if (!first)
    return okOutcome(`no merge-queue entry has waited more than ${humanSeconds(LAND_QUEUE_STALE_MS / 1000)} to start`);
  const more = andMore(rest, (e) => `${e.role} — "${truncate(e.summary, FIX_CLAIM_HEADING_MAX)}"`);
  return warnOutcome(`merge-queue entry of ${roleLabel(first.role)} — "${truncate(first.summary, FIX_CLAIM_HEADING_MAX)}" — has waited ` +
      `${first.age} to start${more}; a queued change the pipeline neither approves nor flags reads as healthy, so the merge queue has stopped moving`);
}

/** Stale questions — open QUESTIONS.md questions that have waited more than 7 days for an
 * answer. A team can stay parked on a question for days while `tumwater doctor` reports
 * nothing; the `--list` age (`questionAgeSuffix` on `tumwater questions`) is the only other
 * place the wait shows, and only when the operator asks. Reads the tree at `root` — the
 * primary checkout IS main's tree — like checkRefusedEntries, reusing
 * `questionFilingDate`/`openQuestionEntries` (src/backlog) unchanged. The age is the whole
 * days between the heading's `(asked by …)` stamp and now through backlog.js's ageInDays,
 * the one age formula, floored at 0; an undated heading is skipped. A warn, never a fail —
 * the checkStalledPlans/checkRefusedEntries precedent: a question awaiting a human is
 * operator signal, not a broken environment. */
export function checkStaleQuestions(root: string): CheckOutcome {
  const read = readDocChecked(path.join(root, "QUESTIONS.md"), "QUESTIONS.md", "no QUESTIONS.md — nothing to verify");
  if ("outcome" in read) return read.outcome;
  const stale = openQuestionEntries(root).flatMap((q) => {
    const stamp = questionFilingDate(q.title);
    if (stamp === null) return [];
    const days = ageInDays(stamp);
    return days >= STALE_QUESTION_DAYS ? [{ title: q.title, days }] : [];
  });
  const [first, ...rest] = stale;
  if (!first) return okOutcome("no open question has waited more than 7 days for an answer");
  const more = andMore(rest, (q) => `"${truncate(q.title, FIX_CLAIM_HEADING_MAX)}"`);
  return warnOutcome(`QUESTIONS.md question "${truncate(first.title, FIX_CLAIM_HEADING_MAX)}" has waited ${first.days} d for an answer${more} — ` +
      `a question that waits too long for a human answer is worth your attention`);
}

/** Stale bugs — unrefused open BUGS.md bugs whose `(found by … YYYY-MM-DD)` or `(reported …)`
 * stamp is at least 3 days old. The bugfix role fixes a bug within hours, so one that sits means
 * no loop is fixing it. Positions are the 1-based `bug --list` numbers; a refused bug is skipped
 * (checkRefusedEntries names it), a waiting bug is skipped (checkWaitingBugs names it) and so is
 * an undated heading. A warn, never a fail. */
export function checkStaleBugs(root: string): CheckOutcome {
  const read = readDocChecked(path.join(root, "BUGS.md"), "BUGS.md", "no BUGS.md — nothing to verify");
  if ("outcome" in read) return read.outcome;
  const stale = openBugEntries(root).flatMap((entry, index) => {
    if (refusalNote(entry.body) !== null || waitingNote(entry.body) !== null) return [];
    const stamp = filingDate(entry.title);
    if (stamp === null) return [];
    const days = ageInDays(stamp);
    return days >= STALE_BUG_DAYS ? [{ position: index + 1, title: entry.title, days }] : [];
  });
  const [first, ...rest] = stale;
  if (!first) return okOutcome("no open bug has waited more than 3 days for a fix");
  const more = andMore(rest, (b) => `#${b.position} "${truncate(b.title, FIX_CLAIM_HEADING_MAX)}"`);
  return warnOutcome(`BUGS.md bug #${first.position} "${truncate(first.title, FIX_CLAIM_HEADING_MAX)}" has waited ${first.days} d for a fix${more} — ` +
      `no role is fixing it: check that the bugfix role is enabled and not failing, or retract it with \`tumwater bug --cancel ${first.position}\``);
}

/** The first span between straight double quotes in a bug heading that is at least 12
 * characters long — the test name a flake bug's heading quotes — or null. The floor stops a
 * short quoted word from matching unrelated failures. */
export function quotedTestName(title: string): string | null {
  return /"([^"]{12,})"/.exec(title)?.[1] ?? null;
}

/** Local midnight at the end of a `YYYY-MM-DD` day, in ms: the earliest instant a failure can
 * be told apart from the one a same-day note or fix record was written about. NaN for a
 * malformed date. */
function dayAfterMs(date: string): number {
  return new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)) + 1).getTime();
}

/** The first `YYYY-MM-DD` in a Waiting for the next failure note's text, or null. */
export function waitingNoteDate(note: string): string | null {
  return /\d{4}-\d{2}-\d{2}/.exec(note)?.[0] ?? null;
}

/** Every event at or after `sinceMs` that records a failure naming `name`: a `warning` whose
 * message includes it (gate and merge flake warnings, a merge check kept for one retry), or a
 * `review_rejected` with a reason that includes it (its text is the first such reason). In
 * event order. */
export function failureMentions(events: readonly HarnessEvent[], name: string, sinceMs: number): { ts: number; text: string }[] {
  return events.flatMap((e) => {
    if (typeof e.ts !== "number" || e.ts < sinceMs) return [];
    if (e.type === "warning" && typeof e.message === "string" && e.message.includes(name)) return [{ ts: e.ts, text: e.message }];
    if (e.type === "review_rejected") {
      const reason = stringList(e.reasons).find((r) => r.includes(name));
      if (reason !== undefined) return [{ ts: e.ts, text: reason }];
    }
    return [];
  });
}

/** Waiting bugs — open BUGS.md bugs held by a **Waiting for the next failure …** note, which
 * parks a bug until it fails again. Positions are the 1-based `bug --list` numbers; a bug that
 * is also Refused is left to checkRefusedEntries. Ok when the hold is undisturbed — doctor
 * then only names the bugs and how to release one — and a warn when a held bug's quoted test
 * has failed in a gate or merge check since the day after its note (the note carries only a
 * date, so a same-day failure cannot be told from the one it was written about). A warn is
 * never a fail, and doctor writes nothing to BUGS.md. */
export function checkWaitingBugs(root: string): CheckOutcome {
  const read = readDocChecked(path.join(root, "BUGS.md"), "BUGS.md", "no BUGS.md — nothing to verify");
  if ("outcome" in read) return read.outcome;
  const held = openBugEntries(root).flatMap((entry, index) => {
    const note = waitingNote(entry.body);
    if (note === null || refusalNote(entry.body) !== null) return [];
    const name = quotedTestName(entry.title);
    const date = waitingNoteDate(note);
    const since = name !== null && date !== null ? dayAfterMs(date) : null;
    return [{ position: index + 1, title: entry.title, note, name, since }];
  });
  const [first, ...rest] = held;
  if (!first) return okOutcome("no open bug is waiting for its next failure");
  const sinces = held.flatMap((b) => (b.since !== null && !Number.isNaN(b.since) ? [b.since] : []));
  if (sinces.length > 0) {
    const { events } = readEventsSince(root, Math.max(0, Date.now() - Math.min(...sinces)));
    const recurred = held.flatMap((b) => {
      if (b.name === null || b.since === null) return [];
      const mentions = failureMentions(events, b.name, b.since);
      const newest = mentions[mentions.length - 1];
      return newest ? [{ ...b, newest }] : [];
    });
    const [again, ...others] = recurred;
    if (again) {
      const more = andMore(others, (b) => `#${b.position} "${truncate(b.title, FIX_CLAIM_HEADING_MAX)}"`);
      return warnOutcome(`BUGS.md bug #${again.position} "${truncate(again.title, FIX_CLAIM_HEADING_MAX)}" failed again since its Waiting for the next failure note ` +
        `(${formatTimestamp(again.newest.ts)}: ${truncate(again.newest.text, REFUSAL_NOTE_MAX)})${more} — ` +
        `record the occurrence under the entry and release it with \`tumwater bug --release ${again.position}\``);
    }
  }
  const more = andMore(rest, (b) => `#${b.position} "${truncate(b.title, FIX_CLAIM_HEADING_MAX)}"`);
  return okOutcome(`BUGS.md bug #${first.position} "${truncate(first.title, FIX_CLAIM_HEADING_MAX)}" is held until it fails again ` +
      `(${truncate(first.note, REFUSAL_NOTE_MAX)})${more} — selfcheck lifts the note when it records a new occurrence; ` +
      `release it now with \`tumwater bug --release ${first.position}\``);
}

/** Regressed fixes — a newest-10 BUGS.md Fixed record whose heading quotes a test name that a
 * gate or merge check has failed on since the day after its fix (the heading carries only a
 * date, so a same-day failure cannot be told from the one the fix answered), unless an Open bug
 * already quotes the same test, which means the regression is filed. A warn, never a fail, and
 * doctor writes nothing to BUGS.md. */
export function checkRegressedFixes(root: string): CheckOutcome {
  const read = readDocChecked(path.join(root, "BUGS.md"), "BUGS.md", "no BUGS.md — nothing to verify");
  if ("outcome" in read) return read.outcome;
  const candidates = fixedEntries(read.doc).slice(0, FIX_CLAIMS_CHECKED).flatMap((entry) => {
    const name = quotedTestName(entry.title);
    const date = lastDate(entry.title, /(\d{4}-\d{2}-\d{2})/);
    if (name === null || date === null) return [];
    const since = dayAfterMs(date);
    return Number.isNaN(since) ? [] : [{ title: entry.title, name, date, since }];
  });
  const open = candidates.length > 0 ? openBugEntries(root).map((e) => quotedTestName(e.title)) : [];
  const unfiled = candidates.filter((c) => !open.includes(c.name));
  if (unfiled.length > 0) {
    const { events } = readEventsSince(root, Math.max(0, Date.now() - Math.min(...unfiled.map((c) => c.since))));
    const regressed = unfiled.flatMap((c) => {
      const mentions = failureMentions(events, c.name, c.since);
      const newest = mentions[mentions.length - 1];
      return newest ? [{ ...c, newest }] : [];
    });
    const [first, ...rest] = regressed;
    if (first) {
      const more = andMore(rest, (c) => `"${truncate(c.title, FIX_CLAIM_HEADING_MAX)}"`);
      return warnOutcome(`BUGS.md Fixed record "${truncate(first.title, FIX_CLAIM_HEADING_MAX)}" quotes a test that failed again after its ${first.date} fix ` +
        `(${formatTimestamp(first.newest.ts)}: ${truncate(first.newest.text, REFUSAL_NOTE_MAX)})${more} — ` +
        "file it as a new bug with `tumwater bug`, quoting the test name and citing the Fixed record");
    }
  }
  return okOutcome("no recently Fixed bug's quoted test has failed since its fix");
}

/** Refused entries — planned plans and open bugs held by a **Refused …** note. No loop clears
 * a Refused note, so the entry stays parked until a human or the director edits it, or an
 * operator releases it with `--release <n>`, and the
 * only other signs are the `[refused]` marks in the backlog listings. Reads the tree at `root`
 * — the primary checkout IS main's tree — like checkFixClaims, in `--list` order (PLANS.md
 * Planned, then BUGS.md Open). A warn, never a fail: a refusal is operator signal, not a broken
 * environment. The warning also counts the planned parts a refused series part holds. */
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
      const waiting = file === "PLANS.md" ? plansWaitingOn(planned, index).length : 0;
      return [{ file, command, position: index + 1, title: entry.title, note, landed, waiting }];
    }));
  const [first, ...rest] = held;
  if (!first) return okOutcome("no planned plan or open bug is held by a Refused note");
  const more = andMore(rest, (e) =>
    `${e.file} ${e.command} #${e.position} "${truncate(e.title, FIX_CLAIM_HEADING_MAX)}"` +
    (e.landed.length > 0 ? " [prerequisites no longer planned]" : "") +
    (e.waiting > 0 ? ` [${e.waiting} part(s) wait on it]` : ""));
  const stale = first.landed.length > 0
    ? `; its prerequisite(s) ${first.landed.map((r) => `${r.series} ${r.part}/${r.of}`).join(", ")} are no longer planned, so the refusal may be stale`
    : "";
  const waiting = first.waiting > 0
    ? `; ${first.waiting} planned part(s) wait on it, directly or through an earlier part`
    : "";
  return warnOutcome(`${first.file} ${first.command} #${first.position} "${first.title}" is held by a Refused note ` +
      `(${truncate(first.note, REFUSAL_NOTE_MAX)})${stale}${waiting}${more} — no role takes a refused entry until it is edited: ` +
      `answer the objection and release the entry with \`tumwater ${first.command} --release ${first.position}\`, ` +
      `or retract it with \`tumwater ${first.command} --cancel ${first.position}\``);
}

/** Names the backlog files (and the brief file) with uncommitted edits in the primary checkout.
 * An operator write is meant to be committed on the base branch by commitOperatorBacklogEdit;
 * when that commit does not happen the edit is invisible to every loop worktree (they branch
 * from main) and a landing that touches the file cannot fast-forward the checkout
 * (merge_blocked). A primary off the base branch is skipped: the ref-push landing arm leaves
 * its working tree alone. Untracked files are not edits of a tracked file and are ignored. */
export async function checkUncommittedBacklog(root: string, config: TumwaterConfig | undefined): Promise<CheckOutcome> {
  const primary = await currentBranch(root);
  const base = targetBranch(config?.baseBranch, primary);
  if (primary === null || primary !== base) {
    return okOutcome(`your checkout is not on ${base}; backlog writes from you are not committed from it`);
  }
  const brief = briefFile(root);
  const files = [...new Set([...BACKLOG_FILES, ...(brief ? [brief] : [])])];
  const out = await gitTry(root, "status", "--porcelain", "--", ...files);
  if (out === null) return okOutcome("could not read git status; skipped");
  const dirty = new Set(out.split("\n")
    .filter((line) => line.length > 3 && !line.startsWith("??"))
    .map((line) => line.slice(3)));
  const named = files.filter((f) => dirty.has(f));
  if (named.length === 0) {
    const list = files.slice(0, -1).join(", ");
    return okOutcome(`${list} and ${files[files.length - 1]} are committed`);
  }
  const list = named.join(", ");
  return warnOutcome(`${list} ${named.length > 1 ? "have" : "has"} uncommitted changes in your checkout — ` +
    `roles branch from main and do not see them, and a merge that touches one cannot fast-forward the checkout ` +
    `(merge_blocked); review them with \`git diff -- ${list}\` and commit them on ${base}`);
}
