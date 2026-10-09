/** The gate family's event logging is best-effort (src/events/events.ts's
 * logEventBestEffort). pollFleetGates runs inside the orchestrator's catch-less poll loop, so
 * an unwritable events feed (ENOSPC, EACCES, the path replaced) must not end the fleet: every
 * gate that logs a crossing event — budget, pause, streak, per-role cap, quiet hours, the
 * fleet hold, and the two storm alarms — has to survive a logEvent throw and still perform
 * its real work. The fault is injected by putting a directory where events.jsonl belongs:
 * every append throws EISDIR, while every other file under the real root still writes, so
 * each gate reaches its own event line exactly as it would on a full disk. */

import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { eventsLogPath } from "../src/paths.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { MODELS_JSON, writeModelsFile } from "./fixtures/models-fixtures.js";
import { paidFallbackConfig } from "./fixtures/config-fixtures.js";
import { freshLoopState, type LoopState } from "../src/loop/loop-state.js";
import { recordDailyCost } from "../src/budget/budget.js";
import { defaultConfig } from "../src/config/config.js";
import type { LoopRunner } from "../src/loop/loop.js";
import { pollBudgetGate, newBudgetGateState } from "../src/gates/budget-gates.js";
import { pollPauseGates, newPauseGateState } from "../src/gates/pause-gates.js";
import { pollStreakGate, newStreakGateState } from "../src/gates/streak-gate.js";
import { pollRoleCapGate, newRoleCapGateState } from "../src/gates/role-cap-gates.js";
import { newQuietHoursGateState, pollQuietHoursGate } from "../src/scheduling/quiet-hours.js";
import type { FleetHold } from "../src/fleet/fleet-hold.js";
import { ERROR_STORM_QUIET } from "../src/fleet/error-storm.js";
import { FAILURE_SPREAD_QUIET } from "../src/fleet/failure-spread.js";
import {
  pollErrorStorm,
  pollFailureSpread,
  pollFleetHold,
  type HoldInputs,
} from "../src/fleet/fleet-polls.js";
import { newFleetGateStates, pollFleetGates } from "../src/gates/gate-polls.js";

/** Put a directory where the append-only events log belongs: every logEvent under `root`
 * throws EISDIR, while every other file under the real root still writes normally. */
function unwritableEvents(root: string): void {
  const file = eventsLogPath(root);
  fs.rmSync(file, { recursive: true, force: true });
  fs.mkdirSync(file, { recursive: true });
}

const T0 = 1_000_000_000;

test("pollQuietHoursGate: a quiet-hours crossing survives an unwritable events feed", () => {
  const root = tmpdir("gate-best-effort-quiet-");
  unwritableEvents(root);
  const state = newQuietHoursGateState();
  assert.doesNotThrow(() =>
    pollQuietHoursGate(root, "23:00-07:00", state, new Date(2026, 8, 30, 23, 30)),
  );
  // The gate's bookkeeping still advanced: the crossing is remembered even though it could
  // not be logged, so the next poll does not re-log it.
  assert.equal(state.prevIn, true);
});

test("pollPauseGates: pause/resume crossings survive an unwritable events feed", () => {
  const root = tmpdir("gate-best-effort-pause-");
  unwritableEvents(root);
  const state = newPauseGateState();
  state.prevUserPaused = true;
  state.prevPausedRoles = new Set(["docs"]);
  let gates: { userPaused: boolean; pausedRoles: Set<string> } | undefined;
  assert.doesNotThrow(() => {
    gates = pollPauseGates(root, state);
  });
  // The edge bookkeeping still advanced on both edges.
  assert.equal(state.prevUserPaused, false);
  assert.deepEqual([...state.prevPausedRoles], []);
  assert.equal(gates!.userPaused, false);
});

test("pollStreakGate: a breaker trip pauses the role even when the event cannot be logged", () => {
  const root = tmpdir("gate-best-effort-streak-");
  unwritableEvents(root);
  const state = newStreakGateState();
  const tripped = pollStreakGate(
    root,
    state,
    [{ role: "docs", state: { consecutiveErrors: 10, lastError: "boom" } }],
    new Set(),
  );
  assert.deepEqual(tripped, ["docs"], "the trip is reported even though its event is lost");
});

