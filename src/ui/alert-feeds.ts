import { openBugEntries, openQuestionEntries, filingDate, ageInDays } from "../backlog/backlog.js";
import { refusalNote, waitingNote } from "../backlog/backlog-eligibility.js";
import { stripEntryStamp } from "../backlog/backlog-structure.js";
import { questionFilingDate } from "../backlog/question-answer.js";
import { byDaysThenIndex } from "../collections.js";
import { eventsSince } from "../events/event-window.js";
import type { HarnessEvent } from "../events/events.js";
import { isNotifyFailure } from "../events/notify.js";
import { staleQueuedPromptRows, staleQueuedMergeRows, skippedMergeQueueFiles, atRiskPostReviews, atRiskPostReviewsPhrase, STALE_BUG_DAYS, STALE_QUESTION_DAYS } from "../doctor/doctor-backlog.js";
import { staleWaitingBugRows, regressedFixCandidates, matchedRegressedFixes, regressedFixesPhrase, type RegressedFix, type RegressedFixCandidate } from "../doctor/doctor-backlog-bugs.js";
import { planDependencyProblem } from "../doctor/doctor-backlog-plans.js";
import { checkWaitContention, providerWaitContention, slotWaitContention, staleWorkspacePins, CHECK_WAIT_CHECK_WINDOW_MS, PROVIDER_WAIT_CHECK_WINDOW_MS, SLOT_WAIT_CHECK_WINDOW_MS, type WaitContention } from "../doctor/doctor-contention-checks.js";
import { NOTIFY_CHECK_WINDOW_MS } from "../doctor/doctor-notify.js";
import { flappedChecksPhrase } from "../doctor/doctor-project-checks.js";
import { readSlotsState } from "../git/slots-state.js";
import { readQaCoverage, qaCoverageStalled } from "../run/qa-coverage.js";
import { postMergeChurn, POST_MERGE_REJECT_WINDOW_MS, type PostMergeRejection } from "../review/post-merge-review.js";
import { KNOWN_FLAKE_WINDOW_MS, loadQuarantine, repeatedFlakeCounts } from "../review/known-flakes.js";
import { quarantineWarning } from "../baseline/main-guardrails.js";
import { configForStatus } from "../status/status-polls.js";
import type { FlappedChecks, NotifyFailure, PlanDependencyProblem, PrimaryOverwriteBlock, QuarantinedTests, StaleBug, StaleMerge, StalePrompt, StaleQuestion, StaleWaitingBug } from "./team-alerts.js";

/** This module is the alert-feed half of src/ui/status-payload.ts: each always-on team alert's
 * data-sourcing function (staleOpenBugs, notifyFailures, capacityContention, …) lives here, a
 * sibling of the src/ui/team-alerts.ts builder that turns them into banners. status-payload.ts
 * stays the one status-document builder, importing these feeds and folding each feed's result
 * into the `alerts` field; status-render.ts reads the feeds directly for the TUI. */
/** The open bugs the doctor's 3-day rule (src/doctor/doctor-backlog-bugs.ts checkStaleBugs,
 * STALE_BUG_DAYS) calls stale: an unrefused, non-waiting open bug whose filing stamp is at
 * least STALE_BUG_DAYS old. This is the always-on feed for the stale-bugs team alert — the
 * doctor's check is the same rule at the same threshold, so the two cannot drift. An entry
 * carrying a Refused note or a Waiting-for-the-next-failure note is skipped (the refused and
 * waiting alerts name those), and so is an undated heading (like the doctor's check). The
 * returned objects carry the 0-based index (for the drawer address `bugs:<index>`), the
 * 1-based position (for `bug --cancel <position>`), the stamp-stripped title, and the whole-
 * day age. Returned oldest-first — most days waited, ties in file order — so a caller naming
 * the first element names the most-stale bug. */
export function staleOpenBugs(root: string, now = Date.now()): StaleBug[] {
  return openBugEntries(root)
    .flatMap((entry, index) => {
      if (refusalNote(entry.body) !== null || waitingNote(entry.body) !== null) return [];
      const stamp = filingDate(entry.title);
      if (stamp === null) return [];
      const days = ageInDays(stamp, now);
      return days >= STALE_BUG_DAYS ? [{ index, position: index + 1, title: stripEntryStamp(entry.title), days }] : [];
    })
    .sort(byDaysThenIndex);
}

