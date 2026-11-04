// --- src/report/report-usage-fold.ts: the single-event usage folding core ---
// foldUsageEvent is the pure per-event rule shared by the since-window collector and the
// per-day window fold, so the two windows' aggregation cannot drift. These tests pin the
// per-family contract the report relies on: zero-means-absent maps, the positive-only median
// lists, the base-role normalization, and the parallel tallies that are never subtracted.

import test from "node:test";
import assert from "node:assert/strict";
import { foldUsageEvent, type UsageFold, zeroUsageFold } from "../src/report/report-usage-fold.js";
import type { HarnessEvent } from "../src/events/events.js";

/** A fresh accumulator with every field the fold writes, in the shape the day/window
 * collectors hand it. `runs` is set (not left undefined) so the total-run increment is
 * exercised too. */
function fresh(): UsageFold {
  // runs: 0 so the total-run increment is exercised too — see the function comment.
  return { ...zeroUsageFold(), runs: 0 };
}

/** Build a minimal HarnessEvent; the fold reads only the fields each family needs. */
function ev(type: string, extra: Record<string, unknown> = {}): HarnessEvent {
  return { ts: 0, source: "feature", type: type as HarnessEvent["type"], ...extra } as HarnessEvent;
}

test("run_end folds the run count, usage, and the parallel outcome tallies", () => {
  const f = fresh();
  foldUsageEvent(
    f,
    ev("run_end", { source: "feature", result: "changed", tokens: 100, costUsd: 0.5, durationMs: 1000 }),
  );
  // run_end keys by the raw role id (no base-role normalization).
  assert.equal(f.runs, 1);
  assert.deepEqual(f.runsByRole, { feature: 1 });
  assert.equal(f.tokensOut, 100);
  assert.deepEqual(f.tokensByRole, { feature: 100 });
  assert.equal(f.costUsd, 0.5);
  assert.deepEqual(f.costByRole, { feature: 0.5 });
  assert.deepEqual(f.runDurationsMs, [1000]);
  // "changed" is merged-class, so the error tally stays absent.
  assert.deepEqual(f.failedRunsByRole, {});
  assert.deepEqual(f.refusalsByRole, {});
});

test("run_end: an error-class result and a refusal are their own parallel tallies", () => {
  const f = fresh();
  foldUsageEvent(f, ev("run_end", { source: "bugfix", result: "rejected", tokens: 0, costUsd: 0 }));
  foldUsageEvent(f, ev("run_end", { source: "feature", result: "refused", tokens: 0, costUsd: 0 }));
  assert.equal(f.runs, 2);
  assert.deepEqual(f.failedRunsByRole, { bugfix: 1 });
  assert.deepEqual(f.refusalsByRole, { feature: 1 });
  // A zero-cost run leaves no costByRole key (zero-means-absent).
  assert.deepEqual(f.costByRole, {});
});

test("run_end: a result the OUTCOME_CLASS table lacks is a run, not a failed run", () => {
  // A result retired from the digest's OUTCOME_CLASS table while still in the RunResult
  // union (part 4m/3 removes main_red's key; 4k/3 removes the member) keeps counting as a
  // run, but its absence from the table means the error tally must not count it: `===
  // "error"` reads undefined, not "error".
  const f = fresh();
  foldUsageEvent(f, ev("run_end", { source: "feature", result: "retired_code", tokens: 0, costUsd: 0 }));
  assert.equal(f.runs, 1);
  assert.deepEqual(f.runsByRole, { feature: 1 });
  assert.deepEqual(f.failedRunsByRole, {});
  assert.deepEqual(f.refusalsByRole, {});
});

test("run_end: the notional backend comes from agent, else a subscription default", () => {
  const byAgent = fresh();
  foldUsageEvent(
    byAgent,
    ev("run_end", { source: "feature", result: "changed", notionalCostUsd: 2, agent: "codex" }),
  );
  assert.deepEqual(byAgent.notionalByBackend, { codex: 2 });
  assert.equal(byAgent.notionalCostUsd, 2);

  const byDefault = fresh();
  foldUsageEvent(
    byDefault,
    ev("run_end", { source: "feature", result: "changed", notionalCostUsd: 3, billing: "subscription" }),
  );
  assert.deepEqual(byDefault.notionalByBackend, { claude: 3 });

  const unattributed = fresh();
  foldUsageEvent(
    unattributed,
    ev("run_end", { source: "feature", result: "changed", notionalCostUsd: 1 }),
  );
  assert.deepEqual(unattributed.notionalByBackend, {});
});

test("run_end: prompt tokens carry the cache share clamped to the prompt total", () => {
  const f = fresh();
  foldUsageEvent(
    f,
    ev("run_end", { source: "feature", result: "changed", promptTokens: 400, cacheReadTokens: 500 }),
  );
  assert.deepEqual(f.promptTokensByRole, { feature: 400 });
  // A torn cache share above the prompt total is clamped, never recorded above 100%.
  assert.deepEqual(f.cacheReadTokensByRole, { feature: 400 });
});

test("run_end: the providerCost map folds per provider, zero left absent", () => {
  const f = fresh();
  foldUsageEvent(
    f,
    ev("run_end", {
      source: "feature",
      result: "changed",
      providerCost: {
        primary: { costUsd: 1.5, notionalCostUsd: 0.5 },
        free: { costUsd: 0, notionalCostUsd: 0 },
      },
    }),
  );
  assert.deepEqual(f.costByProvider, { primary: 1.5 });
  assert.deepEqual(f.notionalByProvider, { primary: 0.5 });
});

