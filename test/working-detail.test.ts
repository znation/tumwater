import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loopPhase, workingDetail } from "../src/status-render.js";
import { freshLoopState } from "../src/state.js";
import { piLogPath } from "../src/paths.js";
import { assistantLine, tmpdir } from "./util.js";

const SESSION = JSON.stringify({ type: "session", version: 3, id: "x" });

function toolStart(toolName: string, args: unknown): string {
  return JSON.stringify({ type: "tool_execution_start", toolCallId: "c1", toolName, args });
}

/** Write a raw pi log for `role` under `root`. */
function writePiLog(root: string, role: string, lines: string[]): string {
  const file = piLogPath(root, role);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

test("workingDetail without a pi log shows only the elapsed time", () => {
  const root = tmpdir();
  assert.equal(workingDetail(root, freshLoopState("clean")), "working");
  const s = freshLoopState("clean");
  s.lastTickStartedAt = Date.now() - 90_000;
  // ±1s of drift between setting the timestamp and formatting it.
  assert.match(workingDetail(root, s), /^working 1m(29|30|31)s$/);
});

test("workingDetail folds live progress into turn, context, and last tool", () => {
  const root = tmpdir();
  writePiLog(root, "clean", [
    SESSION,
    assistantLine("looking around", { tokens: 4015 }),
    toolStart("read", { path: "/deep/dir/README.md" }),
    assistantLine("now the tests", { tokens: 22_000 }),
    toolStart("bash", { command: "npm test" }),
  ]);
  const s = freshLoopState("clean");
  s.lastTickStartedAt = Date.now() - 5_000;
  const detail = workingDetail(root, s);
  assert.match(detail, /^working \ds · /, `unexpected shape: ${detail}`);
  assert.ok(detail.includes("turn 3"), "two completed turns means the third is in flight");
  assert.ok(detail.includes("ctx 22.0k"), "latest context size compact-formatted");
  assert.ok(detail.endsWith("bash npm test"), "most recent tool call last");
});

test("workingDetail omits the ctx part when no tokens are known yet", () => {
  const root = tmpdir();
  writePiLog(root, "clean", [SESSION, assistantLine("starting")]); // no usage
  assert.doesNotMatch(workingDetail(root, freshLoopState("clean")), /ctx/);
});

test("workingDetail flags a stalled run only after at least five minutes of silence", () => {
  const root = tmpdir();
  const file = writePiLog(root, "clean", [SESSION, assistantLine("hanging", { tokens: 100 })]);
  assert.doesNotMatch(workingDetail(root, freshLoopState("clean")), /no pi output/);
  // Four minutes of silence is still below the five-minute threshold.
  const fourMinAgo = new Date(Date.now() - 4 * 60_000);
  fs.utimesSync(file, fourMinAgo, fourMinAgo);
  assert.doesNotMatch(workingDetail(root, freshLoopState("clean")), /no pi output/);
  // Six minutes of silence crosses it.
  const sixMinAgo = new Date(Date.now() - 6 * 60_000);
  fs.utimesSync(file, sixMinAgo, sixMinAgo);
  assert.match(workingDetail(root, freshLoopState("clean")), /no pi output for 6m/);
});

test("loopPhase surfaces the live detail only while a tick is in flight", () => {
  const root = tmpdir();
  writePiLog(root, "feature", [SESSION, assistantLine("working", { tokens: 3_000 })]);
  const s = freshLoopState("feature");
  assert.equal(loopPhase(s, true), "queued", "idle loop is not working");
  s.running = true;
  s.lastTickStartedAt = Date.now() - 5_000;
  assert.match(loopPhase(s, true, root), /^working \ds · turn 2/);
});

test("loopPhase live detail degrades to plain working when the tick has no start time", () => {
  const root = tmpdir();
  writePiLog(root, "feature", [SESSION, assistantLine("working", { tokens: 3_000 })]);
  const s = freshLoopState("feature");
  s.running = true;
  assert.equal(loopPhase(s, true, root), "working · turn 2 · ctx 3000");
});
