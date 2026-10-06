/** pollFleetGates (src/gate-polls.ts): the wiring between the error-streak circuit breaker's
 * trips and the pause gates' edge-triggered event bookkeeping. The breaker pauses through the
 * same per-role marker the operator's `pause --role` writes, so without coordination the NEXT
 * poll's pause gate sees the marker change and logs a generic role_paused on top of the
 * breaker's own role_streak_paused — one pause, two events, the second mislabeled. */

import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { defaultConfig } from "../src/config/config.js";
import { recordDailyCost } from "../src/budget.js";
import { DIRECTOR_ROLE } from "../src/roles.js";
import { LoopRunner } from "../src/loop.js";
import { freshLoopState, type LoopState } from "../src/loop-state.js";
import { newFleetGateStates, pollFleetGates } from "../src/gate-polls.js";
import { readEvents } from "../src/events/event-read.js";
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

test("pollFleetGates: capPaused reflects maxDailyCostUsdPerRole; an absent key yields the empty set", () => {
  const root = tmpdir("gate-polls-cap-");
  const config = defaultConfig();
  config.maxDailyCostUsdPerRole = { docs: 0.5, coverage: 0 };
  const docsState = freshLoopState("docs");
  recordDailyCost(docsState, 0.5);
  const runners = [
    fakeRunner("docs", docsState, null, []),
    fakeRunner("coverage", freshLoopState("coverage"), null, []),
    fakeRunner(DIRECTOR_ROLE, freshLoopState(DIRECTOR_ROLE), null, []),
  ];

  const states = newFleetGateStates(config);
  const ctx = {
    root,
    runners,
    liveConfig: config,
    modelsPath: path.join(root, "models.json"),
    now: Date.now(),
    info: { pid: process.pid, startedAt: 0, roles: ["docs", "coverage", DIRECTOR_ROLE] },
    infoFile: path.join(root, "orchestrator.json"),
  };

  const first = pollFleetGates(states, ctx);
  assert.ok(first.capPaused.has("docs"), "the over-cap role is blocked on this very poll");
  assert.ok(!first.capPaused.has("coverage"), "a 0 cap disables that role's gate");
  assert.ok(!first.capPaused.has(DIRECTOR_ROLE), "the director is exempt");
  assert.ok(!first.pausedRoles.has("docs"), "no pause marker is written — the sets stay separate");

  // Edge-triggered: a second poll over the cap adds no event, and the set still names the role.
  const second = pollFleetGates(states, ctx);
  assert.ok(second.capPaused.has("docs"));

  // A live edit removing the key lifts the verdict (and logs the resume).
  const lifted = pollFleetGates(states, { ...ctx, liveConfig: { ...config, maxDailyCostUsdPerRole: undefined } });
  assert.equal(lifted.capPaused.size, 0);

  // An absent key from the start: the empty set, no events at all.
  const quiet = newFleetGateStates(config);
  const bare = pollFleetGates(quiet, { ...ctx, liveConfig: { ...config, maxDailyCostUsdPerRole: undefined } });
  assert.equal(bare.capPaused.size, 0);
  assert.equal(readEvents(root, 100).filter((e) => e.type === "role_cap_paused").length, 1);
  assert.equal(readEvents(root, 100).filter((e) => e.type === "role_cap_resumed").length, 1);
});

// Per-role quiet hours (PLANS.md quietHoursPerRole): pollFleetGates folds the per-role
// windows into a stateless hold set beside capPaused — no events, no bookkeeping.
test("pollFleetGates: roleQuietHeld names the roles their own quiet window holds; the director is exempt", () => {
  const root = tmpdir("gate-polls-rolequiet-");
  const config = defaultConfig();
  config.quietHoursPerRole = { docs: "00:00-23:59", coverage: "", qa: "23:00-07:00" };
  const runners = [
    fakeRunner("docs", freshLoopState("docs"), null, []),
    fakeRunner("coverage", freshLoopState("coverage"), null, []),
    fakeRunner("qa", freshLoopState("qa"), null, []),
    fakeRunner(DIRECTOR_ROLE, freshLoopState(DIRECTOR_ROLE), null, []),
  ];
  const ctx = {
    root,
    runners,
    liveConfig: config,
    modelsPath: path.join(root, "models.json"),
    now: Date.now(),
    info: { pid: process.pid, startedAt: 0, roles: ["docs", "coverage", "qa", DIRECTOR_ROLE] },
    infoFile: path.join(root, "orchestrator.json"),
  };
  // A mid-day poll: docs' near-all-day window holds, coverage's empty window is off, qa's
  // wrapping window only holds late night. `now` is pinned to a fixed local mid-day instead
  // of Date.now() — a real 23:59:xx run fell outside "00:00-23:59" (the end minute is
  // exclusive, inQuietHours) and flaked the suite. Whichever side of 07:00 a caller's clock
  // sits on, docs' and the director's verdicts are time-independent by construction.
  const poll = pollFleetGates(newFleetGateStates(config), {
    ...ctx,
    now: new Date(2026, 9, 6, 12, 0, 0).getTime(),
  });
  assert.ok(poll.roleQuietHeld.has("docs"), "docs' near-all-day window holds at any local time");
  assert.ok(!poll.roleQuietHeld.has("coverage"), "an empty window is off for that role");
  assert.ok(!poll.roleQuietHeld.has(DIRECTOR_ROLE), "the director is exempt");
  assert.ok(!poll.pausedRoles.has("docs"), "no pause marker is written — stateless beside capPaused");

  // A live edit removing the key lifts the verdict on the next poll, and no events were
  // logged for any of it (stateless — the fleet window's edge events are the only quiet
  // hours events there are).
  const lifted = pollFleetGates(newFleetGateStates(config), {
    ...ctx,
    liveConfig: { ...config, quietHoursPerRole: undefined },
  });
  assert.equal(lifted.roleQuietHeld.size, 0);
  assert.equal(readEvents(root, 100).length, 0);
});
