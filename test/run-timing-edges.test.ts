import test from "node:test";
import assert from "node:assert/strict";
import { drainInFlightWork, MERGE_ABORT_SETTLE_FLOOR_MS } from "../src/run/run-timing.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { warningMessages } from "./fixtures/log-fixtures.js";
import { flushImmediate, scriptedTimers } from "./helpers/wait.js";
import { standInMerge } from "./fixtures/merge-fixtures.js";
import { errnoError, patchFsMethod } from "./helpers/fs-faults.js";

// A run-timing guarantee the neighbouring files do not catch breaking: a restart's hand-off
// folds every merge task into one wait that names all their roles.

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
    [standInMerge(t1, ["clean"]), standInMerge(t2, ["dedupe"])],
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

test("a restart stops an in-flight post-merge review at once and keeps its hand-off window for the merge", async () => {
  // The 2026-11-21 waste: a post-merge review — which lands nothing until its verdict — sat out
  // the whole hand-off window, was aborted, and started over in a fresh session. The hand-off
  // stops it at its own controller instead of waiting, and arms no hand-off window for it.
  const root = tmpdir();
  let resolveReview!: () => void;
  let resolveMerge!: () => void;
  const review = { ...standInMerge(new Promise<void>((r) => (resolveReview = r)), ["improve"]), review: true };
  const mergeTask = standInMerge(new Promise<void>((r) => (resolveMerge = r)), ["clean"]);
  const timers = scriptedTimers();
  let aborts = 0;
  const drain = drainInFlightWork(root, new Set(), new Set(), [review, mergeTask], true, 5_000, () => void aborts++, timers.after);
  assert.deepEqual(
    timers.delays,
    [MERGE_ABORT_SETTLE_FLOOR_MS, 5_000],
    "the review is armed only its abort-settle floor; the merge keeps the hand-off window",
  );
  assert.equal(review.controller.signal.aborted, true, "the review is stopped as the hand-off begins");
  assert.equal(mergeTask.controller.signal.aborted, false, "the merge is not aborted before its window");
  assert.equal(aborts, 0, "the review's stop fires its own controller, never the caller's internal stop");
  resolveReview();
  resolveMerge();
  await drain;
  assert.equal(timers.pending(), 0, "both windows were cleared on settle");
  const w = warningMessages(root);
  assert.equal(w.length, 2, "the review stop is announced alongside the merge wait");
  assert.match(w[0]!, /^restart: the post-merge review for improve lands nothing, so it stops at once/);
  assert.match(w[1]!, /^restart waiting on the merge in progress for clean \(deadline 5s\)$/);
});

test("a restart hands off without waiting on a review run wedged past its abort-settle floor", async () => {
  // A reviewer run that ignores its abort cannot hold the hand-off open: the review is left
  // behind exactly as a crash leaves it — its entry stays queued, uncounted, for the next drain.
  const root = tmpdir();
  const review = { ...standInMerge(new Promise<void>(() => {}), ["feature"]), review: true };
  const timers = scriptedTimers();
  const drain = drainInFlightWork(root, new Set(), new Set(), [review], true, 5_000, () => {}, timers.after);
  assert.deepEqual(timers.delays, [MERGE_ABORT_SETTLE_FLOOR_MS], "the wedged review gets the settle floor, not a hand-off window");
  assert.equal(review.controller.signal.aborted, true);
  timers.fire(); // the floor lapses with the run still wedged
  await drain;
  assert.equal(timers.pending(), 0, "the hand-off armed nothing else behind the wedged review");
});

/** Make every append to an events feed fail with ENOSPC; returns the undo. */
function unwritableEventsFeed(): () => void {
  return patchFsMethod("appendFileSync", (orig) => (file, ...rest) => {
    if (typeof file === "string" && file.endsWith("events.jsonl")) throw errnoError("ENOSPC");
    return (orig as (...a: unknown[]) => unknown)(file, ...rest);
  });
}

test("an operator stop with an unwritable events feed still waits out the merge before it returns", async () => {
  const root = tmpdir();
  let resolveTask!: () => void;
  const task = new Promise<void>((r) => (resolveTask = r));
  const undo = unwritableEventsFeed();
  try {
    let settled = false;
    const drain = drainInFlightWork(root, new Set(), new Set(), [standInMerge(task, ["clean"])], false, 5_000, () => {}).then(
      () => (settled = true),
    );
    await flushImmediate();
    assert.equal(settled, false, "the unwritable feed did not end the drain before the merge settled");
    resolveTask();
    await drain;
  } finally {
    undo();
  }
});

test("a restart's hand-off with an unwritable events feed still aborts past its window and resolves", async () => {
  const root = tmpdir();
  let resolveTask!: () => void;
  const task = new Promise<void>((r) => (resolveTask = r));
  const timers = scriptedTimers();
  let aborts = 0;
  const undo = unwritableEventsFeed();
  try {
    const drain = drainInFlightWork(
      root,
      new Set(),
      new Set(),
      [standInMerge(task, ["clean"])],
      true,
      50,
      () => void aborts++,
      timers.after,
    );
    timers.fire();
    await flushImmediate();
    assert.equal(aborts, 1);
    resolveTask();
    await drain;
  } finally {
    undo();
  }
});
