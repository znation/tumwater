import test from "node:test";
import assert from "node:assert/strict";
import {
  describeStateChange,
  STATE_CHANGE_TOP,
  STATE_CHANGE_TYPES,
} from "../src/failure-state-change.js";
import type { HarnessEvent } from "../src/events.js";

// describeStateChange is the wording half of the failure digest's Fleet state changes section:
// one bounded line per harness self-decision event. Fixtures here carry only the payload fields
// the real emit sites write (orchestrator.ts, redeploy.ts, fleet-hold.ts, the pause
// commands), so the pins track what observers actually see in events.jsonl.

/** An event as logEvent would write it — ts and loop are always present, payload after. */
function ev(fields: Record<string, unknown>): HarnessEvent {
  return { ts: 0, loop: "harness", ...fields } as HarnessEvent;
}

test("STATE_CHANGE_TYPES lists the replayed transitions and STATE_CHANGE_TOP caps the section", () => {
  // The set is the contract failure-data.ts filters the window against: every event type the
  // digest replays as a Fleet state change, and nothing else.
  for (const t of [
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
  ]) {
    assert.ok(STATE_CHANGE_TYPES.has(t), `missing ${t}`);
  }
  // tick outcomes (tick_end, landed, ...) are deliberately absent — they are the outcomes
  // section's business, not state changes.
  assert.ok(!STATE_CHANGE_TYPES.has("tick_end"));
  assert.equal(STATE_CHANGE_TOP, 6);
});

test("budget_paused leads with the breaker demotion cause when a fallback was demoted", () => {
  // orchestrator.ts emits the demotion pair with the breaker's failure count, so the digest
  // line names both the free pair that died and how many ticks it took with it.
  assert.equal(
    describeStateChange(
      ev({ type: "budget_paused", fallbackDemoted: "groq/llama-3-free", failures: 3, spentUsd: 5, capUsd: 5 }),
    ),
    "budget paused — 3 ticks failed on fallback groq/llama-3-free",
  );
  // A hand-edited or future event without the count still renders bounded, never crashes.
  assert.equal(
    describeStateChange(ev({ type: "budget_paused", fallbackDemoted: "groq/llama-3-free" })),
    "budget paused — ? ticks failed on fallback groq/llama-3-free",
  );
});

test("budget_paused plain spend names the amount and a refused fallback when one was configured", () => {
  assert.equal(
    describeStateChange(ev({ type: "budget_paused", spentUsd: 12.5, capUsd: 20 })),
    "budget paused — $12.50 of $20.00 daily cost reached",
  );
  // A long refused pair rides until the 72-char line cap and is cut there — by design, so the
  // digest's byte bound holds for any event shape (the spend line above is the uncut shape);
  // past the cap the cut falls on a word boundary with a remainder marker (BUGS.md 2026-10-01).
  assert.equal(
    describeStateChange(
      ev({ type: "budget_paused", spentUsd: 12.5, capUsd: 20, fallbackRejected: "openai/gpt-4o" }),
    ),
    "budget paused — $12.50 of $20.00 daily cost reached (fallback … (+23 chars)",
  );
});

test("budget_fallback and budget_resumed phrase the spend around the gate move", () => {
  // The pair name rides until the 72-char line cap and is cut there — by design: the digest's
  // byte bound holds for any event shape, so a long model name loses its tail, not the line.
  assert.equal(
    describeStateChange(
      ev({ type: "budget_fallback", spentUsd: 5, capUsd: 5, provider: "groq", model: "llama-3-free" }),
    ),
    // Past the 72-char cap the cut falls on the last word boundary with a remainder marker,
    // not mid-token (BUGS.md 2026-10-01).
    "budget fallback — $5.00 of $5.00 daily cost reached; on … (+29 chars)",
  );
  // Without a resolved pair the line still renders (pi default), bounded the same way.
  assert.equal(
    describeStateChange(ev({ type: "budget_fallback", spentUsd: 5, capUsd: 5 })),
    "budget fallback — $5.00 of $5.00 daily cost reached; on pi default/pi … (+19 chars)",
  );
  assert.equal(
    describeStateChange(ev({ type: "budget_resumed", spentUsd: 12.5, capUsd: 20 })),
    "budget resumed ($12.50 of $20.00 today)",
  );
});

test("fleet and role pauses render fixed and role-named lines", () => {
  assert.equal(describeStateChange(ev({ type: "fleet_paused" })), "fleet paused — role loops stop starting new ticks");
  assert.equal(describeStateChange(ev({ type: "fleet_resumed" })), "fleet resumed — role loops tick again");
  assert.equal(
    describeStateChange(ev({ type: "role_paused", role: "steward" })),
    "role steward paused — it stops starting new ticks",
  );
  assert.equal(describeStateChange(ev({ type: "role_resumed", role: "steward" })), "role steward resumed — it ticks again");
  // A missing role renders as "?" rather than "undefined".
  assert.equal(describeStateChange(ev({ type: "role_paused" })), "role ? paused — it stops starting new ticks");
});

