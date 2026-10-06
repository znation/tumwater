import test from "node:test";
import assert from "node:assert/strict";
import {
  FALLBACK_BREAKER_POLICY,
  IDLE_FALLBACK_BREAKER,
  abandonFallbackProbe,
  fallbackDemotion,
  fallbackEvidence,
  fallbackProbeDue,
  fallbackServing,
  recordFallbackTick,
  rekeyFallbackBreaker,
  startFallbackProbe,
  type FallbackBreaker,
  type FallbackBreakerPolicy,
} from "../src/fallback-breaker.js";

/** The fallback circuit breaker's tests (src/fallback-breaker.ts): the rekey rules (a changed
 * subject re-trusts), the half-open probe admission, the evidence vocabulary, and the fold of
 * one finished tick — trips, served closes from any state, failed probes double the cool-down
 * up to the cap, stragglers leave the running cool-down alone. */

/** A small policy so doubling arithmetic is easy to read; the thresholds' real values are
 * asserted against FALLBACK_BREAKER_POLICY separately. */
const policy: FallbackBreakerPolicy = { failureLimit: 3, cooldownMs: 100, maxCooldownMs: 300 };

/** A trusted breaker for an engaged pair. */
function closed(pair = "free/qwen", capUsd = 5): FallbackBreaker {
  return { ...IDLE_FALLBACK_BREAKER, pair, capUsd };
}

/** A demoted breaker whose first cool-down started at `probeAt`. */
function demoted(probeAt = 1_000, cooldownMs = 100, failures = 3): FallbackBreaker {
  return { pair: "free/qwen", capUsd: 5, failures, probeAt, cooldownMs, probing: false };
}

test("the shipped policy is the 2026-09-19 incident's arithmetic", () => {
  assert.deepEqual(FALLBACK_BREAKER_POLICY, { failureLimit: 3, cooldownMs: 5 * 60_000, maxCooldownMs: 30 * 60_000 });
});

test("rekey keeps the same breaker while the subject is unchanged, re-trusts on any change", () => {
  const b = closed("free/qwen", 5);
  // Same pair and cap: the running judgment survives the poll.
  assert.equal(rekeyFallbackBreaker(b, "free/qwen", 5), b);
  // No fallback engaged either poll: same idle breaker.
  const idle = { ...IDLE_FALLBACK_BREAKER };
  assert.equal(rekeyFallbackBreaker(idle, null, 0), idle);
  // A new pair (or cap) is a new subject: fresh and trusted, carrying the new subject.
  const newPair = rekeyFallbackBreaker(demoted(), "other/mini", 5);
  assert.deepEqual(newPair, { pair: "other/mini", capUsd: 5, failures: 0, probeAt: null, cooldownMs: 0, probing: false });
  const newCap = rekeyFallbackBreaker(demoted(), "free/qwen", 10);
  assert.deepEqual(newCap, { pair: "free/qwen", capUsd: 10, failures: 0, probeAt: null, cooldownMs: 0, probing: false });
  // Leaving the fallback (midnight's budget_resumed) clears the demotion and the cap.
  const left = rekeyFallbackBreaker(demoted(), null, 5);
  assert.deepEqual(left, { ...IDLE_FALLBACK_BREAKER, pair: null, capUsd: 0 });
});

test("fallbackServing is false exactly while the breaker holds a demotion, probe included", () => {
  assert.equal(fallbackServing(IDLE_FALLBACK_BREAKER), true);
  assert.equal(fallbackServing(closed()), true);
  assert.equal(fallbackServing(demoted()), false);
  assert.equal(fallbackServing(startFallbackProbe(demoted())), false);
});

test("fallbackProbeDue admits one tick only after the cool-down, only with a demotion and no probe in flight", () => {
  assert.equal(fallbackProbeDue(IDLE_FALLBACK_BREAKER, 10_000), false); // no fallback engaged
  assert.equal(fallbackProbeDue(closed(), 10_000), false); // trusted: no probe needed
  assert.equal(fallbackProbeDue(demoted(5_000), 4_999), false); // still cooling down
  assert.equal(fallbackProbeDue(demoted(5_000), 5_000), true); // the cool-down's boundary admits
  assert.equal(fallbackProbeDue(startFallbackProbe(demoted(5_000)), 6_000), false); // one at a time
});

test("startFallbackProbe marks the slot busy; abandon hands it back without touching the cool-down", () => {
  const started = startFallbackProbe(demoted(5_000));
  assert.deepEqual(started, { pair: "free/qwen", capUsd: 5, failures: 3, probeAt: 5_000, cooldownMs: 100, probing: true });
  const abandoned = abandonFallbackProbe(started);
  assert.deepEqual(abandoned, demoted(5_000)); // due again at the next poll, cool-down intact
});

