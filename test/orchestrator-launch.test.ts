/** Unit-tier coverage for the orchestrator's launch pass (src/orchestrator/orchestrator-launch.ts):
 * the half of the poll that turns the decision pass's due-runner map into reserved,
 * semaphore-gated, in-flight runs. Until now this wiring ran in no test at any tier:
 * runTimedRoleRun has its own unit tests and the orchestrator's fallback-probe admission
 * is covered end-to-end (orchestrator-probe.test.ts), but the launch mechanics — the
 * director's semaphore bypass, the parked-waiter/permit-holder bookkeeping, the start
 * gate handing a reservation back, the probe claim handed back when the gate turns it
 * away, the wake event, and the duration-sample fold — ran only inside full-repo runs,
 * where a slip in any of them would surface as a hung team, not a red test.
 *
 * The tests drive launchDueRuns directly with stand-in runners (the launch pass touches
 * only `role`, `state.running`, `state.parkedSince`, and `run()` on a RoleRunner), a real
 * Semaphore, and a real breaker; a zero-capacity semaphore makes the director's bypass
 * observable (the role parked behind it never gets a permit). */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { launchDueRuns } from "../src/orchestrator/orchestrator-launch.js";
import { DIRECTOR_ROLE } from "../src/roles/roles.js";
import type { RoleRunner } from "../src/runner/runner.js";
import type { RunnerState } from "../src/runner/runner-state.js";
import type { RunOutcome } from "../src/run/run-outcome.js";
import type { TeamGateStates } from "../src/gates/gate-polls.js";
import { IDLE_FALLBACK_BREAKER, rekeyFallbackBreaker, FALLBACK_BREAKER_POLICY, type FallbackBreaker } from "../src/budget/fallback-breaker.js";
import { Semaphore } from "../src/concurrency/semaphore.js";
import { readEvents } from "../src/events/event-read.js";
import { eventsLogPath } from "../src/paths.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { waitFor, sleep } from "./helpers/wait.js";
import { captureStderr } from "./helpers/exit-capture.js";

/** A stand-in runner: only what launchDueRuns reads. `config` is what runConfig returns —
 * the run's pair comes from the runner's own config view (part 5c/8), or from its active
 * model-fallback episode in the real runner. */
function fakeRunner(
  role: string,
  run: () => Promise<RunOutcome> = async () => ({ result: "changed" }),
  config: unknown = { roles: {} },
) {
  return {
    role,
    state: {} as RunnerState,
    config,
    runConfig: () => config as ReturnType<RoleRunner["runConfig"]>,
    run,
  } as unknown as RoleRunner;
}

function emptyGateStates(breaker: FallbackBreaker = IDLE_FALLBACK_BREAKER): TeamGateStates {
  const breakers = breaker.pair !== null ? { [breaker.pair]: breaker } : {};
  return { budget: { breakers, engaged: breaker.pair } } as unknown as TeamGateStates;
}

function ctx(overrides: Partial<Parameters<typeof launchDueRuns>[0]>) {
  return {
    root: tmpdir("launch-"),
    reasons: new Map<RoleRunner, string | undefined>(),
    signal: new AbortController().signal,
    gateStates: emptyGateStates(),
    breakerPolicy: FALLBACK_BREAKER_POLICY,
    breakerNow: Date.now,
    probePair: null,
    probeRoles: new Set<string>(),
    budgetActive: false,
    windowMovedRoles: new Set<string>(),
    semaphore: new Semaphore(4),
    rolePermitHolders: new Set<RoleRunner>(),
    roleInFlight: new Set<Promise<void>>(),
    directorInFlight: new Set<Promise<void>>(),
    roleRunDurationsMs: [],
    startHeld: () => false,
    ...overrides,
  };
}

async function settle(c: ReturnType<typeof ctx>): Promise<void> {
  await Promise.all([...c.roleInFlight, ...c.directorInFlight]);
}

