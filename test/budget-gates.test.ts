import test from "node:test";
import assert from "node:assert/strict";
import { gateRoleConfig, newBudgetGateState, pollBudgetGate, runOnPair } from "../src/gates/budget-gates.js";
import { applyFallbackModel, resolveTierFallbacks } from "../src/config/config-fallbacks.js";
import { DIRECTOR_ROLE } from "../src/roles/roles.js";
import { BUDGET_WARNING_FRACTION } from "../src/budget/budget.js";
import { IDLE_FALLBACK_BREAKER } from "../src/budget/fallback-breaker.js";
import { readEvents } from "../src/events/event-read.js";
import { spentRunnerState } from "./fixtures/runner-fixtures.js";
import type { TumwaterConfig } from "../src/config/config-schema.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { eventTypes } from "./fixtures/log-fixtures.js";
import { paidFallbackConfig } from "./fixtures/config-fixtures.js";
import { configForRole, reviewRunConfig } from "../src/config/config-views.js";
import { reviewHoldKey } from "../src/orchestrator/orchestrator-scheduling.js";
import { writeClaudeAccount } from "../src/agent/claude/claude-account.js";
import { defaultConfig } from "../src/config/config.js";
import { MODELS_JSON, PAID_ONLY_JSON, writeModelsFile, writeOpencodeCache } from "./fixtures/models-fixtures.js";
/** A team at a paid top-level model, a free fallback configured, one role pinned to the
 * paid model, and a reviewer override — everything the fallback view must strip. */
function configWith(capUsd: number): TumwaterConfig {
  const cfg = paidFallbackConfig(capUsd);
  cfg.roles.feature = { ...cfg.roles.feature, provider: "paid", model: "gpt-x", enabled: true };
  cfg.review = { ...cfg.review, provider: "paid", model: "gpt-x" };
  return cfg;
}

function poll(root: string, state: ReturnType<typeof newBudgetGateState>, cfg: TumwaterConfig, modelsPath: string, states = [spentRunnerState("feature", 0)]) {
  return pollBudgetGate(state, { root, states, liveConfig: cfg, modelsPath });
}

test("pollBudgetGate keeps the gate open under the cap and hands the live config straight through", () => {
  const root = tmpdir("budget-gates-");
  const models = writeModelsFile(root, MODELS_JSON);
  const cfg = configWith(10);
  const state = newBudgetGateState(cfg);

  const p = poll(root, state, cfg, models, [spentRunnerState("feature", 5)]);
  assert.equal(p.gate, "open");
  assert.equal(p.onFallback, false);
  assert.equal(p.roleConfig, cfg); // same object: no view is derived while budget remains
  // The poll hands back the spend/cap pair it just evaluated — the figures the orchestrator
  // publishes for the dashboards (BUGS.md 2026-09-30). Disabled cap: the spend still rides
  // along (a disabled team's badge keeps its dollar figure).
  assert.deepEqual({ spentUsd: p.spentUsd, capUsd: p.capUsd }, { spentUsd: 5, capUsd: 10 });
  assert.deepEqual(readEvents(root), []); // no transition, no events
});

test("crossing the cap engages the fallback once: one event, the derived role view, no re-derives", () => {
  const root = tmpdir("budget-gates-");
  const models = writeModelsFile(root, MODELS_JSON);
  const cfg = configWith(10);
  const state = newBudgetGateState(cfg);
  const over = [spentRunnerState("feature", 10)]; // exactly at the cap (>=)

  const p = poll(root, state, cfg, models, over);
  assert.equal(p.gate, "fallback");
  assert.equal(p.onFallback, true);
  assert.deepEqual({ spentUsd: p.spentUsd, capUsd: p.capUsd }, { spentUsd: 10, capUsd: 10 }); // the tripped-on pair
  // The role view: the per-tier model map rewritten to the resolved pairs (part 5c/8 — the
  // single fallback resolves default own and the others borrowed, so every tier reads the
  // same free pair), every override dropped, everything else (the cap itself among it)
  // untouched.
  assert.equal(p.roleConfig.provider, undefined);
  assert.deepEqual(p.roleConfig.model, {
    small: "free/qwen-free",
    default: "free/qwen-free",
    strong: "free/qwen-free",
  });
  assert.equal(p.roleConfig.maxDailyCostUsd, 10);
  assert.equal(p.roleConfig.roles.feature?.model, undefined);
  assert.equal(p.roleConfig.roles.feature?.provider, undefined);
  assert.equal(p.roleConfig.review.model, undefined);

  // Exactly one edge-triggered event, naming the fallback that took over.
  const events = readEvents(root);
  assert.deepEqual(events.map((e) => e.type), ["budget_fallback"]);
  const ev = events[0]!;
  assert.equal(ev.source, "tumwater");
  assert.equal(ev.provider, "free");
  assert.equal(ev.model, "qwen-free");
  // One fallback pair resolves every tier to it (small and strong borrow default's own), so
  // the event stays tier-free (part 7b/8): today's single-pair readers keep today's text.
  assert.equal(ev.tiers, undefined);
  assert.deepEqual(ev.topRoles, [{ role: "feature", spentUsd: 10 }]);
  assert.equal(ev.capUsd, 10);
  assert.ok(typeof ev.spentUsd === "number" && ev.spentUsd >= 10);

  // A second poll with the same live config: no new event, the same derived view
  // (memoized on the config object, not re-derived every poll).
  const p2 = poll(root, state, cfg, models, over);
  assert.equal(p2.gate, "fallback");
  assert.equal(p2.onFallback, true);
  assert.equal(p2.roleConfig, state.fallbackConfig); // still the one derived view
  assert.equal(readEvents(root).length, 1); // edge-triggered: no second budget_fallback
});

test("a tiered fallback with two distinct pairs carries the per-tier map on the event", () => {
  const root = tmpdir("budget-gates-");
  const models = writeModelsFile(root, MODELS_JSON);
  const cfg = configWith(10);
  // Part 7b/8: default runs its own pair and strong declares a DIFFERENT free one — the two
  // distinct pairs the badge and the feed list. Small borrows default's (its own tier
  // declares nothing), so its label carries the `(from default)` suffix.
  cfg.fallback = { default: "free/qwen-free", strong: "free/llama-free" };
  const state = newBudgetGateState(cfg);

  const p = poll(root, state, cfg, models, [spentRunnerState("feature", 10)]);
  assert.equal(p.gate, "fallback");
  const events = readEvents(root);
  assert.deepEqual(events.map((e) => e.type), ["budget_fallback"]);
  const ev = events[0]!;
  assert.equal(ev.provider, "free");
  assert.equal(ev.model, "qwen-free"); // the default tier's pair, as before
  assert.deepEqual(ev.tiers, {
    small: "free/qwen-free (from default)",
    default: "free/qwen-free",
    strong: "free/llama-free",
  });
});

