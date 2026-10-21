import { tierChainSteps } from "../src/config/config-fallbacks.js";
import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "../src/config/config.js";
import type { ModelSelectorEntry, TumwaterConfig } from "../src/config/config-schema.js";
import {
  FALLBACK_REVIEW_TIMEOUT_S,
  REVIEW_TIMEOUT_S,
  backendQualifiedSelector,
  configForRole,
  fallbackDisplayPair,
  teamModelLabel,
  modelSelectorField,
  resolvedBackendConfig,
  windowReserveFor,
  resolverConfig,
  reviewConfig,
  reviewRunConfig,
  seamConcurrencyKey,
  seamHoldKey,
  tierModel,
  topTierBackend,
  withModelOverrides,
} from "../src/config/config-views.js";
import {
  applyFallbackModel,
  fallbackPair,
  fallbackRoleConfig,
  resolveTierFallbacks,
  seamsInUse,
  type TierFallback,
  type TierFallbackMap,
} from "../src/config/config-fallbacks.js";
import { routeModel } from "../src/config/model-selector.js";

// The config views' derived models over a loaded config: how the role, review, and fallback
// overlays resolve on top of the top-level pi settings. The per-seam resolution lives in
// src/config/config-views.ts; the budget/tier fallback resolution in
// src/config/config-fallbacks.ts. The load/save/validation side of the config lives in
// test/config.test.ts and test/config-validation.test.ts.

test("configForRole applies role overrides over top-level pi settings", () => {
  const config: TumwaterConfig = defaultConfig();
  config.provider = "top-provider";
  config.model = "top-model";
  config.roles.feature = { enabled: true, model: "strong-model", thinking: "high" };
  const feature = configForRole(config, "feature");
  assert.equal(feature.provider, "top-provider");
  assert.equal(feature.model, "strong-model");
  assert.equal(feature.thinking, "high");
  const clean = configForRole(config, "clean");
  assert.equal(clean.model, "top-model");
  assert.equal(clean.thinking, undefined);
  // A role with no entry resolves like one without overrides: the top-level values, with the
  // model seam resolved to a concrete selector (the views' ResolvedModelConfig contract).
  const other = configForRole(config, "nonexistent");
  assert.equal(other.provider, "top-provider");
  assert.equal(other.model, "top-model");
  assert.equal(other.thinking, undefined);
});

test("reviewConfig applies the review section's overrides over top-level pi settings", () => {
  const config: TumwaterConfig = defaultConfig();
  config.provider = "top-provider";
  config.model = "top-model";
  config.review = { enabled: true, exemptPaths: [], model: "strong-model", thinking: "high" };
  const review = reviewConfig(config);
  assert.equal(review.provider, "top-provider");
  assert.equal(review.model, "strong-model");
  assert.equal(review.thinking, "high");

  // No overrides in the section → top-level values pass through unchanged.
  const plain = reviewConfig(defaultConfig());
  assert.equal(plain.provider, undefined);
  assert.equal(plain.model, undefined);
  assert.equal(plain.thinking, undefined);
});

test("reviewRunConfig gives the reviewer its own time budget over the reviewer wiring", () => {
  const config: TumwaterConfig = defaultConfig();
  config.runTimeoutSeconds = 54_000;
  config.review.model = "strong-model";
  const run = reviewRunConfig(config);
  assert.equal(run.runTimeoutSeconds, REVIEW_TIMEOUT_S, "the run's hours-long budget never reaches the reviewer");
  assert.equal(run.model, "strong-model", "the run keeps the reviewer's model wiring");
  assert.equal(run.quietTimeoutSeconds, config.quietTimeoutSeconds, "only the wall-clock budget changes");

  // A configured review.timeoutSeconds replaces the default; a smaller run budget still wins.
  config.review.timeoutSeconds = 120;
  assert.equal(reviewRunConfig(config).runTimeoutSeconds, 120);
  config.runTimeoutSeconds = 60;
  assert.equal(reviewRunConfig(config).runTimeoutSeconds, 60);
});

test("fallbackPair resolves the fallback over the top-level values", () => {
  const config: TumwaterConfig = defaultConfig();
  config.provider = "hf";
  config.model = "big-paid";
  config.thinking = "high";
  assert.equal(fallbackPair(config), null, "no fallback configured");

  // Each field falls back to the top-level value — the same precedence a role's overrides use.
  assert.deepEqual(fallbackPair({ ...config, fallbackModel: { model: "local-free" } }), {
    provider: "hf",
    model: "local-free",
    thinking: "high",
  });
  assert.deepEqual(
    fallbackPair({ ...config, fallbackModel: { provider: "omlx", model: "local-free", thinking: "off" } }),
    { provider: "omlx", model: "local-free", thinking: "off" },
  );
});

test("applyFallbackModel installs the free pair and drops every model override", () => {
  const config: TumwaterConfig = defaultConfig();
  config.provider = "hf";
  config.model = "big-paid";
  config.fallbackModel = { provider: "omlx", model: "local-free" };
  // A role pinned to its own paid model and a strong paid reviewer: both would keep spending
  // past the cap if the switch only replaced the top-level values.
  config.roles.feature = { enabled: true, provider: "hf", model: "even-bigger-paid", instructions: "keep me" };
  config.review = { ...config.review, provider: "hf", model: "reviewer-paid" };

  const fb = applyFallbackModel(config);
  assert.equal(configForRole(fb, "feature").provider, "omlx");
  assert.equal(configForRole(fb, "feature").model, "local-free");
  assert.equal(reviewConfig(fb).provider, "omlx");
  assert.equal(reviewConfig(fb).model, "local-free");
  // Only the model seams move: everything else the gate keeps re-evaluating against is intact.
  assert.equal(fb.roles.feature?.instructions, "keep me");
  assert.equal(fb.maxDailyCostUsd, config.maxDailyCostUsd);
  assert.deepEqual(fb.review.exemptPaths, config.review.exemptPaths);
  // The source config is untouched — the orchestrator keeps using it for the director.
  assert.equal(configForRole(config, "feature").model, "even-bigger-paid");
  // No fallback configured: the same object back, so the non-fallback path costs nothing.
  const plain = defaultConfig();
  assert.equal(applyFallbackModel(plain), plain);
});

test("applyFallbackModel raises the reviewer's time budget to the fallback floor", () => {
  // The budgeted model's 900 s review budget fit 4–7 local-model turns, so every fallback
  // review timed out and no code change merged until midnight (BUGS.md 2026-09-30).
  const config: TumwaterConfig = defaultConfig();
  config.runTimeoutSeconds = 54_000;
  config.fallbackModel = { provider: "omlx", model: "local-free" };
  assert.equal(reviewRunConfig(config).runTimeoutSeconds, REVIEW_TIMEOUT_S, "the budgeted model keeps its own budget");
  assert.equal(reviewRunConfig(applyFallbackModel(config)).runTimeoutSeconds, FALLBACK_REVIEW_TIMEOUT_S);

  // A configured budget below the floor is raised only on the fallback; one above it stands.
  config.review.timeoutSeconds = 120;
  assert.equal(reviewRunConfig(config).runTimeoutSeconds, 120);
  assert.equal(reviewRunConfig(applyFallbackModel(config)).runTimeoutSeconds, FALLBACK_REVIEW_TIMEOUT_S);
  config.review.timeoutSeconds = 7200;
  assert.equal(reviewRunConfig(applyFallbackModel(config)).runTimeoutSeconds, 7200);
  assert.equal(config.review.timeoutSeconds, 7200, "the source config is untouched");

  // The run's own budget still caps the reviewer, fallback or not.
  config.runTimeoutSeconds = 600;
  assert.equal(reviewRunConfig(applyFallbackModel(config)).runTimeoutSeconds, 600);
});