/** The open questions the doctor's 7-day rule (src/doctor/doctor-backlog-bugs.ts
 * checkStaleQuestions, STALE_QUESTION_DAYS) calls stale: an open QUESTIONS.md entry whose
 * `(asked by …)` stamp is at least 7 days old. This is the always-on feed for the stale-questions
 * team alert — the shared rule's twin on every observer surface, computed from the same threshold
 * and the same questionFilingDate parser the doctor's check uses, so the two cannot drift on which
 * questions are stale. An undated heading is skipped (like the doctor's check); questions carry no
 * refused or waiting note to filter. The returned objects carry the 1-based position (for
 * `tumwater questions answer <n>`), the 0-based index (kept only as the file-order tiebreak), the
 * stamp-stripped title, and the whole-day age. Returned oldest-first — most days waited, ties in
 * file order — so a caller naming the first element names the most-stale question. */
export function staleOpenQuestions(root: string, now = Date.now()): StaleQuestion[] {
  return openQuestionEntries(root)
    .flatMap((entry, index) => {
      const stamp = questionFilingDate(entry.title);
      if (stamp === null) return [];
      const days = ageInDays(stamp, now);
      return days >= STALE_QUESTION_DAYS ? [{ index, position: index + 1, title: stripEntryStamp(entry.title), days }] : [];
    })
    .sort(byDaysThenIndex);
}

/** The notify pages the doctor's 1-day rule (src/doctor/doctor-notify.ts checkNotify,
 * NOTIFY_CHECK_WINDOW_MS) calls failed — warning events within the last day that isNotifyFailure
 * recognizes (a nonzero exit, a kill, or a failed start). This is the always-on feed for the
 * notify team alert, sharing the doctor's threshold, window and filter, so the alert and the
 * check cannot drift. null when the window holds no failed page. */
export function notifyFailures(root: string, now = Date.now()): NotifyFailure | null {
  const failures = eventsSince(root, NOTIFY_CHECK_WINDOW_MS, now, isNotifyFailure);
  const latest = failures[failures.length - 1];
  return latest ? { count: failures.length, latestTs: latest.ts, message: String(latest.message) } : null;
}

/** The queued inbox prompts the doctor's stale-prompt rule (src/doctor/doctor-backlog.ts
 * `staleQueuedPromptRows`, STALE_PROMPT_MS) calls stale: a prompt due-but-undelivered for more
 * than a day. This is the always-on feed for the stale-prompts team alert — the doctor's check
 * reads the same shared traversal and threshold, so the two cannot drift. A deferred prompt
 * (its not-before time still in the future) is never stale, and neither is a prompt at or under
 * the threshold (strictly past STALE_PROMPT_MS). Each returned object carries the role, the
 * 1-based position (`prompt --cancel <n> --role <id>`), and the wait in ms. Returned
 * oldest-first (queuedAtMs ascending), so a caller naming the first element names the
 * longest-waiting prompt. */
export function stalePrompts(root: string, now = Date.now()): StalePrompt[] {
  return staleQueuedPromptRows(root, now).map((p) => ({ role: p.role, position: p.position, waitedMs: now - p.queuedAtMs }));
}

/** The queued merges the doctor's stale-merge rule (src/doctor/doctor-backlog.ts
 * `staleQueuedMergeRows`, MERGE_QUEUE_STALE_MS) calls stale: a change that has sat in the
 * merge queue more than 6 h without starting. This is the always-on feed for the stale-merges
 * team alert — the doctor's check reads the same shared traversal and threshold, so the two
 * cannot drift. Each returned object carries the role, the summary, and the wait in ms.
 * Returned oldest-first (queue-file order), so a caller naming the first element names the
 * longest-waiting merge. */
export function staleMerges(root: string, now = Date.now()): StaleMerge[] {
  return staleQueuedMergeRows(root, now).map((m) => ({ role: m.role, summary: m.summary, waitedMs: m.waitedMs }));
}

/** A broken plan-dependency clause, the always-on twin of the doctor's `plan dependencies` row
 * (src/doctor/doctor-backlog-plans.ts checkPlanDependencies): the same rule's problem set,
 * severity order, and exact message, so the alert and the doctor cannot drift. The reader owns
 * the rule — planDependencyAlert passes the doctor's planDependencyProblem through unchanged,
 * like staleOpenBugs and the other stale feeds do their doctor's rules. null when PLANS.md's
 * planned entries have no cycle, dangling ref, unparsed clause, or misworded dependency. */
