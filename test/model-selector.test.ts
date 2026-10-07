import test from "node:test";
import assert from "node:assert/strict";
import { formatModelSelector, parseModelSelector } from "../src/config/model-selector.js";

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
