/** Wording half of the failure digest's Team state changes section: which transition event types
 * the digest replays and the bounded one-liner describing each. Split out of failure-data.ts (the
 * same seam build/build-check-events.ts split from build/build-check.ts) so the per-event-type
 * wording — which changes whenever the harness grows a new self-decision — stays apart from the
 * collection rules (clustering, window math, section cuts) in failure-data.ts. Every free string is
 * sliced here, so the digest's byte bound holds for any event shape; the render adds the timestamp
 * and a roleCell-sliced role, so no unbounded field reaches the page. */
import { truncateExample } from "./failure-cluster.js";
import { cutSplitsSurrogatePair, isNonBlankString } from "../text/text.js";
import { finiteNumber, stringList } from "../files/json-object.js";
import type { HarnessEvent } from "../events/events.js";
import { orchestratorStopPhrase, backendKindPhrase, budgetPhrase, teamPausePhrase, teamResumePhrase, holdPhrase, plural, rolePausePhrase, roleResumePhrase, rolesPhrase, shortSpanPhrase, PAUSE_EXPIRED_SUFFIX } from "../text/phrases.js";

import { shortSha } from "../text/format.js";
import { deferredReasonText, untilClockSuffix, gigabytes, windowSuffix, windowResetPhrase, backendLabel } from "../events/event-format.js";
import { claudeUtilizationPct } from "../agent/claude/claude-account.js";

/** The transition events the digest replays: the decisions the harness made about itself (the
 * cap/team gates and the team hold, the error-streak breaker's pause, the role's own daily
 * cap, model fallbacks, live-config edits, self-hosted redeploys, need-based deferrals,
 * orchestrator lifecycle, and the gate holds/lifts that stop and restart work — low disk,
 * quiet hours, the maintenance allowance and the subscription-window reserve). Deliberately
 * left out, and said so here: `subscription_window_warning` (observational, gates nothing),
 * `disk_reclaim` (an action, not a state transition), `image_blind` (a run outcome), and
 * `permit_reserve`/`slot_wait`/`check_wait`/`provider_wait`/`claim` (per-run advisories or
 * assignments). The rest are the evidence the selfcheck role's load-bearing rule asks it to
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
]);

/** The Team state changes section's caps: newest N transitions, each line's payload capped at
 * STATE_CHANGE_MAX (a marked word-boundary cut per truncateExample), each free field within it
 * at STATE_CHANGE_FIELD_MAX. Together with the fixed timestamp/role cells these make the
 * section's bytes a constant-plus-marker, so the digest's ~6 KB bound holds no matter how many
 * transitions the window holds or how long a field is. */
export const STATE_CHANGE_TOP = 6;
const STATE_CHANGE_MAX = 72;
const STATE_CHANGE_FIELD_MAX = 24;

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

/** A compact, bounded one-liner for one harness decision event, for the Team state changes
 * section. Every free string is sliced (field) and the whole line is capped again at
 * STATE_CHANGE_MAX so the digest's byte bound holds for any event shape — the cap cut falls on
 * a word boundary and carries truncateExample's `… (+N chars)` marker, so a cut line can never
 * read as complete or stand mid-word where a key or value should be; the render adds the
 * timestamp and a roleCell-sliced role, so no unbounded field reaches the page. */
export function describeStateChange(ev: HarnessEvent): string {
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
    case "model_fallback_started":
      // The role tripped off its primary onto its fallback after provider-class failures.
      text = `model fallback — ${providerModel(ev)} engaged (${field(ev.reason ?? "backend failure")})`;
      break;
    case "model_fallback_ended":
      // The return counterpart: names the primary the role resumed on and how long the
      // off-model episode ran.
      text = `model fallback ended — back on ${providerModel(ev)} after ${shortSpanPhrase(finiteNumber(ev.durationMs, 0))}`;
      break;
    case "rate_limit_hold": {
      // Same split as the event feed's rendering (event-format.ts): a rate-limit hold keeps
      // the 429 wording; a backend-failure kind names itself. The role list caps at four and
      // each role is byte-sliced through field() so the section's bound holds.
      const roles = rolesPhrase(ev.roles, "?", 4, field);
      text =
        ev.kind && ev.kind !== "rate-limit"
          ? `backend hold (${backendKindPhrase(ev.kind)}) ${holdPhrase(ev.holdMs, ev.escalation)} — ${roles}`
          : `429 hold ${holdPhrase(ev.holdMs, ev.escalation)} — ${roles}`;
      break;
    }
    case "rate_limit_resumed":
      // Same split as the hold line above (and the event feed's rendering): the resumed event
      // carries the ended hold's kind, so a backend hold's lift names itself.
      text =
        ev.kind && ev.kind !== "rate-limit"
          ? `backend hold lifted (${backendKindPhrase(ev.kind)}) — roles run again`
          : "429 hold lifted — roles run again";
      break;
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
      text = keys.length > 0 ? `config changed: ${keys.join(", ")}` : "config changed";
      let hidden = 0;
      while (text.length > STATE_CHANGE_MAX) {
        keys.pop();
        hidden += 1;
        text =
          keys.length > 0
            ? `config changed: ${keys.join(", ")} … +${hidden} more keys`
            : `config changed … +${hidden} more keys`;
      }
      break;
    }
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
    case "run_deferred":
      text = `deferred — ${deferredReasonText(ev)}`;
      break;
    case "orchestrator_start":
      text = `tumwater started (pid ${field(ev.pid)}${ev.build ? `, build ${shortSha(ev.build)}` : ""})`;
      break;
    case "orchestrator_stop":
      text = orchestratorStopPhrase(ev.cause);
      break;
    case "supervisor_exit":
      text = `tumwater down — restart ${field(ev.generation)} ${ev.signal ? `killed by ${field(ev.signal)}` : `exited ${field(ev.code)}`}${ev.reason ? `: ${field(ev.reason)}` : ""}`;
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
    case "provider_concurrency_changed":
      text = `${field(ev.provider)} concurrency ${field(ev.from)} → ${field(ev.to)}`;
      break;
    case "model_changed":
      // A model_cleared (or a roles.<id>.model-only) live edit arrives with `to: null`;
      // name pi's default the way the feed does so the digest never renders a bare
      // `model changed — now `.
      text = `model changed — now ${field(ev.to ?? "pi's default")}`;
      break;
    case "bootstrap_complete":
      text = `bootstrap complete — ${field(ev.plansDone)}/${field(ev.untilPlansDone)} plans done`;
      break;
    default:
      text = ev.type;
  }
  return truncateExample(text, STATE_CHANGE_MAX);
}