test("selector strings for model parse into the provider/model/thinking triple", () => {
  const config: TumwaterConfig = defaultConfig();
  config.model = "huggingface/zai-org/GLM-5.3-Flash:together:low";
  assert.deepEqual(
    { provider: configForRole(config, "feature").provider, model: configForRole(config, "feature").model, thinking: configForRole(config, "feature").thinking },
    { provider: "huggingface", model: "zai-org/GLM-5.3-Flash:together", thinking: "low" },
  );
  // A legacy provider in scope keeps a string model a bare id under it — the old configs'
  // meaning, so their argv is unchanged.
  config.model = "zai-org/GLM-5.3-Flash:together";
  config.provider = "huggingface";
  assert.deepEqual(
    { provider: configForRole(config, "feature").provider, model: configForRole(config, "feature").model },
    { provider: "huggingface", model: "zai-org/GLM-5.3-Flash:together" },
  );
  // An explicit thinking key wins over a selector's suffix; a suffix beats the ambient
  // top-level thinking.
  config.roles.feature = { enabled: true, model: "org/m:low", thinking: "high" };
  assert.equal(configForRole(config, "feature").thinking, "high");
  const ambient = defaultConfig();
  ambient.thinking = "high";
  ambient.model = "org/m:low";
  assert.equal(configForRole(ambient, "feature").thinking, "low");
  assert.equal(reviewConfig(ambient).thinking, "low");
});

test("a selector-string fallback engages like the equivalent fallbackModel object", () => {
  const config: TumwaterConfig = defaultConfig();
  config.provider = "hf";
  config.model = "big-paid";
  config.thinking = "high";
  // No suffix borrows the ambient thinking, exactly as the object form does.
  config.fallback = "omlx/local-free";
  assert.deepEqual(fallbackPair(config), { provider: "omlx", model: "local-free", thinking: "high" });
  // The suffix wins over the ambient thinking.
  config.fallback = "omlx/local-free:off";
  assert.deepEqual(fallbackPair(config), { provider: "omlx", model: "local-free", thinking: "off" });
  config.fallback = "omlx/local-free";
  assert.deepEqual(fallbackPair(config), { provider: "omlx", model: "local-free", thinking: "high" });
  // Without a legacy provider, a slash-less string is a bare pattern with no provider.
  const bare = defaultConfig();
  bare.fallback = "local-free";
  assert.deepEqual(fallbackPair(bare), { model: "local-free" });
  // The fallback config drives every seam: applyFallbackModel lands on the parsed pair.
  const fb = applyFallbackModel({ ...config, roles: { feature: { enabled: true, model: "paid" } } });
  assert.deepEqual(
    { provider: configForRole(fb, "feature").provider, model: configForRole(fb, "feature").model },
    { provider: "omlx", model: "local-free" },
  );
});

// --- Model tiers (plans/model-tiers.md part 3/8) -------------------------------------------

test("tierModel resolves each tier of a map-form model, a string form being the default tier", () => {
  const map: TumwaterConfig = defaultConfig();
  map.model = { default: "prov/a", strong: "prov/b", small: "prov/c" };
  assert.equal(tierModel(map, "strong")?.model, "b");
  assert.equal(tierModel(map, "strong")?.provider, "prov");
  assert.equal(tierModel(map, "small")?.model, "c");
  assert.equal(tierModel(map, "default")?.model, "a");
  // A tier left out inherits default's.
  delete (map.model as Record<string, string>).small;
  assert.equal(tierModel(map, "small")?.model, "a");
  // A map with no default leaves the default tier on pi's own default.
  assert.equal(tierModel({ ...map, model: { strong: "prov/b" } }, "default"), undefined);
  // A string form is { default: <string> }, at every tier.
  const str: TumwaterConfig = defaultConfig();
  str.model = "prov/a:low";
  assert.equal(tierModel(str, "strong")?.model, "a");
  assert.equal(tierModel(str, "strong")?.thinking, "low");
  // No model at all: none.
  assert.equal(tierModel(defaultConfig(), "strong"), undefined);
});

test("teamModelLabel collapses agreeing tiers and lists differing ones", () => {
  // Every tier unset: pi's own default, so the live-edit event names no model.
  assert.equal(teamModelLabel(defaultConfig()), null);
  // A string form applies at every tier, so all set tiers agree on one selector.
  const str: TumwaterConfig = defaultConfig();
  str.model = "prov-a/model-a";
  assert.equal(teamModelLabel(str), "prov-a/model-a");
  // A map whose tiers differ lists each tier's effective selector — small inherits default.
  const map: TumwaterConfig = defaultConfig();
  map.model = { default: "prov-a/model-a", strong: "prov-s/model-s:high" };
  assert.equal(
    teamModelLabel(map),
    "small=prov-a/model-a, default=prov-a/model-a, strong=prov-s/model-s:high",
  );
  // A bare-id model is agent-qualified by routing (PLANS.md "Mixed claude + pi fleets, part
  // 3/4" gap 7): over `pi` it stays bare, over `claude` it names the backend — so a live
  // `agent` flip relabels the tier and the reload logs model_changed. (Rule 3a exempts a
  // bare `claude-…` id: it routes to claude over pi already, so the flip no longer relabels
  // it — a non-claude bare id keeps testing the flip.)
  const bare: TumwaterConfig = defaultConfig();
  bare.backend = "pi";
  bare.model = "local-model";
  assert.equal(teamModelLabel(bare), "local-model");
  const onClaude: TumwaterConfig = defaultConfig();
  onClaude.backend = "claude";
  onClaude.model = "local-model";
  assert.equal(teamModelLabel(onClaude), "claude/local-model");
});

test("fallbackDisplayPair agent-qualifies a backend pair and keeps a pi pair bare", () => {
  assert.equal(fallbackDisplayPair({ backend: "claude", provider: "claude", model: "claude-sonnet-5-5" }, "pi default"), "claude/claude-sonnet-5-5");
  assert.equal(fallbackDisplayPair({ provider: "omlx", model: "local-free" }, "pi default"), "local-free");
  assert.equal(fallbackDisplayPair({ provider: "omlx" }, "pi default"), "omlx");
  assert.equal(fallbackDisplayPair(null, "pi default"), "pi default");
});

test("configForRole resolves each seam's tier: plan and director strong, readme small, others default", () => {
  const config: TumwaterConfig = defaultConfig();
  config.model = { default: "prov/a", strong: "prov/b", small: "prov/c" };
  assert.equal(configForRole(config, "plan").model, "b");
  assert.equal(configForRole(config, "readme").model, "c");
  assert.equal(configForRole(config, "feature").model, "a");
  assert.equal(configForRole(config, "director").model, "b");
  // A tier-name override in roles.<id>.model moves the seam to that tier.
  config.roles.feature = { enabled: true, model: "strong" };
  assert.equal(configForRole(config, "feature").model, "b");
  // A selector override wins outright.
  config.roles.feature = { enabled: true, model: "other/z:high" };
  const feature = configForRole(config, "feature");
  assert.equal(feature.model, "z");
  assert.equal(feature.provider, "other");
  assert.equal(feature.thinking, "high");
});

