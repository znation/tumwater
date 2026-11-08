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
  // order holds for runs WAITING on a slot across polls, not just within one kickoff batch.
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

// --- Age bound (BUGS.md 2026-11-08: tier-1 role waiters have no age bound and no visible
// wait, so maintenance roles starve behind work runs for half a day) ---

test("snapshot publishes each live waiter's tier and age, then clears it when admitted", async () => {
  let clock = 1_000;
  const sem = new Semaphore(1, { now: () => clock, starveMs: 10_000 });
  const holder = await sem.acquireLease(0);
  const waiter = sem.acquireLease(1);
  await flushImmediate();

  clock = 4_000;
  assert.deepEqual(sem.snapshot().waiting, [{ tier: 1, waitingMs: 3_000 }], "the parked tier and its age");

  clock = 12_000; // past the starve bound, so the snapshot reports the effective (promoted) tier
  assert.deepEqual(sem.snapshot().waiting, [{ tier: 0, waitingMs: 11_000 }], "an aged waiter reports its effective tier");

  holder.release();
  const admitted = await waiter;
  assert.deepEqual(sem.snapshot().waiting, [], "an admitted waiter leaves the published list");
  admitted.release();
});

test("an aged tier-1 waiter is promoted ahead of a new tier-0 arrival, ending its starvation", async () => {
  // A tier-1 (maintenance) waiter must not be passed over forever: once it has waited past
  // the starve bound, a fresh tier-0 (work) arrival must stop jumping ahead of it.
  let clock = 0;
  const sem = new Semaphore(1, { now: () => clock, starveMs: 10_000 });
  const order: string[] = [];
  const snap = () => [...order]; // see the sibling test for why not a bare `order`
  await sem.acquire(0); // holder: this test owns the only slot

  // Park a maintenance waiter; it is young right now.
  void sem.acquire(1).then(() => order.push("maint"));
  await flushImmediate();

  // Age it past the starve bound, then a work role becomes due and parks fresh.
  clock = 20_000; // beyond the 10s bound
  void sem.acquire(0).then(() => order.push("work"));
  await flushImmediate();
  assert.deepEqual(snap(), [], "nothing runs while the holder keeps the slot");

  sem.release(); // the holder frees the slot: its head is the aged maint, not the fresh work
  await flushImmediate();
  assert.deepEqual(snap(), ["maint"], "the aged tier-1 waiter is granted before the fresh tier-0 arrival");

  sem.release(); // maint's own permit, once it is done
  await flushImmediate();
  assert.deepEqual(snap(), ["maint", "work"], "the work arrival takes the slot that maint freed");
});

test("a young tier-1 waiter is still passed over by a fresh tier-0 arrival (tier order intact)", async () => {
  // Without the age bound, the existing tier order must be unchanged: a tier-0 arrival still
  // jumps ahead of a tier-1 waiter that has not yet starved.
  let clock = 0;
  const sem = new Semaphore(1, { now: () => clock, starveMs: 10_000 });
  const order: string[] = [];
  const snap = () => [...order];
  await sem.acquire(0); // holder
  void sem.acquire(1).then(() => order.push("maint"));
  await flushImmediate();
  clock = 1_000; // well under the 10s bound
  void sem.acquire(0).then(() => order.push("work"));
  await flushImmediate();

  sem.release();
  await flushImmediate();
  assert.deepEqual(snap(), ["work"], "a fresh tier-0 arrival jumps ahead of the young tier-1 waiter");
  sem.release();
  await flushImmediate();
  assert.deepEqual(snap(), ["work", "maint"], "the young tier-1 waiter takes the next freed slot");
});

test("an aged tier-1 waiter bypasses the reserve so the work headroom cannot starve it", async () => {
  // Two work holders sit at capacity (2 of 2). A reserve of 1 would withhold the next freed
  // permit from a tier-1 waiter; the age bound promotes the aged maintenance waiter to tier 0,
  // so it can take that reserved permit — a work run arriving fresh must otherwise always win.
  let clock = 0;
  const sem = new Semaphore(2, { now: () => clock, starveMs: 10_000 });
  await sem.acquire(0); // work holder A
  await sem.acquire(0); // work holder B — at capacity
  sem.setReserve(1); // withhold the one free permit from tier >= 1 once a holder releases
  let granted = false;
  void sem.acquire(1).then(() => (granted = true));
  await flushImmediate();
  assert.equal(granted, false, "nothing runs while the two holders sit at capacity");

  clock = 20_000; // age the maintenance waiter past the bound
  sem.release(); // holder A frees one permit: in-use is now exactly capacity - reserve, so the
  // reserved permit is the only headroom and only the age-promoted waiter can take it
  await flushImmediate();
  assert.equal(granted, true, "the aged tier-1 waiter bypasses the reserve for a reserved permit");
});

test("an aged tier-1 waiter takes the reserved headroom before a fresh tier-0 arrival", async () => {
  // The reserve leaves one permit free while the young maintenance waiter is withheld. Nothing
  // drives the queue when that waiter ages, so a fresh work arrival must not take the free
  // permit through the acquire fast path ahead of it.
  let clock = 0;
  const sem = new Semaphore(2, { now: () => clock, starveMs: 10_000 });
  const order: string[] = [];
  const snap = () => [...order]; // see the sibling age test for why not a bare `order`
  await sem.acquire(0); // work holder: in-use 1, leaving one permit
  sem.setReserve(1); // that permit is reserved for work, so the tier-1 waiter parks
  void sem.acquire(1).then(() => order.push("maint"));
  await flushImmediate();
  assert.deepEqual(snap(), [], "the reserve withholds the free permit from the young maintenance waiter");

  clock = 20_000; // age it past the bound; no release or resize drives the queue
  void sem.acquire(0).then(() => order.push("work"));
  await flushImmediate();
  assert.deepEqual(snap(), ["maint"], "the aged waiter takes the reserved permit before the fresh work arrival");

  sem.release(); // holder frees its permit: the parked work arrival takes it
  await flushImmediate();
  assert.deepEqual(snap(), ["maint", "work"], "the work arrival takes the next freed permit");
  sem.release();
  sem.release();
});

