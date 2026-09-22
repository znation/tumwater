import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  parseProgress,
  readLiveProgress,
  stalledToolLabel,
  toolCallStallMs,
} from "../src/ui/progress.js";
import { landWorktreePath, piLogPath, worktreePath } from "../src/paths.js";
import { assistantLine, tmpdir } from "./util.js";

function toolStart(toolName: string, args: unknown): string {
  return JSON.stringify({ type: "tool_execution_start", toolCallId: "c1", toolName, args });
}

function toolUpdate(toolCallId: string, partialResult: unknown): string {
  return JSON.stringify({ type: "tool_execution_update", toolCallId, partialResult });
}

/** Wall-clock gap in ms — readLiveProgress stamps activity at Date.now(), so two observations
 * separated by a measurable gap can prove (or disprove) that a line moved the activity clock. */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

// A role's log carries several pi run kinds — the authoring tick's run and the review gate's
// runs (reviewer, conflict resolver) in the role's `_land-<role>` worktree — each with its
// own `session` event (cwd names the worktree). A gate session must reset only the gate's
// counts, never the working tick's (BUGS.md 2026-09-22: a landing's reviewer run reset the
// author's cell to turn 1 mid-tick and its turns/ctx/tool described the wrong run).

test("a lander (gate) session mid-log does not reset the author run's counts", () => {
  const root = tmpdir();
  const file = piLogPath(root, "clean");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const gateSession = JSON.stringify({
    type: "session",
    version: 3,
    id: "g",
    cwd: landWorktreePath(root, "clean"),
  });
  fs.writeFileSync(
    file,
    [
      SESSION,
      assistantLine("author turn one", { tokens: 100 }),
      assistantLine("author turn two", { tokens: 200 }),
      gateSession, // the landing's reviewer run starts mid-tick
      assistantLine("reviewer turn", { tokens: 300 }),
    ].join("\n") + "\n",
  );
  const author = readLiveProgress(root, "clean");
  assert.equal(author?.turns, 2, "the working cell keeps the author run's turns");
  assert.equal(author?.contextTokens, 200);
  const gate = readLiveProgress(root, "clean", "gate");
  assert.equal(gate?.turns, 1, "the reviewing cell reads the reviewer run");
  assert.equal(gate?.contextTokens, 300);
  assert.equal(gate?.currentWork, "reviewer turn");
});

test("the next author session resets only the author accumulator, and gate lines fold into gate", () => {
  const root = tmpdir();
  const file = piLogPath(root, "clean");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const gateSession = JSON.stringify({
    type: "session",
    version: 3,
    id: "g",
    cwd: landWorktreePath(root, "clean"),
  });
  const authorSession = JSON.stringify({
    type: "session",
    version: 3,
    id: "a",
    cwd: worktreePath(root, "clean"),
  });
  fs.writeFileSync(
    file,
    [
      SESSION,
      assistantLine("old tick", { tokens: 999 }),
      gateSession,
      assistantLine("reviewer", { tokens: 50 }),
      authorSession, // the role's next tick starts
      assistantLine("new tick", { tokens: 10 }),
    ].join("\n") + "\n",
  );
  const author = readLiveProgress(root, "clean");
  assert.equal(author?.turns, 1, "the new tick's run starts from zero");
  assert.equal(author?.contextTokens, 10);
  const gate = readLiveProgress(root, "clean", "gate");
  assert.equal(gate?.turns, 1, "the finished reviewer run's counts survive untouched");
  assert.equal(gate?.contextTokens, 50);
});

test("the harness's review label line routes following lines to the gate accumulator", () => {
  const root = tmpdir();
  const file = piLogPath(root, "clean");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    [
      SESSION,
      assistantLine("author", { tokens: 100 }),
      // src/pi.ts writes the harness's label line before the reviewer's session event.
      JSON.stringify({ type: "tumwater_run", label: "review" }),
      assistantLine("reviewer", { tokens: 200 }),
    ].join("\n") + "\n",
  );
  assert.equal(readLiveProgress(root, "clean")?.turns, 1, "the author run keeps its count");
  const gate = readLiveProgress(root, "clean", "gate");
  assert.equal(gate?.turns, 1, "the labeled run's line folded into gate");
  assert.equal(gate?.currentWork, "reviewer");
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

// Open-tool-call tracking feeds the dashboard's stall flag (BUGS.md 2026-09-13 sibling):
// a hung command must be nameable in the state cell while it is still open.

test("parseProgress tracks open tool calls and clears them at end", () => {
  const p = parseProgress([SESSION, toolStart("bash", { command: "find / -name x" })], 0);
  assert.deepEqual(
    p.openToolCalls?.map((c) => [c.id, c.label]),
    [["c1", "bash find / -name x"]],
    "the open call is tracked by id with a label that names the command",
  );
  // A parallel sibling stays tracked when one ends (pi runs calls concurrently by default).
  const both = parseProgress(
    [
      SESSION,
      toolStart("bash", { command: "find / -name x" }),
      JSON.stringify({ type: "tool_execution_start", toolCallId: "c2", toolName: "read", args: { path: "/a/b.ts" } }),
      JSON.stringify({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: {}, isError: false }),
    ],
    0,
  );
  assert.deepEqual(both.openToolCalls?.map((c) => c.id), ["c2"]);
  // A new session restores the at-time-zero state (no calls tracked).
  const reset = parseProgress(
    [
      SESSION,
      toolStart("bash", { command: "find / -name x" }),
      JSON.stringify({ type: "session", version: 3, id: "y" }),
    ],
    0,
  );
  assert.equal(reset.openToolCalls?.length ?? 0, 0);
});

test("a content-bearing tool_execution_update moves the open call's activity clock", async () => {
  // Liveness proof: a streaming command that still prints output must not be flagged stalled,
  // so the feed forwards content-bearing updates to the open call's clock.
  const root = tmpdir();
  const file = piLogPath(root, "clean");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, SESSION + "\n" + toolStart("bash", { command: "npm test" }) + "\n");
  const stamp1 = readLiveProgress(root, "clean")?.openToolCalls?.[0]?.lastActivityAt;
  assert.ok(stamp1 !== undefined, "the bash call is open after start");

  await sleep(10); // measurable gap between the start stamp and the update stamp

  fs.appendFileSync(file, toolUpdate("c1", { content: [{ type: "text", text: "test output" }] }) + "\n");
  const p2 = readLiveProgress(root, "clean");
  const stamp2 = p2?.openToolCalls?.[0]?.lastActivityAt;
  assert.ok(stamp2 !== undefined, "the call is still open after the update");
  assert.ok(stamp2 > stamp1, `content-bearing update must move the clock (${stamp2} vs ${stamp1})`);
});

