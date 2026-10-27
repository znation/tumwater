/** Wording half of the failure digest's Team state changes section: which transition event types
 * the digest replays and the bounded one-liner describing each. Split out of failure-data.ts (the
 * same seam build/build-check-events.ts split from build/build-check.ts) so the per-event-type
 * wording — which changes whenever the harness grows a new self-decision — stays apart from the
 * collection rules (clustering, window math, section cuts) in failure-data.ts. Every free string is
 * sliced here, so the digest's byte bound holds for any event shape; the render adds the timestamp
 * and a roleCell-sliced role, so no unbounded field reaches the page. */
import { truncateExample } from "./failure-cluster.js";
import { cutSplitsSurrogatePair, isNonBlankString } from "../text/text.js";
import { finiteNumber, isJsonObject, stringList } from "../files/json-object.js";
import type { HarnessEvent } from "../events/events.js";
import { orchestratorStopPhrase, backendKindPhrase, budgetPhrase, teamPausePhrase, teamResumePhrase, holdPhrase, plural, rolePausePhrase, roleResumePhrase, rolesPhrase, shortSpanPhrase, rendersAsBackendFailure, PAUSE_EXPIRED_SUFFIX } from "../text/phrases.js";

import { shortSha } from "../text/format.js";
import { deferredReasonText, untilClockSuffix, gigabytes, windowSuffix, windowResetPhrase, backendLabel } from "../events/event-format.js";
import { claudeUtilizationPct } from "../agent/claude/claude-account.js";

/** The transition events the digest replays: the decisions the harness made about itself (the
 * cap/team gates and the team hold, the error-streak breaker's pause, the role's own daily
 * cap, model fallbacks, live-config edits, self-hosted redeploys, need-based deferrals,
 * orchestrator lifecycle, and the gate holds/lifts that stop and restart work — low disk,
 * quiet hours, the maintenance allowance and the subscription-window reserve). Everything the
 * set omits is deliberately excluded and named in STATE_CHANGE_EXCLUDED_TYPES; the two sets
 * partition EVENT_TYPE_LABELS' keys, so a new event type must land in exactly one of them and
 * cannot ship unclassified. The wiring twins `fallback_switched` and `budget_handback` are the
 * run-side consequence of `budget_resumed` — the budget/window reopening that aborts in-flight
 * fallback runs so their next run continues on the primary. The rest are the evidence the
 * selfcheck role's load-bearing rule asks it to
 * judge — whether the harness's RESPONSE to a failure was wrong (plans/telemetry-role.md) —
 * so they sit beside the outcomes rather than being dropped. */
export const STATE_CHANGE_TYPES = new Set<string>([
  "budget_paused",
  "budget_fallback",
  "budget_resumed",
  "team_paused",
  "team_resumed",
  "role_paused",
  "role_resumed",
  "role_streak_paused",
  "role_cap_paused",
  "role_cap_resumed",
  "model_fallback_started",
  "model_fallback_ended",
  "rate_limit_hold",
  "rate_limit_resumed",
  "max_concurrent_changed",
  "retention_changed",
  "config_changed",
  "build_stale",
  "restart_pending",
  "restart",
  "restart_refused",
  "restart_blocked",
  "run_deferred",
  "orchestrator_start",
  "orchestrator_stop",
  "supervisor_exit",
  "disk_low",
  "disk_ok",
  "quiet_hours_started",
  "quiet_hours_ended",
  "maintenance_quota_hold",
  "maintenance_quota_resumed",
  "subscription_window_reserved",
  "subscription_window_limited",
  "subscription_window_reset",
  "provider_concurrency_changed",
  "model_changed",
  "bootstrap_complete",
  "fallback_switched",
  "budget_handback",
]);

/** The event types the digest deliberately does not replay, one per EVENT_TYPE_LABELS key that
 * is not a STATE_CHANGE_TYPES member. Together with STATE_CHANGE_TYPES it partitions
 * EVENT_TYPE_LABELS' keys, so a new event type must be classified in one set or the other — the
 * disjoint-and-covering commitment the digest's Team state changes section rests on. Grouped by
 * reason, one line per group (the run-outcome half, the per-run advisories and the observations
 * were named in the older comment; the state-adjacent group is newly listed). */
