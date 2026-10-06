/** Unit-tier coverage for the orchestrator's launch pass (src/orchestrator/orchestrator-launch.ts):
 * the half of the poll that turns the decision pass's due-runner map into reserved,
 * semaphore-gated, in-flight ticks. Until now this wiring ran in no test at any tier:
 * runTimedRoleTick has its own unit tests and the orchestrator's fallback-probe admission
 * is covered end-to-end (orchestrator-probe.test.ts), but the launch mechanics — the
 * director's semaphore bypass, the parked-waiter/permit-holder bookkeeping, the start
 * gate handing a reservation back, the probe claim handed back when the gate turns it
 * away, the wake event, and the duration-sample fold — ran only inside full-repo runs,
 * where a slip in any of them would surface as a hung fleet, not a red test.
 *
 * The tests drive launchDueTicks directly with stand-in runners (the launch pass touches
 * only `role`, `state.running`, `state.parkedSince`, and `tick()` on a LoopRunner), a real
 * Semaphore, and a real breaker; a zero-capacity semaphore makes the director's bypass
 * observable (the role parked behind it never gets a permit). */

import test from "node:test";
import assert from "node:assert/strict";

import { launchDueTicks } from "../src/orchestrator/orchestrator-launch.js";
import type { LoopRunner } from "../src/loop/loop.js";
import type { LoopState } from "../src/loop/loop-state.js";
import type { TickOutcome } from "../src/tick/tick-outcome.js";
import type { FleetGateStates } from "../src/gates/gate-polls.js";
import { IDLE_FALLBACK_BREAKER, rekeyFallbackBreaker, FALLBACK_BREAKER_POLICY, type FallbackBreaker } from "../src/budget/fallback-breaker.js";
import { Semaphore } from "../src/concurrency/semaphore.js";
import { DIRECTOR_ROLE } from "../src/roles/roles.js";
import { readEvents } from "../src/events/event-read.js";
import { tmpdir } from "./repo-fixtures.js";
import { waitFor } from "./wait.js";

/** A stand-in runner: only what launchDueTicks reads. */
function fakeRunner(role: string, tick: () => Promise<TickOutcome> = async () => ({ result: "changed" })) {
  return {
    role,
    state: {} as LoopState,
    tick,
  } as unknown as LoopRunner;
}

function emptyGateStates(breaker: FallbackBreaker = IDLE_FALLBACK_BREAKER): FleetGateStates {
  const breakers = breaker.pair !== null ? { [breaker.pair]: breaker } : {};
  return { budget: { breakers, engaged: breaker.pair } } as unknown as FleetGateStates;
}

function ctx(overrides: Partial<Parameters<typeof launchDueTicks>[0]>) {
  return {
    root: tmpdir("launch-"),
    reasons: new Map<LoopRunner, string | undefined>(),
    signal: new AbortController().signal,
    gateStates: emptyGateStates(),
    breakerPolicy: FALLBACK_BREAKER_POLICY,
    probePair: null,
    semaphore: new Semaphore(4),
    rolePermitHolders: new Set<LoopRunner>(),
    roleInFlight: new Set<Promise<void>>(),
    directorInFlight: new Set<Promise<void>>(),
    roleTickDurationsMs: [],
    startHeld: () => false,
    ...overrides,
  };
}

async function settle(c: ReturnType<typeof ctx>): Promise<void> {
  await Promise.all([...c.roleInFlight, ...c.directorInFlight]);
}

test("a due role tick parks, holds a permit, releases it, and folds its duration sample", async () => {
  const runner = fakeRunner("organize");
  const c = ctx({ reasons: new Map([[runner, "scheduled"]]) });
  launchDueTicks(c);
  // Reserved before the semaphore wait: not double-schedulable while parked.
  assert.equal(runner.state.running, true, "the reservation is held before the permit");
  assert.ok(typeof runner.state.parkedSince === "number", "a role parks while it waits");
  await settle(c);
  assert.equal(runner.state.parkedSince, undefined, "parking is cleared when the permit lands");
  assert.equal(runner.state.running, true, "a started tick keeps its reservation");
  assert.equal(c.rolePermitHolders.size, 0, "the permit was released at tick end");
  assert.equal(c.roleInFlight.size, 0, "the finished task left the in-flight bucket");
  assert.equal(c.roleTickDurationsMs.length, 1, "one work-bearing tick duration was sampled");
});

test("the director never queues behind the semaphore and never samples the role drain window", async () => {
  // Capacity zero: a role tick parked behind it never gets a permit, so the director
  // finishing anyway proves the bypass.
  const director = fakeRunner(DIRECTOR_ROLE);
  const role = fakeRunner("clean");
  const c = ctx({
    reasons: new Map([[director, "prompt"], [role, "scheduled"]]),
    semaphore: new Semaphore(0),
  });
  launchDueTicks(c);
  assert.equal(director.state.parkedSince, undefined, "the director never parks");
  assert.ok(typeof role.state.parkedSince === "number", "the role parks behind the empty semaphore");
  // The director's tick completes while the role is still parked.
  await waitFor(() => c.directorInFlight.size === 0, "director tick to finish");
  assert.equal(director.state.running, true, "the director's tick ran");
  assert.equal(c.roleTickDurationsMs.length, 0, "director ticks are not role-drain samples");
  assert.equal(c.directorInFlight.size, 0);
  assert.equal(c.roleInFlight.size, 1, "the role stays in flight, parked");
  // Clean up the parked task: aborting lets its acquire-return path settle the tick.
  const parkedTask = [...c.roleInFlight][0]!;
  void parkedTask.catch(() => {});
});

