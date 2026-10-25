// --- src/report/report-main-red.ts: mainRedMinutesByDay ---
// Pure per-day main-red wall-clock from the main_check / main_red_hold trail G1 uses. Hand-built
// events in explicit local windows (no clock, no log) pin the spell-open/close and the
// day-split, matching the collector's own [fromMs, toMs) window rule.

import test from "node:test";
import assert from "node:assert/strict";
import { mainRedCulpritsByDay, mainRedFailingTestsByDay, mainRedMinutesByDay } from "../src/report/report-main-red.js";
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

test("mainRedFailingTestsByDay counts each red main_check's failing tests on its day", () => {
  const t = at(2026, 10, 22, 10);
  const from = new Date(2026, 9, 22, 0).getTime();
  const to = new Date(2026, 9, 24, 0).getTime();
  const map = mainRedFailingTestsByDay(
    [
      { ...check(t, "failed", 2000), failingTests: ["a", "b"] },
      { ...check(t + 5 * MIN, "failed", 2000), failingTests: ["a"] },
      { ...hold(t + 10 * MIN), failingTests: ["a", "hold"] },
      check(t + 20 * MIN, "passed", 2000),
      // durationMs 0 is a cached/inherited verdict — isRedMain ignores it, so its "c" is absent.
      { ...check(t + 25 * MIN, "failed", 0), failingTests: ["c"] },
      { ...check(at(2026, 10, 23, 9), "failed", 2000), failingTests: ["b"] },
      // An Object.prototype-named test (constructor) must count as its own OWN key — addTo
      // seeds it, where a bare `record[key] ?? 0` would take the inherited function and
      // string-concatenate the count.
      { ...check(at(2026, 10, 23, 9), "failed", 2000), failingTests: ["constructor", "constructor"] },
    ],
    from,
    to,
  );
  assert.deepEqual(map.get(dayKey(t)), { a: 3, b: 1, hold: 1 }, "the a-tests, b, and the hold's failing tests name the first day");
  assert.equal(map.get(dayKey(t))!.c, undefined, "the durationMs-0 check's 'c' contributes nothing");
  assert.deepEqual(map.get(dayKey(at(2026, 10, 23, 9))), { b: 1, constructor: 2 }, "the second day's [b] and the two constructor counts are its own record");
});

test("mainRedCulpritsByDay counts each main_culprit on its day", () => {
  const t = at(2026, 10, 22, 10);
  const from = new Date(2026, 9, 22, 0).getTime();
  const to = new Date(2026, 9, 24, 0).getTime();
  const culprit = (ts: number, commit: string, runner?: string) =>
    ({ type: "main_culprit", source: "t", ts, commit, ...(runner === undefined ? {} : { runner }) } as const);
  const map = mainRedCulpritsByDay(
    [
      // a runner names the merge as `<role> <shortSha>`.
      culprit(t, "abc1234567", "feature"),
      culprit(t + 5 * MIN, "abc1234567", "feature"), // same label counts twice on the first day
      // no runner → `merge <shortSha>`.
      culprit(t + 10 * MIN, "deadbeef9999"),
      // at exactly toMs is outside the window.
      culprit(to, "abcdef0123", "plan"),
      // a missing / empty / non-string commit contributes nothing.
      { type: "main_culprit", source: "t", ts: t + 20 * MIN },
      { type: "main_culprit", source: "t", ts: t + 21 * MIN, commit: "" },
      { type: "main_culprit", source: "t", ts: t + 22 * MIN, commit: 42 },
      // a main_check / main_red_hold contributes nothing (not main_culprit).
      { ...check(t + 25 * MIN, "failed", 2000), failingTests: ["a"] },
      { ...hold(t + 26 * MIN), failingTests: ["a"] },
      // a second day's culprits land on their own key.
      culprit(at(2026, 10, 23, 9), "feedcafe1234", "plan"),
    ],
    from,
    to,
  );
  assert.deepEqual(
    map.get(dayKey(t)),
    { "feature abc12345": 2, "merge deadbeef": 1 },
    "the runner and runner-less labels, with the runner doubling on the first day",
  );
  assert.deepEqual(map.get(dayKey(at(2026, 10, 23, 9))), { "plan feedcafe": 1 }, "the second day's own record");
  assert.equal(map.get(dayKey(to)), undefined, "the event at exactly toMs is excluded");
});

test("a torn failingTests list counts only its strings and a missing key adds nothing", () => {
  const t = at(2026, 10, 22, 10);
  const from = new Date(2026, 9, 22, 0).getTime();
  const to = new Date(2026, 9, 24, 0).getTime();
  const map = mainRedFailingTestsByDay(
    [
      { ...check(t, "failed", 2000), failingTests: ["ok", 7] },
      // A non-array failingTests (loose log) and a check with no failingTests key add nothing.
      { ...check(t + 5 * MIN, "failed", 2000), failingTests: { not: "an array" } },
      check(t + 10 * MIN, "failed", 2000),
    ],
    from,
    to,
  );
  assert.deepEqual(map.get(dayKey(t)), { ok: 1 });
  assert.equal(map.get(dayKey(t))![7 as unknown as string], undefined, "the non-string entry counts nothing");
});
