/** One event as a single human one-liner for the terminal and dashboard event feed: the local
 * timestamp, the role padded to a column, then the event's message. Presentation only — it
 * depends on the event shape (events.ts's HarnessEvent), never on the event log's I/O.
 *
 * The per-event *line* builders live in the sibling <family> modules — event-format-run.ts,
 * -merge.ts, -review.ts, -inbox.ts, -budget.ts, -hold.ts, -resource.ts, -config.ts,
 * -image-restart.ts, -check-wait.ts and -warning.ts — each exporting its <family>EventMessage
 * dispatcher; the EVENT_MESSAGE_FAMILY table routes each event type to its family. The shared
 * presentation fragments those families render through — the usage, elapsed, disk, window,
 * backend and provider phrases and the event's outcome / deferral-text accessors — live in
 * event-format-fragments.ts, beside this dispatcher, so no family re-declares a fragment and
 * this module keeps its public accessors by re-exporting them from there. */
import { type HarnessEvent, TUMWATER_SOURCE } from "./events.js";
import { usageText, gigabytes, untilClockSuffix, windowSuffix, windowResetPhrase, backendLabel, eventResult, outcomeText, deferredReasonText } from "./event-format-fragments.js";
import { eventRole } from "./event-read.js";
import { roleLabel } from "../roles/role-labels.js";
import { padToWidth } from "../text/text-width.js";
import { textOr } from "../text/text.js";
import { formatTimestamp } from "../text/datetime.js";
import { runEventMessage } from "./event-format-run.js";
import { mergeEventMessage } from "./event-format-merge.js";
import { reviewEventMessage } from "./event-format-review.js";
import { inboxEventMessage } from "./event-format-inbox.js";
import { budgetEventMessage } from "./event-format-budget.js";
import { holdEventMessage } from "./event-format-hold.js";
import { resourceEventMessage } from "./event-format-resource.js";
import { configEventMessage } from "./event-format-config.js";
import { imageRestartEventMessage } from "./event-format-image-restart.js";
import { checkWaitEventMessage } from "./event-format-check-wait.js";
import { warningEventMessage } from "./event-format-warning.js";
export { usageText, gigabytes, untilClockSuffix, windowSuffix, windowResetPhrase, backendLabel, eventResult, outcomeText, deferredReasonText };

export function formatEvent(e: HarnessEvent): string {
  const time = formatTimestamp(e.ts);
  // Padded in terminal display columns (padToWidth), not String#padEnd's UTF-16 code units:
  // a custom role name holding a wide character (CJK, emoji) counts one code unit but two
  // display columns, so a padEnd cell rendered wider than its column and the message column
  // sat right of every ASCII row's (the same unit mistake the aligned tables shed). The role
  // itself goes through eventRole, so a torn or hand-edited event with no role shows "?" like
  // the usage report and failure digest, never String(undefined)'s literal "undefined".
  const source = eventRole(e);
  const roleCell = padToWidth(source === TUMWATER_SOURCE ? "tumwater" : roleLabel(source), 10);
  return `${time} ${roleCell} ${eventMessage(e)}`;
}

/** One event as the dashboard's activity feed consumes it: `result` is a run's outcome, a
 * merge's result, or a build check's status — whichever string the event carries. The event
 * layer owns the event shape's projection, so both the status poll (ui/status-payload.ts) and
 * the slice endpoint (gui/gui-history-endpoints.ts's handleLogs) read the same fields, and a feed
 * row's shape cannot drift between them. */
export function eventFeedItem(e: HarnessEvent): { ts: number; source: string; type: string; result?: string; message: string } {
  const result = eventResult(e);
  // eventRole renders a missing/empty role as "?" like the reports, so a torn or hand-edited
  // event never shows a literal "undefined" role chip in the dashboard's activity feed.
  return { ts: e.ts, source: eventRole(e), type: e.type, ...(result === undefined ? {} : { result }), message: eventMessage(e) };
}

/** The feed's `--grep`/Search match rule: case-insensitive substring over the raw event type
 * prefixed to the rendered line — exactly the haystack the operator would otherwise read. One
 * home shared by the CLI's `tumwater logs --grep` (cli/cli-log-commands.ts) and the dashboard's
 * /api/logs search, so the two surfaces cannot disagree about what a pattern matches. */
export function eventMatchesGrep(e: HarnessEvent, patternLower: string): boolean {
  return `${e.type} ${formatEvent(e)}`.toLowerCase().includes(patternLower);
}


type EventMessageFamily = (e: HarnessEvent) => string;

/** The event-to-family dispatch, typed by the union so a newly added event type is a compile
 * error until it is routed: each key maps to the <family>EventMessage builder that builds its
 * line (runEventMessage, mergeEventMessage, reviewEventMessage, inboxEventMessage,
 * budgetEventMessage, holdEventMessage, resourceEventMessage, configEventMessage,
 * imageRestartEventMessage, checkWaitEventMessage, warningEventMessage), grouped by family.
 * This is the one home of the type-to-family routing that the event feed's dispatch reads. */
