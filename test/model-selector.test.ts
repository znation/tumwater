import test from "node:test";
import assert from "node:assert/strict";
import { formatModelSelector, parseModelSelector, routeModel } from "../src/config/model-selector.js";

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

// routeModel's opencode routing (plans/opencode-backend.md "Config and routing", part 2/7):
// once `opencode` is a registered agent id, the existing rule — a provider naming an agent
// routes to that agent — covers it with no code change; these pin that routing.
test("routeModel routes opencode/<model> ids to the opencode backend", () => {
  // Everything after `opencode/` is the model: one slash is OpenCode's own gateway.
  assert.deepEqual(routeModel("opencode", "deepseek-v4.1-flash-free", "pi", "default"), {
    agent: "opencode",
    model: "deepseek-v4.1-flash-free",
  });
  // With a second slash the rest is another provider OpenCode knows; the model id keeps it.
  assert.deepEqual(routeModel("opencode", "anthropic/claude-sonnet-5-5", "pi", "default"), {
    agent: "opencode",
    model: "anthropic/claude-sonnet-5-5",
  });
  // A bare id under backend: "opencode" routes to opencode (parseModelSelector strips the
  // `:low` thinking suffix before routeModel sees the model).
  assert.deepEqual(parseModelSelector("opencode/deepseek-v4.1-flash-free:low"), {
    provider: "opencode",
    model: "deepseek-v4.1-flash-free",
    thinking: "low",
  });
  assert.deepEqual(routeModel(undefined, "deepseek-v4.1-flash-free", "opencode", "default"), {
    agent: "opencode",
    model: "deepseek-v4.1-flash-free",
  });
  // pi's own opencode-go provider is untouched: not an agent id, so it stays on pi.
  assert.deepEqual(routeModel("opencode-go", "deepseek-v4.1-flash", "pi", "default"), {
    agent: "pi",
    model: "deepseek-v4.1-flash",
  });
  // A bare claude-… id still routes to claude whatever the config backend says (rule 3a).
  assert.deepEqual(routeModel(undefined, "claude-opus-5-5", "opencode", "strong"), {
    agent: "claude",
    model: "claude-opus-5-5",
  });
  // opencode declares no tier defaults, so a no-model opencode job resolves no model.
  assert.deepEqual(routeModel(undefined, undefined, "opencode", "default"), { agent: "opencode" });
  assert.deepEqual(routeModel(undefined, undefined, "opencode", "strong"), { agent: "opencode" });
});