test("a due role run parks, holds a permit, releases it, and folds its duration sample", async () => {
  const runner = fakeRunner("organize");
  const c = ctx({ reasons: new Map([[runner, "scheduled"]]) });
  launchDueRuns(c);
  // Reserved before the semaphore wait: not double-schedulable while parked.
  assert.equal(runner.state.running, true, "the reservation is held before the permit");
  assert.ok(typeof runner.state.parkedSince === "number", "a role parks while it waits");
  await settle(c);
  assert.equal(runner.state.parkedSince, undefined, "parking is cleared when the permit arrives");
  assert.equal(runner.state.running, true, "a started run keeps its reservation");
  assert.equal(c.rolePermitHolders.size, 0, "the permit was released at run end");
  assert.equal(c.roleInFlight.size, 0, "the finished task left the in-flight bucket");
  assert.equal(c.roleRunDurationsMs.length, 1, "one work-bearing run duration was sampled");
});

test("a role run that waits for the team slot logs a provider_wait event; an at-once admission and a director do not", async () => {
  // The only permit is held by another lease, so the role's admission waits on the one team
  // total (maxConcurrent). providerWaitMs: 0 is the test seam forcing even a sub-second wait to
  // be named.
  const semaphore = new Semaphore(1);
  const held = await semaphore.acquireLease(0);
  const runner = fakeRunner("feature", undefined, { provider: "omlx", model: "m", agent: "pi" });
  const c = ctx({ reasons: new Map([[runner, "scheduled"]]), semaphore, providerWaitMs: 0 });
  launchDueRuns(c);
  held.release(); // free the permit so the role's admission completes
  await settle(c);
  const waits = eventsOfType(c.root, "provider_wait");
  assert.equal(waits.length, 1, "one provider_wait event for the waiting admission");
  assert.equal(waits[0]!.role, "feature");
  assert.ok(!("key" in waits[0]!), "the wait names no provider key");
  assert.ok(!("cap" in waits[0]!), "the wait carries no cap field");
  assert.ok(!("limit" in waits[0]!), "the wait carries no limit field");
  assert.ok(Number(waits[0]!.waitedMs) >= 0, "the wait is measured, never NaN");

  // An unheld semaphore admits at once: at the default threshold nothing is logged.
  const atOnce = ctx({
    reasons: new Map([[fakeRunner("feature", undefined, { provider: "omlx", model: "m", agent: "pi" }), "scheduled"]]),
  });
  launchDueRuns(atOnce);
  await settle(atOnce);
  assert.equal(eventsOfType(atOnce.root, "provider_wait").length, 0);

  // The director never queues and never holds an admission wait, so it logs nothing.
  const director = fakeRunner(DIRECTOR_ROLE);
  const dc = ctx({ reasons: new Map([[director, "prompt"]]) });
  launchDueRuns(dc);
  await settle(dc);
  assert.equal(eventsOfType(dc.root, "provider_wait").length, 0);
});

test("the director never queues behind the semaphore and never samples the role drain window", async () => {
  // Capacity zero: a role run parked behind it never gets a permit, so the director
  // finishing anyway proves the bypass.
  const director = fakeRunner(DIRECTOR_ROLE);
  const role = fakeRunner("clean");
  const c = ctx({
    reasons: new Map([[director, "prompt"], [role, "scheduled"]]),
    semaphore: new Semaphore(0),
  });
  launchDueRuns(c);
  assert.equal(director.state.parkedSince, undefined, "the director never parks");
  assert.ok(typeof role.state.parkedSince === "number", "the role parks behind the empty semaphore");
  // The director's run completes while the role is still parked.
  await waitFor(() => c.directorInFlight.size === 0, "director run to finish");
  assert.equal(director.state.running, true, "the director's run happened");
  assert.equal(c.roleRunDurationsMs.length, 0, "director runs are not role-drain samples");
  assert.equal(c.directorInFlight.size, 0);
  assert.equal(c.roleInFlight.size, 1, "the role stays in flight, parked");
  // Clean up the parked task: aborting lets its acquire-return path settle the run.
  const parkedTask = [...c.roleInFlight][0]!;
  void parkedTask.catch(() => {});
});

