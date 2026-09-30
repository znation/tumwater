import type { TumwaterConfig } from "./config-schema.js";
import type { BudgetGate } from "./budget.js";
import {
  newBudgetGateState,
  pollBudgetGate,
  tickOnPair,
  type BudgetGateState,
} from "./budget-gates.js";
import { fallbackDemotion } from "./fallback-breaker.js";
import { newPauseGateState, pollPauseGates, type PauseGateState } from "./pause-gates.js";
import {
  newQuietHoursGateState,
  pollQuietHoursGate,
  type QuietHoursGateState,
} from "./quiet-hours.js";
import { pollErrorStorm, pollFailureSpread, pollFleetHold } from "./fleet-polls.js";
import { FLEET_OPEN, type FleetHold } from "./fleet-hold.js";
import { ERROR_STORM_QUIET, type ErrorStorm } from "./error-storm.js";
import { FAILURE_SPREAD_QUIET, type FailureSpread } from "./failure-spread.js";
import type { LoopRunner } from "./loop.js";
import { DIRECTOR_ROLE } from "./roles.js";
import { logEvent } from "./events.js";
import { writeJsonFile } from "./json-files.js";
import type { OrchestratorInfo } from "./fleet-state.js";

/** The orchestrator poll loop's fleet-wide gates and alarms, as one family: the daily cost
 * budget gate, the operator and per-role pause gates, quiet hours, the fleet-wide failure
 * hold, and the two observational storm alarms. Each gate's reads, edge-triggered events,
 * and cross-poll bookkeeping live in its own module (src/budget-gates.ts, src/pause-gates.ts,
 * src/quiet-hours.ts, and the fleet-health trio in src/fleet-polls.ts); this owns the wiring
 * half — one poll advances every gate's state in place. Split out of orchestrator.ts so the
 * poll loop reads as phases (reload → requests → gates → redeploy → landings → schedule →
 * start) and the gate family's wiring sits in one place, the same split fleet-polls.ts made
 * for the fleet-health trio. Dependency direction: orchestrator → gate-polls → the gate
 * modules. */

/** The gate family's cross-poll memory, constructed once per orchestrator run and mutated
 * in place by each poll. In memory only — a restart re-trusts the fallback, re-opens the
 * hold, and can re-log at most one event per gate. Two members are also mutated from
 * outside this module: the budget gate's breaker collects the start pass's tick evidence
 * and its probe (src/fallback-breaker.ts), and `fleetHold` is the hold's LATEST verdict,
 * read at permit time by the start pass's closures — read it from `states.fleetHold` at
 * call time, never from a per-poll snapshot (the poll loop's docs below). */
export interface FleetGateStates {
  budget: BudgetGateState;
  pause: PauseGateState;
  quiet: QuietHoursGateState;
  fleetHold: FleetHold;
  errorStorm: ErrorStorm;
  failureSpread: FailureSpread;
}

/** A fresh gate family: nothing seen yet, so the first poll of an unpaused, unheld fleet
 * logs nothing. The budget gate seeds its breaker and derived fallback view from the
 * startup config; a live reload replaces the config on the next poll. */
export function newFleetGateStates(config: TumwaterConfig): FleetGateStates {
  return {
    budget: newBudgetGateState(config),
    pause: newPauseGateState(),
    quiet: newQuietHoursGateState(),
    fleetHold: FLEET_OPEN,
    errorStorm: ERROR_STORM_QUIET,
    failureSpread: FAILURE_SPREAD_QUIET,
  };
}

/** One poll's verdicts, for the poll loop's scheduling and start passes of THIS poll: the
 * budget gate's value and the config role loops tick under, the two pause views, and
 * whether quiet hours hold now. Deliberately NOT the failure hold or the storm alarms:
 * the hold's verdict must be read fresh from `states.fleetHold` wherever it gates — a
 * permit-time closure runs after later polls have advanced the hold, so a destructured
 * per-poll copy would freeze the poll-time verdict and let a parked tick start into a
 * storm (or stay parked through a lift) that the latest poll already settled. */
interface FleetGatePoll {
  gate: BudgetGate;
  roleConfig: TumwaterConfig;
  userPaused: boolean;
  pausedRoles: ReadonlySet<string>;
  quietNow: boolean;
}

/** Inputs one poll needs: the live config the reload produced, the runner list (its states
 * feed the spend read and its config field is assigned here), and the orchestrator's info
 * file for the derived-state publish. */
interface FleetGatePollCtx {
  root: string;
  runners: readonly LoopRunner[];
  liveConfig: TumwaterConfig;
  modelsPath: string;
  now: number;
  info: OrchestratorInfo;
  infoFile: string;
}

