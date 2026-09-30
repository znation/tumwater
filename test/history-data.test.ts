import test from "node:test";
import assert from "node:assert/strict";
import type { HarnessEvent } from "../src/events.js";
import { readTickRowsSince } from "../src/history-data.js";
import { tmpdir } from "./repo-fixtures.js";
import { writeEvents } from "./log-fixtures.js";

// The `history --since` collector: readTickRowsSince reuses the pure tickRows over a
// day-keyed window read (event-window.ts), filters the window's events to the cutoff, and
// reports coverage with the same predicate cmdLogs consults. These tests pin the window's
// composition — what crosses the cutoff, what pairs across it, and what `covered` claims —
// against a log seeded relative to the reader's own clock. Cutoff-sensitive fixtures sit
// minutes away from the cutoff so a few ms of clock drift between seeding and the read
// cannot flip an assertion.

const TWO_HOURS = 7_200_000;
const MIN = 60_000;

function endEvent(over: Partial<HarnessEvent>): HarnessEvent {
  return { ts: 0, loop: "feature", type: "tick_end", tick: 1, result: "changed", ...over } as HarnessEvent;
}

function startEvent(over: Partial<HarnessEvent>): HarnessEvent {
  return { ts: 0, loop: "feature", type: "tick_start", tick: 1, ...over } as HarnessEvent;
}

test("a missing or empty log reads as no rows over a covered window", () => {
  const missing = tmpdir();
  assert.deepEqual(readTickRowsSince(missing, TWO_HOURS, null), { rows: [], covered: true });

  const empty = tmpdir();
  writeEvents(empty, []);
  assert.deepEqual(readTickRowsSince(empty, TWO_HOURS, null), { rows: [], covered: true });
});

test("rows keep the in-window ticks, newest first, and drop everything before the cutoff", () => {
  const root = tmpdir();
  const cutoff = Date.now() - TWO_HOURS;
  // The log is append-only chronological: the pre-cutoff tick rides first.
  writeEvents(root, [
    endEvent({ ts: cutoff - MIN, tick: 1, result: "no_change" }),
    endEvent({ ts: Date.now() - 30 * MIN, tick: 2 }),
    endEvent({ ts: Date.now() - 10 * MIN, tick: 3, summary: "latest work" }),
  ]);
  const { rows } = readTickRowsSince(root, TWO_HOURS, null);
  assert.deepEqual(
    rows.map((r) => [r.tick, r.result, r.detail]),
    [
      [3, "changed", "latest work"],
      [2, "changed", ""],
    ],
  );
});

test("a tick spanning the cutoff renders a dash: the ts filter removes its start too", () => {
  const root = tmpdir();
  const cutoff = Date.now() - TWO_HOURS;
  writeEvents(root, [
    // Started before the cutoff, ended inside it: the window's ts filter drops the start,
    // so the row must show the dash, not a duration spanning the cutoff.
    startEvent({ ts: cutoff - MIN, tick: 1 }),
    endEvent({ ts: Date.now() - 10 * MIN, tick: 1 }),
    // Fully inside the window: still paired, still timed.
    startEvent({ ts: Date.now() - 30 * MIN, tick: 2 }),
    endEvent({ ts: Date.now() - 20 * MIN, tick: 2 }),
  ]);
  const { rows } = readTickRowsSince(root, TWO_HOURS, null);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.tick, 2);
  assert.equal(rows[0]!.durationMs, 10 * MIN);
  assert.equal(rows[1]!.tick, 1);
  assert.equal(rows[1]!.durationMs, null);
});

test("--role narrows the window to one loop", () => {
  const root = tmpdir();
  writeEvents(root, [
    startEvent({ ts: Date.now() - 30 * MIN, loop: "feature", tick: 1 }),
    endEvent({ ts: Date.now() - 20 * MIN, loop: "feature", tick: 1 }),
    endEvent({ ts: Date.now() - 15 * MIN, loop: "clean", tick: 1, result: "no_change" }),
    endEvent({ ts: Date.now() - 5 * MIN, loop: "clean", tick: 2, result: "changed" }),
  ]);
  const all = readTickRowsSince(root, TWO_HOURS, null);
  assert.deepEqual(all.rows.map((r) => [r.loop, r.tick]), [
    ["clean", 2],
    ["clean", 1],
    ["feature", 1],
  ]);
  const clean = readTickRowsSince(root, TWO_HOURS, "clean");
  assert.deepEqual(clean.rows.map((r) => [r.loop, r.tick]), [
    ["clean", 2],
    ["clean", 1],
  ]);
  // The role filter scoping starts as well: the feature tick still pairs within its rows.
  const feature = readTickRowsSince(root, TWO_HOURS, "feature");
  assert.equal(feature.rows[0]!.durationMs, 10 * MIN);
});

test("covered is false while the log starts inside the window, true once an event predates the cutoff", () => {
  const inside = tmpdir();
  writeEvents(inside, [
    endEvent({ ts: Date.now() - 30 * MIN, tick: 1 }),
    endEvent({ ts: Date.now() - 10 * MIN, tick: 2 }),
  ]);
  assert.equal(readTickRowsSince(inside, TWO_HOURS, null).covered, false);

  // The same log plus one older tick: the window's oldest event predates the cutoff, so
  // the read covers it — exactly the predicate cmdLogs' coverage note consults.
  const spanning = tmpdir();
  const cutoff = Date.now() - TWO_HOURS;
  writeEvents(spanning, [
    endEvent({ ts: cutoff - MIN, tick: 1, result: "no_change" }),
    endEvent({ ts: Date.now() - 30 * MIN, tick: 2 }),
  ]);
  assert.equal(readTickRowsSince(spanning, TWO_HOURS, null).covered, true);
});