test("reviewConfig runs the strong tier unless review.model names another", () => {
  const config: TumwaterConfig = defaultConfig();
  config.model = { default: "prov/a", strong: "prov/b" };
  assert.equal(reviewConfig(config).model, "b");
  config.review = { ...config.review, model: "default" };
  assert.equal(reviewConfig(config).model, "a");
  config.review = { ...config.review, model: "other/r" };
  const review = reviewConfig(config);
  assert.equal(review.model, "r");
  assert.equal(review.provider, "other");
  // With only a string model (the default tier), the reviewer runs it — unchanged behavior.
  const str: TumwaterConfig = defaultConfig();
  str.model = "prov/a";
  assert.equal(reviewConfig(str).model, "a");
});

test("a map-form model and the equivalent string produce identical resolved triples", () => {
  const string_: TumwaterConfig = defaultConfig();
  string_.model = "prov/a:low";
  const map: TumwaterConfig = defaultConfig();
  map.model = { default: "prov/a:low" };
  for (const role of ["feature", "plan", "readme", "director"]) {
    const s = configForRole(string_, role);
    const m = configForRole(map, role);
    assert.equal(s.provider, m.provider);
    assert.equal(s.model, m.model);
    assert.equal(s.thinking, m.thinking);
  }
  const s = reviewConfig(string_);
  const m = reviewConfig(map);
  assert.equal(s.model, m.model);
  assert.equal(s.thinking, m.thinking);
});

test("fallbackPair resolves a map with no default entry through the borrow order", () => {
  // A map with no `default` key (or a `"pause"` one) engages the per-tier gate, but this
  // view once read only the missing default entry and reported null. It must return the
  // default tier's RESOLVED pair — borrowed exactly as the gate borrows it.
  const small: TumwaterConfig = defaultConfig();
  small.fallback = { small: "omlx/m" };
  assert.deepEqual(fallbackPair(small), { provider: "omlx", model: "m" });
  const strong: TumwaterConfig = defaultConfig();
  strong.fallback = { strong: "omlx/s" };
  assert.deepEqual(fallbackPair(strong), { provider: "omlx", model: "s" });
  // The default predicate admits every declared pair (the config-only view); a pricing
  // predicate yields the borrowed free pair a priced default would be refused in favor of.
  const priced: TumwaterConfig = defaultConfig();
  priced.fallback = { default: "paid/x", strong: "free/s" };
  assert.deepEqual(fallbackPair(priced), { provider: "paid", model: "x" });
  assert.deepEqual(fallbackPair(priced, (p) => p.provider === "free"), {
    provider: "free",
    model: "s",
  });
});

test("a map-form fallback engages its default entry until part 5/8 tiers it", () => {
  const config: TumwaterConfig = defaultConfig();
  config.fallback = { default: "omlx/local-free:low", strong: "pause" };
  const pair = fallbackPair(config);
  assert.equal(pair?.provider, "omlx");
  assert.equal(pair?.model, "local-free");
  assert.equal(pair?.thinking, "low");
  // A pause default names no model at all.
  assert.equal(fallbackPair({ ...config, fallback: { default: "pause" } }), null);
});

test("a non-pi fallback pair is keyed by its backend, in both selector forms", () => {
  // PLANS.md "Mixed claude + pi fleets, part 2/4": the budget gate's handback matches the
  // run's seamHoldKey capture against the fallback pair, so a fallback that routes to a
  // non-pi backend must carry that backend as its provider and as its `backend` — an explicit
  // step backend and a step that inherits the claude team's backend both read `claude`, so a
  // run on either form is handed back. A pi pair keeps its own provider (and a bare pi
  // selector keeps undefined).
  const claude: TumwaterConfig = { ...defaultConfig(), backend: "claude" };
  const want = { backend: "claude", provider: "claude", model: "claude-sonnet-5-5", extraUsage: true };
  assert.deepEqual(fallbackPair({ ...claude, fallback: [{ backend: "claude", model: "claude-sonnet-5-5" }] }), want);
  assert.deepEqual(fallbackPair({ ...claude, fallback: "claude-sonnet-5-5" }), want, "a step with no backend inherits the team's");
  const pi: TumwaterConfig = defaultConfig();
  pi.fallback = "omlx/qwen";
  assert.deepEqual(fallbackPair(pi), { provider: "omlx", model: "qwen" });
  const bare: TumwaterConfig = defaultConfig();
  bare.provider = "omlx";
  bare.fallback = "qwen";
  assert.deepEqual(fallbackPair(bare), { model: "qwen" }, "a bare pi selector keeps its no-provider shape");
});

// Part 5a/8: the per-tier budget-fallback resolution engine.

test("resolveTierFallbacks with a single fallback: every tier lands on it, default own", () => {
  const config: TumwaterConfig = defaultConfig();
  config.fallback = "omlx/free";
  const r = resolveTierFallbacks(config, () => true);
  assert.deepEqual(r.default, { pair: { provider: "omlx", model: "free" }, from: null });
  assert.deepEqual(r.small, { pair: { provider: "omlx", model: "free" }, from: "default" });
  assert.deepEqual(r.strong, { pair: { provider: "omlx", model: "free" }, from: "default" });
  // No fallback configured: every tier pauses.
  const none = resolveTierFallbacks(defaultConfig(), () => true);
  for (const tier of ["small", "default", "strong"] as const)
    assert.deepEqual(none[tier], { pair: null, from: null });
});

test("resolveTierFallbacks borrows per tier in the declared order, strong never small", () => {
  const config: TumwaterConfig = defaultConfig();
  config.fallback = { default: "omlx/d", strong: "omlx/s" };
  const r = resolveTierFallbacks(config, () => true);
  assert.deepEqual(r.default, { pair: { provider: "omlx", model: "d" }, from: null });
  assert.deepEqual(r.strong, { pair: { provider: "omlx", model: "s" }, from: null });
  assert.deepEqual(r.small, { pair: { provider: "omlx", model: "d" }, from: "default" });
  // Without a strong entry, strong borrows default's.
  const noStrong = resolveTierFallbacks({ ...config, fallback: { default: "omlx/d" } }, () => true);
  assert.deepEqual(noStrong.strong, { pair: { provider: "omlx", model: "d" }, from: "default" });
  // Without a default entry, default borrows strong's and small borrows strong's.
  const onlySmall = resolveTierFallbacks({ ...config, fallback: { small: "omlx/m" } }, () => true);
  assert.deepEqual(onlySmall.small, { pair: { provider: "omlx", model: "m" }, from: null });
  assert.deepEqual(onlySmall.default, { pair: { provider: "omlx", model: "m" }, from: "small" });
  assert.deepEqual(onlySmall.strong, { pair: null, from: null });
});

test("resolveTierFallbacks honors usable() and explicit pause", () => {
  const config: TumwaterConfig = defaultConfig();
  config.fallback = { default: "omlx/d", small: "omlx/m", strong: "omlx/s" };
  // Only the strong pair is usable: strong keeps it, the others borrow it.
  const r = resolveTierFallbacks(config, (p) => p.model === "s");
  assert.deepEqual(r.strong, { pair: { provider: "omlx", model: "s" }, from: null });
  assert.deepEqual(r.default, { pair: { provider: "omlx", model: "s" }, from: "strong" });
  assert.deepEqual(r.small, { pair: { provider: "omlx", model: "s" }, from: "strong" });
  // An explicit pause opts a tier out and makes it unborrowable.
  const paused: TumwaterConfig = defaultConfig();
  paused.fallback = { default: "pause", small: "omlx/m", strong: "omlx/s" };
  const rp = resolveTierFallbacks(paused, () => true);
  assert.deepEqual(rp.default, { pair: { provider: "omlx", model: "s" }, from: "strong" });
  // Nothing usable anywhere: every tier pauses.
  const dead = resolveTierFallbacks(config, () => false);
  for (const tier of ["small", "default", "strong"] as const)
    assert.deepEqual(dead[tier], { pair: null, from: null });
  // The legacy fallbackModel object is default's own fallback.
  const legacy: TumwaterConfig = defaultConfig();
  legacy.fallbackModel = { provider: "omlx", model: "free" };
  const rl = resolveTierFallbacks(legacy, () => true);
  assert.deepEqual(rl.default, { pair: { provider: "omlx", model: "free" }, from: null });
  assert.deepEqual(rl.strong, { pair: { provider: "omlx", model: "free" }, from: "default" });
});