export function planDependencyAlert(root: string): PlanDependencyProblem | null {
  return planDependencyProblem(root);
}

/** The open bugs a Waiting-for-the-next-failure note has held for STALE_WAIT_DAYS (7) or more —
 * the always-on feed for the waiting-bugs team alert, sharing the doctor's threshold, held-bug
 * selection and anchor through staleWaitingBugRows so the alert and `checkWaitingBugs` cannot
 * drift. The returned objects carry the 0-based index (drawer `bugs:<index>`), the 1-based
 * position (`bug --release <position>`), the stamp-stripped title, and the whole-day age.
 * Returned most-days-waited-first — ties in file order — so a caller naming the first element
 * names the longest-held bug. */
export function staleWaitingBugs(root: string, now = Date.now()): StaleWaitingBug[] {
  return staleWaitingBugRows(root, now);
}

/** The merge-queue files `readMergeQueue` skips as checkout-relative paths — the always-on feed
 * for the `skipped-merges` team alert (src/ui/team-alerts.ts), sharing the doctor's one list
 * (doctor-backlog.ts skippedMergeQueueFiles), so the alert and the doctor's `merge-queue files`
 * row cannot drift on the selection or the named paths. */
export function skippedMergeFiles(root: string): string[] {
  return skippedMergeQueueFiles(root);
}

/** The doctor's three `_wait` contention rows (src/doctor/doctor-contention-checks.ts
 * `slotWaitContention`/`providerWaitContention`/`checkWaitContention`) folded into one
 * always-on feed for the `contention` team alert (src/ui/team-alerts.ts): the standing twin of
 * the doctor's `workspaces`, `provider contention` and `check contention` rows, read off the
 * same `*_wait` events and the same ten-minute thresholds the doctor sums, so the alert and
 * the doctor cannot drift on the trigger or the knob-raising advice. Reads each window with
 * `eventsSince` (a read error skips that row, exactly like the doctor's own read-error arms),
 * sizing the slot row with readSlotsState's slot count and the provider/check rows with the
 * same last-known-good config the snapshot uses (configForStatus). One entry per row whose
 * window crosses its threshold, `[]` when none does. */
export interface CapacityBottleneck {
  name: string;
  detail: string;
}
/** @see CapacityBottleneck */
export function capacityContention(root: string, now = Date.now()): CapacityBottleneck[] {
  const out: CapacityBottleneck[] = [];
  /** Resolve one capacity verdict and push a "capacity bottleneck" row when it warns. Shared
   * by the three capacity checks (workspace, provider, check slots) so the try/catch that keeps
   * each one from crying wolf on an unreadable event log lives in one place, and the row's
   * `name`/`detail` shape cannot drift between them. */
  const maybeWarn = (
    name: string,
    windowMs: number,
    keep: (ev: HarnessEvent) => boolean,
    resolve: (waits: readonly HarnessEvent[]) => WaitContention,
  ): void => {
    try {
      const verdict = resolve(eventsSince(root, windowMs, now, keep));
      if (verdict.warn) out.push({ name, detail: verdict.detail });
    } catch {
      // A read error skips this row, so the alert never cries wolf on an unreadable log.
    }
  };
  maybeWarn("workspace slots", SLOT_WAIT_CHECK_WINDOW_MS, (ev) => ev.type === "slot_wait", (waits) => slotWaitContention(waits, readSlotsState(root).slots.length));
  maybeWarn("provider slots", PROVIDER_WAIT_CHECK_WINDOW_MS, (ev) => ev.type === "provider_wait", (waits) => providerWaitContention(waits, configForStatus(root)));
  maybeWarn("check slots", CHECK_WAIT_CHECK_WINDOW_MS, (e) => e.type === "check_wait", (waits) => checkWaitContention(waits, configForStatus(root)));
  return out;
}

/** How far back the primary-overwrite alert looks — one day, so a team stuck retrying one
 * dirty primary file is a standing amber banner until the file is committed and the refusals
 * age out. */
