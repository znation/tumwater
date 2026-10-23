/** pollTeamGates (src/gates/gate-polls.ts): the wiring between the error-streak circuit breaker's
 * trips and the pause gates' edge-triggered event bookkeeping. The breaker pauses through the
 * same per-role marker the operator's `pause --role` writes, so without coordination the NEXT
 * poll's pause gate sees the marker change and logs a generic role_paused on top of the
 * breaker's own role_streak_paused — one pause, two events, the second mislabeled. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { defaultConfig } from "../src/config/config.js";
import { DIRECTOR_ROLE } from "../src/roles/roles.js";
import { RoleRunner } from "../src/runner/runner.js";
import { freshRunnerState, type RunnerState } from "../src/runner/runner-state.js";
import { newTeamGateStates, pollTeamGates } from "../src/gates/gate-polls.js";
import { BYTES_PER_GB } from "../src/gates/disk-gate.js";
import { heldProviders } from "../src/team/team-hold.js";
import type { ModelFallbackState } from "../src/runner/model-fallback.js";
import { writeClaudeAccount } from "../src/agent/claude/claude-account.js";
import { writeAccount } from "../src/agent/subscription-account.js";
import { readEvents } from "../src/events/event-read.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { spentRunnerState } from "./fixtures/runner-fixtures.js";
import { readJson } from "./helpers/json-read.js";
import { orchestratorStatePath } from "../src/paths.js";
import { piRunResult } from "./fakes/fake-pi.js";
import { MODELS_JSON, writeModelsFile } from "./fixtures/models-fixtures.js";
import { eventTypes } from "./fixtures/log-fixtures.js";
import { paidFallbackConfig } from "./fixtures/config-fixtures.js";
import { IDLE_FALLBACK_BREAKER } from "../src/budget/fallback-breaker.js";
import type { OrchestratorInfo } from "../src/team/orchestrator-info.js";

test("pollTeamGates: a breaker trip logs role_streak_paused once — no duplicate role_paused on the next poll", () => {
  const root = tmpdir("gate-polls-");
  const config = defaultConfig();
  const runner = new RoleRunner(root, "docs", config, "main");
  runner.state.consecutiveErrors = 10;
  runner.state.lastError = "boom";

  const states = newTeamGateStates(config);
  const ctx = {
    root,
    runners: [runner],
    liveConfig: config,
    // No fallback pair in the default config: the models catalog is never read.
    modelsPath: path.join(root, "models.json"),
    now: Date.now(),
    info: { pid: process.pid, startedAt: 0, roles: ["docs"] },
    // Injected so a hosted runner's real free space cannot also pause docs through the
    // disk floor, muddying what the breaker's own pause did.
    sampleFree: () => 100 * BYTES_PER_GB,
  };

  // Poll 1: the breaker trips — the scheduler's paused-roles view must block the role on
  // this very poll, and the breaker's own event is the announcement.
  const first = pollTeamGates(states, ctx);
  assert.ok(first.pausedRoles.has("docs"), "the fresh trip must fold into this poll's paused view");

  // Poll 2: the pause stands. The breaker logs nothing more, and the pause gates must not
  // re-log the same pause as a generic role_paused (whose contract names an operator action).
  const second = pollTeamGates(states, ctx);
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

/** A minimal runner stand-in: pollTeamGates only reads a runner's role and state,
 * assigns its config, and — on a budget reopen — matches runModelPair() against the
 * fallback pair and calls handBackRun(). Recorded handbacks stand in for the real
 * resumable abort the orchestrator's runners perform. */
function fakeRunner(
  role: string,
  state: RunnerState,
  runPair: { provider?: string; model?: string } | null,
  handbacks: string[],
  provider = "paid",
): RoleRunner {
  const runner = {
    role,
    state,
    runProvider: () => provider,
    runModelPair: () => (state.running ? runPair : null),
    handBackRun: () => {
      handbacks.push(role);
    },
  };
  return runner as unknown as RoleRunner;
}

