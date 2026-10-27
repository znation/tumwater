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
