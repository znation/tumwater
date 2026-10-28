import test from "node:test";
import assert from "node:assert/strict";
import { formatModelSelector, parseModelSelector, routeModel } from "../src/config/config-model-selector.js";

// parseModelSelector / formatModelSelector (plans/model-tiers.md "Selectors"): the
// provider/id[:thinking] strings `model` and `fallback` accept, and their round-trip.

test("a trailing :x is thinking only when x is a real thinking level", () => {
  assert.deepEqual(parseModelSelector("huggingface/zai-org/GLM-5.3-Flash:together:low"), {
    provider: "huggingface",
    model: "zai-org/GLM-5.3-Flash:together",
    thinking: "low",
  });
  // A non-level suffix stays on the id: the HF router's provider pin.
  assert.deepEqual(parseModelSelector("huggingface/zai-org/GLM-5.3-Flash:together"), {
    provider: "huggingface",
    model: "zai-org/GLM-5.3-Flash:together",
  });
});

test("the provider is the text before the first /, the id is the rest", () => {
  assert.deepEqual(parseModelSelector("omlx/Qwen3.8-27B-MLX-oQ4e-mtp"), {
    provider: "omlx",
    model: "Qwen3.8-27B-MLX-oQ4e-mtp",
  });
  // Ids contain slashes themselves (org/repo names).
  assert.deepEqual(parseModelSelector("a/b/c"), { provider: "a", model: "b/c" });
});

test("a selector with no / is a bare pattern with no provider", () => {
  assert.deepEqual(parseModelSelector("GLM-5.3-Flash"), { model: "GLM-5.3-Flash" });
  assert.deepEqual(parseModelSelector("GLM-5.3-Flash:high"), {
    model: "GLM-5.3-Flash",
    thinking: "high",
  });
});

test("a legacy provider makes the whole string a bare id under it", () => {
  assert.deepEqual(parseModelSelector("zai-org/GLM-5.3-Flash:together", "huggingface"), {
    provider: "huggingface",
    model: "zai-org/GLM-5.3-Flash:together",
  });
  assert.deepEqual(parseModelSelector("top-model", "top-provider"), {
    provider: "top-provider",
    model: "top-model",
  });
});

test("formatModelSelector is parseModelSelector's inverse", () => {
  for (const s of [
    "huggingface/zai-org/GLM-5.3-Flash:together:low",
    "omlx/Qwen3.8-27B-MLX-oQ4e-mtp",
    "GLM-5.3-Flash",
    "GLM-5.3-Flash:high",
    "a/b/c",
  ]) {
    const sel = parseModelSelector(s);
    assert.equal(s, formatModelSelector(sel));
  }
});

// routeModel's backend rule: the backend is the explicit one, else the config's, else pi — a model
// id never names it. claude and opencode take the id verbatim.
test("routeModel resolves the backend from the keys, never from the model id", () => {
  assert.deepEqual(routeModel(undefined, "deepseek-v4.1-flash-free", "opencode", "default"), {
    agent: "opencode",
    model: "deepseek-v4.1-flash-free",
  });
  // A second slash under backend opencode stays in the id, whole.
  assert.deepEqual(routeModel("anthropic", "claude-sonnet-5-5", "opencode", "default"), {
    agent: "opencode",
    model: "anthropic/claude-sonnet-5-5",
  });
  assert.deepEqual(parseModelSelector("opencode/deepseek-v4.1-flash-free:low"), {
    provider: "opencode",
    model: "deepseek-v4.1-flash-free",
    thinking: "low",
  });
  // A provider named like a backend is just a pi provider now.
  assert.deepEqual(routeModel("opencode-go", "deepseek-v4.1-flash", "pi", "default"), {
    agent: "pi",
    model: "deepseek-v4.1-flash",
  });
  assert.deepEqual(routeModel("claude", "x", "pi", "default"), { agent: "pi", model: "x" });
  // A bare claude-… id stays on the configured backend (it takes no shortcut to claude).
  assert.deepEqual(routeModel(undefined, "claude-opus-5-5", "opencode", "strong"), {
    agent: "opencode",
    model: "claude-opus-5-5",
  });
  assert.deepEqual(routeModel(undefined, "claude-opus-5-5", "pi", "strong"), {
    agent: "pi",
    model: "claude-opus-5-5",
  });
  // An explicit backend outranks the config's.
  assert.deepEqual(routeModel(undefined, "claude-opus-5-5", "pi", "strong", "claude"), {
    agent: "claude",
    model: "claude-opus-5-5",
  });
  // opencode declares no tier defaults, so a no-model opencode job resolves no model.
  assert.deepEqual(routeModel(undefined, undefined, "opencode", "default"), { agent: "opencode" });
  assert.deepEqual(routeModel(undefined, undefined, "opencode", "strong"), { agent: "opencode" });
  // codex (part 4/9): takes the model id as written — no `codex/` namespace is prepended even
  // when a provider is present — and resolves its tier defaults (gpt-6.1-sol / gpt-6-luna /
  // gpt-6-luna) when no model survives.
  assert.deepEqual(routeModel(undefined, "gpt-6.1-sol", "codex", "default"), {
    agent: "codex",
    model: "gpt-6.1-sol",
  });
  assert.deepEqual(routeModel("whatever", "gpt-6.1-sol", "codex", "default"), {
    agent: "codex",
    model: "gpt-6.1-sol",
  });
  assert.deepEqual(routeModel(undefined, undefined, "codex", "strong"), {
    agent: "codex",
    model: "gpt-6.1-sol",
  });
  assert.deepEqual(routeModel(undefined, undefined, "codex", "default"), {
    agent: "codex",
    model: "gpt-6-luna",
  });
  assert.deepEqual(routeModel(undefined, undefined, "codex", "small"), {
    agent: "codex",
    model: "gpt-6-luna",
  });
});