export const STATE_CHANGE_EXCLUDED_TYPES = new Set<string>([
  // Run, merge and main-watch outcomes and per-run bookkeeping.
  "run_start",
  "run_end",
  "merge_queued",
  "merge_cancelled",
  "merge_topped",
  "merge_done",
  "merge_failed",
  "merged",
  "counters_reset",
  "run_aborted",
  "resume",
  "wake",
  "operator_revert",
  "build_check",
  "dep_install",
  "budget_warning",
  "role_cap_warning",
  "main_check",
  "main_culprit",
  "main_red_hold",
  "warning",
  // Reviews and revisions.
  "review_start",
  "review_verdict",
  "review_rejected",
  "review_failed",
  "revision",
  "conflict_handback",
  // Inbox and backlog.
  "question_posted",
  "issue_filed",
  "entry_refused",
  "prompt_enqueued",
  "prompt_cancelled",
  "prompt_edited",
  "prompt_topped",
  "prompt_taken",
  // Per-run advisories and assignments.
  "claim",
  "permit_reserve",
  "slot_wait",
  "provider_wait",
  "check_wait",
  // Observations and actions.
  "disk_reclaim",
  "subscription_window_warning",
  "image_blind",
  // State-adjacent but not self-decisions.
  "state_migrated",
  "restart_forced",
  "backend_binary",
  "opencode_free_model_billed",
]);

/** The Team state changes section's caps: newest N transitions, each line's payload capped at
 * STATE_CHANGE_MAX (a marked word-boundary cut per truncateExample), each free field within it
 * at STATE_CHANGE_FIELD_MAX. Together with the fixed timestamp/role cells these make the
 * section's bytes a constant-plus-marker, so the digest's ~6 KB bound holds no matter how many
 * transitions the window holds or how long a field is. */
export const STATE_CHANGE_TOP = 6;
const STATE_CHANGE_MAX = 72;
const STATE_CHANGE_FIELD_MAX = 24;

/** Join a list of `items` into one comma/`;`-separated line that fits STATE_CHANGE_MAX: pop
 * tail items until `prefix + items.join(separator)` — with a `… +N more <noun>` marker naming
 * the drop, or a bare `bare` fallback once none remain — stays under the cap, so the cut never
 * lands mid-item and the marker survives the final pass. Shared by the fallback_switched and
 * config_changed lines, which both bounded-drop a hand-edited/list payload that can overshoot
 * the cap (BUGS.md 2026-10-01), so the loop shape and marker wording cannot drift between them. */
function joinToCap(
  bare: string,
  prefix: string,
  separator: string,
  noun: string,
  items: string[],
): string {
  let text = items.length > 0 ? prefix + items.join(separator) : bare;
  let hidden = 0;
  while (text.length > STATE_CHANGE_MAX) {
    items.pop();
    hidden += 1;
    text =
      items.length > 0
        ? `${prefix}${items.join(separator)} … +${hidden} more ${noun}`
        : `${bare} … +${hidden} more ${noun}`;
  }
  return text;
}

/** A free event field, sliced so one hand-edited or future payload cannot blow the section's
 * byte budget. Takes unknown because HarnessEvent carries its fields loosely typed. A cut that
 * would land between an astral character's two UTF-16 units backs off one unit — dropping the
 * whole character rather than leaving a lone high surrogate the terminal renders as a
 * replacement box (text.ts's truncate rule, shared rather than re-derived). */
function field(v: unknown): string {
  if (v === undefined || v === null) return ""; // A torn event must never render "undefined".
  const s = String(v);
  let cut = STATE_CHANGE_FIELD_MAX;
  if (cutSplitsSurrogatePair(s, cut)) cut -= 1; // Never emit a lone high surrogate.
  return s.slice(0, cut);
}

/** The backend a fallback-ish decision line names, as "provider/model", defaulting each half
 * to pi's own default when the event omits it and slicing both through field. Shared by the
 * budget_fallback and model_fallback lines so the default and its slice rule stay in one place. */
function providerModel(ev: HarnessEvent): string {
  return `${field(ev.provider ?? "pi default")}/${field(ev.model ?? "pi default")}`;
}

/** A utilization fraction as its whole-number percent, read through finiteNumber so a torn or
 * hand-edited subscription event renders 0% rather than NaN — the same corrupt-field rule the
 * feed's own subscription lines apply. */
function pct(v: unknown): number {
  return claudeUtilizationPct(finiteNumber(v, 0));
}

/** A per-family builder of one state-change line, one per event family, so the budget, pause,
 * model-wiring, provider-hold, live-config, update, wait and lifecycle wordings are each found
 * by name. Each is a total function over any HarnessEvent — its `default` returns the bare type
 * name, unreachable through the dispatcher below — and each returns the untruncated line; the
 * caller truncates exactly once, so the byte bound and its marker apply as before. */