test("applyFallbackModel with a resolved map keeps tiers and drops raw overrides", () => {
  const config: TumwaterConfig = defaultConfig();
  config.model = { default: "paid/a", strong: "paid/b" };
  config.thinking = "high";
  config.provider = "legacy";
  config.review = { ...config.review, model: "paid/reviewer" };
  config.roles.feature = { enabled: true, model: "paid/pin" };
  config.roles.plan = { enabled: true, model: "strong" };
  const resolved: TierFallbackMap = resolveTierFallbacks(
    { ...config, fallback: { default: "omlx/d:low", strong: "omlx/s" } },
    () => true,
  );
  const out = applyFallbackModel(config, resolved);
  assert.deepEqual(out.model, {
    small: "omlx/d:low",
    default: "omlx/d:low",
    strong: "omlx/s:high",
  });
  assert.equal(out.provider, undefined);
  assert.equal(out.thinking, undefined);
  // Raw per-role selector overrides are dropped; tier-name ones kept.
  assert.equal(out.roles.feature?.model, undefined);
  assert.equal(out.roles.plan?.model, "strong");
  assert.equal(out.review.model, undefined);
  // The reviewer's time budget still rises to the fallback floor.
  assert.equal(
    reviewRunConfig(out).runTimeoutSeconds,
    FALLBACK_REVIEW_TIMEOUT_S,
  );
  // A paused tier is left out of the map (it inherits default's entry).
  const pausedStrong: TierFallback = { pair: null, from: null };
  const half = applyFallbackModel(config, { ...resolved, strong: pausedStrong });
  assert.deepEqual(half.model, { small: "omlx/d:low", default: "omlx/d:low" });
});

test("applyFallbackModel keeps a free seam while moving a priced one", () => {
  const config: TumwaterConfig = defaultConfig();
  config.model = { default: "paid/gpt-x", strong: "paid/gpt-x" };
  config.fallback = "free/qwen-free";
  // A free (subscription claude) role and a priced pi role: only the priced one moves.
  config.roles.feature = { enabled: true, backend: "claude", model: "claude-sonnet-5-5" };
  config.roles.plan = { enabled: true, provider: "paid", model: "gpt-x" };
  const resolved = resolveTierFallbacks(config, () => true);
  const out = applyFallbackModel(config, resolved, (seam) => seam.agent === "claude");
  assert.equal(configForRole(out, "feature").agent, "claude", "the free seam's backend survives");
  assert.equal(configForRole(out, "feature").model, "claude-sonnet-5-5");
  assert.equal(configForRole(out, "plan").provider, "free", "the priced seam moves to its fallback");
  assert.equal(configForRole(out, "plan").model, "qwen-free");
  // Without the predicate the paid pin is still stripped as before.
  const plain = applyFallbackModel(config, resolved);
  assert.equal(configForRole(plain, "feature").provider, "free");
});

test("applyFallbackModel keeps a free seam's ambient thinking level", () => {
  const config: TumwaterConfig = defaultConfig();
  config.model = { default: { backend: "claude", model: "claude-sonnet-5-5" }, strong: "paid/gpt-x" };
  config.thinking = "high";
  config.fallback = "free/qwen-free";
  config.review = { ...config.review, enabled: true, backend: "claude", model: "claude-sonnet-5-5" };
  config.roles.feature = { enabled: true, backend: "claude", model: "claude-sonnet-5-5" };
  const resolved = resolveTierFallbacks(config, () => true);
  const out = applyFallbackModel(config, resolved, (seam) => seam.agent === "claude");
  // The kept free tier carries the ambient thinking level in its selector; its roles inherit it,
  // exactly as they did before the cap. A moved seam still drops the top-level thinking field
  // (the existing test above pins `out.thinking === undefined`), though its pair selector already
  // folded the ambient level in.
  assert.equal(tierModel(out, "default")?.thinking, "high");
  assert.equal(configForRole(out, "feature").thinking, "high");
});

test("applyFallbackModel keeps a free agent-default tier's ambient thinking", () => {
  // `agent: "claude"` with no top-level `model`: each seam rides its agent's tier default
  // (sonnet/haiku/opus), and the ambient thinking level applies to all of them. A free seam has
  // no own selector to carry the level, so the kept tier must name the routed default plus it.
  const config: TumwaterConfig = defaultConfig();
  config.backend = "claude";
  config.thinking = "high";
  config.fallback = "free/qwen-free";
  const resolved = resolveTierFallbacks(config, () => true);
  const out = applyFallbackModel(config, resolved, (seam) => seam.agent === "claude");
  assert.equal(configForRole(out, "feature").model, "claude-sonnet-5-5");
  assert.equal(configForRole(out, "feature").thinking, "high");
  assert.equal(configForRole(out, "readme").model, "claude-haiku-5-5");
  assert.equal(configForRole(out, "readme").thinking, "high");
  assert.equal(configForRole(out, "plan").thinking, "high");
  assert.equal(reviewConfig(out).thinking, "high");
});

test("fallbackRoleConfig resolves the role's tier pair and is null when it pauses", () => {
  const config: TumwaterConfig = defaultConfig();
  config.model = "paid/primary";
  config.fallback = "free/f";
  const fb = fallbackRoleConfig(config, "feature");
  assert.equal(fb?.provider, "free");
  assert.equal(fb?.model, "f");
  assert.equal(
    fb?.minRunIntervalSeconds,
    config.roles.feature?.minRunIntervalSeconds ?? config.minRunIntervalSeconds,
  );
  // A strong-tier role borrows the default tier's own fallback (BORROW_ORDER).
  config.roles.feature = { enabled: true, model: "strong" };
  const strong = fallbackRoleConfig(config, "feature");
  assert.equal(strong?.provider, "free");
  assert.equal(strong?.model, "f");
  // No fallback configured resolves every tier to pause: the feature is off.
  const none: TumwaterConfig = defaultConfig();
  none.model = "paid/primary";
  assert.equal(fallbackRoleConfig(none, "feature"), null);
});

test("resolvedBackendConfig reads the legacy agentBin/piArgs as the pi entry's bin/args", () => {
  // A config with only the legacy spellings resolves them under backends.pi.
  const legacy: TumwaterConfig = defaultConfig();
  legacy.agentBin = "/opt/pi";
  legacy.piArgs = ["--no-skills"];
  assert.deepEqual(resolvedBackendConfig(legacy, "pi"), { bin: "/opt/pi", args: ["--no-skills"] });
  // The new form wins where it is present; a plain default resolves to pi's own binary and
  // an empty argv, matching the seams' current defaults.
  const mixed: TumwaterConfig = defaultConfig();
  mixed.agentBin = "/legacy";
  mixed.piArgs = ["--legacy"];
  mixed.backends = { pi: { bin: "/new", args: ["--new"] } };
  assert.deepEqual(resolvedBackendConfig(mixed, "pi"), { bin: "/new", args: ["--new"] });
  assert.deepEqual(resolvedBackendConfig(defaultConfig(), "pi"), { bin: undefined, args: [] });
  // A non-pi backend reads its own entry and never falls back to the pi legacy fields.
  const claude: TumwaterConfig = defaultConfig();
  claude.agentBin = "/legacy";
  claude.backends = { claude: { bin: "claude", args: ["--verbose"] } };
  assert.deepEqual(resolvedBackendConfig(claude, "claude"), { bin: "claude", args: ["--verbose"] });
  assert.deepEqual(resolvedBackendConfig(claude, "unknown"), {});
});

