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
  assert.match(
    validationError({ roles: { plan: { enabled: true, model: "strnog" } } }),
    /roles\.plan\.model "strnog" is not a tier name or a model id pi can resolve — did you mean `strong`\?/,
  );
  assert.match(
    validationError({ review: { enabled: true, model: "Default" } }),
    /review\.model "Default" is not a tier name or a model id pi can resolve — did you mean `default`\?/,
  );
  assert.match(
    validationError({ roles: { plan: { enabled: true, model: "smal" } } }),
    /did you mean `small`\?/,
  );
  for (const model of ["prov/strnog", "gpt-5", "sonnet"])
    assert.doesNotThrow(() => validateConfig({ roles: { plan: { enabled: true, model } } }));
  assert.doesNotThrow(() =>
    validateConfig({ roles: { plan: { enabled: true, provider: "prov", model: "smal" } } }),
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

// `backend` beside `model` on a tier entry, a role and `review`: the backend must be a
// registered id, and the model written beside it must be a valid id for that backend.
test("backend beside model: tier entries, roles and review accept registered backends only", () => {
  assert.doesNotThrow(() =>
    validateConfig({
      model: {
        default: "qwenrunner/qwen3.8-27b",
        strong: { backend: "claude", model: "claude-opus-5-5", thinking: "high" },
        small: { backend: "opencode", model: "anthropic/claude-haiku-5-5" },
      },
      roles: { feature: { backend: "pi", model: "qwenrunner/qwen3.8-27b" } },
      review: { backend: "claude" },
    }),
  );
  assert.match(
    validationError({ model: { strong: { backend: "gemini", model: "x" } } }),
    /model\.strong\.backend must name a backend \(pi, claude, opencode, codex; got "gemini"\)/,
  );
  assert.match(
    validationError({ roles: { feature: { backend: "gemini" } } }),
    /roles\.feature\.backend must name a backend \(pi, claude, opencode, codex; got "gemini"\)/,
  );
  assert.match(
    validationError({ review: { backend: "gemini" } }),
    /review\.backend must name a backend \(pi, claude, opencode, codex; got "gemini"\)/,
  );
  assert.match(
    validationError({ model: { strong: { backend: "claude", mdoel: "x" } } }),
    /unknown key "mdoel" in model\.strong/,
  );
});

test("backend beside model: the id must fit the backend", () => {
  assert.match(
    validationError({ roles: { feature: { backend: "claude", model: "anthropic/claude-opus-5-5" } } }),
    /roles\.feature\.model "anthropic\/claude-opus-5-5" has a "\/" but roles\.feature\.backend is "claude"/,
  );
  assert.match(
    validationError({ model: { strong: { backend: "pi", model: "claude-opus-5-5" } } }),
    /model\.strong\.model "claude-opus-5-5" has no provider but model\.strong\.backend is "pi"/,
  );
  assert.match(
    validationError({ review: { backend: "pi", model: "claude/claude-opus-5-5" } }), // legacy spelling, retired in part 5/5
    /review\.model "claude\/claude-opus-5-5" names the backend "claude" as its provider.*drop the "claude\/" namespace/,
  );
});

// The retired backend spellings (Backend/model split, part 5/5): a model id never names a
// backend, so each old spelling fails the load with the edit that replaces it.
test("a model id that names a backend fails, naming the backend key to write instead", () => {
  assert.match(
    validationError({ model: "claude/claude-opus-5-5" }),
    /model "claude\/claude-opus-5-5" names the backend "claude" in its model id — write backend: "claude" beside model: "claude-opus-5-5"/,
  );
  assert.match(
    validationError({ model: "opencode/deepseek-free" }),
    /write backend: "opencode" beside model: "deepseek-free"/,
  );
  assert.match(
    validationError({ model: "claude-sonnet-5-5" }),
    /model "claude-sonnet-5-5" is a claude model id but the backend is pi — add backend: "claude" beside it, or write "anthropic\/claude-sonnet-5-5" to keep it on pi/,
  );
  // The same check reaches each place a selector is written.
  assert.match(
    validationError({ model: { strong: "claude/claude-opus-5-5" } }),
    /model\.strong "claude\/claude-opus-5-5" names the backend "claude"/,
  );
  assert.match(
    validationError({ roles: { feature: { model: "claude-opus-5-5" } } }),
    /roles\.feature\.model "claude-opus-5-5" is a claude model id/,
  );
  assert.match(
    validationError({ review: { model: "claude/claude-opus-5-5" } }),
    /review\.model "claude\/claude-opus-5-5" names the backend "claude"/,
  );
  assert.match(
    validationError({ fallback: ["qwenrunner/qwen3.8-27b", "claude/claude-haiku-5-5"] }),
    /fallback\[1\] "claude\/claude-haiku-5-5" names the backend "claude"/,
  );
  // A provider/model id under a claude backend would run as a paid claude model: it fails the
  // load, and a string fallback is checked against every tier's backend, not just the default's.
  assert.match(
    validationError({ backend: "claude", fallback: "qwenrunner/qwen3.8-27b" }),
    /fallback "qwenrunner\/qwen3.8-27b" is a provider\/model id but the backend is claude.*add backend: "pi"/,
  );
  assert.match(
    validationError({ model: { strong: { backend: "claude", model: "claude-opus-5-5" } }, fallback: "claude-sonnet-5-5" }),
    /fallback "claude-sonnet-5-5" is a claude model id but the backend is pi/,
  );
  // A fallback step inherits its tier primary's backend, so the bare id passes under claude.
  assert.doesNotThrow(() => validateConfig({ backend: "claude", fallback: "claude-haiku-5-5" }));
  assert.match(validationError({ fallback: "claude-haiku-5-5" }), /fallback "claude-haiku-5-5" is a claude model id/);
});

test("the explicit backend form and its pi and opencode neighbours still validate", () => {
  assert.doesNotThrow(() => validateConfig({ backend: "claude", model: "claude-sonnet-5-5" }));
  assert.doesNotThrow(() => validateConfig({ backend: "claude", model: { strong: "claude-opus-5-5" } }));
  assert.doesNotThrow(() => validateConfig({ model: "anthropic/claude-sonnet-5-5" }));
  assert.doesNotThrow(() => validateConfig({ backend: "opencode", model: "opencode/deepseek-free" }));
  assert.doesNotThrow(() =>
    validateConfig({
      backend: "claude",
      fallback: [{ backend: "pi", model: "qwenrunner/qwen3.8-27b" }],
    }),
  );
});

test("a legacy provider that is a backend id other than pi fails the load, naming the edit", () => {
  // The retired spelling doubled a backend id as the provider namespace. Since the
  // Backend/model split, configForRole still resolves such a section to pi and hands the
  // bare provider name to pi, which has no such provider — so the pair must fail the load
  // with the same edit the step check names (write the backend beside the model, drop the
  // provider).
  assert.match(
    validationError({ provider: "claude", model: "claude-opus-5-5" }),
    /provider "claude" is the retired backend namespace but this section runs on pi — write backend: "claude" beside the model and drop the provider/,
  );
  assert.match(
    validationError({ provider: "opencode", model: "deepseek-free" }),
    /provider "opencode" is the retired backend namespace/,
  );
  // Roles and review inherit the top-level provider and apply their own.
  assert.match(
    validationError({ provider: "claude", roles: { feature: { model: "claude-opus-5-5" } } }),
    /roles\.feature\.provider "claude" is the retired backend namespace/,
  );
  assert.match(
    validationError({ provider: "claude", review: { model: "claude-opus-5-5" } }),
    /review\.provider "claude" is the retired backend namespace/,
  );
  // An explicit pi backend does not dodge it; a non-backend provider name stays legal, and
  // a backend that carries its own provider namespace (claude beside provider claude)
  // still loads.
  assert.match(
    validationError({ provider: "claude", backend: "pi", model: "claude-opus-5-5" }),
    /provider "claude" is the retired backend namespace/,
  );
  assert.doesNotThrow(() => validateConfig({ provider: "huggingface", model: "omlx/local-free" }));
  assert.doesNotThrow(() => validateConfig({ backend: "claude", model: "claude-opus-5-5" }));
});

test("fallbackModel's legacy provider is checked too (it is a legacy provider-bearing section)", () => {
  // legacyFallbackPair forces a fallbackModel that names its own provider onto backend pi, so
  // a provider that is a backend id there is the same silent-pi-pair flaw and must be rejected.
  assert.match(
    validationError({ fallbackModel: { provider: "claude", model: "claude-opus-5-5" } }),
    /fallbackModel\.provider "claude" is the retired backend namespace/,
  );
  assert.doesNotThrow(() => validateConfig({ fallbackModel: { provider: "huggingface", model: "omlx/local-free" } }));
  assert.doesNotThrow(() => validateConfig({ fallbackModel: { model: "claude-opus-5-5" } }));
});