test("at the cap an opencode-free team keeps its primary; a priced pi role moves to the fallback (part 6b/7)", () => {
  const root = tmpdir("budget-gates-opencode-");
  writeOpencodeCache(root); // the catalog pollBudgetGate prices opencode seams against
  const models = writeModelsFile(root, MODELS_JSON);
  const cfg = defaultConfig();
  // Every tier's own seam routes to the catalog-free opencode gateway model.
  cfg.backend = "opencode"; cfg.model = "deepseek-v4.1-flash-free";
  // A free pi fallback pair, so the gate has a pair to engage when the cap is reached.
  cfg.fallbackModel = { provider: "free", model: "qwen-free" };
  cfg.maxDailyCostUsd = 10;
  // One role pinned to a priced pi model — the spend that trips the cap.
  cfg.roles.feature = { ...cfg.roles.feature, provider: "paid", model: "gpt-x", enabled: true };
  const state = newBudgetGateState(cfg);
  const over = [spentRunnerState("feature", 10), spentRunnerState("clean", 0)];
  const p = poll(root, state, cfg, models, over);
  assert.equal(p.gate, "fallback");
  assert.equal(p.onFallback, true);
  // The free opencode tiers keep their own primary selector in the derived view — they are
  // free, so the cap must not move them to the pi fallback.
  const modelView = p.roleConfig.model as Record<string, string>;
  assert.equal(modelView.default, "deepseek-v4.1-flash-free");
  assert.equal(modelView.strong, "deepseek-v4.1-flash-free");
  // The priced pi role is the one moved: its override is stripped so it runs its tier's
  // free fallback pair, and the opencode model map never sends it back to `paid/gpt-x`.
  assert.equal(p.roleConfig.roles.feature?.provider, undefined);
  assert.equal(p.roleConfig.roles.feature?.model, undefined);
});

test("raising the cap resumes the gate: one budget_resumed event and the live config again", () => {
  const root = tmpdir("budget-gates-");
  const models = writeModelsFile(root, MODELS_JSON);
  const cfg = configWith(10);
  const state = newBudgetGateState(cfg);
  poll(root, state, cfg, models, [spentRunnerState("feature", 10)]); // engage the fallback first

  const raised = configWith(100);
  const p = poll(root, state, raised, models, [spentRunnerState("feature", 10)]);
  assert.equal(p.gate, "open");
  assert.equal(p.onFallback, false);
  assert.equal(p.roleConfig, raised); // the fallback view is dropped at once
  assert.deepEqual(eventTypes(root), ["budget_fallback", "budget_resumed"]);
  assert.equal("topRoles" in readEvents(root)[1]!, false);
});

test("resumed is true on exactly the reopening poll, with the fallback pair it left", () => {
  const root = tmpdir("budget-gates-");
  const models = writeModelsFile(root, MODELS_JSON);
  const cfg = configWith(10);
  const state = newBudgetGateState(cfg);

  // Open → fallback: the engagement poll is not a resume, but it carries the pair.
  const p0 = poll(root, state, cfg, models, [spentRunnerState("feature", 10)]);
  assert.equal(p0.gate, "fallback");
  assert.equal(p0.resumed, false);
  assert.deepEqual(p0.pairs, [{ provider: "free", model: "qwen-free" }]);

  // Holding the fallback: still not a resume.
  assert.equal(poll(root, state, cfg, models, [spentRunnerState("feature", 10)]).resumed, false);

  // fallback → open (cap raised): exactly the resume, naming the pair the gate just left.
  const p2 = poll(root, state, configWith(100), models, [spentRunnerState("feature", 10)]);
  assert.equal(p2.gate, "open");
  assert.equal(p2.resumed, true);
  assert.deepEqual(p2.pairs, [{ provider: "free", model: "qwen-free" }]);

  // Staying open poll after poll: no further resumes.
  assert.equal(poll(root, state, configWith(100), models, [spentRunnerState("feature", 10)]).resumed, false);

  // paused → open is a resume too: runs parked on the fallback view while the breaker had
  // the gate paused must be handed back exactly like fallback-held ones.
  const paidOnlyDir = tmpdir("budget-gates-paid-");
  const paidOnly = writeModelsFile(paidOnlyDir, PAID_ONLY_JSON);
  const state2 = newBudgetGateState(cfg);
  assert.equal(poll(root, state2, cfg, paidOnly, [spentRunnerState("feature", 10)]).gate, "paused");
  const p5 = poll(root, state2, configWith(100), paidOnly, [spentRunnerState("feature", 10)]);
  assert.equal(p5.gate, "open");
  assert.equal(p5.resumed, true);

  // Open from the start (no transition at all): not a resume.
  const state3 = newBudgetGateState(cfg);
  assert.equal(poll(root, state3, cfg, models, [spentRunnerState("feature", 5)]).resumed, false);
});

test("crossing 80% of the cap warns once while the gate is open, and re-arms after dropping below", () => {
  const root = tmpdir("budget-gates-");
  const models = writeModelsFile(root, MODELS_JSON);
  const cfg = configWith(10);
  const state = newBudgetGateState(cfg);
  assert.equal(state.warned, false); // a fresh poll state starts unarmed
  const threshold = 10 * BUDGET_WARNING_FRACTION; // 8 of a 10 cap

  // Under the threshold: silent.
  poll(root, state, cfg, models, [spentRunnerState("feature", threshold - 2)]);
  assert.deepEqual(readEvents(root), []);

  // Crossing 80% with the gate still open: exactly one budget_warning.
  poll(root, state, cfg, models, [spentRunnerState("feature", threshold)]);
  let events = readEvents(root);
  assert.deepEqual(events.map((e) => e.type), ["budget_warning"]);
  assert.equal(events[0]!.source, "tumwater");
  assert.equal(events[0]!.capUsd, 10);
  assert.equal(events[0]!.spentUsd, threshold);
  assert.deepEqual(events[0]!.topRoles, [{ role: "feature", spentUsd: threshold }]);

  // Still above the threshold: edge-triggered, no second warning.
  poll(root, state, cfg, models, [spentRunnerState("feature", threshold + 1)]);
  assert.equal(readEvents(root).length, 1);

  // Dropping back below (a new local day, a raised cap) re-arms: crossing again warns again.
  poll(root, state, cfg, models, [spentRunnerState("feature", threshold - 3)]); // still open the whole time: no transition events
  poll(root, state, cfg, models, [spentRunnerState("feature", threshold)]);
  assert.deepEqual(eventTypes(root), ["budget_warning", "budget_warning"]);
});

