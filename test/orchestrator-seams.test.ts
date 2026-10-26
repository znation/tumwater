import { sleep, flushImmediate } from "./helpers/wait.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  MERGE_ABORT_SETTLE_FLOOR_MS,
  awaitMergeForHandoff,
  p75RunDurationMs,
  runTimedRoleRun,
  sleepInterruptible,
  type AfterDelay,
} from "../src/run/run-timing.js";
import { pollTeamHold, type HoldInputs } from "../src/team/team-polls.js";
import { Semaphore } from "../src/concurrency/semaphore.js";
import { readEvents } from "../src/events/event-read.js";
import { TEAM_OPEN, HOLD_BASE_MS, type TeamHold } from "../src/team/team-hold.js";

/** Step the team-hold poll from a single-provider prev and read the default provider's
 * hold back out of the per-provider map it returns (src/team/team-polls.ts). */
function stepHolds(
  root: string,
  prev: TeamHold | ReadonlyMap<string | undefined, TeamHold>,
  runners: readonly HoldInputs[],
  now: number,
): TeamHold {
  const prevMap = prev instanceof Map ? prev : new Map([[(prev as TeamHold).provider ?? undefined, prev]]);
  return pollTeamHold(root, prevMap, runners, now).get(undefined)!;
}
import { readMergeMarker, writeMergeMarker } from "../src/merge/merge-slot.js";
import type { RunOutcome } from "../src/run/run-outcome.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { warningMessages } from "./fixtures/log-fixtures.js";

// The orchestrator's exported unit-test seams (src/orchestrator/orchestrator.ts): the
// permit-holding
// wrapper that times a role run for the p75 redeploy window (and the p75 itself), the
// abort-wakeable poll sleep, and the restart hand-off's bounded merge wait. Both are small enough
// to pin without a team — the live orchestrator loop around
// them is the e2e tier's job — but each carries a documented edge case that could plausibly
// break (an already-aborted signal that addEventListener alone would never fire; an aborted
// run whose duration must not drag the window down), and none of that was under any unit
// test before this file.

/** A one-shot deadline scheduler the test fires by hand (see run-timing-edges.test.ts) so a
 * hand-off's windows pass deterministically instead of living through them. */
function scriptedAfter(): { after: AfterDelay; delays: number[]; pending(): number; fire(): void } {
  const pending: Array<() => void> = [];
  const delays: number[] = [];
  return {
    after: (ms, fn) => {
      delays.push(ms);
      pending.push(fn);
      return () => {
        const i = pending.indexOf(fn);
        if (i >= 0) pending.splice(i, 1);
      };
    },
    delays,
    pending: () => pending.length,
    fire: () => void pending.shift()?.(),
  };
}

/** Minimal recording harness for runTimedRoleRun: counts acquire/release, replays the given
 * run outcomes, and serves a controllable fake clock (each call advances by `stepMs`). */
function timedRunHarness(outcomes: RunOutcome[], stepMs = 100) {
  const calls = { acquire: 0, release: 0, runs: 0 };
  let nowMs = 0;
  return {
    calls,
    acquire: async () => void calls.acquire++,
    release: () => void calls.release++,
    run: async (): Promise<RunOutcome> => outcomes[calls.runs++] as RunOutcome,
    now: () => (nowMs += stepMs),
  };
}

test("runTimedRoleRun returns the run's wall-clock duration measured by the now seam", async () => {
  const h = timedRunHarness([{ result: "changed" }]);
  const elapsed = await runTimedRoleRun(new AbortController().signal, h.acquire, h.release, h.run, h.now);
  assert.equal(elapsed, 100); // startedAt = 100 (first call), end = 200 (second call)
  assert.equal(h.calls.acquire, 1);
  assert.equal(h.calls.release, 1);
  assert.equal(h.calls.runs, 1);
});

test("runTimedRoleRun skips an already-aborted run but still releases its permit", async () => {
  const h = timedRunHarness([{ result: "changed" }]);
  const controller = new AbortController();
  controller.abort(); // Before the run is even acquired: the documented regression —
  // addEventListener alone would never notice an abort that already happened.
  const elapsed = await runTimedRoleRun(controller.signal, h.acquire, h.release, h.run, h.now);
  assert.equal(elapsed, null);
  assert.equal(h.calls.runs, 0); // never started
  assert.equal(h.calls.release, 1); // permit returned even though the run never started
});