test("resolvedBackendConfig returns args detached from the config it reads", () => {
  // The view is documented pure: a consumer appending passthrough argv to the returned
  // `args` must not write back into the loaded config.
  const config: TumwaterConfig = defaultConfig();
  config.piArgs = ["--no-skills"];
  config.backends = { claude: { args: ["--verbose"] } };
  resolvedBackendConfig(config, "pi").args!.push("--evil");
  resolvedBackendConfig(config, "claude").args!.push("--evil");
  assert.deepEqual(config.piArgs, ["--no-skills"], "the pi view's args do not alias config.piArgs");
  assert.deepEqual(
    config.backends.claude!.args,
    ["--verbose"],
    "the claude view's args do not alias config.backends.claude.args",
  );
});

test("applyFallbackModel without a resolved map is unchanged", () => {
  const config: TumwaterConfig = defaultConfig();
  config.model = { default: "paid/a", strong: "paid/b" };
  config.fallback = "free/f";
  const out = applyFallbackModel(config);
  assert.equal(out.provider, "free");
  assert.equal(out.model, "f");
  assert.equal(out.roles.feature?.model, undefined);
});

// --- Agent routing (plans/agent-backends.md part 4b/7) ------------------------------------

test("routeModel: the backend is the explicit one, else the config's; a model id never names it", () => {
  // A provider named like a backend is just a pi provider under pi.
  assert.deepEqual(routeModel("claude", "claude-opus-5-5", "pi", "strong"), {
    agent: "pi",
    model: "claude-opus-5-5",
  });
  // The config's backend takes any provider/id verbatim.
  assert.deepEqual(routeModel("omlx", "Qwen", "claude", "default"), { agent: "claude", model: "omlx/Qwen" });
  // A bare id (no provider) runs the top-level backend.
  assert.deepEqual(routeModel(undefined, "sonnet", "claude", "default"), { agent: "claude", model: "sonnet" });
  assert.deepEqual(routeModel(undefined, "sonnet", "pi", "default"), { agent: "pi", model: "sonnet" });
  // A bare `claude-…` id no longer jumps to claude: the explicit backend decides.
  assert.deepEqual(routeModel(undefined, "claude-opus-5-5", "pi", "strong"), {
    agent: "pi",
    model: "claude-opus-5-5",
  });
  assert.deepEqual(routeModel(undefined, "claude-opus-5-5", "pi", "strong", "claude"), {
    agent: "claude",
    model: "claude-opus-5-5",
  });
  // No model at all: the backend's tier default, or none for pi.
  assert.deepEqual(routeModel(undefined, undefined, "claude", "small"), {
    agent: "claude",
    model: "claude-haiku-5-5",
  });
  assert.deepEqual(routeModel(undefined, undefined, "pi", "small"), { agent: "pi" });
});

test("agent: claude with no model runs each seam on its tier's claude default", () => {
  const config: TumwaterConfig = defaultConfig();
  config.backend = "claude";
  // Author (default tier), readme (small), plan (strong): sonnet, haiku, opus.
  const feature = configForRole(config, "feature");
  assert.equal(feature.agent, "claude");
  assert.equal(feature.model, "claude-sonnet-5-5");
  assert.equal(feature.provider, undefined, "the claude namespace is not a pi provider");
  assert.equal(configForRole(config, "readme").model, "claude-haiku-5-5");
  assert.equal(configForRole(config, "plan").model, "claude-opus-5-5");
  // The reviewer and the conflict resolver run the strong tier.
  assert.equal(reviewConfig(config).agent, "claude");
  assert.equal(reviewConfig(config).model, "claude-opus-5-5");
  assert.equal(resolverConfig(config).agent, "claude");
  assert.equal(resolverConfig(config).model, "claude-opus-5-5");
  // A model string then applies at every tier, exactly as for pi.
  config.model = "claude-sonnet-5-5";
  for (const role of ["feature", "readme", "plan"]) {
    assert.equal(configForRole(config, role).agent, "claude");
    assert.equal(configForRole(config, role).model, "claude-sonnet-5-5");
  }
});

test("a review backend routes its seam alone to that agent", () => {
  const config: TumwaterConfig = defaultConfig();
  config.backend = "pi";
  config.review = { ...config.review, backend: "claude", model: "claude-opus-5-5:high" };
  const review = reviewConfig(config);
  assert.equal(review.agent, "claude");
  assert.equal(review.model, "claude-opus-5-5");
  assert.equal(review.thinking, "high");
  assert.equal(review.provider, undefined, "the routed provider namespace is dropped");
  // The rest of the team stays on pi with pi's own default.
  assert.equal(configForRole(config, "feature").agent, "pi");
  assert.equal(configForRole(config, "feature").model, undefined);
});

test("a mixed fallback under agent: claude runs on pi while the primary stays claude", () => {
  const config: TumwaterConfig = defaultConfig();
  config.backend = "claude";
  config.fallback = { default: { backend: "pi", model: "omlx/Qwen3.8-27B-MLX" } };
  assert.equal(configForRole(config, "feature").agent, "claude");
  const fb = fallbackRoleConfig(config, "feature");
  assert.equal(fb?.agent, "pi", "an explicit pi step runs on pi");
  assert.equal(fb?.provider, "omlx");
  assert.equal(fb?.model, "Qwen3.8-27B-MLX");
});

test("seamHoldKey keys a claude seam by its agent and a pi seam by its provider", () => {
  // A claude seam carries no pi provider, so its hold key is the backend id — the one key the
  // scheduler and pollTeamHold both read. A pi seam keeps its provider, and pi's own default
  // (no provider at all) keys undefined.
  assert.equal(seamHoldKey({ agent: "claude", provider: undefined }), "claude");
  assert.equal(seamHoldKey({ agent: "pi", provider: "omlx" }), "omlx");
  assert.equal(seamHoldKey({ agent: "pi", provider: undefined }), undefined);
});

test("seamConcurrencyKey reuses the hold key, and a no-model pi seam takes pi's default provider", () => {
  // A claude seam carries no pi provider, so its hold key is the backend id.
  assert.equal(seamConcurrencyKey({ agent: "claude", provider: undefined, model: "claude-opus-5-5" }, null), "claude");
  // A pi seam keeps its provider — the omlx and huggingface sub-provider-pin cases alike.
  assert.equal(seamConcurrencyKey({ agent: "pi", provider: "omlx", model: "Qwen" }, null), "omlx");
  assert.equal(
    seamConcurrencyKey({ agent: "pi", provider: "huggingface", model: "deepseek-ai/DeepSeek:deepinfra" }, null),
    "huggingface",
  );
  // A pi seam that names no model runs pi's saved default, so it takes the default provider.
  assert.equal(seamConcurrencyKey({ agent: "pi", provider: undefined, model: undefined }, { provider: "omlx", model: "d" }), "omlx");
  assert.equal(
    seamConcurrencyKey({ agent: "pi", provider: undefined, model: undefined }, { provider: "lm-studio", model: "d" }),
    "lm-studio",
  );
  // No pi default either: no key.
  assert.equal(seamConcurrencyKey({ agent: "pi", provider: undefined, model: undefined }, null), undefined);
  // A bare id with no provider is left keyless regardless of pi's default.
  assert.equal(
    seamConcurrencyKey({ agent: "pi", provider: undefined, model: "sonnet" }, { provider: "omlx", model: "d" }),
    undefined,
  );
});