test("a start gate held at permit time hands the reservation back with nothing started", async () => {
  let runCalls = 0;
  const runner = fakeRunner("organize", async () => ((runCalls += 1), { result: "changed" }));
  const c = ctx({ reasons: new Map([[runner, "scheduled"]]), startHeld: () => true });
  launchDueRuns(c);
  await settle(c);
  assert.equal(runCalls, 0, "the held run never started");
  assert.equal(runner.state.running, false, "the unstarted reservation was handed back");
  assert.equal(runner.state.parkedSince, undefined, "the parked-waiter marker was cleared");
  assert.equal(c.roleRunDurationsMs.length, 0, "no duration was sampled for a run that never started");
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
  launchDueRuns(c);
  await settle(c);
  assert.ok(c.gateStates.budget.breakers["free/qwen"]?.probing === false, "the probe's evidence closed the probing flag");
  assert.equal(c.gateStates.budget.breakers["free/qwen"]?.failures, 0, "a served probe is not a failure");
  assert.equal(second.state.running ?? false, false, "the second eligible role was never reserved: one claim per poll");
  assert.equal(c.roleRunDurationsMs.length, 1, "only the probe ran");
  assert.equal(c.rolePermitHolders.size, 0);
});

test("a model-fallback run folds its breaker evidence into the pair runConfig names, not the primary (PLANS.md 1/2)", async () => {
  // The runner's installed config is the primary (what configForRole would read), but its
  // active model-fallback episode means the run uses the fallback pair, which runConfig —
  // the start pass's read — returns. The evidence must end up on the fallback breaker; the
  // primary's must stay untouched.
  const primary = rekeyFallbackBreaker(IDLE_FALLBACK_BREAKER, "paid/gpt", 10);
  const fallback = rekeyFallbackBreaker(IDLE_FALLBACK_BREAKER, "free/qwen", 10);
  const gateStates = {
    budget: { breakers: { "paid/gpt": primary, "free/qwen": fallback }, engaged: "paid/gpt" },
  } as unknown as TeamGateStates;
  const runner = {
    role: "feature",
    state: {} as RunnerState,
    config: { roles: {}, provider: "paid", model: "gpt" },
    runConfig: () => ({ roles: {}, provider: "free", model: "qwen" }),
    run: async () => ({ result: "error" }) as RunOutcome,
  } as unknown as RoleRunner;
  const c = ctx({ reasons: new Map([[runner, "scheduled"]]), budgetActive: true, gateStates });
  launchDueRuns(c);
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
  launchDueRuns(c);
  await settle(c);
  assert.equal(c.gateStates.budget.breakers["free/qwen"]?.probing, false, "no claim was taken");
  assert.equal(c.roleRunDurationsMs.length, 1, "the non-probe role launched normally");
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
  launchDueRuns(c);
  await settle(c);
  assert.equal(c.gateStates.budget.breakers["free/qwen"]?.probing, false, "the probe claim was abandoned, not left hanging");
  assert.equal(runner.state.running, false, "the probe run never started, so no reservation remains");
});

test("a probe whose run starts after the budget reopened has its claim handed back", async () => {
  // The probe is admitted for the demoted pair (the launch pass reads only the breaker
  // entry), but while it waits for its permit the budget gate reopens (the cap is raised
  // or midnight resets spend), so the run starts with the budget inactive and no evidence
  // is folded into the pair — the claim must still be handed back, or the entry stays
  // probing and no later probe can ever run (the fallback stays demoted past its due probe).
  const runner = fakeRunner("clean");
  const breaker = rekeyFallbackBreaker(IDLE_FALLBACK_BREAKER, "free/qwen", 10);
  const gateStates = emptyGateStates(breaker);
  const c = ctx({
    reasons: new Map([[runner, "scheduled"]]),
    probePair: "free/qwen",
    probeRoles: new Set(["clean"]),
    budgetActive: false, // the reopen arrived between admission and run start
    gateStates,
  });
  launchDueRuns(c);
  await settle(c);
  assert.equal(c.gateStates.budget.breakers["free/qwen"]?.probing, false, "the probe claim was abandoned when no evidence was folded");
});

test("a due reason other than scheduled/startup logs a wake event", async () => {
  const runner = fakeRunner("organize");
  const c = ctx({ reasons: new Map([[runner, "operator"]]) });
  launchDueRuns(c);
  await settle(c);
  const wakes = readEvents(c.root).filter((e) => e.type === "wake");
  assert.equal(wakes.length, 1, "one wake event for the operator reason");
  assert.equal(wakes[0]!.source, "organize");
  const quiet = ctx({ reasons: new Map([[fakeRunner("clean"), "scheduled"]]) });
  launchDueRuns(quiet);
  await settle(quiet);
  assert.equal(readEvents(quiet.root).filter((e) => e.type === "wake").length, 0, "a scheduled run is not a wake");
});