test("fallbackEvidence maps the TickResult vocabulary: error alone fails, a model reply serves, kills and landing results say nothing", () => {
  assert.equal(fallbackEvidence("error"), "failed");
  for (const served of ["queued", "changed", "no_change", "refused", "rejected"] as const) {
    assert.equal(fallbackEvidence(served), "served", served);
  }
  for (const none of [
    "merge_conflict",
    "merge_blocked",
    "review_error",
    "aborted",
    "quiet_killed",
    "user_aborted",
    "main_red",
    "skipped",
  ] as const) {
    assert.equal(fallbackEvidence(none), "none", none);
  }
});

test("recordFallbackTick drops evidence about a subject that is not the engaged one", () => {
  const b = closed();
  // The tick ran while no fallback was engaged.
  assert.equal(recordFallbackTick(b, IDLE_FALLBACK_BREAKER, "error", false, 1_000), b);
  // The tick ran on the previous pair, but the operator repointed fallbackModel mid-tick.
  assert.equal(recordFallbackTick(b, closed("old/free", 5), "error", false, 1_000), b);
  // The tick ran on the previous cap, but the operator raised it mid-tick.
  assert.equal(recordFallbackTick(b, closed("free/qwen", 4), "error", false, 1_000), b);
  // Nothing was recorded either way.
  assert.deepEqual(b, closed());
});

test("recordFallbackTick closes the breaker from any state when a tick served", () => {
  const demotedProbing = startFallbackProbe(demoted(5_000));
  assert.deepEqual(recordFallbackTick(demotedProbing, demotedProbing, "no_change", true, 6_000), {
    pair: "free/qwen",
    capUsd: 5,
    failures: 0,
    probeAt: null,
    cooldownMs: 0,
    probing: false,
  });
  // A served straggler from before the trip also re-trusts at once.
  const demotedIdle = demoted(5_000);
  assert.deepEqual(recordFallbackTick(demotedIdle, demotedIdle, "changed", false, 6_000), {
    pair: "free/qwen",
    capUsd: 5,
    failures: 0,
    probeAt: null,
    cooldownMs: 0,
    probing: false,
  });
});

test("recordFallbackTick counts failures while closed and trips at the limit, opening the first cool-down", () => {
  let b = closed();
  const at = 10_000;
  b = recordFallbackTick(b, b, "error", false, at, policy);
  assert.deepEqual(b, { pair: "free/qwen", capUsd: 5, failures: 1, probeAt: null, cooldownMs: 0, probing: false });
  b = recordFallbackTick(b, b, "error", false, at, policy);
  assert.equal(b.probeAt, null); // one below the limit: still trusted
  b = recordFallbackTick(b, b, "error", false, at, policy);
  assert.deepEqual(b, { pair: "free/qwen", capUsd: 5, failures: 3, probeAt: at + policy.cooldownMs, cooldownMs: policy.cooldownMs, probing: false });
  // The shipped policy trips on the third failure too, five minutes out.
  let shipped = closed();
  for (let i = 0; i < FALLBACK_BREAKER_POLICY.failureLimit; i++) shipped = recordFallbackTick(shipped, shipped, "error", false, at);
  assert.equal(shipped.probeAt, at + FALLBACK_BREAKER_POLICY.cooldownMs);
});

test("recordFallbackTick leaves a failed straggler's running cool-down alone", () => {
  // The straggler started under the closed breaker (probe false) but reports after the trip.
  const b = recordFallbackTick(demoted(20_000, 100, 3), closed(), "error", false, 21_000, policy);
  assert.deepEqual(b, { pair: "free/qwen", capUsd: 5, failures: 4, probeAt: 20_000, cooldownMs: 100, probing: false });
});

test("recordFallbackTick doubles a failed probe's cool-down, capped, and re-opens the breaker", () => {
  const started = startFallbackProbe(demoted(5_000, 100, 3));
  const first = recordFallbackTick(started, started, "error", true, 6_000, policy);
  assert.deepEqual(first, { pair: "free/qwen", capUsd: 5, failures: 4, probeAt: 6_000 + 200, cooldownMs: 200, probing: false });
  // The next failed probe doubles again...
  const second = recordFallbackTick(startFallbackProbe(first), startFallbackProbe(first), "error", true, 8_000, policy);
  assert.deepEqual(second, { pair: "free/qwen", capUsd: 5, failures: 5, probeAt: 8_000 + 300, cooldownMs: 300, probing: false });
  // ...and then the cap holds instead of growing without bound.
  const third = recordFallbackTick(startFallbackProbe(second), startFallbackProbe(second), "error", true, 12_000, policy);
  assert.deepEqual(third, { pair: "free/qwen", capUsd: 5, failures: 6, probeAt: 12_000 + 300, cooldownMs: 300, probing: false });
});

test("recordFallbackTick frees the probe slot when the probe produced no evidence", () => {
  const started = startFallbackProbe(demoted(5_000, 100, 3));
  const b = recordFallbackTick(started, started, "aborted", true, 6_000, policy);
  assert.deepEqual(b, { pair: "free/qwen", capUsd: 5, failures: 3, probeAt: 5_000, cooldownMs: 100, probing: false });
  // A non-probe tick with no evidence changes nothing at all.
  const demotedIdle = demoted(5_000);
  assert.equal(recordFallbackTick(demotedIdle, demotedIdle, "main_red", false, 6_000, policy), demotedIdle);
});