test("rate_limit_hold renders the hold duration, relapse, and at most four roles", () => {
  assert.equal(
    describeStateChange(ev({ type: "rate_limit_hold", holdMs: 60_000, escalation: 0, roles: ["feature", "fix"] })),
    "429 hold for 60s — feature, fix",
  );
  assert.equal(
    describeStateChange(ev({ type: "rate_limit_hold", holdMs: 180_000, escalation: 1, roles: ["feature"] })),
    "429 hold for 3m (relapse 1) — feature",
  );
  // More than four roles are cut: the storm's breadth, not its roster, is the news.
  assert.equal(
    describeStateChange(
      ev({ type: "rate_limit_hold", holdMs: 60_000, escalation: 0, roles: ["a", "b", "c", "d", "e", "f"] }),
    ),
    "429 hold for 60s — a, b, c, d",
  );
  // A malformed payload (no roles array) reads as "?", never crashes.
  assert.equal(describeStateChange(ev({ type: "rate_limit_hold", holdMs: 60_000 })), "429 hold for 60s — ?");
  // The resumed event carries the ended hold's kind (BUGS.md 2026-09-29), so a backend
  // hold's lift names itself; a kindless line keeps the historical 429 wording.
  assert.equal(
    describeStateChange(ev({ type: "rate_limit_resumed", kind: "server" })),
    "backend hold lifted (server error) — role loops tick again",
  );
  assert.equal(
    describeStateChange(ev({ type: "rate_limit_resumed" })),
    "429 hold lifted — role loops tick again",
  );
});

test("live-edit events name the knob and both values", () => {
  assert.equal(describeStateChange(ev({ type: "max_concurrent_changed", from: 4, to: 2 })), "maxConcurrent 4 → 2");
  assert.equal(describeStateChange(ev({ type: "retention_changed", from: 14, to: 7 })), "sessionRetentionDays 14 → 7");
  assert.equal(
    describeStateChange(ev({ type: "config_changed", keys: ["maxDailyCostUsd", "model"] })),
    "config changed: maxDailyCostUsd, model",
  );
  // No keys → the bare form, not a dangling colon.
  assert.equal(describeStateChange(ev({ type: "config_changed" })), "config changed");
});

test("build_stale and the restart quartet render shas and the refusal reason", () => {
  assert.equal(
    describeStateChange(ev({ type: "build_stale", build: "abcdef1234567890", head: "1234567890abcdef", aheadCommits: 3 })),
    "build abcdef12 stale — main 12345678 3 commits ahead",
  );
  assert.equal(
    describeStateChange(ev({ type: "restart_pending", head: "1234567890abcdef" })),
    "restart pending — main 12345678 green; compiling",
  );
  assert.equal(describeStateChange(ev({ type: "restart", to: "abcdef1234567890" })), "restarting onto build abcdef12");
  assert.equal(
    describeStateChange(ev({ type: "restart_refused", to: "abcdef1234567890", reason: "startup gate failed" })),
    "restart onto abcdef12 refused: startup gate failed",
  );
  // The third terminal state: a latched block must leave "compiling" in the state stream, or
  // the digest's newest transitions read as an endless in-progress build (BUGS.md 2026-09-28).
  // The reason rides the 24-char field cap (the full sentence is the warning's business).
  assert.equal(
    describeStateChange(ev({ type: "restart_blocked", from: "abcdef1234567890", to: "1234567890abcdef", reason: "rebuild of 12345678 failed" })),
    "restart blocked — rebuild of 12345678 fail; staying on build abcdef12",
  );
});

test("tick_deferred, orchestrator lifecycle, and supervisor_exit render their payloads", () => {
  assert.equal(describeStateChange(ev({ type: "tick_deferred" })), "deferred — no work landed since last tick");
  assert.equal(
    describeStateChange(ev({ type: "orchestrator_start", pid: 4242, build: "abcdef1234567890" })),
    "orchestrator started (pid 4242, build abcdef12)",
  );
  assert.equal(describeStateChange(ev({ type: "orchestrator_start", pid: 4242 })), "orchestrator started (pid 4242)");
  assert.equal(describeStateChange(ev({ type: "orchestrator_stop" })), "orchestrator stopped");
  assert.equal(
    describeStateChange(ev({ type: "supervisor_exit", generation: 7, code: 1 })),
    "fleet down — generation 7 exited 1",
  );
  assert.equal(
    describeStateChange(ev({ type: "supervisor_exit", generation: 7, signal: "SIGKILL" })),
    "fleet down — generation 7 killed by SIGKILL",
  );
  assert.equal(
    describeStateChange(
      ev({ type: "supervisor_exit", generation: 7, code: 1, reason: "startup gate failed" }),
    ),
    "fleet down — generation 7 exited 1: startup gate failed",
  );
});