function budgetStateChange(ev: HarnessEvent): string {
  let text: string;
  switch (ev.type) {
    case "budget_paused": {
      // A breaker demotion (BUGS.md 2026-09-20) leads with its cause instead of the spend: the
      // spend line is the budget_fallback just before it, and the line cap would cut the pair.
      if (ev.fallbackDemoted) {
        text = `budget paused — ${field(ev.failures ?? "?")} runs failed on over-cap model ${field(ev.fallbackDemoted)}`;
        break;
      }
      const refused = ev.fallbackRejected
        ? ` (fallback ${field(ev.fallbackRejected)} refused)`
        : "";
      text = `budget paused — ${budgetPhrase(ev.spentUsd, ev.capUsd)} daily cost reached${refused}`;
      break;
    }
    case "budget_fallback":
      text = `over-cap model — ${budgetPhrase(ev.spentUsd, ev.capUsd)} daily cost reached; roles continue on ${providerModel(ev)} (cost n/a)`;
      break;
    case "budget_resumed":
      text = `budget resumed (${budgetPhrase(ev.spentUsd, ev.capUsd)} today)`;
      break;
    default:
      return ev.type;
  }
  return text;
}

function pauseStateChange(ev: HarnessEvent): string {
  let text: string;
  switch (ev.type) {
    case "team_paused":
      text = teamPausePhrase() + untilClockSuffix(ev.until);
      if (isNonBlankString(ev.reason)) text += `: ${field(ev.reason)}`;
      break;
    case "team_resumed":
      text = teamResumePhrase() + (ev.expired === true ? PAUSE_EXPIRED_SUFFIX : "");
      break;
    case "role_paused":
      text = rolePausePhrase(field(ev.role ?? "?")) + untilClockSuffix(ev.until);
      break;
    case "role_resumed":
      text = roleResumePhrase(field(ev.role ?? "?")) + (ev.expired === true ? PAUSE_EXPIRED_SUFFIX : "");
      break;
    case "role_streak_paused":
      // The error-streak breaker auto-paused the role; the digest names the depth so the
      // operator can connect the pause to the failing runs the clusters above show.
      text = `role ${field(ev.role ?? "?")} paused — ${field(ev.streak ?? "?")} runs failed in a row`;
      break;
    case "role_cap_paused":
      // The role reached its own daily spend cap and stopped starting runs.
      text = `role ${field(ev.role ?? "?")} paused — ${budgetPhrase(ev.spentUsd, ev.capUsd)} of its daily cap spent`;
      break;
    case "role_cap_resumed":
      text = `role ${field(ev.role ?? "?")} resumed — under its daily cap again`;
      break;
    default:
      return ev.type;
  }
  return text;
}

function modelStateChange(ev: HarnessEvent): string {
  let text: string;
  switch (ev.type) {
    case "model_fallback_started":
      // The role tripped off its primary onto its fallback after provider-class failures.
      text = `model fallback — ${providerModel(ev)} engaged (${field(ev.reason ?? "backend failure")})`;
      break;
    case "model_fallback_ended":
      // The return counterpart: names the primary the role resumed on and how long the
      // off-model episode ran.
      text = `model fallback ended — back on ${providerModel(ev)} after ${shortSpanPhrase(finiteNumber(ev.durationMs, 0))}`;
      break;
    case "provider_concurrency_changed":
      text = `${field(ev.provider)} concurrency ${field(ev.from)} → ${field(ev.to)}`;
      break;
    case "model_changed":
      // A model_cleared (or a roles.<id>.model-only) live edit arrives with `to: null`;
      // name pi's default the way the feed does so the digest never renders a bare
      // `model changed — now `.
      text = `model changed — now ${field(ev.to ?? "pi's default")}`;
      break;
    case "fallback_switched": {
      // A tier's fallback pair or step changed (or returned to the primary) this poll. Null
      // `to`/`from` read `primary`, matching the feed's fallback_switched line. Whole parts
      // only, dropped from the tail with a marker when the tier list overshoots the cap — the
      // same bounded-drop rule config_changed uses, because a hand-edited `tiers` object can
      // carry more entries than MODEL_TIERS; an empty or torn object reads `fallback switched`.
      const tiers = isJsonObject(ev.tiers) ? ev.tiers : {};
      const parts = Object.entries(tiers).map(([tier, v]) => {
        const t = isJsonObject(v) ? v : {};
        return `${field(tier)}: ${field(t.from ?? "primary")} → ${field(t.to ?? "primary")} (${field(t.reason ?? "available")})`;
      });
      text = joinToCap("fallback switched", "fallback switched — ", "; ", "tiers", parts);
      break;
    }
    case "budget_handback":
      // The budget/window reopened and aborted in-flight fallback runs; their next run
      // continues on the primary. Mirrors the feed's budget_handback wording in the digest's
      // compact form; the window's backend is not named since subscription_window_reset
      // already carries it.
      text =
        ev.reason === "window"
          ? `window reset — handed ${rolesPhrase(ev.roles, "?", 4, field)} back to the primary`
          : `budget reopened — handed ${rolesPhrase(ev.roles, "?", 4, field)} back to the primary`;
      break;
    default:
      return ev.type;
  }
  return text;
}

