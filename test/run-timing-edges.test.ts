import test from "node:test";
import assert from "node:assert/strict";
import { drainInFlightWork } from "../src/run/run-timing.js";
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