test("pollTeamGates: a budget reopen hands in-flight fallback runs back to the primary", () => {
  const root = tmpdir("gate-polls-budget-");
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
  const ctx = {
    root,
    runners,
    liveConfig: config,
    modelsPath,
    now: Date.now(),
    info: { pid: process.pid, startedAt: 0, roles: ["feature", "docs", DIRECTOR_ROLE] },
  };

  // Poll 1: the cap is reached — the fallback engages, roles are assigned the
  // derived free-pair view, the director keeps the live (paid) config, and no run is
  // disturbed while the gate holds.
  const engaged = pollTeamGates(states, ctx);
  assert.equal(engaged.gate, "fallback");
  const modelOf = (i: number) => (runners[i] as unknown as { config: { model?: unknown } }).config.model;
  const tierView = { small: "free/qwen-free", default: "free/qwen-free", strong: "free/qwen-free" };
  assert.deepEqual(modelOf(0), tierView, "role loops run the per-tier fallback view (part 5c/8)");
  assert.deepEqual(modelOf(1), tierView);
  assert.equal(modelOf(2), "gpt-x", "the director keeps its budgeted model");
  assert.deepEqual(handbacks, []);

  // Poll 2: the cap is raised (the live reload) — the gate reopens and the orchestrator
  // hands the in-flight fallback runs back to the primary, resumably.
  const raised = { ...config, maxDailyCostUsd: 100 };
  const reopened = pollTeamGates(states, { ...ctx, liveConfig: raised });
  assert.equal(reopened.gate, "open");
  assert.equal(modelOf(1), "gpt-x", "the primary model is back after the reopen");
  assert.deepEqual(handbacks, ["feature"], "only the run on the fallback pair is handed back");

  const events = readEvents(root, 100);
  assert.equal(events.filter((e) => e.type === "budget_resumed").length, 1);
  const handoff = events.filter((e) => e.type === "budget_handback");
  assert.equal(handoff.length, 1, "one event names every handed-back run");
  assert.equal(handoff[0]!.source, "tumwater");
  assert.deepEqual(handoff[0]!.roles, ["feature"]);
  assert.equal(handoff[0]!.provider, "free");
  assert.equal(handoff[0]!.model, "qwen-free");
});

test("pollTeamGates: a used-up claude window moves claude roles to the fallback and hands them back at the reset", () => {
  const root = tmpdir("gate-polls-window-");
  const modelsPath = writeModelsFile(root, MODELS_JSON);
  const now = Date.now();
  writeClaudeAccount(root, {
    billing: "subscription",
    observedAt: now,
    windows: { five_hour: { status: "rejected", resetsAt: now + 3_600_000, observedAt: now } },
  });
  const handbacks: string[] = [];
  const featureState = spentRunnerState("feature", 1);
  featureState.running = true;
  const directorState = freshRunnerState(DIRECTOR_ROLE);
  const runners = [
    fakeRunner("feature", featureState, { provider: "free", model: "qwen-free" }, handbacks, "claude"),
    fakeRunner(DIRECTOR_ROLE, directorState, null, handbacks, "claude"),
  ];
  const config = paidFallbackConfig(10);
  config.provider = undefined;
  config.backend = "claude"; config.model = "claude-sonnet-5-5";
  const states = newTeamGateStates(config);
  const ctx = {
    root,
    runners,
    liveConfig: config,
    modelsPath,
    now,
    info: { pid: process.pid, startedAt: 0, roles: ["feature", DIRECTOR_ROLE] },
  };

  const out = pollTeamGates(states, ctx);
  assert.equal(out.gate, "open");
  const cfgOf = (i: number) => (runners[i] as unknown as { config: { model?: unknown } }).config;
  // On a claude team the pi pair's entry names its backend, so claude cannot take its id.
  const piEntry = { backend: "pi", model: "free/qwen-free" };
  assert.deepEqual(cfgOf(0).model, { small: piEntry, default: piEntry, strong: piEntry });
  assert.deepEqual(cfgOf(1).model, cfgOf(0).model, "the director follows its tier to the fallback pair too");
  assert.equal((runners[0] as unknown as { budgetFallbackActive?: boolean }).budgetFallbackActive, false, "the cap flag stays off");
  const limited = readEvents(root, 100).filter((e) => e.type === "subscription_window_limited");
  assert.equal(limited.length, 1);
  assert.ok(limited[0]!.tiers, "the limited event names where the moved tiers went");
  assert.deepEqual(handbacks, []);

  // The window resets: the in-flight fallback run is handed back, with reason window.
  writeClaudeAccount(root, { billing: "subscription", observedAt: now, windows: {} });
  pollTeamGates(states, ctx);
  assert.deepEqual(handbacks, ["feature"]);
  const back = readEvents(root, 100).filter((e) => e.type === "budget_handback");
  assert.equal(back.length, 1);
  assert.equal(back[0]!.reason, "window");
  assert.equal(back[0]!.backend, "claude", "the handback names the backend whose window resumed");
  assert.equal(cfgOf(0), config, "the live config is back");
  assert.equal(cfgOf(1), config, "the director's too");
});