export const PRIMARY_OVERWRITE_WINDOW_MS = 24 * 60 * 60_000;
/** How far back the dropped-post-review alert looks — one day, the 24 h event-window convention
 * every event-reading alert uses (PRIMARY_OVERWRITE_WINDOW_MS sorts beside it), so a review the
 * drain dropped stays a standing amber notice until a day passes. */
export const DROPPED_POST_REVIEW_WINDOW_MS = 24 * 60 * 60_000;
/** How far back the regressed-fixes alert looks — one day, so a recently Fixed test that failed
 * again is a standing amber alert until a day passes (or the failure is filed). The doctor's
 * own `regressed fixes` row keeps its since-the-fix read; this is the alert's daily trigger, the
 * same trailing day the primary-overwrite and notify alerts read. */
export const REGRESSED_FIX_WINDOW_MS = 24 * 60 * 60_000;
/** A Fixed record whose quoted test failed again in the trailing day — the always-on feed for the
 * `regressed-fixes` team alert (src/ui/team-alerts.ts), carrying the doctor's own sentence
 * (regressedFixesPhrase) so the alert and the `regressed fixes` row cannot drift on the wording.
 * null when no Fixed record's quoted test failed in the window. */
export interface RegressedFixAlert {
  count: number;
  detail: string;
}
/** The always-on twin of the doctor's `regressed fixes` row (src/doctor/doctor-backlog-bugs.ts
 * checkRegressedFixes): the same candidate selection (regressedFixCandidates) and the same
 * failureMentions match (matchedRegressedFixes) and sentence (regressedFixesPhrase), read off the
 * trailing REGRESSED_FIX_WINDOW_MS of events (the doctor, whose window is since each fix, still
 * warns on an older recurrence). An unreadable event log yields none. */
export function regressedFixesAlert(root: string, now = Date.now()): RegressedFixAlert | null {
  const candidates: RegressedFixCandidate[] = regressedFixCandidates(root);
  const rows: RegressedFix[] = matchedRegressedFixes(candidates, eventsSince(root, REGRESSED_FIX_WINDOW_MS, now));
  const detail = regressedFixesPhrase(rows);
  return detail === null ? null : { count: rows.length, detail };
}
/** The exact substring merge-git.ts's overwrite blocker logs in its `warning` event, so this
 * feed matches the refusal and nothing the merge path does not say (see merge-git.ts
 * `overwriteBlockedReason`). */
const PRIMARY_OVERWRITE_MARKER = "would overwrite files in the primary checkout";
/** The merges the primary checkout refused in the trailing day (src/merge/merge-git.ts
 * `primaryCheckoutBlockers`, `overwriteBlockedReason`) — the always-on feed for the
 * `primary-overwrite` team alert (src/ui/team-alerts.ts). It reads only the `warning` event the
 * merge path already writes, so it reaches the status poll without a git read (the doctor's
 * `uncommitted backlog` check's git read is async and never gets there) and cannot drift from
 * the refusals. null when the window holds no such warning. */
export function primaryOverwriteBlocks(root: string, now = Date.now()): PrimaryOverwriteBlock | null {
  const hits = eventsSince(root, PRIMARY_OVERWRITE_WINDOW_MS, now, (e) => e.type === "warning" && typeof e.message === "string" && e.message.includes(PRIMARY_OVERWRITE_MARKER));
  const latest = hits[hits.length - 1];
  return latest ? { count: hits.length, latestTs: latest.ts, message: String(latest.message) } : null;
}

/** Re-export so the always-on alert's threshold and window stay in their one home
 * (src/review/post-merge-review.ts) while status-payload.ts and test/status-payload.test.ts keep
 * reading it from this module. */
export { POST_MERGE_REJECT_WINDOW_MS };
/** Re-export so the always-on alert's stale-pin selector stays in its one home
 * (src/doctor/doctor-contention-checks.ts) while tui.tsx keeps importing every alert feed from
 * this one module. */
export { staleWorkspacePins };
/** A trailing day of at least `POST_MERGE_REJECT_WARN` post-merge `review_rejected` events:
 * which already-landed commits were turned back, and by how many per role. count is the total
 * rejections in the window, roles each role's per-role total (count-desc, role-asc). */
