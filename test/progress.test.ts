import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describeToolCall, parseProgress, readLiveProgress } from "../src/progress.js";
import { piLogPath } from "../src/paths.js";
import { assistantLine, tmpdir } from "./util.js";

function toolStart(toolName: string, args: unknown): string {
  return JSON.stringify({ type: "tool_execution_start", toolCallId: "c1", toolName, args });
}

const SESSION = JSON.stringify({ type: "session", version: 3, id: "x" });

test("parseProgress counts turns/tools and tracks the latest context size", () => {
  const lines = [
    SESSION,
    JSON.stringify({ type: "agent_start" }),
    assistantLine("let me look", { tokens: 2201 }),
    toolStart("read", { path: "/deep/dir/README.md" }),
    toolStart("read", { path: "/deep/dir/PLANS.md" }),
    assistantLine("now the tests", { tokens: 4015 }),
    toolStart("bash", { command: "npm test" }),
  ];
  const p = parseProgress(lines, 5000);
  assert.equal(p.turns, 2);
  assert.equal(p.toolCalls, 3);
  assert.equal(p.contextTokens, 4015);
  assert.equal(p.lastTool, "bash npm test");
  assert.equal(p.quietMs, 5000);
});

test("parseProgress resets at a new session (previous tick's events ignored)", () => {
  const lines = [
    SESSION,
    assistantLine("old tick", { tokens: 9999 }),
    toolStart("bash", { command: "old" }),
    SESSION,
    assistantLine("new tick", { tokens: 100 }),
  ];
  const p = parseProgress(lines, 0);
  assert.equal(p.turns, 1);
  assert.equal(p.toolCalls, 0);
  assert.equal(p.contextTokens, 100);
  assert.equal(p.lastTool, undefined);
});

test("parseProgress survives noise and blank lines", () => {
  const p = parseProgress([SESSION, "", "not json", assistantLine("hi", { tokens: 10 })], 0);
  assert.equal(p.turns, 1);
});

test("describeToolCall summarizes common arg shapes tersely", () => {
  assert.equal(describeToolCall("read", { path: "/a/b/loop.ts" }), "read loop.ts");
  assert.equal(describeToolCall("bash", { command: "npm run build" }), "bash npm run build");
  assert.equal(describeToolCall("edit", {}), "edit");
  assert.equal(describeToolCall("bash", { command: "x".repeat(100) }), `bash ${"x".repeat(31)}…`);
  assert.equal(describeToolCall("bash", { command: "a\n  b\tc" }), "bash a b c");
});

test("readLiveProgress reads the loop's raw log and reports quiet time", () => {
  const root = tmpdir();
  const file = piLogPath(root, "clean");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [SESSION, assistantLine("working", { tokens: 500 }), toolStart("read", { path: "x.ts" })].join("\n") + "\n");
  const p = readLiveProgress(root, "clean");
  assert.ok(p);
  assert.equal(p.turns, 1);
  assert.equal(p.lastTool, "read x.ts");
  assert.ok(p.quietMs < 5000);
  assert.equal(readLiveProgress(root, "never-ran"), null);
});