test("backendQualifiedSelector names a non-pi backend as the selector namespace", () => {
  // Part 4f/7: a claude seam's selector carries the backend id (`claude/claude-sonnet-5-5`),
  // the form routeModel parses back; pi keeps the historical `provider/model` byte-for-byte.
  assert.equal(
    backendQualifiedSelector({ provider: undefined, model: "claude-sonnet-5-5", thinking: undefined, agent: "claude" }),
    "claude/claude-sonnet-5-5",
  );
  assert.equal(
    backendQualifiedSelector({ provider: undefined, model: "claude-sonnet-5-5", thinking: "high", agent: "claude" }),
    "claude/claude-sonnet-5-5:high",
  );
  assert.equal(
    backendQualifiedSelector({ provider: "omlx", model: "Qwen", thinking: undefined, agent: "pi" }),
    "omlx/Qwen",
  );
  assert.deepEqual(
    modelSelectorField({ provider: "omlx", model: undefined, thinking: undefined, agent: "pi" }),
    {},
    "no resolved model leaves the field absent",
  );
});

test("a legacy pi config gains no model and stays on pi", () => {
  const config: TumwaterConfig = defaultConfig();
  config.agentBin = "/opt/pi";
  config.piArgs = ["--no-skills"];
  config.provider = "omlx";
  config.model = "Qwen";
  const feature = configForRole(config, "feature");
  assert.equal(feature.agent, "pi");
  assert.equal(feature.provider, "omlx", "the pi provider half is kept");
  assert.equal(feature.model, "Qwen", "no default is injected when a model resolves");
  // No model at all: pi supplies no default, so the triplet is unchanged from before routing.
  const bare: TumwaterConfig = defaultConfig();
  bare.provider = "omlx";
  const bareFeature = configForRole(bare, "feature");
  assert.equal(bareFeature.agent, "pi");
  assert.equal(bareFeature.provider, "omlx");
  assert.equal(bareFeature.model, undefined);
});

test("Mixing providers: one config serves HF on pi, claude for strong seams, and an oMLX fallback on pi", () => {
  // PLANS.md "Mixed claude + pi fleets, part 4/4" README example: a Claude model id beside
  // models from other providers, with no top-level `backend` key and no `claude/` prefix. The
  // strong tier's object form puts the claude id on the claude CLI while named providers stay
  // on pi.
  const config: TumwaterConfig = defaultConfig();
  config.model = {
    default: "huggingface/deepseek-ai/DeepSeek-V4.1-Flash:deepinfra",
    strong: { backend: "claude", model: "claude-opus-5-5" },
  };
  config.fallback = "omlx/Qwen3.8-27B-MLX-oQ4e-mtp";
  // The default tier (feature role) runs on pi through HF.
  const feature = configForRole(config, "feature");
  assert.equal(feature.agent, "pi");
  assert.equal(feature.provider, "huggingface");
  // `:deepinfra` is a provider pin for the serving endpoint, not a thinking level, so it rides
  // on the id; no thinking suffix resolves.
  assert.equal(feature.model, "deepseek-ai/DeepSeek-V4.1-Flash:deepinfra");
  assert.equal(feature.thinking, undefined);
  // The strong seams (reviewer and conflict resolver) run on the claude CLI.
  assert.equal(reviewConfig(config).agent, "claude");
  assert.equal(reviewConfig(config).model, "claude-opus-5-5");
  assert.equal(resolverConfig(config).agent, "claude");
  assert.equal(resolverConfig(config).model, "claude-opus-5-5");
  assert.equal(resolverConfig(config).provider, undefined);
  // The fallback pair runs on pi through oMLX (no thinking suffix, so none is added).
  assert.deepEqual(fallbackPair(config), {
    provider: "omlx",
    model: "Qwen3.8-27B-MLX-oQ4e-mtp",
  });
});

test("a fallback list runs its first usable step, then borrows, and seamsInUse lists every step", () => {
  const config: TumwaterConfig = defaultConfig();
  config.fallback = { default: ["omlx/a", "omlx/b"], strong: "pause" };
  const bad = new Set(["a"]);
  const r = resolveTierFallbacks(config, (p) => !bad.has(p.model ?? ""));
  assert.equal(r.default.pair?.model, "b");
  assert.equal(r.default.step, 1);
  assert.equal(resolveTierFallbacks(config, () => true).default.step, undefined);
  // Both steps unusable: default pauses, and strong (pause) never borrows small.
  assert.equal(resolveTierFallbacks(config, () => false).default.pair, null);
  assert.equal(resolveTierFallbacks(config, () => false).strong.pair, null);
  // small borrows default's first usable step.
  assert.equal(r.small.pair?.model, "b");
  assert.equal(r.small.from, "default");
  const labels = seamsInUse(config).map((s) => s.label);
  assert.ok(labels.includes("fallback:default") && labels.includes("fallback:default#1"));
});

test("a Claude step is marked extraUsage when a Claude model comes earlier in its chain", () => {
  const claude: TumwaterConfig = { ...defaultConfig(), backend: "claude" };
  const chain = (cfg: TumwaterConfig) => tierChainSteps(cfg).map((s) => s.pair.extraUsage === true);
  const sonnet = { backend: "claude", model: "claude-sonnet-5-5" } as const;
  const haiku = { backend: "claude", model: "claude-haiku-5-5" } as const;
  assert.deepEqual(
    chain({ ...claude, fallback: [sonnet, haiku, { backend: "pi", model: "omlx/qwen" }] }),
    [true, true, false],
    "a Claude primary makes every Claude step extra usage",
  );
  const pi: TumwaterConfig = { ...defaultConfig(), provider: "omlx", model: "qwen" };
  assert.deepEqual(
    chain({ ...pi, fallback: [sonnet, sonnet, "omlx/qwen"] }),
    [false, true, false],
    "with a pi primary the first Claude step stays on the subscription",
  );
  const mapped = { ...pi, fallback: { default: [sonnet], strong: ["omlx/qwen", sonnet] } };
  assert.deepEqual(chain(mapped), [false, false, false], "each tier's chain marks by its own order, so a second chain's first Claude step is unmarked");
});

test("teamModelLabel qualifies a non-pi backend's model id once", () => {
  for (const [backend, model, want] of [
    ["opencode", "deepseek-v4.1-flash-free", "opencode/deepseek-v4.1-flash-free"],
    ["claude", "claude-sonnet-5-5", "claude/claude-sonnet-5-5"],
  ] as const) {
    const cfg: TumwaterConfig = defaultConfig();
    cfg.backend = backend;
    cfg.model = model;
    assert.equal(teamModelLabel(cfg), want);
  }
});

