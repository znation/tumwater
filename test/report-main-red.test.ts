// --- src/report/report-main-red.ts: mainRedMinutesByDay ---
// Pure per-day main-red wall-clock from the main_check / main_red_hold trail G1 uses. Hand-built
// events in explicit local windows (no clock, no log) pin the spell-open/close and the
// day-split, matching the collector's own [fromMs, toMs) window rule.

import test from "node:test";
import assert from "node:assert/strict";
import { mainRedMinutesByDay } from "../src/report/report-main-red.js";
import { dayKey } from "./helpers/oracles.js";

const MIN = 60_000;
const HOUR = 3_600_000;

const hold = (ts: number) => ({ type: "main_red_hold", ts, source: "t", sha: "abc123" } as const);
const check = (ts: number, status: "passed" | "failed", durationMs: number) =>
  ({ type: "main_check", ts, source: "t", status, durationMs, sha: "abc123" } as const);
const at = (y: number, m: number, d: number, h: number, min = 0) =>
  new Date(y, m - 1, d, h, min).getTime();

test("a main_red_hold closed by a passing main_check prices the elapsed span that day", () => {
  const t = at(2026, 10, 22, 10);
  const from = new Date(2026, 9, 22, 0).getTime();
  const to = from + 2 * 24 * HOUR;
  const map = mainRedMinutesByDay([hold(t), check(t + 40 * MIN, "passed", 2000)], from, to);
  assert.equal(map.get(dayKey(t)), 40 * MIN);
  assert.equal(map.size, 1);
});

test("a spell crossing local midnight splits across both day keys summing to the span", () => {
  const holdTs = at(2026, 10, 22, 23);
  const passTs = at(2026, 10, 23, 1);
  const from = new Date(2026, 9, 22, 0).getTime();
  const to = new Date(2026, 9, 24, 0).getTime();
  const map = mainRedMinutesByDay([hold(holdTs), check(passTs, "passed", 2000)], from, to);
  assert.equal(map.get(dayKey(holdTs)), 1 * HOUR, "23:00 → midnight on the first day");
  assert.equal(map.get(dayKey(passTs)), 1 * HOUR, "midnight → 01:00 on the next day");
  assert.equal([...map.values()].reduce((a, b) => a + b, 0), 2 * HOUR);
});

test("a spell still open at the window end counts to toMs", () => {
  const holdTs = at(2026, 10, 22, 10);
  const to = at(2026, 10, 22, 12);
  const map = mainRedMinutesByDay([hold(holdTs)], holdTs, to);
  assert.equal(map.get(dayKey(holdTs)), 2 * HOUR);
});

test("a main_check that did not run (durationMs 0) neither opens nor closes a spell", () => {
  // A failed cached check opens nothing (it is inside [from, to), so the map is empty only
  // because isRedMain ignores a durationMs-0 check, not because the window dropped it).
  const from = at(2026, 10, 22, 0);
  const to = at(2026, 10, 22, 11);
  assert.equal(mainRedMinutesByDay([check(from + 5 * MIN, "failed", 0)], from, to).size, 0);

  // A passed cached check does not close: the hold stays open to the window end.
  const holdTs = at(2026, 10, 22, 10);
  const toMs = at(2026, 10, 22, 11);
  const map = mainRedMinutesByDay([hold(holdTs), check(holdTs + 30 * MIN, "passed", 0)], holdTs, toMs);
  assert.equal(map.get(dayKey(holdTs)), 1 * HOUR, "the durationMs-0 pass leaves the spell open to toMs");
});

test("a second red while a spell is open keeps the earliest start", () => {
  const t = at(2026, 10, 22, 10);
  const from = new Date(2026, 9, 22, 0).getTime();
  const to = from + 24 * HOUR;
  const map = mainRedMinutesByDay(
    [hold(t), hold(t + 10 * MIN), check(t + 40 * MIN, "passed", 2000)],
    from,
    to,
  );
  assert.equal(map.get(dayKey(t)), 40 * MIN);
});

test("events at or outside the bounds are ignored", () => {
  const from = at(2026, 10, 22, 0);
  const to = at(2026, 10, 24, 0);
  // A hold before fromMs does not open a spell (its opener lies outside the window).
  assert.equal(mainRedMinutesByDay([hold(from - HOUR)], from, to).size, 0);
  // A hold at fromMs opens a spell; a pass at toMs (excluded) does not close it, so it counts
  // to toMs; a hold after toMs opens nothing on its own.
  const open = at(2026, 10, 22, 10);
  const map = mainRedMinutesByDay([hold(open), check(to, "passed", 2000), hold(to + HOUR)], from, to);
  assert.equal(map.get(dayKey(open)), 14 * HOUR, "the open-day slice of the spell");
  assert.equal([...map.values()].reduce((a, b) => a + b, 0), to - open, "the open spell runs to toMs");
  assert.ok(!map.has(dayKey(to)), "the excluded pass at toMs days gain nothing");
});
