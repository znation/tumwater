import test from "node:test";
import assert from "node:assert/strict";
import {
  REVIEW_TIMEOUT_S,
  applyFallbackModel,
  configForRole,
  fallbackPair,
  reviewConfig,
  reviewRunConfig,
} from "../src/config-views.js";
import { defaultConfig } from "../src/config.js";
import type { TumwaterConfig } from "../src/config-schema.js";

/** A copy of the default config with a known top-level model wiring and no role
 * overrides — the starting point every test mutates. */
function baseConfig(): TumwaterConfig {
  const c = JSON.parse(JSON.stringify(defaultConfig())) as TumwaterConfig;
  c.provider = "prov";
  c.model = "top-model";
  c.thinking = "medium";
  c.roles = {};
  return c;
}

test("configForRole returns the config unchanged for an unknown role", () => {
  const config = baseConfig();
  assert.equal(configForRole(config, "nobody"), config);
});

test("configForRole applies a role's model overrides over the top-level values", () => {
  const config = baseConfig();
  config.roles.author = {
    enabled: true,
    provider: "role-prov",
    model: "role-model",
    thinking: "high",
  };
  const seen = configForRole(config, "author");
  assert.equal(seen.provider, "role-prov");
  assert.equal(seen.model, "role-model");
  assert.equal(seen.thinking, "high");
  // The top-level config itself is untouched — the view is a derivation.
  assert.equal(config.model, "top-model");
});

test("configForRole keeps the top-level values where the role sets no override", () => {
  const config = baseConfig();
  config.roles.author = { enabled: true, model: "role-model" };
  const seen = configForRole(config, "author");
  assert.equal(seen.model, "role-model");
  assert.equal(seen.provider, "prov");
  assert.equal(seen.thinking, "medium");
});

test("configForRole falls back to the global minTickIntervalSeconds when the role sets none", () => {
  const config = baseConfig();
  config.minTickIntervalSeconds = 60;
  config.roles.steward = { enabled: true };
  assert.equal(configForRole(config, "steward").minTickIntervalSeconds, 60);
  config.roles.steward = { enabled: true, minTickIntervalSeconds: 21_600 };
  assert.equal(configForRole(config, "steward").minTickIntervalSeconds, 21_600);
});

test("reviewConfig applies the review section's overrides over the top-level values", () => {
  const config = baseConfig();
  config.review = { enabled: true, exemptPaths: [], model: "review-model", thinking: "high" };
  const seen = reviewConfig(config);
  assert.equal(seen.model, "review-model");
  assert.equal(seen.thinking, "high");
  assert.equal(seen.provider, "prov");
});

test("reviewConfig keeps the top-level wiring when the review section overrides nothing", () => {
  const config = baseConfig();
  const seen = reviewConfig(config);
  assert.equal(seen.provider, "prov");
  assert.equal(seen.model, "top-model");
  assert.equal(seen.thinking, "medium");
});

test("reviewRunConfig caps tickTimeoutSeconds at the default review timeout", () => {
  const config = baseConfig();
  config.tickTimeoutSeconds = 10_000;
  const seen = reviewRunConfig(config);
  assert.equal(seen.tickTimeoutSeconds, REVIEW_TIMEOUT_S);
});

test("reviewRunConfig honors a smaller review.timeoutSeconds over the tick budget", () => {
  const config = baseConfig();
  config.tickTimeoutSeconds = 10_000;
  config.review = { enabled: true, exemptPaths: [], timeoutSeconds: 120 };
  assert.equal(reviewRunConfig(config).tickTimeoutSeconds, 120);
});

test("reviewRunConfig keeps a smaller tickTimeoutSeconds even with a larger review budget", () => {
  const config = baseConfig();
  config.tickTimeoutSeconds = 300;
  config.review = { enabled: true, exemptPaths: [], timeoutSeconds: 900 };
  assert.equal(reviewRunConfig(config).tickTimeoutSeconds, 300);
});

test("fallbackPair returns null without a fallbackModel", () => {
  const config = baseConfig();
  assert.equal(fallbackPair(config), null);
  assert.equal(applyFallbackModel(config), config);
});

test("fallbackPair fills missing fields from the top-level config", () => {
  const config = baseConfig();
  config.fallbackModel = { model: "free-model" };
  assert.deepEqual(fallbackPair(config), { provider: "prov", model: "free-model", thinking: "medium" });
});

test("fallbackPair keeps the fallback's own fields over the top-level ones", () => {
  const config = baseConfig();
  config.fallbackModel = { provider: "free-prov", model: "free-model", thinking: "low" };
  assert.deepEqual(fallbackPair(config), {
    provider: "free-prov",
    model: "free-model",
    thinking: "low",
  });
});

test("applyFallbackModel installs the fallback pair and strips every model override", () => {
  const config = baseConfig();
  config.fallbackModel = { provider: "free-prov", model: "free-model" };
  config.roles.author = {
    enabled: true,
    model: "paid-model",
    instructions: "keep writing",
    minTickIntervalSeconds: 60,
  };
  config.roles.steward = { enabled: true, thinking: "high" };
  config.review = { enabled: true, exemptPaths: [], model: "review-model", timeoutSeconds: 120 };

  const seen = applyFallbackModel(config);
  // The fallback pair is the top-level wiring now.
  assert.equal(seen.provider, "free-prov");
  assert.equal(seen.model, "free-model");
  assert.equal(seen.thinking, "medium"); // filled from the top-level thinking
  // Role overrides are dropped — a role pinned to a paid model must not keep spending —
  // while the rest of each role entry survives.
  assert.equal(seen.roles.author?.model, undefined);
  assert.equal(seen.roles.author?.provider, undefined);
  assert.equal(seen.roles.author?.instructions, "keep writing");
  assert.equal(seen.roles.author?.minTickIntervalSeconds, 60);
  assert.equal(seen.roles.steward?.thinking, undefined);
  // The reviewer's override is dropped too: its run must resolve to the free pair.
  assert.equal(seen.review.model, undefined);
  assert.equal(seen.review.enabled, true);
  assert.equal(seen.review.timeoutSeconds, 120);
  // Everything else is untouched — the gate re-evaluates against the same numbers.
  assert.equal(seen.minTickIntervalSeconds, config.minTickIntervalSeconds);
  assert.equal(seen.tickTimeoutSeconds, config.tickTimeoutSeconds);
  assert.equal(seen.maxDailyCostUsd, config.maxDailyCostUsd);
});
