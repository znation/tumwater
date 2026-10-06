/** The fleet-control family of formatEvent tests (src/events/event-format.ts): the events the harness
 * emits as it manages the fleet — the daily-cost budget's transitions (and its per-role cap
 * siblings), the live config changes (maxConcurrent, sessionRetentionDays, edited keys), the
 * operator and breaker pause/resume events, and the fleet-wide 429/backend holds with their
 * kinds. These tests live only here — event-format.test.ts holds no copies of them. They share one rendering
 * contract — a routine state change renders plainly, never with the warning prefix — so they
 * are tested together, apart from the tick/merge/review event lines in event-format.test.ts. */
import test from "node:test";
import assert from "node:assert/strict";
import { formatEvent } from "../src/events/event-format.js";

// The daily cost budget's transition events (plans/daily-cost-budget.md): routine state
// changes like counters_reset — plain lines carrying the spend and cap that triggered them,
// no warning prefix.
test("formatEvent renders the budget warning with the spend phrase and the still-open gate", () => {
  const warned = formatEvent({
    ts: 0,
    loop: "harness",
    type: "budget_warning",
    spentUsd: 40.005,
    capUsd: 50,
  } as never);
  assert.match(warned, /harness\s+budget warning — \$40\.01 of \$50\.00 of the daily cap spent; the gate is still open/);
});

