/** pollFleetGates (src/gate-polls.ts): the wiring between the error-streak circuit breaker's
 * trips and the pause gates' edge-triggered event bookkeeping. The breaker pauses through the
 * same per-role marker the operator's `pause --role` writes, so without coordination the NEXT
 * poll's pause gate sees the marker change and logs a generic role_paused on top of the
 * breaker's own role_streak_paused — one pause, two events, the second mislabeled. */

import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { defaultConfig } from "../src/config.js";
import { recordDailyCost } from "../src/budget.js";
import { DIRECTOR_ROLE } from "../src/roles.js";
import { LoopRunner } from "../src/loop.js";
import { freshLoopState, type LoopState } from "../src/loop-state.js";
import { newFleetGateStates, pollFleetGates } from "../src/gate-polls.js";
import { readEvents } from "../src/event-read.js";
import { tmpdir } from "./repo-fixtures.js";
import { MODELS_JSON } from "./models-fixtures.js";

test("pollFleetGates: a breaker trip logs role_streak_paused once — no duplicate role_paused on the next poll", () => {
  const root = tmpdir("gate-polls-");
  const config = defaultConfig();
  const runner = new LoopRunner(root, "docs", config, "main");
  runner.state.consecutiveErrors = 10;
  runner.state.lastError = "boom";

  const states = newFleetGateStates(config);
  const ctx = {
    root,
    runners: [runner],
    liveConfig: config,
    // No fallback pair in the default config: the models catalog is never read.
    modelsPath: path.join(root, "models.json"),
    now: Date.now(),
    info: { pid: process.pid, startedAt: 0, roles: ["docs"] },
    infoFile: path.join(root, "orchestrator.json"),
  };

  // Poll 1: the breaker trips — the scheduler's paused-roles view must block the role on
  // this very poll, and the breaker's own event is the announcement.
  const first = pollFleetGates(states, ctx);
  assert.ok(first.pausedRoles.has("docs"), "the fresh trip must fold into this poll's paused view");

  // Poll 2: the pause stands. The breaker logs nothing more, and the pause gates must not
  // re-log the same pause as a generic role_paused (whose contract names an operator action).
  const second = pollFleetGates(states, ctx);
  assert.ok(second.pausedRoles.has("docs"), "the marker keeps blocking on the next poll");

  const events = readEvents(root, 100);
  assert.equal(
    events.filter((e) => e.type === "role_streak_paused").length,
    1,
    "exactly one breaker event for one trip",
  );
  assert.equal(
    events.filter((e) => e.type === "role_paused").length,
    0,
    "the breaker's pause must not surface again as an operator pause",
  );
});


/** A minimal runner stand-in: pollFleetGates only reads a runner's role and state,
 * assigns its config, and — on a budget reopen — matches tickModel() against the
 * fallback pair and calls handBackTick(). Recorded handbacks stand in for the real
 * resumable abort the orchestrator's runners perform. */
function fakeRunner(
  role: string,
  state: LoopState,
  tickPair: { provider?: string; model?: string } | null,
  handbacks: string[],
): LoopRunner {
  const runner = {
    role,
    state,
    tickModel: () => (state.running ? tickPair : null),
    handBackTick: () => {
      handbacks.push(role);
    },
  };
  return runner as unknown as LoopRunner;
}

test("pollFleetGates: a budget reopen hands in-flight fallback ticks back to the primary", () => {
  const root = tmpdir("gate-polls-budget-");
  fs.mkdirSync(root, { recursive: true });
  const modelsPath = path.join(root, "models.json");
  fs.writeFileSync(modelsPath, MODELS_JSON);

  const handbacks: string[] = [];
  const featureState = freshLoopState("feature");
  recordDailyCost(featureState, 10);
  featureState.running = true;
  const docsState = freshLoopState("docs");
  recordDailyCost(docsState, 5);
  docsState.running = true;
  const directorState = freshLoopState(DIRECTOR_ROLE);
  directorState.running = true;
  const runners = [
    // In flight on the fallback pair: exactly the tick a reopen hands back.
    fakeRunner("feature", featureState, { provider: "free", model: "qwen-free" }, handbacks),
    // In flight on the primary: a reopen must not touch it.
    fakeRunner("docs", docsState, { provider: "paid", model: "gpt-x" }, handbacks),
    // In flight on the fallback but the director: exempt from the handback, as from the gate.
    fakeRunner(DIRECTOR_ROLE, directorState, { provider: "free", model: "qwen-free" }, handbacks),
  ];

  const config = defaultConfig();
  config.provider = "paid";
  config.model = "gpt-x";
  config.fallbackModel = { provider: "free", model: "qwen-free" };
  config.maxDailyCostUsd = 10;

  const states = newFleetGateStates(config);
  const ctx = {
    root,
    runners,
    liveConfig: config,
    modelsPath,
    now: Date.now(),
    info: { pid: process.pid, startedAt: 0, roles: ["feature", "docs", DIRECTOR_ROLE] },
    infoFile: path.join(root, "orchestrator.json"),
  };

  // Poll 1: the cap is reached — the fallback engages, role loops are assigned the
  // derived free-pair view, the director keeps the live (paid) config, and no tick is
  // disturbed while the gate holds.
  const engaged = pollFleetGates(states, ctx);
  assert.equal(engaged.gate, "fallback");
  const modelOf = (i: number) => (runners[i] as unknown as { config: { model?: string } }).config.model;
  assert.equal(modelOf(0), "qwen-free", "role loops run the fallback view");
  assert.equal(modelOf(1), "qwen-free");
  assert.equal(modelOf(2), "gpt-x", "the director keeps its budgeted model");
  assert.deepEqual(handbacks, []);

  // Poll 2: the cap is raised (the live reload) — the gate reopens and the orchestrator
  // hands the in-flight fallback ticks back to the primary, resumably.
  const raised = { ...config, maxDailyCostUsd: 100 };
  const reopened = pollFleetGates(states, { ...ctx, liveConfig: raised });
  assert.equal(reopened.gate, "open");
  assert.equal(modelOf(1), "gpt-x", "the primary model is back after the reopen");
  assert.deepEqual(handbacks, ["feature"], "only the tick on the fallback pair is handed back");

  const events = readEvents(root, 100);
  assert.equal(events.filter((e) => e.type === "budget_resumed").length, 1);
  const handoff = events.filter((e) => e.type === "budget_handback");
  assert.equal(handoff.length, 1, "one event names every handed-back tick");
  assert.equal(handoff[0]!.loop, "harness");
  assert.deepEqual(handoff[0]!.roles, ["feature"]);
  assert.equal(handoff[0]!.provider, "free");
  assert.equal(handoff[0]!.model, "qwen-free");
});
