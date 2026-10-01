/** Unit-tier coverage for the orchestrator's fallback-breaker wiring (src/orchestrator.ts's
 * tick bookkeeping): a role tick that runs while the budget gate has engaged the free
 * fallback folds its outcome into the breaker (recordFallbackTick), and the demotion that
 * follows failureLimit consecutive failures reaches the observers — the budget_paused event
 * and orchestrator.json's fallbackDemoted. Until now this wiring ran only in no test at any
 * tier: the breaker's state machine has its own unit tests (fallback-breaker.test.ts) and
 * the gate's verdicts theirs (budget-gates.test.ts), but the orchestrator's "the tick that
 * ran on the fallback is the breaker's evidence" fold was covered nowhere, so a wiring slip
 * (recording the wrong outcome, or none) would leave a dead fallback trusted forever.
 *
 * The scenario, driven in-process against the fake pi: one $10 tick on the primary spends
 * to the cap, the gate engages the free pair, and every tick from then on runs on it — the
 * fake pi answers the primary with a compliant nothing-to-do and dies on the fallback pair,
 * so three consecutive errors trip the breaker (FALLBACK_BREAKER_POLICY.failureLimit = 3)
 * before the error-streak breaker (10) or the fleet hold (two distinct roles) could react.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { loadLoopState } from "../src/loop-state.js";
import { readOrchestratorInfo } from "../src/fleet-state.js";
import { FAST_POLL_MS, fastConfig, makeFastRepo, runRepoOrchestrator } from "./orchestrator-fixtures.js";
import { fakePi } from "./fake-pi.js";
import { assistantLine } from "./pi-events.js";
import { eventsOfType } from "./log-fixtures.js";
import { tmpdir } from "./repo-fixtures.js";
import { waitFor } from "./wait.js";

test("ticks on the engaged fallback feed the breaker: three dead-backend errors demote it", async () => {
  const repo = await makeFastRepo("fallback breaker unit test", ["feature"]);
  const cfg = fastConfig(["feature"]);
  cfg.maxDailyCostUsd = 10;
  cfg.fallbackModel = { provider: "free", model: "qwen-free" };
  const cfgPath = path.join(repo, "tumwater.json");
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));

  // pi's model catalog, pricing the fallback pair at zero (an absent cost is free) — the
  // modelsPath seam keeps the test off the real ~/.pi definitions.
  const modelsPath = path.join(tmpdir("fallback-models-"), "models.json");
  fs.mkdirSync(path.dirname(modelsPath), { recursive: true });
  fs.writeFileSync(
    modelsPath,
    JSON.stringify({ providers: { free: { models: [{ id: "qwen-free" }] } } }),
  );

  // The fake pi records each run's argv, serves the primary a $10 nothing-to-do, and dies
  // on the fallback pair — the dead backend the breaker exists to detect.
  const argsFile = path.join(tmpdir("fallback-args-"), "argv.log");
  const script =
    `echo "$@" >> '${argsFile}'\n` +
    `for a in "$@"; do case "$a" in qwen-free) echo 'fallback backend dead' >&2; exit 1;; esac; done\n` +
    `printf '%s\\n' '${assistantLine("TUMWATER_NOTHING_TO_DO", { cost: 10 })}'`;
  const restore = fakePi(script);

  const controller = new AbortController();
  const run = runRepoOrchestrator(repo, {
    signal: controller.signal,
    pollMs: FAST_POLL_MS,
    modelsPath,
  });
  const timeout = setTimeout(() => controller.abort(), 45_000);
  timeout.unref();
  try {
    // The primary tick spends to the cap; the next poll engages the fallback and says so.
    await waitFor(
      () => eventsOfType(repo, "budget_fallback").length === 1,
      "the budget_fallback event",
    );
    const fallback = eventsOfType(repo, "budget_fallback")[0]!;
    assert.equal(fallback.provider, "free");
    assert.equal(fallback.model, "qwen-free");

    // Every tick from here runs on the free pair and fails; the third consecutive failure
    // trips the breaker and the gate drops to paused, naming the demotion.
    await waitFor(
      () => eventsOfType(repo, "budget_paused").length === 1,
      "the breaker's budget_paused event",
    );
    const paused = eventsOfType(repo, "budget_paused")[0]!;
    assert.equal(paused.fallbackDemoted, "free/qwen-free");
    assert.equal(paused.failures, 3, "failureLimit consecutive failures, fleet-wide");
    assert.ok(
      typeof paused.spentUsd === "number" && paused.spentUsd >= 10,
      "the pause carries the spend that triggered it",
    );

    // The failing ticks really ran on the fallback: exactly one primary run, the rest on
    // the free pair. Count run markers, not lines — the recorded prompt itself is
    // multi-line, so the argv log is not one line per run.
    const argv = fs.readFileSync(argsFile, "utf8");
    const runs = argv.match(/--print/g)?.length ?? 0;
    const onFallback = argv.match(/--model qwen-free/g)?.length ?? 0;
    assert.ok(onFallback >= 3, `expected the failed ticks on the fallback, got ${onFallback}`);
    assert.equal(runs - onFallback, 1, "exactly one run on the primary");

    // The demotion reaches the observers' file, with the failure count that demoted it.
    const info = readOrchestratorInfo(repo);
    assert.equal(info?.fallbackDemoted?.pair, "free/qwen-free");
    assert.equal(info?.fallbackDemoted?.failures, 3);

    // And the demoted pause actually holds: no further role tick starts while it stands.
    const ticksAtTrip = loadLoopState(repo, "feature").ticks;
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(
      loadLoopState(repo, "feature").ticks,
      ticksAtTrip,
      "a demoted fallback pauses role ticks — the probe waits out its cool-down",
    );
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await run.catch(() => undefined); // shutdown noise must not mask the assertions above
    restore();
  }
});