test("fallbackDemotion publishes a demotion and nothing while trusted or unengaged", () => {
  assert.equal(fallbackDemotion(IDLE_FALLBACK_BREAKER), undefined);
  assert.equal(fallbackDemotion(closed()), undefined);
  assert.deepEqual(fallbackDemotion(demoted(20_000, 100, 3)), { pair: "free/qwen", failures: 3, probeAt: 20_000 });
});

// --- the breaker map (part 5b/8): one judgment per pair, shared by the tiers on it ---

import {
  abandonFallbackProbeAt,
  fallbackProbeDuePair,
  fallbackServingPair,
  recordFallbackTickAt,
  rekeyFallbackBreakers,
  startFallbackProbeAt,
  type FallbackBreakerMap,
} from "../src/fallback-breaker.js";

test("rekeyFallbackBreakers re-keys per pair, adds fresh entries, and drops pairs that left", () => {
  const held = { ...demoted(), pair: "free/qwen", capUsd: 5 };
  const other = { ...closed("other/mini", 5), failures: 1 };
  const map: FallbackBreakerMap = { "free/qwen": held, "other/mini": other };
  // Same pairs, same cap: both judgments survive, re-keyed per pair.
  const kept = rekeyFallbackBreakers(map, ["free/qwen", "other/mini"], 5);
  assert.equal(kept["free/qwen"], held);
  assert.equal(kept["other/mini"], other);
  // A raised cap is a new subject for every pair: fresh and trusted.
  const raised = rekeyFallbackBreakers(map, ["free/qwen", "other/mini"], 10);
  assert.deepEqual(raised["free/qwen"], { pair: "free/qwen", capUsd: 10, failures: 0, probeAt: null, cooldownMs: 0, probing: false });
  // A pair that left the resolution loses its entry; a new one starts trusted.
  const moved = rekeyFallbackBreakers(map, ["other/mini", "third/mini"], 5);
  assert.equal(moved["free/qwen"], undefined);
  assert.equal(moved["other/mini"], other);
  assert.deepEqual(moved["third/mini"], { pair: "third/mini", capUsd: 5, failures: 0, probeAt: null, cooldownMs: 0, probing: false });
  // No pairs at all: the empty map.
  assert.deepEqual(rekeyFallbackBreakers(map, [], 5), {});
});

test("fallbackServingPair reads only the named pair's entry, so tiers sharing a pair share the verdict", () => {
  const map: FallbackBreakerMap = { "free/qwen": demoted(), "other/mini": closed("other/mini") };
  assert.equal(fallbackServingPair(map, "free/qwen"), false, "the demoted pair is not serving");
  assert.equal(fallbackServingPair(map, "other/mini"), true, "the trusted pair keeps serving");
  assert.equal(fallbackServingPair(map, null), false, "no pair engaged, no verdict");
  assert.equal(fallbackServingPair(map, "gone/pair"), false, "a pair the resolution dropped has no verdict");
});

test("the probe admission and evidence fold run on the named pair's entry", () => {
  const map: FallbackBreakerMap = { "free/qwen": demoted(0, 100, 3), "other/mini": closed("other/mini") };
  assert.equal(fallbackProbeDuePair(map, 1_000), "free/qwen", "the due pair is found");
  assert.equal(fallbackProbeDuePair({ "other/mini": closed("other/mini") }, 1_000), null, "a trusted map has no probe due");
  const probing = startFallbackProbeAt(map, "free/qwen");
  assert.equal(probing["free/qwen"]?.probing, true);
  assert.equal(probing["other/mini"], map["other/mini"], "the other pair's entry is untouched");
  // A probe whose tick never ran has its claim handed back, on its pair only.
  const abandoned = abandonFallbackProbeAt(probing, "free/qwen");
  assert.equal(abandoned["free/qwen"]?.probing, false);
  assert.equal(abandoned["other/mini"], map["other/mini"]);
  // The probe served: the entry closes; the other pair's breaker keeps its state.
  const served = recordFallbackTickAt(probing, "free/qwen", map["free/qwen"]!, "changed", true, 1_001, policy);
  assert.deepEqual(served["free/qwen"], { pair: "free/qwen", capUsd: 5, failures: 0, probeAt: null, cooldownMs: 0, probing: false });
  assert.equal(served["other/mini"], map["other/mini"]);
  // A failed probe doubles only its own pair's cool-down.
  const failed = recordFallbackTickAt(probing, "free/qwen", map["free/qwen"]!, "error", true, 1_001, policy);
  assert.equal(failed["free/qwen"]?.probeAt, 1_201);
  assert.equal(failed["other/mini"]?.probeAt, null);
  // An entry the rekey dropped mid-flight: nothing to fold into, the map stands.
  const dropped = recordFallbackTickAt({}, "free/qwen", demoted(), "error", true, 1_001, policy);
  assert.deepEqual(dropped, {});
});
