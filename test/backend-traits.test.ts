// The per-backend capabilities (plans/opencode-backend.md "Groundwork: the claude-only branches
// become backend traits"): the config, prompt, watchdog, progress and doctor layers read these
// instead of testing a backend id by its literal. pi streams tool output, resolves its model
// jobs through pi's models.json, and labels a pair `provider/model`; claude does none of that
// and labels its bare model. An id with no entry reads as pi, because run-agent.ts routes an
// unregistered id to the pi backend.
import test from "node:test";
import assert from "node:assert/strict";
import {
  backendDefaultLabel,
  modelLabel,
  reservedPassthroughFlag,
  streamsToolOutput,
  usesPiModels,
} from "../src/agent/backend-traits.js";

test("pi streams tool output, uses pi's models and labels provider/model", () => {
  assert.equal(streamsToolOutput("pi"), true);
  assert.equal(usesPiModels("pi"), true);
  assert.equal(modelLabel("pi", "openrouter", "deepseek-chat"), "openrouter/deepseek-chat");
  assert.equal(modelLabel("pi", undefined, undefined), "?/?");
});

test("claude, opencode and codex stream no tool output and use no pi models", () => {
  assert.equal(streamsToolOutput("claude"), false);
  assert.equal(usesPiModels("claude"), false);
  assert.equal(modelLabel("claude", "claude", "claude-sonnet-5-5"), "claude-sonnet-5-5");
  assert.equal(modelLabel("claude", "claude", undefined), "claude backend");
  // opencode (part 2/7): streams no tool output, resolves no pi models, and labels every id
  // under its `opencode/` namespace.
  assert.equal(streamsToolOutput("opencode"), false);
  assert.equal(usesPiModels("opencode"), false);
  assert.equal(modelLabel("opencode", "opencode", "deepseek-v4.1-flash-free"), "opencode/deepseek-v4.1-flash-free");
  assert.equal(modelLabel("opencode", undefined, undefined), "opencode/?");
  // codex (part 4/9): streams no tool output, resolves no pi models, and labels the bare model
  // or "codex default".
  assert.equal(streamsToolOutput("codex"), false);
  assert.equal(usesPiModels("codex"), false);
  assert.equal(modelLabel("codex", undefined, "gpt-6.1-sol"), "gpt-6.1-sol");
  assert.equal(modelLabel("codex", undefined, undefined), "codex default");
});

test("an id with no entry reads as pi (undefined and unknown both become pi traits)", () => {
  assert.equal(streamsToolOutput(undefined), true);
  assert.equal(usesPiModels(undefined), true);
  assert.equal(modelLabel(undefined, "x", "y"), "x/y");
  assert.equal(streamsToolOutput("other"), true, "an unregistered id routes to pi at run time");
  assert.equal(usesPiModels("other"), true);
  assert.equal(modelLabel("other", "x", "y"), "x/y");
});

test("reservedPassthroughFlag keeps each backend's validation reason", () => {
  // pi's reserved set carries a reason string naming the fix.
  assert.equal(reservedPassthroughFlag("pi", "--mode"), "tumwater requires pi's json output mode");
  assert.equal(reservedPassthroughFlag("pi", "--name"), "tumwater names the session");
  assert.equal(reservedPassthroughFlag("pi", "--no-skills"), undefined, "an unreserved pi flag is free");
  // claude's reserved set reads "it is managed by tumwater".
  assert.equal(reservedPassthroughFlag("claude", "--model"), "it is managed by tumwater");
  assert.equal(reservedPassthroughFlag("claude", "--print"), "it is managed by tumwater");
  assert.equal(reservedPassthroughFlag("claude", "--debug"), undefined, "an unreserved claude flag is free");
  // opencode's reserved set reads "it is managed by tumwater", like claude's.
  assert.equal(reservedPassthroughFlag("opencode", "--model"), "it is managed by tumwater");
  assert.equal(reservedPassthroughFlag("opencode", "-m"), "it is managed by tumwater");
  assert.equal(reservedPassthroughFlag("opencode", "--title"), "it is managed by tumwater");
  assert.equal(reservedPassthroughFlag("opencode", "--print-logs"), undefined, "an unreserved opencode flag is free");
  // codex's reserved set reads "it is managed by tumwater" too; the `-c` config-key screen is
  // arity-aware and lives in config-validation against HARNESS_CODEX_CONFIG_KEYS.
  assert.equal(reservedPassthroughFlag("codex", "--sandbox"), "it is managed by tumwater");
  assert.equal(reservedPassthroughFlag("codex", "--json"), "it is managed by tumwater");
  assert.equal(reservedPassthroughFlag("codex", "--strict-config"), undefined, "an unreserved codex flag is free");
});

test("backendDefaultLabel names pi and non-pi seams", () => {
  // pi (and an unknown/undefined id, which reads as pi) carries the historical `pi default`;
  // claude, opencode and codex carry their own backend's label.
  assert.equal(backendDefaultLabel("pi"), "pi default");
  assert.equal(backendDefaultLabel(undefined), "pi default");
  assert.equal(backendDefaultLabel("unregistered"), "pi default", "an unknown id reads as pi");
  assert.equal(backendDefaultLabel("claude"), "claude default");
  assert.equal(backendDefaultLabel("opencode"), "opencode default");
  assert.equal(backendDefaultLabel("codex"), "codex default");
});