test("an aged tier-1 lease waiter takes the reserved headroom before a fresh tier-0 lease", async () => {
  // The orchestrator admits role runs through acquireLease, not acquire: the role-starvation
  // path needs the same grant-ahead, not only the check-permit path.
  let clock = 0;
  const sem = new Semaphore(2, { now: () => clock, starveMs: 10_000 });
  const order: string[] = [];
  const snap = () => [...order];
  const holder = await sem.acquireLease(0); // work holder: in-use 1, leaving one permit
  sem.setReserve(1); // that permit is reserved for work, so the tier-1 lease waiter parks
  const maint = sem.acquireLease(1).then((lease) => {
    order.push("maint");
    return lease;
  });
  await flushImmediate();
  assert.deepEqual(snap(), [], "the reserve withholds the free permit from the young maintenance lease waiter");

  clock = 20_000; // age it past the bound; no release or resize drives the queue
  const work = sem.acquireLease(0).then((lease) => {
    order.push("work");
    return lease;
  });
  await flushImmediate();
  assert.deepEqual(snap(), ["maint"], "the aged lease waiter takes the reserved permit before the fresh work lease");

  holder.release(); // the holder frees its permit: the parked work lease takes it
  await flushImmediate();
  assert.deepEqual(snap(), ["maint", "work"], "the work lease takes the next freed permit");
  (await maint).release();
  (await work).release();
  assert.equal(sem.snapshot().inUse, 0, "every lease gave its permit back");
});

test("an aged tier-1 lease waiter takes the reserved headroom before a paused lease resumes", async () => {
  // A resume is an admission too: it must grant the aged waiter ahead of it before retaking the
  // free permit, or a failed review's in-place retry can barge a starved maintenance run.
  let clock = 0;
  const sem = new Semaphore(2, { now: () => clock, starveMs: 10_000 });
  const order: string[] = [];
  const snap = () => [...order];
  const holder = await sem.acquireLease(0);
  const pausedLease = await sem.acquireLease(0);
  pausedLease.pause(); // hands one permit back, leaving the other held by holder
  sem.setReserve(1); // the free permit is reserved, so the tier-1 lease waiter parks
  const maint = sem.acquireLease(1).then((lease) => {
    order.push("maint");
    return lease;
  });
  await flushImmediate();
  assert.deepEqual(snap(), [], "the reserve withholds the free permit from the young maintenance lease waiter");

  clock = 20_000; // age it past the bound; resume is the arrival that could barge it
  const resume = pausedLease.resume().then(() => order.push("resume"));
  await flushImmediate();
  assert.deepEqual(snap(), ["maint"], "the aged lease waiter takes the reserved permit before the resume");

  holder.release(); // the resume takes the next freed permit behind the aged waiter
  await flushImmediate();
  assert.deepEqual(snap(), ["maint", "resume"], "the resume takes the next freed permit");
  await resume;
  (await maint).release();
  pausedLease.release();
  assert.equal(sem.snapshot().inUse, 0, "every lease gave its permit back");
});


// --- Pause/resume (part 5i/6): a lease hands its team permit back for an idle wait ---

test("a paused lease hands its permit to a parked waiter, and resume queues for the next free one", async () => {
  const sem = new Semaphore(1);
  const holder = await sem.acquireLease(0);
  let waiterGranted = false;
  const waiter = sem.acquireLease(0).then((l) => {
    waiterGranted = true;
    return l;
  });
  await flushImmediate();
  assert.equal(waiterGranted, false, "the waiter parks while the holder holds the only permit");

  holder.pause();
  const parked = await waiter;
  assert.equal(waiterGranted, true, "pause hands the team permit to the waiter");
  assert.equal(sem.snapshot().inUse, 1, "the waiter now holds the permit");

  let resumed = false;
  const resume = holder.resume().then(() => (resumed = true));
  await flushImmediate();
  assert.equal(resumed, false, "resume waits like any admission waiter while the permit is taken");
  parked.release();
  await resume;
  assert.equal(sem.snapshot().inUse, 1, "the holder has it back");
  holder.release();
  assert.equal(sem.snapshot().inUse, 0);
});

test("releasing a paused lease, or one whose resume is still queued, owes nothing", async () => {
  const sem = new Semaphore(1);
  const idle = await sem.acquireLease(0);
  idle.pause();
  idle.pause(); // a second pause is a no-op, never a second give-back
  idle.release();
  assert.equal(sem.snapshot().inUse, 0, "a paused lease held nothing to free");

  const holder = await sem.acquireLease(0);
  holder.pause();
  const other = await sem.acquireLease(0);
  let resumed = false;
  const resume = holder.resume().then(() => (resumed = true));
  await flushImmediate();
  holder.release(); // the aborted verification's finally, while its resume is queued
  await resume;
  assert.equal(resumed, true, "the cancelled resume settles");
  assert.equal(sem.waiting, 0, "and leaves the queue");
  other.release();
  assert.equal(sem.snapshot().inUse, 0, "no count goes negative or leaks");
  await holder.resume(); // a released lease never takes a permit back
  assert.equal(sem.snapshot().inUse, 0);
});
