import test from "node:test";
import assert from "node:assert/strict";
import { drainInFlightWork, MERGE_ABORT_SETTLE_FLOOR_MS, type AfterDelay } from "../src/run/run-timing.js";
import { writeMergeMarker, readMergeMarker } from "../src/merge/merge-slot.js";
import type { InFlightMerge } from "../src/merge/merge-pipeline.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { warningMessages } from "./fixtures/log-fixtures.js";
import { flushImmediate } from "./helpers/wait.js";

// drainInFlightWork is the shutdown drain's policy: on an operator stop it waits out the
// reserved runs and every merge task unboundedly (the harness signal already aborted the
// merges), while on a restart it bounds the merge behind the hand-off and — when the
// merge is wedged past even the post-abort window — goes ahead WITHOUT waiting out the
// reserved runs (an abandoned merge still holds its permit, so a waiter parked behind it
// would never settle). The abandoned path is the one that hangs the restart forever if the
// condition regresses, so its run stands in as a promise that never settles under a test
// timeout: a regression fails the test instead of passing silently. The hand-off's deadlines
// come from the injected `AfterDelay` seam (scriptedTimers), so the verdict is crossed by hand
// and no assertion reads elapsed wall time.

/** A minimal in-flight merge whose promise the test controls. */
function merge(promise: Promise<void>, roles: string[]): InFlightMerge {
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

test("drainInFlightWork on an operator stop waits out runs and merges, announcing the merge", async () => {
  const root = tmpdir();
  let releaseRun!: () => void;
  let releaseMerge!: () => void;
  const inFlightRun = new Promise<void>((r) => (releaseRun = r));
  const task = new Promise<void>((r) => (releaseMerge = r));
  const timers = scriptedTimers();
  let aborts = 0;
  let returned = false;
  const drain = drainInFlightWork(root, new Set([inFlightRun]), new Set(), [merge(task, ["clean", "dedupe"])], false, 5_000, () => void aborts++, timers.after).then(() => (returned = true));
  await flushImmediate();
  assert.equal(returned, false, "the drain waits for the run and the merge");
  assert.equal(timers.pending(), 0, "an operator stop arms no hand-off window");
  releaseRun();
  releaseMerge();
  await drain;
  assert.equal(aborts, 0, "an operator stop never aborts: the signal already did");
  const w = warningMessages(root);
  assert.equal(w.length, 1, "only the merge wait is announced");
  assert.match(w[0]!, /^shutdown waiting on the merge in progress for clean, dedupe$/);
});

test("drainInFlightWork on a restart with a merge inside its window waits out the runs too", async () => {
  const root = tmpdir();
  let releaseRun!: () => void;
  let releaseMerge!: () => void;
  const inFlightRun = new Promise<void>((r) => (releaseRun = r));
  const task = new Promise<void>((r) => (releaseMerge = r));
  const timers = scriptedTimers();
  let aborts = 0;
  let returned = false;
  const drain = drainInFlightWork(root, new Set([inFlightRun]), new Set(), [merge(task, ["organize"])], true, 5_000, () => void aborts++, timers.after).then(() => (returned = true));
  assert.deepEqual(timers.delays, [5_000], "the merge gets one hand-off window");
  releaseMerge(); // finishes inside the hand-off window
  await flushImmediate();
  assert.equal(timers.pending(), 0, "a merge that finished inside its window clears the deadline");
  assert.equal(returned, false, "the restart still waits out the reserved run");
  releaseRun();
  await drain;
  assert.equal(aborts, 0, "a merge inside its window is never aborted");
  const w = warningMessages(root);
  assert.equal(w.length, 1, "the hand-off's own wait announcement, not the shutdown one");
  assert.match(w[0]!, /^restart waiting on the merge in progress for organize/);
});

test("drainInFlightWork hands off without a wedged merge and without waiting on reserved runs", { timeout: 5_000 }, async () => {
  const root = tmpdir();
  writeMergeMarker(root, { role: "clean", sha: "a".repeat(40), summary: "wedged", startedAt: Date.now(), stage: "build-check" });
  const timers = scriptedTimers();
  let aborts = 0;
  let returned = false;
  // Both stand-ins never settle: a merge wedged past its post-abort window, and a reserved
  // run parked behind its permit. If the drain ever waits on the runs here, the test times out.
  const never = new Promise<void>(() => {});
  const drain = drainInFlightWork(root, new Set([never]), new Set(), [merge(never, ["clean"])], true, 50, () => void aborts++, timers.after).then(() => (returned = true));
  assert.deepEqual(timers.delays, [50], "the first hand-off window is armed");
  assert.equal(returned, false, "the drain does not abandon before its deadline lapses");
  timers.fire(); // the first window lapses: the merge is aborted
  await flushImmediate();
  assert.equal(aborts, 1, "the hand-off aborted the wedged merge exactly once");
  assert.deepEqual(
    timers.delays,
    [50, MERGE_ABORT_SETTLE_FLOOR_MS],
    "the abort's settle window is the floor, not the tiny deadline (BUGS.md 2026-10-26)",
  );
  timers.fire(); // the second window lapses: hand off without it
  await drain;
  assert.equal(returned, true, "the hand-off is bounded by two windows on the injected clock");
  assert.equal(readMergeMarker(root), null, "the exiting process's marker is cleared for the next generation");
  const w = warningMessages(root);
  assert.equal(w.length, 3, "wait, lapse, and abandon are each announced");
  assert.match(w[2]!, /the aborted merge for clean was still running 10s later — restarting without it/);
});
