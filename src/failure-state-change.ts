/** Wording half of the failure digest's Fleet state changes section: which transition event
 * types the digest replays and the bounded one-liner describing each. Split out of
 * failure-data.ts (the same seam build-check-events.ts split from build-check.ts) so the
 * per-event-type wording — which changes whenever the harness grows a new self-decision —
 * stays apart from the collection rules (clustering, window math, section cuts) in
 * failure-data.ts. Every free string is sliced here, so the digest's byte bound holds for any
 * event shape; the render adds the timestamp and a roleCell-sliced role, so no unbounded field
 * reaches the page. */
import type { HarnessEvent } from "./types.js";
import { budgetPhrase, rateLimitHoldPhrase, shortSha } from "./text.js";

/** The transition events the digest replays: the decisions the harness made about itself (the
 * cap/fleet gates and the 429 hold, live-config edits, self-hosted redeploys, need-based
 * deferrals, orchestrator lifecycle). They are the evidence the telemetry role's load-bearing
 * rule asks it to judge — whether the harness's RESPONSE to a failure was wrong
 * (plans/telemetry-role.md) — so they sit beside the outcomes rather than being dropped. */
export const STATE_CHANGE_TYPES = new Set<string>([
  "budget_paused",
  "budget_fallback",
  "budget_resumed",
  "fleet_paused",
  "fleet_resumed",
  "role_paused",
  "role_resumed",
  "rate_limit_hold",
  "rate_limit_resumed",
  "max_concurrent_changed",
  "retention_changed",
  "config_changed",
  "build_stale",
  "restart_pending",
  "restart",
  "restart_refused",
  "tick_deferred",
  "orchestrator_start",
  "orchestrator_stop",
  "supervisor_exit",
]);

/** The Fleet state changes section's caps: newest N transitions, each line's payload capped at
 * STATE_CHANGE_MAX, each free field within it at STATE_CHANGE_FIELD_MAX. Together with the
 * fixed timestamp/role cells these make the section's bytes a constant, so the digest's ~6 KB
 * bound holds no matter how many transitions the window holds or how long a field is. */
export const STATE_CHANGE_TOP = 6;
const STATE_CHANGE_MAX = 72;
const STATE_CHANGE_FIELD_MAX = 24;

/** A free event field, sliced so one hand-edited or future payload cannot blow the section's
 * byte budget. Takes unknown because HarnessEvent carries its fields loosely typed. */
function field(v: unknown): string {
  return String(v).slice(0, STATE_CHANGE_FIELD_MAX);
}

/** A compact, bounded one-liner for one harness decision event, for the Fleet state changes
 * section. Every free string is sliced (field) and the whole line is capped again
 * (STATE_CHANGE_MAX) so the digest's byte bound holds for any event shape; the render adds the
 * timestamp and a roleCell-sliced role, so no unbounded field reaches the page. */
export function describeStateChange(ev: HarnessEvent): string {
  let text: string;
  switch (ev.type) {
    case "budget_paused": {
      // A breaker demotion (BUGS.md 2026-09-20) leads with its cause instead of the spend: the
      // spend line is the budget_fallback just before it, and the line cap would cut the pair.
      if (ev.fallbackDemoted) {
        text = `budget paused — ${field(ev.failures ?? "?")} ticks failed on fallback ${field(ev.fallbackDemoted)}`;
        break;
      }
      const refused = ev.fallbackRejected
        ? ` (fallback ${field(ev.fallbackRejected)} refused)`
        : "";
      text = `budget paused — ${budgetPhrase(ev.spentUsd, ev.capUsd)} daily cost reached${refused}`;
      break;
    }
    case "budget_fallback":
      text = `budget fallback — ${budgetPhrase(ev.spentUsd, ev.capUsd)} daily cost reached; on ${field(ev.provider ?? "pi default")}/${field(ev.model ?? "pi default")} (cost n/a)`;
      break;
    case "budget_resumed":
      text = `budget resumed (${budgetPhrase(ev.spentUsd, ev.capUsd)} today)`;
      break;
    case "fleet_paused":
      text = "fleet paused — role loops stop starting new ticks";
      break;
    case "fleet_resumed":
      text = "fleet resumed — role loops tick again";
      break;
    case "role_paused":
      text = `role ${field(ev.role ?? "?")} paused — it stops starting new ticks`;
      break;
    case "role_resumed":
      text = `role ${field(ev.role ?? "?")} resumed — it ticks again`;
      break;
    case "rate_limit_hold":
      text = `429 hold ${rateLimitHoldPhrase(ev.holdMs, ev.escalation)} — ${Array.isArray(ev.roles) ? (ev.roles as unknown[]).slice(0, 4).map(field).join(", ") : "?"}`;
      break;
    case "rate_limit_resumed":
      text = "429 hold lifted — role loops tick again";
      break;
    case "max_concurrent_changed":
      text = `maxConcurrent ${field(ev.from)} → ${field(ev.to)}`;
      break;
    case "retention_changed":
      text = `sessionRetentionDays ${field(ev.from)} → ${field(ev.to)}`;
      break;
    case "config_changed": {
      const keys = Array.isArray(ev.keys)
        ? (ev.keys as unknown[]).slice(0, 6).map(field)
        : [];
      text = keys.length > 0 ? `config changed: ${keys.join(", ")}` : "config changed";
      break;
    }
    case "build_stale":
      text = `build ${shortSha(ev.build)} stale — main ${shortSha(ev.head)} ${field(ev.aheadCommits)} commit(s) ahead`;
      break;
    case "restart_pending":
      text = `restart pending — main ${shortSha(ev.head)} green; compiling`;
      break;
    case "restart":
      text = `restarting onto build ${shortSha(ev.to)}`;
      break;
    case "restart_refused":
      text = `restart onto ${shortSha(ev.to)} refused: ${field(ev.reason)}`;
      break;
    case "tick_deferred":
      text = "deferred — no work landed since last tick";
      break;
    case "orchestrator_start":
      text = `orchestrator started (pid ${field(ev.pid)}${ev.build ? `, build ${shortSha(ev.build)}` : ""})`;
      break;
    case "orchestrator_stop":
      text = "orchestrator stopped";
      break;
    case "supervisor_exit":
      text = `fleet down — generation ${field(ev.generation)} ${ev.signal ? `killed by ${field(ev.signal)}` : `exited ${field(ev.code)}`}${ev.reason ? `: ${field(ev.reason)}` : ""}`;
      break;
    default:
      text = ev.type;
  }
  return text.slice(0, STATE_CHANGE_MAX);
}
