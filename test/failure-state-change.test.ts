import test from "node:test";
import assert from "node:assert/strict";
import {
  describeStateChange,
  STATE_CHANGE_TOP,
  STATE_CHANGE_TYPES,
  STATE_CHANGE_EXCLUDED_TYPES,
} from "../src/failure/failure-state-change.js";
import { EVENT_TYPE_LABELS } from "../src/events/event-labels.js";
import { formatTime } from "../src/text/datetime.js";
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
    "model_changed",
    "bootstrap_complete",
    "fallback_switched",
    "budget_handback",
  ]) {
    assert.ok(STATE_CHANGE_TYPES.has(t), `missing ${t}`);
  }
  // run outcomes (run_end, merged, ...) are deliberately absent — they are the outcomes
  // section's business, not state changes.
  assert.ok(!STATE_CHANGE_TYPES.has("run_end"));
  assert.equal(STATE_CHANGE_TOP, 6);
});

test("every event type is replayed or explicitly excluded", () => {
  // STATE_CHANGE_TYPES and STATE_CHANGE_EXCLUDED_TYPES partition EVENT_TYPE_LABELS' keys, so a
  // new event type cannot ship unclassified; either it is a digest-replayed state change or it
  // is named as deliberately excluded.
  assert.deepEqual(
    [...STATE_CHANGE_TYPES].filter((t) => STATE_CHANGE_EXCLUDED_TYPES.has(t)),
    [],
  );
  assert.deepEqual(
    Array.from(new Set([...STATE_CHANGE_TYPES, ...STATE_CHANGE_EXCLUDED_TYPES])).sort(),
    Object.keys(EVENT_TYPE_LABELS).sort(),
  );
  for (const t of STATE_CHANGE_EXCLUDED_TYPES) {
    assert.ok(Object.hasOwn(EVENT_TYPE_LABELS, t), `excluded type ${t} is not an event type`);
  }
});

test("budget_paused leads with the breaker demotion cause when a fallback was demoted", () => {
  // orchestrator.ts emits the demotion pair with the breaker's failure count, so the digest
  // line names both the free pair that died and how many runs it took with it.
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
  const until = Date.UTC(2026, 9, 20, 14, 5, 0);
  assert.equal(
    describeStateChange(ev({ type: "team_paused", until, reason: "deploy freeze" })),
    `team paused — roles start no new runs until ${formatTime(new Date(until))}: deploy freeze`,
  );
  assert.equal(describeStateChange(ev({ type: "team_resumed" })), "team resumed — roles run again");
  assert.equal(
    describeStateChange(ev({ type: "role_paused", role: "steward" })),
    "role steward paused — it starts no new runs",
  );
  const roleUntil = Date.UTC(2026, 9, 20, 12, 0, 0);
  assert.equal(
    describeStateChange(ev({ type: "role_paused", role: "steward", until: roleUntil })),
    `role steward paused — it starts no new runs until ${formatTime(new Date(roleUntil))}`,
  );
  assert.equal(describeStateChange(ev({ type: "role_resumed", role: "steward" })), "role steward resumed — it runs again");
  // A missing role renders as "?" rather than "undefined".
  assert.equal(describeStateChange(ev({ type: "role_paused" })), "role ? paused — it starts no new runs");
});