test("pollTeamGates: a used-up window's demoted fallback holds the moved tier's roles below the cap", () => {
  const root = tmpdir("gate-polls-window-demoted-");
  const modelsPath = writeModelsFile(root, MODELS_JSON);
  const now = Date.now();
  const claudeWindow = {
    billing: "subscription" as const,
    observedAt: now,
    windows: { five_hour: { status: "rejected" as const, resetsAt: now + 3_600_000, observedAt: now } },
  };
  writeClaudeAccount(root, claudeWindow);
  const runners = [
    fakeRunner("feature", spentRunnerState("feature", 1), { provider: "free", model: "qwen-free" }, [], "claude"),
    fakeRunner("bugfix", spentRunnerState("bugfix", 1), { provider: "free", model: "qwen-free" }, [], "claude"),
    fakeRunner(DIRECTOR_ROLE, freshRunnerState(DIRECTOR_ROLE), null, [], "claude"),
  ];
  const config = paidFallbackConfig(10);
  config.provider = undefined;
  config.backend = "claude"; config.model = "claude-sonnet-5-5";
  config.roles = { ...config.roles, bugfix: { enabled: true, backend: "pi", model: "free/qwen-free" } };
  const ctx = {
    root,
    runners,
    liveConfig: config,
    modelsPath,
    now,
    info: { pid: process.pid, startedAt: 0, roles: ["feature", DIRECTOR_ROLE] },
  };
  const demoted = {
    ...IDLE_FALLBACK_BREAKER,
    pair: "free/qwen-free",
    capUsd: 10,
    failures: 3,
    probeAt: now + 60_000,
  };

  const states = newTeamGateStates(config);
  states.budget.breakers = { "free/qwen-free": demoted };
  const held = pollTeamGates(states, ctx);
  assert.equal(held.budgetActive, false, "the cap is not reached");
  assert.ok(held.windowMovedRoles.has("feature"));
  assert.ok(held.budgetPausedRoles.has("feature"), "the demoted window fallback holds the moved role");
  assert.ok(!held.windowMovedRoles.has("bugfix"), "a role pinned to a non-claude model is not moved");
  assert.ok(!held.budgetPausedRoles.has("bugfix"), "nor held by the demoted fallback");
  assert.ok(!held.windowMovedRoles.has(DIRECTOR_ROLE) && !held.budgetPausedRoles.has(DIRECTOR_ROLE));

  const trusted = pollTeamGates(newTeamGateStates(config), ctx);
  assert.ok(trusted.windowMovedRoles.has("feature"));
  assert.ok(!trusted.budgetPausedRoles.has("feature"), "a trusted fallback keeps the moved role running");

  writeClaudeAccount(root, { billing: "subscription", observedAt: now, windows: {} });
  const none = pollTeamGates(newTeamGateStates(config), ctx);
  assert.equal(none.windowMovedRoles.size, 0, "no used-up window, no moved roles");
});

test("pollTeamGates: fallback_switched is logged once per chain change and orchestrator info carries chain", () => {
  const root = tmpdir("gate-polls-chain-");
  const modelsPath = writeModelsFile(root, MODELS_JSON);
  const now = Date.now();
  writeClaudeAccount(root, {
    billing: "subscription",
    observedAt: now,
    windows: { five_hour: { status: "rejected", resetsAt: now + 3_600_000, observedAt: now } },
  });
  const runners = [fakeRunner("feature", spentRunnerState("feature", 1), null, [], "claude")];
  const config = paidFallbackConfig(10);
  config.provider = undefined;
  config.backend = "claude"; config.model = "claude-sonnet-5-5";
  const states = newTeamGateStates(config);
  const info: Record<string, unknown> = { pid: process.pid, startedAt: 0, roles: ["feature"] };
  const ctx = { root, runners, liveConfig: config, modelsPath, now, info: info as never };
  const switched = () => readEvents(root, 100).filter((e) => e.type === "fallback_switched");

  pollTeamGates(states, ctx);
  pollTeamGates(states, ctx);
  assert.equal(switched().length, 1);
  assert.equal((switched()[0]!.tiers as Record<string, { reason: string }>).default!.reason, "window");
  assert.ok(info.chain, "chain is published while moved");

  writeClaudeAccount(root, { billing: "subscription", observedAt: now, windows: {} });
  pollTeamGates(states, ctx);
  assert.equal(switched().length, 2);
  const back = (switched()[1]!.tiers as Record<string, { to: unknown; reason: string }>).default!;
  assert.equal(back.to, null);
  assert.equal(back.reason, "available");
  assert.equal(info.chain, undefined, "chain is gone after the reset");
});

