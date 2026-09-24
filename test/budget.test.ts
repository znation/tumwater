import test from "node:test";
import assert from "node:assert/strict";
import { freshLoopState } from "../src/state.js";
import {
  abandonFallbackProbe,
  budgetGate,
  budgetPaused,
  budgetReached,
  dailyCost,
  FALLBACK_BREAKER_POLICY,
  type FallbackBreaker,
  fallbackDemotion,
  fallbackEvidence,
  fallbackProbeDue,
  fallbackServing,
  fleetDailyCost,
  IDLE_FALLBACK_BREAKER,
  recordDailyCost,
  recordFallbackTick,
  rekeyFallbackBreaker,
  startFallbackProbe,
  todayStamp,
} from "../src/budget.js";
import { defaultConfig } from "../src/config.js";
import type { TickResult } from "../src/types.js";

/** Two local-time timestamps straddling midnight, built with the local Date constructor so
 * the test holds in any timezone: dayA is an evening, dayB just after local midnight. */
function midnightPair(): { dayA: number; dayB: number } {
  return {
    dayA: new Date(2026, 7, 30, 20, 0, 0).getTime(), // Aug 30, 8 pm local
    dayB: new Date(2026, 7, 31, 0, 0, 1).getTime(), // Aug 31, just after midnight
  };
}

test("recordDailyCost accumulates same-day spend and rolls over at local midnight on write", () => {
  const s = freshLoopState("feature");
  const { dayA, dayB } = midnightPair();

  recordDailyCost(s, 1.5, dayA); // first run of the day (fresh state: no stamp yet)
  assert.equal(s.dayStamp, todayStamp(dayA));
  assert.equal(s.dayCostUsd, 1.5);

  recordDailyCost(s, 0.25, dayA + 3_600_000); // an hour later, same local day
  assert.equal(s.dayStamp, todayStamp(dayA));
  assert.equal(s.dayCostUsd, 1.75);

  // A tick that crosses midnight attributes its spend to the NEW day: the window resets
  // first, so yesterday's $1.75 cannot leak into today's budget (or vice versa).
  recordDailyCost(s, 0.5, dayB);
  assert.equal(s.dayStamp, todayStamp(dayB));
  assert.notEqual(s.dayStamp, todayStamp(dayA));
  assert.equal(s.dayCostUsd, 0.5);
});

test("dailyCost reads $0 for a stale or missing stamp and the window's value when fresh", () => {
  const s = freshLoopState("feature"); // dayStamp "" — never ticked
  assert.equal(dailyCost(s), 0);

  const { dayA, dayB } = midnightPair();
  recordDailyCost(s, 2.5, dayA);
  assert.equal(dailyCost(s, dayA), 2.5); // fresh: the window's value
  assert.equal(dailyCost(s, dayB), 0); // read "tomorrow": stale → $0

  // Reads never mutate — a stale read must not reset or touch the recorded window.
  assert.equal(s.dayStamp, todayStamp(dayA));
  assert.equal(s.dayCostUsd, 2.5);
});

test("fleetDailyCost sums every loop's daily window with stale ones reading $0", () => {
  const { dayA, dayB } = midnightPair();
  const a = freshLoopState("feature");
  recordDailyCost(a, 1.25, dayA); // spent on day A
  const b = freshLoopState("clean"); // never ticked: missing stamp → $0
  const c = freshLoopState("dry");
  recordDailyCost(c, 0.75, dayB); // spent on day B only

  assert.equal(fleetDailyCost([a, b, c], dayA), 1.25);
  assert.equal(fleetDailyCost([a, b, c], dayB), 0.75);
  assert.equal(fleetDailyCost([], dayA), 0);
});

