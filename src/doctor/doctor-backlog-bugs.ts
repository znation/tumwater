import { andMore, quoteHeading, readBacklogChecked, FIX_CLAIMS_CHECKED, REFUSAL_NOTE_MAX, STALE_QUESTION_DAYS, STALE_BUG_DAYS } from "./doctor-backlog.js";
import { truncate } from "../text/text.js";
import { plural, agree } from "../text/phrases.js";
import { ageInDays, filingDate, fixedBugEntries, openBugEntries, openQuestionEntries, plannedPlanEntries } from "../backlog/backlog.js";
import { questionFilingDate } from "../backlog/backlog-question-answer.js";
import { needsReviewNote, refusalNote } from "../backlog/backlog-eligibility.js";
import { plannedPartKeys, plansWaitingOn, prerequisitesMerged } from "../backlog/backlog-parts.js";
import { lastDate } from "../backlog/backlog-md.js";
import { formatTimestamp } from "../text/datetime.js";
import { stringList } from "../files/json-object.js";
import { readEventsSince } from "../events/event-window.js";
import type { HarnessEvent } from "../events/events.js";
import { type CheckOutcome, okOutcome, warnOutcome } from "./outcome.js";

/** The doctor's open-bug and question checks, split out of doctor-backlog.ts: questions that
 * have waited too long for an answer (checkStaleQuestions), bugs left unfixed (checkStaleBugs),
 * fixed records whose quoted test regressed (checkRegressedFixes), and
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
 * the checkStalledEntries/checkRefusedEntries precedent: a question awaiting a human is
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
  const more = andMore(rest, (q) => quoteHeading(q.title));
  return warnOutcome(`QUESTIONS.md question ${quoteHeading(first.title)} has waited ${first.days} d for an answer${more} — ` +
      `a question that waits too long for a human answer is worth your attention`);
}

/** Stale bugs — unrefused, unheld open BUGS.md bugs whose `(found by … YYYY-MM-DD)` or
 * `(reported …)` stamp is at least 3 days old. The bugfix role fixes a bug within hours, so one
 * that sits means no role is fixing it. Positions are the 1-based `bug --list` numbers; a refused
 * bug is skipped (checkRefusedEntries names it), a bug parked by a Needs-review note is skipped
 * (the note names what would make it fail, so it is not unfixed), and so is an undated heading.
 * A warn, never a fail. */
export function checkStaleBugs(root: string): CheckOutcome {
  const doc = readBacklogChecked(root, "BUGS.md");
  if (typeof doc !== "string") return doc;
  const stale = openBugEntries(root).flatMap((entry, index) => {
    if (refusalNote(entry.body) !== null || needsReviewNote(entry.body) !== null) return [];
    const stamp = filingDate(entry.title);
    if (stamp === null) return [];
    const days = ageInDays(stamp);
    return days >= STALE_BUG_DAYS ? [{ position: index + 1, title: entry.title, days }] : [];
  });
  const [first, ...rest] = stale;
  if (!first) return okOutcome("no open bug has waited more than 3 days for a fix");
  const more = andMore(rest, (b) => `#${b.position} ${quoteHeading(b.title)}`);
  return warnOutcome(`BUGS.md bug #${first.position} ${quoteHeading(first.title)} has waited ${first.days} d for a fix${more} — ` +
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
 * its boundary?" step, shared by the regressed-fix match (matchedRegressedFixes), so both
 * keep the same last-mention rule. */
function lastFailureMention(events: readonly HarnessEvent[], name: string, sinceMs: number): { ts: number; text: string } | undefined {
  const mentions = failureMentions(events, name, sinceMs);
  return mentions[mentions.length - 1];
}

/** The read-events window (ms) that reaches the oldest of `sinces` — `Date.now()` minus the
 * oldest timestamp, floored at 0 — so a recurrence check reads events past every candidate's
 * `since`. The single home of the "oldest of a set of since-times" step, shared by
 * checkRegressedFixes, so those sites cannot drift on the clamp or the
 * time base. */
function sinceWindowMs(sinces: readonly number[]): number {
  return Math.max(0, Date.now() - Math.min(...sinces));
}

/** The regression candidates for the `regressed fixes` feed: a newest-FIX_CLAIMS_CHECKED BUGS.md
 * Fixed record whose heading quotes a test name and carries a `YYYY-MM-DD` date, unless an Open
 * bug already quotes the same test (which means the regression is filed). Shared by the doctor's
 * `regressed fixes` row (checkRegressedFixes) and the always-on regressed-fixes alert, so the two
 * cannot drift on the selection. `since` is the day-after the fix date — the recurrence scan's
 * boundary (the heading carries only a date, so a same-day failure cannot be told from the one
 * the fix answered). Returns `[]` when no candidate has both a quoted test and a date. */
function regressedFixCandidates(root: string): RegressedFixCandidate[] {
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
function matchedRegressedFixes(
  candidates: readonly RegressedFixCandidate[],
  events: readonly HarnessEvent[],
): RegressedFix[] {
  return candidates.flatMap((c) => {
    const newest = lastFailureMention(events, c.name, c.since);
    return newest ? [{ ...c, newest }] : [];
  });
}

/** The doctor's `regressed fixes` warn sentence, verbatim, or null when nothing regressed. */
function regressedFixesPhrase(regressed: readonly RegressedFix[]): string | null {
  const [first, ...rest] = regressed;
  if (!first) return null;
  const more = andMore(rest, (c) => quoteHeading(c.title));
  return `BUGS.md Fixed record ${quoteHeading(first.title)} quotes a test that failed again after its ${first.date} fix ` +
    `(${formatTimestamp(first.newest.ts)}: ${truncate(first.newest.text, REFUSAL_NOTE_MAX)})${more} — ` +
    "file it as a new bug with `tumwater bug`, quoting the test name and citing the Fixed record";
}

/** A Fixed record whose heading quotes a test name and carries a `YYYY-MM-DD` fix date — one
 * regressed-fix candidate that is not already filed as an Open bug. */
interface RegressedFixCandidate {
  title: string;
  name: string;
  date: string;
  since: number;
}

/** A RegressedFixCandidate whose quoted test actually failed again: the candidate plus the last
 * matching failure event (its ts and text). */
interface RegressedFix extends RegressedFixCandidate {
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
    `${e.file} ${e.command} #${e.position} ${quoteHeading(e.title)}` +
    (e.mergeDone.length > 0 ? " [prerequisites no longer planned]" : "") +
    (e.waiting > 0 ? ` [${plural(e.waiting, "part waits on it", "parts wait on it")}]` : ""));
  const stale = first.mergeDone.length > 0
    ? `; its ${agree(first.mergeDone.length, "prerequisite", "prerequisites")} ${first.mergeDone.map((r) => `${r.series} ${r.part}/${r.of}`).join(", ")} ${agree(first.mergeDone.length, "is", "are")} no longer planned, so the refusal may be stale`
    : "";
  const waiting = first.waiting > 0
    ? `; ${plural(first.waiting, "planned part waits on it", "planned parts wait on it")}, directly or through an earlier part`
    : "";
  return warnOutcome(`${first.file} ${first.command} #${first.position} "${first.title}" is held by a Refused note ` +
      `(${truncate(first.note, REFUSAL_NOTE_MAX)})${stale}${waiting}${more} — no role takes a refused entry until it is edited: ` +
      `answer the objection and release the entry with \`tumwater ${first.command} --release ${first.position}\`, ` +
      `or retract it with \`tumwater ${first.command} --cancel ${first.position}\``);
}
