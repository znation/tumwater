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
import fs from "node:fs";

import { launchDueTicks } from "../src/orchestrator/orchestrator-launch.js";
import type { LoopRunner } from "../src/loop/loop.js";
import type { LoopState } from "../src/loop/loop-state.js";
import type { TickOutcome } from "../src/tick/tick-outcome.js";
import type { FleetGateStates } from "../src/gates/gate-polls.js";
import { IDLE_FALLBACK_BREAKER, rekeyFallbackBreaker, FALLBACK_BREAKER_POLICY, type FallbackBreaker } from "../src/budget/fallback-breaker.js";
import { Semaphore } from "../src/concurrency/semaphore.js";
import { DIRECTOR_ROLE } from "../src/roles/roles.js";
import { readEvents } from "../src/events/event-read.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { waitFor } from "./helpers/wait.js";

/** A stand-in runner: only what launchDueTicks reads. `config` is what runConfig returns —
 * the tick's pair comes from the runner's own config view (part 5c/8), or from its active
 * model-fallback episode in the real runner. */
function fakeRunner(
  role: string,
  tick: () => Promise<TickOutcome> = async () => ({ result: "changed" }),
  config: unknown = { roles: {} },
) {
  return {
    role,
    state: {} as LoopState,
    config,
    runConfig: () => config as ReturnType<LoopRunner["runConfig"]>,
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
    breakerNow: Date.now,
    probePair: null,
    probeRoles: new Set<string>(),
    budgetActive: false,
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

test("the probe goes to a runner whose tier resolves to the probed pair, one per poll", async () => {
  const cfg = { roles: {}, provider: "free", model: "qwen" };
  const first = fakeRunner("clean", undefined, cfg);
  const second = fakeRunner("organize", undefined, cfg);
  const breaker = rekeyFallbackBreaker(IDLE_FALLBACK_BREAKER, "free/qwen", 10);
  const c = ctx({
    reasons: new Map([[first, "scheduled"], [second, "scheduled"]]),
    probePair: "free/qwen",
    probeRoles: new Set(["clean", "organize"]),
    budgetActive: true,
    gateStates: emptyGateStates(breaker),
  });
  launchDueTicks(c);
  await settle(c);
  assert.ok(c.gateStates.budget.breakers["free/qwen"]?.probing === false, "the probe's evidence closed the probing flag");
  assert.equal(c.gateStates.budget.breakers["free/qwen"]?.failures, 0, "a served probe is not a failure");
  assert.equal(second.state.running ?? false, false, "the second eligible role was never reserved: one claim per poll");
  assert.equal(c.roleTickDurationsMs.length, 1, "only the probe ran");
  assert.equal(c.rolePermitHolders.size, 0);
});

test("a model-fallback tick folds its breaker evidence into the pair runConfig names, not the primary (PLANS.md 1/2)", async () => {
  // The runner's installed config is the primary (what configForRole would read), but its
  // active model-fallback episode means the tick runs the fallback pair, which runConfig —
  // the start pass's read — returns. The evidence must land on the fallback breaker; the
  // primary's must stay untouched.
  const primary = rekeyFallbackBreaker(IDLE_FALLBACK_BREAKER, "paid/gpt", 10);
  const fallback = rekeyFallbackBreaker(IDLE_FALLBACK_BREAKER, "free/qwen", 10);
  const gateStates = {
    budget: { breakers: { "paid/gpt": primary, "free/qwen": fallback }, engaged: "paid/gpt" },
  } as unknown as FleetGateStates;
  const runner = {
    role: "feature",
    state: {} as LoopState,
    config: { roles: {}, provider: "paid", model: "gpt" },
    runConfig: () => ({ roles: {}, provider: "free", model: "qwen" }),
    tick: async () => ({ result: "error" }) as TickOutcome,
  } as unknown as LoopRunner;
  const c = ctx({ reasons: new Map([[runner, "scheduled"]]), budgetActive: true, gateStates });
  launchDueTicks(c);
  await settle(c);
  assert.equal(c.gateStates.budget.breakers["free/qwen"]?.failures, 1, "the fallback pair carries the failure");
  assert.equal(c.gateStates.budget.breakers["paid/gpt"]?.failures, 0, "the abandoned primary stays clean");
});

test("a probe with no eligible runner leaves the other due launches alone (part 5c/8)", async () => {
  // The earlier draft continued every non-director runner when the probe's pair could not
  // admit one: a due pair whose tier has no due runner deadlocked the whole pass. Only the
  // pair's own tier's runners wait; everyone else launches normally.
  const other = fakeRunner("organize");
  const breaker = rekeyFallbackBreaker(IDLE_FALLBACK_BREAKER, "free/qwen", 10);
  const c = ctx({
    reasons: new Map([[other, "scheduled"]]),
    probePair: "free/qwen",
    probeRoles: new Set(["clean"]),
    gateStates: emptyGateStates(breaker),
  });
  launchDueTicks(c);
  await settle(c);
  assert.equal(c.gateStates.budget.breakers["free/qwen"]?.probing, false, "no claim was taken");
  assert.equal(c.roleTickDurationsMs.length, 1, "the non-probe role launched normally");
});

test("a probe turned away by the held start gate has its claim handed back", async () => {
  const runner = fakeRunner("clean");
  const breaker = rekeyFallbackBreaker(IDLE_FALLBACK_BREAKER, "free/qwen", 10);
  const c = ctx({
    reasons: new Map([[runner, "scheduled"]]),
    probePair: "free/qwen",
    probeRoles: new Set(["clean"]),
    gateStates: emptyGateStates(breaker),
    startHeld: () => true,
  });
  launchDueTicks(c);
  await settle(c);
  assert.equal(c.gateStates.budget.breakers["free/qwen"]?.probing, false, "the probe claim was abandoned, not left hanging");
  assert.equal(runner.state.running, false, "the probe tick never started, so no reservation remains");
});

test("a probe whose tick starts after the budget reopened has its claim handed back", async () => {
  // The probe is admitted for the demoted pair (the launch pass reads only the breaker
  // entry), but while it waits for its permit the budget gate reopens (the cap is raised
  // or midnight resets spend), so the tick starts with the budget inactive and no evidence
  // is folded into the pair — the claim must still be handed back, or the entry stays
  // probing and no later probe can ever run (the fallback stays demoted past its due probe).
  const runner = fakeRunner("clean");
  const breaker = rekeyFallbackBreaker(IDLE_FALLBACK_BREAKER, "free/qwen", 10);
  const gateStates = emptyGateStates(breaker);
  const c = ctx({
    reasons: new Map([[runner, "scheduled"]]),
    probePair: "free/qwen",
    probeRoles: new Set(["clean"]),
    budgetActive: false, // the reopen landed between admission and tick start
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

test("a rejected tick task is logged and un-reserved, not an unhandled rejection", async () => {
  // A LoopRunner.tick normally folds every failure into an `error` outcome, but a throw
  // before or after runTick (a finalize-time file write, a bug) rejects the task. The
  // launch pass chains its bucket cleanup off a detached `void task.finally(...)`, so the
  // rejection would surface as an unhandled rejection and kill the whole fleet. The drain
  // already awaits these with allSettled, so mirror that here.
  const runner = fakeRunner("organize", async () => {
    throw new Error("boom during finalize");
  });
  const c = ctx({ reasons: new Map([[runner, "scheduled"]]) });
  launchDueTicks(c);
  await Promise.allSettled([...c.roleInFlight]);
  await waitFor(() => c.roleInFlight.size === 0, "the rejected task to leave the bucket");
  assert.equal(runner.state.running, false, "the rejected reservation is handed back");
  const warnings = eventsOfType(c.root, "warning");
  assert.equal(warnings.length, 1, "one warning names the rejection");
  assert.match(String(warnings[0]!.message), /boom during finalize/);
});

test("a warning whose event write throws is reported to stderr, not left as an unhandled rejection", async () => {
  // The rejection handler reports the rejected tick through warnEvent, which writes the
  // events log. On a full or unwritable disk that write throws — inside the rejection
  // handler of a detached `void task.catch(...).finally(...)` chain — so the reporting
  // error would become the chain's own rejection, unhandled and fleet-ending, unless the
  // handler contains it. Sabotage the log (the root becomes a regular file, so
  // ensureParentDir cannot create .tumwater/log under it) and watch where the failure goes.
  const runner = fakeRunner("organize", async () => {
    throw new Error("boom during finalize");
  });
  const c = ctx({ reasons: new Map([[runner, "scheduled"]]) });
  const stderrWrites: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => {
    stderrWrites.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown): void => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", onRejection);
  try {
    launchDueTicks(c);
    fs.rmSync(c.root, { recursive: true, force: true });
    fs.writeFileSync(c.root, "");
    await waitFor(() => c.roleInFlight.size === 0, "the rejected task to leave the bucket");
    // Give a leaked rejection a turn to surface before the assertions.
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.stderr.write = originalWrite;
    process.off("unhandledRejection", onRejection);
  }
  assert.equal(runner.state.running, false, "the rejected reservation is handed back");
  assert.equal(rejections.length, 0, "no unhandled rejection escaped the detached chain");
  assert.ok(
    stderrWrites.some((line) => /boom during finalize/.test(line)),
    "the rejection is still reported, to stderr, when the event log is unwritable",
  );
});
