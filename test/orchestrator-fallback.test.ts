/** Unit-tier coverage for the orchestrator's fallback-breaker wiring
 * (src/orchestrator/orchestrator.ts's
 * run bookkeeping): a role run made while the budget gate has engaged the free
 * fallback folds its outcome into the breaker (recordFallbackRun), and the demotion that
 * follows failureLimit consecutive failures reaches the observers — the budget_paused event
 * and orchestrator.json's fallbackDemoted. Until now this wiring ran only in no test at any
 * tier: the breaker's state machine has its own unit tests (fallback-breaker.test.ts) and
 * the gate's verdicts theirs (budget-gates.test.ts), but the orchestrator's "the run that
 * ran on the fallback is the breaker's evidence" fold was covered nowhere, so a wiring slip
 * (recording the wrong outcome, or none) would leave a dead fallback trusted forever.
 *
 * The scenario, driven in-process against the fake pi: one $10 run on the primary spends
 * to the cap, the gate engages the free pair, and every later run uses it — the
 * fake pi answers the primary with a compliant nothing-to-do and dies on the fallback pair,
 * so three consecutive errors trip the breaker (FALLBACK_BREAKER_POLICY.failureLimit = 3)
 * before the error-streak breaker (10) or the team hold (two distinct roles) could react.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { loadRunnerState } from "../src/runner/runner-state.js";
import { readOrchestratorInfo } from "../src/team/orchestrator-info.js";
import { FAST_POLL_MS, deadFallbackScenario, fastConfig, makeFastRepo, runRepoOrchestrator } from "./fixtures/orchestrator-fixtures.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";
import { twoPlansDoc } from "./fixtures/repo-fixtures.js";
import { sleep, waitFor } from "./helpers/wait.js";

test("runs on the engaged fallback feed the breaker: three dead-backend errors demote it", async () => {
  const repo = await makeFastRepo("fallback breaker unit test", ["feature"]);
  const cfg = fastConfig(["feature"]);
  cfg.maxDailyCostUsd = 10;
  cfg.fallbackModel = { provider: "free", model: "qwen-free" };
  const cfgPath = path.join(repo, "tumwater.json");
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  // An eligible plan keeps the feature runner going: with none it stands down.
  fs.writeFileSync(path.join(repo, "PLANS.md"), twoPlansDoc());

  // The dead-free-fallback scenario: the modelsPath seam keeps the test off the real ~/.pi
  // definitions, and the fake pi dies on the fallback pair whose demotion the breaker detects.
  const { modelsPath, argsFile, restore } = deadFallbackScenario("fallback");

  const controller = new AbortController();
  const run = runRepoOrchestrator(repo, {
    signal: controller.signal,
    pollMs: FAST_POLL_MS,
    modelsPath,
  });
  const timeout = setTimeout(() => controller.abort(), 45_000);
  timeout.unref();
  try {
    // The primary run spends to the cap; the next poll engages the fallback and says so.
    await waitFor(
      () => eventsOfType(repo, "budget_fallback").length === 1,
      "the budget_fallback event",
    );
    const fallback = eventsOfType(repo, "budget_fallback")[0]!;
    assert.equal(fallback.provider, "free");
    assert.equal(fallback.model, "qwen-free");

    // Every later run uses the free pair and fails; the third consecutive failure
    // trips the breaker and the gate drops to paused, naming the demotion.
    await waitFor(
      () => eventsOfType(repo, "budget_paused").length === 1,
      "the breaker's budget_paused event",
    );
    const paused = eventsOfType(repo, "budget_paused")[0]!;
    assert.equal(paused.fallbackDemoted, "free/qwen-free");
    assert.equal(paused.failures, 3, "failureLimit consecutive failures, team-wide");
    assert.ok(
      typeof paused.spentUsd === "number" && paused.spentUsd >= 10,
      "the pause carries the spend that triggered it",
    );

    // The failing runs really used the fallback: exactly one primary run, the rest on
    // the free pair. Count run markers, not lines — the recorded prompt itself is
    // multi-line, so the argv log is not one line per run.
    const argv = fs.readFileSync(argsFile, "utf8");
    const runs = argv.match(/--print/g)?.length ?? 0;
    const onFallback = argv.match(/--model qwen-free/g)?.length ?? 0;
    assert.ok(onFallback >= 3, `expected the failed runs on the fallback, got ${onFallback}`);
    assert.equal(runs - onFallback, 1, "exactly one run on the primary");

    // The demotion reaches the observers' file, with the failure count that demoted it.
    const info = readOrchestratorInfo(repo);
    assert.equal(info?.fallbackDemoted?.pair, "free/qwen-free");
    assert.equal(info?.fallbackDemoted?.failures, 3);

    // And the demoted pause actually holds: no further role run starts while it stands.
    const runsAtTrip = loadRunnerState(repo, "feature").runs;
    await sleep(600);
    assert.equal(
      loadRunnerState(repo, "feature").runs,
      runsAtTrip,
      "a demoted fallback pauses role runs — the probe waits out its cool-down",
    );
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await run.catch(() => undefined); // shutdown noise must not mask the assertions above
    restore();
  }
});