test("runTimedRoleRun returns null for an aborted run outcome so it cannot drag the p75 window", async () => {
  for (const result of ["aborted", "user_aborted"] as const) {
    const h = timedRunHarness([{ result }]);
    const elapsed = await runTimedRoleRun(new AbortController().signal, h.acquire, h.release, h.run, h.now);
    assert.equal(elapsed, null, `result ${result} must be excluded from the window`);
    assert.equal(h.calls.release, 1);
  }
  // A non-aborted failure still measures: an errored run is a real duration the window wants.
  const h = timedRunHarness([{ result: "error" }]);
  const elapsed = await runTimedRoleRun(new AbortController().signal, h.acquire, h.release, h.run, h.now);
  assert.equal(elapsed, 100);
});

test("runTimedRoleRun returns null for a run that ended without work so the window is not sized to re-checks", async () => {
  // The 2026-09-30 restart's drain window sampled 26 no_change re-checks out of 50 runs and
  // collapsed to 131 s — cutting a 14-minute coverage run off a few minutes in. A run
  // that ended with nothing to show (no_change, or skipped with nothing to run) says nothing
  // about how long the work the drain waits on takes, even when it did run the model.
  for (const result of ["no_change", "skipped"] as const) {
    const h = timedRunHarness([{ result }]);
    const elapsed = await runTimedRoleRun(new AbortController().signal, h.acquire, h.release, h.run, h.now);
    assert.equal(elapsed, null, `result ${result} must be excluded from the window`);
    assert.equal(h.calls.release, 1);
  }
  // A work-bearing outcome still measures — queued included: the sample's whole point.
  const h = timedRunHarness([{ result: "queued" }]);
  const elapsed = await runTimedRoleRun(new AbortController().signal, h.acquire, h.release, h.run, h.now);
  assert.equal(elapsed, 100);
});

test("runTimedRoleRun releases its permit when the run throws", async () => {
  const h = timedRunHarness([]);
  const failing = async (): Promise<RunOutcome> => {
    throw new Error("run exploded");
  };
  await assert.rejects(
    runTimedRoleRun(new AbortController().signal, h.acquire, h.release, failing, h.now),
    /run exploded/,
  );
  assert.equal(h.calls.release, 1); // the finally block, not the happy path
});