test("unknown event types fall through to the bare type name", () => {
  // A future event type before this module learns its wording still shows up in the digest
  // instead of vanishing.
  assert.equal(describeStateChange(ev({ type: "mystery_event" })), "mystery_event");
});

test("free fields are sliced to 24 chars and the whole line to 72", () => {
  // One hand-edited or future payload field cannot blow the digest's byte bound: the field is
  // cut first, then the assembled line.
  assert.equal(
    describeStateChange(ev({ type: "max_concurrent_changed", from: "x".repeat(100), to: 2 })),
    `maxConcurrent ${"x".repeat(24)} → 2`,
  );
  // Six 24-char keys cannot all fit the line cap: whole keys are kept and the drop is
  // marked, instead of a bare slice leaving a mid-word fragment standing in for a key
  // (BUGS.md 2026-10-01). One 24-char key plus the marker fits; the second would not.
  assert.equal(
    describeStateChange(ev({ type: "config_changed", keys: Array.from({ length: 6 }, () => "k".repeat(24)) })),
    `config changed: ${"k".repeat(24)} … +5 more keys`,
  );
});

test("config_changed with more keys than fit the line cap names every dropped key", () => {
  // The digest is the operator's audit view of a live config edit: dropping keys silently —
  // or cutting the sixth mid-word — reads as a key named `prov` existing (BUGS.md 2026-10-01).
  // Eight real-world keys: as many whole keys as fit inside the section cap — marker
  // included — are shown, then one marker counts the rest.
  const keys = [
    "fallbackModel",
    "idleBackoff",
    "maxDailyCostUsd",
    "model",
    "provider",
    "quietHours",
    "notify",
    "customLoops",
  ];
  const line = describeStateChange(ev({ type: "config_changed", keys }));
  assert.equal(line, "config changed: fallbackModel, idleBackoff … +6 more keys");
  for (const k of keys) {
    if (!line.includes(k)) assert.ok(line.includes(`+6 more keys`), `key ${k} neither shown nor counted`);
  }
  assert.ok(!/\w…/.test(line), "no key is cut mid-word");
  assert.ok(line.length <= 72, "the line still honors the section cap");
});

test("a state-change line past 72 chars is cut on a word boundary with a remainder marker", () => {
  // The same convention the digest's other capped sections got (BUGS.md 2026-09-30): a cut
  // never lands mid-word and always says how much was dropped, so a truncated line cannot
  // read as complete.
  // rate_limit_hold assembles four role names past the cap even after field() clips each.
  const line = describeStateChange(
    ev({ type: "rate_limit_hold", kind: "connection", holdMs: 60_000, escalation: 1, roles: ["feature", "fix", "tests", "coverage"] }),
  );
  assert.ok(line.endsWith(")"), line);
  assert.ok(line.includes("… (+"), line);
  assert.ok(!line.match(/\S…/), `cut falls on a word boundary: ${line}`);
  const body = line.slice(0, line.indexOf(" … (+"));
  assert.ok(body.length <= 72, `the body honors the cap: ${body.length}`);
});

// The backend-failure kinds (PLANS.md 2026-09-29) name themselves in the digest's line, while
// the rate-limit kind keeps the "429 hold" wording every historical event has.
test("rate_limit_hold renders backend kinds as backend holds, rate-limit as a 429 hold", () => {
  assert.equal(
    describeStateChange(ev({ type: "rate_limit_hold", kind: "connection", holdMs: 60_000, escalation: 0, roles: ["feature", "fix"] })),
    "backend hold (connection error) for 60s — feature, fix",
  );
  assert.equal(
    describeStateChange(ev({ type: "rate_limit_hold", kind: "server", holdMs: 180_000, escalation: 1, roles: ["feature"] })),
    "backend hold (server error) for 3m (relapse 1) — feature",
  );
  // A timeout hold names the timeout's own phrase, not a connection's — the digest pools
  // plain and progressing tick timeouts under this kind (failure-cluster.ts).
  assert.equal(
    describeStateChange(ev({ type: "rate_limit_hold", kind: "timeout", holdMs: 60_000, escalation: 0, roles: ["tests"] })),
    "backend hold (request timed out) for 60s — tests",
  );
  // A torn line with no kind at all keeps the 429 wording too (the existing test above pins
  // the normal rate-limit kind's wording).
  assert.equal(
    describeStateChange(ev({ type: "rate_limit_hold", holdMs: 60_000, escalation: 0, roles: ["feature", "fix"] })),
    "429 hold for 60s — feature, fix",
  );
});