// Routing goldens: each shape's seamsInUse list (grouped by agent|provider|model|thinking),
// recorded in the explicit-backend form: a model id never names a backend, so each shape
// spells its backend with the `backend` key.
const ROUTING_GOLDENS: Record<string, string[]> = {
  "string model": [
    "pi|anthropic|claude-sonnet-5-5|high <- 17:feature,bugfix,plan,readme,organize,coverage,clean,dedupe,perf,qa,security,robustness,improve,steward,director,review,resolver"
  ],
  "string model legacy provider": [
    "pi|qwenrunner|qwen3.8-27b|- <- 17:feature,bugfix,plan,readme,organize,coverage,clean,dedupe,perf,qa,security,robustness,improve,steward,director,review,resolver"
  ],
  "map with tier entry and inherited default": [
    "pi|qwenrunner|qwen3.8-27b|- <- 13:feature,bugfix,readme,organize,coverage,clean,dedupe,perf,qa,security,robustness,improve,steward",
    "pi|huggingface|zai-org/GLM-5.3-Flash:together|low <- 4:plan,director,review,resolver"
  ],
  "claude id under backend claude": [
    "claude|-|claude-opus-5-5|- <- 17:feature,bugfix,plan,readme,organize,coverage,clean,dedupe,perf,qa,security,robustness,improve,steward,director,review,resolver"
  ],
  "claude-named provider under pi": [
    "pi|claude|claude-opus-5-5|- <- 17:feature,bugfix,plan,readme,organize,coverage,clean,dedupe,perf,qa,security,robustness,improve,steward,director,review,resolver"
  ],
  "gateway id under backend opencode": [
    "opencode|-|anthropic/claude-sonnet-5-5|- <- 17:feature,bugfix,plan,readme,organize,coverage,clean,dedupe,perf,qa,security,robustness,improve,steward,director,review,resolver"
  ],
  "anthropic id under claude backend": [
    "claude|-|anthropic/claude-sonnet-5-5|- <- 17:feature,bugfix,plan,readme,organize,coverage,clean,dedupe,perf,qa,security,robustness,improve,steward,director,review,resolver"
  ],
  "claude backend no model": [
    "claude|-|claude-sonnet-5-5|- <- 12:feature,bugfix,organize,coverage,clean,dedupe,perf,qa,security,robustness,improve,steward",
    "claude|-|claude-opus-5-5|- <- 4:plan,director,review,resolver",
    "claude|-|claude-haiku-5-5|- <- 1:readme"
  ],
  "opencode backend no model": [
    "opencode|-|-|- <- 17:feature,bugfix,plan,readme,organize,coverage,clean,dedupe,perf,qa,security,robustness,improve,steward,director,review,resolver"
  ],
  "role selector override": [
    "claude|-|claude-haiku-5-5|low <- 1:feature",
    "pi|qwenrunner|qwen3.8-27b|- <- 16:bugfix,plan,readme,organize,coverage,clean,dedupe,perf,qa,security,robustness,improve,steward,director,review,resolver"
  ],
  "role tier-name override": [
    "claude|-|claude-opus-5-5|- <- 5:feature,plan,director,review,resolver",
    "pi|qwenrunner|qwen3.8-27b|- <- 12:bugfix,readme,organize,coverage,clean,dedupe,perf,qa,security,robustness,improve,steward"
  ],
  "review override": [
    "pi|qwenrunner|qwen3.8-27b|- <- 16:feature,bugfix,plan,readme,organize,coverage,clean,dedupe,perf,qa,security,robustness,improve,steward,director,resolver",
    "opencode|-|anthropic/claude-sonnet-5-5|- <- 1:review"
  ],
  "fallback chain": [
    "claude|-|claude-sonnet-5-5|- <- 17:feature,bugfix,plan,readme,organize,coverage,clean,dedupe,perf,qa,security,robustness,improve,steward,director,review,resolver",
    "pi|qwenrunner|qwen3.8-27b|- <- 1:fallback:default",
    "claude|-|claude-haiku-5-5|- <- 1:fallback:default#1"
  ]
};

test("ROUTING_GOLDENS: every pre-existing routing shape resolves as it did", () => {
  const mk = (o: Partial<TumwaterConfig>): TumwaterConfig => ({ ...defaultConfig(), ...o });
  const withRole = (o: Partial<TumwaterConfig>, id: string, rc: Record<string, unknown>): TumwaterConfig => {
    const c = mk(o);
    c.roles = { ...c.roles, [id]: { ...c.roles[id]!, ...rc } };
    return c;
  };
  const review = mk({ model: "qwenrunner/qwen3.8-27b" });
  review.review = { ...review.review, backend: "opencode", model: "anthropic/claude-sonnet-5-5" };
  const cases: Record<string, TumwaterConfig> = {
    "string model": mk({ model: "anthropic/claude-sonnet-5-5:high" }),
    "string model legacy provider": mk({ provider: "qwenrunner", model: "qwen3.8-27b" }),
    "map with tier entry and inherited default": mk({
      model: { default: "qwenrunner/qwen3.8-27b", strong: "huggingface/zai-org/GLM-5.3-Flash:together:low" },
    }),
    "claude id under backend claude": mk({ backend: "claude", model: "claude-opus-5-5" }),
    "claude-named provider under pi": mk({ model: "claude/claude-opus-5-5" }),
    "gateway id under backend opencode": mk({ backend: "opencode", model: "anthropic/claude-sonnet-5-5" }),
    "anthropic id under claude backend": mk({ backend: "claude", model: "anthropic/claude-sonnet-5-5" }),
    "claude backend no model": mk({ backend: "claude" }),
    "opencode backend no model": mk({ backend: "opencode" }),
    "role selector override": withRole({ model: "qwenrunner/qwen3.8-27b" }, "feature", {
      backend: "claude",
      model: "claude-haiku-5-5",
      thinking: "low",
    }),
    "role tier-name override": withRole(
      { model: { default: "qwenrunner/qwen3.8-27b", strong: { backend: "claude", model: "claude-opus-5-5" } } },
      "feature",
      { model: "strong" },
    ),
    "review override": review,
    "fallback chain": mk({
      backend: "claude",
      model: "claude-sonnet-5-5",
      fallback: [{ backend: "pi", model: "qwenrunner/qwen3.8-27b" }, "claude-haiku-5-5"],
    }),
  };
  for (const [name, config] of Object.entries(cases)) {
    const groups = new Map<string, string[]>();
    for (const { label, agent, provider, model, thinking } of seamsInUse(config)) {
      const key = [agent, provider ?? "-", model ?? "-", thinking ?? "-"].join("|");
      groups.set(key, [...(groups.get(key) ?? []), label]);
    }
    const got = [...groups].map(([k, l]) => `${k} <- ${l.length}:${l.join(",")}`);
    assert.deepEqual(got, ROUTING_GOLDENS[name], name);
  }
});

test("explicit backend: a tier entry routes its own model on its backend, beside an unchanged pi default", () => {
  const config = {
    ...defaultConfig(),
    model: {
      default: "qwenrunner/qwen3.8-27b",
      strong: { backend: "claude", model: "claude-opus-5-5" },
    },
  } as TumwaterConfig;
  for (const seam of seamsInUse(config)) {
    const strong = ["plan", "director", "review", "resolver"].includes(seam.label);
    assert.equal(seam.agent, strong ? "claude" : "pi", seam.label);
    assert.equal(seam.model, strong ? "claude-opus-5-5" : "qwen3.8-27b", seam.label);
  }
  // A role naming only `model` does not inherit the tier entry's backend.
  config.roles.director = { ...config.roles.director!, model: "qwenrunner/qwen3.8-27b" };
  const director = configForRole(config, "director");
  assert.equal(director.agent, "pi");
  assert.equal(director.provider, "qwenrunner");
  assert.equal(director.model, "qwen3.8-27b");
  assert.match(teamModelLabel(config)!, /strong=claude\/claude-opus-5-5/);
});