test("budgetPaused is false at cap 0 (disabled) and below the cap, true at/above it", () => {
  const s = freshLoopState("feature");
  const { dayA, dayB } = midnightPair();
  recordDailyCost(s, 10, dayA);

  const cfg = defaultConfig(); // maxDailyCostUsd: 50
  assert.equal(budgetPaused([s], cfg, dayA), false); // $10 < $50

  cfg.maxDailyCostUsd = 10;
  assert.equal(budgetPaused([s], cfg, dayA), true); // exactly at the cap (>=)

  cfg.maxDailyCostUsd = 9.99;
  assert.equal(budgetPaused([s], cfg, dayA), true); // above it

  cfg.maxDailyCostUsd = 0;
  assert.equal(budgetPaused([s], cfg, dayA), false); // 0 disables the budget entirely

  // A stale window reads $0: a fleet that hasn't ticked since yesterday is never paused.
  const other = freshLoopState("clean");
  recordDailyCost(other, 100, dayB);
  cfg.maxDailyCostUsd = 1;
  assert.equal(budgetPaused([other], cfg, dayA), false);
});

test("budgetGate: reached with a free, serving fallback keeps loops running; otherwise they pause", () => {
  // The three facts the gate is made of (plans/fallback-model.md, BUGS.md 2026-09-20). Under
  // the cap nothing else matters — a configured fallback does not take over while there is
  // budget left, serving or not.
  assert.equal(budgetGate(false, false), "open");
  assert.equal(budgetGate(false, true), "open");
  assert.equal(budgetGate(false, true, false), "open");
  // At the cap the fallback decides whether the fleet degrades or stops. Only "paused" blocks
  // a tick, which is why this had to stop being a boolean.
  assert.equal(budgetGate(true, true, true), "fallback");
  assert.equal(budgetGate(true, false), "paused");
  // Free is not usable on its own: this pin used to read budgetGate(true, true) === "fallback"
  // with no way to say "free, but its backend cannot serve" — the 2026-09-19 hour of 33/33
  // failed ticks. A free fallback the breaker demoted pauses the fleet like no fallback at all.
  assert.equal(budgetGate(true, true, false), "paused");
  assert.equal(budgetGate(true, false, false), "paused");
  // Observers (status.ts) fold the demotion into their fallbackReady input and pass no third
  // argument; it defaults to serving so their two-input reading is unchanged.
  assert.equal(budgetGate(true, true), "fallback");
});

const T0 = 1_000_000;
const POLICY = FALLBACK_BREAKER_POLICY;

/** A breaker with the fallback engaged: the pair and the cap it engaged under. */
function engaged(pair = "omlx/qwen", capUsd = 10): FallbackBreaker {
  return rekeyFallbackBreaker(IDLE_FALLBACK_BREAKER, pair, capUsd);
}

/** Fold `results` in order as ordinary (non-probe) fallback ticks, all started under `b`. */
function fold(b: FallbackBreaker, results: TickResult[], now = T0): FallbackBreaker {
  for (const r of results) b = recordFallbackTick(b, b, r, false, now);
  return b;
}

test("fallbackEvidence: only error is a backend failure; only a model reply is served", () => {
  // Exhaustive over TickResult, so a new result value must be classified on purpose.
  const expected: Record<TickResult, "served" | "failed" | "none"> = {
    error: "failed",
    queued: "served",
    changed: "served",
    no_change: "served",
    refused: "served",
    rejected: "served",
    aborted: "none",
    user_aborted: "none",
    skipped: "none",
    main_red: "none",
    quiet_killed: "none",
    merge_conflict: "none",
    merge_blocked: "none",
    review_error: "none",
  };
  for (const [result, evidence] of Object.entries(expected))
    assert.equal(fallbackEvidence(result as TickResult), evidence, result);
});

