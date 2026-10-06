/** backoff (src/backoff.ts): the loop's CLOCK policy — pure functions, no I/O, so every
 * rule here is tested directly: the wake levers (clearBackoff, restoreMidTickWake), the
 * yield-scaled clock (pushYieldOutcome's ring, yieldMultiplier's ladder), and the backoff
 * ladders (nextBackoffSeconds, scheduleBackoff, ERROR_BACKOFF's minutes-not-hours cap). */

import test from "node:test";
import assert from "node:assert/strict";

import {
  clearBackoff,
  restoreMidTickWake,
  pushYieldOutcome,
  yieldMultiplier,
  YIELD_RING,
  nextBackoffSeconds,
  scheduleBackoff,
  scheduleAtMinInterval,
  ERROR_BACKOFF,
} from "../src/backoff.js";
import { freshLoopState } from "../src/loop/loop-state.js";

function ladder(initialSeconds = 30, factor = 2, maxSeconds = 600) {
  return { initialSeconds, factor, maxSeconds };
}

test("clearBackoff: zeroes the ladder, pulls nextRunAt to now, stamps wokenAt, preserves everything else", () => {
  const s = freshLoopState("docs");
  s.backoffSeconds = 3600;
  s.nextRunAt = 1_000;
  s.recentOutcomes = "Lnnn";
  const before = { ...s };
  const now = 5_000_000;

  const cleared = clearBackoff(s, now);

  assert.equal(cleared.backoffSeconds, 0);
  assert.equal(cleared.nextRunAt, now);
  assert.equal(cleared.wokenAt, now);
  // Counters, wake tracking, and the last-result fields survive untouched.
  assert.equal(cleared.recentOutcomes, before.recentOutcomes);
  assert.equal(cleared.lastMainHead, before.lastMainHead);
  assert.deepEqual(
    cleared,
    { ...before, backoffSeconds: 0, nextRunAt: now, wokenAt: now },
  );
});

test("restoreMidTickWake: no wake recorded — reports false, leaves the schedule alone", () => {
  const s = freshLoopState("tests");
  s.lastTickStartedAt = 1_000;
  s.lastTickEndedAt = 2_000;
  s.nextRunAt = 62_000;
  s.backoffSeconds = 60;

  assert.equal(restoreMidTickWake(s), false);
  assert.equal(s.nextRunAt, 62_000);
  assert.equal(s.backoffSeconds, 60);
  assert.equal(s.wokenAt, undefined);
});

test("restoreMidTickWake: a wake older than the tick's start was already honored — not restored", () => {
  const s = freshLoopState("tests");
  s.lastTickStartedAt = 1_000;
  s.wokenAt = 1_000; // tie with the tick's start: the ordinary self-clearing must hold
  assert.equal(restoreMidTickWake(s), false);

  s.wokenAt = 999;
  assert.equal(restoreMidTickWake(s), false);
});

test("restoreMidTickWake: a cut-off tick's resumePending deliberately blocks the wake shortcut", () => {
  const s = freshLoopState("tests");
  s.lastTickStartedAt = 1_000;
  s.wokenAt = 1_500;
  s.resumePending = true;
  assert.equal(restoreMidTickWake(s), false);
  assert.equal(s.wokenAt, 1_500); // untouched
});

test("restoreMidTickWake: live wake re-applied — backoff cleared, nextRunAt re-stamped past the end", () => {
  const now = Date.now();
  const s = freshLoopState("tests");
  s.lastTickStartedAt = now - 10_000;
  s.lastTickEndedAt = now - 5_000;
  s.wokenAt = now - 3_000; // woke mid-tick
  s.backoffSeconds = 600;
  s.nextRunAt = now + 600_000; // applyTickOutcome scheduled a fresh backoff out

  assert.equal(restoreMidTickWake(s), true);
  assert.equal(s.backoffSeconds, 0);
  assert.equal(s.wokenAt, s.nextRunAt); // clearBackoff stamped both to the same now
  assert.ok(s.nextRunAt > s.lastTickEndedAt, "wake must read newer than the end stamp");
});

test("restoreMidTickWake: an end stamp in the future wins the max — wokenAt lands just past it", () => {
  const s = freshLoopState("tests");
  s.lastTickStartedAt = 1_000;
  s.lastTickEndedAt = Date.now() + 60_000; // clock skew / fast tick
  s.wokenAt = 2_000;

  assert.equal(restoreMidTickWake(s), true);
  assert.equal(s.nextRunAt, s.lastTickEndedAt + 1);
  assert.equal(s.wokenAt, s.lastTickEndedAt + 1);
});

