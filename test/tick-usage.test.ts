import test from "node:test";
import assert from "node:assert/strict";
import { TickUsage } from "../src/tick-usage.js";
import { freshLoopState } from "../src/state.js";
import type { LoopState, PiRunResult } from "../src/types.js";
import { piRunResult } from "./fake-pi.js";

// TickUsage's accounting (src/tick-usage.ts): the once-per-run choke point every pi run of a
// tick folds through. Pure in-memory logic — no filesystem, no pi — so each clause is pinned
// directly: lifetime totals on LoopState, per-tick windows on the TickUsage itself, the daily
// budget fold, and the 429 stamp the orchestrator's fleet-wide hold consumes.

function run(over: Partial<PiRunResult>): PiRunResult {
  return piRunResult({ ...over });
}

test("fold accumulates lifetime totals and per-tick counters across runs", () => {
  const s: LoopState = freshLoopState("coverage");
  const u = new TickUsage();

  u.fold(s, run({ outputTokens: 100, peakContextTokens: 5_000, costUsd: 0.01, turns: 3 }));
  u.fold(s, run({ outputTokens: 50, peakContextTokens: 9_000, costUsd: 0.02, turns: 2 }));
  u.fold(s, run({ outputTokens: 10, peakContextTokens: 1_000, costUsd: 0.005, turns: 1 }));

  assert.equal(s.generatedTokens, 160);
  // Costs are IEEE-754 sums (0.01 + 0.02 + 0.005), so compare within float noise.
  assert.ok(Math.abs(s.totalCostUsd - 0.035) < 1e-12);
  assert.equal(u.turns, 6);
  assert.ok(Math.abs(u.costUsd - 0.035) < 1e-12);
  // Peak context is a high-water mark, not a sum: the largest single run wins.
  assert.equal(s.peakContextTokens, 9_000);
});

test("fold feeds the daily cost budget: dayStamp is set and dayCostUsd accumulates", () => {
  const s: LoopState = freshLoopState("coverage");
  const u = new TickUsage();

  u.fold(s, run({ costUsd: 0.25 }));
  u.fold(s, run({ costUsd: 0.75 }));

  assert.ok(s.dayStamp);
  assert.equal(s.dayCostUsd, 1.0);
});

test("lastRateLimit is stamped only by a run that ENDED on the 429, with the Retry-After hint", () => {
  const s: LoopState = freshLoopState("coverage");
  const u = new TickUsage();
  const before = Date.now();

  // A run that merely saw a 429 inside pi's own retry and then finished must not stamp one.
  u.fold(s, run({ transientRateLimit: true, ok: true }));
  assert.equal(!!u.lastRateLimit, false);

  // A failed run that was not a 429 must not stamp one either.
  u.fold(s, run({ ok: false, transientServerTimeout: true }));
  assert.equal(!!u.lastRateLimit, false);

  // The real thing: a run that ended on the provider's 429.
  u.fold(s, run({ ok: false, transientRateLimit: true, retryAfterSeconds: 30 }));
  const rl = u.lastRateLimit as { at: number; retryAfterSeconds?: number } | undefined;
  assert.ok(rl);
  assert.equal(rl.retryAfterSeconds, 30);
  assert.ok(rl.at >= before && rl.at <= Date.now());

  // A later non-429 run does not clear or refresh the observation: it stays until a new 429.
  const stampedAt = rl.at;
  u.fold(s, run({ ok: true }));
  assert.equal((u.lastRateLimit as { at: number } | undefined)?.at, stampedAt);
});

test("reset clears the per-tick windows but keeps lastRateLimit for the orchestrator's hold", () => {
  const s: LoopState = freshLoopState("coverage");
  const u = new TickUsage();
  u.fold(s, run({ turns: 4, costUsd: 0.1, ok: false, transientRateLimit: true }));

  u.reset();

  assert.equal(u.turns, 0);
  assert.equal(u.costUsd, 0);
  // lastRateLimit is an episodic observation, not a per-tick window: reset at tick start
  // would erase a hold the orchestrator has not polled yet.
  assert.ok(u.lastRateLimit);

  // And the next tick's folds start from the cleared windows.
  u.fold(s, run({ turns: 2, costUsd: 0.3 }));
  assert.equal(u.turns, 2);
  assert.equal(u.costUsd, 0.3);
});