test("pollTeamGates: a cap reopen while the claude window is still used up hands nothing back", () => {
  const root = tmpdir("gate-polls-window-cap-");
  const modelsPath = writeModelsFile(root, MODELS_JSON);
  const now = Date.now();
  writeClaudeAccount(root, {
    billing: "subscription",
    observedAt: now,
    windows: { five_hour: { status: "rejected", resetsAt: now + 3_600_000, observedAt: now } },
  });
  const handbacks: string[] = [];
  const featureState = spentRunnerState("feature", 10);
  featureState.running = true;
  const runners = [fakeRunner("feature", featureState, { provider: "free", model: "qwen-free" }, handbacks, "claude")];
  const config = paidFallbackConfig(10);
  config.provider = undefined;
  config.backend = "claude"; config.model = "claude-sonnet-5-5";
  const states = newTeamGateStates(config);
  const ctx = {
    root,
    runners,
    liveConfig: config,
    modelsPath,
    now,
    info: { pid: process.pid, startedAt: 0, roles: ["feature"] },
  };
  assert.equal(pollTeamGates(states, ctx).gate, "fallback");
  const reopened = pollTeamGates(states, { ...ctx, liveConfig: { ...config, maxDailyCostUsd: 100 } });
  assert.equal(reopened.gate, "open");
  assert.deepEqual(handbacks, [], "the run is already on the pair the window still assigns");
  assert.equal(readEvents(root, 100).filter((e) => e.type === "budget_handback").length, 0);
});

test("pollTeamGates: a used-up sub window moves the sub tier's roles, holds backend sub, and leaves claude untouched", () => {
  const root = tmpdir("gate-polls-sub-window-");
  const modelsPath = writeModelsFile(root, MODELS_JSON);
  const now = Date.now();
  const config = paidFallbackConfig(10);
  // The strong tier routes to the test-only `sub` backend and the default tier to claude, so one
  // config carries two subscription backends and each backend's window is judged from its own
  // account (part 2e/9). Never through loadConfig: `sub` is a test-only backend id.
  config.model = {
    strong: { backend: "sub", model: "sub-astra" },
    default: { backend: "claude", model: "claude-sonnet-5-5" },
  };
  config.roles = {
    ...config.roles,
    feature: { enabled: true, model: "strong" },
    bugfix: { enabled: true, model: "default" },
  };
  const runners = [
    fakeRunner("feature", spentRunnerState("feature", 1), null, [], "sub"),
    fakeRunner("bugfix", spentRunnerState("bugfix", 1), null, [], "claude"),
    fakeRunner(DIRECTOR_ROLE, freshRunnerState(DIRECTOR_ROLE), null, [], "sub"),
  ];
  const ctx = {
    root,
    runners,
    liveConfig: config,
    modelsPath,
    now,
    info: { pid: process.pid, startedAt: 0, roles: ["feature", "bugfix", DIRECTOR_ROLE] },
  };

  // sub rejected, claude healthy: only the sub role moves, the hold keys `sub`, the limited
  // event names `sub`, and claude's role and account are untouched.
  writeAccount(root, "sub", {
    billing: "subscription",
    observedAt: now,
    windows: { five_hour: { status: "rejected", resetsAt: now + 3_600_000, observedAt: now } },
  });
  writeClaudeAccount(root, { billing: "subscription", observedAt: now, windows: {} });
  const states = newTeamGateStates(config);
  const subOut = pollTeamGates(states, ctx);
  assert.ok(subOut.windowMovedRoles.has("feature"), "the sub role moves");
  assert.ok(!subOut.windowMovedRoles.has("bugfix"), "claude's healthy role does not move");
  assert.ok(!subOut.windowMovedRoles.has(DIRECTOR_ROLE), "the director stays");
  const limited = readEvents(root, 100).filter((e) => e.type === "subscription_window_limited");
  assert.equal(limited.length, 1);
  assert.equal(limited[0]!.backend, "sub", "the limited event names the sub backend");
  const held = heldProviders(states.teamHold);
  assert.ok(held.has("sub"), "the hold keys the sub backend");
  assert.ok(!held.has("claude"), "claude's healthy window holds nothing");

  // claude rejected, sub healthy: only claude's role moves, and the limited event names claude.
  writeAccount(root, "sub", { billing: "subscription", observedAt: now, windows: {} });
  writeClaudeAccount(root, {
    billing: "subscription",
    observedAt: now,
    windows: { five_hour: { status: "rejected", resetsAt: now + 3_600_000, observedAt: now } },
  });
  const claudeOut = pollTeamGates(newTeamGateStates(config), ctx);
  assert.ok(claudeOut.windowMovedRoles.has("bugfix"), "claude's rejected role moves");
  assert.ok(!claudeOut.windowMovedRoles.has("feature"), "the healthy sub role does not move");
  const limitedClaude = readEvents(root, 100).filter((e) => e.type === "subscription_window_limited");
  assert.equal(limitedClaude.length, 2, "a second limited event for claude");
  assert.equal(limitedClaude[1]!.backend, "claude");
});