test("the budget warning names the roles spending most, highest first", () => {
  const root = tmpdir("budget-gates-");
  const models = writeModelsFile(root, MODELS_JSON);
  const cfg = configWith(10);
  const state = newBudgetGateState(cfg);
  poll(root, state, cfg, models, [spentRunnerState("plan", 2), spentRunnerState("feature", 6)]);
  assert.deepEqual(readEvents(root)[0]!.topRoles, [
    { role: "feature", spentUsd: 6 },
    { role: "plan", spentUsd: 2 },
  ]);
});

test("no budget warning at the cap itself, and none with the cap disabled", () => {
  const root = tmpdir("budget-gates-");
  const models = writeModelsFile(root, MODELS_JSON);
  const cfg = configWith(10);
  const state = newBudgetGateState(cfg);

  // Straight to the cap: the fallback transition logs its own event, the warning never
  // doubles the page on the poll the gate stops being open.
  poll(root, state, cfg, models, [spentRunnerState("feature", 10)]);
  assert.deepEqual(eventTypes(root), ["budget_fallback"]);

  // A cap of 0 disables the budget entirely: no warning at any spend.
  const state2 = newBudgetGateState(configWith(0));
  poll(root, state2, configWith(0), models, [spentRunnerState("feature", 100)]);
  assert.deepEqual(eventTypes(root), ["budget_fallback"]);
});

test("runOnPair matches only an in-flight run on the fallback pair", () => {
  const pair = { provider: "local", model: "local-free" };
  assert.equal(runOnPair({ provider: "local", model: "local-free" }, pair), true);
  assert.equal(runOnPair({ provider: "paid", model: "big-paid" }, pair), false, "a primary run keeps running");
  assert.equal(runOnPair(null, pair), false, "an idle loop has nothing to hand back");
  assert.equal(runOnPair({ provider: "local", model: "local-free" }, null), false, "no fallback, no handback");
  // A claude fallback pair (PLANS.md "Mixed claude + pi fleets, part 2/4"): setRunPair now
  // keys the in-flight run by the seam that ran (seamHoldKey → "claude"), and the fallback
  // pair is seam-keyed the same way (config-fallbacks.ts's seamKeyedPairFields names the
  // backend for a bare `<id>` selector on a claude team) — so a
  // claude fallback run IS handed back, and a run whose provider is
  // a different seam (a pi `omlx` author here) never matches and is not returned.
  const claude = { provider: "claude", model: "claude-sonnet-5-5" };
  assert.equal(runOnPair({ provider: "claude", model: "claude-sonnet-5-5" }, claude), true);
  assert.equal(
    runOnPair({ provider: "omlx", model: "claude-sonnet-5-5" }, claude),
    false,
    "a run on a different seam is not handed back to the claude fallback",
  );
  // A bare-selector claude fallback never reaches runOnPair with provider undefined: the
  // fallback pair is seam-keyed at creation (config-views.test.ts, seamKeyedPairFields),
  // so a bare `<id>` on a claude team produces the `claude` pair above
  // and hands the run back through this same match.
});

test("a fallback pi prices above zero cannot engage: the gate pauses and the event says why", () => {
  const root = tmpdir("budget-gates-");
  const models = writeModelsFile(root, PAID_ONLY_JSON);
  const cfg = configWith(10);
  const state = newBudgetGateState(cfg);

  const p = poll(root, state, cfg, models, [spentRunnerState("feature", 10)]);
  assert.equal(p.gate, "paused");
  assert.equal(p.onFallback, false);
  assert.equal(p.roleConfig, cfg); // no fallback view while nothing is engaged

  const events = readEvents(root);
  assert.deepEqual(events.map((e) => e.type), ["budget_paused"]);
  assert.equal(events[0]!.fallbackRejected, "free/qwen-free"); // the pair the operator asked for
  assert.deepEqual(events[0]!.topRoles, [{ role: "feature", spentUsd: 10 }]);
  assert.equal(events[0]!.capUsd, 10);
});

test("a claude-routed fallback cannot engage even when models.json prices its namespace at zero", () => {
  // The same refusal as a priced pi pair: pi's pricing cannot see claude CLI billing, so a
  // models.json that happens to list a free `claude` provider must not let the gate engage it
  // and run unpriceable spend past the cap (plans/agent-backends.md "Config" step 4).
  const root = tmpdir("budget-gates-");
  const models = writeModelsFile(
    root,
    JSON.stringify({ providers: { claude: { models: [{ id: "claude-sonnet-5-5", cost: { input: 0, output: 0 } }] } } }),
  );
  const cfg = configWith(10);
  cfg.fallback = [{ backend: "claude", model: "claude-sonnet-5-5" }];
  const state = newBudgetGateState(cfg);

  const p = poll(root, state, cfg, models, [spentRunnerState("feature", 10)]);
  assert.equal(p.gate, "paused");
  assert.equal(p.onFallback, false);
  assert.equal(p.roleConfig, cfg); // no fallback view while nothing is engaged

  const events = readEvents(root);
  assert.deepEqual(events.map((e) => e.type), ["budget_paused"]);
  assert.equal(events[0]!.fallbackRejected, "claude/claude-sonnet-5-5");
});

test("an unseeded claude fallback cannot engage — the startup seed is what frees it", () => {
  // gap 1 of plans/provider-concurrency.md §9: before startup seeded the account for a
  // fallback-only claude, no claude-account.json existed, seamFree judged the claude pair
  // priced, and the gate refused `fallback: claude/...` at the cap unless a test (or operator)
  // wrote the file by hand. The startup gate now runs seedClaudeAccount for the fallback seam
  // (test/startup-gate.test.ts), so a subscription claude fallback reads free — the sibling
  // test below — without any hand-written file.
  const root = tmpdir("budget-gates-");
  const models = writeModelsFile(root, MODELS_JSON);
  const cfg = configWith(10);
  cfg.fallback = [{ backend: "claude", model: "claude-sonnet-5-5" }];
  const state = newBudgetGateState(cfg);
  const p = poll(root, state, cfg, models, [spentRunnerState("feature", 10)]);
  assert.equal(p.gate, "paused");
  assert.equal(p.onFallback, false);
});

