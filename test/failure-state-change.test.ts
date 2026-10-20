import test from "node:test";
import assert from "node:assert/strict";
import {
  describeStateChange,
  STATE_CHANGE_TOP,
  STATE_CHANGE_TYPES,
} from "../src/failure/failure-state-change.js";
import type { HarnessEvent } from "../src/events/events.js";

// describeStateChange is the wording half of the failure digest's Team state changes section:
// one bounded line per harness self-decision event. Fixtures here carry only the payload fields
// the real emit sites write (orchestrator.ts, redeploy.ts, team/team-hold.ts, the pause
// commands), so the pins track what observers actually see in events.jsonl.

/** An event as logEvent would write it — ts and role are always present, payload after. */
function ev(fields: Record<string, unknown>): HarnessEvent {
  return { ts: 0, source: "harness", ...fields } as HarnessEvent;
}

test("STATE_CHANGE_TYPES lists the replayed transitions and STATE_CHANGE_TOP caps the section", () => {
  // The set is the contract src/failure/failure-data.ts filters the window against: every event
  // type the
  // digest replays as a Team state change, and nothing else.
  for (const t of [
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
  ]) {
    assert.ok(STATE_CHANGE_TYPES.has(t), `missing ${t}`);
  }
  // tick outcomes (run_end, merged, ...) are deliberately absent — they are the outcomes
  // section's business, not state changes.
  assert.ok(!STATE_CHANGE_TYPES.has("run_end"));
  assert.equal(STATE_CHANGE_TOP, 6);
});

test("budget_paused leads with the breaker demotion cause when a fallback was demoted", () => {
  // orchestrator.ts emits the demotion pair with the breaker's failure count, so the digest
  // line names both the free pair that died and how many ticks it took with it.
  assert.equal(
    describeStateChange(
      ev({ type: "budget_paused", fallbackDemoted: "groq/llama-3-free", failures: 3, spentUsd: 5, capUsd: 5 }),
    ),
    "budget paused — 3 runs failed on over-cap model groq/llama-3-free",
  );
  // A hand-edited or future event without the count still renders bounded, never crashes.
  assert.equal(
    describeStateChange(ev({ type: "budget_paused", fallbackDemoted: "groq/llama-3-free" })),
    "budget paused — ? runs failed on over-cap model groq/llama-3-free",
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
    "over-cap model — $5.00 of $5.00 daily cost reached; roles continue on … (+29 chars)",
  );
  // Without a resolved pair the line still renders (pi default), bounded the same way.
  assert.equal(
    describeStateChange(ev({ type: "budget_fallback", spentUsd: 5, capUsd: 5 })),
    "over-cap model — $5.00 of $5.00 daily cost reached; roles continue on … (+33 chars)",
  );
  assert.equal(
    describeStateChange(ev({ type: "budget_resumed", spentUsd: 12.5, capUsd: 20 })),
    "budget resumed ($12.50 of $20.00 today)",
  );
});

test("team and role pauses render fixed and role-named lines", () => {
  assert.equal(describeStateChange(ev({ type: "team_paused" })), "team paused — roles start no new runs");
  assert.equal(describeStateChange(ev({ type: "team_resumed" })), "team resumed — roles run again");
  assert.equal(
    describeStateChange(ev({ type: "role_paused", role: "steward" })),
    "role steward paused — it starts no new runs",
  );
  assert.equal(describeStateChange(ev({ type: "role_resumed", role: "steward" })), "role steward resumed — it runs again");
  // A missing role renders as "?" rather than "undefined".
  assert.equal(describeStateChange(ev({ type: "role_paused" })), "role ? paused — it starts no new runs");
});