test("pollTeamGates: a window on one backend does not move a healthy backend's role on the same tier", () => {
  const root = tmpdir("gate-polls-sub-same-tier-");
  const modelsPath = writeModelsFile(root, MODELS_JSON);
  const now = Date.now();
  const config = paidFallbackConfig(10);
  // Both roles ride tier `strong`: feature on the test-only `sub` backend, bugfix pinned to claude
  // on the SAME tier, so the tier's own seam (sub) moving must not drag claude's healthy role.
  config.model = {
    strong: { backend: "sub", model: "sub-astra" },
    default: { backend: "claude", model: "claude-sonnet-5-5" },
  };
  config.roles = {
    ...config.roles,
    feature: { enabled: true, model: "strong" },
    bugfix: { enabled: true, model: "strong", backend: "claude" },
  };
  const runners = [
    fakeRunner("feature", spentRunnerState("feature", 1), null, [], "sub"),
    fakeRunner("bugfix", spentRunnerState("bugfix", 1), null, [], "claude"),
    fakeRunner(DIRECTOR_ROLE, freshRunnerState(DIRECTOR_ROLE), null, [], "sub"),
  ];
  const ctx = {
    root,
    runners,
    liveConfig: config,
    modelsPath,
    now,
    info: { pid: process.pid, startedAt: 0, roles: ["feature", "bugfix", DIRECTOR_ROLE] },
  };

  // sub rejected, claude healthy: the tier moves because of sub, so only the sub role moves;
  // the healthy claude role on the same tier keeps its pair (part 2e/9).
  writeAccount(root, "sub", {
    billing: "subscription",
    observedAt: now,
    windows: { five_hour: { status: "rejected", resetsAt: now + 3_600_000, observedAt: now } },
  });
  writeClaudeAccount(root, { billing: "subscription", observedAt: now, windows: {} });
  const out = pollTeamGates(newTeamGateStates(config), ctx);
  assert.ok(out.windowMovedRoles.has("feature"), "the sub role moves");
  assert.ok(!out.windowMovedRoles.has("bugfix"), "the healthy claude role on the same tier stays");
});

test("pollTeamGates: a sub reserve logs subscription_window_reserved once per window without disturbing claude's reserve memory", () => {
  const root = tmpdir("gate-polls-sub-reserve-");
  const modelsPath = writeModelsFile(root, MODELS_JSON);
  const now = Date.now();
  const config = paidFallbackConfig(10);
  config.model = {
    strong: { backend: "sub", model: "sub-astra" },
    default: { backend: "claude", model: "claude-sonnet-5-5" },
  };
  config.backends = { sub: { windowReserve: { five_hour: 0.9 } } };
  config.claudeWindowReserve = { five_hour: 0.9 };
  const states = newTeamGateStates(config);
  const ctx = {
    root,
    runners: [],
    liveConfig: config,
    modelsPath,
    now,
    info: { pid: process.pid, startedAt: 0, roles: [] },
  };
  const reserved = () =>
    readEvents(root, 100).filter((e) => e.type === "subscription_window_reserved");

  writeAccount(root, "sub", {
    billing: "subscription",
    observedAt: now,
    windows: { five_hour: { status: "allowed_warning", utilization: 0.95, resetsAt: now + 3_600_000, observedAt: now } },
  });
  writeClaudeAccount(root, {
    billing: "subscription",
    observedAt: now,
    windows: { five_hour: { status: "allowed_warning", utilization: 0.95, resetsAt: now + 3_600_000, observedAt: now } },
  });
  pollTeamGates(states, ctx);
  pollTeamGates(states, ctx); // a second poll must not re-log the same window
  const byBackend = (b: string) => reserved().filter((e) => e.backend === b);
  assert.equal(byBackend("sub").length, 1, "the sub reserve logs once per window");
  assert.equal(byBackend("claude").length, 1, "claude's own reserve logs once too");
  assert.equal(reserved().length, 2, "each backend's crossing keeps its own key");
});

// The per-provider failure hold keys on the provider each role's NEXT run will run on
// (PLANS.md "Model failure fallback, part 1/2"): a role mid-episode reports its fallback
// pair, so a storm on that pair forms its own hold while the abandoned primary stays clear —
// and a healthy role still on the primary is not gated by the fallback hold.
test("pollTeamGates: a fallback episode's failures key the hold on the fallback provider", () => {
  const root = tmpdir("gate-polls-fallback-hold-");
  const modelsPath = writeModelsFile(root, MODELS_JSON);
  const config = paidFallbackConfig();
  const now = Date.now();
  const episode = (): ModelFallbackState => ({
    failures: 0,
    since: now - 1000,
    probeAt: now + 60_000,
    cooldownMs: 5 * 60_000,
    reason: "rate-limit",
  });
  const feature = new RoleRunner(root, "feature", config, "main");
  const docs = new RoleRunner(root, "docs", config, "main");
  const perf = new RoleRunner(root, "perf", config, "main");
  for (const r of [feature, docs]) {
    r.state.modelFallback = episode();
    // Stamp each role's latest observation as a 429; the poll reads the provider through
    // runProvider, which resolves the active episode's fallback pair, not the primary.
    r.foldMergeUsage(piRunResult({ ok: false, transientRateLimit: true }));
  }
  const runners = [feature, docs, perf];

  const states = newTeamGateStates(config);
  const ctx = {
    root,
    runners,
    liveConfig: config,
    modelsPath,
    now,
    info: { pid: process.pid, startedAt: 0, roles: ["feature", "docs", "perf"] },
  };
  pollTeamGates(states, ctx);

  const held = heldProviders(states.teamHold);
  assert.ok(held.has("free"), "the storm on the fallback pair forms a hold there");
  assert.ok(!held.has("paid"), "the abandoned primary is not held");
  assert.equal(
    perf.runProvider(now),
    "paid",
    "a role with no episode keeps reporting the primary, so the free hold does not gate it",
  );
});

