import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { newBudgetGateState, pollBudgetGate, tickOnPair } from "../src/gates/budget-gates.js";import { BUDGET_WARNING_FRACTION, recordDailyCost } from "../src/budget/budget.js";
import { IDLE_FALLBACK_BREAKER } from "../src/budget/fallback-breaker.js";
import { defaultConfig } from "../src/config/config.js";
import { readEvents } from "../src/events/event-read.js";
import { freshLoopState } from "../src/loop/loop-state.js";
import type { TumwaterConfig } from "../src/config/config-schema.js";
import { tmpdir } from "./repo-fixtures.js";
import { MODELS_JSON, PAID_ONLY_JSON } from "./models-fixtures.js";

function writeModels(dir: string, content: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "models.json");
  fs.writeFileSync(file, content);
  return file;
}

/** A fleet at a paid top-level model, a free fallback configured, one role pinned to the
 * paid model, and a reviewer override — everything the fallback view must strip. */
function configWith(capUsd: number): TumwaterConfig {
  const cfg = defaultConfig();
  cfg.provider = "paid";
  cfg.model = "gpt-x";
  cfg.fallbackModel = { provider: "free", model: "qwen-free" };
  cfg.maxDailyCostUsd = capUsd;
  cfg.roles.feature = { ...cfg.roles.feature, provider: "paid", model: "gpt-x", enabled: true };
  cfg.review = { ...cfg.review, provider: "paid", model: "gpt-x" };
  return cfg;
}

/** A loop that has already spent `usd` today (recorded against the real clock, matching
 * pollBudgetGate's own Date.now() read). */
function spent(usd: number) {
  const s = freshLoopState("feature");
  recordDailyCost(s, usd);
  return s;
}

function poll(root: string, state: ReturnType<typeof newBudgetGateState>, cfg: TumwaterConfig, modelsPath: string, states = [spent(0)]) {
  return pollBudgetGate(state, { root, states, liveConfig: cfg, modelsPath });
}

test("pollBudgetGate keeps the gate open under the cap and hands the live config straight through", () => {
  const root = tmpdir("budget-gates-");
  const models = writeModels(root, MODELS_JSON);
  const cfg = configWith(10);
  const state = newBudgetGateState(cfg);

  const p = poll(root, state, cfg, models, [spent(5)]);
  assert.equal(p.gate, "open");
  assert.equal(p.onFallback, false);
  assert.equal(p.roleConfig, cfg); // same object: no view is derived while budget remains
  // The poll hands back the spend/cap pair it just evaluated — the figures the orchestrator
  // publishes for the dashboards (BUGS.md 2026-09-30). Disabled cap: the spend still rides
  // along (a disabled fleet's badge keeps its dollar figure).
  assert.deepEqual({ spentUsd: p.spentUsd, capUsd: p.capUsd }, { spentUsd: 5, capUsd: 10 });
  assert.deepEqual(readEvents(root), []); // no transition, no events
});