test("formatEvent renders the budget transition events plainly with spend and cap", () => {
  const paused = formatEvent({
    ts: 0,
    loop: "harness",
    type: "budget_paused",
    spentUsd: 50.123,
    capUsd: 50,
  } as never);
  assert.match(paused, /harness\s+budget paused — \$50\.12 of \$50\.00 daily cost reached/);
  assert.ok(!paused.includes("warning"), "a routine state change is not a warning");

  const resumed = formatEvent({
    ts: 0,
    loop: "harness",
    type: "budget_resumed",
    spentUsd: 12.345,
    capUsd: 50,
  } as never);
  assert.match(resumed, /harness\s+budget resumed \(\$12\.35 of \$50\.00 today\)/);

  // The per-role cap transitions (src/gates/role-cap-gates.ts) name the role, its spend vs its
  // cap, and the two lift paths; the resume states the loop ticks again. Fleet-rendering
  // siblings of the budget pause/resume above, so they live here too.
  const rolePaused = formatEvent({
    ts: 0,
    loop: "harness",
    type: "role_cap_paused",
    role: "docs",
    spentUsd: 0.5,
    capUsd: 0.5,
  } as never);
  assert.match(rolePaused, /harness\s+role docs paused — \$0\.50 of \$0\.50 of its daily cap spent/);
  assert.match(rolePaused, /raised or removed in tumwater\.json or the local day rolls over/);
  assert.ok(!rolePaused.includes("warning"), "a routine state change is not a warning");

  const roleResumed = formatEvent({
    ts: 0,
    loop: "harness",
    type: "role_cap_resumed",
    role: "docs",
  } as never);
  assert.match(roleResumed, /harness\s+role docs resumed — it is under its daily cap again and ticks again/);

  // The handback (PLANS.md 2026-09-30): the reopen names which in-flight fallback ticks were
  // handed back to the primary, so the resulting aborted ticks read as the budget reopening.
  const handback = formatEvent({
    ts: 0,
    loop: "harness",
    type: "budget_handback",
    roles: ["steward", "plan"],
  } as never);
  assert.match(handback, /harness\s+budget reopened: handed steward, plan back to the primary/);
  const bareHandback = formatEvent({ ts: 0, loop: "harness", type: "budget_handback" } as never);
  assert.match(bareHandback, /budget reopened: handed \? back to the primary/);

  // A torn or hand-edited event line could carry no payloads; the fallback must still render.
  const bare = formatEvent({ ts: 0, loop: "harness", type: "budget_paused" } as never);
  assert.match(bare, /budget paused — \$0\.00 of \$0\.00 daily cost reached/);

  // The cost n/a fallback (plans/fallback-model.md): a switch names the model that took over,
  // and a pause names a configured fallback the gate refused — the operator's next action.
  const fallback = formatEvent({
    ts: Date.UTC(2026, 0, 2, 3, 4, 5),
    loop: "harness",
    type: "budget_fallback",
    spentUsd: 10.5,
    capUsd: 10,
    provider: "omlx",
    model: "local-free",
  } as never);
  assert.match(
    fallback,
    /harness\s+budget fallback — \$10\.50 of \$10\.00 daily cost reached; role loops continue on omlx\/local-free \(cost n\/a\)/,
  );
  const refused = formatEvent({
    ts: 0,
    loop: "harness",
    type: "budget_paused",
    spentUsd: 10.5,
    capUsd: 10,
    fallbackRejected: "omlx/typo",
  } as never);
  assert.match(refused, /budget paused — \$10\.50 of \$10\.00 daily cost reached \(fallback omlx\/typo is not a cost n\/a model in pi's models\.json\)/);
  // A free fallback the breaker demoted (BUGS.md 2026-09-20): the backend is what to fix, and
  // the fleet retries it on its own — both belong on the line.
  const demoted = formatEvent({
    ts: 0,
    loop: "harness",
    type: "budget_paused",
    spentUsd: 10.5,
    capUsd: 10,
    fallbackDemoted: "omlx/qwen",
    failures: 3,
  } as never);
  assert.match(
    demoted,
    /budget paused — \$10\.50 of \$10\.00 daily cost reached \(fallback omlx\/qwen is not serving — 3 consecutive ticks failed on it; one probe tick retries it after a cool-down\)/,
  );
  assert.ok(!demoted.includes("warning"), "a routine state change is not a warning");
});

// The live concurrency-cap change event (PLANS.md, Live maxConcurrent): a routine state
// change like counters_reset — a plain line carrying from → to in that order, no warning prefix.
test("formatEvent renders the maxConcurrent change event plainly with from and to", () => {
  const line = formatEvent({
    ts: 0,
    loop: "harness",
    type: "max_concurrent_changed",
    from: 1,
    to: 4,
  } as never);
  assert.match(line, /harness\s+maxConcurrent changed: 1 → 4/);
  assert.ok(!line.includes("warning"), "a routine state change is not a warning");

  // A torn or hand-edited event line could carry no payloads; the fallback must still render.
  const bare = formatEvent({ ts: 0, loop: "harness", type: "max_concurrent_changed" } as never);
  assert.match(bare, /maxConcurrent changed:/);
});

// The live session-retention change event (PLANS.md, Live sessionRetentionDays): a routine
// state change like max_concurrent_changed — a plain line carrying from → to, no warning prefix.
test("formatEvent renders the retention change event plainly with from and to", () => {
  const line = formatEvent({
    ts: 0,
    loop: "harness",
    type: "retention_changed",
    from: 30,
    to: 1,
  } as never);
  assert.match(line, /harness\s+sessionRetentionDays changed: 30 → 1/);
  assert.ok(!line.includes("warning"), "a routine state change is not a warning");

  // A torn or hand-edited event line could carry no payloads; the fallback must still render.
  const bare = formatEvent({ ts: 0, loop: "harness", type: "retention_changed" } as never);
  assert.match(bare, /sessionRetentionDays changed:/);
});

// The live config-change event (PLANS.md "Live config-change event"): a routine state change
// like its maxConcurrent/retention siblings — a plain line naming the edited keys, no warning.
test("formatEvent renders the config change event plainly with the edited keys", () => {
  const line = formatEvent({
    ts: 0,
    loop: "harness",
    type: "config_changed",
    keys: ["provider", "thrashTurns"],
  } as never);
  assert.match(line, /harness\s+config changed: provider, thrashTurns/);
  assert.ok(!line.includes("warning"), "a routine state change is not a warning");

  // A torn or hand-edited event line could carry no keys; the fallback must still render.
  const bare = formatEvent({ ts: 0, loop: "harness", type: "config_changed" } as never);
  assert.match(bare, /config changed$/);
  const empty = formatEvent({ ts: 0, loop: "harness", type: "config_changed", keys: [] } as never);
  assert.match(empty, /config changed$/);
});
// Operator-intent gate (src/orchestrator.ts): `tumwater pause`/`resume` log these once per
// transition. Both are routine state changes an operator reads at a glance; the paused line
// states the scope and the director exemption, the resumed line says role ticks are back.
test("formatEvent renders the fleet pause and resume events plainly", () => {
  const paused = formatEvent({ ts: 0, loop: "harness", type: "fleet_paused" } as never);
  assert.match(
    paused,
    /harness\s+fleet paused — role loops stop starting new ticks \(director keeps running\)$/,
    `the pause must state its scope and the director exemption: ${paused}`,
  );
  assert.ok(!paused.includes("warning"), `a deliberate pause is routine, not a warning: ${paused}`);

  const resumed = formatEvent({ ts: 0, loop: "harness", type: "fleet_resumed" } as never);
  assert.match(resumed, /harness\s+fleet resumed — role loops tick again$/, `resume line: ${resumed}`);
  assert.ok(!resumed.includes("warning"), `a resume is routine, not a warning: ${resumed}`);
});

// Per-role pause (`tumwater pause --role <id>`): the fleet pause's narrower sibling. Both lines
// name the role, and the paused line states what stays running — every other role, the
// director included.
test("formatEvent renders the per-role pause and resume events with the role named", () => {
  const paused = formatEvent({ ts: 0, loop: "harness", type: "role_paused", role: "docs" } as never);
  assert.match(
    paused,
    /harness\s+role docs paused — it stops starting new ticks \(the rest of the fleet keeps running\)$/,
    `the pause must name the role and what keeps running: ${paused}`,
  );
  assert.ok(!paused.includes("warning"), `a deliberate pause is routine, not a warning: ${paused}`);

  const resumed = formatEvent({ ts: 0, loop: "harness", type: "role_resumed", role: "docs" } as never);
  assert.match(resumed, /harness\s+role docs resumed — it ticks again$/, `resume line: ${resumed}`);
  assert.ok(!resumed.includes("warning"), `a resume is routine, not a warning: ${resumed}`);

  // role_streak_paused (src/gates/streak-gate.ts): the breaker's pause IS the harness handling the
  // failure — routine with an explanation, like rate_limit_hold, never a warning. It names
  // the streak depth and how to lift it.
  const streakPaused = formatEvent({
    ts: 0,
    loop: "harness",
    type: "role_streak_paused",
    role: "docs",
    streak: 10,
  } as never);
  assert.match(
    streakPaused,
    /harness\s+role docs paused — 10 ticks failed in a row; fix the cause and resume it \(tumwater resume --role <id>\)$/,
    `breaker pause line: ${streakPaused}`,
  );
  assert.ok(!streakPaused.includes("warning"), `the breaker's pause is routine, not a warning: ${streakPaused}`);
});

// Fleet-wide 429 hold (src/fleet/fleet-hold.ts; BUGS.md 2026-09-21 "A 429 storm still has no
// fleet-wide hold"): the hold is the harness handling a storm, so both lines are routine. The
// hold line names who saw the 429s, how long nothing new starts, a relapse when the storm came
// straight back, and the director exemption.
test("formatEvent renders the 429 hold and its re-open plainly", () => {
  const hold = formatEvent({
    ts: 0,
    loop: "harness",
    type: "rate_limit_hold",
    roles: ["bugfix", "coverage"],
    holdMs: 60_000,
    escalation: 0,
  } as never);
  assert.match(
    hold,
    /harness\s+429 hold — bugfix, coverage rate-limited by the provider; role loops on every provider start nothing new for 60s \(director keeps running\)$/,
    `the hold must name its roles, duration and scope: ${hold}`,
  );
  assert.ok(!hold.includes("warning"), `the hold is routine, not a warning: ${hold}`);

  const relapse = formatEvent({
    ts: 0,
    loop: "harness",
    type: "rate_limit_hold",
    roles: ["dry", "feature"],
    holdMs: 15 * 60_000,
    escalation: 4,
  } as never);
  assert.match(relapse, /for 15m \(relapse 4\) \(director keeps running\)$/, `relapse line: ${relapse}`);

  const resumed = formatEvent({ ts: 0, loop: "harness", type: "rate_limit_resumed" } as never);
  assert.match(resumed, /harness\s+429 hold lifted — role loops on every provider tick again$/, `resumed line: ${resumed}`);
});

// The hold's generalization (PLANS.md 2026-09-29): a backend-failure kind renders as a backend
// hold naming the kind, while the rate-limit kind keeps the exact wording every historical
// event has.
test("formatEvent renders a backend hold with its kind, and keeps the 429 wording for rate limits", () => {
  const backend = formatEvent({
    ts: 0,
    loop: "harness",
    type: "rate_limit_hold",
    kind: "connection",
    roles: ["bugfix", "clean"],
    holdMs: 60_000,
    escalation: 0,
  } as never);
  assert.match(
    backend,
    /harness\s+backend hold \(connection error\) — bugfix, clean hit backend failures; role loops on every provider start nothing new for 60s \(director keeps running\)$/,
    `backend hold line: ${backend}`,
  );
  const modelLoad = formatEvent({
    ts: 0, loop: "harness", type: "rate_limit_hold", kind: "model-load", roles: ["dry"], holdMs: 120_000, escalation: 1,
  } as never);
  assert.match(modelLoad, /backend hold \(model load failure\) — dry hit backend failures; role loops on every provider start nothing new for 2m \(relapse 1\)/, `model-load line: ${modelLoad}`);

  // A timeout storm names its own phrase too — the digest pools plain and progressing tick
  // timeouts under this kind, and a timeout hold must not borrow a connection's wording.
  const timeout = formatEvent({
    ts: 0, loop: "harness", type: "rate_limit_hold", kind: "timeout", roles: ["tests"], holdMs: 60_000, escalation: 0,
  } as never);
  assert.match(
    timeout,
    /harness\s+backend hold \(request timed out\) — tests hit backend failures; role loops on every provider start nothing new for 60s \(director keeps running\)$/,
    `timeout hold line: ${timeout}`,
  );
  const timeoutResumed = formatEvent({
    ts: 0, loop: "harness", type: "rate_limit_resumed", kind: "timeout",
  } as never);
  assert.match(
    timeoutResumed,
    /harness\s+backend hold lifted \(request timed out\) — role loops on every provider tick again$/,
    `timeout resumed line: ${timeoutResumed}`,
  );

  // The lift names what actually ended (BUGS.md 2026-09-29): the resumed event carries the
  // ended hold's kind, so a backend hold's re-open must not render as "429 hold lifted".
  const backendResumed = formatEvent({
    ts: 0, loop: "harness", type: "rate_limit_resumed", kind: "connection",
  } as never);
  assert.match(
    backendResumed,
    /harness\s+backend hold lifted \(connection error\) — role loops on every provider tick again$/,
    `backend resumed line: ${backendResumed}`,
  );
  // A rate-limit hold's lift (and a torn resumed line with no kind) keeps the historical wording.
  const rlResumed = formatEvent({
    ts: 0, loop: "harness", type: "rate_limit_resumed", kind: "rate-limit",
  } as never);
  assert.match(rlResumed, /429 hold lifted — role loops on every provider tick again$/, `rate-limit resumed line: ${rlResumed}`);
});