function providerHoldStateChange(ev: HarnessEvent): string {
  let text: string;
  switch (ev.type) {
    case "rate_limit_hold": {
      // Same split as the event feed's rendering (event-format.ts): a rate-limit hold keeps
      // the 429 wording; a backend-failure kind names itself. The role list caps at four and
      // each role is byte-sliced through field() so the section's bound holds.
      const roles = rolesPhrase(ev.roles, "?", 4, field);
      text =
        rendersAsBackendFailure(ev.kind)
          ? `backend hold (${backendKindPhrase(ev.kind)}) ${holdPhrase(ev.holdMs, ev.escalation)} — ${roles}`
          : `429 hold ${holdPhrase(ev.holdMs, ev.escalation)} — ${roles}`;
      break;
    }
    case "rate_limit_resumed":
      // Same split as the hold line above (and the event feed's rendering): the resumed event
      // carries the ended hold's kind, so a backend hold's lift names itself.
      text =
        rendersAsBackendFailure(ev.kind)
          ? `backend hold lifted (${backendKindPhrase(ev.kind)}) — roles run again`
          : "429 hold lifted — roles run again";
      break;
    default:
      return ev.type;
  }
  return text;
}

function liveConfigStateChange(ev: HarnessEvent): string {
  let text: string;
  switch (ev.type) {
    case "max_concurrent_changed":
      text = `maxConcurrent ${field(ev.from)} → ${field(ev.to)}`;
      break;
    case "retention_changed":
      text = `sessionRetentionDays ${field(ev.from)} → ${field(ev.to)}`;
      break;
    case "config_changed": {
      // Whole keys only, and a marked drop when any are cut (BUGS.md 2026-10-01): the old
      // slice(0, 6) could leave a mid-word fragment standing in for a key and hid the rest of
      // the edit with no marker. Keys are dropped from the tail until the line — plus the
      // marker naming the drop — fits the section cap, so the final STATE_CHANGE_MAX pass
      // below can never cut the marker or a key mid-word.
      const keys = stringList(ev.keys).map(field);
      text = joinToCap("config changed", "config changed: ", ", ", "keys", keys);
      break;
    }
    default:
      return ev.type;
  }
  return text;
}

function updateStateChange(ev: HarnessEvent): string {
  let text: string;
  switch (ev.type) {
    case "build_stale":
      // The digest's 72-char line cap (§ STATE_CHANGE_MAX) cannot hold the full alert phrase
      // "restarts after cooldown; work continues" beside the ahead-count prefix, so it says
      // the same thing compactly: the restart waits while work continues (cooldown scope,
      // PLANS.md 2026-10-23).
      text = `update available (${plural(finiteNumber(ev.aheadCommits, 0), "commit")} behind) — restart waits; work continues`;
      break;
    case "restart_pending":
      text = `restart pending — main ${shortSha(ev.head)} green`;
      break;
    case "restart":
      text = `restarting onto update ${shortSha(ev.to)}`;
      break;
    case "restart_refused":
      text = `restart onto ${shortSha(ev.to)} refused: ${field(ev.reason)}`;
      break;
    case "restart_blocked":
      text = `restart blocked — ${field(ev.reason)}; staying on build ${shortSha(ev.from)}`;
      break;
    default:
      return ev.type;
  }
  return text;
}