test("the error-streak and role-cap transitions render their reason", () => {
  // The breaker's auto-pause names the streak depth so the pause connects to the failing
  // runs; without a count the line still renders (?, like the feed's textOr fallback).
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
    "update available (3 commits behind) — restart waits; work continues",
  );
  // A torn or hand-edited log can carry a non-numeric aheadCommits; the digest must not render
  // "NaN commits" (event-format.ts's build_stale line has the same guard).
  const corrupt = describeStateChange(ev({ type: "build_stale", build: "abcdef1234567890", head: "1234567890abcdef", aheadCommits: "twelve" }));
  assert.equal(corrupt, "update available (0 commits behind) — restart waits; work continues");
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
  assert.equal(describeStateChange(ev({ type: "orchestrator_stop", cause: "once" })), "tumwater stopped — the --once round settled");
  assert.equal(describeStateChange(ev({ type: "orchestrator_stop", cause: "signal" })), "tumwater stopped on a stop signal");
  assert.equal(describeStateChange(ev({ type: "orchestrator_stop", cause: "error" })), "tumwater stopped — its polling failed");
  assert.equal(describeStateChange(ev({ type: "orchestrator_stop", cause: "bogus" })), "tumwater stopped");
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
  // plain and progressing run timeouts under this kind (src/failure/failure-cluster.ts).
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

test("the digest names every gate hold and lift", () => {
  // The gate holds/lifts that stop and restart work — low disk, quiet hours, the maintenance
  // allowance and the subscription-window reserve — replay in the digest beside the budget,
  // team and rate-limit gates, so a window in which a floor stopped the team reads as the
  // harness decision it was, not a mere idle.
  assert.equal(
    describeStateChange(ev({ type: "disk_low", freeGB: 3.2, holdGB: 2 })),
    "waiting: low disk — 3.2 GB free (floor 2.0 GB)",
  );
  assert.equal(describeStateChange(ev({ type: "disk_ok", freeGB: 12 })), "disk recovered — 12.0 GB free");
  assert.equal(
    describeStateChange(ev({ type: "quiet_hours_started", window: "23:00-07:00" })),
    "waiting: quiet hours (23:00-07:00)",
  );
  assert.equal(
    describeStateChange(ev({ type: "maintenance_quota_hold", maint: 3, allowance: 4, work: 20 })),
    "waiting: maintenance allowance used — 3/4 in 24h (20 work)",
  );
  assert.equal(
    describeStateChange(ev({ type: "subscription_window_reserved", backend: "claude", windowType: "five_hour", utilization: 0.85, reserve: 0.8 })),
    "waiting: claude window five_hour at 85% past its 80% reserve",
  );
  const limited = describeStateChange(ev({ type: "subscription_window_limited", windowType: "five_hour" }));
  assert.ok(limited.startsWith("waiting: claude window five_hour rejected"), limited);
  assert.equal(describeStateChange(ev({ type: "model_changed", to: "acme/m1" })), "model changed — now acme/m1");
  // A model cleared to pi's default arrives with `to: null`; it must render pi's default,
  // never the degenerate `model changed — now `.
  assert.equal(describeStateChange(ev({ type: "model_changed" })), `model changed — now pi's default`);
  assert.equal(
    describeStateChange(ev({ type: "bootstrap_complete", plansDone: 5, untilPlansDone: 5 })),
    "bootstrap complete — 5/5 plans done",
  );
  // A torn disk_low with no free fields reads through finiteNumber as 0, never NaN/undefined.
  const torn = describeStateChange(ev({ type: "disk_low" }));
  assert.equal(torn, "waiting: low disk — 0.0 GB free (floor 0.0 GB)");
  assert.doesNotMatch(torn, /NaN|undefined/);
  // A torn maintenance_quota_hold with no fields renders empty cells, never "undefined".
  const tornMaint = describeStateChange(ev({ type: "maintenance_quota_hold" }));
  assert.doesNotMatch(tornMaint, /NaN|undefined/);
  // Each line honors the section cap, as every other state-change line does.
  for (const line of [
    describeStateChange(ev({ type: "disk_low", freeGB: 3.2, holdGB: 2 })),
    describeStateChange(ev({ type: "subscription_window_reserved", backend: "claude", windowType: "five_hour", utilization: 0.85, reserve: 0.8 })),
    describeStateChange(ev({ type: "subscription_window_limited", windowType: "five_hour" })),
  ]) {
    assert.ok(line.length <= 72, `under the cap: ${line}`);
  }
});

test("the digest names a tier fallback switch and the budget hand-back", () => {
  // A tier slid onto its fallback pair: the digest names the move beside the pause/hold ones.
  assert.equal(
    describeStateChange(
      ev({ type: "fallback_switched", tiers: { default: { from: "acme/m1", to: "free/llama", reason: "cap" } } }),
    ),
    "fallback switched — default: acme/m1 → free/llama (cap)",
  );
  // A return to the primary arrives with `to: null`; it reads `primary`, never a bare field.
  assert.equal(
    describeStateChange(
      ev({ type: "fallback_switched", tiers: { default: { from: "acme/m1", to: null, reason: "available" } } }),
    ),
    "fallback switched — default: acme/m1 → primary (available)",
  );
  // The budget reopening handed the still-on-fallback roles back to the primary.
  assert.equal(
    describeStateChange(ev({ type: "budget_handback", roles: ["feature", "bugfix"] })),
    "budget reopened — handed feature, bugfix back to the primary",
  );
  // A window reset hands them back the same way, against the subscription_window_reset line.
  assert.equal(
    describeStateChange(ev({ type: "budget_handback", roles: ["feature", "bugfix"], reason: "window" })),
    "window reset — handed feature, bugfix back to the primary",
  );
  // A torn or empty tiers/budget_handback renders compactly, never undefined/NaN.
  const tornTiers = describeStateChange(ev({ type: "fallback_switched", tiers: {} }));
  assert.equal(tornTiers, "fallback switched");
  assert.doesNotMatch(tornTiers, /NaN|undefined/);
  const tornHandback = describeStateChange(ev({ type: "budget_handback" }));
  assert.equal(tornHandback, "budget reopened — handed ? back to the primary");
  assert.doesNotMatch(tornHandback, /NaN|undefined/);
});

test("fallback_switched with more tiers than fit the line cap names every dropped tier", () => {
  // Mirrors config_changed's bounded-drop rule: whole parts drop from the tail with a marker,
  // so a hand-edited tiers object never cuts the marker or a part mid-word.
  const tiers: Record<string, unknown> = {};
  for (let i = 0; i < 8; i++) {
    tiers[`tier${i}`] = { from: "acme/m1", to: "free/llama", reason: "cap" };
  }
  const line = describeStateChange(ev({ type: "fallback_switched", tiers }));
  assert.ok(line.includes("fallback switched —"), line);
  assert.ok(/\+N more tiers|\+\d+ more tiers/.test(line), line);
  assert.ok(line.length <= 72, `under the cap: ${line}`);
});
