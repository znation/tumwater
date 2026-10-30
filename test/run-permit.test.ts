/** Unit tests for the run-permit store (src/concurrency/run-permit.ts), the AsyncLocalStorage
 * that carries a run's lease across its work so an idle stretch inside it (a failed review's
 * in-place retry pause) can hand the team permit back and re-take it. These pin the properties
 * a unit test is meant to hold: an idle wait with no lease in context is a no-op, and an idle
 * wait inside a lease runs without the lease's permit, takes it back after, while an aborted
 * wait takes nothing back. */
import test from "node:test";
import assert from "node:assert/strict";

import { Semaphore } from "../src/concurrency/semaphore.js";
import { idleWithoutPermit, withRunPermit } from "../src/concurrency/run-permit.js";

test("idleWithoutPermit runs the wait without the lease's permit, then takes it back", async () => {
  const semaphore = new Semaphore(1);
  const lease = await semaphore.acquireLease(0);
  await withRunPermit(lease, async () => {
    await idleWithoutPermit(async () => {
      assert.equal(semaphore.snapshot().inUse, 0, "nothing is held during the wait");
    });
    assert.equal(semaphore.snapshot().inUse, 1, "the permit is held again after it");
  });
  lease.release();
  assert.equal(semaphore.snapshot().inUse, 0);
});

test("idleWithoutPermit just waits without a lease in context, and takes nothing back once aborted", async () => {
  let waited = false;
  await idleWithoutPermit(async () => {
    waited = true;
  });
  assert.equal(waited, true, "no lease in context: the wait still runs");

  const semaphore = new Semaphore(1);
  const lease = await semaphore.acquireLease(0);
  const controller = new AbortController();
  await withRunPermit(lease, async () => {
    // A parked run takes the permit during the wait; once aborted, the lease must not queue for it.
    const other = semaphore.acquireLease(0);
    await idleWithoutPermit(async () => {
      controller.abort();
    }, controller.signal);
    (await other).release();
  });
  assert.equal(semaphore.snapshot().inUse, 0, "the aborted lease took nothing back");
  lease.release();
  assert.equal(semaphore.snapshot().inUse, 0, "and releasing it owes nothing");
});

test("idleWithoutPermit re-takes the permit via resume when the signal never fires", async () => {
  // The non-abort round-trip: a lease in context with a signal that is never aborted must
  // hand the permit back during the wait and then resume through untilAborted (the abort
  // listener's `Promise.race([p, aborted])` resolving on `p`, not the listener), rather
  // than shortcut line 29's `signal?.aborted` early return the way the aborted-during-wait
  // test above does.
  const semaphore = new Semaphore(2);
  const lease = await semaphore.acquireLease(0);
  const signal = new AbortController().signal;
  await withRunPermit(lease, async () => {
    // A second lease parks one permit, so resume() must queue behind it; the non-aborted
    // signal still races the park's promise and takes the permit back once it frees up.
    const parked = semaphore.acquireLease(0);
    await idleWithoutPermit(async () => {
      assert.equal(semaphore.snapshot().inUse, 1, "the wait holds only the parked lease, not this one");
    }, signal);
    // Free the parked permit; the queued resume then re-admits this lease.
    (await parked).release();
    assert.equal(semaphore.snapshot().inUse, 1, "the permit is held again after the wait");
  });
  lease.release();
  assert.equal(semaphore.snapshot().inUse, 0);
});

test("idleWithoutPermit returns via the abort listener while the resume stays parked", async () => {
  // The abort-listener side of the race: a resume still queued behind a full team when the
  // signal fires must let the idle wait return even though the permit is not yet free, so
  // an aborted verification does not keep waiting on a permit it no longer needs.
  const semaphore = new Semaphore(2);
  const holder = await semaphore.acquireLease(0);
  const lease = await semaphore.acquireLease(0); // the team is now full
  const controller = new AbortController();
  await withRunPermit(lease, async () => {
    const competitor = semaphore.acquireLease(0); // queues while the team is full
    await idleWithoutPermit(async () => {
      // lease.pause() frees a permit, admitting competitor; once the wait ends, resume()
      // queues behind it and parks. Firing the abort on the next tick then resolves the
      // race through untilAborted's abort listener instead of the parked resume promise.
      setImmediate(() => controller.abort());
    }, controller.signal);
    (await competitor).release();
  });
  lease.release();
  holder.release();
  assert.equal(semaphore.snapshot().inUse, 0);
});
