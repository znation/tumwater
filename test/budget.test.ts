import test from "node:test";
import assert from "node:assert/strict";
import { freshLoopState } from "../src/state.js";
import {
  budgetGate,
  budgetPaused,
  budgetReached,
  dailyCost,
  fleetDailyCost,
  recordDailyCost,
  todayStamp,
} from "../src/budget.js";
import { defaultConfig } from "../src/config.js";

/** Two local-time timestamps straddling midnight, built with the local Date constructor so
 * the test holds in any timezone: dayA is an evening, dayB just after local midnight. */
function midnightPair(): { dayA: number; dayB: number } {
  return {
    dayA: new Date(2026, 7, 30, 20, 0, 0).getTime(), // Aug 30, 8 pm local
    dayB: new Date(2026, 7, 31, 0, 0, 1).getTime(), // Aug 31, just after midnight
  };
}

test("recordDailyCost accumulates same-day spend and rolls over at local midnight on write", () => {
  const s = freshLoopState("feature");
  const { dayA, dayB } = midnightPair();

  recordDailyCost(s, 1.5, dayA); // first run of the day (fresh state: no stamp yet)
  assert.equal(s.dayStamp, todayStamp(dayA));
  assert.equal(s.dayCostUsd, 1.5);

  recordDailyCost(s, 0.25, dayA + 3_600_000); // an hour later, same local day
  assert.equal(s.dayStamp, todayStamp(dayA));
  assert.equal(s.dayCostUsd, 1.75);

  // A tick that crosses midnight attributes its spend to the NEW day: the window resets
  // first, so yesterday's $1.75 cannot leak into today's budget (or vice versa).
  recordDailyCost(s, 0.5, dayB);
  assert.equal(s.dayStamp, todayStamp(dayB));
  assert.notEqual(s.dayStamp, todayStamp(dayA));
  assert.equal(s.dayCostUsd, 0.5);
});

test("dailyCost reads $0 for a stale or missing stamp and the window's value when fresh", () => {
  const s = freshLoopState("feature"); // dayStamp "" — never ticked
  assert.equal(dailyCost(s), 0);

  const { dayA, dayB } = midnightPair();
  recordDailyCost(s, 2.5, dayA);
  assert.equal(dailyCost(s, dayA), 2.5); // fresh: the window's value
  assert.equal(dailyCost(s, dayB), 0); // read "tomorrow": stale → $0

  // Reads never mutate — a stale read must not reset or touch the recorded window.
  assert.equal(s.dayStamp, todayStamp(dayA));
  assert.equal(s.dayCostUsd, 2.5);
});

test("fleetDailyCost sums every loop's daily window with stale ones reading $0", () => {
  const { dayA, dayB } = midnightPair();
  const a = freshLoopState("feature");
  recordDailyCost(a, 1.25, dayA); // spent on day A
  const b = freshLoopState("clean"); // never ticked: missing stamp → $0
  const c = freshLoopState("dry");
  recordDailyCost(c, 0.75, dayB); // spent on day B only

  assert.equal(fleetDailyCost([a, b, c], dayA), 1.25);
  assert.equal(fleetDailyCost([a, b, c], dayB), 0.75);
  assert.equal(fleetDailyCost([], dayA), 0);
});

test("budgetPaused is false at cap 0 (disabled) and below the cap, true at/above it", () => {
  const s = freshLoopState("feature");
  const { dayA, dayB } = midnightPair();
  recordDailyCost(s, 10, dayA);

  const cfg = defaultConfig(); // maxDailyCostUsd: 50
  assert.equal(budgetPaused([s], cfg, dayA), false); // $10 < $50

  cfg.maxDailyCostUsd = 10;
  assert.equal(budgetPaused([s], cfg, dayA), true); // exactly at the cap (>=)

  cfg.maxDailyCostUsd = 9.99;
  assert.equal(budgetPaused([s], cfg, dayA), true); // above it

  cfg.maxDailyCostUsd = 0;
  assert.equal(budgetPaused([s], cfg, dayA), false); // 0 disables the budget entirely

  // A stale window reads $0: a fleet that hasn't ticked since yesterday is never paused.
  const other = freshLoopState("clean");
  recordDailyCost(other, 100, dayB);
  cfg.maxDailyCostUsd = 1;
  assert.equal(budgetPaused([other], cfg, dayA), false);
});

test("budgetGate: reached with a free fallback keeps loops running, without one pauses them", () => {
  // The two facts the gate is made of (plans/fallback-model.md). Under the cap nothing else
  // matters — a configured fallback does not take over while there is budget left.
  assert.equal(budgetGate(false, false), "open");
  assert.equal(budgetGate(false, true), "open");
  // At the cap the fallback decides whether the fleet degrades or stops. Only "paused" blocks
  // a tick, which is why this had to stop being a boolean.
  assert.equal(budgetGate(true, true), "fallback");
  assert.equal(budgetGate(true, false), "paused");
});

test("budgetReached is false for a disabled (null) or under-cap view, true at/above the cap", () => {
  assert.equal(budgetReached(null), false); // null = budget disabled
  assert.equal(budgetReached({ spentUsd: 10, capUsd: 50 }), false); // below the cap
  assert.equal(budgetReached({ spentUsd: 50, capUsd: 50 }), true); // exactly at the cap (>=)
  assert.equal(budgetReached({ spentUsd: 50.01, capUsd: 50 }), true); // above it
});
