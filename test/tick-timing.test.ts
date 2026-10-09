import test from "node:test";
import assert from "node:assert/strict";
import { drainInFlightWork } from "../src/tick/tick-timing.js";
import { writeLandingMarker, readLandingMarker } from "../src/landing/landing-slot.js";
import type { InFlightLanding } from "../src/landing/landing-pipeline.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { warningMessages } from "./fixtures/log-fixtures.js";

// drainInFlightWork is the shutdown drain's policy: on an operator stop it waits out the
// reserved ticks and every landing task unboundedly (the harness signal already aborted the
// landings), while on a restart it bounds the landing behind the hand-off and — when the
// landing is wedged past even the post-abort window — goes ahead WITHOUT waiting out the
// reserved ticks (an abandoned landing still holds its permit, so a waiter parked behind it
// would never settle). The abandoned path is the one that hangs the restart forever if the
// condition regresses, so its tick stands in as a promise that never settles under a test
// timeout: a regression fails the test instead of passing silently.

/** A minimal in-flight landing whose promise the test controls. */
function landing(promise: Promise<void>, roles: string[]): InFlightLanding {
  return { promise, controller: new AbortController(), roles, userAborted: false };
}

test("drainInFlightWork on an operator stop waits out ticks and landings, announcing the landing", async () => {
  const root = tmpdir();
  let tickSettledAt = 0;
  let landingSettledAt = 0;
  let aborts = 0;
  const tick = new Promise<void>((r) => setTimeout(() => ((tickSettledAt = Date.now()), r()), 30));
  const task = new Promise<void>((r) => setTimeout(() => ((landingSettledAt = Date.now()), r()), 20));
  await drainInFlightWork(root, new Set([tick]), new Set(), [landing(task, ["clean", "dry"])], false, 5_000, () => void aborts++);
  assert.equal(aborts, 0, "an operator stop never aborts: the signal already did");
  // Settled-before-return, not elapsed wall time: the timers start before any "now" the test
  // could read, so an elapsed check races the clock (it read 29 ms of a 30 ms tick in CI).
  assert.ok(tickSettledAt > 0, "the drain waited out the reserved tick");
  assert.ok(landingSettledAt > 0, "the drain waited out the landing");
  const w = warningMessages(root);
  assert.equal(w.length, 1, "only the landing wait is announced");
  assert.match(w[0]!, /^shutdown waiting on the in-flight landing of clean, dry$/);
});

test("drainInFlightWork on a restart with a landing inside its window waits out the ticks too", async () => {
  const root = tmpdir();
  let tickSettledAt = 0;
  let aborts = 0;
  const tick = new Promise<void>((r) => setTimeout(() => ((tickSettledAt = Date.now()), r()), 40));
  const task = new Promise<void>((r) => setTimeout(r, 10)); // finishes inside the hand-off window
  await drainInFlightWork(root, new Set([tick]), new Set(), [landing(task, ["organize"])], true, 5_000, () => void aborts++);
  assert.equal(aborts, 0, "a landing inside its window is never aborted");
  assert.ok(tickSettledAt > 0, "the restart still waits out reserved ticks that settled");
  const w = warningMessages(root);
  assert.equal(w.length, 1, "the hand-off's own wait announcement, not the shutdown one");
  assert.match(w[0]!, /^restart hand-off waiting on the in-flight landing of organize/);
});

test("drainInFlightWork hands off without a wedged landing and without waiting on reserved ticks", { timeout: 5_000 }, async () => {
  const root = tmpdir();
  writeLandingMarker(root, { role: "clean", sha: "a".repeat(40), summary: "wedged", startedAt: Date.now(), stage: "build-check" });
  let aborts = 0;
  // Both stand-ins never settle: a landing wedged past its post-abort window, and a reserved
  // tick parked behind its permit. If the drain ever waits on the ticks here, the test times out.
  const never = new Promise<void>(() => {});
  const startedAt = Date.now();
  await drainInFlightWork(root, new Set([never]), new Set(), [landing(never, ["clean"])], true, 50, () => void aborts++);
  const elapsed = Date.now() - startedAt;
  assert.equal(aborts, 1, "the hand-off aborted the wedged landing exactly once");
  assert.ok(elapsed >= 100 && elapsed < 5_000, `the drain is bounded by two hand-off windows (${elapsed}ms)`);
  assert.equal(readLandingMarker(root), null, "the exiting process's marker is cleared for the next generation");
  const w = warningMessages(root);
  assert.equal(w.length, 3, "wait, lapse, and abandon are each announced");
  assert.match(w[2]!, /the aborted landing of clean was still running 0\.05s later — handing off without it/);
});
