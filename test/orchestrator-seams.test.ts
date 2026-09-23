import test from "node:test";
import assert from "node:assert/strict";
import { runTimedRoleTick, sleepInterruptible } from "../src/orchestrator.js";
import { Semaphore } from "../src/semaphore.js";
import type { TickOutcome } from "../src/types.js";

// The orchestrator's two exported unit-test seams (src/orchestrator.ts): the permit-holding
// wrapper that times a role tick for the p75 redeploy window, and the abort-wakeable poll
// sleep. Both are small enough to pin without a fleet — the live orchestrator loop around
// them is the e2e tier's job — but each carries a documented edge case that could plausibly
// break (an already-aborted signal that addEventListener alone would never fire; an aborted
// tick whose duration must not drag the window down), and none of that was under any unit
// test before this file.

/** Minimal recording harness for runTimedRoleTick: counts acquire/release, replays the given
 * tick outcomes, and serves a controllable fake clock (each call advances by `stepMs`). */
function timedTickHarness(outcomes: TickOutcome[], stepMs = 100) {
  const calls = { acquire: 0, release: 0, ticks: 0 };
  let nowMs = 0;
  return {
    calls,
    acquire: async () => void calls.acquire++,
    release: () => void calls.release++,
    tick: async (): Promise<TickOutcome> => outcomes[calls.ticks++] as TickOutcome,
    now: () => (nowMs += stepMs),
  };
}

test("runTimedRoleTick returns the tick's wall-clock duration measured by the now seam", async () => {
  const h = timedTickHarness([{ result: "changed" }]);
  const elapsed = await runTimedRoleTick(new AbortController().signal, h.acquire, h.release, h.tick, h.now);
  assert.equal(elapsed, 100); // startedAt = 100 (first call), end = 200 (second call)
  assert.equal(h.calls.acquire, 1);
  assert.equal(h.calls.release, 1);
  assert.equal(h.calls.ticks, 1);
});

test("runTimedRoleTick skips an already-aborted tick but still releases its permit", async () => {
  const h = timedTickHarness([{ result: "changed" }]);
  const controller = new AbortController();
  controller.abort(); // Before the tick is even acquired: the documented regression —
  // addEventListener alone would never notice an abort that already happened.
  const elapsed = await runTimedRoleTick(controller.signal, h.acquire, h.release, h.tick, h.now);
  assert.equal(elapsed, null);
  assert.equal(h.calls.ticks, 0); // never started
  assert.equal(h.calls.release, 1); // permit returned even though the tick never ran
});

test("runTimedRoleTick returns null for an aborted tick outcome so it cannot drag the p75 window", async () => {
  for (const result of ["aborted", "user_aborted"] as const) {
    const h = timedTickHarness([{ result }]);
    const elapsed = await runTimedRoleTick(new AbortController().signal, h.acquire, h.release, h.tick, h.now);
    assert.equal(elapsed, null, `result ${result} must be excluded from the window`);
    assert.equal(h.calls.release, 1);
  }
  // A non-aborted failure still measures: an errored tick is a real duration the window wants.
  const h = timedTickHarness([{ result: "error" }]);
  const elapsed = await runTimedRoleTick(new AbortController().signal, h.acquire, h.release, h.tick, h.now);
  assert.equal(elapsed, 100);
});

test("runTimedRoleTick releases its permit when the tick throws", async () => {
  const h = timedTickHarness([]);
  const failing = async (): Promise<TickOutcome> => {
    throw new Error("tick exploded");
  };
  await assert.rejects(
    runTimedRoleTick(new AbortController().signal, h.acquire, h.release, failing, h.now),
    /tick exploded/,
  );
  assert.equal(h.calls.release, 1); // the finally block, not the happy path
});

test("sleepInterruptible sleeps out its duration when the signal never aborts", async () => {
  const start = Date.now();
  await sleepInterruptible(30, new AbortController().signal);
  assert.ok(Date.now() - start >= 20, "must wait roughly the full duration");
});

test("sleepInterruptible wakes immediately when the signal aborts mid-sleep", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  const start = Date.now();
  await sleepInterruptible(10_000, controller.signal);
  assert.ok(Date.now() - start < 5_000, "an abort mid-sleep must not wait out the full duration");
});

test("sleepInterruptible returns without waiting on an already-aborted signal", async () => {
  const controller = new AbortController();
  controller.abort();
  const start = Date.now();
  await sleepInterruptible(10_000, controller.signal);
  assert.ok(Date.now() - start < 5_000, "a pre-aborted signal must resolve immediately");
});

// BUGS.md 2026-09-24 — the display fix leans on this wiring: the orchestrator marks a loop
// `parkedSince` BEFORE the semaphore wait and clears it inside the acquire closure, so a
// parked waiter renders as an inactive state and the active rows track the real permit
// holders. Pinned here against the real Semaphore because the landing-holds-a-permit
// invariant otherwise lives only in the e2e tier.
test("a parked waiter holds no permit until acquire grants it, which the landing tier shares", async () => {
  const semaphore = new Semaphore(1);
  // Permit holder: a role tick that holds the only slot until its (gated) tick completes.
  let holderAcquired = false;
  let releaseHolder = () => {};
  const gate = new Promise<void>((r) => (releaseHolder = r));
  const holder = runTimedRoleTick(
    new AbortController().signal,
    async () => {
      await semaphore.acquire(0);
      holderAcquired = true;
    },
    () => semaphore.release(),
    async () => {
      await gate;
      return { result: "changed" } as TickOutcome;
    },
  );
  while (!holderAcquired) await new Promise((r) => setTimeout(r, 1));

  // A parked waiter and a landing, both queued behind the one held permit. Each clears its
  // parked marker exactly as the orchestrator's wrapped acquire does.
  const parked: Record<string, number | undefined> = { waiter: 1, landing: 1 };
  const waiter = runTimedRoleTick(
    new AbortController().signal,
    async () => {
      await semaphore.acquire(0);
      parked.waiter = undefined;
    },
    () => semaphore.release(),
    async () => ({ result: "changed" } as TickOutcome),
  );
  const landing = runTimedRoleTick(
    new AbortController().signal,
    async () => {
      await semaphore.acquire(-1); // LANDING_TIER: below every role tier
      parked.landing = undefined;
    },
    () => semaphore.release(),
    async () => ({ result: "changed" } as TickOutcome),
  );
  await new Promise((r) => setTimeout(r, 5));
  // Neither queued party holds a permit yet — the fleet serves at most the cap.
  assert.equal(parked.waiter, 1, "the waiter is still parked");
  assert.equal(parked.landing, 1, "the landing is still parked");

  // Releases hand the permit on: the lower tier number (the landing) goes first, the waiter
  // follows. Both clear their parked marker at grant, so no loop can stay an inactive row
  // while holding a permit.
  releaseHolder();
  await Promise.all([holder, waiter, landing]);
  assert.equal(parked.waiter, undefined);
  assert.equal(parked.landing, undefined);
});
