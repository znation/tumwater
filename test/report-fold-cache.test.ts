// --- src/report/report-data.ts: collectReport's memoized event-log fold ---
// collectReport caches the event-log half of the day report per (root, fromKey) so a
// dashboard re-fetching /api/report every poll folds only appended log lines instead of
// re-reading the whole window. These tests pin the contract the memo must hold: a warm call
// is byte-for-byte the cold one's twin, and every fallback arm (append, torn tail, shrink,
// window change, empty-log flip) re-derives exactly what a cache-cold read would.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { collectReport } from "../src/report/report-data.js";
import { tmpdir } from "./repo-fixtures.js";
import { atLocalTs as at, dayKey } from "./helpers/oracles.js";

/** Warm a root's memo (one seeding call, one cache-hit call) and return the cache-hit
 * result — the value a poll actually gets. */
function warmed(root: string, days: number) {
  collectReport(root, days);
  return collectReport(root, days);
}

const logOf = (root: string) => path.join(root, ".tumwater", "log", "events.jsonl");

test("warm collectReport equals the cold read before and after appends", () => {
  const root = tmpdir();
  fs.mkdirSync(path.dirname(logOf(root)), { recursive: true });
  fs.writeFileSync(
    logOf(root),
    [
      JSON.stringify({ ts: at(4), loop: "feature", type: "tick_end", tokens: 500, costUsd: 0.5 }),
      JSON.stringify({ ts: at(2), loop: "feature", type: "merged", commit: "abc" }),
    ].join("\n") + "\n",
  );
  const cold = collectReport(root, 5);
  assert.deepEqual(warmed(root, 5), cold);
  // Append a new tick plus a landing event: the warm fold must match a fresh full read.
  fs.appendFileSync(
    logOf(root),
    [
      JSON.stringify({ ts: at(0), loop: "bugfix", type: "tick_end", tokens: 10 }),
      JSON.stringify({ ts: at(0), loop: "review", type: "landed", tokens: 42, costUsd: 0.2 }),
    ].join("\n") + "\n",
  );
  const fresh = collectReport(root, 5);
  assert.deepEqual(warmed(root, 5), fresh);
  assert.equal(fresh.series[4]!.ticksByRole.bugfix, 1);
  assert.equal(fresh.totals.landingTokens, 42);
});

test("a torn trailing write is ignored until its newline lands", () => {
  const root = tmpdir();
  fs.mkdirSync(path.dirname(logOf(root)), { recursive: true });
  fs.writeFileSync(logOf(root), JSON.stringify({ ts: at(1), loop: "a", type: "tick_end", tokens: 1 }) + "\n");
  assert.deepEqual(warmed(root, 2), collectReport(root, 2));
  fs.appendFileSync(logOf(root), JSON.stringify({ ts: at(0), loop: "a", type: "tick_end", tokens: 2 }));
  const torn = collectReport(root, 2);
  assert.deepEqual(collectReport(root, 2), torn); // No partial fold, no drift between calls.
  fs.appendFileSync(logOf(root), "\n"); // The writer completes the line.
  const complete = collectReport(root, 2);
  assert.equal(complete.series[1]!.ticksByRole.a, 1);
  assert.deepEqual(collectReport(root, 2), complete);
});