test("pushYieldOutcome: landings are L, everything productive-or-empty is n, error classes never enter the ring", () => {
  const s = freshLoopState("feature");
  pushYieldOutcome(s, "changed");
  pushYieldOutcome(s, "queued");
  pushYieldOutcome(s, "no_change");
  pushYieldOutcome(s, "error");
  pushYieldOutcome(s, "aborted");
  pushYieldOutcome(s, "quiet_killed");
  assert.equal(s.recentOutcomes, "LLn");
});

test("pushYieldOutcome: the ring is bounded at YIELD_RING, oldest entries fall off", () => {
  const s = freshLoopState("feature");
  for (let i = 0; i < YIELD_RING + 5; i++) pushYieldOutcome(s, "no_change");
  assert.equal(s.recentOutcomes?.length, YIELD_RING);
  assert.equal(s.recentOutcomes, "n".repeat(YIELD_RING));
});

test("yieldMultiplier: a landing inside the recent window resets the clock to 1 even with older empties", () => {
  // 15 empties would earn ×4 — but a landing inside the last 10 is the evidence the
  // role's clock should trust, so the older empties count for nothing while it's recent.
  assert.equal(yieldMultiplier(("n".repeat(15) + "L" + "n".repeat(9)).split("")), 1);
  assert.equal(yieldMultiplier("nnnLnnnnn".split("")), 1);
});

test("yieldMultiplier: below 10 empties the gap is unchanged", () => {
  assert.equal(yieldMultiplier([]), 1);
  assert.equal(yieldMultiplier("nnnnnnnnn".split("")), 1);
});

test("yieldMultiplier: doubling per 5 further empty ticks, capped at 8", () => {
  assert.equal(yieldMultiplier("n".repeat(10).split("")), 2);
  assert.equal(yieldMultiplier("n".repeat(14).split("")), 2);
  assert.equal(yieldMultiplier("n".repeat(15).split("")), 4);
  assert.equal(yieldMultiplier("n".repeat(20).split("")), 8);
  assert.equal(yieldMultiplier("n".repeat(40).split("")), 8);
});

test("yieldMultiplier: a landing older than the recent window counts as yield evidence neither way", () => {
  // One L aged out of the recent window plus 10 empties: the L is excluded from the empty
  // count, so the multiplier climbs on the empties alone.
  const ring = "L" + "n".repeat(10);
  assert.equal(ring.length, 11);
  assert.equal(yieldMultiplier(ring.split("")), 2);
  // And one aged-out landing among 11 empties does not hold the clock down either.
  assert.equal(yieldMultiplier(("L" + "n".repeat(11)).split("")), 2);
});

test("nextBackoffSeconds: the first step is the (capped) initial, later steps multiply up to the cap", () => {
  const cfg = ladder(30, 2, 100);
  assert.equal(nextBackoffSeconds(0, cfg), 30);
  assert.equal(nextBackoffSeconds(30, cfg), 60);
  assert.equal(nextBackoffSeconds(60, cfg), 100);
  assert.equal(nextBackoffSeconds(100, cfg), 100); // pinned at the cap
  // An initial larger than the cap is capped immediately.
  assert.equal(nextBackoffSeconds(0, ladder(500, 2, 100)), 100);
});

test("scheduleBackoff: advances from the state's current seconds, not from the ladder's bottom", () => {
  const s = freshLoopState("docs");
  s.backoffSeconds = 300;
  const before = Date.now();

  scheduleBackoff(s, ladder(30, 2, 600));

  assert.equal(s.backoffSeconds, 600);
  assert.ok(s.nextRunAt >= before + 600_000);
  assert.ok(s.nextRunAt <= Date.now() + 600_000 + 50);
});

test("ERROR_BACKOFF: one broken git costs minutes, never the idle ladder's hours", () => {
  assert.ok(ERROR_BACKOFF.maxSeconds < 3600);
  let seconds = 0;
  const climbs: number[] = [];
  for (let i = 0; i < 8; i++) {
    seconds = nextBackoffSeconds(seconds, ERROR_BACKOFF);
    climbs.push(seconds);
  }
  assert.deepEqual(climbs, [30, 60, 120, 240, 480, 600, 600, 600]);
});

test("scheduleAtMinInterval: the productive-side cadence is the role's own min interval", () => {
  const s = freshLoopState("readme");
  const before = Date.now();

  scheduleAtMinInterval(s, { minTickIntervalSeconds: 120 });

  assert.ok(s.nextRunAt >= before + 120_000);
  assert.ok(s.nextRunAt <= Date.now() + 120_000 + 50);
  assert.equal(s.backoffSeconds, 0); // untouched: the productive side never climbs a ladder
});