test("a subscription claude fallback engages at the cap", () => {
  const root = tmpdir("budget-gates-");
  const models = writeModelsFile(
    root,
    JSON.stringify({ providers: { claude: { models: [{ id: "claude-sonnet-5-5", cost: { input: 0, output: 0 } }] } } }),
  );
  writeClaudeAccount(root, { billing: "subscription", observedAt: Date.now(), windows: {} });
  const cfg = configWith(10);
  cfg.fallback = [{ backend: "claude", model: "claude-sonnet-5-5" }];
  const state = newBudgetGateState(cfg);

  const p = poll(root, state, cfg, models, [spentRunnerState("feature", 10)]);
  assert.equal(p.gate, "fallback"); // the subscription fallback is free money, not refused
  const claudeEntry = { backend: "claude", model: "claude-sonnet-5-5" };
  assert.deepEqual(p.roleConfig.model, { small: claudeEntry, default: claudeEntry, strong: claudeEntry });
  const events = readEvents(root);
  assert.deepEqual(events.map((e) => e.type), ["budget_fallback"]);
  assert.equal(events[0]!.provider, "claude");
  assert.equal(events[0]!.model, "claude-sonnet-5-5");
});

test("a subscription claude seam stays put at the cap while a priced pi seam moves", () => {
  const root = tmpdir("budget-gates-");
  const models = writeModelsFile(root, MODELS_JSON);
  writeClaudeAccount(root, { billing: "subscription", observedAt: Date.now(), windows: {} });
  const cfg = configWith(10);
  // The top level is paid, written as a selector so a claude section inherits no pi provider.
  cfg.provider = undefined;
  cfg.model = "paid/gpt-x";
  // One role pinned to subscription claude, one to a priced pi model.
  cfg.roles.feature = { ...cfg.roles.feature, provider: undefined, backend: "claude", model: "claude-sonnet-5-5", enabled: true };
  cfg.roles.plan = { enabled: true, provider: "paid", model: "gpt-x" };
  const state = newBudgetGateState(cfg);

  const p = poll(root, state, cfg, models, [spentRunnerState("feature", 10)]);
  assert.equal(p.gate, "fallback");
  const feature = configForRole(p.roleConfig, "feature");
  assert.equal(feature.agent, "claude", "the free seam keeps its backend");
  assert.equal(feature.model, "claude-sonnet-5-5", "the free seam keeps its model");
  const plan = configForRole(p.roleConfig, "plan");
  assert.equal(plan.provider, "free", "the priced seam moves to its fallback");
  assert.equal(plan.model, "qwen-free");
});

test("an overage subscription claude seam moves to its fallback at the cap", () => {
  const root = tmpdir("budget-gates-");
  const models = writeModelsFile(root, MODELS_JSON);
  // The account bills a subscription but is spending into overage: that overflow is real money
  // (plans/agent-backends.md §7), so the seam is priced and the cap moves it.
  writeClaudeAccount(root, {
    billing: "subscription",
    observedAt: Date.now(),
    windows: { five_hour: { status: "allowed", isUsingOverage: true, observedAt: Date.now() } },
  });
  const cfg = configWith(10);
  cfg.roles.feature = { ...cfg.roles.feature, provider: undefined, backend: "claude", model: "claude-sonnet-5-5", enabled: true };
  const state = newBudgetGateState(cfg);

  const p = poll(root, state, cfg, models, [spentRunnerState("feature", 10)]);
  assert.equal(p.gate, "fallback");
  const feature = configForRole(p.roleConfig, "feature");
  assert.equal(feature.provider, "free", "an overage claude seam is priced and moves");
  assert.equal(feature.model, "qwen-free");
});

test("a demoted fallback keeps the gate paused and the role view: demotion never promotes to the paid model", () => {
  const root = tmpdir("budget-gates-");
  const models = writeModelsFile(root, MODELS_JSON);
  const cfg = configWith(10);
  const state = newBudgetGateState(cfg);
  // The breaker already tripped: three consecutive failures on the engaged pair, a probe
  // allowed from now on. Keyed to the same pair and cap the poll re-keys against, so the
  // judgment survives the rekey.
  state.breakers = {
    "free/qwen-free": {
      ...IDLE_FALLBACK_BREAKER,
      pair: "free/qwen-free",
      capUsd: 10,
      failures: 3,
      probeAt: 0, // demoted; the probe is already due
    },
  };

  const p = poll(root, state, cfg, models, [spentRunnerState("feature", 10)]);
  assert.equal(p.gate, "paused"); // free but not serving: paused, like no fallback at all
  assert.equal(p.onFallback, true); // yet runs parked in flight still run on the free pair
  assert.equal(p.roleConfig.provider, undefined);
  assert.deepEqual(p.roleConfig.model, {
    small: "free/qwen-free",
    default: "free/qwen-free",
    strong: "free/qwen-free",
  });
  assert.equal(p.roleConfig.roles.feature?.model, undefined);

  const events = readEvents(root);
  assert.deepEqual(events.map((e) => e.type), ["budget_paused"]);
  assert.equal(events[0]!.fallbackDemoted, "free/qwen-free");
  assert.equal(events[0]!.failures, 3);
});

