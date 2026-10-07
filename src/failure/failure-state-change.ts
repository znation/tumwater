/** Wording half of the failure digest's Fleet state changes section: which transition event
 * types the digest replays and the bounded one-liner describing each. Split out of
 * failure-data.ts (the same seam build/build-check-events.ts split from build/build-check.ts) so the
 * per-event-type wording — which changes whenever the harness grows a new self-decision —
 * stays apart from the collection rules (clustering, window math, section cuts) in
 * failure-data.ts. Every free string is sliced here, so the digest's byte bound holds for any
 * event shape; the render adds the timestamp and a roleCell-sliced role, so no unbounded field
 * reaches the page. */
import { truncateExample } from "./failure-cluster.js";
import { cutSplitsSurrogatePair } from "../text/text.js";
import { finiteNumber, stringList } from "../files/json-object.js";
import type { HarnessEvent } from "../events/events.js";
import { backendKindPhrase, budgetPhrase, holdPhrase, plural, rolesPhrase } from "../text/phrases.js";
import { shortSha } from "../text/format.js";
import { deferredReasonText } from "../events/event-format.js";

/** The transition events the digest replays: the decisions the harness made about itself (the
 * cap/fleet gates and the fleet hold, live-config edits, self-hosted redeploys, need-based
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
  "restart_blocked",
  "tick_deferred",
  "orchestrator_start",
  "orchestrator_stop",
  "supervisor_exit",
]);

/** The Fleet state changes section's caps: newest N transitions, each line's payload capped at
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
  const s = String(v);
  let cut = STATE_CHANGE_FIELD_MAX;
  if (cutSplitsSurrogatePair(s, cut)) cut -= 1; // Never emit a lone high surrogate.
  return s.slice(0, cut);
}

/** A compact, bounded one-liner for one harness decision event, for the Fleet state changes
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
          ? `backend hold lifted (${backendKindPhrase(ev.kind)}) — role loops tick again`
          : "429 hold lifted — role loops tick again";
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
      text = `build ${shortSha(ev.build)} stale — main ${shortSha(ev.head)} ${plural(finiteNumber(ev.aheadCommits, 0), "commit")} ahead`;
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
    case "restart_blocked":
      text = `restart blocked — ${field(ev.reason)}; staying on build ${shortSha(ev.from)}`;
      break;
    case "tick_deferred":
      text = `deferred — ${deferredReasonText(ev)}`;
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
  return truncateExample(text, STATE_CHANGE_MAX);
}
