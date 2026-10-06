/** The status table's per-cell suites, split out of status-render.test.ts: the last-tick cell
 * (lastTickCell), the today column, the last-result cell, and the next-run column (nextRunCell).
 * The remaining renderStatus surface stays in status-render.test.ts; the status-model suite
 * (loopPhase, workingDetail) lives in status-model.test.ts, the header badges' in
 * status-header.test.ts, and the fixtures these assemble snapshots from are in status-fixtures.ts. */
import test from "node:test";
import assert from "node:assert/strict";
import { lastTickCell, nextRunCell, renderStatus } from "../src/ui/status-render.js";
import { loopPhase } from "../src/ui/status-model.js";
import { freshLoopState } from "../src/loop-state.js";
import { applyLandingOutcome, applyTickOutcome } from "../src/tick/tick-apply.js";
import { defaultConfig } from "../src/config/config.js";
import { fleetDailyCost, todayStamp } from "../src/budget.js";
import { tmpdir } from "./repo-fixtures.js";
import { assistantLine } from "./pi-events.js";
import {
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

// Last tick cell: absolute local time of the last tick end alongside the relative age.

test("lastTickCell shows the absolute local time plus relative age", () => {
  const ts = Date.now() - 180_000; // three minutes ago, same day: no date prefix
  assert.equal(lastTickCell(ts), `${stampOf(ts)} · 3m ago`);
});

test("lastTickCell prefixes the date once older than a day", () => {
  const ts = Date.now() - 2 * 86_400_000;
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  assert.equal(lastTickCell(ts), `${p(d.getMonth() + 1)}-${p(d.getDate())} ${stampOf(ts)} · 2d ago`);
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
  // ...and the badge carries the same sum (status-data.ts derives both from the loops).
  const snap = snapshotWith([a, b, c], { spentUsd: fleetDailyCost([a, b, c]), capUsd: 50, capHitAt: null, free: false, fallback: null });
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
