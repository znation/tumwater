import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readEventsSince, readWindowEvents } from "../src/events/event-window.js";
import { eventsLogPath } from "../src/paths.js";
import { collectReport } from "../src/report/report-data.js";
import { renderReportMarkdown } from "../src/report/report-render.js";
import { atLocalTs as tsDaysAgo, dayKey } from "./helpers/oracles.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { writeLogLines } from "./log-fixtures.js";

// `readWindowEvents` scans the append-only event log BACKWARDS in 8 KB chunks and early-stops
// once the oldest complete line in hand predates the window. The subtle parts — a line torn by
// a chunk boundary, a chunk that ends inside a line, and the one-chunk log whose own oldest line
// was never checked for an early stop — are what these tests pin.

function eventLine(ts: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ts, loop: "feature", type: "tick_end", ...extra });
}

/** Write events.jsonl under the fixture root's .tumwater/log/. Raw strings pass through so a
 * test can plant a malformed or blank line. */
function writeLog(root: string, lines: string[]): void {
  writeLogLines(path.join(root, ".tumwater", "log", "events.jsonl"), lines);
}

/** Write the rotated archive (events.jsonl.1) beside the fixture root's live log. */
function writeArchive(root: string, lines: string[]): void {
  writeLogLines(path.join(root, ".tumwater", "log", "events.jsonl.1"), lines);
}

/** The live log's covered end for these newline-terminated fixture logs — the byte size the
 * scan read through, which `readWindowEvents` reports as `liveEnd` (0 for a missing log). */
function liveEndOf(root: string): number {
  try {
    return fs.statSync(eventsLogPath(root)).size;
  } catch {
    return 0;
  }
}