test("a rotated log replaced by a fresh larger one refolds instead of folding the new log's bytes", () => {
  const root = tmpdir();
  fs.mkdirSync(path.dirname(logOf(root)), { recursive: true });
  // Five 100-token ticks warm the memo; the cache's offset lands at this file's size.
  fs.writeFileSync(
    logOf(root),
    Array.from({ length: 5 }, () => JSON.stringify({ ts: at(0), loop: "bugfix", type: "tick_end", tokens: 100 })).join("\n") + "\n",
  );
  assert.equal(warmed(root, 2).totals.tokensOut, 500);
  // Rotation: rename the whole log away and let a fresh log grow in its place — with ten
  // 10-token ticks AND a size already past the cached offset. Size/mtime alone read as
  // "grown", so the growth arm would fold the fresh log's bytes from the old offset into
  // the folds that cover the retired log — double-counting whatever slice it reads and
  // losing the rest; the inode pins the file the folds cover and forces the full refold.
  fs.renameSync(logOf(root), logOf(root) + ".1");
  // Ten 10-token fresh ticks, but split by a padding run of spaces so the fresh file's size
  // exceeds the cached offset while the bytes past that offset hold only a strict SUFFIX of
  // the fresh events — whatever the growth arm folds from the old offset is a partial fold,
  // never the fresh log's full contribution.
  const tick = () => JSON.stringify({ ts: at(0), loop: "bugfix", type: "tick_end", tokens: 10 });
  const oldSize = fs.statSync(logOf(root) + ".1").size;
  const head = [tick(), tick(), tick()].join("\n") + "\n";
  const tail = [tick(), tick(), tick(), tick(), tick(), tick(), tick()].join("\n") + "\n";
  const padLen = Math.max(1, oldSize - head.length + 40);
  fs.writeFileSync(logOf(root), head + " ".repeat(padLen) + "\n" + tail);
  assert.ok(fs.statSync(logOf(root)).size > oldSize, "fresh log must exceed the cached offset");
  // The window's history survives rotation via the archive (events.jsonl.1): the report
  // folds the archived five 100-token ticks plus the fresh ten 10-token ticks.
  const report = warmed(root, 2);
  assert.equal(report.totals.tokensOut, 600);
  assert.equal(report.totals.ticks, 15);
});

test("a shrunken log (rotation) refolds instead of misaligning the byte offset", () => {
  const root = tmpdir();
  fs.mkdirSync(path.dirname(logOf(root)), { recursive: true });
  fs.writeFileSync(
    logOf(root),
    [JSON.stringify({ ts: at(3), loop: "a", type: "tick_end", tokens: 7 }), JSON.stringify({ ts: at(1), loop: "b", type: "merged" })].join("\n") + "\n",
  );
  assert.deepEqual(warmed(root, 5), collectReport(root, 5));
  // Rotation replaced the whole file: shorter than the memo's offset, new content.
  fs.writeFileSync(logOf(root), JSON.stringify({ ts: at(0), loop: "c", type: "tick_end", tokens: 9 }) + "\n");
  const fresh = collectReport(root, 5);
  assert.deepEqual(collectReport(root, 5), fresh);
  assert.equal(fresh.totals.tokensOut, 9);
});

test("the coverage proof follows the window, not the memo's seed: empty-log vacuous arm flips on first append", () => {
  const root = tmpdir();
  fs.mkdirSync(path.dirname(logOf(root)), { recursive: true });
  fs.writeFileSync(logOf(root), ""); // No retained events: coverage is vacuously true.
  assert.equal(collectReport(root, 1).coversFullWindow, true);
  assert.equal(warmed(root, 1).coversFullWindow, true);
  // First event lands inside the window: the vacuous arm must give way, on the warm path too.
  fs.appendFileSync(logOf(root), JSON.stringify({ ts: at(0), loop: "a", type: "tick_end", tokens: 3 }) + "\n");
  assert.equal(collectReport(root, 1).coversFullWindow, false);
  assert.equal(warmed(root, 1).coversFullWindow, false);
  // A log born inside a 1-day window still proves a wider window whose first day predates it.
  fs.writeFileSync(logOf(root), JSON.stringify({ ts: at(3), loop: "a", type: "tick_end" }) + "\n");
  // The log's birth (3 days ago) predates the narrow windows' first day — covered there;
  // a 4-day window starts on the log's birth day (no proof anything earlier existed) and
  // wider windows contain the log's whole life, so none of those are covered.
  assert.equal(warmed(root, 1).coversFullWindow, true);
  assert.equal(warmed(root, 3).coversFullWindow, true);
  assert.equal(warmed(root, 4).coversFullWindow, false);
  assert.equal(warmed(root, 6).coversFullWindow, false);
  assert.equal(dayKey(at(0)), collectReport(root, 1).to);
});