test("an already-aborted signal launches nothing", async () => {
  const runner = fakeRunner("clean");
  const c = ctx({ reasons: new Map([[runner, "scheduled"]]), signal: AbortSignal.abort() });
  launchDueRuns(c);
  assert.equal(c.roleInFlight.size, 0, "no task was started");
  assert.equal(runner.state.running ?? false, false, "no reservation was taken");
});

test("a rejected run task is logged and un-reserved, not an unhandled rejection", async () => {
  // A RoleRunner.run normally folds every failure into an `error` outcome, but a throw
  // before or after runOnce (a finalize-time file write, a bug) rejects the task. The
  // launch pass chains its bucket cleanup off a detached `void task.finally(...)`, so the
  // rejection would surface as an unhandled rejection and kill the whole team. The drain
  // already awaits these with allSettled, so mirror that here.
  const runner = fakeRunner("organize", async () => {
    throw new Error("boom during finalize");
  });
  const c = ctx({ reasons: new Map([[runner, "scheduled"]]) });
  launchDueRuns(c);
  await Promise.allSettled([...c.roleInFlight]);
  await waitFor(() => c.roleInFlight.size === 0, "the rejected task to leave the bucket");
  assert.equal(runner.state.running, false, "the rejected reservation is handed back");
  const warnings = eventsOfType(c.root, "warning");
  assert.equal(warnings.length, 1, "one warning names the rejection");
  assert.match(String(warnings[0]!.message), /boom during finalize/);
});

test("a warning whose event write throws is reported to stderr, not left as an unhandled rejection", async () => {
  // The rejection handler reports the rejected run through warnEvent, which writes the
  // events log. On a full or unwritable disk that write throws — inside the rejection
  // handler of a detached `void task.catch(...).finally(...)` chain — so the reporting
  // error would become the chain's own rejection, unhandled and team-ending, unless the
  // handler contains it. Sabotage the log (the root becomes a regular file, so
  // ensureParentDir cannot create .tumwater/log under it) and watch where the failure goes.
  const runner = fakeRunner("organize", async () => {
    throw new Error("boom during finalize");
  });
  const c = ctx({ reasons: new Map([[runner, "scheduled"]]) });
  const stderr = captureStderr();
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown): void => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", onRejection);
  try {
    launchDueRuns(c);
    fs.rmSync(c.root, { recursive: true, force: true });
    fs.writeFileSync(c.root, "");
    await waitFor(() => c.roleInFlight.size === 0, "the rejected task to leave the bucket");
    // Give a leaked rejection a turn to surface before the assertions.
    await sleep(20);
  } finally {
    stderr.restore();
    process.off("unhandledRejection", onRejection);
  }
  assert.equal(runner.state.running, false, "the rejected reservation is handed back");
  assert.equal(rejections.length, 0, "no unhandled rejection escaped the detached chain");
  assert.match(
    stderr.err(),
    /boom during finalize/,
    "the rejection is still reported, to stderr, when the event log is unwritable",
  );
});

test("a wake event that cannot be logged still starts the due run", async () => {
  // The launch pass runs inside the orchestrator's catch-less poll loop: a wake for an
  // inbox/resume/main-moved run must not end the team when events.jsonl is unwritable.
  const root = tmpdir("launch-best-effort-wake-");
  const file = eventsLogPath(root);
  fs.rmSync(file, { recursive: true, force: true });
  fs.mkdirSync(file, { recursive: true });
  const runner = fakeRunner("clean");
  const c = ctx({ root, reasons: new Map([[runner, "main moved"]]) });
  // Before the fix this threw EISDIR before the reservation; the run must still start.
  launchDueRuns(c);
  assert.equal(runner.state.running, true, "the reservation is taken despite the unwritable feed");
  await settle(c);
  assert.equal(c.roleInFlight.size, 0, "the run finished");
});