test("a missing or empty log reads as an empty window that does not cover", () => {
  const missing = tmpdir();
  assert.deepEqual(readWindowEvents(missing, dayKey(tsDaysAgo(0))), {
    events: [],
    coversFullWindow: false,
    liveEnd: 0,
  });

  const empty = tmpdir();
  writeLog(empty, []);
  assert.deepEqual(readWindowEvents(empty, dayKey(tsDaysAgo(0))), {
    events: [],
    coversFullWindow: false,
    liveEnd: liveEndOf(empty),
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
  const { events, coversFullWindow } = readWindowEvents(root, dayKey(oldest));
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
  assert.deepEqual(readWindowEvents(within, dayKey(tsDaysAgo(5))), {
    events: [{ ts: recent, loop: "feature", type: "tick_end", tick: 1 }],
    coversFullWindow: false,
    liveEnd: liveEndOf(within),
  });

  const before = tmpdir();
  writeLog(before, [eventLine(tsDaysAgo(10), { tick: 1 })]);
  const { events, coversFullWindow } = readWindowEvents(before, dayKey(tsDaysAgo(5)));
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
  const { events, coversFullWindow } = readWindowEvents(root, dayKey(tsDaysAgo(5)));
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
  const { events, coversFullWindow } = readWindowEvents(root, dayKey(tsDaysAgo(5)));
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
  const { events, coversFullWindow } = readWindowEvents(root, dayKey(tsDaysAgo(5)));
  assert.deepEqual(
    events.map((e) => e.tick),
    [1, 2, 3],
  );
  // Every retained line lies inside the window; the early stop never fires.
  assert.equal(coversFullWindow, false);
});

// Rotation moves the grown log to events.jsonl.1; the windowed readers continue into it so a
// 16 MB live file no longer truncates a multi-day window. These cases pin the boundary: both
// files' in-window events returned oldest-first, coverage reported from whichever file reaches
// farthest back, and the no-archive case unchanged.

test("a window spanning the rotation boundary reads both files, oldest-first, in-window only", () => {
  const root = tmpdir();
  writeArchive(root, [
    eventLine(tsDaysAgo(6), { tick: 1 }),
    eventLine(tsDaysAgo(3), { tick: 2 }),
  ]);
  writeLog(root, [
    eventLine(tsDaysAgo(1), { tick: 3 }),
    eventLine(tsDaysAgo(0), { tick: 4 }),
  ]);
  const { events, coversFullWindow } = readWindowEvents(root, dayKey(tsDaysAgo(5)));
  // The archive's day-6 event predates the window and drops out; the day-3 one comes first,
  // then the live file's two — archive events are strictly older than the live file's.
  assert.deepEqual(
    events.map((e) => e.tick),
    [2, 3, 4],
  );
  // The archive's oldest event predates the window start, so nothing rotated away.
  assert.equal(coversFullWindow, true);
});

test("the report's per-day series sums to the seeded totals across the boundary", () => {
  const root = tmpdir();
  writeArchive(root, [
    eventLine(tsDaysAgo(3), { tick: 1, loop: "feature", tokens: 10 }),
    eventLine(tsDaysAgo(3), { tick: 2, loop: "bugfix", tokens: 20 }),
  ]);
  writeLog(root, [
    eventLine(tsDaysAgo(0), { tick: 3, loop: "feature", tokens: 30 }),
  ]);
  const report = collectReport(root, 5);
  const totalTicks = report.series.reduce((n, d) => n + Object.values(d.ticksByRole).reduce((a, b) => a + b, 0), 0);
  const totalTokens = report.series.reduce((n, d) => n + d.tokensOut, 0);
  assert.equal(totalTicks, 3, "both files' in-window ticks fold into the series");
  assert.equal(totalTokens, 60);
  // The out-of-window archive day contributes nothing, and the series' dates do not repeat.
  const featureDay3 = report.series.find((d) => d.ticksByRole["feature"] !== undefined);
  assert.ok(featureDay3, "the archive day's feature tick lands on its own date");
});

test("coversFullWindow is false when even the archive starts inside the window", () => {
  const root = tmpdir();
  writeArchive(root, [
    eventLine(tsDaysAgo(3), { tick: 1 }),
    eventLine(tsDaysAgo(2), { tick: 2 }),
  ]);
  writeLog(root, [eventLine(tsDaysAgo(0), { tick: 3 })]);
  const { events, coversFullWindow } = readWindowEvents(root, dayKey(tsDaysAgo(5)));
  assert.deepEqual(
    events.map((e) => e.tick),
    [1, 2, 3],
  );
  // Both files' oldest events lie inside the window: the note must still warn that older
  // events rotated out.
  assert.equal(coversFullWindow, false);
});

test("the day report says so when even the archive starts inside the window", () => {
  // collectReport was the one windowed consumer without a truncation note: the --since report
  // and the failure digest both carry one, but the day report could undercount a window that
  // outran the single kept archive generation in silence.
  const root = tmpdir();
  writeArchive(root, [eventLine(tsDaysAgo(3), { tick: 1, loop: "feature", tokens: 10 })]);
  writeLog(root, [eventLine(tsDaysAgo(0), { tick: 2, loop: "feature", tokens: 20 })]);
  const report = collectReport(root, 5);
  assert.equal(report.coversFullWindow, false, "both files' oldest events lie inside the window");
  assert.match(renderReportMarkdown(report), /older events may have rotated out/);
});

test("the day report stays silent when the archive proves the window's coverage", () => {
  const root = tmpdir();
  writeArchive(root, [eventLine(tsDaysAgo(6), { tick: 1, loop: "feature", tokens: 10 })]);
  writeLog(root, [eventLine(tsDaysAgo(0), { tick: 2, loop: "feature", tokens: 20 })]);
  const report = collectReport(root, 5);
  assert.equal(report.coversFullWindow, true, "the archive's day-6 event predates the window's first day");
  assert.ok(!renderReportMarkdown(report).includes("rotated out"), "a fully covered window claims no truncation");
});

test("a missing or empty archive leaves the live file's window behavior unchanged", () => {
  const missingArchive = tmpdir();
  writeLog(missingArchive, [
    eventLine(tsDaysAgo(1), { tick: 1 }),
    eventLine(tsDaysAgo(1, 13), { tick: 2 }),
  ]);
  assert.deepEqual(readWindowEvents(missingArchive, dayKey(tsDaysAgo(1))), {
    events: [
      { ts: tsDaysAgo(1), loop: "feature", type: "tick_end", tick: 1 },
      { ts: tsDaysAgo(1, 13), loop: "feature", type: "tick_end", tick: 2 },
    ],
    coversFullWindow: false,
    liveEnd: liveEndOf(missingArchive),
  });

  const emptyArchive = tmpdir();
  writeArchive(emptyArchive, []);
  writeLog(emptyArchive, [eventLine(tsDaysAgo(1), { tick: 1 })]);
  assert.deepEqual(readWindowEvents(emptyArchive, dayKey(tsDaysAgo(1))), {
    events: [{ ts: tsDaysAgo(1), loop: "feature", type: "tick_end", tick: 1 }],
    coversFullWindow: false,
    liveEnd: liveEndOf(emptyArchive),
  });
});

test("the archive follows the live file's skip policy, and a covered window never touches it", () => {
  const root = tmpdir();
  writeArchive(root, [
    "this line is not json", // torn/corrupt archive line: skipped
    "", // blank line: skipped
    eventLine(tsDaysAgo(1), { tick: 1 }),
  ]);
  // The live file's own oldest line predates the window, so the read never needs the archive —
  // and anything the archive holds must not leak into the result.
  writeLog(root, [
    eventLine(tsDaysAgo(10), { tick: 99 }),
    eventLine(tsDaysAgo(0), { tick: 2 }),
  ]);
  const { events, coversFullWindow } = readWindowEvents(root, dayKey(tsDaysAgo(5)));
  assert.deepEqual(
    events.map((e) => e.tick),
    [2],
  );
  assert.equal(coversFullWindow, true);

  // And when the window does reach into the archive, the same skip policy applies there.
  const archiveInside = tmpdir();
  writeArchive(archiveInside, [
    "still not json",
    eventLine(tsDaysAgo(2), { tick: 1 }),
  ]);
  writeLog(archiveInside, [eventLine(tsDaysAgo(0), { tick: 2 })]);
  const spanned = readWindowEvents(archiveInside, dayKey(tsDaysAgo(5)));
  assert.deepEqual(
    spanned.events.map((e) => e.tick),
    [1, 2],
  );
  assert.equal(spanned.coversFullWindow, false);
});

// readEventsSince is the duration-shaped window read `logs --since` and `history --since`
// share: the cutoff is now − sinceMs, the day-keyed read may over-read earlier hours of the
// cutoff's own day, and the ts filter removes them — so these tests pin the instant filter's
// margins with Date.now()-relative timestamps (noon fixtures would straddle the cutoff
// depending on when the suite runs), and the coverage verdict with the same local-noon
// fixtures readWindowEvents' tests above use.

test("readEventsSince filters the day-keyed over-read by the cutoff instant", () => {
  const root = tmpdir();
  const t0 = Date.now();
  writeLog(root, [
    eventLine(t0 - 120_000, { tick: 1 }), // before the cutoff: the ts filter drops it (it sits
    // inside the cutoff's local day for every run except one within 2 minutes of midnight,
    // where the day key drops it instead — the assertion holds either way)
    JSON.stringify({ ts: "not a number", loop: "feature", type: "tick_end" }), // no numeric ts
    eventLine(t0 - 30_000, { tick: 2 }), // inside the window
    eventLine(t0, { tick: 3 }),
  ]);
  const readFrom = Date.now();
  const { cutoff, events, covered } = readEventsSince(root, 60_000);
  const readTo = Date.now();
  assert.deepEqual(
    events.map((e) => e.tick),
    [2, 3],
  );
  // The cutoff is the read's own now − sinceMs: bracketed by clock reads around the read, not
  // a fixed tolerance around the fixture's t0 that a stalled host could exceed.
  assert.ok(
    cutoff >= readFrom - 60_000 && cutoff <= readTo - 60_000,
    `cutoff ${cutoff} vs the read's ${readFrom - 60_000}..${readTo - 60_000}`,
  );
  // Covered: the day-keyed read hands back the 2-min-ago event too, and its being at-or-before
  // the cutoff proves nothing older could have rotated away — even though the ts filter then
  // drops it from the returned events. Coverage is judged on the window's oldest retained
  // event, not on the filtered result's.
  assert.equal(covered, true);
});

test("an empty window reads as covered — an idle fleet prints no rotation note", () => {
  const root = tmpdir();
  writeLog(root, []);
  const { events, covered } = readEventsSince(root, 60_000);
  assert.deepEqual(events, []);
  // eventWindowCovers' vacuous case: with no retained events nothing can have rotated away,
  // so `logs --since` on a fleet that never ran must not hedge.
  assert.equal(covered, true);
});

test("a log born inside a wide --since window reads as uncovered", () => {
  const root = tmpdir();
  writeLog(root, [eventLine(tsDaysAgo(1), { tick: 1 }), eventLine(tsDaysAgo(0), { tick: 2 })]);
  const { events, covered } = readEventsSince(root, 3 * 24 * 60 * 60 * 1000);
  assert.deepEqual(
    events.map((e) => e.tick),
    [1, 2],
  );
  // Every retained line lies inside the window's days and the oldest is younger than the
  // cutoff instant: the read cannot distinguish "idle since" from "younger than the window".
  assert.equal(covered, false);
});

test("a --since window spanning the rotation boundary reads the archive through the same filter", () => {
  const root = tmpdir();
  writeArchive(root, [eventLine(tsDaysAgo(4), { tick: 1 }), eventLine(tsDaysAgo(2), { tick: 2 })]);
  writeLog(root, [eventLine(tsDaysAgo(0), { tick: 3 })]);
  const { events, covered } = readEventsSince(root, 3 * 24 * 60 * 60 * 1000);
  // Archive first (strictly older), the pre-window 4-days-ago event dropped, the in-window
  // 2-days-ago one kept: the instant filter applies to the concatenation, not just the live file.
  assert.deepEqual(
    events.map((e) => e.tick),
    [2, 3],
  );
  // The archive's oldest line predates the window, so the read proves its own coverage —
  // the rotation note stays silent even though the live file alone would not.
  assert.equal(covered, true);
});