test("explicit backend: a role naming only backend inherits the tier's model only when the tier routes there", () => {
  const role = (model: TumwaterConfig["model"], backend: string): ReturnType<typeof configForRole> => {
    const config = { ...defaultConfig(), model } as TumwaterConfig;
    config.roles.feature = { ...config.roles.feature!, backend };
    return configForRole(config, "feature");
  };
  // The tier routes to claude, so a pi-only role gets pi's own default, not that id.
  const pi = role({ default: { backend: "claude", model: "claude-opus-5-5" } }, "pi");
  assert.equal(pi.agent, "pi");
  assert.equal(pi.model, undefined);
  assert.equal(pi.provider, undefined);
  // The tier is on claude through its backend key, so the claude role inherits its id.
  const claude = role({ default: { backend: "claude", model: "claude-opus-5-5" } }, "claude");
  assert.equal(claude.agent, "claude");
  assert.equal(claude.model, "claude-opus-5-5");
});

test("explicit backend: a role's backend plus model passes the id verbatim; a bare tier entry backend takes the tier default", () => {
  const config = { ...defaultConfig(), model: "qwenrunner/qwen3.8-27b" } as TumwaterConfig;
  config.roles.feature = {
    ...config.roles.feature!,
    backend: "opencode",
    model: "anthropic/claude-sonnet-5-5",
  };
  const feature = configForRole(config, "feature");
  assert.equal(feature.agent, "opencode");
  assert.equal(feature.model, "anthropic/claude-sonnet-5-5");
  assert.equal(feature.provider, undefined);

  const tiered = {
    ...defaultConfig(),
    model: { default: "qwenrunner/qwen3.8-27b", strong: { backend: "claude" } },
  } as TumwaterConfig;
  const strong = resolverConfig(tiered);
  assert.equal(strong.agent, "claude");
  assert.equal(strong.model, "claude-opus-5-5");
});

test("topTierBackend reads an object entry's backend, and yields none for a string or an uninheritable one", () => {
  const strong: ModelSelectorEntry = { backend: "claude", model: "claude-opus-5-5" };
  const config = { ...defaultConfig(), model: { default: "qwenrunner/qwen3.8-27b", strong } } as TumwaterConfig;
  assert.equal(topTierBackend(config, "strong"), "claude");
  assert.equal(topTierBackend(config, "default"), undefined);
  // A tier entry naming a backend `default` does not route to takes no inherited model.
  const bare = { ...defaultConfig(), model: { default: "qwenrunner/qwen3.8-27b", small: { backend: "claude" } } } as TumwaterConfig;
  assert.equal(topTierBackend(bare, "small"), "claude");
  assert.equal(tierModel(bare, "small"), undefined);
});

test("applyFallbackModel keeps a free object tier entry's backend and strips a role's backend", () => {
  const config: TumwaterConfig = defaultConfig();
  config.model = { default: "paid/gpt-x", strong: { backend: "claude", model: "opus" } };
  config.fallback = "free/qwen-free";
  config.roles.plan = { enabled: true, backend: "opencode", model: "ollama/qwen3" };
  const resolved = resolveTierFallbacks(config, () => true);
  const out = applyFallbackModel(config, resolved, (seam) => seam.agent === "claude");
  assert.equal(withModelOverrides(out, "strong", {}).agent, "claude", "the free tier keeps its backend");
  assert.equal(out.roles.plan?.backend, undefined, "a priced role's backend is dropped with its model");
  assert.equal(out.roles.plan?.model, undefined);
});

test("applyFallbackModel drops a paid backend pinned beside a tier-name role model", () => {
  const config: TumwaterConfig = defaultConfig();
  config.model = { default: "paid/gpt-x" };
  config.fallback = "free/qwen-free";
  config.roles.feature = { enabled: true, model: "strong", backend: "opencode" };
  const out = applyFallbackModel(config, resolveTierFallbacks(config, () => true));
  assert.equal(out.roles.feature?.model, "strong", "the tier reference stays");
  assert.equal(out.roles.feature?.backend, undefined, "the paid backend does not survive the cap");
});

test("an explicit fallback step backend overrides the team's; a step with none inherits it", () => {
  const withFallback = (backend: "pi" | "claude", fallback: TumwaterConfig["fallback"]): TumwaterConfig => ({
    ...defaultConfig(),
    backend,
    fallback,
  });
  const pi = fallbackPair(withFallback("claude", [{ backend: "pi", model: "qwenrunner/qwen3.8-27b" }]));
  assert.deepEqual(pi, { provider: "qwenrunner", model: "qwen3.8-27b" });
  const inherited = fallbackPair(withFallback("claude", ["qwenrunner/qwen3.8-27b"]));
  assert.equal(inherited?.backend, "claude", "no step backend: the claude team's applies, the id verbatim");
  assert.equal(inherited?.model, "qwenrunner/qwen3.8-27b");
  const explicit = fallbackPair(withFallback("pi", [{ backend: "claude", model: "claude-sonnet-5-5" }]));
  assert.deepEqual(explicit, { backend: "claude", provider: "claude", model: "claude-sonnet-5-5" });
  assert.equal(explicit && fallbackDisplayPair(explicit, "pi default"), "claude/claude-sonnet-5-5");
  const capped = tierChainSteps(withFallback("pi", [{ backend: "claude", model: "claude-sonnet-5-5", maxDailyCostUsd: 2 }]))[0]?.pair;
  assert.equal(capped?.backend, "claude");
  assert.equal(capped?.maxDailyCostUsd, 2);
});

test("the migrated operator config resolves claude for every primary seam and pi for the fallback", () => {
  const config: TumwaterConfig = {
    ...defaultConfig(),
    backend: "claude",
    model: { default: "claude-sonnet-5-5", strong: "claude-opus-5-5" },
    fallback: [{ backend: "pi", model: "qwenrunner/qwen3.8-27b" }],
  };
  const seams = seamsInUse(config);
  const primary = seams.filter((s) => !s.label.startsWith("fallback:"));
  assert.ok(primary.length > 0);
  assert.ok(primary.every((s) => s.agent === "claude"), "every primary seam runs on claude");
  const fallback = seams.filter((s) => s.label.startsWith("fallback:"));
  assert.ok(fallback.length > 0);
  assert.ok(fallback.every((s) => s.agent === "pi" && s.provider === "qwenrunner" && s.model === "qwen3.8-27b"));
});

test("windowReserveFor reads the nested claude key, falls back to claudeWindowReserve, and is undefined otherwise", () => {
  const nested = { backends: { claude: { windowReserve: { seven_day: 0.8 } } } };
  assert.deepEqual(windowReserveFor(nested, "claude"), { seven_day: 0.8 });
  // A backend with neither spelling answers undefined.
  assert.equal(windowReserveFor({ backends: {} }, "codex"), undefined);
  assert.equal(windowReserveFor({}, "codex"), undefined);
  // The top-level spelling is claude's older fallback.
  assert.deepEqual(windowReserveFor({ claudeWindowReserve: { five_hour: 1 } }, "claude"), { five_hour: 1 });
  // but not a sibling backend's.
  assert.equal(windowReserveFor({ claudeWindowReserve: { five_hour: 1 } }, "codex"), undefined);
  // The nested key wins over the legacy spelling.
  assert.deepEqual(
    windowReserveFor({ claudeWindowReserve: { seven_day: 0.9 }, backends: { claude: { windowReserve: { seven_day: 0.8 } } } }, "claude"),
    { seven_day: 0.8 },
  );
});