test("review_rejected: one rejection per role, the post-merge subset, a duration when one ran", () => {
  const f = fresh();
  foldUsageEvent(f, ev("review_rejected", { source: "feature", afterMerge: true, durationMs: 800 }));
  foldUsageEvent(f, ev("review_rejected", { source: "bugfix" }));
  assert.deepEqual(f.rejectionsByRole, { feature: 1, bugfix: 1 });
  assert.deepEqual(f.postMergeRejectionsByRole, { feature: 1 });
  // Only the rejection that carried a positive duration joins the median.
  assert.deepEqual(f.reviewDurationsMs, [800]);
});

test("review_verdict: an approval with a duration joins the review median", () => {
  const f = fresh();
  foldUsageEvent(f, ev("review_verdict", { source: "reviewer", durationMs: 600 }));
  assert.deepEqual(f.reviewDurationsMs, [600]);
});

test("revision and image_reroute fold one event per role", () => {
  const f = fresh();
  foldUsageEvent(f, ev("revision", { source: "feature", action: "applied" }));
  foldUsageEvent(f, ev("image_reroute", { source: "qa" }));
  assert.deepEqual(f.revisionsByRole, { feature: 1 });
  assert.deepEqual(f.imageReroutesByRole, { qa: 1 });
});

test("a passing full check joins the check median; a red one counts a failure", () => {
  const f = fresh();
  foldUsageEvent(f, ev("build_check", { scope: "merge", status: "passed", durationMs: 1200 }));
  foldUsageEvent(f, ev("build_check", { scope: "baseline", status: "failed" }));
  // A gate check ran a subset, so it is not a full-suite verdict and folds nothing.
  foldUsageEvent(f, ev("build_check", { scope: "gate", status: "passed", durationMs: 50 }));
  assert.deepEqual(f.checkDurationsMs, [1200]);
  assert.equal(f.checkFailures, 1);
});

test("run_deferred buckets by reason, falling back to no-work", () => {
  const f = fresh();
  foldUsageEvent(f, ev("run_deferred", { source: "readme", reason: "backlog" }));
  foldUsageEvent(f, ev("run_deferred", { source: "readme", reason: "plans-full" }));
  foldUsageEvent(f, ev("run_deferred", { source: "readme" }));
  assert.deepEqual(f.deferredByReason, { backlog: 1, "plans-full": 1, "no-work": 1 });
});

test("merged: one commit, split by base role and by tier", () => {
  const f = fresh();
  foldUsageEvent(f, ev("merged", { source: "feature-2" }));
  foldUsageEvent(f, ev("merged", { source: "director" }));
  foldUsageEvent(f, ev("merged", { source: "readme" }));
  foldUsageEvent(f, ev("merged", { source: "plan" }));
  assert.equal(f.commits, 4);
  assert.deepEqual(f.commitsByRole, { feature: 1, director: 1, readme: 1, plan: 1 });
  // feature and director are work-tier, readme is maintenance, plan is neither.
  assert.equal(f.workCommits, 2);
  assert.equal(f.maintenanceCommits, 1);
});

test("run_start: one tally per configured model, absent model adds none", () => {
  const f = fresh();
  foldUsageEvent(f, ev("run_start", { source: "feature", model: "deepseek-flash" }));
  foldUsageEvent(f, ev("run_start", { source: "feature" }));
  assert.deepEqual(f.runsByModel, { "deepseek-flash": 1 });
});

test("provider/slot/check waits: only positive waits join their medians", () => {
  const f = fresh();
  foldUsageEvent(f, ev("provider_wait", { source: "feature", waitedMs: 30000 }));
  foldUsageEvent(f, ev("slot_wait", { source: "feature", waitedMs: 0 }));
  foldUsageEvent(f, ev("check_wait", { source: "feature", waitedMs: 45000 }));
  assert.deepEqual(f.providerWaitsMs, [30000]);
  assert.deepEqual(f.slotWaitsMs, []);
  assert.deepEqual(f.checkWaitsMs, [45000]);
});

test("merge_done: a merge run, base-role tally, waits, and the merge-only cost share", () => {
  const f = fresh();
  foldUsageEvent(
    f,
    ev("merge_done", {
      source: "feature-2",
      queuedMs: 2000,
      durationMs: 5000,
      tokens: 50,
      costUsd: 1.0,
      notionalByBackend: { codex: 0.4 },
    }),
  );
  assert.equal(f.mergeRuns, 1);
  assert.equal(f.mergeFailed, undefined);
  assert.deepEqual(f.mergedByRole, { feature: 1 });
  assert.deepEqual(f.mergeWaitsMs, [2000]);
  assert.deepEqual(f.mergeDurationsMs, [5000]);
  // Merge usage accumulates into the merge fields, never into costByRole/costUsd.
  assert.equal(f.mergeTokens, 50);
  assert.equal(f.mergeCostUsd, 1.0);
  assert.equal(f.costUsd, 0);
  assert.deepEqual(f.costByRole, {});
  assert.deepEqual(f.notionalByBackend, { codex: 0.4 });
});

test("merge_failed: the failure, its role, and its reason (or unknown)", () => {
  const f = fresh();
  foldUsageEvent(f, ev("merge_failed", { source: "bugfix", result: "rejected" }));
  foldUsageEvent(f, ev("merge_failed", { source: "feature", result: "" }));
  assert.equal(f.mergeRuns, 2);
  assert.equal(f.mergeFailed, 2);
  assert.deepEqual(f.mergeFailedByRole, { bugfix: 1, feature: 1 });
  // A non-empty result names the reason; an empty one folds under "unknown".
  assert.deepEqual(f.mergeFailedByReason, { rejected: 1, unknown: 1 });
});
