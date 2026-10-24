import { andMore, readBacklogChecked, FIX_CLAIMS_CHECKED, FIX_CLAIM_HEADING_MAX, REFUSAL_NOTE_MAX, STALE_QUESTION_DAYS, STALE_BUG_DAYS, STALE_WAIT_DAYS } from "./doctor-backlog.js";
import { truncate } from "../text/text.js";
import { ageInDays, filingDate, fixedBugEntries, openBugEntries, openQuestionEntries, plannedPlanEntries } from "../backlog/backlog.js";
import { stripEntryStamp } from "../backlog/backlog-structure.js";
import { questionFilingDate } from "../backlog/question-answer.js";
import { refusalNote, waitingNote } from "../backlog/backlog-eligibility.js";
import { plannedPartKeys, plansWaitingOn, prerequisitesMerged } from "../backlog/backlog-parts.js";
import { lastDate } from "../backlog/backlog-md.js";
import { formatTimestamp } from "../text/datetime.js";
import { stringList } from "../files/json-object.js";
import { readEventsSince } from "../events/event-window.js";
import type { HarnessEvent } from "../events/events.js";
import { type CheckOutcome, okOutcome, warnOutcome } from "./outcome.js";

/** The doctor's open-bug and question checks, split out of doctor-backlog.ts: questions that
 * have waited too long for an answer (checkStaleQuestions), bugs left unfixed (checkStaleBugs),
 * bugs held for their next failure (checkWaitingBugs, with its quotedTestName / waitingNoteDate /
 * failureMentions helpers), fixed records whose quoted test regressed (checkRegressedFixes), and
 * entries parked by a Refused note (checkRefusedEntries). They import the shared helpers
 * (readBacklogChecked, andMore) from doctor-backlog.ts, plus the age/trim bounds, and
 * all warn instead of failing: a stale or
 * parked entry is operator signal, not a broken environment. doctor.ts composes them beside the
 * plan-structure and queue checks; the shared CheckOutcome shape is imported from outcome.ts. */

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
  const doc = readBacklogChecked(root, "QUESTIONS.md");
  if (typeof doc !== "string") return doc;
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
 * no role is fixing it. Positions are the 1-based `bug --list` numbers; a refused bug is skipped
 * (checkRefusedEntries names it), a waiting bug is skipped (checkWaitingBugs names it) and so is
 * an undated heading. A warn, never a fail. */