test("a demoted strong-tier pair names itself as the pause cause when only strong declares a fallback", () => {
  const root = tmpdir("budget-gates-strong-pause-");
  const models = writeModelsFile(root, MODELS_JSON);
  const cfg = configWith(10);
  // Only the strong tier declares a fallback, so the legacy default pair (fallbackPair, the
  // map's `default` entry) is null while strong's price-only resolution still holds the pair.
  // Default and small borrow strong's pair, so demoting it resolves every tier to pause; the
  // event must name the strong pair the tiers would have run on, not read as the default
  // pair's own demotion.
  cfg.fallback = { strong: "free/llama-free" };
  cfg.fallbackModel = undefined;
  const state = newBudgetGateState(cfg);
  state.breakers = {
    "free/llama-free": {
      ...IDLE_FALLBACK_BREAKER,
      pair: "free/llama-free",
      capUsd: 10,
      failures: 3,
      probeAt: 0, // demoted; the probe is already due
    },
  };

  const p = poll(root, state, cfg, models, [spentRunnerState("feature", 10)]);
  assert.equal(p.gate, "paused");
  assert.equal(p.priceResolved.strong.pair?.model, "llama-free", "the price-only resolution keeps the pair");
  assert.equal(p.servingResolved.strong.pair, null, "the breaker demotion drops it from the serving view");

  const events = readEvents(root);
  assert.deepEqual(events.map((e) => e.type), ["budget_paused"]);
  assert.equal(events[0]!.fallbackDemoted, "free/llama-free");
  assert.equal(events[0]!.fallbackRejected, undefined, "not the default pair's own refusal");
  assert.equal(events[0]!.failures, 3);
});

// The per-tier gate semantics (part 5c/8): the gate folds the DEMOTION-AWARE resolution of the
// `default` and `strong` tiers — a tier resolved to pause holds its own roles beside the per-role
// cap set, and with review on an unresolvable strong tier pauses the whole gate (nothing could
// merge).
test("review on and strong unresolvable pauses the gate; review off holds only its roles", () => {
  const root = tmpdir("budget-gates-tier-");
  const models = writeModelsFile(root, MODELS_JSON);
  const cfg = configWith(10);
  // Only the small tier declares a fallback: default borrows it, strong never borrows small
  // and pauses — the plan role is the strong-tier role the acceptance names.
  cfg.fallback = { small: "free/qwen-free" };
  cfg.fallbackModel = undefined;
  const state = newBudgetGateState(cfg);

  const p = poll(root, state, cfg, models, [spentRunnerState("feature", 10)]);
  assert.equal(p.gate, "paused", "review on: nothing could merge, the gate pauses");
  assert.equal(p.servingResolved.strong.pair, null);
  assert.ok(p.servingResolved.default.pair !== null, "default still resolves (borrowing small)");
  assert.ok(p.budgetActive);

  // Review off: the same config keeps the gate on fallback — only the strong roles are held
  // (the per-tier pause set), the rest keep running.
  const off = { ...cfg, review: { ...cfg.review, enabled: false } };
  const p2 = pollBudgetGate(newBudgetGateState(off), { root, states: [spentRunnerState("feature", 10)], liveConfig: off, modelsPath: models });
  assert.equal(p2.gate, "fallback");
  assert.equal(p2.servingResolved.strong.pair, null, "strong still resolves to pause — the set holds it");
});

test("an unborrowable strong tier pauses the gate without naming the serving default pair as demoted", () => {
  const root = tmpdir("budget-gates-strong-unborrowable-");
  const models = writeModelsFile(root, MODELS_JSON);
  const cfg = configWith(10);
  // Only small declares a fallback: default borrows it and serves, while strong cannot borrow
  // small and pauses. Review on pauses the gate, but the default pair is free, resolved and
  // serving — the pause cause must not read as that pair's own demotion (failures 0).
  cfg.fallback = { small: "free/qwen-free" };
  cfg.fallbackModel = undefined;
  const state = newBudgetGateState(cfg);

  const p = poll(root, state, cfg, models, [spentRunnerState("feature", 10)]);
  assert.equal(p.gate, "paused");
  assert.equal(p.servingResolved.strong.pair, null);
  assert.equal(state.engaged, "free/qwen-free", "the serving default pair is still the engaged one");

  const events = readEvents(root);
  assert.deepEqual(events.map((e) => e.type), ["budget_paused"]);
  assert.equal(events[0]!.fallbackDemoted, undefined, "the serving default pair is not demoted");
  assert.equal(events[0]!.fallbackRejected, undefined, "the serving default pair is not refused");
  assert.equal(events[0]!.failures, undefined);
});

test("a map with no default entry engages the gate and reports the borrowed pair", () => {
  const root = tmpdir("budget-gates-no-default-");
  const models = writeModelsFile(root, MODELS_JSON);
  const cfg = configWith(10);
  // No `default` key: the default tier borrows strong's pair (default → strong → small), so
  // the gate runs a fallback and state.engaged must name it instead of staying null.
  cfg.fallback = { small: "free/qwen-free", strong: "free/llama-free" };
  cfg.fallbackModel = undefined;
  cfg.review = { ...cfg.review, enabled: false };
  const state = newBudgetGateState(cfg);

  const p = poll(root, state, cfg, models, [spentRunnerState("feature", 10)]);
  assert.equal(p.gate, "fallback");
  assert.deepEqual(p.priceResolved.default, {
    pair: { provider: "free", model: "llama-free" },
    from: "strong",
  });
  assert.equal(state.engaged, "free/llama-free");
  const events = readEvents(root);
  assert.deepEqual(events.map((e) => e.type), ["budget_fallback"]);
  assert.equal(events[0]!.provider, "free");
  assert.equal(events[0]!.model, "llama-free");
});

test("a breaker-demoted pair re-resolves only the tiers using it", () => {
  const root = tmpdir("budget-gates-demoted-tier-");
  const models = writeModelsFile(root, MODELS_JSON);
  const cfg = configWith(10);
  cfg.fallback = { default: "free/qwen-free", strong: "free/llama-free" };
  cfg.fallbackModel = undefined;
  const state = newBudgetGateState(cfg);
  state.breakers = {
    "free/llama-free": {
      ...IDLE_FALLBACK_BREAKER,
      pair: "free/llama-free",
      capUsd: 10,
      failures: 3,
      probeAt: 0, // demoted; the probe is already due
    },
  };

  const p = poll(root, state, cfg, models, [spentRunnerState("feature", 10)]);
  // The demoted strong pair re-resolves strong alone: it borrows default's own pair (a
  // downgrade, not a pause), and default/small keep exactly what they had.
  assert.equal(p.gate, "fallback");
  assert.deepEqual(
    p.servingResolved.strong.pair && { provider: p.servingResolved.strong.pair.provider, model: p.servingResolved.strong.pair.model },
    { provider: "free", model: "qwen-free" },
    "strong borrows the default pair it may borrow",
  );
  assert.deepEqual(
    p.servingResolved.default.pair && { provider: p.servingResolved.default.pair.provider, model: p.servingResolved.default.pair.model },
    { provider: "free", model: "qwen-free" },
  );
  assert.equal(p.servingResolved.small.from, "default");
  // The price-based resolution keeps the demoted pair among the keys (the view and the probe
  // still reach it) — the serving resolution is what dropped it.
  assert.ok(p.pairs.some((q) => q.model === "llama-free"), "the demoted pair stays installed for its probe");
});