export interface PostMergeChurn {
  count: number;
  roles: readonly PostMergeRejection[];
}
/** The always-on feed for the `post-merge-churn` team alert (src/ui/team-alerts.ts): a day in
 * which at least `POST_MERGE_REJECT_WARN` already-merged commits were turned back by post-merge
 * review, each rejection written by reviewMergedCommit as a `review_rejected` event with
 * `afterMerge: true`. Post-merge is the costly kind — the commit already reached main, so a
 * rejection is answered only by the reviewer's own fix — and it is the reviewer-fix signal for
 * the `review.afterMerge` tiering. Reads the same
 * events the report's `postMergeRejectionsByRole` fills, so the two cannot disagree; null when
 * the window holds fewer than `POST_MERGE_REJECT_WARN` post-merge rejections, or none. A read
 * error skips the row (the capacityContention precedent). */
export function postMergeChurnAlert(root: string, now = Date.now()): PostMergeChurn | null {
  try {
    const events = eventsSince(root, POST_MERGE_REJECT_WINDOW_MS, now, (e) => e.type === "review_rejected");
    return postMergeChurn(events);
  } catch {
    // A read error skips the row, so the alert never cries wolf on an unreadable log.
    return null;
  }
}

/** A stale or oversized flake quarantine, the always-on twin of the doctor's `flaky checks` row
 * (src/doctor/doctor-project-checks.ts checkFlakyChecks): the same quarantineWarning the doctor
 * calls over the same loadQuarantine list, so the alert and the doctor cannot drift on when the
 * list is a problem. null when the list is fresh and small (or absent) — the rule fires only
 * over QUARANTINE_WARN_COUNT tests or one first seen more than QUARANTINE_AGE_MS ago. */
export function quarantineAlert(root: string, now = Date.now()): QuarantinedTests | null {
  const entries = loadQuarantine(root);
  const warning = quarantineWarning(entries, now);
  if (warning === null) return null;
  const oldest = entries.reduce((a, b) => (b.firstSeen < a.firstSeen ? b : a));
  return { count: entries.length, oldestTest: oldest.test, oldestFirstSeen: oldest.firstSeen, warning };
}
/** Checks that flapped more than once in the doctor's window, the always-on twin of the doctor's
 * `flaky checks` row (src/doctor/doctor-project-checks.ts checkFlakyChecks): the same
 * repeatedFlakeCounts over the same KNOWN_FLAKE_WINDOW_MS event window and the same
 * flappedChecksPhrase the doctor shows, so the alert and the doctor cannot drift on the count or
 * the wording. null when no check flapped twice in the window (or the log is unreadable). */
export function flappedChecksAlert(root: string, now = Date.now()): FlappedChecks | null {
  const events = eventsSince(root, KNOWN_FLAKE_WINDOW_MS, now, (e) => e.type === "warning");
  const flapped = repeatedFlakeCounts(events);
  const detail = flappedChecksPhrase(flapped);
  return detail === null ? null : { count: flapped.length, detail };
}
/** A qa flow-coverage ledger whose newest exercise is over `QA_COVERAGE_STALE_MS` old — the
 * always-on twin of the doctor's `qa coverage` row (doctor-project-checks.ts checkQaCoverage):
 * read over the same qaCoverageStalled predicate, so the alert and the doctor cannot drift on
 * when a quiet qa is a problem. null when the ledger is fresh or empty — no record yet (a
 * missing file, or a project that never ran qa) is not a stall. `newestAt` is the newest
 * entry's `lastRunAt`, `count` the number of well-formed entries (the `quarantineAlert` shape). */
export interface QaCoverageStale {
  newestFlow: string;
  newestAt: number;
  count: number;
}

export function qaCoverageAlert(root: string, now = Date.now()): QaCoverageStale | null {
  const coverage = readQaCoverage(root);
  if (!qaCoverageStalled(coverage, now)) return null;
  const entries = Object.entries(coverage);
  let newestFlow = entries[0]![0];
  let newestAt = entries[0]![1].lastRunAt;
  for (const [name, entry] of entries) {
    if (entry.lastRunAt > newestAt) {
      newestAt = entry.lastRunAt;
      newestFlow = name;
    }
  }
  return { newestFlow, newestAt, count: entries.length };
}
/** A post-merge review one failed run from being dropped, the always-on twin of the doctor's
 * `post-merge reviews` row (src/doctor/doctor-backlog.ts checkPostReviews): the same
 * atRiskPostReviews traversal and atRiskPostReviewsPhrase the doctor shows, so the alert and the
 * doctor cannot drift on the selection or the wording. count is the at-risk reviews, detail the
 * doctor's sentence. null when no queued review is at risk (or the file is missing or torn —
 * readPostReviews never throws and the read is one small JSON file, so it is poll-cheap). */
