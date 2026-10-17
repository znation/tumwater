// The per-backend capabilities (plans/opencode-backend.md "Groundwork: the claude-only branches
// become backend traits"): the config, prompt, watchdog, progress and doctor layers read these
// instead of testing a backend id by its literal. pi streams tool output, resolves its model
// jobs through pi's models.json, and labels a pair `provider/model`; claude does none of that
// and labels its bare model. An id with no entry reads as pi, because run-agent.ts routes an
// unregistered id to the pi backend.
import test from "node:test";
import assert from "node:assert/strict";
import {
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

test("claude streams no tool output, uses no pi models and labels its bare model", () => {
  assert.equal(streamsToolOutput("claude"), false);
  assert.equal(usesPiModels("claude"), false);
  assert.equal(modelLabel("claude", "claude", "claude-sonnet-5-5"), "claude-sonnet-5-5");
  assert.equal(modelLabel("claude", "claude", undefined), "claude backend");
});

test("an id with no entry reads as pi (undefined and unknown both become pi traits)", () => {
  assert.equal(streamsToolOutput(undefined), true);
  assert.equal(usesPiModels(undefined), true);
  assert.equal(modelLabel(undefined, "x", "y"), "x/y");
  assert.equal(streamsToolOutput("opencode"), true, "an unregistered id routes to pi at run time");
  assert.equal(usesPiModels("opencode"), true);
  assert.equal(modelLabel("opencode", "x", "y"), "x/y");
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
  // An unknown backend has no known harness argv, so nothing is reserved.
  assert.equal(reservedPassthroughFlag("opencode", "--model"), undefined);
});
