import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "../src/config/config.js";
import { validateConfig } from "../src/config/config-validation.js";
import { validationError } from "./fixtures/config-fixtures.js";

// validateConfig's model-selection forms (src/config/config-validation.ts): the budget
// `fallback` selector/object/tier-map and the `model` tier-map and tier-name forms
// (plans/model-tiers.md). Split from test/config-validation.test.ts (2026-10-11).

test("the fallback selector string is validated like its fallbackModel object form", () => {
  // A non-empty string: empty would silently never engage, the same silent-ignore class
  // fallbackModel's object form already rejects. A string may also be a map by tier —
  // plans/model-tiers.md — whose values are selector strings or "pause".
  assert.match(
    validationError({ fallback: "" }),
    /fallback must be a model id or a map by tier \(got ""\)/,
  );
  assert.match(
    validationError({ fallback: 3 }),
    /fallback must be a model id or a map by tier \(got 3\)/,
  );
  assert.doesNotThrow(() => validateConfig({ fallback: "omlx/local-free" }));
  assert.doesNotThrow(() => validateConfig({ fallback: "omlx/local-free:low" }));
  assert.doesNotThrow(() =>
    validateConfig({ fallback: { default: "omlx/local-free", strong: "pause" } }),
  );
  assert.match(
    validationError({ fallback: { medium: "omlx/local-free" } }),
    /unknown key "medium" in fallback \(valid keys: small, default, strong\)/,
  );
  assert.match(
    validationError({ fallback: { default: "" } }),
    /fallback\.default must be a non-empty model id or "pause" \(got ""\)/,
  );
  assert.match(
    validationError({ fallback: "pause" }),
    /fallback "pause" is only valid as a tier map value/,
  );
  // Setting both forms is an error naming both keys — which one wins is not a question the
  // file should ever pose.
  const both = validationError({ fallback: "omlx/local-free", fallbackModel: { model: "m" } });
  assert.match(both, /fallback and fallbackModel both name the budget fallback/);
  assert.match(both, /fallbackModel/);
});

// --- Model tiers (plans/model-tiers.md part 3/8) --------------------------------------------

test("validateConfig guards the tier-map and tier-name forms of model", () => {
  // A well-formed map passes.
  assert.doesNotThrow(() =>
    validateConfig({ model: { default: "prov/a", strong: "prov/b:high", small: "prov/c" } }),
  );
  // Map keys are exactly the three tiers.
  assert.match(
    validationError({ model: { medium: "prov/a" } }),
    /unknown key "medium" in model \(valid keys: small, default, strong\)/,
  );
  // Map values are non-empty model ids.
  assert.match(
    validationError({ model: { default: "" } }),
    /model\.default must be a non-empty model id \(got ""\)/,
  );
  // A map cannot coexist with the legacy top-level provider.
  assert.match(
    validationError({ provider: "prov", model: { default: "a" } }),
    /model as a map by tier cannot coexist with the legacy top-level provider/,
  );
  // Tier names are valid only as roles.<id>.model / review.model values.
  assert.match(
    validationError({ model: "strong" }),
    /model must name a model id — tier names are valid only as roles\.<id>\.model or review\.model values/,
  );
  assert.doesNotThrow(() => validateConfig({ roles: { plan: { enabled: true, model: "strong" } } }));
  assert.doesNotThrow(() =>
    validateConfig({ model: { default: "prov/a" }, review: { enabled: true, model: "default" } }),
  );
  // A tier-name override without a model map is legal but inert (it resolves to pi's default).
  // A non-string model keeps an actionable message.
  assert.match(
    validationError({ roles: { plan: { enabled: true, model: 7 } } }),
    /roles\.plan\.model must be a model id or a tier name \(small, default, strong\) \(got 7\)/,
  );
});

test("validateConfig bounds maintenancePerWorkMerge to a number of 0 or more", () => {
  // Work ratio 1a/4: zero and fractions are valid; a negative value or a string is not.
  for (const v of [0, 2, 2.5])
    assert.doesNotThrow(() => validateConfig({ ...defaultConfig(), maintenancePerWorkMerge: v }));
  assert.match(
    validationError({ ...defaultConfig(), maintenancePerWorkMerge: -1 }),
    /maintenancePerWorkMerge must be a number of 0 or more \(got -1\)/,
  );
  assert.match(
    validationError({ ...defaultConfig(), maintenancePerWorkMerge: "2" }),
    /maintenancePerWorkMerge must be a number of 0 or more \(got "2"\)/,
  );
});

test("fallback lists: non-empty, each element a model id, pause only as a whole-tier value", () => {
  assert.doesNotThrow(() => validateConfig({ fallback: ["omlx/a", "omlx/b"] }));
  assert.doesNotThrow(() => validateConfig({ fallback: { default: ["omlx/a", "omlx/b"], strong: "pause" } }));
  for (const bad of [[], [""], ["pause"], [3]])
    assert.match(validationError({ fallback: bad }), /fallback list/);
  assert.match(validationError({ fallback: { default: [] } }), /fallback\.default list/);
});

test("a fallback chain step may be an object with a positive maxDailyCostUsd", () => {
  assert.doesNotThrow(() =>
    validateConfig({ fallback: [{ model: "hf/m", maxDailyCostUsd: 5 }, "omlx/local", { model: "omlx/b" }] }),
  );
  assert.doesNotThrow(() => validateConfig({ fallback: { default: { model: "hf/m", maxDailyCostUsd: 1.5 } } }));
  assert.match(validationError({ fallback: [{ model: "hf/m", maxDailyCostUsd: 0 }] }), /fallback\[0\]\.maxDailyCostUsd must be a positive number/);
  assert.match(validationError({ fallback: [{ model: "hf/m", maxDailyCostUsd: "5" }] }), /maxDailyCostUsd must be a positive number/);
  assert.match(validationError({ fallback: [{ maxDailyCostUsd: 5 }] }), /fallback\[0\]\.model must be a non-empty model id/);
  assert.match(validationError({ fallback: [{ model: "hf/m", cap: 5 }] }), /cap/);
});
