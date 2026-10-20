import { flushImmediate, sleep } from "./helpers/wait.js";
import test from "node:test";
import assert from "node:assert/strict";
import { Semaphore } from "../src/concurrency/semaphore.js";

test("semaphore bounds concurrency", async () => {
  const sem = new Semaphore(2);
  let running = 0;
  let peak = 0;
  const tasks = Array.from({ length: 6 }, async () => {
    await sem.acquire(0);
    running += 1;
    peak = Math.max(peak, running);
    await sleep(20);
    running -= 1;
    sem.release();
  });
  await Promise.all(tasks);
  assert.equal(peak, 2);
  assert.equal(running, 0);
});

test("release wakes waiters in FIFO order", async () => {
  // The orchestrator relies on this: fairOrder queues eligible roles by priority, and the
  // semaphore's wake order is what actually hands out freed slots. LIFO (pop instead of
  // shift) would let a role that keeps re-queueing every poll beat roles waiting longer.
  const sem = new Semaphore(1);
  await sem.acquire(0); // hold the only slot so everything below queues
  const order: string[] = [];
  for (const name of ["a", "b", "c"]) {
    void sem.acquire(0).then(() => order.push(name));
  }
  await flushImmediate(); // all three are now queued, in this order
  assert.deepEqual(order, [], "nothing runs while the slot is held");
  assert.equal(sem.waiting, 3, "every queued acquirer is counted as waiting");

  sem.release();
  await flushImmediate();
  assert.deepEqual(order, ["a"], "first release wakes the first waiter");

  sem.release();
  await flushImmediate();
  assert.deepEqual(order, ["a", "b"]);

  sem.release();
  await flushImmediate();
  assert.deepEqual(order, ["a", "b", "c"], "waiters run in queue order");
  assert.equal(sem.waiting, 0, "a woken waiter no longer counts as waiting");
});

test("capacity fully restores after a burst: no slot leak", async () => {
  // Five tasks through two slots means the last releases happen with NO waiters queued,
  // exercising release()'s capacity-restore branch. If that branch leaked a slot, the
  // post-burst acquires would hang — each is raced against a timeout so a regression fails
  // the test instead of hanging it (node --test has no per-test default timeout).
  const sem = new Semaphore(2);
  const tasks = Array.from({ length: 5 }, async () => {
    await sem.acquire(0);
    await sleep(10);
    sem.release();
  });
  await Promise.all(tasks);

  for (let i = 1; i <= 2; i++) {
    const got = await Promise.race([
      sem.acquire(0).then(() => true),
      new Promise((r) => setTimeout(() => r(false), 200)),
    ]);
    assert.ok(got, `post-burst acquire ${i} hung: a slot leaked`);
    sem.release();
  }
});

// --- Live capacity changes (setCapacity — a mid-run tumwater.json edit) ---

test("growing capacity wakes queued acquirers up to the new headroom, never beyond it", async () => {
  const sem = new Semaphore(2);
  await sem.acquire(0); // holder A (this test)
  await sem.acquire(0); // holder B — at capacity
  let holders = 2;
  let peak = 2;
  const woken: number[] = [];
  for (let i = 0; i < 4; i++) {
    void sem.acquire(0).then(() => {
      holders += 1;
      peak = Math.max(peak, holders);
      woken.push(i);
    });
  }
  await flushImmediate(); // all four queued — no headroom at capacity 2
  assert.deepEqual(woken, [], "nothing proceeds while at capacity");

  sem.setCapacity(5); // new headroom is 3 → wakes exactly three of the four waiters
  await flushImmediate();
  assert.deepEqual(woken, [0, 1, 2], "one permit per woken waiter, bounded by the new headroom");
  assert.equal(holders, 5);
  assert.equal(peak, 5, "never more than capacity hold permits at once");

  // The fourth waiter still queues; a release hands it the freed permit.
  holders -= 1;
  sem.release();
  await flushImmediate();
  assert.deepEqual(woken, [0, 1, 2, 3], "the last waiter wakes on the next release");
});

test("shrinking below current in-use admits no new work until releases drain under the cap", async () => {
  const sem = new Semaphore(2);
  await sem.acquire(0); // holder A (this test)
  await sem.acquire(0); // holder B — at capacity, both in flight
  let lateArriverRan = false;
  void sem.acquire(0).then(() => (lateArriverRan = true)); // queues: no headroom
  await flushImmediate();

  sem.setCapacity(1); // shrink below the two in-flight holders
  assert.equal(lateArriverRan, false, "a pure shrink wakes nothing");

  // First release brings in-use to 1 — still AT the cap, so no new grant yet. In-flight work
  // is never preempted; it simply drains.
  sem.release();
  await flushImmediate();
  assert.equal(lateArriverRan, false, "no new acquire while in-use sits at the shrunken cap");

  // Second release brings in-use to 0 < 1: now the queued acquire may proceed.
  sem.release();
  await flushImmediate();
  assert.equal(lateArriverRan, true, "a release that drains under the cap admits the waiter");
});

