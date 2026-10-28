/** applyBudgetGateWiring (src/budget/budget-wiring.ts): the budget gate's wiring half moved
 * out of pollTeamGates — the demotions publish, the fallback_switched event, the per-runner
 * config/cap assignment, and the cap-reopen / window hand-back. These pin the moved body in its
 * new home; test/gate-polls.test.ts still exercises the same body through pollTeamGates. */
import test from "node:test";
import assert from "node:assert/strict";
import { DIRECTOR_ROLE } from "../src/roles/roles.js";
import type { RoleRunner } from "../src/runner/runner.js";
import { freshRunnerState, type RunnerState } from "../src/runner/runner-state.js";
import { newTeamGateStates } from "../src/gates/gate-polls.js";
import { pollBudgetGate } from "../src/gates/budget-gates.js";
import { applyBudgetGateWiring, budgetPausedSubjects } from "../src/budget/budget-wiring.js";
import type { TierFallbackMap } from "../src/config/config-fallbacks.js";
import { readEvents } from "../src/events/event-read.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { spentRunnerState } from "./fixtures/runner-fixtures.js";
import { MODELS_JSON, writeModelsFile } from "./fixtures/models-fixtures.js";
import { paidFallbackConfig } from "./fixtures/config-fixtures.js";
import type { OrchestratorInfo } from "../src/team/team-orchestrator-info.js";

/** A minimal runner stand-in, as in test/gate-polls.test.ts: applyBudgetGateWiring assigns its
 * config, sets the cap flag, and — on a budget reopen — matches runModelPair() against the
 * fallback pair and calls handBackRun(). Recorded handbacks stand in for the resumable abort. */
function fakeRunner(
  role: string,
  state: RunnerState,
  runPair: { provider?: string; model?: string } | null,
  handbacks: string[],
): RoleRunner {
  const runner = {
    role,
    state,
    runModelPair: () => (state.running ? runPair : null),
    handBackRun: () => {
      handbacks.push(role);
    },
    config: {},
    budgetFallbackActive: false,
  };
  return runner as unknown as RoleRunner;
}

// A spent maxDailyCostUsd moves the tier to the fallback pair, publishing the chain and a
// fallback_switched event (the window-triggered move is gone, part 5d/6).
test("applyBudgetGateWiring: publishes spend/chain info and logs fallback_switched for a cap move", () => {
  const root = tmpdir("budget-wiring-publish-");
  const modelsPath = writeModelsFile(root, MODELS_JSON);
  const runners = [fakeRunner("feature", spentRunnerState("feature", 10), null, [])];
  const config = paidFallbackConfig(10);
  const states = newTeamGateStates(config);
  const info: OrchestratorInfo = { pid: process.pid, startedAt: 0, roles: ["feature"] };
  const view = pollBudgetGate(states.budget, {
    root,
    states: runners.map((r) => r.state),
    liveConfig: config,
    modelsPath,
  });

  applyBudgetGateWiring({
    root,
    runners,
    liveConfig: config,
    info,
    budget: states.budget,
    view,
  });

  assert.deepEqual(info.budget, { spentUsd: view.spentUsd, capUsd: view.capUsd }, "spend/cap published");
  assert.deepEqual(info.fallbackDemotions, {}, "the demotion map is published (empty here)");
  assert.ok(info.chain, "chain is published while the cap moves");
  assert.deepEqual(info.chain, view.chain, "the published chain mirrors this poll's resolution");
  const switched = readEvents(root, 100).filter((e) => e.type === "fallback_switched");
  assert.equal(switched.length, 1, "one switch event for the move");
  assert.equal(
    (switched[0]!.tiers as Record<string, { reason: string }>).default!.reason,
    "cap",
  );
});

