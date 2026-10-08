import { sleep, within } from "./helpers/wait.js";
import test from "node:test";
import assert from "node:assert/strict";

import { abortOnShutdown, acquireUnlessAborted } from "../src/landing/landing-pipeline.js";
import { Semaphore } from "../src/concurrency/semaphore.js";

// Unit-tier coverage for the landing pipeline's two shutdown seams (src/landing/landing-pipeline.ts):
// the wiring that turns the harness stop into a landing task's own abort, and the
// permit-taking race that lets a parked vet lose its grant to a shutdown without leaking the
// permit. Both run in every shutdown of every fleet (landing-drain.ts and landing-vetting.ts
// call them for every task), and both carry a documented edge a naive version gets wrong — an
// already-aborted signal that addEventListener alone would never fire; a grant that arrives
// after the abort and must be handed straight back ("a hop, never a leak") or maxConcurrent
// starves by one permit per aborted vet. Until now both ran only under the e2e tier, which
// the gating `npm test` never executes, so a wiring slip here would pass the gate.

/** Flush the microtasks (and the auto-release callback) a resolved waiter chain needs. */
function settle(): Promise<void> {
  return sleep(0);
}

test("abortOnShutdown aborts an already-aborted signal's task controller at once", () => {
  // The documented regression: a listener added after the event never runs, so a task wired
  // during a drain that has already begun would tick or review on past the stop.
  const controller = new AbortController();
  abortOnShutdown(AbortSignal.abort(), controller);
  assert.equal(controller.signal.aborted, true, "the pre-fired stop reaches the task synchronously");
});

test("abortOnShutdown wires a live signal through, and the wiring is one-shot", () => {
  const harness = new AbortController();
  const task = new AbortController();
  abortOnShutdown(harness.signal, task);
  assert.equal(task.signal.aborted, false, "a live signal leaves the task running");
  harness.abort();
  assert.equal(task.signal.aborted, true, "the harness stop reaches the task");
  // An abort event fires once; the { once: true } listener must not pile up or re-fire.
  harness.abort();
  assert.equal(task.signal.aborted, true);
});

test("acquireUnlessAborted returns null for an already-aborted signal and takes no permit", async () => {
  const semaphore = new Semaphore(1);
  const release = await acquireUnlessAborted(semaphore, 0, AbortSignal.abort());
  assert.equal(release, null, "no release function for a run that never started");
  // The permit was never taken: a plain acquire on the fresh semaphore resolves at once
  // (capacity 1 — a leaked permit would park this acquire forever, and within() would read false).
  assert.ok(await within(semaphore.acquire(0)), "no permit was taken by the aborted entry");
});

test("acquireUnlessAborted grants a free permit and its release hands it back", async () => {
  const semaphore = new Semaphore(1);
  const release = await acquireUnlessAborted(semaphore, 0, new AbortController().signal);
  assert.ok(release, "a free permit is granted");
  // The grant is counted against the cap: a second acquirer parks until the release.
  let second = false;
  void semaphore.acquire(1).then(() => (second = true));
  await settle();
  assert.equal(second, false, "the cap holds while the vet holds its permit");
  release();
  await settle();
  assert.equal(second, true, "the release hands the permit to the parked waiter");
});

test("an abort while parked resolves null, and a grant that arrives later is handed straight back", async () => {
  // The race the seam exists for: a vet parks on a saturated maxConcurrent, the shutdown
  // fires while it waits, and the permit it was queued for is granted anyway the moment the
  // holder finishes. Without the hand-back, that grant is lost — every aborted vet would
  // shrink the fleet's real concurrency by one.
  const semaphore = new Semaphore(1);
  await semaphore.acquire(0); // the permit a mid-tick author holds
  const harness = new AbortController();
  const parked = acquireUnlessAborted(semaphore, 0, harness.signal);
  let settled = false;
  void parked.then(() => (settled = true));
  await settle();
  assert.equal(settled, false, "still parked while the permit is held");

  harness.abort();
  assert.equal(await parked, null, "the abort wins the race against the held permit");

  // The holder finishes: the queued acquire's grant resolves and must hand itself straight
  // back — after which the semaphore reads as fully free again.
  semaphore.release();
  await settle();
  assert.ok(await within(semaphore.acquire(0)), "the late grant was handed back, not leaked");
});

test("a permit granted before the abort keeps its normal release — the abort does not double-release", async () => {
  const semaphore = new Semaphore(1);
  const controller = new AbortController();
  const release = await acquireUnlessAborted(semaphore, 0, controller.signal);
  assert.ok(release);
  controller.abort(); // the stop lands after the grant: the vet is already running
  release(); // the task's own finally still releases exactly once
  await settle();
  assert.ok(await within(semaphore.acquire(0)), "exactly one release: the permit is free again");
});