test("pollRoleCapGate: a cap pause survives an unwritable events feed", () => {
  const root = tmpdir("gate-best-effort-cap-");
  unwritableEvents(root);
  const state = newRoleCapGateState();
  const spent = freshLoopState("docs");
  recordDailyCost(spent, 0.5);
  const paused = pollRoleCapGate(
    root,
    state,
    [{ role: "docs", state: spent }],
    { docs: 0.5 },
    Date.now(),
  );
  assert.deepEqual([...paused], ["docs"], "the cap verdict is returned even though its event is lost");
});

test("pollBudgetGate: a budget transition survives an unwritable events feed", () => {
  const root = tmpdir("gate-best-effort-budget-");
  unwritableEvents(root);
  const config = defaultConfig();
  config.maxDailyCostUsd = 1;
  const state = newBudgetGateState(config);
  const spent = freshLoopState("feature");
  recordDailyCost(spent, 0.9); // past the 80% warning, under the cap: gate open, warning fires
  assert.doesNotThrow(() =>
    pollBudgetGate(state, {
      root,
      states: [spent],
      liveConfig: config,
      modelsPath: path.join(root, "models.json"),
    }),
  );
  assert.equal(state.warned, true, "the once-per-day warning is marked spent even when unlogged");
});

test("pollFleetHold: a rate-limit hold survives an unwritable events feed", () => {
  const root = tmpdir("gate-best-effort-hold-");
  unwritableEvents(root);
  const runners: HoldInputs[] = [
    { role: "clean", lastRateLimit: { at: T0 } },
    { role: "coverage", lastRateLimit: { at: T0 } },
  ];
  let held: FleetHold | undefined;
  assert.doesNotThrow(() => {
    held = pollFleetHold(root, new Map(), runners, T0 + 1_000).get(undefined);
  });
  assert.notEqual(held!.until, null, "the hold still engages even though its event is lost");
});

test("pollErrorStorm: an error-storm warning survives an unwritable events feed", () => {
  const root = tmpdir("gate-best-effort-storm-");
  unwritableEvents(root);
  const runners = ["clean", "coverage", "dry"].map((role) => ({
    role,
    state: { consecutiveErrors: 3, lastError: "timed out after 1800s" },
  }));
  assert.doesNotThrow(() => pollErrorStorm(root, ERROR_STORM_QUIET, runners));
});

test("pollFailureSpread: a wide-shallow storm warning survives an unwritable events feed", () => {
  const root = tmpdir("gate-best-effort-spread-");
  unwritableEvents(root);
  const roles = ["bugfix", "clean", "coverage", "dry", "feature", "improve"];
  const runners: HoldInputs[] = roles.map((role, i) => ({
    role,
    lastBackendFailure: { at: T0 + i * 4 * 60_000, kind: "connection" },
  }));
  assert.doesNotThrow(() => pollFailureSpread(root, FAILURE_SPREAD_QUIET, runners, T0 + 20 * 60_000));
});

test("pollFleetGates: a budget reopen hands fallback ticks back even when the feed is unwritable", () => {
  const root = tmpdir("gate-best-effort-reopen-");
  const modelsPath = writeModelsFile(root, MODELS_JSON);

  const handbacks: string[] = [];
  const featureState: LoopState = freshLoopState("feature");
  recordDailyCost(featureState, 10);
  featureState.running = true;
  const runner = {
    role: "feature",
    state: featureState,
    runProvider: () => "paid",
    tickModel: () => ({ provider: "free", model: "qwen-free" }),
    handBackTick: () => {
      handbacks.push("feature");
    },
  } as unknown as LoopRunner;

  const config = paidFallbackConfig(10);
  const states = newFleetGateStates(config);
  const ctx = {
    root,
    runners: [runner],
    liveConfig: config,
    modelsPath,
    now: Date.now(),
    info: { pid: process.pid, startedAt: 0, roles: ["feature"] },
  };

  // Poll 1 engages the fallback and writes its real event, so the reopen below has a
  // transition to announce.
  assert.equal(pollFleetGates(states, ctx).gate, "fallback");
  // Now make the feed unwritable; the reopen's budget_resumed and budget_handback events both
  // hit it, and neither may throw out of the catch-less poll loop or skip the handback.
  unwritableEvents(root);
  const raised = { ...config, maxDailyCostUsd: 100 };
  let reopened: { gate: string } | undefined;
  assert.doesNotThrow(() => {
    reopened = pollFleetGates(states, { ...ctx, liveConfig: raised });
  });
  assert.equal(reopened!.gate, "open");
  assert.deepEqual(handbacks, ["feature"], "the in-flight fallback tick is still handed back");
});
