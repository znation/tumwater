import test from "node:test";
import assert from "node:assert/strict";
import { awaitLandingForHandoff, pollRateLimitHold, runTimedRoleTick, sleepInterruptible } from "../src/orchestrator.js";
import { Semaphore } from "../src/semaphore.js";
import { readEvents } from "../src/events.js";
import { RATE_LIMIT_HOLD_BASE_MS, RATE_LIMIT_OPEN } from "../src/rate-limit-hold.js";
import { readLandingMarker, writeLandingMarker } from "../src/landing-slot.js";
import type { TickOutcome } from "../src/types.js";
import { tmpdir } from "./util.js";

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

// BUGS.md 2026-09-23 — the restart drain's `hold` was checked only at scheduling, so a tick
// reserved in an earlier poll and parked in the semaphore queue started a fresh pi run the
// moment a slot freed mid-drain. The gate is re-checked when the permit is granted: the Repro,
// against the real Semaphore — park waiters behind a held permit, flip the hold on, free the
// permit.
test("a waiter parked before a restart hold is turned away at its permit, which it hands on unused", async () => {
  const semaphore = new Semaphore(1);
  let hold = false;
  const held = () => hold;
  let releaseHolder = () => {};
  const gate = new Promise<void>((r) => (releaseHolder = r));
  let holderAcquired = false;
  const holder = runTimedRoleTick(
    new AbortController().signal,
    async () => {
      await semaphore.acquire(1);
      holderAcquired = true;
    },
    () => semaphore.release(),
    async () => {
      await gate;
      return { result: "changed" } as TickOutcome;
    },
    Date.now,
    held,
  );
  while (!holderAcquired) await new Promise((r) => setTimeout(r, 1));

  // Two waiters reserved while the gate was still open (the scheduling-time check passed).
  const ran: string[] = [];
  const released: string[] = [];
  const parkedWaiter = (name: string) =>
    runTimedRoleTick(
      new AbortController().signal,
      () => semaphore.acquire(1),
      () => {
        released.push(name);
        semaphore.release();
      },
      async () => {
        ran.push(name);
        return { result: "changed" } as TickOutcome;
      },
      Date.now,
      held,
    );
  const first = parkedWaiter("first");
  const second = parkedWaiter("second");
  await new Promise((r) => setTimeout(r, 5));

  hold = true; // the redeploy flips into `hold` while both are parked
  releaseHolder();
  assert.notEqual(await holder, null, "the permit holder that was already running finishes normally");
  assert.equal(await first, null, "a tick turned away at its permit yields no drain sample");
  assert.equal(await second, null);
  assert.deepEqual(ran, [], "neither parked tick started its run mid-drain");
  // Each released the permit it was handed, so the next waiter was granted it in turn and the
  // whole queue drained without starting anything — the permit is free again.
  assert.deepEqual(released, ["first", "second"]);
  let free = false;
  void semaphore.acquire(1).then(() => (free = true));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(free, true, "no permit leaked to a tick that never started");
  semaphore.release();

  // Control: once the hold lifts, a waiter granted a permit starts as before.
  hold = false;
  assert.notEqual(await parkedWaiter("after"), null);
  assert.deepEqual(ran, ["after"]);
});