test("crossing the cap engages the fallback once: one event, the derived role view, no re-derives", () => {
  const root = tmpdir("budget-gates-");
  const models = writeModels(root, MODELS_JSON);
  const cfg = configWith(10);
  const state = newBudgetGateState(cfg);
  const over = [spent(10)]; // exactly at the cap (>=)

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
  assert.equal(ev.loop, "harness");
  assert.equal(ev.provider, "free");
  assert.equal(ev.model, "qwen-free");
  // One fallback pair resolves every tier to it (small and strong borrow default's own), so
  // the event stays tier-free (part 7b/8): today's single-pair readers keep today's text.
  assert.equal(ev.tiers, undefined);
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
  const models = writeModels(root, MODELS_JSON);
  const cfg = configWith(10);
  // Part 7b/8: default runs its own pair and strong declares a DIFFERENT free one — the two
  // distinct pairs the badge and the feed list. Small borrows default's (its own tier
  // declares nothing), so its label carries the `(from default)` suffix.
  cfg.fallback = { default: "free/qwen-free", strong: "free/llama-free" };
  const state = newBudgetGateState(cfg);

  const p = poll(root, state, cfg, models, [spent(10)]);
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

test("raising the cap resumes the gate: one budget_resumed event and the live config again", () => {
  const root = tmpdir("budget-gates-");
  const models = writeModels(root, MODELS_JSON);
  const cfg = configWith(10);
  const state = newBudgetGateState(cfg);
  poll(root, state, cfg, models, [spent(10)]); // engage the fallback first

  const raised = configWith(100);
  const p = poll(root, state, raised, models, [spent(10)]);
  assert.equal(p.gate, "open");
  assert.equal(p.onFallback, false);
  assert.equal(p.roleConfig, raised); // the fallback view is dropped at once
  assert.deepEqual(readEvents(root).map((e) => e.type), ["budget_fallback", "budget_resumed"]);
});

test("resumed is true on exactly the reopening poll, with the fallback pair it left", () => {
  const root = tmpdir("budget-gates-");
  const models = writeModels(root, MODELS_JSON);
  const cfg = configWith(10);
  const state = newBudgetGateState(cfg);

  // Open → fallback: the engagement poll is not a resume, but it carries the pair.
  const p0 = poll(root, state, cfg, models, [spent(10)]);
  assert.equal(p0.gate, "fallback");
  assert.equal(p0.resumed, false);
  assert.deepEqual(p0.pairs, [{ provider: "free", model: "qwen-free" }]);

  // Holding the fallback: still not a resume.
  assert.equal(poll(root, state, cfg, models, [spent(10)]).resumed, false);

  // fallback → open (cap raised): exactly the resume, naming the pair the gate just left.
  const p2 = poll(root, state, configWith(100), models, [spent(10)]);
  assert.equal(p2.gate, "open");
  assert.equal(p2.resumed, true);
  assert.deepEqual(p2.pairs, [{ provider: "free", model: "qwen-free" }]);

  // Staying open poll after poll: no further resumes.
  assert.equal(poll(root, state, configWith(100), models, [spent(10)]).resumed, false);

  // paused → open is a resume too: ticks parked on the fallback view while the breaker had
  // the gate paused must be handed back exactly like fallback-held ones.
  const paidOnlyDir = tmpdir("budget-gates-paid-");
  const paidOnly = writeModels(paidOnlyDir, PAID_ONLY_JSON);
  const state2 = newBudgetGateState(cfg);
  assert.equal(poll(root, state2, cfg, paidOnly, [spent(10)]).gate, "paused");
  const p5 = poll(root, state2, configWith(100), paidOnly, [spent(10)]);
  assert.equal(p5.gate, "open");
  assert.equal(p5.resumed, true);

  // Open from the start (no transition at all): not a resume.
  const state3 = newBudgetGateState(cfg);
  assert.equal(poll(root, state3, cfg, models, [spent(5)]).resumed, false);
});

test("crossing 80% of the cap warns once while the gate is open, and re-arms after dropping below", () => {
  const root = tmpdir("budget-gates-");
  const models = writeModels(root, MODELS_JSON);
  const cfg = configWith(10);
  const state = newBudgetGateState(cfg);
  assert.equal(state.warned, false); // a fresh poll state starts unarmed
  const threshold = 10 * BUDGET_WARNING_FRACTION; // 8 of a 10 cap

  // Under the threshold: silent.
  poll(root, state, cfg, models, [spent(threshold - 2)]);
  assert.deepEqual(readEvents(root), []);

  // Crossing 80% with the gate still open: exactly one budget_warning.
  poll(root, state, cfg, models, [spent(threshold)]);
  let events = readEvents(root);
  assert.deepEqual(events.map((e) => e.type), ["budget_warning"]);
  assert.equal(events[0]!.loop, "harness");
  assert.equal(events[0]!.capUsd, 10);
  assert.equal(events[0]!.spentUsd, threshold);

  // Still above the threshold: edge-triggered, no second warning.
  poll(root, state, cfg, models, [spent(threshold + 1)]);
  assert.equal(readEvents(root).length, 1);

  // Dropping back below (a new local day, a raised cap) re-arms: crossing again warns again.
  poll(root, state, cfg, models, [spent(threshold - 3)]); // still open the whole time: no transition events
  poll(root, state, cfg, models, [spent(threshold)]);
  assert.deepEqual(readEvents(root).map((e) => e.type), ["budget_warning", "budget_warning"]);
});

test("no budget warning at the cap itself, and none with the cap disabled", () => {
  const root = tmpdir("budget-gates-");
  const models = writeModels(root, MODELS_JSON);
  const cfg = configWith(10);
  const state = newBudgetGateState(cfg);

  // Straight to the cap: the fallback transition logs its own event, the warning never
  // doubles the page on the poll the gate stops being open.
  poll(root, state, cfg, models, [spent(10)]);
  assert.deepEqual(readEvents(root).map((e) => e.type), ["budget_fallback"]);

  // A cap of 0 disables the budget entirely: no warning at any spend.
  const state2 = newBudgetGateState(configWith(0));
  poll(root, state2, configWith(0), models, [spent(100)]);
  assert.deepEqual(readEvents(root).map((e) => e.type), ["budget_fallback"]);
});

test("tickOnPair matches only an in-flight tick on the fallback pair", () => {
  const pair = { provider: "local", model: "local-free" };
  assert.equal(tickOnPair({ provider: "local", model: "local-free" }, pair), true);
  assert.equal(tickOnPair({ provider: "paid", model: "big-paid" }, pair), false, "a primary tick keeps running");
  assert.equal(tickOnPair(null, pair), false, "an idle loop has nothing to hand back");
  assert.equal(tickOnPair({ provider: "local", model: "local-free" }, null), false, "no fallback, no handback");
});

test("a fallback pi prices above zero cannot engage: the gate pauses and the event says why", () => {
  const root = tmpdir("budget-gates-");
  const models = writeModels(root, PAID_ONLY_JSON);
  const cfg = configWith(10);
  const state = newBudgetGateState(cfg);

  const p = poll(root, state, cfg, models, [spent(10)]);
  assert.equal(p.gate, "paused");
  assert.equal(p.onFallback, false);
  assert.equal(p.roleConfig, cfg); // no fallback view while nothing is engaged

  const events = readEvents(root);
  assert.deepEqual(events.map((e) => e.type), ["budget_paused"]);
  assert.equal(events[0]!.fallbackRejected, "free/qwen-free"); // the pair the operator asked for
  assert.equal(events[0]!.capUsd, 10);
});

test("a demoted fallback keeps the gate paused and the role view: demotion never promotes to the paid model", () => {
  const root = tmpdir("budget-gates-");
  const models = writeModels(root, MODELS_JSON);
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

  const p = poll(root, state, cfg, models, [spent(10)]);
  assert.equal(p.gate, "paused"); // free but not serving: paused, like no fallback at all
  assert.equal(p.onFallback, true); // yet ticks parked in flight still run on the free pair
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
  const models = writeModels(root, MODELS_JSON);
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

  const p = poll(root, state, cfg, models, [spent(10)]);
  assert.equal(p.gate, "paused");
  assert.equal(p.priceResolved.strong.pair?.model, "llama-free", "the price-only resolution keeps the pair");
  assert.equal(p.servingResolved.strong.pair, null, "the breaker demotion drops it from the serving view");

  const events = readEvents(root);
  assert.deepEqual(events.map((e) => e.type), ["budget_paused"]);
  assert.equal(events[0]!.fallbackDemoted, "free/llama-free");
  assert.equal(events[0]!.fallbackRejected, undefined, "not the default pair's own refusal");
  assert.equal(events[0]!.failures, 3);
});

// The per-tier gate semantics (part 5c/8): the gate folds the DEMOTION-AWARE resolution of
// the `default` and `strong` tiers — a tier resolved to pause holds its own roles beside the
// per-role cap set, and with review on an unresolvable strong tier pauses the whole gate
// (nothing could land).
test("review on and strong unresolvable pauses the gate; review off holds only its roles", () => {
  const root = tmpdir("budget-gates-tier-");
  const models = writeModels(root, MODELS_JSON);
  const cfg = configWith(10);
  // Only the small tier declares a fallback: default borrows it, strong never borrows small
  // and pauses — the plan role is the strong-tier loop the acceptance names.
  cfg.fallback = { small: "free/qwen-free" };
  cfg.fallbackModel = undefined;
  const state = newBudgetGateState(cfg);

  const p = poll(root, state, cfg, models, [spent(10)]);
  assert.equal(p.gate, "paused", "review on: nothing could land, the gate pauses");
  assert.equal(p.servingResolved.strong.pair, null);
  assert.ok(p.servingResolved.default.pair !== null, "default still resolves (borrowing small)");
  assert.ok(p.budgetActive);

  // Review off: the same config keeps the gate on fallback — only the strong roles are held
  // (the per-tier pause set), the rest keep ticking.
  const off = { ...cfg, review: { ...cfg.review, enabled: false } };
  const p2 = pollBudgetGate(newBudgetGateState(off), { root, states: [spent(10)], liveConfig: off, modelsPath: models });
  assert.equal(p2.gate, "fallback");
  assert.equal(p2.servingResolved.strong.pair, null, "strong still resolves to pause — the set holds it");
});

test("a breaker-demoted pair re-resolves only the tiers using it", () => {
  const root = tmpdir("budget-gates-demoted-tier-");
  const models = writeModels(root, MODELS_JSON);
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

  const p = poll(root, state, cfg, models, [spent(10)]);
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
  const models = writeModels(root, MODELS_JSON);
  const cfg = configWith(10);
  // Per-tier fallbacks: small and default declare the same free pair (they share one
  // breaker), strong declares a priced one it must never use.
  cfg.fallback = { default: "free/qwen-free", small: "free/qwen-free", strong: "paid/gpt-x" };
  cfg.fallbackModel = undefined;
  const state = newBudgetGateState(cfg);

  const p = poll(root, state, cfg, models, [spent(10)]);
  assert.equal(p.gate, "fallback");
  // The priced pair is not resolvable, so the map holds only the free pair the tiers
  // actually resolve to — small's own, default's own, and strong's borrowed default.
  assert.deepEqual(Object.keys(state.breakers), ["free/qwen-free"]);
  assert.equal(state.engaged, "free/qwen-free");
});