test("pollTeamGates: capPaused reflects maxDailyCostUsdPerRole; an absent key yields the empty set", () => {
  const root = tmpdir("gate-polls-cap-");
  const config = defaultConfig();
  config.maxDailyCostUsdPerRole = { docs: 0.5, coverage: 0 };
  const docsState = spentRunnerState("docs", 0.5);
  const runners = [
    fakeRunner("docs", docsState, null, []),
    fakeRunner("coverage", freshRunnerState("coverage"), null, []),
    fakeRunner(DIRECTOR_ROLE, freshRunnerState(DIRECTOR_ROLE), null, []),
  ];

  const states = newTeamGateStates(config);
  const ctx = {
    root,
    runners,
    liveConfig: config,
    modelsPath: path.join(root, "models.json"),
    now: Date.now(),
    info: { pid: process.pid, startedAt: 0, roles: ["docs", "coverage", DIRECTOR_ROLE] },
    // Injected so a hosted runner's real free space cannot add docs to pausedRoles
    // through the disk floor and fail the set-separation assertion below.
    sampleFree: () => 100 * BYTES_PER_GB,
  };

  const first = pollTeamGates(states, ctx);
  assert.ok(first.capPaused.has("docs"), "the over-cap role is blocked on this very poll");
  assert.ok(!first.capPaused.has("coverage"), "a 0 cap disables that role's gate");
  assert.ok(!first.capPaused.has(DIRECTOR_ROLE), "the director is exempt");
  assert.ok(!first.pausedRoles.has("docs"), "no pause marker is written — the sets stay separate");

  // Edge-triggered: a second poll over the cap adds no event, and the set still names the role.
  const second = pollTeamGates(states, ctx);
  assert.ok(second.capPaused.has("docs"));

  // A live edit removing the key lifts the verdict (and logs the resume).
  const lifted = pollTeamGates(states, { ...ctx, liveConfig: { ...config, maxDailyCostUsdPerRole: undefined } });
  assert.equal(lifted.capPaused.size, 0);

  // An absent key from the start: the empty set, no events at all.
  const quiet = newTeamGateStates(config);
  const bare = pollTeamGates(quiet, { ...ctx, liveConfig: { ...config, maxDailyCostUsdPerRole: undefined } });
  assert.equal(bare.capPaused.size, 0);
  assert.equal(readEvents(root, 100).filter((e) => e.type === "role_cap_paused").length, 1);
  assert.equal(readEvents(root, 100).filter((e) => e.type === "role_cap_resumed").length, 1);
});