test("release hands a permit straight to a queued waiter without double-granting", async () => {
  const sem = new Semaphore(1);
  await sem.acquire(0); // hold the only slot
  let wokenCount = 0;
  void sem.acquire(0).then(() => (wokenCount += 1));
  void sem.acquire(0).then(() => (wokenCount += 1));
  await flushImmediate();

  sem.release(); // must wake exactly ONE waiter, not both
  await flushImmediate();
  assert.equal(wokenCount, 1, "one release wakes one waiter");

  sem.release();
  await flushImmediate();
  assert.equal(wokenCount, 2, "the second release wakes the second waiter");
});

test("repeated grow/shrink cycles leak no permits and starve no waiter", async () => {
  const sem = new Semaphore(1);
  for (let cycle = 0; cycle < 5; cycle++) {
    const cap = cycle % 2 === 0 ? 3 : 1; // alternate grow and shrink
    sem.setCapacity(cap);

    // Fill to the current capacity.
    for (let i = 0; i < cap; i++) await sem.acquire(0);

    // Queue a waiter: no grant while at full capacity.
    let waiterRan = false;
    void sem.acquire(0).then(() => (waiterRan = true));
    await flushImmediate();
    assert.equal(waiterRan, false, `cycle ${cycle}: nothing proceeds at full capacity`);

    if (cap === 1) {
      // Grow: the queued waiter is admitted immediately.
      sem.setCapacity(2);
      await flushImmediate();
      assert.equal(waiterRan, true, "the grow wakes the queued waiter");
      for (let i = 0; i < 2; i++) sem.release(); // drain both holders
    } else {
      // Shrink below in-use: no new grant until releases drain under the cap.
      sem.setCapacity(1);
      for (let i = 0; i < cap - 1; i++) {
        sem.release();
        await flushImmediate();
        assert.equal(waiterRan, false, `cycle ${cycle}: still at/over the shrunken cap`);
      }
      sem.release(); // final release drains under the cap → admits the waiter
      await flushImmediate();
      assert.equal(waiterRan, true, "draining under the shrunken cap admits the waiter");
      sem.release(); // the waiter's own permit
    }
  }

  // Fully drained after five cycles: no leaked permits (a leak would hang this acquire).
  const got = await Promise.race([
    sem.acquire(0).then(() => true),
    new Promise((r) => setTimeout(() => r(false), 200)),
  ]);
  assert.ok(got, "post-cycle acquire hung: a permit leaked");
});

// --- Tier-ordered waiting (BUGS.md 2026-09-12: cross-poll slot inversion) ---

test("a lower-tier arrival jumps ahead of parked higher-tier waiters, FIFO within a tier", async () => {
  // The orchestrator passes roleTier so the documented "work roles ahead of maintenance"
  // order holds for ticks WAITING on a slot across polls, not just within one kickoff batch.
  const sem = new Semaphore(1);
  await sem.acquire(1); // holder: the only slot is busy
  const order: string[] = [];
  // Snapshot before asserting: node:assert/strict's deepEqual carries an `asserts actual is T`
  // signature, which would narrow `order` to the asserted literal and reject later pushes.
  const snap = () => [...order];

  void sem.acquire(1).then(() => order.push("maint-early")); // parked in an earlier poll
  await flushImmediate();
  void sem.acquire(0).then(() => order.push("work-late")); // work role becomes due later
  await flushImmediate();
  assert.deepEqual(snap(), [], "nothing runs while the slot is held");

  sem.release();
  await flushImmediate();
  assert.deepEqual(
    snap(),
    ["work-late"],
    "the tier-0 arrival jumps ahead of the parked tier-1 waiter",
  );

  // The jumped-over maintenance waiter still gets its turn — and a same-tier arrival parks
  // BEHIND it (stable FIFO within a tier), not in front.
  void sem.acquire(1).then(() => order.push("maint-late"));
  await flushImmediate();
  sem.release();
  await flushImmediate();
  assert.deepEqual(snap(), ["work-late", "maint-early"], "the jumped-over waiter runs next");

  sem.release();
  await flushImmediate();
  assert.deepEqual(
    snap(),
    ["work-late", "maint-early", "maint-late"],
    "same-tier waiters stay FIFO",
  );
});

