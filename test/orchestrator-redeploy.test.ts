/** Unit-tier coverage for the orchestrator's self-redeploy wiring (src/orchestrator/orchestrator.ts's
 * `if (redeploy)` block): the policy's verdict gates the fleet — a `hold` starts no new ticks
 * and its lift resumes them, a `restart` ends the run with restart: true — and the policy's
 * status() is published into orchestrator.json, at startup and again whenever it changes. The
 * gating `npm test` never ran this path; the redeploy e2e tier covers it, but only under
 * `npm run test:e2e`, so the shape was only implied by the orchestrator's source. A scripted
 * fake Redeployer keeps the tier's focus on the orchestrator's own decisions, not the policy's
 * state machine (src/redeploy/redeployer.ts has its own tests). */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadLoopState } from "../src/loop/loop-state.js";
import { readOrchestratorInfo } from "../src/fleet/orchestrator-info.js";
import { eventsLogPath } from "../src/paths.js";
import type { BuildStatus } from "../src/build/build-info.js";
import type { Redeployer } from "../src/redeploy/redeployer.js";
import { FAST_POLL_MS, makeFastRepo, runRepoOrchestrator, withHangGuard } from "./orchestrator-fixtures.js";
import { fakePi, fakePiIdle } from "./fake-pi.js";
import { tmpdir } from "./repo-fixtures.js";
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
 * current step's build status. While `ready` returns false every poll answers "none" without
 * advancing the script, so a step can wait on fleet state instead of a poll count. Cast through unknown: Redeployer is a class with private state,
 * and the orchestrator touches only poll/status/forceRestart plus the build sha it logs at
 * startup. Also returns how many polls ran, so a hold-length assertion cannot pass by accident
 * of a stalled run. */
function scriptedRedeployer(steps: ScriptedStep[], ready: () => boolean = () => true): {
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
        if (!ready()) return "none";
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
  const done = runRepoOrchestrator(repo, {
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
  const done = runRepoOrchestrator(repo, {
    signal: controller.signal,
    pollMs: FAST_POLL_MS,
    redeploy: redeployer,
  });
  // A restart verdict must end the run on its own; if the exit path breaks, the race turns
  // the hang into a failure instead of a stalled suite.
  try {
    const exit = await withHangGuard(done, "restart verdict did not end the run");
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
  const done = runRepoOrchestrator(repo, {
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

test("a restart verdict cuts off a permit-holding tick instead of draining it", async () => {
  const repo = await makeFastRepo("redeploy restart cutoff test", ["clean"]);
  // The fake pi hangs far past the test: the role's startup tick stays a permit holder
  // parked inside the pi run until the restart's abort cuts it off. A "finished" line in
  // the run log would mean the shutdown drained the model run to completion instead.
  const runLog = path.join(tmpdir("restart-cutoff-"), "pi-runs.log");
  const script = `echo started >> '${runLog}'\nsleep 120\necho finished >> '${runLog}'\n`;
  const restore = fakePi(script);
  const controller = new AbortController();
  // The restart verdict waits for the startup tick to park inside the hung pi run, so it lands
  // with a tick in flight. A fixed count of idle polls raced the tick's worktree setup: under
  // load the restart cut the tick off before pi ever started (2026-10-01 suite flake).
  const piStarted = () => fs.existsSync(runLog) && fs.readFileSync(runLog, "utf8").includes("started");
  const { redeployer } = scriptedRedeployer([{ action: "restart" }], piStarted);
  const done = runRepoOrchestrator(repo, {
    signal: controller.signal,
    pollMs: FAST_POLL_MS,
    redeploy: redeployer,
  });
  try {
    await waitFor(piStarted, "the role tick's pi run to start");
    // A restart verdict must end the run on its own; if the abort path breaks, the race turns
    // the hang into a failure instead of a stalled suite. Armed only now, so a slow startup
    // tick cannot spend the restart's budget.
    const exit = await withHangGuard(done, "restart verdict did not end the run");
    assert.deepEqual(exit, { restart: true }, "the daemon exit names the restart for the caller");
    assert.equal(
      fs.readFileSync(runLog, "utf8").includes("finished"),
      false,
      "the in-flight pi run was cut off, not drained to completion",
    );
    // The tick was started but never completed: the cut-off reservation hands itself back
    // with no tick_end of its own to record.
    assert.ok(loadLoopState(repo, "clean").running || loadLoopState(repo, "clean").ticks >= 1,
      "the tick was in flight when the restart landed");
  } finally {
    controller.abort();
    restore();
    await done.catch(() => undefined);
  }
});