// The per-tier budget pause (part 5c/8): the gate returns the roles whose tier resolved to
// pause while the cap is reached, and publishes every demoted pair for the dashboards — not
// only the engaged pair's, so a per-tier demotion cannot hide from the operator.
test("pollTeamGates: budgetPausedRoles holds the tiers that resolved to pause, and every demotion is published", () => {
  const root = tmpdir("gate-polls-tier-budget-");
  const modelsPath = writeModelsFile(root, MODELS_JSON);

  const config = defaultConfig();
  config.provider = "paid";
  config.model = "gpt-x";
  config.maxDailyCostUsd = 10;
  config.fallback = { small: "free/qwen-free" }; // strong never borrows small: it pauses
  config.fallbackModel = undefined;
  config.review = { ...config.review, enabled: false }; // isolate the per-tier set
  const atCap = spentRunnerState("docs", 10);
  const planState = spentRunnerState("plan", 1);
  const runners = [
    fakeRunner("docs", atCap, null, []), // small tier: borrows small's pair
    fakeRunner("plan", planState, null, []), // strong tier: resolves to pause
    fakeRunner(DIRECTOR_ROLE, freshRunnerState(DIRECTOR_ROLE), null, []),
  ];

  const states = newTeamGateStates(config);
  const info: OrchestratorInfo = { pid: process.pid, startedAt: 0, roles: ["docs", "plan", DIRECTOR_ROLE] };
  const ctx = {
    root,
    runners,
    liveConfig: config,
    modelsPath,
    now: Date.now(),
    info,
  };

  const first = pollTeamGates(states, ctx);
  assert.equal(first.gate, "fallback", "review off: the strong pause holds only its own roles");
  assert.ok(first.budgetPausedRoles.has("plan"), "the strong-tier role is held");
  assert.ok(!first.budgetPausedRoles.has("docs"), "the small-tier role borrows and keeps running");
  assert.ok(!first.budgetPausedRoles.has(DIRECTOR_ROLE), "the director is exempt");

  // Under the cap: nobody is held.
  const under = spentRunnerState("docs", 1);
  const underCtx = { ...ctx, runners: [fakeRunner("docs", under, null, []), runners[1]!, runners[2]!] };
  const second = pollTeamGates(newTeamGateStates(config), underCtx);
  assert.equal(second.budgetPausedRoles.size, 0);

  // A demotion is published per pair, and the engaged pair's entry also fills the legacy
  // single-pair field the doctor and the failure digest read (the engaged pair is the legacy
  // fallbackModel story, so the publish phase polls a legacy config).
  states.budget.breakers = {
    "free/qwen-free": {
      ...IDLE_FALLBACK_BREAKER,
      pair: "free/qwen-free",
      capUsd: 10,
      failures: 3,
      probeAt: 0,
    },
  };
  const legacy = { ...config, fallback: undefined, fallbackModel: { provider: "free", model: "qwen-free" } };
  pollTeamGates(states, { ...ctx, liveConfig: legacy });
  assert.ok(info.fallbackDemotions?.["free/qwen-free"], "the pair's demotion is published");
  assert.equal(info.fallbackDemoted?.pair, "free/qwen-free", "the engaged pair's entry fills the legacy field");
});

// Per-role quiet hours (PLANS.md quietHoursPerRole): pollTeamGates folds the per-role
// windows into a stateless hold set beside capPaused — no events, no bookkeeping.
test("pollTeamGates: roleQuietHeld names the roles their own quiet window holds; the director is exempt", () => {
  const root = tmpdir("gate-polls-rolequiet-");
  const config = defaultConfig();
  config.quietHoursPerRole = { docs: "00:00-23:59", coverage: "", qa: "23:00-07:00" };
  const runners = [
    fakeRunner("docs", freshRunnerState("docs"), null, []),
    fakeRunner("coverage", freshRunnerState("coverage"), null, []),
    fakeRunner("qa", freshRunnerState("qa"), null, []),
    fakeRunner(DIRECTOR_ROLE, freshRunnerState(DIRECTOR_ROLE), null, []),
  ];
  const ctx = {
    root,
    runners,
    liveConfig: config,
    modelsPath: path.join(root, "models.json"),
    now: Date.now(),
    info: { pid: process.pid, startedAt: 0, roles: ["docs", "coverage", "qa", DIRECTOR_ROLE] },
    // The disk sampler is injected (as the disk test below does) so a hosted runner with
    // little real free space cannot hold docs through the disk floor and fail the
    // pausedRoles assertion (CI's ubuntu-26.04 image, 2026-10-22); this test is about
    // quiet windows alone.
    sampleFree: () => 100 * BYTES_PER_GB,
  };
  // A mid-day poll: docs' near-all-day window holds, coverage's empty window is off, qa's
  // wrapping window only holds late night. `now` is pinned to a fixed local mid-day instead
  // of Date.now() — a real 23:59:xx run fell outside "00:00-23:59" (the end minute is
  // exclusive, inQuietHours) and flaked the suite. Whichever side of 07:00 a caller's clock
  // sits on, docs' and the director's verdicts are time-independent by construction.
  const poll = pollTeamGates(newTeamGateStates(config), {
    ...ctx,
    now: new Date(2026, 9, 6, 12, 0, 0).getTime(),
  });
  assert.ok(poll.roleQuietHeld.has("docs"), "docs' near-all-day window holds at any local time");
  assert.ok(!poll.roleQuietHeld.has("coverage"), "an empty window is off for that role");
  assert.ok(!poll.roleQuietHeld.has(DIRECTOR_ROLE), "the director is exempt");
  assert.ok(!poll.pausedRoles.has("docs"), "no pause marker is written — stateless beside capPaused");

  // A live edit removing the key lifts the verdict on the next poll, and no events were
  // logged for any of it (stateless — the team window's edge events are the only quiet
  // hours events there are).
  const lifted = pollTeamGates(newTeamGateStates(config), {
    ...ctx,
    liveConfig: { ...config, quietHoursPerRole: undefined },
  });
  assert.equal(lifted.roleQuietHeld.size, 0);
  assert.equal(readEvents(root, 100).length, 0);
});

