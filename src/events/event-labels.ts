/** Words for the two code families the dashboards show: event types (the activity chips) and run
 * result codes (the result cells). Pure, no I/O, so core modules and the UI may both import it. */

import type { HarnessEvent } from "./events.js";
import type { RunResult } from "../run/run-outcome.js";

/** The words for each event type. The `Record` type makes the compiler demand a label for every
 * type in the union, so a new event type cannot ship without one; renaming a type renames its key
 * here and leaves the label unchanged. A label is a lowercase phrase of a few words, never the
 * code itself. */
export const EVENT_TYPE_LABELS: Readonly<Record<HarnessEvent["type"], string>> = {
  run_start: "run started",
  run_end: "run finished",
  merge_queued: "waiting to merge",
  merge_cancelled: "merge cancelled",
  merge_topped: "merge moved to front",
  merge_done: "merge finished",
  merge_failed: "merge failed",
  merged: "merged",
  question_posted: "question posted",
  issue_filed: "issue filed",
  entry_refused: "plan refused",
  wake: "woke up",
  run_deferred: "run deferred",
  orchestrator_start: "tumwater started",
  orchestrator_stop: "tumwater stopped",
  prompt_enqueued: "message queued",
  prompt_cancelled: "message cancelled",
  prompt_edited: "message edited",
  prompt_topped: "message moved to front",
  prompt_taken: "message picked up",
  counters_reset: "counters reset",
  run_aborted: "run stopped by you",
  resume: "run resumed",
  review_start: "review started",
  review_verdict: "review approved",
  review_rejected: "review rejected",
  review_failed: "review failed",
  revision: "revision round",
  conflict_handback: "sent back to resolve",
  build_check: "check ran",
  dep_install: "dependencies installed",
  budget_warning: "budget warning",
  budget_paused: "budget paused",
  budget_fallback: "over-cap model",
  budget_resumed: "budget resumed",
  budget_handback: "returned to main model",
  fallback_switched: "fallback switched",
  team_paused: "team paused",
  team_resumed: "team resumed",
  state_migrated: "state migrated",
  role_paused: "role paused",
  role_resumed: "role resumed",
  role_streak_paused: "repeated-failure pause",
  role_cap_warning: "role budget warning",
  role_cap_paused: "role budget paused",
  role_cap_resumed: "role budget resumed",
  main_check: "main checked",
  main_culprit: "main red culprit",
  operator_revert: "operator revert", // vocabulary-ok: "operator" is the operator-role name this label's plan chose
  main_red_hold: "main's check is failing",
  maintenance_quota_hold: "waiting: maintenance allowance used",
  maintenance_quota_resumed: "maintenance allowance reopened",
  bootstrap_complete: "bootstrap complete",
  quiet_hours_started: "quiet hours started",
  quiet_hours_ended: "quiet hours ended",
  disk_low: "waiting: low disk",
  disk_ok: "disk space restored",
  disk_reclaim: "disk space reclaimed",
  claim: "entry claimed",
  permit_reserve: "permits reserved",
  slot_wait: "waited to start",
  provider_wait: "waited for a provider slot",
  check_wait: "waited for a check slot",
  rate_limit_hold: "waiting: provider limit",
  rate_limit_resumed: "provider limit lifted",
  subscription_window_reserved: "usage window reserved",
  subscription_window_warning: "usage window warning",
  subscription_window_limited: "waiting: usage window",
  subscription_window_reset: "usage window reset",
  max_concurrent_changed: "concurrency changed",
  retention_changed: "retention changed",
  config_changed: "settings changed",
  model_changed: "model changed",
  backend_binary: "backend checked",
  opencode_free_model_billed: "free model billed",
  image_blind: "image not seen",
  build_stale: "update available",
  restart_pending: "update waits for idle",
  restart: "restarted onto update",
  restart_refused: "update refused",
  restart_blocked: "update blocked",
  restart_forced: "update forced",
  supervisor_exit: "tumwater exited",
  warning: "warning",
};

/** The words for each run result code, shown in the result cells. */
export const RUN_RESULT_LABELS: Readonly<Record<RunResult, string>> = {
  changed: "merged",
  queued: "waiting to merge",
  no_change: "no change",
  skipped: "skipped",
  refused: "refused",
  rejected: "rejected in review",
  review_error: "review failed",
  merge_conflict: "merge conflict",
  merge_blocked: "merge blocked",
  error: "error",
  aborted: "interrupted",
  quiet_killed: "stalled, resumed",
  user_aborted: "stopped by you",
  main_red: "main's check is failing",
};

/** The words for an event type or run result code: its own-property label, else the code with
 * underscores as spaces. The two code families are disjoint, so one lookup serves both. */
export function eventTypeLabel(code: string): string {
  if (Object.hasOwn(EVENT_TYPE_LABELS, code)) return EVENT_TYPE_LABELS[code as HarnessEvent["type"]];
  if (Object.hasOwn(RUN_RESULT_LABELS, code)) return RUN_RESULT_LABELS[code as RunResult];
  return code.replace(/_/g, " ");
}