/** Poll every fleet-wide gate and alarm, advancing `states` in place. */
export function pollFleetGates(
  states: FleetGateStates,
  ctx: FleetGatePollCtx,
): FleetGatePoll {
  const { root, runners, liveConfig, modelsPath, now, info, infoFile } = ctx;

  // Daily cost budget gate (src/budget-gates.ts owns the reads, the edge-triggered
  // budget_* events, the breaker re-key, and the fallback config view): the orchestrator
  // owns only the wiring — the demotion publish below and the per-runner assignment at
  // the bottom of this block.
  const { gate, roleConfig, spentUsd, capUsd, resumed: gateResumed, fallbackPair: leftPair } =
    pollBudgetGate(states.budget, {
    root,
    states: runners.map((r) => r.state),
    liveConfig,
    modelsPath,
  });
  // Publish what observers cannot derive themselves: the demotion (the dashboards' gate
  // and `tumwater doctor` would otherwise read the price alone and advertise a dead
  // fallback) and the gate's own spend/cap pair — summed over the runners' live states,
  // which every persisted-file reader lags by the in-flight runs' charges. Both rewritten
  // only when they change, like the build status; the exit removes the whole file, so no
  // stale pair survives a stop.
  const demotion = fallbackDemotion(states.budget.breaker);
  const budget = { spentUsd, capUsd };
  const demotionChanged = JSON.stringify(demotion) !== JSON.stringify(info.fallbackDemoted);
  const budgetChanged = JSON.stringify(budget) !== JSON.stringify(info.budget);
  if (demotionChanged || budgetChanged) {
    if (demotionChanged) info.fallbackDemoted = demotion;
    if (budgetChanged) info.budget = budget;
    writeJsonFile(infoFile, info);
  }
  // The director keeps the live config — an explicit human prompt outranks the
  // autonomous-spend cap. Assigned every poll (not only on transitions) so a runner
  // created mid-gate, or one left behind by a broken-file poll that skipped the reload,
  // can never tick on the wrong model.
  for (const r of runners) r.config = r.role === DIRECTOR_ROLE ? liveConfig : roleConfig;

  // The budget reopened: a tick that started on the fallback keeps it until it ends, so
  // hand those ticks back — abort them resumably (session and worktree edits kept) and
  // let their next tick continue the same session on the primary, whose config the
  // assignment above already installed (PLANS.md 2026-09-30). A tick started on the
  // primary keeps running, the director is exempt, and the landings (the slot's own runs)
  // are untouched. One event names who was handed back, so the resulting aborted ticks
  // read as the budget reopening, not as unexplained failures.
  if (gateResumed && leftPair) {
    const matching = runners.filter(
      (r) => r.role !== DIRECTOR_ROLE && tickOnPair(r.tickModel(), leftPair),
    );
    if (matching.length > 0) {
      logEvent(root, {
        loop: "harness",
        type: "budget_handback",
        roles: matching.map((r) => r.role),
        provider: leftPair.provider,
        model: leftPair.model,
      });
      for (const r of matching) r.handBackTick();
    }
  }

  // The pause gates (src/pause-gates.ts owns the reads, the edge-triggered pause/resume
  // events, and the cross-poll bookkeeping): the operator pause's marker and the per-role
  // pause's set, both read fresh per cycle so a marker change lands on the next poll.
  const { userPaused, pausedRoles } = pollPauseGates(root, states.pause);

  // Quiet hours (src/quiet-hours.ts): the config-driven daily local-time window during
  // which role loops start no new ticks — the operator pause's semantics on a schedule.
  // The config value is read fresh per cycle, so a live edit applies on the next poll;
  // exactly one quiet_hours_started/ended event per crossing. In-flight ticks finish;
  // the gate folds into the same hold site as the pause gates.
  const quietNow = pollQuietHoursGate(
    root,
    liveConfig.quietHours,
    states.quiet,
    new Date(now),
  );

  // Fleet-wide failure hold (src/fleet-hold.ts): once two roles' runs have ended on
  // the SAME provider failure kind within a short window — 429s, or a connection, timeout,
  // 5xx, or model-load backend failure — role loops start no new ticks — and the land
  // queue starts no new vet (the director's included), whose reviewer run has no retry
  // and would spend a review strike on the storm — until the hold re-opens at its own
  // deadline (Retry-After honoured on the rate-limit kind, doubling on a relapse, capped).
  // The director's ticks are exempt, as under the budget gate and the operator pause: an
  // explicit human prompt outranks an autonomous gate, one director run is not the
  // concurrency that sustains a storm, its 429 runs keep the per-run transient retry
  // (backend-failure kinds ride this hold alone), and a prompt its tick fails to fulfil
  // goes back to the inbox. In-flight ticks finish; NEW ticks are gated at scheduling like
  // both siblings, and a role tick already parked in the semaphore meets the same hold at
  // its permit (the start gate) and hands its reservation back instead of starting
  // into the storm. The verdict is written back to states.fleetHold — the scheduling pass
  // reads this poll's copy as `held`, and the permit-time closures read the LATEST poll's
  // copy there, so a waiter granted its permit after a later poll sees that poll's world.
  states.fleetHold = pollFleetHold(root, states.fleetHold, runners, now);

  // Fleet-wide error-storm warning (src/error-storm.ts): when several roles' tick streaks
  // fail consecutively on one shared cause, each role's own "consecutive tick failures"
  // warning still fires alone — this adds the one fleet-level warning that names the
  // cause (and the config knob, when the cause has one) instead of leaving the operator
  // to diff 14 streak lines. Observational only: it gates nothing, so unlike the failure
  // hold above there is no re-open event — the members' own recoveries tell that story.
  states.errorStorm = pollErrorStorm(root, states.errorStorm, runners);

  // Fleet-wide wide-shallow storm alarm (src/failure-spread.ts): when many roles each
  // fail a few times on one provider failure kind, the streak bar needs one role deep,
  // the error storm needs several roles deep, and the hold needs the failures close
  // together — this counts raw failures of one kind across roles in a rolling window,
  // so a degraded backend that fails the fleet widely and shallowly still names itself.
  // Observational only, like the error storm: it gates nothing.
  states.failureSpread = pollFailureSpread(root, states.failureSpread, runners, now);

  return { gate, roleConfig, userPaused, pausedRoles, quietNow };
}