test("tier ordering never starves a higher tier: once no lower-tier waiter is parked, it drains FIFO", async () => {
  // A work role that keeps re-queueing every poll must not wedge the maintenance queue
  // forever — while its arrival holds the slot nothing else runs, but once it finishes and
  // no lower-tier waiter is parked, releases go to the oldest higher-tier waiters in order.
  const sem = new Semaphore(1);
  await sem.acquire(0); // holder (this test)
  const order: string[] = [];
  const snap = () => [...order]; // see the sibling test for why not a bare `order`

  void sem.acquire(1).then(() => order.push("maint-1"));
  void sem.acquire(1).then(() => order.push("maint-2"));
  await flushImmediate();

  // A tier-0 arrival jumps ahead of both parked maintenance waiters.
  const late = (async () => {
    await sem.acquire(0);
    order.push("work"); // holds the slot for the rest of this test
  })();
  await flushImmediate();
  assert.deepEqual(snap(), [], "the tier-0 arrival is still parked while the holder keeps its slot");

  sem.release(); // hands the slot to the queue head: the tier-0 arrival
  await late;
  await flushImmediate();
  assert.deepEqual(snap(), ["work"], "tier 0 ran first, ahead of both maintenance waiters");

  // No lower-tier waiter is parked now: the maintenance waiters drain in FIFO order.
  sem.release(); // work's slot frees up
  await flushImmediate();
  assert.deepEqual(snap(), ["work", "maint-1"]);
  sem.release();
  await flushImmediate();
  assert.deepEqual(
    snap(),
    ["work", "maint-1", "maint-2"],
    "higher tier drains FIFO once unblocked",
  );
});

test("a reserve keeps a permit free for a work acquirer while maintenance sits at its cap", async () => {
  const sem = new Semaphore(6);
  for (let i = 0; i < 4; i++) await sem.acquire(1); // four maintenance permit holders
  sem.setReserve(2);
  let maintenanceGranted = false;
  void sem.acquire(1).then(() => {
    maintenanceGranted = true;
  });
  await flushImmediate();
  assert.equal(maintenanceGranted, false, "the fifth maintenance acquirer is held by the reserve");
  assert.equal(sem.waiting, 1);
  // The work tier ignores the reserve and takes the permit at once, no queue wait.
  let workGranted = false;
  void sem.acquire(0).then(() => {
    workGranted = true;
  });
  await flushImmediate();
  assert.equal(workGranted, true, "a work acquirer takes the reserved permit at once");
  assert.equal(sem.waiting, 1, "the parked maintenance waiter is still waiting");
});

test("lowering the reserve admits a parked maintenance waiter", async () => {
  const sem = new Semaphore(2);
  await sem.acquire(1);
  sem.setReserve(1);
  let granted = false;
  void sem.acquire(1).then(() => {
    granted = true;
  });
  await flushImmediate();
  assert.equal(granted, false, "the reserve withholds the second permit");
  sem.setReserve(0);
  await flushImmediate();
  assert.equal(granted, true, "the freed reserve admits the parked maintenance waiter");
});

test("the verify and merge tiers ignore the reserve", async () => {
  const sem = new Semaphore(2);
  await sem.acquire(1);
  await sem.acquire(1); // capacity full
  sem.setReserve(1);
  sem.release(); // one permit free, but a reserve of 1 would withhold it from tier >= 1
  let verifyGranted = false;
  void sem.acquire(-1).then(() => {
    verifyGranted = true;
  });
  await flushImmediate();
  assert.equal(verifyGranted, true, "a negative-tier (verify/merge) acquirer is never held by the reserve");
});

// --- Keyed permits (plans/provider-concurrency.md §3; 2026-10-15) ---

test("two keys fill independently: a full key never delays a free key, FIFO within a key", async () => {
  const sem = new Semaphore(4);
  sem.setKeyCaps({ a: 1, b: 1 });
  const aHold = await sem.acquireLease(0, "a"); // key a is now full (1/1)
  const order: string[] = [];
  const snap = () => [...order]; // node:assert/strict deepEqual narrows its operand; see siblings
  const a2 = sem.acquireLease(0, "a").then((l) => {
    order.push("a2");
    return l;
  }); // parks: a is full
  await flushImmediate();
  assert.deepEqual(snap(), [], "a second acquirer on the full key a parks");

  // A later waiter on the free key b gains at once, not held back by the parked a waiter.
  const bHold = await sem.acquireLease(0, "b");
  assert.equal(bHold.key, "b");
  order.push("b-granted");
  assert.deepEqual(snap(), ["b-granted"], "the free key's waiter is granted while a's is still parked");

  // FIFO within a key: a third waiter on a parks behind a2, and releases wake them in order.
  const a3 = sem.acquireLease(0, "a").then((l) => {
    order.push("a3");
    return l;
  });
  await flushImmediate();
  bHold.release(); // freeing b wakes nothing on a
  aHold.release(); // frees a's only permit -> the first a waiter
  await flushImmediate();
  assert.deepEqual(snap(), ["b-granted", "a2"], "releasing a's only permit wakes the first a waiter");
  (await a2).release();
  await flushImmediate();
  assert.deepEqual(snap(), ["b-granted", "a2", "a3"], "waiters on one key drain FIFO");
  void a3;
});

