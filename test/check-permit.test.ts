import test from "node:test";
import assert from "node:assert/strict";
import { CHECK_TIER, withCheckPermit } from "../src/check-permit.js";

// A held permit is module-global state, so every test must let its work finish (and any
// rejected run hand its permit back) before the next one starts — a leaked permit would
// park every later acquire in this file.

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Flush microtasks so "has the caller queued yet" is deterministic rather than
// timing-dependent (same pattern as test/semaphore.test.ts).
const flush = () => new Promise<void>((r) => setImmediate(r));

test("withCheckPermit bounds concurrency to the configured cap", async () => {
  const cfg = { maxConcurrentChecks: 2 };
  let running = 0;
  let peak = 0;
  const tasks = Array.from({ length: 6 }, () =>
    withCheckPermit(cfg, CHECK_TIER.other, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await delay(15);
      running -= 1;
    }),
  );
  await Promise.all(tasks);
  assert.equal(peak, 2);
});

test("a valid config raises the cap for the next checks", async () => {
  // The default cap is 2; three concurrent checks can only all run if the config's
  // maxConcurrentChecks was applied to the shared semaphore at acquire time.
  const cfg = { maxConcurrentChecks: 3 };
  let running = 0;
  let peak = 0;
  const tasks = Array.from({ length: 3 }, () =>
    withCheckPermit(cfg, CHECK_TIER.other, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await delay(15);
      running -= 1;
    }),
  );
  await Promise.all(tasks);
  assert.equal(peak, 3);
});

test("an invalid or missing config falls back to the default cap", async () => {
  // Raise the shared cap to 3 first so the fallback (default 2) is actually observable:
  // without the fallback these three checks would all run at once.
  await withCheckPermit({ maxConcurrentChecks: 3 }, CHECK_TIER.other, async () => {});
  let running = 0;
  let peak = 0;
  const run = () =>
    withCheckPermit(undefined as never, CHECK_TIER.other, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await delay(15);
      running -= 1;
    });
  // Missing, sub-one, and non-integer caps must all take the default, never a value the
  // semaphore could not grant under.
  await Promise.all([run(), run(), run()]);
  assert.equal(peak, 2);

  await Promise.all([
    withCheckPermit({ maxConcurrentChecks: 0 }, CHECK_TIER.other, () => delay(15)),
    withCheckPermit({ maxConcurrentChecks: 1.5 }, CHECK_TIER.other, () => delay(15)),
    withCheckPermit({ maxConcurrentChecks: -2 }, CHECK_TIER.other, () => delay(15)),
  ]);
});

test("a failing check still releases its permit", async () => {
  const cfg = { maxConcurrentChecks: 1 };
  await assert.rejects(
    withCheckPermit(cfg, CHECK_TIER.other, async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  // If the permit leaked, this acquire would hang forever — race it against a timeout so
  // the regression fails the test instead of hanging the suite.
  let released = false;
  await Promise.race([
    withCheckPermit(cfg, CHECK_TIER.other, async () => {
      released = true;
    }),
    delay(1000).then(() => {
      throw new Error("permit was not released after a failing check");
    }),
  ]);
  assert.equal(released, true);
});

test("a nested withCheckPermit runs under the permit already held", async () => {
  // At a cap of 1 a non-reentrant inner call could never be granted: the only permit is
  // held by the very call waiting for it. Reentrancy is what keeps this from deadlocking.
  let innerRan = false;
  await withCheckPermit({ maxConcurrentChecks: 1 }, CHECK_TIER.other, async () => {
    await withCheckPermit({ maxConcurrentChecks: 1 }, CHECK_TIER.other, async () => {
      innerRan = true;
    });
    assert.equal(innerRan, true, "the nested call ran inside the held permit");
  });
});

test("a merge-tier waiter is granted ahead of an earlier other-tier waiter", async () => {
  // A merge-scope check runs inside the merge lock, so every check it waits behind is
  // lock-hold time for every other landing — the merge tier must jump the queue.
  // The holder parks on a test-controlled gate, not a timer: a timer can expire under
  // load before both waiters are queued, and the release then hands the permit to the
  // only waiter present (the other-tier one) — the queue-jump the test asserts on never
  // gets a chance to happen. With the gate, the holder cannot release until both
  // waiters are parked, so the grant order is observable by construction.
  const cfg = { maxConcurrentChecks: 1 };
  const granted: string[] = [];
  let releaseHolder: () => void = () => {};
  const holderGate = new Promise<void>((r) => {
    releaseHolder = r;
  });
  const holder = withCheckPermit(cfg, CHECK_TIER.other, async () => {
    await holderGate;
    granted.push("holder");
  });
  await flush(); // holder now holds the only permit
  const other = withCheckPermit(cfg, CHECK_TIER.other, async () => {
    granted.push("other");
  });
  await flush(); // other is parked in the queue first
  const merge = withCheckPermit(cfg, CHECK_TIER.merge, async () => {
    granted.push("merge");
  });
  await flush(); // merge is parked behind it, at the better tier
  releaseHolder(); // only now can the permit change hands — both waiters are queued
  await Promise.all([holder, other, merge]);
  assert.deepEqual(granted, ["holder", "merge", "other"]);
});
