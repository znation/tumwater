import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { clipToWidth, loopPhase, renderStatus, workingDetail } from "../src/status-render.js";
import type { StatusSnapshot } from "../src/status.js";
import { freshLoopState } from "../src/state.js";
import { piLogPath } from "../src/paths.js";
import { assistantLine, tmpdir } from "./util.js";

const SESSION = JSON.stringify({ type: "session", version: 3, id: "x" });

/** Write a raw pi log for `role` under `root`; returns the file path. */
function writePiLog(root: string, role: string, lines: string[]): string {
  const file = piLogPath(root, role);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

function snapshotWith(loops: Array<Partial<ReturnType<typeof freshLoopState>> & { role: string }>): StatusSnapshot {
  return {
    running: false,
    inbox: 0,
    loops: loops.map((partial) => ({ ...freshLoopState(partial.role), ...partial })),
  };
}

test("status table ends with a totals row summing tokens and cost", () => {
  const snap = snapshotWith([
    { role: "clean", generatedTokens: 900_000, peakContextTokens: 120_000, totalCostUsd: 1.25 },
    { role: "dry", generatedTokens: 350_000, peakContextTokens: 80_000, totalCostUsd: 0.5 },
  ]);
  const lines = renderStatus(tmpdir(), snap).split("\n");
  const totals = lines[lines.length - 1] ?? "";
  const separator = lines[lines.length - 2] ?? "";
  assert.match(totals, /^total\b/);
  assert.match(totals, /1250\.0k/, "generated sum is compact-formatted");
  assert.match(totals, /120\.0k/, "peak ctx totals cell is the max across loops");
  assert.match(totals, /\$1\.75/);
  assert.match(separator, /^-+( +-+)+\s*$/, "totals row sits below a separator");
});

test("totals row shows zeros without breaking alignment", () => {
  const snap = snapshotWith([{ role: "clean" }, { role: "dry" }]);
  const lines = renderStatus(tmpdir(), snap).split("\n");
  const totals = lines[lines.length - 1] ?? "";
  assert.match(totals, /^total\b/);
  assert.match(totals, /\b0\b/);
  assert.match(totals, /\$0\.00/);
});

test("renderStatus with maxWidth clips every line and truncates wide cells", () => {
  const snap = snapshotWith([
    {
      role: "improve",
      lastResult: "changed",
      lastSummary: "an extremely long tick summary that would normally blow the table out past eighty columns easily",
      ticks: 3,
      commits: 1,
    },
    { role: "clean" },
  ]);
  const capped = renderStatus(tmpdir(), snap, 80);
  for (const line of capped.split("\n")) {
    assert.ok(line.length <= 80, `line exceeds 80 cols: ${JSON.stringify(line)} (${line.length})`);
  }
  assert.match(capped, /…/, "over-wide cells are ellipsis-truncated");
  // Uncapped output keeps the full summary.
  assert.match(renderStatus(tmpdir(), snap), /eighty columns easily/);
});

test("narrow terminals never receive a wrapping line even below column minimums", () => {
  const snap = snapshotWith([
    { role: "organize", lastResult: "changed", lastSummary: "x".repeat(120), ticks: 12, commits: 9 },
  ]);
  for (const width of [40, 60]) {
    for (const line of renderStatus(tmpdir(), snap, width).split("\n")) {
      assert.ok(line.length <= width, `width ${width} violated: ${line.length}`);
    }
  }
});

test("gen/peak ctx combine persisted totals with live in-tick progress for running loops only", () => {
  const root = tmpdir();
  // In-flight tick: this run's session plus two completed turns (800 output, peak 12k).
  writePiLog(root, "clean", [
    SESSION,
    assistantLine("turn one", { tokens: 8_000, output: 300 }),
    assistantLine("turn two", { tokens: 12_000, output: 500 }),
  ]);
  // Idle loop whose log tail is its last COMPLETED tick (already in the persisted totals).
  writePiLog(root, "dry", [SESSION, assistantLine("done tick", { tokens: 5_000, output: 500 })]);
  const snap = snapshotWith([
    { role: "clean", generatedTokens: 1_000, peakContextTokens: 6_000, running: true },
    { role: "dry", generatedTokens: 2_000, peakContextTokens: 4_000 },
  ]);
  const out = renderStatus(root, snap);
  const cleanRow = out.split("\n").find((l) => l.startsWith("clean")) ?? "";
  assert.match(cleanRow, /\b1800\b/, "running loop gen = persisted + live output (1000+300+500)");
  assert.match(cleanRow, /12\.0k/, "running loop peak ctx = max(persisted, live) = 12000");
  const dryRow = out.split("\n").find((l) => l.startsWith("dry")) ?? "";
  assert.match(dryRow, /\b2000\b/, "idle loop gen stays persisted — its log tail is not double-counted");
  assert.match(dryRow, /\b4000\b/);
  const totals = out.split("\n").at(-1) ?? "";
  assert.match(totals, /\b3800\b/, "totals row sums the displayed (combined) values");
});

test("clipToWidth never exceeds the requested width, even at degenerate widths", () => {
  const text = "a much longer line than any of these widths";
  assert.equal(clipToWidth(text, 100), text, "shorter-than-width text is untouched");
  assert.equal(clipToWidth("abcd", 4), "abcd", "exact-fit text is untouched");
  for (const width of [0, 1, 2, 5, 80]) {
    const clipped = clipToWidth(text, width);
    assert.ok(clipped.length <= width, `width ${width} violated: ${clipped.length}`);
  }
  assert.match(clipToWidth(text, 5), /…$/, "over-wide text ends in an ellipsis");
});

// Working detail: the live per-loop state cell (workingDetail) and its use by loopPhase.

function toolStart(toolName: string, args: unknown): string {
  return JSON.stringify({ type: "tool_execution_start", toolCallId: "c1", toolName, args });
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

// Current work item in the table's state cell (renderStatus row level).

test("renderStatus prepends the current work item to a working loop's state cell", () => {
  const root = tmpdir();
  writePiLog(root, "feature", [
    SESSION,
    assistantLine('implement plan "Linear history on main"'),
    toolStart("bash", { command: "npm test" }),
  ]);
  // Orchestrator running (snap.running) so the in-flight tick renders as working.
  const snap = { ...snapshotWith([{ role: "feature", running: true, lastTickStartedAt: Date.now() - 5_000 }]), running: true };
  const out = renderStatus(root, snap);
  assert.match(out, /implement plan "Linear history on main" · working \ds · turn 2/);
});

test("renderStatus does not leak a finished tick's work item into an idle loop's state cell", () => {
  const root = tmpdir();
  writePiLog(root, "feature", [SESSION, assistantLine("old finished work")]);
  // Orchestrator running but the loop itself is idle (queued/sleeping).
  const snap = { ...snapshotWith([{ role: "feature" }]), running: true };
  const out = renderStatus(root, snap);
  assert.doesNotMatch(out, /old finished work/);
});

test("renderStatus leaves the state cell unchanged while working but before any text", () => {
  const root = tmpdir();
  writePiLog(root, "feature", [SESSION, toolStart("bash", { command: "npm test" })]); // no assistant text yet
  const snap = { ...snapshotWith([{ role: "feature", running: true, lastTickStartedAt: Date.now() - 5_000 }]), running: true };
  assert.match(renderStatus(root, snap), /working \ds · turn 1/);
});

test("work items survive narrow-terminal clipping at the head of the state cell", () => {
  const root = tmpdir();
  writePiLog(
    root,
    "feature",
    [SESSION, assistantLine(`implement plan "${"x".repeat(50)}"`), toolStart("bash", { command: "npm test" })],
  );
  const snap = { ...snapshotWith([{ role: "feature", running: true, lastTickStartedAt: Date.now() - 5_000 }]), running: true };
  for (const width of [80, 60]) {
    for (const line of renderStatus(root, snap, width).split("\n")) {
      assert.ok(line.length <= width, `width ${width} violated: ${line.length}`);
    }
  }
  // The item is prepended, so its head survives even when the cell shrinks to its minimum
  // and gets clipped hard (an appended item would be invisible at this width).
  const narrow = renderStatus(root, snap, 60).split("\n").find((l) => l.startsWith("feature")) ?? "";
  assert.match(narrow, /^feature\s+implement p…/);
});
