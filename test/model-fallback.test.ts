/** The model-fallback state machine (src/loop/model-fallback.ts, PLANS.md "Model failure
 * fallback, part 1/2"): the trip threshold, the pre-trip clear, the probe window, and the
 * failed-probe backoff — all pure with the clock passed in. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  MODEL_FALLBACK_COOLDOWN_MS,
  MODEL_FALLBACK_FAILURES,
  MODEL_FALLBACK_MAX_COOLDOWN_MS,
  modelFallbackActive,
  modelFallbackProbe,
  modelFallbackVerdict,
  providerFailureReason,
  recordModelFallback,
  type ModelFallbackState,
  type ModelFallbackVerdict,
} from "../src/loop/model-fallback.js";

const fold = (verdict: ModelFallbackVerdict, now: number, probe = false) => ({
  verdict,
  probe,
  now,
  reason: "server",
});

test("two provider failures leave the role on its primary", () => {
  let s: ModelFallbackState | undefined = recordModelFallback(undefined, fold("provider-failure", 100));
  s = recordModelFallback(s, fold("provider-failure", 200));
  assert.equal(s?.failures, 2);
  assert.equal(s?.since, 0);
  assert.equal(modelFallbackActive(s, 200), false);
  assert.equal(modelFallbackProbe(s, 200), false);
});

test("the third consecutive provider failure trips fallback with the default cooldown", () => {
  let s: ModelFallbackState | undefined;
  for (let i = 0; i < MODEL_FALLBACK_FAILURES; i++)
    s = recordModelFallback(s, fold("provider-failure", 100 * (i + 1)));
  assert.ok(s);
  assert.equal(s.failures, 0);
  assert.equal(s.since, 300);
  assert.equal(s.probeAt, 300 + MODEL_FALLBACK_COOLDOWN_MS);
  assert.equal(s.cooldownMs, MODEL_FALLBACK_COOLDOWN_MS);
  assert.equal(s.reason, "server");
  assert.equal(modelFallbackActive(s, 300), true);
  assert.equal(modelFallbackProbe(s, 300), false);
  // The probe opens exactly at probeAt: at that instant ticks run the primary again.
  assert.equal(modelFallbackProbe(s, 300 + MODEL_FALLBACK_COOLDOWN_MS), true);
  assert.equal(modelFallbackActive(s, 300 + MODEL_FALLBACK_COOLDOWN_MS), false);
});

test("an answering run clears the running count", () => {
  const one = recordModelFallback(undefined, fold("provider-failure", 1));
  const two = recordModelFallback(one, fold("provider-failure", 2));
  assert.equal(recordModelFallback(two, fold("answered", 3)), undefined);
});

test("an inconclusive run leaves the running count alone", () => {
  const one = recordModelFallback(undefined, fold("provider-failure", 1));
  const two = recordModelFallback(one, fold("provider-failure", 2));
  assert.equal(recordModelFallback(two, fold("inconclusive", 3)), two, "an abort is no evidence");
});

test("a fallback tick leaves the episode in place, a failed probe doubles, a clean probe ends it", () => {
  let tripped: ModelFallbackState | undefined;
  for (let i = 0; i < MODEL_FALLBACK_FAILURES; i++)
    tripped = recordModelFallback(tripped, fold("provider-failure", i + 1));
  assert.ok(tripped);
  const afterFallbackTick = recordModelFallback(tripped, fold("provider-failure", 10, false));
  assert.equal(afterFallbackTick, tripped, "a fallback tick neither returns nor re-trips");
  const afterFailedProbe = recordModelFallback(tripped, fold("provider-failure", 20, true));
  assert.equal(afterFailedProbe?.cooldownMs, MODEL_FALLBACK_COOLDOWN_MS * 2);
  assert.equal(afterFailedProbe?.probeAt, 20 + MODEL_FALLBACK_COOLDOWN_MS * 2);
  assert.equal(recordModelFallback(tripped, fold("answered", 30, true)), undefined);
});

test("an inconclusive probe leaves the episode active so the next tick re-probes", () => {
  const tripped: ModelFallbackState = {
    failures: 0,
    since: 1,
    probeAt: 1,
    cooldownMs: MODEL_FALLBACK_COOLDOWN_MS,
    reason: "server",
  };
  assert.equal(recordModelFallback(tripped, fold("inconclusive", 100, true)), tripped);
  assert.equal(modelFallbackProbe(tripped, 100), true, "the due probe stays due");
});

test("a failed probe doubles the cooldown up to the cap", () => {
  const base: ModelFallbackState = {
    failures: 0,
    since: 1,
    probeAt: 1,
    cooldownMs: 20 * 60_000,
    reason: "server",
  };
  const next = recordModelFallback(base, fold("provider-failure", 1000, true));
  assert.equal(next?.cooldownMs, MODEL_FALLBACK_MAX_COOLDOWN_MS);
  assert.equal(next?.probeAt, 1000 + MODEL_FALLBACK_MAX_COOLDOWN_MS);
});

test("modelFallbackVerdict reads provider evidence from the run, not the tick", () => {
  const base = {
    ok: false,
    transientRateLimit: false,
    transientBackend: false,
    aborted: false,
    quietKilled: false,
    timedOut: false,
  };
  assert.equal(modelFallbackVerdict({ ...base, transientBackend: true }), "provider-failure");
  assert.equal(modelFallbackVerdict({ ...base, transientRateLimit: true }), "provider-failure");
  assert.equal(modelFallbackVerdict({ ...base, ok: true }), "answered");
  // The harness killed it: no verdict about the primary, even with provider evidence.
  assert.equal(
    modelFallbackVerdict({ ...base, transientBackend: true, quietKilled: true }),
    "inconclusive",
  );
  assert.equal(modelFallbackVerdict({ ...base, aborted: true }), "inconclusive");
  assert.equal(modelFallbackVerdict({ ...base, timedOut: true }), "inconclusive");
});

test("providerFailureReason names a 429 rate-limit and a backend kind", () => {
  assert.equal(providerFailureReason(true, "server"), "rate-limit");
  assert.equal(providerFailureReason(false, "server"), "server");
  assert.equal(providerFailureReason(false, undefined), "backend failure");
});
