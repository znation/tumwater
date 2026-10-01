/** Unit-tier coverage for the orchestrator's self-redeploy wiring (src/orchestrator.ts's
 * `if (redeploy)` block): the policy's verdict gates the fleet — a `hold` starts no new ticks
 * and its lift resumes them, a `restart` ends the run with restart: true — and the policy's
 * status() is published into orchestrator.json, at startup and again whenever it changes. The
 * gating `npm test` never ran this path; the redeploy e2e tier covers it, but only under
 * `npm run test:e2e`, so the shape was only implied by the orchestrator's source. A scripted
 * fake Redeployer keeps the tier's focus on the orchestrator's own decisions, not the policy's
 * state machine (redeploy-policy.ts has its own tests). */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { runOrchestrator } from "../src/orchestrator.js";
import { loadConfig } from "../src/config.js";
import { loadLoopState } from "../src/loop-state.js";
import { readOrchestratorInfo } from "../src/fleet-state.js";
import { eventsLogPath } from "../src/paths.js";
import type { BuildStatus } from "../src/build-info.js";
import type { Redeployer } from "../src/redeploy-policy.js";
import { FAST_POLL_MS, makeFastRepo } from "./orchestrator-fixtures.js";
import { fakePiIdle } from "./fake-pi.js";
import { waitFor } from "./wait.js";

/** The build identity every fake publishes; the sha is what the startup event logs. */
const BUILD_SHA = "build-sha";
const BUILT_AT = 1;

interface ScriptedStep {
  /** The verdict this step's poll answers with (default "none"). The last step repeats. */
  action?: "hold" | "restart" | "none";
  /** The build status this step publishes (default: the bare sha/builtAt pair). */
  build?: BuildStatus;
}

/** A Redeployer stand-in that answers each poll with its script's next step and publishes the
 * current step's build status. Cast through unknown: Redeployer is a class with private state,
 * and the orchestrator touches only poll/status/forceRestart plus the build sha it logs at
 * startup. Also returns how many polls ran, so a hold-length assertion cannot pass by accident
 * of a stalled run. */
function scriptedRedeployer(steps: ScriptedStep[]): {
  redeployer: Redeployer;
  polls: () => number;
} {
  let i = 0;
  const current = () => steps[Math.min(i, steps.length - 1)]!;
  return {
    polls: () => i,
    redeployer: {
      build: { sha: BUILD_SHA, builtAt: BUILT_AT, root: "/" },
      selfHosted: true,
      forceRestart() {},
      async poll() {
        const step = current();
        i = Math.min(i + 1, steps.length - 1);
        return step.action ?? "none";
      },
      status() {
        return current().build ?? { sha: BUILD_SHA, builtAt: BUILT_AT };
      },
    } as unknown as Redeployer,
  };
}

/** The harness events of one type from the repo's event log. */
function events(repo: string, type: string): Record<string, unknown>[] {
  return fs
    .readFileSync(eventsLogPath(repo), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((e) => e.type === type);
}

test("a redeploy hold starts no new ticks, and its lift resumes them", async () => {
  const repo = await makeFastRepo("redeploy hold test", ["clean"]);
  const restore = fakePiIdle();
  const controller = new AbortController();
  // Several held polls, then the hold lifts: the fleet sits idle through the hold and the
  // next due tick runs once it clears. The hold outlasts the observation window below — a
  // poll takes longer than the poll interval (each awaits git subprocesses), so the step
  // count is generous on purpose.
  const { redeployer, polls } = scriptedRedeployer([
    { action: "hold" },
    { action: "hold" },
    { action: "hold" },
    { action: "hold" },
    { action: "hold" },
    { action: "hold" },
    {},
  ]);
  const done = runOrchestrator({
    root: repo,
    config: loadConfig(repo),
    mainBranch: "main",
    signal: controller.signal,
    pollMs: FAST_POLL_MS,
    redeploy: redeployer,
  });
  try {
    // Wait for four polls — every one of them answered "hold", so the assertion below is
    // clock-free: an ungated fleet would have ticked on the very first polls (the startup
    // tick is due immediately — the divergence test awaits one inside a few poll periods).
    await waitFor(() => polls() >= 4, "the orchestrator to poll through the hold");
    assert.equal(loadLoopState(repo, "clean").ticks, 0, "a hold starts no new ticks, director included");

    // The hold lifts: the role's pending tick runs on the next polls.
    await waitFor(
      () => loadLoopState(repo, "clean").ticks >= 1 && !loadLoopState(repo, "clean").running,
      "the tick after the hold lifts",
    );
  } finally {
    controller.abort();
    restore();
    await done.catch(() => undefined);
  }
});

test("a restart verdict ends the run with restart: true, before any tick starts", async () => {
  const repo = await makeFastRepo("redeploy restart test", ["clean"]);
  const restore = fakePiIdle();
  const controller = new AbortController();
  const { redeployer } = scriptedRedeployer([{ action: "restart" }]);
  const done = runOrchestrator({
    root: repo,
    config: loadConfig(repo),
    mainBranch: "main",
    signal: controller.signal,
    pollMs: FAST_POLL_MS,
    redeploy: redeployer,
  });
  // A restart verdict must end the run on its own; if the exit path breaks, the race turns
  // the hang into a failure instead of a stalled suite.
  const timeout = new Promise<never>((_, reject) => {
    const t = setTimeout(() => reject(new Error("restart verdict did not end the run")), 30_000);
    t.unref();
  });
  try {
    const exit = await Promise.race([done, timeout]);
    assert.deepEqual(exit, { restart: true }, "the daemon exit names the restart for the caller");
    assert.equal(loadLoopState(repo, "clean").ticks, 0, "the first poll's verdict leaves no tick started");
  } finally {
    controller.abort();
    restore();
    await done.catch(() => undefined);
  }
});

test("the redeployer's build status is published at startup and republished when it changes", async () => {
  const repo = await makeFastRepo("redeploy publish test", ["clean"]);
  const restore = fakePiIdle();
  const controller = new AbortController();
  const initial: BuildStatus = { sha: BUILD_SHA, builtAt: BUILT_AT };
  const stale: BuildStatus = { sha: BUILD_SHA, builtAt: BUILT_AT, stale: true, aheadCommits: 2, checkedHead: "head-1" };
  const { redeployer } = scriptedRedeployer([{ build: initial }, { build: stale }]);
  const done = runOrchestrator({
    root: repo,
    config: loadConfig(repo),
    mainBranch: "main",
    signal: controller.signal,
    pollMs: FAST_POLL_MS,
    redeploy: redeployer,
  });
  try {
    // Startup publishes the policy's status alongside the fleet info, and the start event
    // names the build sha.
    assert.deepEqual(readOrchestratorInfo(repo)!.build, initial, "startup publishes the build status");
    assert.equal(
      events(repo, "orchestrator_start").some((e) => e.build === BUILD_SHA),
      true,
      "the start event names the running build",
    );

    // A changed status is republished on the poll that observed it — the dashboards' staleness
    // verdict rides this write.
    await waitFor(() => readOrchestratorInfo(repo)?.build?.stale === true, "the republished stale verdict");
    assert.deepEqual(readOrchestratorInfo(repo)!.build, stale);
  } finally {
    controller.abort();
    restore();
    await done.catch(() => undefined);
  }
});