test("p75RunDurationMs: null below the sample floor, then the p75 of the samples", () => {
  assert.equal(p75RunDurationMs([]), null);
  assert.equal(p75RunDurationMs([1, 2, 3, 4, 5, 6, 7, 8, 9]), null, "nine samples is below the floor");
  // Ten samples 1..10: floor(10 * 0.75) = 7 -> the 8th value, 8.
  assert.equal(p75RunDurationMs([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 8);
  assert.equal(p75RunDurationMs([10, 1, 9, 2, 8, 3, 7, 4, 6, 5]), 8, "order-independent");
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

// BUGS.md 2026-09-24 — the display fix leans on this wiring: the orchestrator marks a role
// `parkedSince` BEFORE the semaphore wait and clears it inside the acquire closure, so a
// parked waiter renders as an inactive state and the active rows track the real permit
// holders. Pinned here against the real Semaphore because the merge-holds-a-permit
// invariant otherwise lives only in the e2e tier.
test("a parked waiter holds no permit until acquire grants it, which the merge tier shares", async () => {
  const semaphore = new Semaphore(1);
  // Permit holder: a role run that holds the only slot until its (gated) pi call completes.
  let holderAcquired = false;
  let releaseHolder = () => {};
  const gate = new Promise<void>((r) => (releaseHolder = r));
  const holder = runTimedRoleRun(
    new AbortController().signal,
    async () => {
      await semaphore.acquire(0);
      holderAcquired = true;
    },
    () => semaphore.release(),
    async () => {
      await gate;
      return { result: "changed" } as RunOutcome;
    },
  );
  while (!holderAcquired) await sleep(1);

  // A parked waiter and a merge, both queued behind the one held permit. Each clears its
  // parked marker exactly as the orchestrator's wrapped acquire does.
  const parked: Record<string, number | undefined> = { waiter: 1, merge: 1 };
  const waiter = runTimedRoleRun(
    new AbortController().signal,
    async () => {
      await semaphore.acquire(0);
      parked.waiter = undefined;
    },
    () => semaphore.release(),
    async () => ({ result: "changed" } as RunOutcome),
  );
  const merge = runTimedRoleRun(
    new AbortController().signal,
    async () => {
      await semaphore.acquire(-1); // VERIFY_TIER: below every role tier
      parked.merge = undefined;
    },
    () => semaphore.release(),
    async () => ({ result: "changed" } as RunOutcome),
  );
  await sleep(5);
  // Neither queued party holds a permit yet — the team serves at most the cap.
  assert.equal(parked.waiter, 1, "the waiter is still parked");
  assert.equal(parked.merge, 1, "the merge is still parked");

  // Releases hand the permit on: the lower tier number (the merge) goes first, the waiter
  // follows. Both clear their parked marker at grant, so no role can stay an inactive row
  // while holding a permit.
  releaseHolder();
  await Promise.all([holder, waiter, merge]);
  assert.equal(parked.waiter, undefined);
  assert.equal(parked.merge, undefined);
});

// BUGS.md 2026-09-23 — the restart drain's `hold` was checked only at scheduling, so a run
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
  const holder = runTimedRoleRun(
    new AbortController().signal,
    async () => {
      await semaphore.acquire(1);
      holderAcquired = true;
    },
    () => semaphore.release(),
    async () => {
      await gate;
      return { result: "changed" } as RunOutcome;
    },
    Date.now,
    held,
  );
  while (!holderAcquired) await sleep(1);

  // Two waiters reserved while the gate was still open (the scheduling-time check passed).
  const ran: string[] = [];
  const released: string[] = [];
  const parkedWaiter = (name: string) =>
    runTimedRoleRun(
      new AbortController().signal,
      () => semaphore.acquire(1),
      () => {
        released.push(name);
        semaphore.release();
      },
      async () => {
        ran.push(name);
        return { result: "changed" } as RunOutcome;
      },
      Date.now,
      held,
    );
  const first = parkedWaiter("first");
  const second = parkedWaiter("second");
  await sleep(5);

  hold = true; // the redeploy flips into `hold` while both are parked
  releaseHolder();
  assert.notEqual(await holder, null, "the permit holder that was already running finishes normally");
  assert.equal(await first, null, "a run turned away at its permit yields no drain sample");
  assert.equal(await second, null);
  assert.deepEqual(ran, [], "neither parked run started mid-drain");
  // Each released the permit it was handed, so the next waiter was granted it in turn and the
  // whole queue drained without starting anything — the permit is free again.
  assert.deepEqual(released, ["first", "second"]);
  let free = false;
  void semaphore.acquire(1).then(() => (free = true));
  await sleep(5);
  assert.equal(free, true, "no permit leaked to a run that never started");
  semaphore.release();

  // Control: once the hold lifts, a waiter granted a permit starts as before.
  hold = false;
  assert.notEqual(await parkedWaiter("after"), null);
  assert.deepEqual(ran, ["after"]);
});

// BUGS.md 2026-09-21 "A 429 storm still has no fleet-wide hold": the orchestrator's per-poll
// step reads every runner's latest 429 (RoleRunner.lastRateLimit), steps the pure gate
// (team-hold.test.ts pins its rule), and logs exactly one event per crossing — the team
// state transitions the digest's Team state changes section replays. Before the fix there was
// no cross-role input at all: two roles 429ing seconds apart changed nothing.
test("pollTeamHold trips on two roles' 429s, logs one event per crossing, and re-opens at its deadline", () => {
  const root = tmpdir();
  const now = 1_000_000_000;
  const holdEvents = () =>
    readEvents(root).filter((e) => e.type === "rate_limit_hold" || e.type === "rate_limit_resumed");
  const runners = [
    { role: "bugfix", lastRateLimit: { at: now - 5_000 }, lastBackendFailure: undefined },
    { role: "director", lastRateLimit: undefined, lastBackendFailure: undefined },
    { role: "clean", lastRateLimit: undefined, lastBackendFailure: undefined },
  ];

  // One role's 429 is the per-run retry's business: no hold, no event.
  let hold = stepHolds(root, TEAM_OPEN, runners, now);
  assert.equal(hold.until, null);
  assert.equal(holdEvents().length, 0);

  // A second role's run ends on a 429 inside the window: the hold trips, once.
  runners[2]!.lastRateLimit = { at: now };
  hold = stepHolds(root, hold, runners, now);
  assert.equal(hold.until, now + HOLD_BASE_MS);
  const [tripped] = holdEvents();
  assert.equal(tripped?.type, "rate_limit_hold");
  assert.equal(tripped?.source, "tumwater");
  assert.deepEqual(tripped?.roles, ["bugfix", "clean"]);
  assert.equal(tripped?.holdMs, HOLD_BASE_MS);
  assert.equal(tripped?.escalation, 0);

  // Steady polls while held log nothing more.
  hold = stepHolds(root, hold, runners, now + 2_000);
  hold = stepHolds(root, hold, runners, now + 4_000);
  assert.equal(holdEvents().length, 1);

  // At the deadline it re-opens by itself with one resumed event — and the 429s that tripped
  // it cannot re-trip it on the next poll.
  hold = stepHolds(root, hold, runners, now + HOLD_BASE_MS);
  assert.equal(hold.until, null);
  hold = stepHolds(root, hold, runners, now + HOLD_BASE_MS + 2_000);
  assert.deepEqual(
    holdEvents().map((e) => e.type),
    ["rate_limit_hold", "rate_limit_resumed"],
  );

  // The storm resumes right after re-open — the director's 429 counts as evidence too, since it
  // is the same provider: the next hold doubles, and its event says so.
  const relapseAt = now + HOLD_BASE_MS + 10_000;
  runners[0]!.lastRateLimit = { at: relapseAt };
  runners[1]!.lastRateLimit = { at: relapseAt };
  hold = stepHolds(root, hold, runners, relapseAt);
  const relapse = holdEvents().at(-1);
  assert.equal(relapse?.type, "rate_limit_hold");
  assert.deepEqual(relapse?.roles, ["bugfix", "director"]);
  assert.equal(relapse?.escalation, 1);
  assert.equal(relapse?.holdMs, 2 * HOLD_BASE_MS);
});

// The hold's generalization (PLANS.md 2026-09-29): the same poll gathers each runner's
// lastBackendFailure beside its lastRateLimit, and a storm of one backend kind trips and
// renders with the kind in the event payload — while a 429 storm keeps its exact wording.
test("pollTeamHold trips on two roles' same-kind backend failures and names the kind", () => {
  const root = tmpdir();
  const now = 1_000_000_000;
  const holdEvents = () =>
    readEvents(root).filter((e) => e.type === "rate_limit_hold" || e.type === "rate_limit_resumed");
  // The poll's structural runner shape (src/team/team-polls.ts HoldInputs), mutable so the test
  // moves the observations as the team's runs would (the runner's own getters are readonly).
  const runners: HoldInputs[] = [
    { role: "bugfix", lastRateLimit: undefined, lastBackendFailure: { at: now - 3_000, kind: "connection" } },
    { role: "director", lastRateLimit: undefined, lastBackendFailure: undefined },
    { role: "clean", lastRateLimit: undefined, lastBackendFailure: { at: now, kind: "timeout" as const } },
  ];

  // Different kinds, one role each: no storm of either, no event.
  let hold = stepHolds(root, TEAM_OPEN, runners, now);
  assert.equal(hold.until, null);
  assert.equal(holdEvents().length, 0);

  // The second connection error makes a connection storm; the timeout is not part of it.
  runners[2]!.lastBackendFailure = { at: now, kind: "connection" };
  hold = stepHolds(root, hold, runners, now);
  assert.equal(hold.until, now + HOLD_BASE_MS);
  const [tripped] = holdEvents();
  assert.equal(tripped?.type, "rate_limit_hold");
  assert.equal(tripped?.kind, "connection", "the event carries the hold's kind");
  assert.deepEqual(tripped?.roles, ["bugfix", "clean"]);
  assert.equal(tripped?.holdMs, HOLD_BASE_MS);

  // A rate-limit storm still behaves exactly as before the generalization: kind "rate-limit".
  // The poll past the connection hold's deadline re-opens it first (its own resumed event),
  // and only the NEXT poll — with fresh 429s after that re-open — trips the 429 storm.
  const rlAt = now + 10 * 60_000;
  hold = stepHolds(root, hold, runners, rlAt);
  assert.equal(hold.until, null, "the connection hold re-opened at its deadline");
  // The resumed event carries the ended hold's kind (BUGS.md 2026-09-29), so the lift can
  // name the connection error it lifted instead of a 429 that never happened.
  const connectionResumed = holdEvents().filter((e) => e.type === "rate_limit_resumed").at(-1);
  assert.equal(connectionResumed?.kind, "connection", "the resumed event carries the ended hold's kind");
  runners[0]!.lastRateLimit = { at: rlAt + 2_000 };
  runners[1]!.lastRateLimit = { at: rlAt + 2_000 };
  hold = stepHolds(root, hold, runners, rlAt + 2_000);
  const rlTrip = holdEvents().filter((e) => e.type === "rate_limit_hold").at(-1);
  assert.equal(rlTrip?.kind, "rate-limit");
  assert.deepEqual(rlTrip?.roles, ["bugfix", "director"]);
  assert.equal(rlTrip?.holdMs, HOLD_BASE_MS);
});

// BUGS.md 2026-09-23 — the restart hand-off's bounded wait on an in-flight merge. A merge
// promise stands in for the slot's task, so each phase (finished, aborted, abandoned) is
// reached deterministically: the e2e tier drives the real batch through the first abort.

test("awaitMergeForHandoff announces the wait and lets a merge that finishes in time complete", async () => {
  const root = tmpdir();
  let aborts = 0;
  const outcome = await awaitMergeForHandoff(
    root,
    { promise: sleep(20), roles: ["clean", "dedupe"] },
    5_000,
    () => void aborts++,
  );
  assert.equal(outcome, "finished");
  assert.equal(aborts, 0, "a merge inside its window is never aborted");
  const w = warningMessages(root);
  assert.equal(w.length, 1, "only the wait itself is announced");
  assert.match(w[0]!, /^restart waiting on the merge in progress for clean, dedupe \(deadline 5s\)$/);
});

test("awaitMergeForHandoff aborts a merge past its window and waits for it to stop", async () => {
  const root = tmpdir();
  let stop = () => {};
  const promise = new Promise<void>((r) => (stop = r));
  let aborts = 0;
  const startedAt = Date.now();
  const outcome = await awaitMergeForHandoff(root, { promise, roles: ["organize"] }, 200, () => {
    aborts++;
    setTimeout(stop, 20); // the aborted merge reaches its next step boundary and settles
  });
  assert.equal(outcome, "aborted");
  assert.equal(aborts, 1, "aborted exactly once, when the window lapsed");
  assert.ok(Date.now() - startedAt >= 200, "the merge had its whole window first");
  const w = warningMessages(root);
  assert.equal(w.length, 2);
  assert.match(w[1]!, /the merge for organize outlived its 0\.2s deadline — aborted/, "the lapse names what was awaited");
});

test("awaitMergeForHandoff hands off without a merge still running after the abort, clearing its marker", async () => {
  const root = tmpdir();
  writeMergeMarker(root, { role: "clean", sha: "a".repeat(40), summary: "wedged", startedAt: Date.now(), stage: "build-check" });
  const timers = scriptedAfter();
  let aborts = 0;
  // Never settles: a step wedged past its own bound, which no abort reaches.
  const outcome = awaitMergeForHandoff(root, { promise: new Promise(() => {}), roles: ["clean"] }, 100, () => void aborts++, timers.after);
  await flushImmediate();
  assert.equal(timers.delays[0], 100, "the deadline is the window, so the lapse comes quickly");
  timers.fire(); // the deadline lapses — the merge is aborted
  await flushImmediate();
  assert.equal(aborts, 1);
  assert.equal(
    timers.delays[1],
    MERGE_ABORT_SETTLE_FLOOR_MS,
    "the abort's settle gets the floor, decoupled from the tight deadline (BUGS.md 2026-10-26)",
  );
  timers.fire(); // the settle allowance elapses with the merge still wedged
  assert.equal(await outcome, "abandoned");
  assert.equal(readMergeMarker(root), null, "the exiting process's marker is cleared for the next generation");
  const w = warningMessages(root);
  assert.equal(w.length, 3);
  assert.match(w[2]!, /the aborted merge for clean was still running 10s later — restarting without it/);
});

test("awaitMergeForHandoff gives an aborted merge the settle floor, so a short deadline cannot abandon it mid-stop", async () => {
  const root = tmpdir();
  const timers = scriptedAfter();
  let stop = () => {};
  const promise = new Promise<void>((r) => (stop = r));
  let aborts = 0;
  const outcome = awaitMergeForHandoff(root, { promise, roles: ["organize"] }, 1, () => {
    aborts++;
    // The abort reaches the merge at its next step boundary (here, at once — after the 1 ms
    // deadline, long past where the old code would have abandoned it), and it records aborted.
    stop();
  }, timers.after);
  await flushImmediate();
  timers.fire(); // 1 ms deadline lapses — abort fires, the settle window arms
  await flushImmediate();
  assert.equal(aborts, 1);
  assert.equal(timers.delays[1], MERGE_ABORT_SETTLE_FLOOR_MS, "the settle window is the floor, not the 1 ms deadline");
  assert.equal(await outcome, "aborted", "a merge that stops past a tiny deadline is aborted, not abandoned");
});