function waitStateChange(ev: HarnessEvent): string {
  let text: string;
  switch (ev.type) {
    case "run_deferred":
      text = `deferred — ${deferredReasonText(ev)}`;
      break;
    case "disk_low":
      // The disk floor stopped the team from starting runs; the free space and floor read
      // through the feed's own gigabytes so the digest and the event feed cannot drift.
      text = `waiting: low disk — ${gigabytes(ev.freeGB)} free (floor ${gigabytes(ev.holdGB)})`;
      break;
    case "disk_ok":
      text = `disk recovered — ${gigabytes(ev.freeGB)} free`;
      break;
    case "quiet_hours_started":
      text = `waiting: quiet hours${windowSuffix(ev)}`;
      break;
    case "quiet_hours_ended":
      text = `quiet hours ended${windowSuffix(ev)}`;
      break;
    case "maintenance_quota_hold":
      text = `waiting: maintenance allowance used — ${field(ev.maint)}/${field(ev.allowance)} in 24h (${field(ev.work)} work)`;
      break;
    case "maintenance_quota_resumed":
      text = `maintenance allowance reopened — ${field(ev.maint)}/${field(ev.allowance)} in 24h`;
      break;
    case "subscription_window_reserved":
      text = `waiting: ${backendLabel(ev)} window ${field(ev.windowType)} at ${pct(ev.utilization)}% past its ${pct(ev.reserve)}% reserve`;
      break;
    case "subscription_window_limited":
      text = `waiting: ${backendLabel(ev)} window ${field(ev.windowType)} rejected${windowResetPhrase(ev)}`;
      break;
    case "subscription_window_reset":
      text = `${backendLabel(ev)} window reset — model jobs run again`;
      break;
    default:
      return ev.type;
  }
  return text;
}

function lifecycleStateChange(ev: HarnessEvent): string {
  let text: string;
  switch (ev.type) {
    case "orchestrator_start":
      text = `tumwater started (pid ${field(ev.pid)}${ev.build ? `, build ${shortSha(ev.build)}` : ""})`;
      break;
    case "orchestrator_stop":
      text = orchestratorStopPhrase(ev.cause);
      break;
    case "supervisor_exit":
      text = `tumwater down — restart ${field(ev.generation)} ${ev.signal ? `killed by ${field(ev.signal)}` : `exited ${field(ev.code)}`}${ev.reason ? `: ${field(ev.reason)}` : ""}`;
      break;
    case "bootstrap_complete":
      text = `bootstrap complete — ${field(ev.plansDone)}/${field(ev.untilPlansDone)} plans done`;
      break;
    default:
      return ev.type;
  }
  return text;
}

/** A compact, bounded one-liner for one harness decision event, for the Team state changes
 * section. Every free string is sliced (field) and the whole line is capped again at
 * STATE_CHANGE_MAX so the digest's byte bound holds for any event shape — the cap cut falls on
 * a word boundary and carries truncateExample's `… (+N chars)` marker, so a cut line can never
 * read as complete or stand mid-word where a key or value should be; the render adds the
 * timestamp and a roleCell-sliced role, so no unbounded field reaches the page. */
export function describeStateChange(ev: HarnessEvent): string {
  switch (ev.type) {
    case "budget_paused":
    case "budget_fallback":
    case "budget_resumed":
      return truncateExample(budgetStateChange(ev), STATE_CHANGE_MAX);
    case "team_paused":
    case "team_resumed":
    case "role_paused":
    case "role_resumed":
    case "role_streak_paused":
    case "role_cap_paused":
    case "role_cap_resumed":
      return truncateExample(pauseStateChange(ev), STATE_CHANGE_MAX);
    case "model_fallback_started":
    case "model_fallback_ended":
    case "provider_concurrency_changed":
    case "model_changed":
    case "fallback_switched":
    case "budget_handback":
      return truncateExample(modelStateChange(ev), STATE_CHANGE_MAX);
    case "rate_limit_hold":
    case "rate_limit_resumed":
      return truncateExample(providerHoldStateChange(ev), STATE_CHANGE_MAX);
    case "max_concurrent_changed":
    case "retention_changed":
    case "config_changed":
      return truncateExample(liveConfigStateChange(ev), STATE_CHANGE_MAX);
    case "build_stale":
    case "restart_pending":
    case "restart":
    case "restart_refused":
    case "restart_blocked":
      return truncateExample(updateStateChange(ev), STATE_CHANGE_MAX);
    case "run_deferred":
    case "disk_low":
    case "disk_ok":
    case "quiet_hours_started":
    case "quiet_hours_ended":
    case "maintenance_quota_hold":
    case "maintenance_quota_resumed":
    case "subscription_window_reserved":
    case "subscription_window_limited":
    case "subscription_window_reset":
      return truncateExample(waitStateChange(ev), STATE_CHANGE_MAX);
    case "orchestrator_start":
    case "orchestrator_stop":
    case "supervisor_exit":
    case "bootstrap_complete":
      return truncateExample(lifecycleStateChange(ev), STATE_CHANGE_MAX);
    default:
      return truncateExample(ev.type, STATE_CHANGE_MAX);
  }
}