test("the breaker map is keyed per resolved pair: tiers sharing a fallback share one entry", () => {
  const root = tmpdir("budget-gates-");
  const models = writeModelsFile(root, MODELS_JSON);
  const cfg = configWith(10);
  // Per-tier fallbacks: small and default declare the same free pair (they share one
  // breaker), strong declares a priced one it must never use.
  cfg.fallback = { default: "free/qwen-free", small: "free/qwen-free", strong: "paid/gpt-x" };
  cfg.fallbackModel = undefined;
  const state = newBudgetGateState(cfg);

  const p = poll(root, state, cfg, models, [spentRunnerState("feature", 10)]);
  assert.equal(p.gate, "fallback");
  // The priced pair is not resolvable, so the map holds only the free pair the tiers
  // actually resolve to — small's own, default's own, and strong's borrowed default.
  assert.deepEqual(Object.keys(state.breakers), ["free/qwen-free"]);
  assert.equal(state.engaged, "free/qwen-free");
});

function rejectedWindow(root: string, resetsAt = Date.now() + 3_600_000) {
  writeClaudeAccount(root, {
    billing: "subscription",
    observedAt: Date.now(),
    windows: { five_hour: { status: "rejected", resetsAt, observedAt: Date.now() } },
  });
}

test("a used-up claude window moves subscription claude roles to the fallback below the cap; priced pi keeps its primary", () => {
  const root = tmpdir("budget-gates-");
  const models = writeModelsFile(root, MODELS_JSON);
  rejectedWindow(root);
  const cfg = configWith(10);
  cfg.provider = undefined;
  cfg.backend = "claude"; cfg.model = "claude-sonnet-5-5";
  cfg.roles.feature = { enabled: true };
  cfg.roles.plan = { enabled: true, backend: "pi", provider: "paid", model: "gpt-x" };
  cfg.roles.bugfix = { enabled: true, backend: "claude", model: "claude-sonnet-5-5" };
  const state = newBudgetGateState(cfg);

  const p = poll(root, state, cfg, models, [spentRunnerState("feature", 1)]);
  assert.equal(p.gate, "open", "gate keeps meaning the cap");
  assert.equal(p.onFallback, false, "the cap flag stays off");
  assert.equal(p.windowOut?.type, "five_hour");
  const feature = configForRole(p.roleConfig, "feature");
  assert.equal(feature.provider, "free", "the claude role moved to the fallback pair");
  assert.equal(feature.model, "qwen-free");
  const plan = configForRole(p.roleConfig, "plan");
  assert.equal(plan.provider, "paid", "a priced pi role keeps its primary below the cap");
  assert.equal(plan.model, "gpt-x");
  assert.ok(Object.keys(p.windowTiers).length > 0, "the moved tiers are named");
  assert.equal(p.windowResumed, false);
});

test("chain: a rejected window puts the claude tier on its fallback step; under the cap with no window it is empty", () => {
  const root = tmpdir("budget-gates-chain-");
  const models = writeModelsFile(root, MODELS_JSON);
  const resetsAt = Date.now() + 3_600_000;
  rejectedWindow(root, resetsAt);
  const cfg = configWith(10);
  cfg.provider = undefined;
  cfg.backend = "claude"; cfg.model = "claude-sonnet-5-5";
  const p = poll(root, newBudgetGateState(cfg), cfg, models, [spentRunnerState("feature", 1)]);
  assert.deepEqual(p.chain.default, { pair: "free/qwen-free", step: 1, of: 1, reason: "window", returnsAt: resetsAt });

  const root2 = tmpdir("budget-gates-chain-open-");
  const models2 = writeModelsFile(root2, MODELS_JSON);
  const cfg2 = configWith(10);
  assert.deepEqual(poll(root2, newBudgetGateState(cfg2), cfg2, models2, [spentRunnerState("feature", 1)]).chain, {});
});

test("chain: at the cap a priced tier lists its fallback step, a free primary stays unlisted", () => {
  const root = tmpdir("budget-gates-chain-cap-");
  const models = writeModelsFile(root, MODELS_JSON);
  const over = [spentRunnerState("feature", 10)];
  const paid = configWith(10);
  const onPaid = poll(root, newBudgetGateState(paid), paid, models, over);
  assert.equal(onPaid.chain.default?.pair, "free/qwen-free");
  assert.equal(onPaid.chain.default?.reason, "cap");

  const free = configWith(10);
  free.provider = "free";
  free.model = "qwen-free";
  const onFree = poll(root, newBudgetGateState(free), free, models, over);
  assert.equal(onFree.chain.default, undefined, "a free primary never moved, so it has no chain entry");
});

test("a used-up claude window resolves a claude reviewer to the fallback, and returns on reset", () => {
  const root = tmpdir("budget-gates-");
  const models = writeModelsFile(root, MODELS_JSON);
  rejectedWindow(root);
  const cfg = configWith(10);
  cfg.provider = undefined;
  cfg.model = "paid/gpt-x";
  cfg.review = { ...cfg.review, provider: undefined, backend: "claude", model: "claude-sonnet-5-5" };
  const state = newBudgetGateState(cfg);

  const out = poll(root, state, cfg, models);
  const seam = reviewRunConfig(out.roleConfig);
  assert.deepEqual([seam.provider, seam.model], ["free", "qwen-free"], "the claude-pinned reviewer lands on the fallback pair, not the tier's priced primary");
  assert.notEqual(reviewHoldKey(out.roleConfig), reviewHoldKey(cfg), "the reviewer left the claude hold, so reviewHeld stops no role");
  writeClaudeAccount(root, { billing: "subscription", observedAt: Date.now(), windows: {} });
  const back = poll(root, state, cfg, models);
  assert.equal(back.roleConfig, cfg, "the live config returns when the window resets");
  assert.equal(back.windowResumed, true);
  assert.equal(poll(root, state, cfg, models).windowResumed, false, "one poll only");
});

