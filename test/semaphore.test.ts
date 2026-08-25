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
