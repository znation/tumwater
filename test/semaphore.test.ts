import test from "node:test";
import assert from "node:assert/strict";
import { Semaphore } from "../src/semaphore.js";

test("semaphore bounds concurrency", async () => {
  const sem = new Semaphore(2);
  let running = 0;
  let peak = 0;
  const tasks = Array.from({ length: 6 }, async () => {
    await sem.acquire();
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 20));
    running -= 1;
    sem.release();
  });
  await Promise.all(tasks);
  assert.equal(peak, 2);
  assert.equal(running, 0);
});

// Flush microtasks (a woken waiter's .then runs before the next macrotask), so ordering
// assertions below are deterministic rather than timing-dependent.
const flush = () => new Promise<void>((r) => setImmediate(r));

test("release wakes waiters in FIFO order", async () => {
  // The orchestrator relies on this: fairOrder queues eligible loops by priority, and the
  // semaphore's wake order is what actually hands out freed slots. LIFO (pop instead of
  // shift) would let a loop that keeps re-queueing every poll beat loops waiting longer.
  const sem = new Semaphore(1);
  await sem.acquire(); // hold the only slot so everything below queues
  const order: string[] = [];
  for (const name of ["a", "b", "c"]) {
    void sem.acquire().then(() => order.push(name));
  }
  await flush(); // all three are now queued, in this order
  assert.deepEqual(order, [], "nothing runs while the slot is held");

  sem.release();
  await flush();
  assert.deepEqual(order, ["a"], "first release wakes the first waiter");

  sem.release();
  await flush();
  assert.deepEqual(order, ["a", "b"]);

  sem.release();
  await flush();
  assert.deepEqual(order, ["a", "b", "c"], "waiters run in queue order");
});

test("capacity fully restores after a burst: no slot leak", async () => {
  // Five tasks through two slots means the last releases happen with NO waiters queued,
  // exercising release()'s capacity-restore branch. If that branch leaked a slot, the
  // post-burst acquires would hang — each is raced against a timeout so a regression fails
  // the test instead of hanging it (node --test has no per-test default timeout).
  const sem = new Semaphore(2);
  const tasks = Array.from({ length: 5 }, async () => {
    await sem.acquire();
    await new Promise((r) => setTimeout(r, 10));
    sem.release();
  });
  await Promise.all(tasks);

  for (let i = 1; i <= 2; i++) {
    const got = await Promise.race([
      sem.acquire().then(() => true),
      new Promise((r) => setTimeout(() => r(false), 200)),
    ]);
    assert.ok(got, `post-burst acquire ${i} hung: a slot leaked`);
    sem.release();
  }
});

// --- Live capacity changes (setCapacity — a mid-run tumwater.json edit) ---

test("growing capacity wakes queued acquirers up to the new headroom, never beyond it", async () => {
  const sem = new Semaphore(2);
  await sem.acquire(); // holder A (this test)
  await sem.acquire(); // holder B — at capacity
  let holders = 2;
  let peak = 2;
  const woken: number[] = [];
  for (let i = 0; i < 4; i++) {
    void sem.acquire().then(() => {
      holders += 1;
      peak = Math.max(peak, holders);
      woken.push(i);
    });
  }
  await flush(); // all four queued — no headroom at capacity 2
  assert.deepEqual(woken, [], "nothing proceeds while at capacity");

  sem.setCapacity(5); // new headroom is 3 → wakes exactly three of the four waiters
  await flush();
  assert.deepEqual(woken, [0, 1, 2], "one permit per woken waiter, bounded by the new headroom");
  assert.equal(holders, 5);
  assert.equal(peak, 5, "never more than capacity hold permits at once");

  // The fourth waiter still queues; a release hands it the freed permit.
  holders -= 1;
  sem.release();
  await flush();
  assert.deepEqual(woken, [0, 1, 2, 3], "the last waiter wakes on the next release");
});

test("shrinking below current in-use admits no new work until releases drain under the cap", async () => {
  const sem = new Semaphore(2);
  await sem.acquire(); // holder A (this test)
  await sem.acquire(); // holder B — at capacity, both in flight
  let lateArriverRan = false;
  void sem.acquire().then(() => (lateArriverRan = true)); // queues: no headroom
  await flush();

  sem.setCapacity(1); // shrink below the two in-flight holders
  assert.equal(lateArriverRan, false, "a pure shrink wakes nothing");

  // First release brings in-use to 1 — still AT the cap, so no new grant yet. In-flight work
  // is never preempted; it simply drains.
  sem.release();
  await flush();
  assert.equal(lateArriverRan, false, "no new acquire while in-use sits at the shrunken cap");

  // Second release brings in-use to 0 < 1: now the queued acquire may proceed.
  sem.release();
  await flush();
  assert.equal(lateArriverRan, true, "a release that drains under the cap admits the waiter");
});

test("release hands a permit straight to a queued waiter without double-granting", async () => {
  const sem = new Semaphore(1);
  await sem.acquire(); // hold the only slot
  let wokenCount = 0;
  void sem.acquire().then(() => (wokenCount += 1));
  void sem.acquire().then(() => (wokenCount += 1));
  await flush();

  sem.release(); // must wake exactly ONE waiter, not both
  await flush();
  assert.equal(wokenCount, 1, "one release wakes one waiter");

  sem.release();
  await flush();
  assert.equal(wokenCount, 2, "the second release wakes the second waiter");
});

test("repeated grow/shrink cycles leak no permits and starve no waiter", async () => {
  const sem = new Semaphore(1);
  for (let cycle = 0; cycle < 5; cycle++) {
    const cap = cycle % 2 === 0 ? 3 : 1; // alternate grow and shrink
    sem.setCapacity(cap);

    // Fill to the current capacity.
    for (let i = 0; i < cap; i++) await sem.acquire();

    // Queue a waiter: no grant while at full capacity.
    let waiterRan = false;
    void sem.acquire().then(() => (waiterRan = true));
    await flush();
    assert.equal(waiterRan, false, `cycle ${cycle}: nothing proceeds at full capacity`);

    if (cap === 1) {
      // Grow: the queued waiter is admitted immediately.
      sem.setCapacity(2);
      await flush();
      assert.equal(waiterRan, true, "the grow wakes the queued waiter");
      for (let i = 0; i < 2; i++) sem.release(); // drain both holders
    } else {
      // Shrink below in-use: no new grant until releases drain under the cap.
      sem.setCapacity(1);
      for (let i = 0; i < cap - 1; i++) {
        sem.release();
        await flush();
        assert.equal(waiterRan, false, `cycle ${cycle}: still at/over the shrunken cap`);
      }
      sem.release(); // final release drains under the cap → admits the waiter
      await flush();
      assert.equal(waiterRan, true, "draining under the shrunken cap admits the waiter");
      sem.release(); // the waiter's own permit
    }
  }

  // Fully drained after five cycles: no leaked permits (a leak would hang this acquire).
  const got = await Promise.race([
    sem.acquire().then(() => true),
    new Promise((r) => setTimeout(() => r(false), 200)),
  ]);
  assert.ok(got, "post-cycle acquire hung: a permit leaked");
});
