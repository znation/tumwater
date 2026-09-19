import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readWindowEvents } from "../src/event-window.js";
import { tmpdir } from "./util.js";

// `readWindowEvents` scans the append-only event log BACKWARDS in 8 KB chunks and early-stops
// once the oldest complete line in hand predates the window. The subtle parts — a line torn by
// a chunk boundary, a chunk that ends inside a line, and the one-chunk log whose own oldest line
// was never checked for an early stop — are what these tests pin.

/** A local-calendar timestamp `daysAgo` days back, matching the window key's local-day bucketing. */
function tsDaysAgo(daysAgo: number, hour = 12): number {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d.getTime();
}

/** The `YYYY-MM-DD` local key `formatDate` would produce for `ms`. */
function keyAt(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function eventLine(ts: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ts, loop: "feature", type: "tick_end", ...extra });
}

/** Write events.jsonl under the fixture root's .tumwater/log/. Raw strings pass through so a
 * test can plant a malformed or blank line. */
function writeLog(root: string, lines: string[]): void {
  const file = path.join(root, ".tumwater", "log", "events.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => l + "\n").join(""));
}

test("a missing or empty log reads as an empty window that does not cover", () => {
  const missing = tmpdir();
  assert.deepEqual(readWindowEvents(missing, keyAt(tsDaysAgo(0))), {
    events: [],
    coversFullWindow: false,
  });

  const empty = tmpdir();
  writeLog(empty, []);
  assert.deepEqual(readWindowEvents(empty, keyAt(tsDaysAgo(0))), {
    events: [],
    coversFullWindow: false,
  });
});

test("a single-chunk log returns in-window events oldest-first and skips bad lines", () => {
  const root = tmpdir();
  const oldest = tsDaysAgo(2);
  writeLog(root, [
    eventLine(oldest, { tick: 1 }),
    "this line is not json", // torn/corrupt line: skipped
    "", // blank line: skipped
    JSON.stringify({ ts: "not a number", loop: "feature", type: "tick_end" }), // no numeric ts: skipped
    eventLine(tsDaysAgo(1), { tick: 2 }),
    eventLine(tsDaysAgo(0), { tick: 3 }),
  ]);
  const { events, coversFullWindow } = readWindowEvents(root, keyAt(oldest));
  // The window is inclusive: the event exactly on the boundary counts.
  assert.deepEqual(
    events.map((e) => e.tick),
    [1, 2, 3],
  );
  // The retained log starts at the window boundary, not before it, so nothing was rotated away.
  assert.equal(coversFullWindow, false);
});

test("a one-line log is dated from its own single line, not discarded as torn", () => {
  const within = tmpdir();
  const recent = tsDaysAgo(1);
  writeLog(within, [eventLine(recent, { tick: 1 })]);
  assert.deepEqual(readWindowEvents(within, keyAt(tsDaysAgo(5))), {
    events: [{ ts: recent, loop: "feature", type: "tick_end", tick: 1 }],
    coversFullWindow: false,
  });

  const before = tmpdir();
  writeLog(before, [eventLine(tsDaysAgo(10), { tick: 1 })]);
  const { events, coversFullWindow } = readWindowEvents(before, keyAt(tsDaysAgo(5)));
  assert.deepEqual(events, []);
  assert.equal(coversFullWindow, true);
});

test("a single-chunk log whose own oldest line predates the window reports full coverage", () => {
  const root = tmpdir();
  writeLog(root, [
    eventLine(tsDaysAgo(10), { tick: 1 }),
    eventLine(tsDaysAgo(1), { tick: 2 }),
    eventLine(tsDaysAgo(0), { tick: 3 }),
  ]);
  const { events, coversFullWindow } = readWindowEvents(root, keyAt(tsDaysAgo(5)));
  assert.deepEqual(
    events.map((e) => e.tick),
    [2, 3],
  );
  assert.equal(coversFullWindow, true);
});

test("the backwards scan early-stops when a line spanning chunks is older than the window", () => {
  const root = tmpdir();
  // old1 is the file's first line; hugeOld straddles every chunk boundary so the scan must
  // stitch it back together from several parts before it can date it; recent sits after it.
  const recent = tsDaysAgo(0);
  writeLog(root, [
    eventLine(tsDaysAgo(20), { tick: 1 }),
    eventLine(tsDaysAgo(15), { tick: 2, pad: "y".repeat(20000) }),
    eventLine(recent, { tick: 3, note: "recent" }),
  ]);
  const { events, coversFullWindow } = readWindowEvents(root, keyAt(tsDaysAgo(5)));
  assert.equal(coversFullWindow, true);
  assert.equal(events.length, 1, "only the in-window event survives");
  assert.equal(events[0]!.tick, 3);
  assert.equal(events[0]!.note, "recent");
});

test("a multi-chunk log with no line before the window reports an uncovered window", () => {
  const root = tmpdir();
  writeLog(root, [
    eventLine(tsDaysAgo(2), { tick: 1, pad: "a".repeat(20000) }),
    eventLine(tsDaysAgo(1), { tick: 2, pad: "b".repeat(20000) }),
    eventLine(tsDaysAgo(0), { tick: 3 }),
  ]);
  const { events, coversFullWindow } = readWindowEvents(root, keyAt(tsDaysAgo(5)));
  assert.deepEqual(
    events.map((e) => e.tick),
    [1, 2, 3],
  );
  // Every retained line lies inside the window; the early stop never fires.
  assert.equal(coversFullWindow, false);
});
