// The codex argv builder (plans/codex-backend.md "The invocation" §3, findings 6–8, 20; PLANS.md
// "Codex backend, part 5/9"): the design's flag order and set, fresh vs resumed, effort
// validation, and the reserved-flag rejection — all without a spawned process.
import test from "node:test";
import assert from "node:assert/strict";
import { codexArgs, codexEffort, type CodexArgOptions } from "../src/agent/codex/codex-args.js";

function opts(overrides: Partial<CodexArgOptions> = {}): CodexArgOptions {
  return { model: "gpt-6.1-sol", prompt: "do it", ...overrides };
}

test("codexArgs builds the fresh run's argv in the design's order and pairs the prompt with stdin", () => {
  const { args, stdin } = codexArgs(opts({ effort: "high", args: ["--unsafe-custom", "x"] }));
  assert.deepEqual(args, [
    "exec",
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "--ignore-user-config",
    "--ignore-rules",
    "--disable",
    "plugins",
    "--disable",
    "apps",
    "--disable",
    "goals",
    "--disable",
    "image_generation",
    "--disable",
    "browser_use",
    "--disable",
    "computer_use",
    "--disable",
    "tool_suggest",
    "--disable",
    "skill_search",
    "-c",
    "agents.enabled=false",
    "-c",
    'web_search="disabled"',
    "-c",
    "check_for_update_on_startup=false",
    "-c",
    "analytics.enabled=false",
    "-c",
    "feedback.enabled=false",
    "-c",
    'history.persistence="none"',
    "-c",
    'project_doc_fallback_filenames=["CLAUDE.md"]',
    "-m",
    "gpt-6.1-sol",
    "-c",
    "model_reasoning_effort=high",
    "--unsafe-custom",
    "x",
    "-",
  ]);
  assert.equal(stdin, "do it");
  assert.ok(!args.includes("do it"), "the prompt is not an argv element");
  assert.equal(args[args.length - 1], "-", "the closing `-` reads the prompt from stdin");
});

test("codexArgs resumes by id and still carries -m", () => {
  const { args } = codexArgs(opts({ resumeId: "7f3a-11" }));
  assert.equal(args[0], "exec");
  assert.equal(args[1], "resume");
  assert.equal(args[2], "7f3a-11");
  assert.deepEqual(args.slice(args.indexOf("-m"), args.indexOf("-m") + 2), ["-m", "gpt-6.1-sol"]);
  assert.ok(!args.includes("--sandbox"), "a resume carries no sandbox flag");
  assert.equal(args[args.length - 1], "-");
});

test("codexArgs omits the effort flag when effort is unset", () => {
  const { args } = codexArgs(opts());
  assert.ok(!args.includes("model_reasoning_effort"));
});

test("codexArgs rejects an unknown effort", () => {
  assert.throws(() => codexArgs(opts({ effort: "ultra" })), /unknown effort "ultra"/);
  assert.throws(() => codexArgs(opts({ effort: "galaxy-brain" })), /unknown effort/);
});

test("codexArgs rejects a passthrough arg that repeats a flag tumwater sets", () => {
  // The message names the reserved flag it collided with and the fix, so a `--flag=value`
  // spelling still says which harness-set flag to drop.
  assert.throws(
    () => codexArgs(opts({ args: ["--sandbox"] })),
    /repeats a flag tumwater sets \(--sandbox is reserved\) — drop it/,
  );
  assert.throws(() => codexArgs(opts({ args: ["-m", "other-model"] })), /repeats a flag tumwater sets/);
  assert.throws(() => codexArgs(opts({ args: ["--dangerously-bypass-approvals-and-sandbox"] })), /repeats a flag tumwater sets/);
});

test("codexEffort maps thinking through EFFORT_BY_THINKING, gated by the model's levels", () => {
  assert.equal(codexEffort("minimal", ["low", "medium"]), "low");
  assert.equal(codexEffort("max", ["low", "medium", "high"]), undefined);
  assert.equal(codexEffort("high", undefined), "high");
  assert.equal(codexEffort("off", ["low", "high"]), "low");
  // A level the catalog does not support clamps to no effort; an unknown thinking level too.
  assert.equal(codexEffort("medium", ["low", "xhigh"]), undefined);
  assert.equal(codexEffort("galaxy-brain", ["low", "medium", "high", "xhigh", "max"]), undefined);
});