test("shrinking a key below its in-use preempts nothing and grants nothing until releases drain", async () => {
  const sem = new Semaphore(4);
  sem.setKeyCaps({ a: 2 });
  const a1 = await sem.acquireLease(0, "a");
  const a2 = await sem.acquireLease(0, "a"); // a at 2/2
  let late = false;
  void sem.acquireLease(0, "a").then(() => (late = true));
  await flushImmediate();
  sem.setKeyCaps({ a: 1 }); // shrink below the two in-use holders
  assert.equal(late, false, "a pure shrink wakes nothing");
  a1.release(); // a now 1/1 — still AT the cap, so no new grant
  await flushImmediate();
  assert.equal(late, false, "no new grant while a sits at its shrunken cap");
  a2.release(); // a now 0/1 < 1 — the waiter is admitted
  await flushImmediate();
  assert.equal(late, true, "a release draining under the shrunken cap admits the waiter");
});

test("rekey gives the old key back first, and a parked re-key beats a parked admission for the key", async () => {
  const sem = new Semaphore(4);
  sem.setKeyCaps({ a: 1, b: 1 });
  const aHold = await sem.acquireLease(0, "a"); // a 1/1
  const bHold = await sem.acquireLease(0, "b"); // b 1/1
  const order: string[] = [];
  const snap = () => [...order]; // see the sibling test for why not a bare `order`
  const rekeyTask = aHold.rekey("b").then(() => order.push("rekey")); // parks: b is full
  await flushImmediate();
  const admission = sem.acquireLease(0, "b").then(() => order.push("admission")); // parks: b full
  await flushImmediate();
  assert.deepEqual(snap(), [], "both re-key and admission wait");

  // The old key a was given back before the re-key parked, so a is grantable again.
  const poolSnap = sem.snapshot();
  assert.equal(poolSnap.byKey["a"]?.inUse ?? 0, 0, "the old key is returned before the re-key parks");
  const aLate = await sem.acquireLease(0, "a"); // a is free -> granted at once
  aLate.release();

  bHold.release(); // frees b's slot: the parked re-key wins it, not the admission
  await flushImmediate();
  assert.deepEqual(snap(), ["rekey"], "the parked re-key is granted ahead of the parked admission");
  assert.equal(aHold.key, "b", "the re-key'd lease now holds b");
  // The re-key'd lease (aHold) now holds b; releasing it frees b for the admission waiter.
  aHold.release();
  await flushImmediate();
  assert.deepEqual(snap(), ["rekey", "admission"], "the admission waiter gets the key once the re-key releases");
  void rekeyTask;
  void admission;
});

