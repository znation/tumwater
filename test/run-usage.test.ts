import test from "node:test";
import assert from "node:assert/strict";
import { RunUsage } from "../src/run/run-usage.js";
import { freshRunnerState } from "../src/runner/runner-state.js";
import type { PiRunResult } from "../src/pi/pi-run-result.js";
import type { RunnerState } from "../src/runner/runner-state.js";
import { piRunResult } from "./fakes/fake-pi.js";

// RunUsage's accounting (src/run/run-usage.ts): the once-per-run choke point every pi run of a
// run folds through. Pure in-memory logic — no filesystem, no pi — so each clause is pinned
// directly: lifetime totals on RunnerState, per-run windows on the RunUsage itself, the daily
// budget fold, and the 429 stamp the orchestrator's team-wide hold consumes.

function run(over: Partial<PiRunResult>): PiRunResult {
  return piRunResult({ ...over });
}

test("fold accumulates lifetime totals and per-run counters across runs", () => {
  const s: RunnerState = freshRunnerState("coverage");
  const u = new RunUsage();

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

test("fold sums prompt tokens every run and freezes the pre-edit prefix at the first edit", () => {
  const s: RunnerState = freshRunnerState("coverage");
  const u = new RunUsage();

  // Two authoring runs before any edit: both pre-edit prefixes count.
  u.fold(s, run({ promptTokens: 100, cacheReadTokens: 80, preEditPromptTokens: 100 }));
  // The run that edits: its own (larger) prefix counts, then the counter freezes.
  u.fold(s, run({ promptTokens: 200, cacheReadTokens: 150, preEditPromptTokens: 200, firstEditTurn: 2 }));
  // A resumed run after the edit adds prompt tokens but no pre-edit tokens.
  u.fold(s, run({ promptTokens: 300, cacheReadTokens: 250, preEditPromptTokens: 300, firstEditTurn: 1 }));

  assert.equal(u.promptTokens, 600);
  assert.equal(u.cacheReadTokens, 480);
  assert.equal(u.preEditPromptTokens, 300, "frozen at the editing run's prefix");
});

test("fold's authoring=false (a merge/review run) never advances the pre-edit prefix", () => {
  const s: RunnerState = freshRunnerState("coverage");
  const u = new RunUsage();

  u.fold(s, run({ promptTokens: 100, cacheReadTokens: 80, preEditPromptTokens: 100 }), false);

  assert.equal(u.promptTokens, 100, "prompt tokens count for every run");
  assert.equal(u.cacheReadTokens, 80);
  assert.equal(u.preEditPromptTokens, 0, "a review run's context is not the authoring pre-edit prefix");
});

test("reset clears the prompt-token windows too", () => {
  const s: RunnerState = freshRunnerState("coverage");
  const u = new RunUsage();
  u.fold(s, run({ promptTokens: 100, cacheReadTokens: 80, preEditPromptTokens: 100, firstEditTurn: 1 }));

  u.reset();

  assert.equal(u.promptTokens, 0);
  assert.equal(u.cacheReadTokens, 0);
  assert.equal(u.preEditPromptTokens, 0);
  // A later run in the next run is pre-edit again — the freeze does not survive a reset.
  u.fold(s, run({ promptTokens: 10, preEditPromptTokens: 10 }));
  assert.equal(u.preEditPromptTokens, 10);
});

test("fold feeds the daily cost budget: dayStamp is set and dayCostUsd accumulates", () => {
  const s: RunnerState = freshRunnerState("coverage");
  const u = new RunUsage();

  u.fold(s, run({ costUsd: 0.25 }));
  u.fold(s, run({ costUsd: 0.75 }));

  assert.ok(s.dayStamp);
  assert.equal(s.dayCostUsd, 1.0);
});

test("fold heals a corrupt persisted lifetime counter instead of poisoning it", () => {
  const s: RunnerState = freshRunnerState("coverage");
  // loadRunnerState casts the state file without validating it, so any of these can come back
  // as a foreign type or an out-of-range number.
  (s as { generatedTokens: unknown }).generatedTokens = "123";
  (s as { peakContextTokens: unknown }).peakContextTokens = Number.POSITIVE_INFINITY;
  (s as { totalCostUsd: unknown }).totalCostUsd = -5;
  const u = new RunUsage();

  u.fold(s, run({ outputTokens: 10, peakContextTokens: 4_000, costUsd: 0.5 }));

  assert.equal(s.generatedTokens, 10, "string seed reads as 0, then adds the run");
  assert.equal(s.peakContextTokens, 4_000, "Infinity seed reads as 0, so the run's peak wins");
  assert.equal(s.totalCostUsd, 0.5, "negative seed reads as 0, then adds the run");
});

test("lastRateLimit is stamped only by a run that ENDED on the 429, with the Retry-After hint", () => {
  const s: RunnerState = freshRunnerState("coverage");
  const u = new RunUsage();
  const before = Date.now();

  // A run that merely saw a 429 inside pi's own retry and then finished must not stamp one.
  u.fold(s, run({ transientRateLimit: true, ok: true }));
  assert.equal(Boolean(u.lastRateLimit), false);

  // A failed run that was not a 429 must not stamp one either.
  u.fold(s, run({ ok: false, transientServerTimeout: true }));
  assert.equal(Boolean(u.lastRateLimit), false);

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

test("reset clears the per-run windows but keeps lastRateLimit for the orchestrator's hold", () => {
  const s: RunnerState = freshRunnerState("coverage");
  const u = new RunUsage();
  u.fold(s, run({ turns: 4, costUsd: 0.1, ok: false, transientRateLimit: true }));

  u.reset();

  assert.equal(u.turns, 0);
  assert.equal(u.costUsd, 0);
  // lastRateLimit is an episodic observation, not a per-run window: reset at run start
  // would erase a hold the orchestrator has not polled yet.
  assert.ok(u.lastRateLimit);

  // And the next run's folds start from the cleared windows.
  u.fold(s, run({ turns: 2, costUsd: 0.3 }));
  assert.equal(u.turns, 2);
  assert.equal(u.costUsd, 0.3);
});

// The backend-failure sibling of the lastRateLimit stamp (PLANS.md 2026-09-29): the
// connection/timeout/5xx/model-load kinds the team-wide hold groups storms by, stamped under
// the same rule — only a run that ENDED on the failure.
test("lastBackendFailure is stamped only by a run that ENDED on a backend failure, with the kind", () => {
  const s: RunnerState = freshRunnerState("coverage");
  const u = new RunUsage();
  const before = Date.now();

  // A run that saw a backend failure inside pi's own retry and then finished must not stamp.
  u.fold(s, run({ transientBackend: true, backendKind: "connection", ok: true }));
  assert.equal(Boolean(u.lastBackendFailure), false);

  // A failed run that was a rate limit — not a backend failure — stamps the 429, not this.
  u.fold(s, run({ ok: false, transientRateLimit: true }));
  assert.equal(Boolean(u.lastBackendFailure), false);
  assert.ok(u.lastRateLimit, "the 429 stamp is untouched");

  // The real thing: a run that ended on the backend failure, kind and all.
  u.fold(s, run({ ok: false, transientBackend: true, backendKind: "server" }));
  const be = u.lastBackendFailure as { at: number; kind: string } | undefined;
  assert.ok(be);
  assert.equal(be.kind, "server");
  assert.ok(be.at >= before && be.at <= Date.now());

  // A later clean run does not clear or refresh the observation, like lastRateLimit.
  u.fold(s, run({ ok: true }));
  assert.equal((u.lastBackendFailure as { at: number } | undefined)?.at, be.at);
});

test("reset keeps lastBackendFailure for the orchestrator's hold, like lastRateLimit", () => {
  const s: RunnerState = freshRunnerState("coverage");
  const u = new RunUsage();
  u.fold(s, run({ ok: false, transientBackend: true, backendKind: "model-load" }));
  u.reset();
  assert.ok(u.lastBackendFailure, "an episodic observation survives the per-run reset");
});

// The claude billing split (plans/agent-backends.md part 6a): a subscription run's cost is
// notional and never charges the daily cap; an API run's — or one that saw overage — is real.
test("a subscription run folds its cost into notionalCostUsd, never the daily cap", () => {
  const s: RunnerState = freshRunnerState("coverage");
  const u = new RunUsage();

  u.fold(s, run({ costUsd: 3, billing: "subscription" }));
  u.fold(s, run({ costUsd: 3, billing: "subscription" }));

  assert.equal(u.notionalCostUsd, 6, "subscription spend is API-equivalent");
  assert.equal(u.costUsd, 0, "and never real spend");
  assert.equal(s.dayCostUsd ?? 0, 0, "so the daily cap sees nothing");
  assert.equal(s.totalCostUsd, 6, "but lifetime usage still counts it");
  assert.equal(u.billing, "subscription");
});

test("a subscription run that saw overage charges its cost as real spend", () => {
  const s: RunnerState = freshRunnerState("coverage");
  const u = new RunUsage();

  u.fold(s, run({ costUsd: 3, billing: "subscription", usedOverage: true }));

  assert.equal(u.costUsd, 3, "overage is real money");
  assert.equal(u.notionalCostUsd, 0);
  assert.equal(s.dayCostUsd, 3);
});

test("an API-billed run charges the cap and leaves notional at zero", () => {
  const s: RunnerState = freshRunnerState("coverage");
  const u = new RunUsage();

  u.fold(s, run({ costUsd: 1.5, billing: "api" }));

  assert.equal(u.costUsd, 1.5);
  assert.equal(u.notionalCostUsd, 0);
  assert.equal(s.dayCostUsd, 1.5);
  assert.equal(u.billing, "api");
});

test("fold carries the newest rate windows and reset clears them", () => {
  const s: RunnerState = freshRunnerState("coverage");
  const u = new RunUsage();
  const windows = [{ type: "five_hour", status: "allowed", utilization: 0.4 }];

  u.fold(s, run({ billing: "subscription", rateWindows: windows }));
  assert.deepEqual(u.rateWindows, windows);

  u.reset();
  assert.equal(u.billing, undefined);
  assert.equal(u.rateWindows, undefined);
  assert.equal(u.notionalCostUsd, 0);
});

// The per-provider spend split (plans: per-provider spend in the day report): fold keys each
// run's real/notional cost by the provider it ran on, so the run_end event can say which seam
// of a mixed team spent what. A run whose provider was never resolved attributes nothing.
test("fold splits per-provider spend into providerCost, keyed by provider, guarded on undefined", () => {
  const s: RunnerState = freshRunnerState("coverage");
  const u = new RunUsage();

  // Real spend on the default provider, notional on a claude subscription seam.
  u.fold(s, run({ costUsd: 0.25, billing: "api" }), true, "deepinfra");
  u.fold(s, run({ costUsd: 0.5, billing: "api" }), true, "deepinfra");
  u.fold(s, run({ costUsd: 2, billing: "subscription" }), true, "claude");

  assert.deepEqual(u.serializeProviderCost(), {
    deepinfra: { costUsd: 0.75, notionalCostUsd: 0 },
    claude: { costUsd: 0, notionalCostUsd: 2 },
  });

  // A run whose provider was never resolved attributes nothing, so the split is unchanged.
  u.fold(s, run({ costUsd: 0.1, billing: "api" }));
  assert.deepEqual(u.serializeProviderCost(), {
    deepinfra: { costUsd: 0.75, notionalCostUsd: 0 },
    claude: { costUsd: 0, notionalCostUsd: 2 },
  });

  // reset clears the per-run split alongside costUsd/notionalCostUsd.
  u.reset();
  assert.deepEqual(u.serializeProviderCost(), {});
});

test("fold charges a real run's cost to its pair and leaves dayCostByPair alone for an estimated one", () => {
  const s: RunnerState = freshRunnerState("coverage");
  const u = new RunUsage();
  u.fold(s, run({ costUsd: 2 }), true, "hf", "hf/m");
  u.fold(s, run({ costUsd: 3, billing: "subscription" }), true, "claude", "claude/sonnet");
  assert.deepEqual(s.dayCostByPair, { "hf/m": 2 });
  u.fold(s, run({ costUsd: 3, billing: "subscription", usedOverage: true }), true, "claude", "claude/sonnet");
  assert.deepEqual(s.dayCostByPair, { "hf/m": 2, "claude/sonnet": 3 });
});
