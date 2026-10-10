// The claude argv builder (plans/agent-backends.md "The claude invocation", PLANS.md "Agent
// backends, part 3b/7"): the design's flag order and set, the session choice, effort clamping,
// the AGENTS.md condition, and the reserved-flag rejection — all without a spawned process.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { claudeArgs, type ClaudeArgOptions } from "../src/agent/claude/claude-args.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

function opts(overrides: Partial<ClaudeArgOptions> = {}): ClaudeArgOptions {
  return { cwd: tmpdir(), model: "claude-sonnet-5-5", sessionId: "sid", prompt: "do it", ...overrides };
}

test("claudeArgs builds the design's argv in order and pairs the prompt with stdin", () => {
  const cwd = tmpdir();
  fs.writeFileSync(path.join(cwd, "AGENTS.md"), "# agents\n");
  const { args, stdin } = claudeArgs({
    cwd,
    model: "claude-sonnet-5-5",
    thinking: "off",
    sessionId: "11111111-1111-4111-8111-111111111111",
    maxBudgetUsd: 3.5,
    mcpConfig: JSON.stringify({ mcpServers: { tumwater: { command: "node", args: ["/x/role-notes-server.js"] } } }),
    args: ["--no-session-persistence"],
    prompt: "do the thing",
  });
  assert.deepEqual(args, [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    "claude-sonnet-5-5",
    "--effort",
    "low",
    "--session-id",
    "11111111-1111-4111-8111-111111111111",
    "--permission-mode",
    "bypassPermissions",
    "--tools",
    "Bash,Read,Edit,Write,Glob,Grep",
    "--setting-sources",
    "project",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{"tumwater":{"command":"node","args":["/x/role-notes-server.js"]}}}',
    "--disable-slash-commands",
    "--exclude-dynamic-system-prompt-sections",
    "--append-system-prompt-file",
    "AGENTS.md",
    "--max-budget-usd",
    "3.5",
    "--no-session-persistence",
  ]);
  assert.equal(stdin, "do the thing");
  assert.ok(!args.includes("do the thing"), "the prompt is not an argv element");
});

test("claudeArgs resumes by id and maps the thinking level 1:1", () => {
  const { args } = claudeArgs(opts({ sessionId: undefined, resumeSessionId: "resume-id", thinking: "max" }));
  assert.deepEqual(args.slice(args.indexOf("--resume"), args.indexOf("--resume") + 2), ["--resume", "resume-id"]);
  assert.ok(!args.includes("--session-id"), "a resume carries no --session-id");
  assert.deepEqual(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2), ["--effort", "max"]);
});

test("claudeArgs omits --effort when thinking is unset", () => {
  assert.ok(!claudeArgs(opts()).args.includes("--effort"));
});

test("claudeArgs appends AGENTS.md only when present and CLAUDE.md is not", () => {
  const hasAgents = tmpdir();
  fs.writeFileSync(path.join(hasAgents, "AGENTS.md"), "# a\n");
  assert.ok(claudeArgs(opts({ cwd: hasAgents })).args.includes("--append-system-prompt-file"));

  const both = tmpdir();
  fs.writeFileSync(path.join(both, "AGENTS.md"), "# a\n");
  fs.writeFileSync(path.join(both, "CLAUDE.md"), "# c\n");
  assert.ok(!claudeArgs(opts({ cwd: both })).args.includes("--append-system-prompt-file"));

  assert.ok(!claudeArgs(opts({ cwd: tmpdir() })).args.includes("--append-system-prompt-file"));
});

test("claudeArgs passes no --mcp-config and no --max-budget-usd by default", () => {
  const { args } = claudeArgs(opts());
  assert.ok(!args.includes("--mcp-config"));
  assert.ok(!args.includes("--max-budget-usd"));
  assert.ok(!claudeArgs(opts({ maxBudgetUsd: 0 })).args.includes("--max-budget-usd"));
});

test("claudeArgs rejects an unusable session choice", () => {
  assert.throws(() => claudeArgs(opts({ sessionId: undefined })), /exactly one of sessionId or resumeSessionId/);
  assert.throws(
    () => claudeArgs(opts({ sessionId: "a", resumeSessionId: "b" })),
    /exactly one of sessionId or resumeSessionId/,
  );
});

test("claudeArgs rejects an unknown thinking level, including Object.prototype keys", () => {
  assert.throws(() => claudeArgs(opts({ thinking: "galaxy-brain" })), /unknown thinking level/);
  for (const inherited of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    assert.throws(() => claudeArgs(opts({ thinking: inherited })), /unknown thinking level/, inherited);
  }
});

test("claudeArgs rejects a passthrough arg that repeats a harness flag", () => {
  assert.throws(() => claudeArgs(opts({ args: ["--model=x"] })), /repeats a harness flag/);
  assert.throws(() => claudeArgs(opts({ args: ["-p"] })), /repeats a harness flag/);
  // Every flag claudeArgs itself emits is reserved, including the ones the builder appends
  // after the model: a passthrough repeating `--append-system-prompt-file` is appended last
  // and claude is last-wins, so it would silently replace the harness's AGENTS.md.
  assert.throws(() => claudeArgs(opts({ args: ["--append-system-prompt-file", "/evil"] })), /repeats a harness flag/);
  assert.throws(() => claudeArgs(opts({ args: ["--exclude-dynamic-system-prompt-sections"] })), /repeats a harness flag/);
});