test("releasing a lease while its re-key to a full key is parked cancels the grant and never steals the target", async () => {
  const sem = new Semaphore(4);
  sem.setKeyCaps({ a: 1, b: 1 });
  const aHold = await sem.acquireLease(0, "a"); // a 1/1
  const bHold = await sem.acquireLease(0, "b"); // b 1/1
  let rekeySettled: string | null = null;
  const rekeyTask = aHold.rekey("b").then(() => (rekeySettled = "rekey")).catch(() => (rekeySettled = "error"));
  await flushImmediate(); // the re-key parks: b is full, a was returned
  assert.equal(sem.snapshot().byKey["a"]?.inUse ?? 0, 0, "the old key is returned before the re-key parks");
  assert.equal(sem.snapshot().byKey["b"]?.inUse ?? 0, 1, "b still belongs to bHold while the re-key parks");

  // A waiter on b parks behind the re-key (b is full).
  let admitted = false;
  void sem.acquireLease(0, "b").then(() => (admitted = true));
  await flushImmediate();
  assert.equal(admitted, false, "b is full, so the admission waiter parks");

  // Release the lease while its re-key is still parked: the grant must be cancelled, not
  // handed to a dead lease, and b's slot must stay bHold's own.
  aHold.release();
  await rekeyTask;
  assert.equal(rekeySettled, "rekey", "the re-key call resolves (cancelled) rather than hanging");
  const after = sem.snapshot();
  assert.equal(after.byKey["b"]?.inUse ?? 0, 1, "a cancelled re-key does not steal b from bHold");
  assert.equal(after.inUse, 1, "only bHold's team permit remains");
  assert.equal(admitted, false, "the admission waiter is still held by bHold's slot");

  // A SECOND release of the already-released dead lease must be a no-op. Without the fix the
  // released aHold is not idempotent: its phantom b slot (never really owned) is "freed" by
  // the second release, which drains b below its cap and admits the parked waiter even though
  // bHold still holds b. That early admission of the parked waiter is the bug's observable
  // harm, so it must NOT happen.
  aHold.release();
  await flushImmediate();
  assert.equal(admitted, false, "a second release of the dead lease must not free b while bHold still holds it");
  const twice = sem.snapshot();
  assert.equal(twice.byKey["b"]?.inUse ?? 0, 1, "b still belongs to bHold after the dead lease's second release");
  assert.equal(twice.inUse, 1, "the dead lease's second release is a no-op on the team total");

  // Only when the REAL holder releases does b free up for the parked waiter.
  bHold.release();
  await flushImmediate();
  assert.equal(admitted, true, "releasing bHold hands b to the parked admission waiter");
  assert.equal(sem.snapshot().inUse, 1, "the admitted waiter holds the single team permit");
  void rekeyTask;
});

test("a forced lease overshoots a full key by one holder, blocking grants until it drains under the cap", async () => {
  const sem = new Semaphore(4);
  sem.setKeyCaps({ a: 1 });
  const aHold = await sem.acquireLease(0, "a"); // a 1/1
  let waiterGranted = false;
  void sem.acquireLease(0, "a").then(() => (waiterGranted = true));
  await flushImmediate();
  const dir = sem.forceLease("a"); // overshoots to 2/1, never waits, no team permit
  assert.equal(sem.snapshot().byKey["a"]?.inUse, 2, "the forced lease holds a key slot");
  assert.equal(waiterGranted, false, "the forced overshoot still admits nobody");
  aHold.release(); // drains to 1/1 — still AT the cap, so no new grant yet
  await flushImmediate();
  assert.equal(waiterGranted, false, "no grant while the key sits at (or over) its cap");
  dir.release(); // drains to 0/1 < 1 — now the waiter is admitted
  await flushImmediate();
  assert.equal(waiterGranted, true, "draining under the cap admits the waiter");
});

test("re-key waiters hold a team permit only, so the key always drains (no deadlock)", async () => {
  const sem = new Semaphore(2);
  sem.setKeyCaps({ k: 1 });
  const l1 = await sem.acquireLease(0, "x"); // uncapped key grants immediately, team 1/2
  const l2 = await sem.acquireLease(0, "x"); // team 2/2
  // Both re-key onto k: one takes k, the other parks as a re-key waiter.

  const r1 = l1.rekey("k");
  await flushImmediate();
  const r2 = l2.rekey("k");
  await flushImmediate();
  const snap = sem.snapshot();
  assert.equal(snap.byKey["k"]?.inUse, 1, "exactly one holds k");
  assert.equal(sem.waiting, 1, "one re-key waiter is parked");
  assert.equal(snap.inUse, 2, "the parked re-key waiter still holds its team permit");
  // No circular wait: releasing k's only holder grants the parked re-key on that single release.
  l1.release();
  await Promise.all([r1, r2]);
  await flushImmediate();
  const after = sem.snapshot();
  assert.equal(after.byKey["k"]?.inUse, 1, "the re-key waiter takes k on the one release");
  assert.equal(after.inUse, 1, "and releases the team permit it no longer needs");
  l2.release();
});

test("snapshot reports team and per-key in-use, caps and waiters", async () => {
  const sem = new Semaphore(4);
  sem.setKeyCaps({ a: 1, b: 3 });
  await sem.acquireLease(0, "a"); // a 1/1 (full)
  const bHold = await sem.acquireLease(0, "b"); // b 1/3
  void sem.acquireLease(0, "a"); // parks on a
  await flushImmediate();
  const snap = sem.snapshot();
  assert.equal(snap.inUse, 2);
  assert.equal(snap.limit, 4);
  assert.equal(snap.reserve, 0);
  assert.deepEqual(snap.byKey["a"], { inUse: 1, limit: 1, waiting: 1 });
  assert.deepEqual(snap.byKey["b"], { inUse: 1, limit: 3, waiting: 0 });
  bHold.release();
});
