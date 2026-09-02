import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseProgress, readLiveProgress } from "../src/progress.js";
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

test("parseProgress accumulates output tokens and peak context for the current run", () => {
  const lines = [
    SESSION,
    assistantLine("first turn", { tokens: 10_000, output: 250 }),
    toolStart("bash", { command: "npm test" }),
    assistantLine("second turn", { tokens: 4_000, output: 750 }),
  ];
  const p = parseProgress(lines, 0);
  assert.equal(p.outputTokens, 1000, "output sums across turns");
  assert.equal(
    p.peakContextTokens,
    10_000,
    "peak is the largest request context of the run — not a sum and not the last value",
  );
});

test("parseProgress resets output/peak at a new session", () => {
  const lines = [
    SESSION,
    assistantLine("old tick", { tokens: 99_000, output: 5_000 }),
    SESSION,
    assistantLine("new tick", { tokens: 1_000, output: 42 }),
  ];
  const p = parseProgress(lines, 0);
  assert.equal(p.outputTokens, 42);
  assert.equal(p.peakContextTokens, 1_000);
});

test("parseProgress survives noise and blank lines", () => {
  const p = parseProgress([SESSION, "", "not json", assistantLine("hi", { tokens: 10 })], 0);
  assert.equal(p.turns, 1);
});

// Current work item: the first assistant text of the run ("I'll implement plan X").

test("parseProgress captures the first assistant text as the current work item", () => {
  const lines = [
    SESSION,
    JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] } }),
    toolStart("read", { path: "PLANS.md" }),
    assistantLine('I\'ll implement plan "Linear history on main"'),
    assistantLine("a later message must not replace it"),
  ];
  const p = parseProgress(lines, 0);
  assert.equal(p.currentWork, 'I\'ll implement plan "Linear history on main"');
});

test("parseProgress resets the work item at a new session", () => {
  const lines = [
    SESSION,
    assistantLine("old tick's work item"),
    SESSION,
    toolStart("bash", { command: "npm test" }), // no text yet in the new run
  ];
  assert.equal(parseProgress(lines, 0).currentWork, undefined);
});

test("parseProgress collapses whitespace and truncates long work items with an ellipsis", () => {
  const spaced = parseProgress([SESSION, assistantLine("  fix   the\n\tzombie streams  ")], 0);
  assert.equal(spaced.currentWork, "fix the zombie streams");

  const p = parseProgress([SESSION, assistantLine("a".repeat(80))], 0);
  assert.ok(p.currentWork && p.currentWork.length <= 60, `too long: ${p.currentWork?.length}`);
  assert.match(p.currentWork ?? "", /…$/);
});

test("parseProgress leaves the work item unset for thinking/tool-call-only runs", () => {
  const lines = [
    SESSION,
    JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "planning" }], usage: {} } }),
    toolStart("bash", { command: "npm test" }),
  ];
  assert.equal(parseProgress(lines, 0).currentWork, undefined);
});

test("parseProgress skips empty text blocks when capturing the work item", () => {
  const lines = [
    SESSION,
    JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "   " }, { type: "thinking", thinking: "x" }] } }),
    assistantLine("the real item"),
  ];
  assert.equal(parseProgress(lines, 0).currentWork, "the real item");
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

test("parseProgress ignores streaming deltas and other event types (fast-path equivalence)", () => {
  // message_update lines are ~97% of pi's log; the type-first pre-filter skips parsing them
  // entirely. Behavior must be identical to parsing-and-discarding: no turns, tools, or work.
  const delta = JSON.stringify({
    type: "message_update",
    message: { content: [{ type: "text", text: "x".repeat(10_000) }], usage: { totalTokens: 999_999 } },
  });
  const p = parseProgress([SESSION, delta, JSON.stringify({ type: "agent_start" }), assistantLine("done", { tokens: 5 })], 0);
  assert.equal(p.turns, 1);
  assert.equal(p.toolCalls, 0);
  assert.equal(p.contextTokens, 5);
  assert.equal(p.currentWork, "done");
});

test("parseProgress still parses non-compact JSON shapes (fast-path fallback)", () => {
  // The fast path only skips lines matching pi's exact compact `type`-first prefix; anything
  // else — reordered keys, whitespace after the colon, foreign or torn JSON — must fall back
  // to a full parse and count exactly as before. Pin that safe-degradation contract so a
  // future change cannot silently drop events whose serialization differs from pi's.
  const spaced = parseProgress(
    ['{ "type": "message_end", "message": { "role": "assistant", "content": [{ "type": "text", "text": "hi" }], "usage": { "totalTokens": 7, "output": 2, "cost": { "total": 0 } }, "stopReason": "stop" } }'],
    0,
  ); // spaced JSON still counts (fast path falls back to parse)
  assert.equal(spaced.turns, 1);
  assert.equal(spaced.contextTokens, 7);

  const reordered = parseProgress(
    ['{"message":{"role":"assistant","content":[],"usage":{"totalTokens":9,"output":1,"cost":{"total":0}},"stopReason":"stop"},"type":"message_end"}'],
    0,
  ); // type not first: the prefix check cannot apply, full parse still counts it
  assert.equal(reordered.turns, 1);
  assert.equal(reordered.contextTokens, 9);
});