test("the error-streak, role-cap and model-fallback transitions render their reason", () => {
  // The breaker's auto-pause names the streak depth so the pause connects to the failing
  // ticks; without a count the line still renders (?, like the feed's textOr fallback).
  assert.equal(
    describeStateChange(ev({ type: "role_streak_paused", role: "docs", streak: 10 })),
    "role docs paused — 10 runs failed in a row",
  );
  assert.equal(
    describeStateChange(ev({ type: "role_streak_paused", role: "docs" })),
    "role docs paused — ? runs failed in a row",
  );
  // The role's own daily cap: spend and cap through the shared budgetPhrase.
  assert.equal(
    describeStateChange(ev({ type: "role_cap_paused", role: "feature", spentUsd: 1.5, capUsd: 1.5 })),
    "role feature paused — $1.50 of $1.50 of its daily cap spent",
  );
  assert.equal(
    describeStateChange(ev({ type: "role_cap_resumed", role: "feature" })),
    "role feature resumed — under its daily cap again",
  );
  // The model-fallback episode: the fallback pair and the reason the primary was abandoned,
  // with the feed's own pi-default/backend-failure fallbacks for missing fields.
  assert.equal(
    describeStateChange(ev({ type: "model_fallback_started", provider: "groq", model: "llama-3-free", reason: "rate limit" })),
    "model fallback — groq/llama-3-free engaged (rate limit)",
  );
  assert.equal(
    describeStateChange(ev({ type: "model_fallback_started" })),
    "model fallback — pi default/pi default engaged (backend failure)",
  );
  // durationMs is finiteNumber-coerced then shortSpanPhrase'd (300s rounds to 5m); a torn
  // payload without it renders 0s rather than throwing.
  assert.equal(
    describeStateChange(ev({ type: "model_fallback_ended", provider: "groq", model: "llama-3-free", durationMs: 300_000 })),
    "model fallback ended — back on groq/llama-3-free after 5m",
  );
  assert.equal(
    describeStateChange(ev({ type: "model_fallback_ended" })),
    "model fallback ended — back on pi default/pi default after 0s",
  );
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
    "backend hold lifted (server error) — roles run again",
  );
  assert.equal(
    describeStateChange(ev({ type: "rate_limit_resumed" })),
    "429 hold lifted — roles run again",
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
    "update available (3 commits behind) — restarts when idle",
  );
  // A torn or hand-edited log can carry a non-numeric aheadCommits; the digest must not render
  // "NaN commits" (event-format.ts's build_stale line has the same guard).
  const corrupt = describeStateChange(ev({ type: "build_stale", build: "abcdef1234567890", head: "1234567890abcdef", aheadCommits: "twelve" }));
  assert.equal(corrupt, "update available (0 commits behind) — restarts when idle");
  assert.doesNotMatch(corrupt, /NaN/);
  assert.equal(
    describeStateChange(ev({ type: "restart_pending", head: "1234567890abcdef" })),
    "restart pending — main 12345678 green",
  );
  assert.equal(describeStateChange(ev({ type: "restart", to: "abcdef1234567890" })), "restarting onto update abcdef12");
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

test("run_deferred, orchestrator lifecycle, and supervisor_exit render their payloads", () => {
  assert.equal(describeStateChange(ev({ type: "run_deferred" })), "deferred — nothing merged since the last run");
  assert.equal(
    describeStateChange(ev({ type: "run_deferred", reason: "backlog" })),
    "deferred — feature/bugfix backlog open",
  );
  assert.equal(
    describeStateChange(ev({ type: "orchestrator_start", pid: 4242, build: "abcdef1234567890" })),
    "tumwater started (pid 4242, build abcdef12)",
  );
  assert.equal(describeStateChange(ev({ type: "orchestrator_start", pid: 4242 })), "tumwater started (pid 4242)");
  assert.equal(describeStateChange(ev({ type: "orchestrator_stop" })), "tumwater stopped");
  assert.equal(
    describeStateChange(ev({ type: "supervisor_exit", generation: 7, code: 1 })),
    "tumwater down — restart 7 exited 1",
  );
  assert.equal(
    describeStateChange(ev({ type: "supervisor_exit", generation: 7, signal: "SIGKILL" })),
    "tumwater down — restart 7 killed by SIGKILL",
  );
  assert.equal(
    describeStateChange(
      ev({ type: "supervisor_exit", generation: 7, code: 1, reason: "startup gate failed" }),
    ),
    "tumwater down — restart 7 exited 1: startup gate failed",
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
  // A cut between an astral character's surrogate halves backs off one unit: the whole
  // character is dropped, never a lone high surrogate the terminal renders as a box.
  assert.equal(
    describeStateChange(ev({ type: "max_concurrent_changed", from: "x".repeat(23) + "😀" + "y".repeat(30), to: 2 })),
    `maxConcurrent ${"x".repeat(23)} → 2`,
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
    "customRoles",
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
  assert.ok(!(/\S…/.exec(line)), `cut falls on a word boundary: ${line}`);
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
  // plain and progressing tick timeouts under this kind (src/failure/failure-cluster.ts).
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