// A cap reopen hands the in-flight runs still on the fallback pair back to the primary, resumably.
test("applyBudgetGateWiring: a cap reopen hands in-flight fallback runs back to the primary", () => {
  const root = tmpdir("budget-wiring-handback-");
  const modelsPath = writeModelsFile(root, MODELS_JSON);
  const handbacks: string[] = [];
  const featureState = spentRunnerState("feature", 10);
  featureState.running = true;
  const docsState = spentRunnerState("docs", 5);
  docsState.running = true;
  const directorState = freshRunnerState(DIRECTOR_ROLE);
  directorState.running = true;
  const runners = [
    // In flight on the fallback pair: exactly the run a reopen hands back.
    fakeRunner("feature", featureState, { provider: "free", model: "qwen-free" }, handbacks),
    // In flight on the primary: a reopen must not touch it.
    fakeRunner("docs", docsState, { provider: "paid", model: "gpt-x" }, handbacks),
    // In flight on the fallback but the director: exempt from the handback, as from the gate.
    fakeRunner(DIRECTOR_ROLE, directorState, { provider: "free", model: "qwen-free" }, handbacks),
  ];
  const config = paidFallbackConfig(10);
  const states = newTeamGateStates(config);
  const info: OrchestratorInfo = {
    pid: process.pid,
    startedAt: 0,
    roles: ["feature", "docs", DIRECTOR_ROLE],
  };
  const poll = (liveConfig: typeof config) =>
    applyBudgetGateWiring({
      root,
      runners,
      liveConfig,
      info,
      budget: states.budget,
      view: pollBudgetGate(states.budget, {
        root,
        states: runners.map((r) => r.state),
        liveConfig,
        modelsPath,
      }),
    });

  // Poll 1: the cap is reached — the fallback engages and no run is disturbed while it holds.
  poll(config);
  assert.deepEqual(handbacks, []);

  // Poll 2: the cap is raised (the live reload) — the gate reopens and the orchestrator
  // hands the in-flight fallback run back to the primary, resumably.
  poll({ ...config, maxDailyCostUsd: 100 });
  assert.deepEqual(handbacks, ["feature"], "only the run on the fallback pair is handed back");

  const events = readEvents(root, 100);
  const handoff = events.filter((e) => e.type === "budget_handback");
  assert.equal(handoff.length, 1, "one event names every handed-back run");
  assert.deepEqual(handoff[0]!.roles, ["feature"]);
  assert.equal(handoff[0]!.provider, "free");
  assert.equal(handoff[0]!.model, "qwen-free");
});

// budgetPausedSubjects (src/budget/budget-wiring.ts): the per-tier budget pause set, moved
// out of pollTeamGates. At the cap a null servingResolved pair holds every non-director role on
// that tier; below the cap nothing pauses — the window-moved set is gone with part 5d/6. The
// loop's behavior is still exercised through pollTeamGates in test/gate-polls.test.ts.
test("budgetPausedSubjects: a null-pair cap-pause folds the right roles", () => {
  const config = paidFallbackConfig(10);
  config.roles = {
    ...config.roles,
    feature: { enabled: true, model: "strong" },
    bugfix: { enabled: true, model: "strong" },
  };
  const runners = [
    fakeRunner("feature", freshRunnerState("feature"), null, []),
    fakeRunner("bugfix", freshRunnerState("bugfix"), null, []),
    fakeRunner("docs", freshRunnerState("docs"), null, []),
    fakeRunner(DIRECTOR_ROLE, freshRunnerState(DIRECTOR_ROLE), null, []),
  ];
  const free = { provider: "free", model: "qwen-free" };
  const pausedTiers: TierFallbackMap = {
    small: { pair: free, from: "small" },
    default: { pair: null, from: null },
    strong: { pair: null, from: null },
  };

  // Below the cap nothing pauses, whatever the resolution.
  const below = budgetPausedSubjects({
    runners,
    liveConfig: config,
    budgetActive: false,
    servingResolved: {
      small: { pair: free, from: "small" },
      default: { pair: free, from: "default" },
      strong: { pair: free, from: "strong" },
    },
  });
  assert.equal(below.budgetPausedRoles.size, 0, "below the cap a usable pair pauses nothing");

  // At the cap with both tiers resolved to pause: every role on a null-pair tier is held, the
  // director exempt.
  const atCap = budgetPausedSubjects({
    runners,
    liveConfig: config,
    budgetActive: true,
    servingResolved: pausedTiers,
  });
  assert.deepEqual(
    [...atCap.budgetPausedRoles].sort(),
    ["bugfix", "docs", "feature"],
    "every role on a null-pair tier is held at the cap",
  );
  assert.ok(!atCap.budgetPausedRoles.has(DIRECTOR_ROLE), "the director is exempt");
});
