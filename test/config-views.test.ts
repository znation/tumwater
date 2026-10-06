import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "../src/config/config.js";
import type { TumwaterConfig } from "../src/config/config-schema.js";
import {
  applyFallbackModel,
  configForRole,
  FALLBACK_REVIEW_TIMEOUT_S,
  fallbackPair,
  reviewConfig,
  reviewRunConfig,
  REVIEW_TIMEOUT_S,
  tierModel,
} from "../src/config/config-views.js";

// config-views.ts's derived views over a loaded config: how the role, review, and fallback
// overlays resolve on top of the top-level pi settings. The load/save/validation side of the
// config lives in test/config.test.ts; the validators have test/config-validation.test.ts.

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
  config.tickTimeoutSeconds = 54_000;
  config.review.model = "strong-model";
  const run = reviewRunConfig(config);
  assert.equal(run.tickTimeoutSeconds, REVIEW_TIMEOUT_S, "the tick's hours-long budget never reaches the reviewer");
  assert.equal(run.model, "strong-model", "the run keeps the reviewer's model wiring");
  assert.equal(run.quietTimeoutSeconds, config.quietTimeoutSeconds, "only the wall-clock budget changes");

  // A configured review.timeoutSeconds replaces the default; a smaller tick budget still wins.
  config.review.timeoutSeconds = 120;
  assert.equal(reviewRunConfig(config).tickTimeoutSeconds, 120);
  config.tickTimeoutSeconds = 60;
  assert.equal(reviewRunConfig(config).tickTimeoutSeconds, 60);
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
  // review timed out and no code change landed until midnight (BUGS.md 2026-09-30).
  const config: TumwaterConfig = defaultConfig();
  config.tickTimeoutSeconds = 54_000;
  config.fallbackModel = { provider: "omlx", model: "local-free" };
  assert.equal(reviewRunConfig(config).tickTimeoutSeconds, REVIEW_TIMEOUT_S, "the budgeted model keeps its own budget");
  assert.equal(reviewRunConfig(applyFallbackModel(config)).tickTimeoutSeconds, FALLBACK_REVIEW_TIMEOUT_S);

  // A configured budget below the floor is raised only on the fallback; one above it stands.
  config.review.timeoutSeconds = 120;
  assert.equal(reviewRunConfig(config).tickTimeoutSeconds, 120);
  assert.equal(reviewRunConfig(applyFallbackModel(config)).tickTimeoutSeconds, FALLBACK_REVIEW_TIMEOUT_S);
  config.review.timeoutSeconds = 7200;
  assert.equal(reviewRunConfig(applyFallbackModel(config)).tickTimeoutSeconds, 7200);
  assert.equal(config.review.timeoutSeconds, 7200, "the source config is untouched");

  // The tick's own budget still caps the reviewer, fallback or not.
  config.tickTimeoutSeconds = 600;
  assert.equal(reviewRunConfig(applyFallbackModel(config)).tickTimeoutSeconds, 600);
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

test("configForRole resolves each seam's tier: plan strong, readme small, others default", () => {
  const config: TumwaterConfig = defaultConfig();
  config.model = { default: "prov/a", strong: "prov/b", small: "prov/c" };
  assert.equal(configForRole(config, "plan").model, "b");
  assert.equal(configForRole(config, "readme").model, "c");
  assert.equal(configForRole(config, "feature").model, "a");
  assert.equal(configForRole(config, "director").model, "a");
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
