/** The rendered status table suite: renderStatus and lastTickCell (src/ui/status-render.ts).
 * The status-model suite (loopPhase, workingDetail) lives beside it in status-model.test.ts,
 * the header badges' in status-header.test.ts, and the badges' in badges.test.ts; the
 * fixtures both assemble snapshots from are in status-fixtures.ts. */
import test from "node:test";
import assert from "node:assert/strict";
import { lastTickCell, nextRunCell, renderStatus } from "../src/ui/status-render.js";
import { displayWidth } from "../src/text.js";
import { loopPhase } from "../src/ui/status-model.js";
import type { StatusSnapshot } from "../src/status-data.js";
import { freshLoopState } from "../src/loop-state.js";
import { applyLandingOutcome, applyTickOutcome } from "../src/tick-outcome.js";
import { defaultConfig } from "../src/config.js";
import { fleetDailyCost, todayStamp } from "../src/budget.js";
import { tmpdir } from "./repo-fixtures.js";
import { assistantLine } from "./pi-events.js";
import {
  DEFAULT_BUDGET,
  PENDING_SHA,
  SESSION,
  snapshotWith,
  stampOf,
  tableCells,
  toolStart,
  writePiLog,
  rowOf,
  pendingFeature,
} from "./status-fixtures.js";

test("status table ends with a totals row summing tokens and cost", () => {
  const snap = snapshotWith([
    { role: "clean", generatedTokens: 900_000, peakContextTokens: 120_000, totalCostUsd: 1.25 },
    { role: "dry", generatedTokens: 350_000, peakContextTokens: 80_000, totalCostUsd: 0.5 },
  ]);
  const lines = renderStatus(tmpdir(), snap).split("\n");
  const totals = lines[lines.length - 1] ?? "";
  const separator = lines[lines.length - 2] ?? "";
  assert.match(totals, /^total\b/);
  // 900,000 + 350,000 = 1,250,000: the row must use the same k/M magnitude rule as the rest
  // of the surface (regression 2026-09-20 — it used to print "1250.0k").
  assert.match(totals, /1\.3M/, "generated sum is compact-formatted with M past a million");
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

// User-defined loops (tumwater.json's customLoops) are marked with an asterisk beside their
// name plus one footnote line under the table — and a fleet without any of them renders the
// exact same table as before the marker existed.

test("status table marks user-defined loops with an asterisk and a footnote", () => {
  const snap = snapshotWith([{ role: "clean" }, { role: "nightly", custom: true }]);
  const text = renderStatus(tmpdir(), snap);
  assert.match(text, /nightly\*/);
  assert.doesNotMatch(text, /clean\*/, "built-ins stay unmarked");
  // The footnote is the line under the table — one per fleet, not per loop.
  const lines = text.split("\n");
  assert.equal(lines[lines.length - 1], "* user-defined loop");
  assert.equal(text.match(/user-defined loop/g)?.length, 1);

  // No customs: no asterisk anywhere and the table still ends at its totals row.
  const plain = renderStatus(tmpdir(), snapshotWith([{ role: "clean" }, { role: "dry" }]));
  assert.doesNotMatch(plain, /\*/);
  assert.match((plain.split("\n") as string[]).at(-1) ?? "", /^total\b/);
});

test("narrow-width clipping still holds when a custom loop is marked", () => {
  const snap = snapshotWith([
    { role: "nightly", custom: true, lastResult: "changed", lastSummary: "x".repeat(120), ticks: 7 },
    { role: "clean" },
  ]);
  for (const width of [40, 60]) {
    for (const line of renderStatus(tmpdir(), snap, width).split("\n")) {
      assert.ok(line.length <= width, `line exceeds ${width} cols: ${JSON.stringify(line)} (${line.length})`);
    }
  }
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

// Last tick cell: absolute local time of the last tick end alongside the relative age.

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
  const col = (w: number[], i: number): number => w[i] ?? -1;
  const natural = tableCells(renderStatus(root, snap)).widths; // unclipped render
  assert.equal(col(natural, 8), 17, "fixture sanity: last tick column is HH:MM:SS · 3m ago");
  const total = natural.reduce((a, b) => a + b, 0) + 2 * (natural.length - 1);

  // Stage 1: only `last result` shrinks.
  let w = tableCells(renderStatus(root, snap, total - 5)).widths;
  assert.equal(col(w, 9), col(natural, 9) - 5, "last result absorbs the first overflow");
  assert.equal(col(w, 1), col(natural, 1), "state untouched while last result has room");
  assert.equal(col(w, 8), col(natural, 8), "last tick untouched until the others are exhausted");

  // Stage 2: `last result` clamped at its minimum; `state` shrinks next.
  w = tableCells(renderStatus(root, snap, total - (col(natural, 9) - 12) - 5)).widths;
  assert.equal(col(w, 9), 12, "last result clamped at its minimum");
  assert.ok(col(w, 1) < col(natural, 1), "state shrinks after last result is exhausted");
  assert.equal(col(w, 8), col(natural, 8), "last tick still untouched");

  // Stage 3: both at their minimums; `last tick` shrinks last, down to a bare HH:MM:SS.
  w = tableCells(
    renderStatus(root, snap, total - (col(natural, 9) - 12) - (col(natural, 1) - 12) - (col(natural, 8) - 10)),
  ).widths;
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
  const { headers: cols } = tableCells(renderStatus(tmpdir(), snapshotWith([{ role: "clean" }])));
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
  const { lines, cellAt, headers: cols } = tableCells(renderStatus(tmpdir(), snap));
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
  const snap = snapshotWith([a, b, c], { spentUsd: fleetDailyCost([a, b, c]), capUsd: 50, free: false, fallback: null });
  const { lines, cellAt, headers: cols } = tableCells(renderStatus(tmpdir(), snap));
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
  const { widths: natural, headers: cols } = tableCells(renderStatus(root, snap));
  assert.equal(natural[cols.indexOf("today")], 6, "fixture sanity: $12.34 sets the column width");
  const total = natural.reduce((a, b) => a + b, 0) + 2 * (natural.length - 1);
  // Overflow past last result's minimum so at least one flexible column is shrinking...
  const w = tableCells(
    renderStatus(root, snap, total - (natural[cols.indexOf("last result")] ?? 0)),
  ).widths;
  assert.ok(
    (w[cols.indexOf("last result")] ?? 0) < (natural[cols.indexOf("last result")] ?? 0),
    "last result shrinks under overflow",
  );
  assert.equal(w[cols.indexOf("today")], natural[cols.indexOf("today")], "today keeps its natural width — never flexible");
  assert.equal(w[cols.indexOf("cost")], natural[cols.indexOf("cost")], "cost likewise stays fixed");
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

test("loopPhase shows failing for idle loops stuck on an error streak, not sleeping", () => {
  // BUGS.md 2026-09-15: a fleet whose every loop is failing must read as failing, not as
  // an ordinary quiet/sleeping fleet.
  const s = freshLoopState("feature");
  s.lastResult = "error";
  s.consecutiveErrors = 3;
  s.nextRunAt = Date.now() + 1_800_000;
  assert.equal(loopPhase(s, true), "failing", "the streak at the threshold outranks sleep");

  // Below the threshold the loop keeps its ordinary label — a few failed ticks are
  // retryable transients, not a health state.
  const shallow = freshLoopState("feature");
  shallow.lastResult = "error";
  shallow.consecutiveErrors = 2;
  shallow.nextRunAt = Date.now() + 1_800_000;
  assert.match(loopPhase(shallow, true), /^sleeping/);

  // A deeper streak stays failing, even queued.
  const deep = freshLoopState("feature");
  deep.lastResult = "error";
  deep.consecutiveErrors = 4;
  assert.equal(loopPhase(deep, true), "failing");

  // A streak fed by leftover-recovery landing failures reads failing even though the tick's
  // own result is healthy (BUGS.md 2026-09-21): the landing failure, not `lastResult`, is the
  // tell. Before the fix this cell showed "sleeping" while a dead reviewer backend wedged the
  // pin forever.
  const recovered = freshLoopState("feature");
  recovered.lastResult = "no_change";
  recovered.consecutiveErrors = 3;
  recovered.nextRunAt = Date.now() + 1_800_000;
  assert.equal(loopPhase(recovered, true), "failing", "a recovery-failure streak outranks sleep");

  // In-flight ticks are untouched (the label describes the finished tick only).
  const running = freshLoopState("feature");
  running.running = true;
  running.lastResult = "error";
  running.consecutiveErrors = 3;
  assert.equal(loopPhase(running, true), "working");

  // The table's state cell carries the label through to status output.
  const snap = snapshotWith([{ role: "feature", lastResult: "error", consecutiveErrors: 3 }]);
  const out = renderStatus(tmpdir(), { ...snap, running: true });
  assert.match(out, /feature\s+failing/);
});

test("renderStatus shows the main-red blockage in a blocked loop's state cell and last-result line", () => {
  const snap = snapshotWith([
    { role: "feature", lastResult: "main_red", lastSummary: "code merges blocked until main is green" },
    { role: "bugfix" }, // exempt roles keep their ordinary phase
  ]);
  const out = renderStatus(tmpdir(), { ...snap, running: true });
  assert.match(out, /feature\s+main red/);
  assert.match(out, /main_red — code merges blocked until main is green/);
  assert.match(out, /bugfix\s+queued/);
});

// The "last result" cell is the last COMPLETED outcome (BUGS.md 2026-09-23). A tick that commits
// and enqueues its change ends `queued`, which is in-flight work — the state column's `landing
// <elapsed>` and the header's land-queue badge already show it — so the cell must keep the prior
// result WITH the prior summary while the change is pending. Driven through the real
// applyTickOutcome so the pin covers the state write, not a hand-built fixture.

/** A queued tick's pinned commit — the sha its stashed summary and the land-queue entry share. */

test("the last-result cell keeps the prior completed result and its summary while a change is pending", () => {
  const s = pendingFeature();
  // Queued behind another landing, then in flight on the landing slot: both windows render
  // the prior pair, and the live landing state stays in the state column. The `last result`
  // cell is read by column position — `next run` sits after it (see the next-run tests).
  const lastResultCell = (out: string) => {
    const { headers, cellAt, lines } = tableCells(out);
    return cellAt(lines.find((l) => l.startsWith("feature ")) ?? "", headers.indexOf("last result"));
  };
  const queuedOnly = renderStatus(tmpdir(), { ...snapshotWith([s]), running: true, landQueue: { depth: 1 } });
  const inFlight = renderStatus(tmpdir(), {
    ...snapshotWith([s]),
    running: true,
    landQueue: { depth: 1, inFlight: { role: "feature", sha: PENDING_SHA, summary: "add the widget", startedAt: Date.now() - 60_000 } },
  });
  for (const out of [queuedOnly, inFlight]) {
    const row = rowOf(out, "feature");
    assert.equal(lastResultCell(out), "refused — objected to the plan", `prior pair in the last-result cell: ${row}`);
    assert.doesNotMatch(row, /\bqueued\b/, "the live landing status is not a last result");
    assert.doesNotMatch(row, /add the widget/, "the pending change's summary is not paired with the prior result");
  }
  assert.match(rowOf(inFlight, "feature"), /^feature\s+landing\b/, "the state column carries the in-flight landing");
});

test("the last-result cell shows the landing's outcome beside the summary of the change it landed", () => {
  // The second window: once the landing resolves, its result — success or failure — takes the
  // cell, paired with the queued change's summary, never with the prior tick's.
  for (const result of ["changed", "rejected"] as const) {
    const s = pendingFeature();
    applyLandingOutcome(s, result, { sha: PENDING_SHA, summary: "add the widget" });
    const row = rowOf(renderStatus(tmpdir(), { ...snapshotWith([s]), running: true }), "feature");
    const { headers, cellAt, lines } = tableCells(renderStatus(tmpdir(), { ...snapshotWith([s]), running: true }));
    assert.equal(cellAt(lines.find((l) => l.startsWith("feature ")) ?? "", headers.indexOf("last result")), `${result} — add the widget`, `landing pair in the last-result cell: ${row}`);
    assert.doesNotMatch(row, /objected to the plan/, "the prior summary does not outlive its result");
  }
});

test("a pending change after a main-red tick does not keep the state cell reading main red", () => {
  // The last-result cell keeps the main_red pair (it IS the last completed outcome), but the
  // state cell's "main red" claims the loop is blocked NOW — and a tick that queued a change
  // got past the red-main gate, so main was green at its tick.
  const s = freshLoopState("feature");
  applyTickOutcome(s, defaultConfig(), "feature", { result: "main_red", summary: "code merges blocked until main is green" });
  assert.equal(loopPhase(s, true), "main red", "fixture sanity: the blocked tick reads main red");
  applyTickOutcome(s, defaultConfig(), "feature", { result: "queued", summary: "add the widget", commit: PENDING_SHA });
  assert.match(loopPhase(s, true), /^sleeping/, "the pending change's tick was not blocked");
  const row = rowOf(renderStatus(tmpdir(), { ...snapshotWith([s]), running: true, landQueue: { depth: 1 } }), "feature");
  assert.doesNotMatch(row, /main red/);
  const { headers, cellAt, lines } = tableCells(renderStatus(tmpdir(), { ...snapshotWith([s]), running: true, landQueue: { depth: 1 } }));
  assert.equal(cellAt(lines.find((l) => l.startsWith("feature ")) ?? "", headers.indexOf("last result")), "main_red — code merges blocked until main is green", `prior pair kept: ${row}`);
});

test("renderStatus shows budget paused in idle role loops' state cells while the cap is reached", () => {
  const root = tmpdir();
  // Spend below the cap: ordinary labels.
  const under = renderStatus(
    root,
    { ...snapshotWith([{ role: "feature" }, { role: "director" }], { spentUsd: 10, capUsd: 50, free: false, fallback: null }), running: true },
  );
  assert.match(under, /feature\s+queued/);
  assert.doesNotMatch(under, /budget paused/);

  // Spend at the cap: idle role loops read `budget paused`; the director keeps its own phase.
  const reached = renderStatus(
    root,
    { ...snapshotWith([{ role: "feature" }, { role: "director" }], { spentUsd: 50, capUsd: 50, free: false, fallback: null }), running: true },
  );
  assert.match(reached, /feature\s+budget paused/);
  assert.match(reached, /director\s+waiting for prompts/);

  // The header badge shows the reached budget on the same render.
  assert.match(reached.split("\n")[0] ?? "", /· budget: \$50\.00\/\$50 today$/);
});

// Per-role pause (`tumwater pause --role <id>`): the snapshot's pausedRoles set gates the same
// `paused` cell as the fleet flag, but only for the named role — every other idle row keeps
// its ordinary label, and the director keeps its own phase (its cell branch precedes the
// pause checks, like under the fleet pause).
test("renderStatus shows paused only for the individually paused idle role", () => {
  const root = tmpdir();
  const out = renderStatus(
    root,
    {
      ...snapshotWith([{ role: "docs" }, { role: "feature" }, { role: "director" }], DEFAULT_BUDGET, false, ["docs"]),
      running: true,
    },
  );
  assert.match(out, /docs\s+paused/);
  assert.match(out, /feature\s+queued/);
  assert.doesNotMatch(out, /feature\s+paused/);
  assert.match(out, /director\s+waiting for prompts/);

  // An empty set changes nothing — the fleet-wide flag alone drives the cell, as before.
  const none = renderStatus(
    root,
    { ...snapshotWith([{ role: "docs" }], DEFAULT_BUDGET, false, []), running: true },
  );
  assert.doesNotMatch(none, /\bpaused\b/);
});

// Regression (review of the editable-budget feature): the snapshot's budget object is now
// unconditional, so a DISABLED cap (capUsd 0) must not read as reached — spend ≥ 0 would
// otherwise flag every idle loop `budget paused` on a fleet with no cap at all.
test("renderStatus never reads budget paused while the cap is disabled, even past any spend", () => {
  const root = tmpdir();
  // Cap disabled (0) with today's spend far above zero: the gate is off by definition.
  const out = renderStatus(
    root,
    { ...snapshotWith([{ role: "feature" }, { role: "director" }], { spentUsd: 999, capUsd: 0, free: false, fallback: null }), running: true },
  );
  assert.doesNotMatch(out, /budget paused/, "no loop reads budget paused with the cap disabled");
  assert.match(out, /feature\s+queued/);
  assert.match(out, /director\s+waiting for prompts/);
  // The badge stays standing and says no cap.
  assert.match(out.split("\n")[0] ?? "", /· budget: \$999\.00 today · no cap$/);
});

test("renderStatus shows paused in idle role loops' state cells ahead of budget paused and main red", () => {
  const root = tmpdir();
  // No pause: ordinary labels.
  const unpaused = renderStatus(
    root,
    { ...snapshotWith([{ role: "feature" }, { role: "director" }]), running: true },
  );
  assert.match(unpaused, /feature\s+queued/);
  assert.doesNotMatch(unpaused, /\bpaused\b/);

  // Marker present with the cap also reached and main red: idle role loops read `paused`
  // ahead of both; the director keeps its own phase. (The last-result column still carries
  // the raw main_red string — only the state cell is overridden.)
  const paused = renderStatus(
    root,
    {
      ...snapshotWith(
        [{ role: "feature", lastResult: "main_red" }, { role: "director" }],
        { spentUsd: 50, capUsd: 50, free: false, fallback: null },
        true,
      ),
      running: true,
    },
  );
  assert.match(paused, /feature\s+paused/);
  assert.doesNotMatch(paused, /budget paused/);
  assert.doesNotMatch(paused, /main red/);
  assert.match(paused, /director\s+waiting for prompts/);
});

test("renderStatus keeps role loops working under the fallback and pauses them without one", () => {
  const root = tmpdir();
  const loops = [{ role: "feature" }, { role: "director" }];
  // At the cap WITH a usable free fallback: the loops keep ticking on it, so no row reads
  // `budget paused` — the header badge is where the operator learns the cap is spent.
  const degraded = renderStatus(root, {
    ...snapshotWith(loops, { spentUsd: 50, capUsd: 50, free: false, fallback: { provider: "omlx", model: "local-free" } }),
    running: true,
  });
  assert.doesNotMatch(degraded, /budget paused/, "a fallback fleet is not a stopped fleet");
  assert.match(degraded, /feature\s+queued/);
  assert.match(degraded.split("\n")[0] ?? "", /· budget: \$50\.00\/\$50 today · fallback: local-free \(cost n\/a\)$/);

  // The same spend with no usable fallback pauses the role loops, exactly as before.
  const stopped = renderStatus(root, {
    ...snapshotWith(loops, { spentUsd: 50, capUsd: 50, free: false, fallback: null }),
    running: true,
  });
  assert.match(stopped, /feature\s+budget paused/);
});

test("status table groups a landing role above queued/sleeping rows with newer last ticks", () => {
  const root = tmpdir();
  const t = (min: number) => Date.parse("2026-09-11T00:00:00Z") + min * 60000;
  // A sleeping role and a queued role, both with a NEWER last tick than the landing role —
  // grouping must still put the landing role first, the same active-first rule as the GUI
  // table. Before the fix renderStatus emitted payload order, so landing sank with the idles.
  const sleeping = freshLoopState("sleepy");
  sleeping.nextRunAt = Date.now() + 5 * 60_000;
  sleeping.lastTickEndedAt = t(5);
  const queued = freshLoopState("queued-z");
  queued.lastTickEndedAt = t(4);
  const landing = freshLoopState("landing-r");
  landing.lastTickEndedAt = t(0);
  const snap: StatusSnapshot = {
    ...snapshotWith([sleeping, queued, landing]),
    running: true,
    landQueue: {
      depth: 1,
      inFlight: { role: "landing-r", sha: "abc1234", summary: "tidy", startedAt: Date.now() - 90_000 },
    } as StatusSnapshot["landQueue"],
  };
  const lines = renderStatus(root, snap).split("\n");
  const rowOf = (role: string) => lines.findIndex((l) => l.startsWith(role));
  assert.ok(rowOf("landing-r") >= 0, "the landing role has a row");
  assert.ok(rowOf("landing-r") < rowOf("sleepy"), "landing sorts above a sleeping row with a newer last tick");
  assert.ok(rowOf("landing-r") < rowOf("queued-z"), "landing sorts above a queued row with a newer last tick");
  assert.match(lines[rowOf("landing-r")]!, /landing \dm\d+s/);
});
// The `next run` column (PLANS.md "Next-run visibility"): nextRunCell's rules — a due idle
// loop reads `now`, a future one its remaining time (`backoff `-prefixed while backing off),
// in-flight loops and a stopped fleet read `-` — and the column is appended last so
// FLEXIBLE_COLUMNS' positional indices stay untouched.

test("nextRunCell reads now for a due idle loop and the remaining time for a future one", () => {
  const now = Date.now();
  const due = freshLoopState("clean");
  const future = freshLoopState("dry");
  future.nextRunAt = now + 180_000;
  const backoff = freshLoopState("feature");
  backoff.nextRunAt = now + 180_000;
  backoff.backoffSeconds = 240;
  assert.equal(nextRunCell(due, "queued", now, true), "now");
  assert.equal(nextRunCell(future, "queued", now, true), "3m");
  assert.equal(nextRunCell(backoff, "queued", now, true), "backoff 3m", "a backing-off loop says so — that is what wake clears");
});

test("nextRunCell shows ×N beside the time for a role whose yield scales its clock", () => {
  // Yield-scaled clocks (PLANS.md): the multiplier gates the gap in isEligible, so a
  // `now`-due cell at ×4 is a role waiting out its stretched gap — the suffix is what
  // makes that visible instead of looking like a broken clock.
  const now = Date.now();
  const scaled = freshLoopState("perf");
  scaled.recentOutcomes = "n".repeat(16); // ×4
  scaled.nextRunAt = now - 1000;
  assert.equal(nextRunCell(scaled, "queued", now, true), "now ×4");
  scaled.nextRunAt = now + 180_000;
  assert.equal(nextRunCell(scaled, "queued", now, true), "3m ×4");
  scaled.backoffSeconds = 240;
  assert.equal(nextRunCell(scaled, "queued", now, true), "backoff 3m ×4");
  // A role the scaling never applies to stays unsuffixed even with a full empty ring.
  const work = freshLoopState("feature");
  work.recentOutcomes = "n".repeat(20);
  work.nextRunAt = now - 1000;
  assert.equal(nextRunCell(work, "queued", now, true), "now");
  // And multiplier 1 (a landing in the recent window) carries no suffix either.
  const landed = freshLoopState("perf");
  landed.recentOutcomes = "n".repeat(19) + "L";
  landed.nextRunAt = now - 1000;
  assert.equal(nextRunCell(landed, "queued", now, true), "now");
});

test("nextRunCell reads - for a loop in flight or a fleet that is not running", () => {
  const now = Date.now();
  const working = freshLoopState("clean");
  working.nextRunAt = now + 60_000;
  working.running = true;
  assert.equal(nextRunCell(working, "working 3m", now, true), "-");
  // A landing is in flight though the loop itself is not running: the rendered phase says so.
  const landing = freshLoopState("dry");
  landing.nextRunAt = now + 60_000;
  assert.equal(nextRunCell(landing, "landing 1m · build check", now, true), "-");
  const idle = freshLoopState("feature");
  idle.nextRunAt = now + 60_000;
  assert.equal(nextRunCell(idle, "queued", now, false), "-", "a stopped fleet's nextRunAts are stale leftovers, not plans");
});

test("status table appends the next run column after last result", () => {
  const snap = { ...snapshotWith([{ role: "clean" }]), running: true };
  const { headers, cellAt, lines } = tableCells(renderStatus(tmpdir(), snap));
  assert.equal(headers[headers.length - 1], "next run", "the new column is last");
  assert.equal(headers[headers.length - 2], "last result");
  // A fresh state is due immediately (nextRunAt 0): the idle row reads now.
  const row = lines.find((l) => l.startsWith("clean ")) ?? "";
  assert.equal(cellAt(row, headers.indexOf("next run")), "now");
});

/** `line` expanded to one entry per terminal display column — a wide character fills both of
 * its columns. The alignment probe's substrate: misalignment is invisible to character-index
 * arithmetic but obvious column-by-column. */
function columns(line: string): string[] {
  const out: string[] = [];
  for (const ch of line) for (let k = 0; k < displayWidth(ch); k++) out.push(ch);
  return out;
}

test("status table keeps every column boundary aligned when a cell holds a wide character", () => {
  // A custom loop's summary carries CJK text (two terminal columns per code point): widths
  // derived from UTF-16 code units under-measure it, and code-unit padding leaves that row's
  // later columns shifted left against the header and every ASCII row.
  const snap = snapshotWith([
    { role: "clean" },
    { role: "dry", lastResult: "changed", lastSummary: "翻译了三个文件" },
  ]);
  const lines = renderStatus(tmpdir(), snap).split("\n");
  // The separator line (index 3) names each column's boundary in display columns: the
  // cumulative width of its dash runs plus the two-space gaps.
  const boundaries: number[] = [];
  let w = 0;
  for (const seg of (lines[3] ?? "").split("  ")) {
    w += displayWidth(seg);
    boundaries.push(w);
    w += 2;
  }
  // Every fully-populated table line (the column header, the two data rows) must place each
  // cell exactly between its neighbors: at every interior boundary the two gap columns are
  // blank and the next cell's content starts right after them. A row whose wide-character
  // cell was measured and padded by UTF-16 code units renders wider than its column, and its
  // later cells drift right — the drift shows up as blank padding where content belongs.
  // (The totals row is exempt: several of its cells are legitimately empty.)
  const sep2 = lines.findIndex((l, i) => i > 3 && l.startsWith("---"));
  const table = [lines[2] ?? "", ...lines.slice(4, sep2 < 0 ? lines.length : sep2)];
  assert.equal(table.length, 3, "column header plus two data rows render");
  for (const line of table) {
    const c = columns(line);
    for (const b of boundaries.slice(0, -1)) {
      assert.ok(c.length > b + 2, `line reaches past boundary ${b}: ${line}`);
      assert.equal(c[b], " ", `gap before boundary ${b} is not blank in: ${line}`);
      assert.equal(c[b + 1], " ", `gap after boundary ${b} is not blank in: ${line}`);
      assert.notEqual(c[b + 2], " ", `next cell does not start at boundary ${b}+2 in: ${line}`);
    }
  }
});

test("a loop with queued prompts carries a p:N marker on its state cell", () => {
  const snap = snapshotWith([{ role: "clean" }, { role: "dry" }], DEFAULT_BUDGET, false, [], { clean: 2 });
  const lines = renderStatus(tmpdir(), snap).split("\n");
  const cleanRow = lines.find((l) => l.startsWith("clean")) ?? "";
  assert.match(cleanRow, /p:2/, "the queued count rides the state cell");
  const dryRow = lines.find((l) => l.startsWith("dry")) ?? "";
  assert.doesNotMatch(dryRow, /p:/, "an empty queue renders no marker");
  assert.doesNotMatch(lines[lines.length - 1] ?? "", /p:/, "the totals row stays marker-free");
});