// BUGS.md 2026-09-21 "A 429 storm still has no fleet-wide hold": the orchestrator's per-poll
// step reads every runner's latest 429 (LoopRunner.lastRateLimit), steps the pure gate
// (rate-limit-hold.test.ts pins its rule), and logs exactly one event per crossing — the fleet
// state transitions the digest's Fleet state changes section replays. Before the fix there was
// no cross-role input at all: two roles 429ing seconds apart changed nothing.
test("pollRateLimitHold trips on two roles' 429s, logs one event per crossing, and re-opens at its deadline", () => {
  const root = tmpdir();
  const now = 1_000_000_000;
  const holdEvents = () =>
    readEvents(root).filter((e) => e.type === "rate_limit_hold" || e.type === "rate_limit_resumed");
  const runners = [
    { role: "bugfix", lastRateLimit: { at: now - 5_000 } },
    { role: "director", lastRateLimit: undefined },
    { role: "clean", lastRateLimit: undefined },
  ];

  // One role's 429 is the per-run retry's business: no hold, no event.
  let hold = pollRateLimitHold(root, RATE_LIMIT_OPEN, runners, now);
  assert.equal(hold.until, null);
  assert.equal(holdEvents().length, 0);

  // A second role's run ends on a 429 inside the window: the hold trips, once.
  runners[2]!.lastRateLimit = { at: now };
  hold = pollRateLimitHold(root, hold, runners, now);
  assert.equal(hold.until, now + RATE_LIMIT_HOLD_BASE_MS);
  const [tripped] = holdEvents();
  assert.equal(tripped?.type, "rate_limit_hold");
  assert.equal(tripped?.loop, "harness");
  assert.deepEqual(tripped?.roles, ["bugfix", "clean"]);
  assert.equal(tripped?.holdMs, RATE_LIMIT_HOLD_BASE_MS);
  assert.equal(tripped?.escalation, 0);

  // Steady polls while held log nothing more.
  hold = pollRateLimitHold(root, hold, runners, now + 2_000);
  hold = pollRateLimitHold(root, hold, runners, now + 4_000);
  assert.equal(holdEvents().length, 1);

  // At the deadline it re-opens by itself with one resumed event — and the 429s that tripped
  // it cannot re-trip it on the next poll.
  hold = pollRateLimitHold(root, hold, runners, now + RATE_LIMIT_HOLD_BASE_MS);
  assert.equal(hold.until, null);
  hold = pollRateLimitHold(root, hold, runners, now + RATE_LIMIT_HOLD_BASE_MS + 2_000);
  assert.deepEqual(
    holdEvents().map((e) => e.type),
    ["rate_limit_hold", "rate_limit_resumed"],
  );

  // The storm resumes right after re-open — the director's 429 counts as evidence too, since it
  // is the same provider: the next hold doubles, and its event says so.
  const relapseAt = now + RATE_LIMIT_HOLD_BASE_MS + 10_000;
  runners[0]!.lastRateLimit = { at: relapseAt };
  runners[1]!.lastRateLimit = { at: relapseAt };
  hold = pollRateLimitHold(root, hold, runners, relapseAt);
  const relapse = holdEvents().at(-1);
  assert.equal(relapse?.type, "rate_limit_hold");
  assert.deepEqual(relapse?.roles, ["bugfix", "director"]);
  assert.equal(relapse?.escalation, 1);
  assert.equal(relapse?.holdMs, 2 * RATE_LIMIT_HOLD_BASE_MS);
});

// BUGS.md 2026-09-23 — the restart hand-off's bounded wait on an in-flight landing. A landing
// promise stands in for the slot's task, so each phase (finished, aborted, abandoned) is
// reached deterministically: the e2e tier drives the real batch through the first abort.

/** The warning messages logged under `root`, in order. */
function warnings(root: string): string[] {
  return readEvents(root)
    .filter((e) => e.type === "warning")
    .map((e) => String(e.message));
}

test("awaitLandingForHandoff announces the wait and lets a landing that finishes in time land", async () => {
  const root = tmpdir();
  let aborts = 0;
  const outcome = await awaitLandingForHandoff(
    root,
    { promise: new Promise((r) => setTimeout(r, 20)), roles: ["clean", "dry"] },
    5_000,
    () => void aborts++,
  );
  assert.equal(outcome, "finished");
  assert.equal(aborts, 0, "a landing inside its window is never aborted");
  const w = warnings(root);
  assert.equal(w.length, 1, "only the wait itself is announced");
  assert.match(w[0]!, /^restart hand-off waiting on the in-flight landing of clean, dry \(deadline 5s\)$/);
});

test("awaitLandingForHandoff aborts a landing past its window and waits for it to stop", async () => {
  const root = tmpdir();
  let stop = () => {};
  const promise = new Promise<void>((r) => (stop = r));
  let aborts = 0;
  const startedAt = Date.now();
  const outcome = await awaitLandingForHandoff(root, { promise, roles: ["organize"] }, 200, () => {
    aborts++;
    setTimeout(stop, 20); // the aborted landing reaches its next step boundary and settles
  });
  assert.equal(outcome, "aborted");
  assert.equal(aborts, 1, "aborted exactly once, when the window lapsed");
  assert.ok(Date.now() - startedAt >= 200, "the landing had its whole window first");
  const w = warnings(root);
  assert.equal(w.length, 2);
  assert.match(w[1]!, /the landing of organize outlived its 0\.2s deadline — aborted/, "the lapse names what was awaited");
});

test("awaitLandingForHandoff hands off without a landing still running after the abort, clearing its marker", async () => {
  const root = tmpdir();
  writeLandingMarker(root, { role: "clean", sha: "a".repeat(40), summary: "wedged", startedAt: Date.now(), stage: "build-check" });
  let aborts = 0;
  const startedAt = Date.now();
  // Never settles: a step wedged past its own bound, which no abort reaches.
  const outcome = await awaitLandingForHandoff(root, { promise: new Promise(() => {}), roles: ["clean"] }, 100, () => void aborts++);
  const elapsed = Date.now() - startedAt;
  assert.equal(outcome, "abandoned");
  assert.equal(aborts, 1);
  assert.ok(elapsed >= 200 && elapsed < 5_000, `the hand-off is bounded by two windows (${elapsed}ms)`);
  assert.equal(readLandingMarker(root), null, "the exiting process's marker is cleared for the next generation");
  const w = warnings(root);
  assert.equal(w.length, 3);
  assert.match(w[2]!, /the aborted landing of clean was still running 0\.1s later — handing off without it/);
});