test("the fallback breaker replays the 2026-09-19 hour: three failures demote the gate to paused", () => {
  // The incident: the cap reached, oMLX priced at zero, and every fallback tick an HTTP 400.
  // Before the breaker the gate read `fallback` for all 33 of them.
  let b = engaged();
  const gate = (x: FallbackBreaker) => budgetGate(true, true, fallbackServing(x));
  assert.equal(gate(b), "fallback", "a freshly engaged fallback is trusted");
  b = fold(b, ["error", "error"]);
  assert.equal(gate(b), "fallback", "two failures are not yet a dead backend");
  assert.equal(b.failures, 2);
  b = fold(b, ["error"]);
  assert.equal(POLICY.failureLimit, 3);
  assert.equal(gate(b), "paused", "the third consecutive failure demotes the fallback");
  assert.equal(b.probeAt, T0 + POLICY.cooldownMs);
  assert.deepEqual(fallbackDemotion(b), { pair: "omlx/qwen", failures: 3, probeAt: T0 + POLICY.cooldownMs });
  // The other 30 ticks of the hour: the ones already in flight at the trip still report, but
  // they cannot extend the cool-down or re-trip anything — and no new tick starts.
  const stragglers = fold(b, ["error", "error"], T0 + 60_000);
  assert.equal(stragglers.probeAt, b.probeAt, "a failed straggler leaves the running cool-down alone");
  assert.equal(gate(stragglers), "paused");
});

test("the fallback breaker counts consecutive failures: any served tick resets the streak", () => {
  // Fleet-wide and consecutive: a healthy backend with a flaky tick never trips it.
  let b = fold(engaged(), ["error", "error", "no_change", "error", "error", "queued", "error"]);
  assert.equal(b.failures, 1);
  assert.equal(fallbackServing(b), true);
  // No-evidence results neither reset nor extend the streak.
  b = fold(engaged(), ["error", "aborted", "quiet_killed", "error", "main_red", "skipped"]);
  assert.equal(b.failures, 2);
  assert.equal(fallbackServing(b), true);
  b = fold(b, ["error"]);
  assert.equal(fallbackServing(b), false, "the third failure trips, however far apart the no-evidence ticks spread them");
});

// A probe the orchestrator admitted but the restart hold's start gate turned away at its
// permit never ran: its claim goes back, or no second probe could ever be admitted and the
// demoted pause would hold until a rekey.
test("an admitted probe that never ran hands its claim back, so the next poll can probe again", () => {
  const tripped = fold(engaged(), ["error", "error", "error"]);
  const probeAt = tripped.probeAt!;
  const probing = startFallbackProbe(tripped);
  assert.equal(fallbackProbeDue(probing, probeAt + 1), false);
  const abandoned = abandonFallbackProbe(probing);
  assert.equal(fallbackProbeDue(abandoned, probeAt + 1), true, "the probe is due again at once");
  assert.equal(fallbackServing(abandoned), false, "no evidence: still demoted");
  assert.equal(abandoned.failures, probing.failures);
});

test("the demoted fallback lets exactly one probe tick through after its cool-down", () => {
  const tripped = fold(engaged(), ["error", "error", "error"]);
  const probeAt = tripped.probeAt!;
  assert.equal(fallbackProbeDue(tripped, probeAt - 1), false, "no probe during the cool-down");
  assert.equal(fallbackProbeDue(tripped, probeAt), true, "half-open once it elapses");
  // The gate stays `paused` through the half-open window and the probe itself: the dashboards
  // read budget paused until the probe has actually served.
  assert.equal(fallbackServing(tripped), false);
  const probing = startFallbackProbe(tripped);
  assert.equal(fallbackProbeDue(probing, probeAt + 1), false, "a second probe waits for the first one's verdict");
  assert.equal(fallbackServing(probing), false);

  // A probe that serves closes the breaker: the gate is `fallback` again and the streak is clear.
  const healed = recordFallbackTick(probing, probing, "no_change", true, probeAt + 5_000);
  assert.equal(fallbackServing(healed), true);
  assert.equal(healed.failures, 0);
  assert.equal(healed.probing, false);
  assert.equal(fallbackDemotion(healed), undefined);
  assert.equal(budgetGate(true, true, fallbackServing(healed)), "fallback");
});