export interface PostReviewRisk {
  count: number;
  detail: string;
}
/** @see PostReviewRisk */
export function postReviewRiskAlert(root: string): PostReviewRisk | null {
  const rows = atRiskPostReviews(root);
  const detail = atRiskPostReviewsPhrase(rows);
  return detail === null ? null : { count: rows.length, detail };
}
/** The exact substring the drain's drop branch logs in its `warning` event (src/merge/
 * merge-post-review.ts at POST_REVIEW_FAILURE_LIMIT), so this feed matches a real drop and not
 * the per-run `the post-merge review of <sha> failed (…)` warning the at-risk alert already
 * covers — alert-feeds.ts's DROPPED_POST_REVIEW_MARKER is the same string, so the feed and
 * the drain cannot drift on what a drop is. */
const DROPPED_POST_REVIEW_MARKER = "dropping the post-merge review of";
/** A post-merge review the drain dropped in the trailing day (src/merge/merge-post-review.ts
 * `startPostReview` at POST_REVIEW_FAILURE_LIMIT, src/review/post-merge-review.ts) — the commit
 * is permanently on main beyond the review gate with only this `warning` event to say so. count
 * is the drops in the window, latestTs the most recent one's event stamp, latestMessage its
 * squashed wording. */
export interface DroppedPostReviews {
  count: number;
  latestTs: number;
  latestMessage: string;
}
/** The always-on feed for the `dropped-post-reviews` team alert (src/ui/team-alerts.ts): reads
 * only the `warning` event the drain's drop branch already writes, so it reaches the status
 * poll without touching the review state and cannot drift from the drop. null when the day
 * holds no such warning. eventsSince degrades an unreadable log, so one bounded event scan
 * needs no try/catch (the primaryOverwriteBlocks precedent). */
export function droppedPostReviewsAlert(root: string, now = Date.now()): DroppedPostReviews | null {
  const hits = eventsSince(root, DROPPED_POST_REVIEW_WINDOW_MS, now, (e) => e.type === "warning" && typeof e.message === "string" && e.message.includes(DROPPED_POST_REVIEW_MARKER));
  const latest = hits[hits.length - 1];
  return latest ? { count: hits.length, latestTs: latest.ts, latestMessage: String(latest.message) } : null;
}
/** A main watch tip failing the review gate's five diff rules can sit on main for a day — this
 * is how far back the main-diff-rules alert looks, the same trailing-day convention every
 * event-reading alert uses. */
export const MAIN_RULE_FAILURE_WINDOW_MS = 24 * 60 * 60_000;
/** The exact substring main-watch.ts's `watchRules` logs in its warning, so this feed matches a
 * real rule failure and cannot drift from the wording the watch writes. */
const MAIN_RULE_FAILURE_MARKER = "fails the diff rules";
/** A main tip the watch's diff rules rejected in the trailing day. count is the distinct failing
 * tips in the window (the watch logs one warning per tip, not per poll), latestTs the most
 * recent one's event stamp, latestMessage its squashed wording. */
export interface MainRuleFailure {
  count: number;
  latestTs: number;
  latestMessage: string;
}
/** The always-on feed for the `main-diff-rules` team alert (src/ui/team-alerts.ts): reads only
 * the `warning` event the main watch already writes, so it reaches the status poll without a
 * git read or a rule re-run (the watch paid for the check) and cannot drift from the watch's
 * wording. null when the day holds no such warning. eventsSince degrades an unreadable log, so
 * one bounded event scan needs no try/catch (the primaryOverwriteBlocks precedent). */
export function mainRuleFailures(root: string, now = Date.now()): MainRuleFailure | null {
  const hits = eventsSince(root, MAIN_RULE_FAILURE_WINDOW_MS, now, (e) => e.type === "warning" && typeof e.message === "string" && e.message.includes(MAIN_RULE_FAILURE_MARKER));
  const latest = hits[hits.length - 1];
  return latest ? { count: hits.length, latestTs: latest.ts, latestMessage: String(latest.message) } : null;
}
