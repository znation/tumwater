import test from "node:test";
import assert from "node:assert/strict";
import { drainInFlightWork, type AfterDelay } from "../src/run/run-timing.js";
import type { InFlightMerge } from "../src/merge/merge-pipeline.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { warningMessages } from "./fixtures/log-fixtures.js";
import { flushImmediate } from "./helpers/wait.js";

// A run-timing guarantee the neighbouring files do not catch breaking: a restart's hand-off
// folds every merge task into one wait that names all their roles.

/** A minimal in-flight merge whose promise the test controls. */
function merge(promise: Promise<void>, roles: string[]): InFlightMerge {
  return { promise, controller: new AbortController(), roles, userAborted: false };
}

/** A one-shot deadline scheduler the test fires by hand (see test/run-timing.test.ts). */
function scriptedTimers(): { after: AfterDelay; delays: number[]; pending(): number } {
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
    pending: () => pending.length,
  };
}

test("a restart's hand-off waits for every merge task and names all their roles", async () => {
  const root = tmpdir();
  let resolve1!: () => void;
  let resolve2!: () => void;
  const t1 = new Promise<void>((r) => (resolve1 = r));
  const t2 = new Promise<void>((r) => (resolve2 = r));
  const timers = scriptedTimers();
  let aborts = 0;
  let returned = false;
  const drain = drainInFlightWork(
    root,
    new Set(),
    new Set(),
    [merge(t1, ["clean"]), merge(t2, ["dedupe"])],
    true,
    5_000,
    () => void aborts++,
    timers.after,
  ).then(() => (returned = true));
  assert.deepEqual(timers.delays, [5_000]);
  resolve1();
  await flushImmediate();
  assert.equal(returned, false, "one merge task finishing does not end the hand-off");
  assert.equal(timers.pending(), 1, "the window stays armed for the second task");
  resolve2();
  await drain;
  assert.equal(aborts, 0);
  assert.equal(timers.pending(), 0);
  const w = warningMessages(root);
  assert.equal(w.length, 1);
  assert.match(w[0]!, /^restart waiting on the merge in progress for clean, dedupe \(deadline 5s\)$/);
});