test("a used-up claude window with no fallback leaves the live config for the hold", () => {
  const root = tmpdir("budget-gates-");
  const models = writeModelsFile(root, MODELS_JSON);
  rejectedWindow(root);
  const cfg = configWith(10);
  cfg.fallback = undefined;
  cfg.fallbackModel = undefined;
  cfg.roles.feature = { ...cfg.roles.feature, provider: undefined, backend: "claude", model: "claude-sonnet-5-5", enabled: true };
  const state = newBudgetGateState(cfg);
  const p = poll(root, state, cfg, models);
  assert.equal(p.roleConfig, cfg);
  assert.deepEqual(p.windowTiers, {});
  assert.equal(p.windowResumed, false);
});

test("a used-up claude window refuses a subscription claude fallback pair", () => {
  const root = tmpdir("budget-gates-");
  const models = writeModelsFile(
    root,
    JSON.stringify({ providers: { claude: { models: [{ id: "claude-sonnet-5-5", cost: { input: 0, output: 0 } }] } } }),
  );
  rejectedWindow(root);
  const cfg = configWith(10);
  cfg.fallback = [{ backend: "claude", model: "claude-sonnet-5-5" }];
  const state = newBudgetGateState(cfg);
  const p = poll(root, state, cfg, models, [spentRunnerState("feature", 10)]);
  assert.equal(p.gate, "paused", "a claude pair meets the same window, so the cap pauses");
});

test("a used-up claude window leaves a claude-pinned role under a priced pi tier on its pin, for the hold", () => {
  const root = tmpdir("budget-gates-");
  const models = writeModelsFile(root, MODELS_JSON);
  rejectedWindow(root);
  const cfg = configWith(10);
  cfg.roles.bugfix = { enabled: true, backend: "claude", model: "claude-sonnet-5-5" };
  const state = newBudgetGateState(cfg);
  const p = poll(root, state, cfg, models);
  assert.equal(configForRole(p.roleConfig, "bugfix").agent, "claude");
  assert.equal(configForRole(p.roleConfig, "plan").provider, "paid");
});

test("a used-up claude window moves a subscription claude director to its tier's fallback; no window leaves it on the live config", () => {
  const root = tmpdir("budget-gates-");
  const models = writeModelsFile(root, MODELS_JSON);
  rejectedWindow(root);
  const cfg = configWith(10);
  cfg.provider = undefined;
  cfg.backend = "claude"; cfg.model = "claude-sonnet-5-5";
  const state = newBudgetGateState(cfg);
  const p = poll(root, state, cfg, models);
  const director = configForRole(p.directorConfig, DIRECTOR_ROLE);
  assert.equal(director.provider, "free", "the director runs on the fallback pair");
  assert.equal(director.model, "qwen-free");
  assert.equal(gateRoleConfig(DIRECTOR_ROLE, cfg, p.roleConfig, p.directorConfig), p.directorConfig);
  assert.equal(gateRoleConfig(DIRECTOR_ROLE, cfg, p.roleConfig), cfg, "omitted means the live config");
  writeClaudeAccount(root, { billing: "subscription", observedAt: Date.now(), windows: {} });
  assert.equal(poll(root, state, cfg, models).directorConfig, cfg, "the live config returns on reset");
});

test("the cap alone never moves the director, and a window with no fallback leaves it for the hold", () => {
  const root = tmpdir("budget-gates-");
  const models = writeModelsFile(root, MODELS_JSON);
  const cfg = configWith(10);
  cfg.provider = undefined;
  cfg.backend = "claude"; cfg.model = "claude-sonnet-5-5";
  const capped = poll(root, newBudgetGateState(cfg), cfg, models, [spentRunnerState("feature", 10)]);
  assert.equal(capped.onFallback, true);
  assert.equal(capped.directorConfig, cfg, "the cap leaves the director on its Claude model");

  rejectedWindow(root);
  const bare = configWith(10);
  bare.provider = undefined;
  bare.backend = "claude"; bare.model = "claude-sonnet-5-5";
  bare.fallback = undefined;
  bare.fallbackModel = undefined;
  assert.equal(poll(root, newBudgetGateState(bare), bare, models).directorConfig, bare);
});

test("a chain's demoted first step moves the default tier to the next step instead of pausing", () => {
  const root = tmpdir("budget-gates-");
  const models = writeModelsFile(root, MODELS_JSON);
  const cfg = configWith(10);
  cfg.fallback = ["free/qwen-free", "free/llama-free"];
  const state = newBudgetGateState(cfg);
  state.breakers = {
    "free/qwen-free": {
      ...IDLE_FALLBACK_BREAKER,
      pair: "free/qwen-free",
      capUsd: 10,
      failures: 3,
      probeAt: Date.now() + 3_600_000,
    },
  };
  const p = poll(root, state, cfg, models, [spentRunnerState("feature", 10)]);
  assert.equal(p.gate, "fallback");
  assert.equal(p.servingResolved.default.pair?.model, "llama-free");
  assert.equal(p.servingResolved.default.step, 1);
  assert.deepEqual(Object.keys(state.breakers).sort(), ["free/llama-free", "free/qwen-free"]);
  assert.deepEqual(p.pairs.map((x) => x.model).sort(), ["llama-free", "qwen-free"]);
});

test("a priced fallback step runs below the team cap and its own cap; past either, the free step does", () => {
  const root = tmpdir("budget-gates-");
  const models = writeModelsFile(root, MODELS_JSON);
  rejectedWindow(root);
  const cfg = configWith(10);
  cfg.fallback = [{ model: "paid/gpt-x", maxDailyCostUsd: 5 }, "free/qwen-free"];
  cfg.fallbackModel = undefined;
  const spent = (pairUsd: number, totalUsd = pairUsd) => {
    const s = spentRunnerState("feature", totalUsd);
    s.dayCostByPair = { "paid/gpt-x": pairUsd };
    return [s];
  };
  const resolved = (states: ReturnType<typeof spent>) =>
    poll(root, newBudgetGateState(cfg), cfg, models, states).priceResolved.default.pair;

  assert.equal(resolved(spent(2))?.model, "gpt-x", "under both caps the priced step is the tier's pair");
  assert.equal(resolved(spent(2))?.maxDailyCostUsd, 5);
  assert.equal(resolved(spent(5))?.model, "qwen-free", "the step at its own cap hands over to the free step");
  assert.equal(resolved(spent(2, 10))?.model, "qwen-free", "at the team cap only the free step remains");
});

