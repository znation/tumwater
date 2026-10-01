import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "../src/config.js";
import {
  applyFallbackModel,
  configForRole,
  FALLBACK_REVIEW_TIMEOUT_S,
  fallbackPair,
  reviewConfig,
  reviewRunConfig,
  REVIEW_TIMEOUT_S,
} from "../src/config-views.js";

// config-views.ts's derived views over a loaded config: how the role, review, and fallback
// overlays resolve on top of the top-level pi settings. The load/save/validation side of the
// config lives in test/config.test.ts; the validators have test/config-validation.test.ts.

test("configForRole applies role overrides over top-level pi settings", () => {
  const config = defaultConfig();
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
  assert.deepEqual(configForRole(config, "nonexistent"), config);
});

test("reviewConfig applies the review section's overrides over top-level pi settings", () => {
  const config = defaultConfig();
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
  const config = defaultConfig();
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
  const config = defaultConfig();
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
  const config = defaultConfig();
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
  const config = defaultConfig();
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