test("content-free tool_execution_updates leave the activity clock alone (no keepalive masking a hang)", async () => {
  // bash emits one empty-content update right after start; a whitespace-only text block is
  // equally content-free. Neither may move the clock, or a hung command that dribbles
  // keepalives would never go stale. Equality is exact: the untouched entry keeps the start
  // stamp's epoch value through the later read, no wall-clock tolerance needed.
  const root = tmpdir();
  const file = piLogPath(root, "clean");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, SESSION + "\n" + toolStart("bash", { command: "npm test" }) + "\n");
  const stamp1 = readLiveProgress(root, "clean")?.openToolCalls?.[0]?.lastActivityAt;
  assert.ok(stamp1 !== undefined);

  await sleep(10);

  fs.appendFileSync(file, toolUpdate("c1", { content: [] }) + "\n");
  fs.appendFileSync(file, toolUpdate("c1", { content: [{ type: "text", text: "   " }] }) + "\n");
  const p2 = readLiveProgress(root, "clean");
  assert.deepEqual(p2?.openToolCalls?.map((c) => c.id), ["c1"], "the call stays open after keepalives");
  assert.equal(
    p2?.openToolCalls?.[0]?.lastActivityAt,
    stamp1,
    "content-free updates must not move the clock — the hang stays nameable",
  );
});

test("a tool_execution_update before any tool call started is ignored", () => {
  // No start means no open-call list yet; the update must not create one (or crash).
  const p = parseProgress(
    [SESSION, toolUpdate("c1", { content: [{ type: "text", text: "orphan output" }] })],
    0,
  );
  assert.equal(p.openToolCalls, undefined, "an update before start creates no tracked call");
  assert.equal(p.toolCalls, 0);
});

test("a tool_execution_update for an unknown id leaves open calls untouched", async () => {
  // pi runs a message's calls concurrently: a sibling's content-bearing update must not be
  // credited to our call — entries are matched by id, never by position.
  const root = tmpdir();
  const file = piLogPath(root, "clean");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, SESSION + "\n" + toolStart("bash", { command: "npm test" }) + "\n");
  const stamp1 = readLiveProgress(root, "clean")?.openToolCalls?.[0]?.lastActivityAt;
  assert.ok(stamp1 !== undefined);

  await sleep(10);

  fs.appendFileSync(file, toolUpdate("cX", { content: [{ type: "text", text: "sibling output" }] }) + "\n");
  const p2 = readLiveProgress(root, "clean");
  assert.deepEqual(p2?.openToolCalls?.map((c) => c.id), ["c1"], "no call opened for the unknown id");
  assert.equal(
    p2?.openToolCalls?.[0]?.lastActivityAt,
    stamp1,
    "another call's update must not move this call's clock",
  );
});

test("stalledToolLabel names the first call silent past the threshold", () => {
  const now = Date.now();
  assert.equal(stalledToolLabel(undefined), undefined, "no tracked calls — no flag");
  // A fresh call is not stalled (freshly fed lines stamp Date.now()).
  assert.equal(
    stalledToolLabel([{ id: "c1", label: "bash npm test", lastActivityAt: now - 1000 }]),
    undefined,
  );
  // Past the five-minute default it names the call.
  assert.equal(
    stalledToolLabel([{ id: "c1", label: "bash find / -name x", lastActivityAt: now - 301_000 }]),
    "bash find / -name x",
  );
  // With parallel calls, the silent one is named even while a sibling streams.
  assert.equal(
    stalledToolLabel([
      { id: "c1", label: "bash npm test", lastActivityAt: now - 1000 },
      { id: "c2", label: "bash find / -name x", lastActivityAt: now - 301_000 },
    ]),
    "bash find / -name x",
  );
  // A zero threshold disables the flag.
  assert.equal(
    stalledToolLabel([{ id: "c1", label: "x", lastActivityAt: now - 999_999 }], now, 0),
    undefined,
  );
});

test("toolCallStallMs resolves the configured threshold, defaulting to five minutes", () => {
  assert.equal(toolCallStallMs(tmpdir()), 300_000, "no tumwater.json — the documented default");
  const root = tmpdir();
  fs.writeFileSync(path.join(root, "tumwater.json"), JSON.stringify({ toolCallStallSeconds: 5 }));
  assert.equal(toolCallStallMs(root), 5_000);
});