test("a start gate held at permit time hands the reservation back with nothing started", async () => {
  let tickCalls = 0;
  const runner = fakeRunner("organize", async () => ((tickCalls += 1), { result: "changed" }));
  const c = ctx({ reasons: new Map([[runner, "scheduled"]]), startHeld: () => true });
  launchDueTicks(c);
  await settle(c);
  assert.equal(tickCalls, 0, "the held tick never started");
  assert.equal(runner.state.running, false, "the unstarted reservation was handed back");
  assert.equal(runner.state.parkedSince, undefined, "the parked-waiter marker was cleared");
  assert.equal(c.roleTickDurationsMs.length, 0, "no duration was sampled for a tick that never ran");
  assert.equal(c.rolePermitHolders.size, 0, "the permit was released");
});

test("probeDue admits exactly one probe tick and skips the other due roles", async () => {
  const first = fakeRunner("clean");
  const second = fakeRunner("organize");
  const breaker = rekeyFallbackBreaker(IDLE_FALLBACK_BREAKER, "free/qwen", 10);
  const c = ctx({ reasons: new Map([[first, "scheduled"], [second, "scheduled"]]), probePair: "free/qwen", gateStates: emptyGateStates(breaker) });
  launchDueTicks(c);
  await settle(c);
  assert.ok(c.gateStates.budget.breakers["free/qwen"]?.probing === false, "the probe's evidence closed the probing flag");
  assert.equal(c.gateStates.budget.breakers["free/qwen"]?.failures, 0, "a served probe is not a failure");
  assert.equal(second.state.running ?? false, false, "the second due role was never reserved");
  assert.equal(c.roleTickDurationsMs.length, 1, "only the probe ran");
  assert.equal(c.rolePermitHolders.size, 0);
});

test("a probe turned away by the held start gate has its claim handed back", async () => {
  const runner = fakeRunner("clean");
  const breaker = rekeyFallbackBreaker(IDLE_FALLBACK_BREAKER, "free/qwen", 10);
  const c = ctx({
    reasons: new Map([[runner, "scheduled"]]),
    probePair: "free/qwen",
    gateStates: emptyGateStates(breaker),
    startHeld: () => true,
  });
  launchDueTicks(c);
  await settle(c);
  assert.equal(c.gateStates.budget.breakers["free/qwen"]?.probing, false, "the probe claim was abandoned, not left hanging");
  assert.equal(runner.state.running, false, "the probe tick never started, so no reservation remains");
});

test("a probe whose tick starts after the gate reopened has its claim handed back", async () => {
  // The probe is admitted for the demoted pair (the launch pass reads only the breaker
  // entry), but while it waits for its permit the budget gate reopens (the cap is raised
  // or midnight resets spend), so the tick starts with `engaged` null and no evidence is
  // folded into the pair — the claim must still be handed back, or the entry stays probing
  // and no later probe can ever run (the fallback stays demoted past its due probe).
  const runner = fakeRunner("clean");
  const breaker = rekeyFallbackBreaker(IDLE_FALLBACK_BREAKER, "free/qwen", 10);
  const gateStates = emptyGateStates(breaker);
  gateStates.budget.engaged = null; // the reopen landed between admission and tick start
  const c = ctx({
    reasons: new Map([[runner, "scheduled"]]),
    probePair: "free/qwen",
    gateStates,
  });
  launchDueTicks(c);
  await settle(c);
  assert.equal(c.gateStates.budget.breakers["free/qwen"]?.probing, false, "the probe claim was abandoned when no evidence was folded");
});

test("a due reason other than scheduled/startup logs a wake event", async () => {
  const runner = fakeRunner("organize");
  const c = ctx({ reasons: new Map([[runner, "operator"]]) });
  launchDueTicks(c);
  await settle(c);
  const wakes = readEvents(c.root).filter((e) => e.type === "wake");
  assert.equal(wakes.length, 1, "one wake event for the operator reason");
  assert.equal(wakes[0]!.loop, "organize");
  const quiet = ctx({ reasons: new Map([[fakeRunner("clean"), "scheduled"]]) });
  launchDueTicks(quiet);
  await settle(quiet);
  assert.equal(readEvents(quiet.root).filter((e) => e.type === "wake").length, 0, "a scheduled tick is not a wake");
});

test("an already-aborted signal launches nothing", async () => {
  const runner = fakeRunner("clean");
  const c = ctx({ reasons: new Map([[runner, "scheduled"]]), signal: AbortSignal.abort() });
  launchDueTicks(c);
  assert.equal(c.roleInFlight.size, 0, "no task was started");
  assert.equal(runner.state.running ?? false, false, "no reservation was taken");
});