test("one gate state follows a priced step's spend across its own cap during a window move", () => {
  const root = tmpdir("budget-gates-");
  const models = writeModelsFile(root, MODELS_JSON);
  rejectedWindow(root);
  const cfg = configWith(10);
  cfg.provider = undefined;
  cfg.backend = "claude"; cfg.model = "claude-sonnet-5-5";
  cfg.roles.feature = { enabled: true };
  cfg.fallback = [{ backend: "pi", model: "paid/gpt-x", maxDailyCostUsd: 5 }, { backend: "pi", model: "free/qwen-free" }];
  cfg.fallbackModel = undefined;
  const state = newBudgetGateState(cfg);
  const at = (pairUsd: number) => {
    const s = spentRunnerState("feature", pairUsd);
    s.dayCostByPair = { "paid/gpt-x": pairUsd };
    return poll(root, state, cfg, models, [s]);
  };
  assert.equal(configForRole(at(2).roleConfig, "feature").model, "gpt-x");
  const over = at(5);
  assert.equal(configForRole(over.roleConfig, "feature").model, "qwen-free");
  assert.equal(over.roleConfig.fallbackStepCaps, undefined);
});

test("applyFallbackModel records a moved tier's step cap on the derived view only", () => {
  const cfg = configWith(10);
  cfg.fallback = [{ model: "paid/gpt-x", maxDailyCostUsd: 5 }, "free/qwen-free"];
  cfg.fallbackModel = undefined;
  const view = applyFallbackModel(cfg, resolveTierFallbacks(cfg, () => true));
  assert.deepEqual(view.fallbackStepCaps, { "paid/gpt-x": 5 });
  assert.equal(cfg.fallbackStepCaps, undefined);
  const free = configWith(10);
  assert.equal(applyFallbackModel(free, resolveTierFallbacks(free, () => true)).fallbackStepCaps, undefined);
});

test("a Claude step after the subscription primary spends extra usage within its caps; the primary stops at overage", () => {
  const root = tmpdir("budget-gates-");
  const models = writeModelsFile(root, MODELS_JSON);
  const cfg = configWith(10);
  cfg.provider = undefined;
  cfg.backend = "claude"; cfg.model = "claude-sonnet-5-5";
  cfg.fallback = [{ backend: "claude", model: "claude-sonnet-5-5", maxDailyCostUsd: 5 }, { backend: "pi", model: "free/qwen-free" }];
  cfg.fallbackModel = undefined;
  const account = (extra: Record<string, unknown>, resetsAt = Date.now() + 3_600_000) =>
    writeClaudeAccount(root, {
      billing: "subscription",
      observedAt: Date.now(),
      windows: { five_hour: { status: "allowed", resetsAt, observedAt: Date.now(), ...extra } },
    });
  const spent = (pairUsd: number, totalUsd = pairUsd) => {
    const s = spentRunnerState("feature", totalUsd);
    s.dayCostByPair = { "claude/claude-sonnet-5-5": pairUsd };
    return [s];
  };
  const resolved = (states = spent(0)) =>
    poll(root, newBudgetGateState(cfg), cfg, models, states).priceResolved.default.pair;

  account({});
  assert.equal(resolved()?.extraUsage, true, "in window the chain's first usable step is still the extra-usage step");
  account({ isUsingOverage: true, overageStatus: "allowed" });
  assert.equal(resolved(spent(2))?.model, "claude-sonnet-5-5", "overage: the extra-usage step runs under its cap");
  assert.equal(resolved(spent(5))?.model, "qwen-free", "the step at its cap hands over to local");
  assert.equal(resolved(spent(2, 10))?.model, "qwen-free", "the team cap hands over to local");
  account({ status: "rejected", overageStatus: "rejected" });
  assert.equal(resolved(spent(0))?.model, "qwen-free", "a rejected window with no overage skips the step");
  account({ isUsingOverage: true }, Date.now() - 1000);
  assert.equal(poll(root, newBudgetGateState(cfg), cfg, models).windowOut, null, "a reset window is not in overage");
});

test("an overage account with no later Claude step moves a subscription Claude tier to local", () => {
  const root = tmpdir("budget-gates-");
  const models = writeModelsFile(root, MODELS_JSON);
  writeClaudeAccount(root, {
    billing: "subscription",
    observedAt: Date.now(),
    windows: { five_hour: { status: "allowed", isUsingOverage: true, resetsAt: Date.now() + 3_600_000, observedAt: Date.now() } },
  });
  const cfg = configWith(10);
  cfg.provider = undefined;
  cfg.backend = "claude"; cfg.model = "claude-sonnet-5-5";
  cfg.roles.feature = { enabled: true };
  const p = poll(root, newBudgetGateState(cfg), cfg, models);
  assert.equal(p.windowOut?.type, "five_hour");
  assert.equal(configForRole(p.roleConfig, "feature").model, "qwen-free");
});

test("a reserve crossing moves the team's Claude tiers, skips the extra-usage step until overage, and spares the director", () => {
  const root = tmpdir("budget-gates-");
  const models = writeModelsFile(root, MODELS_JSON);
  const cfg = configWith(10);
  cfg.provider = undefined;
  cfg.backend = "claude"; cfg.model = "claude-sonnet-5-5";
  cfg.fallback = [{ backend: "claude", model: "claude-sonnet-5-5", maxDailyCostUsd: 10 }, { backend: "pi", model: "free/qwen-free" }];
  cfg.fallbackModel = undefined;
  cfg.claudeWindowReserve = { seven_day: 0.8 };
  const account = (utilization: number, extra: Record<string, unknown> = {}) =>
    writeClaudeAccount(root, {
      billing: "subscription",
      observedAt: Date.now(),
      windows: { seven_day: { status: "allowed", utilization, resetsAt: Date.now() + 3_600_000, observedAt: Date.now(), ...extra } },
    });
  const run = () => poll(root, newBudgetGateState(cfg), cfg, models);

  account(0.75);
  assert.equal(run().windowOut, null, "under the reserve nothing moves");
  account(0.85);
  const p = run();
  assert.equal(p.windowOut?.reserve, true);
  assert.equal(p.priceResolved.default.pair?.model, "qwen-free", "the extra-usage step waits past the reserve");
  assert.equal(p.directorConfig, cfg, "the director stays on Claude");
  account(0.85, { isUsingOverage: true });
  assert.equal(run().priceResolved.default.pair?.model, "claude-sonnet-5-5", "overage reported: the extra-usage step runs");
});