// The disk floor (plans/disk-floor.md, part 1/4): pollTeamGates reads free space through the
// injectable sampler, holds below diskHoldGB, and yields the edge-triggered disk_low/disk_ok.
test("pollTeamGates: a low disk holds new work; recovery and a live floor edit lift it", () => {
  const root = tmpdir("gate-polls-disk-");
  const config = defaultConfig();
  config.diskHoldGB = 10;
  const ctx = {
    root,
    runners: [],
    liveConfig: config,
    modelsPath: path.join(root, "models.json"),
    now: Date.now(),
    info: { pid: process.pid, startedAt: 0, roles: [] },
    sampleFree: () => 9 * BYTES_PER_GB,
  };
  const states = newTeamGateStates(config);
  const first = pollTeamGates(states, ctx);
  assert.equal(first.diskHeld, true, "9 GB free against a 10 GB floor holds");
  // Still inside the hysteresis band below 15 GB: the hold stands, no second event.
  const still = pollTeamGates(states, { ...ctx, sampleFree: () => 14 * BYTES_PER_GB });
  assert.equal(still.diskHeld, true);
  // A live edit to 0 while the hold is active lifts it on the next poll — even though free
  // space sits inside the old hysteresis band — and logs the one disk_ok.
  const off = pollTeamGates(states, {
    ...ctx,
    liveConfig: { ...config, diskHoldGB: 0 },
    sampleFree: () => 1 * BYTES_PER_GB,
  });
  assert.equal(off.diskHeld, false);
  // Back on with a low sample: a fresh crossing logs a second disk_low.
  const heldAgain = pollTeamGates(states, { ...ctx, sampleFree: () => 9 * BYTES_PER_GB });
  assert.equal(heldAgain.diskHeld, true);
  // Reaching the floor + 5 lifts the hold and logs the second disk_ok.
  const lifted = pollTeamGates(states, { ...ctx, sampleFree: () => 15 * BYTES_PER_GB });
  assert.equal(lifted.diskHeld, false);
  assert.deepEqual(
    eventTypes(root).filter((t) => t === "disk_low" || t === "disk_ok"),
    ["disk_low", "disk_ok", "disk_low", "disk_ok"],
  );
});

// Part 4/4: the same poll publishes what it measured, so observers (status, TUI, GUI) do not
// call statfs themselves. One decimal for freeGB, the configured knobs, the hold verdict; an
// unmeasurable sample publishes nothing so the surfaces render exactly as before.
test("pollTeamGates publishes the measured disk state for observers", () => {
  const root = tmpdir("gate-polls-disk-publish-");
  const config = defaultConfig();
  config.diskHoldGB = 10;
  config.diskReclaimGB = 40;
  const ctx = {
    root,
    runners: [],
    liveConfig: config,
    modelsPath: path.join(root, "models.json"),
    now: Date.now(),
    info: { pid: process.pid, startedAt: 0, roles: [] } satisfies OrchestratorInfo,
    sampleFree: () => 9 * BYTES_PER_GB,
  };
  const states = newTeamGateStates(config);
  const readDisk = () => readJson<{ disk: unknown }>(orchestratorStatePath(root)).disk;
  pollTeamGates(states, ctx);
  assert.deepEqual(readDisk(), { freeGB: 9, holdGB: 10, reclaimGB: 40, held: true });
  pollTeamGates(states, { ...ctx, sampleFree: () => 100 * BYTES_PER_GB });
  assert.deepEqual(readDisk(), { freeGB: 100, holdGB: 10, reclaimGB: 40, held: false });
  pollTeamGates(states, { ...ctx, sampleFree: () => null });
  assert.equal(readDisk(), undefined, "an unmeasurable volume publishes nothing");
});

// The orchestrator's poll loop has no catch, and pollTeamGates publishes build/budget/disk
// changes to the info file on most polls. An unwritable state dir (ENOSPC, EACCES, the path
// replaced by a directory) must degrade that published snapshot, not throw out of the poll and
// end the team. Pinned with the info path made a directory, so the atomic writer's rename
// onto it cannot succeed.
test("pollTeamGates: an unwritable orchestrator info file warns instead of throwing", () => {
  const root = tmpdir("gate-polls-info-unwritable-");
  const config = defaultConfig();
  fs.mkdirSync(orchestratorStatePath(root), { recursive: true });
  const states = newTeamGateStates(config);
  const poll = pollTeamGates(states, {
    root,
    runners: [],
    liveConfig: config,
    modelsPath: path.join(root, "models.json"),
    now: Date.now(),
    info: { pid: process.pid, startedAt: 0, roles: [] } satisfies OrchestratorInfo,
  });
  assert.ok(poll.pausedRoles, "the poll still returns its verdicts");
});