test("each failed probe doubles the cool-down up to its cap; a probe with no evidence frees the slot", () => {
  let b = fold(engaged(), ["error", "error", "error"]);
  const cooldowns: number[] = [b.cooldownMs];
  let now = b.probeAt!;
  for (let i = 0; i < 5; i++) {
    b = startFallbackProbe(b);
    b = recordFallbackTick(b, b, "error", true, now);
    assert.equal(b.probing, false);
    assert.equal(b.probeAt, now + b.cooldownMs, "the next probe waits the new cool-down from the failure");
    cooldowns.push(b.cooldownMs);
    now = b.probeAt!;
  }
  assert.deepEqual(
    cooldowns.map((ms) => ms / 60_000),
    [5, 10, 20, 30, 30, 30],
    "5 min doubling, capped at 30 min",
  );
  assert.equal(POLICY.maxCooldownMs, 30 * 60_000);

  // A probe cut off by a shutdown (or one that never reached the model) says nothing: the slot
  // frees, the elapsed cool-down stands, and the next due role probes instead.
  const probing = startFallbackProbe(b);
  const freed = recordFallbackTick(probing, probing, "aborted", true, now);
  assert.equal(freed.probing, false);
  assert.equal(freed.probeAt, b.probeAt);
  assert.equal(fallbackProbeDue(freed, now), true);
});

test("a served straggler closes a demoted breaker; evidence about another subject is dropped", () => {
  const tripped = fold(engaged(), ["error", "error", "error"]);
  // A tick that started before the trip and then served: the backend demonstrably works.
  assert.equal(fallbackServing(recordFallbackTick(tripped, tripped, "queued", false, T0)), true);
  // A tick that ran on a different pair (or under a different cap) says nothing about this one.
  const other = engaged("omlx/other");
  assert.equal(recordFallbackTick(tripped, other, "queued", false, T0), tripped);
  assert.equal(recordFallbackTick(engaged(), engaged("omlx/qwen", 20), "error", false, T0).failures, 0);
  // Nor does one that started with no fallback engaged.
  assert.equal(recordFallbackTick(tripped, IDLE_FALLBACK_BREAKER, "queued", false, T0), tripped);
});

test("rekeyFallbackBreaker clears a demotion when the cap, the pair, or the day changes", () => {
  const tripped = fold(engaged("omlx/qwen", 10), ["error", "error", "error"]);
  // Same subject, same judgment — the poll-to-poll case.
  assert.equal(rekeyFallbackBreaker(tripped, "omlx/qwen", 10), tripped);
  // Raising the cap (still under spend, so the fallback stays engaged): a fresh, trusted breaker.
  const raised = rekeyFallbackBreaker(tripped, "omlx/qwen", 12);
  assert.equal(fallbackServing(raised), true);
  assert.equal(raised.failures, 0);
  // Pointing fallbackModel somewhere else.
  assert.equal(fallbackServing(rekeyFallbackBreaker(tripped, "omlx/other", 10)), true);
  // Local midnight's budget_resumed (the cap no longer reached), a cap raised above spend, or
  // the pair priced away: no fallback engaged, so nothing is left demoted…
  const idle = rekeyFallbackBreaker(tripped, null, 10);
  assert.deepEqual(idle, IDLE_FALLBACK_BREAKER);
  assert.equal(fallbackDemotion(idle), undefined);
  // …and the next time the cap is reached the same pair starts trusted.
  assert.equal(fallbackServing(rekeyFallbackBreaker(idle, "omlx/qwen", 10)), true);
});

test("budgetReached is false for a disabled (null) or under-cap view, true at/above the cap", () => {
  assert.equal(budgetReached(null), false); // null = budget disabled
  assert.equal(budgetReached({ spentUsd: 10, capUsd: 50 }), false); // below the cap
  assert.equal(budgetReached({ spentUsd: 50, capUsd: 50 }), true); // exactly at the cap (>=)
  assert.equal(budgetReached({ spentUsd: 50.01, capUsd: 50 }), true); // above it
});
