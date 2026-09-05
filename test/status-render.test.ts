import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { clipToWidth, lastTickCell, loopPhase, renderStatus, workingDetail } from "../src/status-render.js";
import type { StatusSnapshot } from "../src/status.js";
import { fleetDailyCost, freshLoopState, todayStamp } from "../src/state.js";
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

function snapshotWith(
  loops: Array<Partial<ReturnType<typeof freshLoopState>> & { role: string }>,
  budget: StatusSnapshot["budget"] = null,
): StatusSnapshot {
  return {
    running: false,
    inbox: 0,
    inboxPrompts: [],
    questions: 0,
    loops: loops.map((partial) => ({ ...freshLoopState(partial.role), ...partial })),
    budget,
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

// The questions badge (plans/questions-outbox.md) rides the header line like the inbox one:
// visible only while something needs an answer, so a quiet project's header stays uncluttered.

test("the status header carries a questions badge only while questions await", () => {
  const zero = renderStatus(tmpdir(), snapshotWith([{ role: "clean" }])).split("\n")[0] ?? "";
  assert.doesNotMatch(zero, /questions/);

  const snap = snapshotWith([{ role: "clean" }]);
  snap.questions = 2;
  const header = renderStatus(tmpdir(), snap).split("\n")[0] ?? "";
  assert.match(header, /· questions: 2$/);
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

test("clipToWidth never splits a surrogate pair (no lone surrogates in clipped lines)", () => {
  // Astral characters (emoji) are two UTF-16 code units; cutting between them would leave a
  // lone high surrogate that terminals render as garbage. The cut backs off and drops the
  // whole character instead, keeping the width invariant.
  const text = "ab🎉cd ef"; // 🎉 occupies code units 2..3
  assert.equal(clipToWidth(text, 4), "ab…"); // cut at 3 would split the pair → back off to 2
  for (const width of [0, 1, 2, 3, 5, 8]) {
    const clipped = clipToWidth(text, width);
    assert.ok(clipped.length <= width, `width ${width} violated: ${clipped.length}`);
    for (let i = 0; i < clipped.length - 1; i++) {
      const code = clipped.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        assert.ok(
          clipped.charCodeAt(i + 1) >= 0xdc00 && clipped.charCodeAt(i + 1) <= 0xdfff,
          `lone surrogate at ${i} in ${JSON.stringify(clipped)}`,
        );
      }
    }
  }
});

// Last tick cell: absolute local time of the last tick end alongside the relative age.

function stampOf(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

test("lastTickCell shows the absolute local time plus relative age", () => {
  const ts = Date.now() - 180_000; // three minutes ago, same day: no date prefix
  assert.equal(lastTickCell(ts), `${stampOf(ts)} · 3m ago`);
});

test("lastTickCell prefixes the date once older than a day", () => {
  const ts = Date.now() - 2 * 86_400_000;
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  assert.equal(lastTickCell(ts), `${p(d.getMonth() + 1)}-${p(d.getDate())} ${stampOf(ts)} · 48h ago`);
});

test("lastTickCell is a bare dash for loops that never ticked", () => {
  assert.equal(lastTickCell(undefined), "-");
});

test("renderStatus shows the absolute last-tick time in the table row", () => {
  const ts = Date.now() - 180_000;
  const snap = snapshotWith([{ role: "clean", lastTickEndedAt: ts }]);
  const row = renderStatus(tmpdir(), snap).split("\n").find((l) => l.startsWith("clean")) ?? "";
  assert.ok(row.includes(`${stampOf(ts)} · 3m ago`), `row missing the stamp: ${JSON.stringify(row)}`);
});

test("last tick shrinks last: narrow width takes from last result, then state, then last tick", () => {
  const root = tmpdir();
  // A working loop with a work-item-style wide state cell and a long last-result summary,
  // so all three flexible columns have room to shrink.
  writePiLog(root, "feature", [
    SESSION,
    assistantLine(`implement plan "${"x".repeat(50)}"`),
    toolStart("bash", { command: "npm test" }),
  ]);
  const snap = {
    ...snapshotWith([
      {
        role: "feature",
        running: true,
        lastTickStartedAt: Date.now() - 5_000,
        ticks: 3,
        commits: 1,
        lastResult: "changed",
        lastSummary: "y".repeat(120),
        lastTickEndedAt: Date.now() - 180_000, // cell is exactly 17 chars: HH:MM:SS · 3m ago
      },
    ]),
    running: true,
  };
  // The separator line (index 3) holds one dash run per column at its exact width.
  const widthsOf = (out: string): number[] => {
    const sep = out.split("\n")[3] ?? "";
    return sep.split("  ").map((seg) => seg.length);
  };
  const col = (w: number[], i: number): number => w[i] ?? -1;
  const natural = widthsOf(renderStatus(root, snap)); // unclipped render
  assert.equal(col(natural, 8), 17, "fixture sanity: last tick column is HH:MM:SS · 3m ago");
  const total = natural.reduce((a, b) => a + b, 0) + 2 * (natural.length - 1);

  // Stage 1: only `last result` shrinks.
  let w = widthsOf(renderStatus(root, snap, total - 5));
  assert.equal(col(w, 9), col(natural, 9) - 5, "last result absorbs the first overflow");
  assert.equal(col(w, 1), col(natural, 1), "state untouched while last result has room");
  assert.equal(col(w, 8), col(natural, 8), "last tick untouched until the others are exhausted");

  // Stage 2: `last result` clamped at its minimum; `state` shrinks next.
  w = widthsOf(renderStatus(root, snap, total - (col(natural, 9) - 12) - 5));
  assert.equal(col(w, 9), 12, "last result clamped at its minimum");
  assert.ok(col(w, 1) < col(natural, 1), "state shrinks after last result is exhausted");
  assert.equal(col(w, 8), col(natural, 8), "last tick still untouched");

  // Stage 3: both at their minimums; `last tick` shrinks last, down to a bare HH:MM:SS.
  w = widthsOf(
    renderStatus(root, snap, total - (col(natural, 9) - 12) - (col(natural, 1) - 12) - (col(natural, 8) - 10)),
  );
  assert.equal(col(w, 9), 12);
  assert.equal(col(w, 1), 12);
  assert.equal(col(w, 8), 10, "last tick shrinks last and only to its HH:MM:SS minimum");

  // And at a hard 80 columns nothing wraps.
  for (const line of renderStatus(root, snap, 80).split("\n")) {
    assert.ok(line.length <= 80, `line exceeds 80 cols: ${JSON.stringify(line)} (${line.length})`);
  }
});

// The per-loop today-spend column (PLANS.md "Per-loop today spend"): `today` sits between cost
// and last tick, showing each loop's daily budget window via dailyCost — $0.00 while its stamp
// is stale or missing, so loops that never ticked read zero without a save. It is not flexible
// (a short fixed-width cell like cost), and the totals row sums the same windows as the badge.

// Header labels are padded to their column widths, so they cannot be split on the two-space
// gap — derive each label by slicing at the separator line's offsets instead.
test("the status table has a today column between cost and last tick", () => {
  const lines = renderStatus(tmpdir(), snapshotWith([{ role: "clean" }])).split("\n");
  const widths = (lines[3] ?? "").split("  ").map((seg) => seg.length); // separator line
  const cellAt = (row: string, i: number): string => {
    let start = 0;
    for (let j = 0; j < i; j++) start += (widths[j] ?? 0) + 2;
    return row.slice(start, start + (widths[i] ?? 0)).trim();
  };
  const cols = widths.map((_, i) => cellAt(lines[2] ?? "", i)); // header labels by position
  assert.ok(cols.includes("today"), "table has a today column");
  assert.equal(cols.indexOf("cost"), cols.indexOf("today") - 1, "today sits directly after cost");
  assert.equal(
    cols.indexOf("last tick"),
    cols.indexOf("today") + 1,
    "today sits directly before last tick",
  );
});

test("the today cell shows the loop's daily window and zeros for stale or missing stamps", () => {
  const fresh = freshLoopState("clean");
  fresh.dayStamp = todayStamp();
  fresh.dayCostUsd = 12.34; // fresh stamp: the persisted window renders as-is
  // Stale: yesterday's stamp with positive spend reads zero — the window rolled over.
  const stale = freshLoopState("dry");
  stale.dayStamp = todayStamp(Date.now() - 86_400_000);
  stale.dayCostUsd = 5.67;
  // Missing: a loop that never ticked (freshLoopState defaults) also reads zero, no save needed.
  const snap = snapshotWith([fresh, stale, freshLoopState("organize")]);
  const lines = renderStatus(tmpdir(), snap).split("\n");
  const widths = (lines[3] ?? "").split("  ").map((seg) => seg.length); // separator line
  const cellAt = (row: string, i: number): string => {
    let start = 0;
    for (let j = 0; j < i; j++) start += (widths[j] ?? 0) + 2;
    return row.slice(start, start + (widths[i] ?? 0)).trim();
  };
  const cols = widths.map((_, i) => cellAt(lines[2] ?? "", i)); // header labels by position
  const cleanRow = lines.find((l) => l.startsWith("clean")) ?? "";
  assert.equal(cellAt(cleanRow, cols.indexOf("today")), "$12.34", "fresh stamp renders its window");
  assert.equal(cellAt(cleanRow, cols.indexOf("cost")), "$0.00", "lifetime cost stays a separate column");
  for (const role of ["dry", "organize"]) {
    const row = lines.find((l) => l.startsWith(role)) ?? "";
    assert.equal(cellAt(row, cols.indexOf("today")), "$0.00", `${role}: stale/missing stamp reads zero`);
  }
});

test("the totals row's today cell sums the loops' daily windows like the header badge", () => {
  const a = freshLoopState("clean");
  a.dayStamp = todayStamp();
  a.dayCostUsd = 12.34;
  const b = freshLoopState("dry");
  b.dayStamp = todayStamp();
  b.dayCostUsd = 0.66;
  // A stale loop contributes nothing to the fleet total...
  const c = freshLoopState("organize");
  c.dayStamp = todayStamp(Date.now() - 86_400_000);
  c.dayCostUsd = 9.99;
  // ...and the badge carries the same sum (status.ts derives both from the loops).
  const snap = snapshotWith([a, b, c], { spentUsd: fleetDailyCost([a, b, c]), capUsd: 50 });
  const lines = renderStatus(tmpdir(), snap).split("\n");
  const widths = (lines[3] ?? "").split("  ").map((seg) => seg.length);
  const cellAt = (row: string, i: number): string => {
    let start = 0;
    for (let j = 0; j < i; j++) start += (widths[j] ?? 0) + 2;
    return row.slice(start, start + (widths[i] ?? 0)).trim();
  };
  const cols = widths.map((_, i) => cellAt(lines[2] ?? "", i)); // header labels by position
  const totalsRow = lines[lines.length - 1] ?? "";
  assert.equal(cellAt(totalsRow, cols.indexOf("today")), "$13.00", "totals sum the fresh windows only (12.34 + 0.66)");
  // Equal to the badge spend on the same render — table and badge cannot drift.
  assert.match(lines[0] ?? "", /· budget: \$13\.00\/\$50 today$/);
});

test("the today column keeps its natural width under overflow like cost", () => {
  const root = tmpdir();
  writePiLog(root, "feature", [
    SESSION,
    assistantLine(`implement plan "${"x".repeat(50)}"`),
    toolStart("bash", { command: "npm test" }),
  ]);
  const s = freshLoopState("feature");
  s.running = true;
  s.lastTickStartedAt = Date.now() - 5_000;
  s.lastResult = "changed";
  s.lastSummary = "y".repeat(120); // wide last result so the flexible columns have room to shrink
  s.dayStamp = todayStamp();
  s.dayCostUsd = 12.34; // "$12.34" — one char wider than the $0.00 default
  const snap = { ...snapshotWith([s]), running: true };
  const widthsOf = (out: string): number[] => (out.split("\n")[3] ?? "").split("  ").map((seg) => seg.length);
  const natural = widthsOf(renderStatus(root, snap));
  // Header labels by position — the separator's offsets, not a two-space split (padded cells
  // would leave stray leading spaces in the segments).
  const headerLine = renderStatus(root, snap).split("\n")[2] ?? "";
  const cols = natural.map((_, i) => {
    let start = 0;
    for (let j = 0; j < i; j++) start += (natural[j] ?? 0) + 2;
    return headerLine.slice(start, start + (natural[i] ?? 0)).trim();
  });
  assert.equal(natural[cols.indexOf("today")], 6, "fixture sanity: $12.34 sets the column width");
  const total = natural.reduce((a, b) => a + b, 0) + 2 * (natural.length - 1);
  // Overflow past last result's minimum so at least one flexible column is shrinking...
  const w = widthsOf(renderStatus(root, snap, total - (natural[cols.indexOf("last result")] ?? 0)));
  assert.ok(
    (w[cols.indexOf("last result")] ?? 0) < (natural[cols.indexOf("last result")] ?? 0),
    "last result shrinks under overflow",
  );
  assert.equal(w[cols.indexOf("today")], natural[cols.indexOf("today")], "today keeps its natural width — never flexible");
  assert.equal(w[cols.indexOf("cost")], natural[cols.indexOf("cost")], "cost likewise stays fixed");
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

test("loopPhase shows the review gate instead of pi detail while a tick is under review", () => {
  const s = freshLoopState("feature");
  s.running = true;
  s.phase = "review";
  s.lastTickStartedAt = Date.now() - 90_000;
  // ±1s of drift between setting the timestamp and formatting it.
  assert.match(loopPhase(s, true), /^reviewing 1m(29|30|31)s$/);

  const bare = freshLoopState("feature");
  bare.running = true;
  bare.phase = "review";
  assert.equal(loopPhase(bare, true), "reviewing"); // no start time: nothing to show elapsed for

  // The review label wins over live pi detail even when a log tail exists — the tail now
  // describes the reviewer run, not the author's.
  const root = tmpdir();
  writePiLog(root, "feature", [SESSION, assistantLine("working", { tokens: 3_000 })]);
  assert.match(loopPhase(s, true, root), /^reviewing /);
});

// duration()'s hours bucket (>= 1h): every elapsed fixture above stays under an hour, so the
// `XhYm` branch — what operators actually see for long ticks and long silences in the status
// table, TUI, and GUI — was untested. The review-gate label is the purest read of it (no log
// tail involved); the stall flag covers its second call site.

test("elapsed labels bucket into hours once a tick passes an hour", () => {
  const reviewing = (msAgo: number): string => {
    const s = freshLoopState("feature");
    s.running = true;
    s.phase = "review";
    s.lastTickStartedAt = Date.now() - msAgo;
    return loopPhase(s, true);
  };

  // Two and a half hours in: floor to whole hours, minutes rounded — not 150m.
  assert.match(reviewing((2 * 3600 + 30 * 60) * 1000), /^reviewing 2h30m$/);

  // The bucket boundary: ten seconds under an hour stays in the minutes branch (59m5Xs),
  // and at exactly an hour the label switches to hours with zero minutes.
  assert.match(reviewing((3600 - 10) * 1000), /^reviewing 59m(49|50|51)s$/);
  assert.match(reviewing(3600 * 1000), /^reviewing 1h0m$/);
});

test("workingDetail's stall flag uses the hours bucket for long silences", () => {
  const root = tmpdir();
  const file = writePiLog(root, "clean", [SESSION, assistantLine("hanging", { tokens: 100 })]);
  // Ninety minutes without pi output: the stall part must read 1h30m, not 90m.
  fs.utimesSync(file, new Date(Date.now() - 5400_000), new Date(Date.now() - 5400_000));
  assert.match(workingDetail(root, freshLoopState("clean")), /no pi output for 1h30m/);
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

// The daily cost budget (plans/daily-cost-budget.md): the header badge is standing
// information while enabled, and paused role loops' state cell reads `budget paused`.

test("the status header carries a budget badge while enabled and none when disabled", () => {
  const enabled = renderStatus(
    tmpdir(),
    snapshotWith([{ role: "clean" }], { spentUsd: 12.34, capUsd: 50 }),
  ).split("\n")[0] ?? "";
  assert.match(enabled, /· budget: \$12\.34\/\$50 today$/);

  // Fractional caps keep their cents; whole-dollar spent values stay two-decimal like the cost column.
  const fractional = renderStatus(
    tmpdir(),
    snapshotWith([{ role: "clean" }], { spentUsd: 0, capUsd: 12.34 }),
  ).split("\n")[0] ?? "";
  assert.match(fractional, /· budget: \$0\.00\/\$12\.34 today$/);

  // Disabled (cap 0 → snapshot sends null): no badge at all.
  const disabled = renderStatus(tmpdir(), snapshotWith([{ role: "clean" }])).split("\n")[0] ?? "";
  assert.doesNotMatch(disabled, /budget/);
});

test("loopPhase reads budget paused for idle role loops while the cap is reached", () => {
  const s = freshLoopState("feature");
  // Not paused: ordinary phase labels are untouched.
  assert.equal(loopPhase(s, true, undefined, false), "queued");
  // Paused: an idle role loop shows why it isn't ticking — ahead of its sleep/queue state.
  assert.equal(loopPhase(s, true, undefined, true), "budget paused");

  // A sleeping loop is paused too (the cap holds it past nextRunAt).
  const sleeping = freshLoopState("clean");
  sleeping.nextRunAt = Date.now() + 3_600_000;
  assert.equal(loopPhase(sleeping, true, undefined, false), "sleeping (for 1h)");
  assert.equal(loopPhase(sleeping, true, undefined, true), "budget paused");

  // The director is exempt from the cap: its phase never changes.
  const d = freshLoopState("director");
  assert.equal(loopPhase(d, true, undefined, true), "waiting for prompts");

  // In-flight ticks finish even while paused — only NEW ticks are blocked.
  const running = freshLoopState("feature");
  running.running = true;
  assert.equal(loopPhase(running, true, undefined, true), "working");

  // A stopped orchestrator still reads stopped (nothing is ticking at all).
  assert.equal(loopPhase(s, false, undefined, true), "stopped");
});

test("renderStatus shows budget paused in idle role loops' state cells while the cap is reached", () => {
  const root = tmpdir();
  // Spend below the cap: ordinary labels.
  const under = renderStatus(
    root,
    { ...snapshotWith([{ role: "feature" }, { role: "director" }], { spentUsd: 10, capUsd: 50 }), running: true },
  );
  assert.match(under, /feature\s+queued/);
  assert.doesNotMatch(under, /budget paused/);

  // Spend at the cap: idle role loops read `budget paused`; the director keeps its own phase.
  const reached = renderStatus(
    root,
    { ...snapshotWith([{ role: "feature" }, { role: "director" }], { spentUsd: 50, capUsd: 50 }), running: true },
  );
  assert.match(reached, /feature\s+budget paused/);
  assert.match(reached, /director\s+waiting for prompts/);

  // The header badge shows the reached budget on the same render.
  assert.match(reached.split("\n")[0] ?? "", /· budget: \$50\.00\/\$50 today$/);
});