const EVENT_MESSAGE_FAMILY: Record<HarnessEvent["type"], EventMessageFamily> = {
  // run family (runEventMessage)
  run_start: runEventMessage, run_end: runEventMessage, run_deferred: runEventMessage, run_aborted: runEventMessage, resume: runEventMessage, wake: runEventMessage, counters_reset: runEventMessage, claim: runEventMessage, permit_reserve: runEventMessage,
  // merge family (mergeEventMessage)
  merged: mergeEventMessage, merge_queued: mergeEventMessage, merge_cancelled: mergeEventMessage, merge_topped: mergeEventMessage, merge_done: mergeEventMessage, merge_failed: mergeEventMessage, conflict_handback: mergeEventMessage, operator_revert: mergeEventMessage, main_check: mergeEventMessage, main_culprit: mergeEventMessage, main_red_hold: mergeEventMessage,
  // review family (reviewEventMessage)
  review_start: reviewEventMessage, review_verdict: reviewEventMessage, review_rejected: reviewEventMessage, review_failed: reviewEventMessage, revision: reviewEventMessage,
  // inbox family (inboxEventMessage)
  prompt_enqueued: inboxEventMessage, prompt_cancelled: inboxEventMessage, prompt_edited: inboxEventMessage, prompt_topped: inboxEventMessage, prompt_taken: inboxEventMessage, question_posted: inboxEventMessage, entry_refused: inboxEventMessage, issue_filed: inboxEventMessage, remote_ci_failed: inboxEventMessage,
  // budget family (budgetEventMessage)
  budget_warning: budgetEventMessage, budget_paused: budgetEventMessage, budget_fallback: budgetEventMessage, budget_resumed: budgetEventMessage, budget_handback: budgetEventMessage, fallback_switched: budgetEventMessage, opencode_free_model_billed: budgetEventMessage,
  // hold family (holdEventMessage)
  team_paused: holdEventMessage, team_resumed: holdEventMessage, role_paused: holdEventMessage, role_resumed: holdEventMessage, role_streak_paused: holdEventMessage, role_cap_warning: holdEventMessage, role_cap_paused: holdEventMessage, role_cap_resumed: holdEventMessage, maintenance_quota_hold: holdEventMessage, maintenance_quota_resumed: holdEventMessage, bootstrap_complete: holdEventMessage,
  // resource family (resourceEventMessage)
  disk_low: resourceEventMessage, disk_ok: resourceEventMessage, disk_reclaim: resourceEventMessage, quiet_hours_started: resourceEventMessage, quiet_hours_ended: resourceEventMessage, rate_limit_hold: resourceEventMessage, rate_limit_resumed: resourceEventMessage, subscription_window_limited: resourceEventMessage, subscription_window_reset: resourceEventMessage, model_check_passed: resourceEventMessage,
  // config family (configEventMessage)
  max_concurrent_changed: configEventMessage, retention_changed: configEventMessage, config_changed: configEventMessage, model_changed: configEventMessage, backend_binary: configEventMessage, state_migrated: configEventMessage, orchestrator_start: configEventMessage, orchestrator_stop: configEventMessage,
  // image/restart family (imageRestartEventMessage)
  image_blind: imageRestartEventMessage, image_reroute: imageRestartEventMessage, build_stale: imageRestartEventMessage, restart_pending: imageRestartEventMessage, restart: imageRestartEventMessage, restart_refused: imageRestartEventMessage, restart_blocked: imageRestartEventMessage, restart_forced: imageRestartEventMessage, supervisor_exit: imageRestartEventMessage,
  // check/wait family (checkWaitEventMessage)
  build_check: checkWaitEventMessage, dep_install: checkWaitEventMessage, slot_wait: checkWaitEventMessage, provider_wait: checkWaitEventMessage, check_wait: checkWaitEventMessage,
  // warning family (warningEventMessage)
  warning: warningEventMessage,
};

/** An event's message alone — formatEvent's line without the time and role columns. The GUI's
 * activity feed renders the time and role itself (relative ages, role chips), so the payload
 * ships this beside the event's type and role instead of making the page re-parse a line.
 * Dispatch only: the family table EVENT_MESSAGE_FAMILY routes the type to the <family>EventMessage
 * builder that builds its line, and an unrecognized type falls through to the "?" stand-in. */
export function eventMessage(e: HarnessEvent): string {
  // The table is the dispatch; a known type routes to its family's line builder. An
  // unrecognized type is normally a newer build's string and renders as-is; a torn or
  // hand-edited event object with no type at all must read the "?" stand-in, never
  // String(undefined)'s literal "undefined" (parseEventLine admits any JSON object), so an
  // own-property guard sends anything the table does not know to the fallback.
  const family = Object.hasOwn(EVENT_MESSAGE_FAMILY, e.type)
    ? EVENT_MESSAGE_FAMILY[e.type]
    : undefined;
  return family !== undefined ? family(e) : textOr(e.type);
}
