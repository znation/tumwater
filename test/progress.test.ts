import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describeToolCall, parseProgress, readCompleteLines, readLiveProgress } from "../src/progress.js";
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

test("readLiveProgress accumulates appended lines across polls", () => {
  const root = tmpdir();
  const file = piLogPath(root, "clean");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, SESSION + "\n");
  assert.equal(readLiveProgress(root, "clean")?.turns, 0);
  fs.appendFileSync(file, assistantLine("one", { tokens: 100 }) + "\n");
  assert.equal(readLiveProgress(root, "clean")?.turns, 1);
  fs.appendFileSync(file, toolStart("bash", { command: "npm test" }) + "\n");
  const p = readLiveProgress(root, "clean");
  assert.equal(p?.toolCalls, 1);
  assert.equal(p?.lastTool, "bash npm test");
});

test("readLiveProgress does not count a torn trailing line until it is complete", () => {
  const root = tmpdir();
  const file = piLogPath(root, "clean");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, SESSION + "\n");
  fs.appendFileSync(file, '{"type":"message_end","mess'); // torn write, no newline
  assert.equal(readLiveProgress(root, "clean")?.turns, 0);
  assert.equal(readLiveProgress(root, "clean")?.turns, 0); // still incomplete: not counted twice or lost
  fs.appendFileSync(file, 'age":{"role":"assistant","usage":{"totalTokens":42}}}' + "\n");
  const p = readLiveProgress(root, "clean");
  assert.equal(p?.turns, 1);
  assert.equal(p?.contextTokens, 42);
});

test("readCompleteLines returns only complete lines and stops at the last newline", () => {
  const file = path.join(tmpdir(), "log.jsonl");
  fs.writeFileSync(file, 'a\n{"torn":"mes'); // trailing partial line (no newline)
  let r = readCompleteLines(file, 0, fs.statSync(file).size);
  assert.deepEqual(r.lines.filter(Boolean), ["a"]);
  assert.equal(r.end, 2); // just past the first \n; the torn tail is not consumed

  fs.appendFileSync(file, 'sage"}\n');
  r = readCompleteLines(file, r.end, fs.statSync(file).size);
  assert.deepEqual(r.lines.filter(Boolean), ['{"torn":"message"}']); // re-read once complete

  // No growth and no newline yet: nothing consumed.
  const empty = path.join(tmpdir(), "empty.jsonl");
  fs.writeFileSync(empty, "abc");
  assert.deepEqual(readCompleteLines(empty, 0, 3), { lines: [], end: 0 });
});

test("readLiveProgress reseeds when the log is rotated (renamed) mid-observation", () => {
  const root = tmpdir();
  const file = piLogPath(root, "clean");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, SESSION + "\n" + assistantLine("old tick", { tokens: 999 }) + "\n");
  assert.equal(readLiveProgress(root, "clean")?.turns, 1);
  // rotateIfLarge renames the log and a fresh file starts for the next run.
  fs.renameSync(file, file + ".1");
  fs.writeFileSync(file, SESSION + "\n" + assistantLine("new tick", { tokens: 7 }) + "\n");
  const p = readLiveProgress(root, "clean");
  assert.equal(p?.turns, 1);
  assert.equal(p?.contextTokens, 7);
});
