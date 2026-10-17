import test from "node:test";
import assert from "node:assert/strict";
import { drainInFlightWork, type AfterDelay } from "../src/tick/tick-timing.js";
import { writeMergeMarker, readMergeMarker } from "../src/merge/merge-slot.js";
import type { InFlightMerge } from "../src/merge/merge-pipeline.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { warningMessages } from "./fixtures/log-fixtures.js";
import { flushImmediate } from "./helpers/wait.js";

// drainInFlightWork is the shutdown drain's policy: on an operator stop it waits out the
// reserved ticks and every landing task unboundedly (the harness signal already aborted the
// landings), while on a restart it bounds the landing behind the hand-off and — when the
// landing is wedged past even the post-abort window — goes ahead WITHOUT waiting out the
// reserved ticks (an abandoned landing still holds its permit, so a waiter parked behind it
// would never settle). The abandoned path is the one that hangs the restart forever if the
// condition regresses, so its tick stands in as a promise that never settles under a test
// timeout: a regression fails the test instead of passing silently. The hand-off's deadlines
// come from the injected `AfterDelay` seam (scriptedTimers), so the verdict is crossed by hand
// and no assertion reads elapsed wall time.

/** A minimal in-flight landing whose promise the test controls. */
function landing(promise: Promise<void>, roles: string[]): InFlightMerge {
  return { promise, controller: new AbortController(), roles, userAborted: false };
}

/** A one-shot deadline scheduler the test fires by hand: `after` records each requested window
 * and its callback, its cancel drops a window that has not fired, and `fire` runs the oldest
 * pending one. `delays` is the assertion surface — the window is crossed on command, never
 * lived through, so host load cannot decide the verdict. */
function scriptedTimers(): {
  after: AfterDelay;
  delays: number[];
  fire(): void;
  pending(): number;
} {
  const pending: Array<() => void> = [];
  const delays: number[] = [];
  return {
    after: (ms, fn) => {
      delays.push(ms);
      pending.push(fn);
      return () => {
        const i = pending.indexOf(fn);
        if (i >= 0) pending.splice(i, 1);
      };
    },
    delays,
    fire: () => void pending.shift()?.(),
    pending: () => pending.length,
  };
}

test("drainInFlightWork on an operator stop waits out ticks and landings, announcing the landing", async () => {
  const root = tmpdir();
  let releaseTick!: () => void;
  let releaseLanding!: () => void;
  const tick = new Promise<void>((r) => (releaseTick = r));
  const task = new Promise<void>((r) => (releaseLanding = r));
  const timers = scriptedTimers();
  let aborts = 0;
  let returned = false;
  const drain = drainInFlightWork(root, new Set([tick]), new Set(), [landing(task, ["clean", "dedupe"])], false, 5_000, () => void aborts++, timers.after).then(() => (returned = true));
  await flushImmediate();
  assert.equal(returned, false, "the drain waits for the tick and the landing");
  assert.equal(timers.pending(), 0, "an operator stop arms no hand-off window");
  releaseTick();
  releaseLanding();
  await drain;
  assert.equal(aborts, 0, "an operator stop never aborts: the signal already did");
  const w = warningMessages(root);
  assert.equal(w.length, 1, "only the landing wait is announced");
  assert.match(w[0]!, /^shutdown waiting on the merge in progress for clean, dedupe$/);
});

test("drainInFlightWork on a restart with a landing inside its window waits out the ticks too", async () => {
  const root = tmpdir();
  let releaseTick!: () => void;
  let releaseLanding!: () => void;
  const tick = new Promise<void>((r) => (releaseTick = r));
  const task = new Promise<void>((r) => (releaseLanding = r));
  const timers = scriptedTimers();
  let aborts = 0;
  let returned = false;
  const drain = drainInFlightWork(root, new Set([tick]), new Set(), [landing(task, ["organize"])], true, 5_000, () => void aborts++, timers.after).then(() => (returned = true));
  assert.deepEqual(timers.delays, [5_000], "the landing gets one hand-off window");
  releaseLanding(); // finishes inside the hand-off window
  await flushImmediate();
  assert.equal(timers.pending(), 0, "a landing that finished inside its window clears the deadline");
  assert.equal(returned, false, "the restart still waits out the reserved tick");
  releaseTick();
  await drain;
  assert.equal(aborts, 0, "a landing inside its window is never aborted");
  const w = warningMessages(root);
  assert.equal(w.length, 1, "the hand-off's own wait announcement, not the shutdown one");
  assert.match(w[0]!, /^restart waiting on the merge in progress for organize/);
});

test("drainInFlightWork hands off without a wedged landing and without waiting on reserved ticks", { timeout: 5_000 }, async () => {
  const root = tmpdir();
  writeMergeMarker(root, { role: "clean", sha: "a".repeat(40), summary: "wedged", startedAt: Date.now(), stage: "build-check" });
  const timers = scriptedTimers();
  let aborts = 0;
  let returned = false;
  // Both stand-ins never settle: a landing wedged past its post-abort window, and a reserved
  // tick parked behind its permit. If the drain ever waits on the ticks here, the test times out.
  const never = new Promise<void>(() => {});
  const drain = drainInFlightWork(root, new Set([never]), new Set(), [landing(never, ["clean"])], true, 50, () => void aborts++, timers.after).then(() => (returned = true));
  assert.deepEqual(timers.delays, [50], "the first hand-off window is armed");
  assert.equal(returned, false, "the drain does not abandon before its deadline lapses");
  timers.fire(); // the first window lapses: the landing is aborted
  await flushImmediate();
  assert.equal(aborts, 1, "the hand-off aborted the wedged landing exactly once");
  assert.deepEqual(timers.delays, [50, 50], "the post-abort window is armed");
  timers.fire(); // the second window lapses: hand off without it
  await drain;
  assert.equal(returned, true, "the hand-off is bounded by two windows on the injected clock");
  assert.equal(readMergeMarker(root), null, "the exiting process's marker is cleared for the next generation");
  const w = warningMessages(root);
  assert.equal(w.length, 3, "wait, lapse, and abandon are each announced");
  assert.match(w[2]!, /the aborted merge for clean was still running 0\.05s later — restarting without it/);
});