export function checkStaleBugs(root: string): CheckOutcome {
  const doc = readBacklogChecked(root, "BUGS.md");
  if (typeof doc !== "string") return doc;
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

/** True when `text` is a check-failure report that names `name` as a test that failed — the
 * doctors' recurrence/regression evidence. The recurrence scans must not count any line that
 * merely *contains* the quoted test name as the flake's return, or a warning that only quotes
 * it — a quarantine-release lifecycle line, an unfiled-flake or housekeeping warning, a
 * merge-blocked note, review prose — gets quoted as the failure that proves a recurrence or
 * regression. Only the actual failure shapes the harness writes count: a `✖ <name>`
 * failed-test line (which the gate's and merge's flake warnings quote verbatim — the `… failed
 * then passed on retry — flaky: ✖ <name>…` pair and `known-flaky failure, merge kept:` — and
 * which a check's own failing-test detail is built from), or a gate warning that lists `name`
 * among main's known failures (`… known failures: <names>`) or a stale base's already-failed
 * set (`… already failed, and main … is green: <names>`). Anything else names the test without
 * failing it. */
function isCheckFailure(text: string, name: string): boolean {
  if (!text.includes(name)) return false;
  return text.includes(`✖ ${name}`) || text.includes("known failures:") || text.includes("already failed");
}

/** Every event at or after `sinceMs` that records a failure naming `name`: a `warning` whose
 * message is a check-failure report naming it (gate and merge flake warnings, a check failed
 * for one retry, main's or a stale base's known-failure list), or a `review_rejected` with a
 * reason that is one (its text is the first such reason). A line that merely quotes the test
 * name in another context is not a failure (see isCheckFailure). In event order. */
export function failureMentions(events: readonly HarnessEvent[], name: string, sinceMs: number): { ts: number; text: string }[] {
  return events.flatMap((e) => {
    if (typeof e.ts !== "number" || e.ts < sinceMs) return [];
    if (e.type === "warning" && typeof e.message === "string" && isCheckFailure(e.message, name)) return [{ ts: e.ts, text: e.message }];
    if (e.type === "review_rejected") {
      const reason = stringList(e.reasons).find((r) => isCheckFailure(r, name));
      if (reason !== undefined) return [{ ts: e.ts, text: reason }];
    }
    return [];
  });
}

/** The newest failure report at or after `since` naming `name` — `failureMentions`'s last
 * mention — or undefined when none. The single home of the "did this flake come back after
 * its boundary?" step, shared by the waiting-bug recurrence scan (checkWaitingBugs) and the
 * regressed-fix match (matchedRegressedFixes), so both keep the same last-mention rule. */
function lastFailureMention(events: readonly HarnessEvent[], name: string, sinceMs: number): { ts: number; text: string } | undefined {
  const mentions = failureMentions(events, name, sinceMs);
  return mentions[mentions.length - 1];
}

/** The read-events window (ms) that reaches the oldest of `sinces` — `Date.now()` minus the
 * oldest timestamp, floored at 0 — so a recurrence check reads events past every candidate's
 * `since`. The single home of the "oldest of a set of since-times" step, shared by
 * checkWaitingBugs and checkRegressedFixes, so those sites cannot drift on the clamp or the
 * time base. */
function sinceWindowMs(sinces: readonly number[]): number {
  return Math.max(0, Date.now() - Math.min(...sinces));
}

/** Open BUGS.md bugs held by a **Waiting for the next failure …** note, in file order: the
 * doctor's `checkWaitingBugs` selection and anchor, factored out so the always-on stale-wait
 * feed (staleWaitingBugRows) reads the same held set and cannot drift from the doctor's rule.
 * A bug that is also Refused is left to checkRefusedEntries. `since` is the day-after the
 * note's date — the recurrence scan's boundary; `date` the note's own `YYYY-MM-DD` or null. */
function heldWaitingBugs(root: string): Array<{ index: number; position: number; title: string; note: string; name: string | null; since: number | null; date: string | null }> {
  return openBugEntries(root).flatMap((entry, index) => {
    const note = waitingNote(entry.body);
    if (note === null || refusalNote(entry.body) !== null) return [];
    const name = quotedTestName(entry.title);
    const date = waitingNoteDate(note);
    const since = name !== null && date !== null ? dayAfterMs(date) : null;
    return [{ index, position: index + 1, title: entry.title, note, name, since, date }];
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
  const doc = readBacklogChecked(root, "BUGS.md");
  if (typeof doc !== "string") return doc;
  const held = heldWaitingBugs(root);
  const [first, ...rest] = held;
  if (!first) return okOutcome("no open bug is waiting for its next failure");
  const sinces = held.flatMap((b) => (b.since !== null && !Number.isNaN(b.since) ? [b.since] : []));
  if (sinces.length > 0) {
    const { events } = readEventsSince(root, sinceWindowMs(sinces));
    const recurred = held.flatMap((b) => {
      if (b.name === null || b.since === null) return [];
      const newest = lastFailureMention(events, b.name, b.since);
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
  /* A Waiting hold has no expiry of its own, so a bug whose flake never comes back parks
   * indefinitely; a hold that has outlived STALE_WAIT_DAYS without a recurrence is escalated
   * from the ok below to a warn so the operator is nudged to release or re-hold it. */
  const lapsed = held.flatMap((b) => {
    /* An undated note (no YYYY-MM-DD in its text) has no hold-start marker, and checkStaleBugs
     * skips any bug carrying a waiting note, so without a fallback it would park indefinitely
     * too; the filing stamp anchors it — the hold cannot be younger than the bug it dates from. */
    const anchor = b.date ?? filingDate(b.title);
    if (anchor === null) return [];
    const days = ageInDays(anchor);
    return days >= STALE_WAIT_DAYS ? [{ ...b, days }] : [];
  });
  const [firstLapsed, ...restLapsed] = lapsed;
  if (firstLapsed) {
    const more = andMore(restLapsed, (b) => `#${b.position} "${truncate(b.title, FIX_CLAIM_HEADING_MAX)}"`);
    return warnOutcome(`BUGS.md bug #${firstLapsed.position} "${truncate(firstLapsed.title, FIX_CLAIM_HEADING_MAX)}" has waited ${firstLapsed.days} d for its next failure without one ` +
        `— its flake likely never comes back, so it parks indefinitely; release it with \`tumwater bug --release ${firstLapsed.position}\`${more}`);
  }
  const more = andMore(rest, (b) => `#${b.position} "${truncate(b.title, FIX_CLAIM_HEADING_MAX)}"`);
  return okOutcome(`BUGS.md bug #${first.position} "${truncate(first.title, FIX_CLAIM_HEADING_MAX)}" is held until it fails again ` +
      `(${truncate(first.note, REFUSAL_NOTE_MAX)})${more} — selfcheck lifts the note when it records a new occurrence; ` +
      `release it now with \`tumwater bug --release ${first.position}\``);
}

/** The always-on rows behind the dashboard/TUI/`tumwater status` waiting-bug alert: open BUGS.md
 * bugs held by a **Waiting for the next failure …** note whose anchor (the note's `YYYY-MM-DD`,
 * else the heading's filing stamp) is at least STALE_WAIT_DAYS old. Shares the doctor's
 * STALE_WAIT_DAYS threshold and the heldWaitingBugs selection/anchor, so the alert and the
 * doctor's `waiting bugs` row cannot drift on the rule; an undated note-and-heading is skipped.
 * The returned objects carry the 0-based index (drawer address `bugs:<index>`), the 1-based
 * position (`bug --release <position>`), the stamp-stripped title, and the whole-day age.
 * Returned most-days-waited-first, ties in file order, like staleOpenBugs. This deliberately
 * omits `checkWaitingBugs`'s recurrence scan, because that scan reads events back to the oldest
 * hold and is too costly on the status poll path; the doctor still reports a recurrence first. */
export function staleWaitingBugRows(root: string, now = Date.now()): Array<{ index: number; position: number; title: string; days: number }> {
  return heldWaitingBugs(root)
    .flatMap((b) => {
      const anchor = b.date ?? filingDate(b.title);
      if (anchor === null) return [];
      const days = ageInDays(anchor, now);
      return days >= STALE_WAIT_DAYS ? [{ index: b.index, position: b.position, title: stripEntryStamp(b.title), days }] : [];
    })
    .sort((a, b) => b.days - a.days || a.index - b.index);
}

/** The regression candidates for the `regressed fixes` feed: a newest-FIX_CLAIMS_CHECKED BUGS.md
 * Fixed record whose heading quotes a test name and carries a `YYYY-MM-DD` date, unless an Open
 * bug already quotes the same test (which means the regression is filed). Shared by the doctor's
 * `regressed fixes` row (checkRegressedFixes) and the always-on regressed-fixes alert, so the two
 * cannot drift on the selection. `since` is the day-after the fix date — the recurrence scan's
 * boundary (the heading carries only a date, so a same-day failure cannot be told from the one
 * the fix answered). Returns `[]` when no candidate has both a quoted test and a date. */
export function regressedFixCandidates(root: string): RegressedFixCandidate[] {
  const candidates = fixedBugEntries(root).slice(0, FIX_CLAIMS_CHECKED).flatMap((entry) => {
    const name = quotedTestName(entry.title);
    const date = lastDate(entry.title, /(\d{4}-\d{2}-\d{2})/);
    if (name === null || date === null) return [];
    const since = dayAfterMs(date);
    return Number.isNaN(since) ? [] : [{ title: entry.title, name, date, since }];
  });
  const open = candidates.length > 0 ? openBugEntries(root).map((e) => quotedTestName(e.title)) : [];
  return candidates.filter((c) => !open.includes(c.name));
}

/** The candidates whose quoted test actually failed again, in candidate order: one
 * `failureMentions` per candidate over `events`, keeping the last mention (the doctor's exact
 * match). The caller supplies the event window — the doctor reads back to the oldest candidate's
 * day-after, the always-on alert the trailing day. */
export function matchedRegressedFixes(
  candidates: readonly RegressedFixCandidate[],
  events: readonly HarnessEvent[],
): RegressedFix[] {
  return candidates.flatMap((c) => {
    const newest = lastFailureMention(events, c.name, c.since);
    return newest ? [{ ...c, newest }] : [];
  });
}

/** The doctor's `regressed fixes` warn sentence, verbatim, or null when nothing regressed. */
export function regressedFixesPhrase(regressed: readonly RegressedFix[]): string | null {
  const [first, ...rest] = regressed;
  if (!first) return null;
  const more = andMore(rest, (c) => `"${truncate(c.title, FIX_CLAIM_HEADING_MAX)}"`);
  return `BUGS.md Fixed record "${truncate(first.title, FIX_CLAIM_HEADING_MAX)}" quotes a test that failed again after its ${first.date} fix ` +
    `(${formatTimestamp(first.newest.ts)}: ${truncate(first.newest.text, REFUSAL_NOTE_MAX)})${more} — ` +
    "file it as a new bug with `tumwater bug`, quoting the test name and citing the Fixed record";
}

/** A Fixed record whose heading quotes a test name and carries a `YYYY-MM-DD` fix date — one
 * regressed-fix candidate that is not already filed as an Open bug. */
export interface RegressedFixCandidate {
  title: string;
  name: string;
  date: string;
  since: number;
}

/** A RegressedFixCandidate whose quoted test actually failed again: the candidate plus the last
 * matching failure event (its ts and text). */
export interface RegressedFix extends RegressedFixCandidate {
  newest: { ts: number; text: string };
}

/** Regressed fixes — a newest-10 BUGS.md Fixed record whose heading quotes a test name that a
 * gate or merge check has failed on since the day after its fix, unless an Open bug already
 * quotes the same test. A warn, never a fail, and doctor writes nothing to BUGS.md. */
export function checkRegressedFixes(root: string): CheckOutcome {
  const doc = readBacklogChecked(root, "BUGS.md");
  if (typeof doc !== "string") return doc;
  const candidates = regressedFixCandidates(root);
  if (candidates.length > 0) {
    const { events } = readEventsSince(root, sinceWindowMs(candidates.map((c) => c.since)));
    const phrase = regressedFixesPhrase(matchedRegressedFixes(candidates, events));
    if (phrase !== null) return warnOutcome(phrase);
  }
  return okOutcome("no recently Fixed bug's quoted test has failed since its fix");
}

/** Refused entries — planned plans and open bugs held by a **Refused …** note. No role clears
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
      const mergeDone = prerequisitesMerged(entry.title, parts);
      const waiting = file === "PLANS.md" ? plansWaitingOn(planned, index).length : 0;
      return [{ file, command, position: index + 1, title: entry.title, note, mergeDone, waiting }];
    }));
  const [first, ...rest] = held;
  if (!first) return okOutcome("no planned plan or open bug is held by a Refused note");
  const more = andMore(rest, (e) =>
    `${e.file} ${e.command} #${e.position} "${truncate(e.title, FIX_CLAIM_HEADING_MAX)}"` +
    (e.mergeDone.length > 0 ? " [prerequisites no longer planned]" : "") +
    (e.waiting > 0 ? ` [${e.waiting} part(s) wait on it]` : ""));
  const stale = first.mergeDone.length > 0
    ? `; its prerequisite(s) ${first.mergeDone.map((r) => `${r.series} ${r.part}/${r.of}`).join(", ")} are no longer planned, so the refusal may be stale`
    : "";
  const waiting = first.waiting > 0
    ? `; ${first.waiting} planned part(s) wait on it, directly or through an earlier part`
    : "";
  return warnOutcome(`${first.file} ${first.command} #${first.position} "${first.title}" is held by a Refused note ` +
      `(${truncate(first.note, REFUSAL_NOTE_MAX)})${stale}${waiting}${more} — no role takes a refused entry until it is edited: ` +
      `answer the objection and release the entry with \`tumwater ${first.command} --release ${first.position}\`, ` +
      `or retract it with \`tumwater ${first.command} --cancel ${first.position}\``);
}
