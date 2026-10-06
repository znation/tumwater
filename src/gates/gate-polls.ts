import type { TumwaterConfig } from "../config/config-schema.js";
import type { BudgetGate } from "../budget.js";
import {
  gateRoleConfig,
  newBudgetGateState,
  pollBudgetGate,
  tickOnPair,
  type BudgetGateState,
} from "./budget-gates.js";
import { fallbackDemotion } from "../fallback-breaker.js";
import { newPauseGateState, pollPauseGates, type PauseGateState } from "./pause-gates.js";
import { newStreakGateState, pollStreakGate, type StreakGateState } from "./streak-gate.js";
import {
  newRoleCapGateState,
  pollRoleCapGate,
  type RoleCapGateState,
} from "./role-cap-gates.js";
import {
  newQuietHoursGateState,
  pollQuietHoursGate,
  roleQuietHold,
  type QuietHoursGateState,
} from "../quiet-hours.js";
import { pollErrorStorm, pollFailureSpread, pollFleetHold, type HoldInputs } from "../fleet/fleet-polls.js";
import { type FleetHold } from "../fleet/fleet-hold.js";
import { ERROR_STORM_QUIET, type ErrorStorm } from "../error-storm.js";
import { FAILURE_SPREAD_QUIET, type FailureSpread } from "../failure/failure-spread.js";
import type { LoopRunner } from "../loop/loop.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";
import { logEvent } from "../events/events.js";
import { writeJsonFile } from "../json-files.js";
import type { OrchestratorInfo } from "../fleet/fleet-state.js";
import { configForRole } from "../config/config-views.js";

/** The orchestrator poll loop's fleet-wide gates and alarms, as one family: the daily cost
 * budget gate, the operator and per-role pause gates, quiet hours, the fleet-wide failure
 * hold, and the two observational storm alarms. Each gate's reads, edge-triggered events,
 * and cross-poll bookkeeping live in its own module (src/gates/budget-gates.ts, src/gates/pause-gates.ts,
 * src/quiet-hours.ts, and the fleet-health trio in src/fleet/fleet-polls.ts); this owns the wiring
 * half — one poll advances every gate's state in place. Split out of orchestrator.ts so the
 * poll loop reads as phases (reload → requests → gates → redeploy → landings → schedule →
 * start) and the gate family's wiring sits in one place, the same split fleet/fleet-polls.ts made
 * for the fleet-health trio. Dependency direction: orchestrator → gate-polls → the gate
 * modules. */

/** The gate family's cross-poll memory, constructed once per orchestrator run and mutated
 * in place by each poll. In memory only — a restart re-trusts the fallback, re-opens the
 * hold, and can re-log at most one event per gate. Two members are also mutated from
 * outside this module: the budget gate's breaker collects the start pass's tick evidence
 * and its probe (src/fallback-breaker.ts), and `fleetHold` is the holds-per-provider map —
 * the holds' LATEST verdicts, read at permit time by the start pass's closures — read it
 * from `states.fleetHold` at call time, never from a per-poll snapshot (the poll loop's
 * docs below). Key presence is not "held": providers whose hold re-opened stay in the map
 * for their relapse memory, so every consumer goes through fleet/fleet-hold.ts's heldProviders(). */
export interface FleetGateStates {
  budget: BudgetGateState;
  pause: PauseGateState;
  streak: StreakGateState;
  cap: RoleCapGateState;
  quiet: QuietHoursGateState;
  fleetHold: ReadonlyMap<string | undefined, FleetHold>;
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
    streak: newStreakGateState(),
    cap: newRoleCapGateState(),
    quiet: newQuietHoursGateState(),
    fleetHold: new Map(),
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
  capPaused: ReadonlySet<string>;
  /** The roles (the director excluded) whose own `quietHoursPerRole` window holds right now:
   * a stateless verdict recomputed every poll beside `capPaused` — no event, no bookkeeping
   * (the pause marker is anonymous and must never masquerade as an operator's schedule). */
  roleQuietHeld: ReadonlySet<string>;
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

  // Daily cost budget gate (src/gates/budget-gates.ts owns the reads, the edge-triggered
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
  const engagedBreaker = states.budget.engaged !== null ? states.budget.breakers[states.budget.engaged] : undefined;
  const demotion = engagedBreaker ? fallbackDemotion(engagedBreaker) : undefined;
  const budget = { spentUsd, capUsd };
  const demotionChanged = JSON.stringify(demotion) !== JSON.stringify(info.fallbackDemoted);
  const budgetChanged = JSON.stringify(budget) !== JSON.stringify(info.budget);
  if (demotionChanged || budgetChanged) {
    if (demotionChanged) info.fallbackDemoted = demotion;
    if (budgetChanged) info.budget = budget;
    writeJsonFile(infoFile, info);
  }
  // The director keeps the live config — an explicit human prompt outranks the
  // autonomous-spend cap (gateRoleConfig). Assigned every poll (not only on transitions)
  // so a runner created mid-gate, or one left behind by a broken-file poll that skipped
  // the reload, can never tick on the wrong model.
  for (const r of runners) r.config = gateRoleConfig(r.role, liveConfig, roleConfig);

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

  // The pause gates (src/gates/pause-gates.ts owns the reads, the edge-triggered pause/resume
  // events, and the cross-poll bookkeeping): the operator pause's marker and the per-role
  // pause's set, both read fresh per cycle so a marker change lands on the next poll.
  const { userPaused, pausedRoles } = pollPauseGates(root, states.pause);

  // The error-streak circuit breaker (src/gates/streak-gate.ts): a role past ERROR_STREAK_BREAKER
  // consecutive failed ticks is paused through the same per-role marker the operator's
  // `pause --role` writes — act-on-it where the warn bar and the storm alarms only talk. The
  // director is not exempt; a failing director cannot process prompts anyway. Roles it just
  // paused fold into this poll's paused-roles view, so the scheduler blocks them on this very
  // poll instead of the next one.
  const streakPaused = pollStreakGate(root, states.streak, runners, pausedRoles);
  // pollPauseGates advanced its edge-triggered bookkeeping BEFORE the breaker wrote its
  // marker, so without this fold the NEXT poll would log a generic role_paused for a pause
  // the breaker already announced as role_streak_paused — one pause, two events, the second
  // mislabeled as an operator action (BUGS.md 2026-09-30). The trips are not the pause
  // gates' to announce; a later operator resume still logs role_resumed as usual.
  for (const role of streakPaused) states.pause.prevPausedRoles.add(role);
  const pausedRolesNow =
    streakPaused.length > 0 ? new Set([...pausedRoles, ...streakPaused]) : pausedRoles;

  // The per-role daily cost cap (src/gates/role-cap-gates.ts): a loop whose local-day spend has
  // reached its own maxDailyCostUsdPerRole entry starts no new ticks — the stateless verdict
  // recomputed every poll, no pause marker written (the marker is anonymous; a cap pause must
  // never masquerade as an operator's), so this returns its own set beside pausedRoles and the
  // pause gates' edge bookkeeping never sees it. A live config edit applies on the next poll;
  // local midnight lifts the verdict by itself.
  const capPaused = pollRoleCapGate(root, states.cap, runners, liveConfig.maxDailyCostUsdPerRole, now);

  // Per-role quiet hours (src/quiet-hours.ts): a role whose own quietHoursPerRole window
  // covers `now` starts no new ticks — the fleet window's semantics scoped to one loop, the
  // director exempt like every autonomous gate. Stateless, recomputed per poll exactly like
  // capPaused: no crossing events, no state — a live config edit applies on the next poll
  // by construction. A role held by BOTH windows is held once: the scheduling pass folds
  // both verdicts into one hold condition, nothing counts a role twice.
  const roleQuietHeld = new Set<string>();
  for (const r of runners) {
    if (r.role === DIRECTOR_ROLE) continue;
    if (roleQuietHold(liveConfig.quietHoursPerRole, r.role, new Date(now))) roleQuietHeld.add(r.role);
  }

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

  // Each runner as the two provider-failure polls read it (HoldInputs): the role, its two
  // episodic fields, and the provider its runs resolve to (configForRole — the run's
  // resolved config; undefined when pi's default is in charge). Built ONCE per poll so the
  // hold and the spread read the same list, like holdObservations on the reducer side.
  const holdInputs = (config: TumwaterConfig, rs: readonly LoopRunner[]): HoldInputs[] =>
    rs.map((r) => ({
      role: r.role,
      provider: configForRole(config, r.role).provider,
      ...(r.lastRateLimit ? { lastRateLimit: r.lastRateLimit } : {}),
      ...(r.lastBackendFailure ? { lastBackendFailure: r.lastBackendFailure } : {}),
    }));

  // Fleet-wide failure hold, per provider (src/fleet/fleet-hold.ts, PLANS.md 2026-10-05): once two
  // roles' runs have ended on the SAME provider AND failure kind within a short window —
  // 429s, or a connection, timeout, 5xx, or model-load backend failure — role loops on THAT
  // provider start no new ticks, and the land queue starts no new vet, whose reviewer run
  // has no retry and would spend a review strike on the storm — until the hold re-opens at
  // its own deadline (Retry-After honoured on the rate-limit kind, doubling on a relapse,
  // capped). Roles on a healthy provider keep ticking; a hold on the reviewer's provider
  // (with the review gate on) still blocks everything, since nothing could land — the
  // orchestrator's scheduling and start passes derive that verdict from this map. The
  // director's ticks are exempt, as under the budget gate and the operator pause: an
  // explicit human prompt outranks an autonomous gate, one director run is not the
  // concurrency that sustains a storm, its 429 runs keep the per-run transient retry
  // (backend-failure kinds ride this hold alone), and a prompt its tick fails to fulfil
  // goes back to the inbox. In-flight ticks finish; NEW ticks are gated at scheduling like
  // both siblings, and a role tick already parked in the semaphore meets the same hold at
  // its permit (the start gate) and hands its reservation back instead of starting
  // into the storm. The verdicts are written back to states.fleetHold — one hold per
  // provider, lifted holds kept keyed for their relapse memory but never reading as held —
  // and the permit-time closures read the LATEST poll's map there, so a waiter granted its
  // permit after a later poll sees that poll's world.
  states.fleetHold = pollFleetHold(root, states.fleetHold, holdInputs(liveConfig, runners), now);

  // Fleet-wide error-storm warning (src/error-storm.ts): when several roles' tick streaks
  // fail consecutively on one shared cause, each role's own "consecutive tick failures"
  // warning still fires alone — this adds the one fleet-level warning that names the
  // cause (and the config knob, when the cause has one) instead of leaving the operator
  // to diff 14 streak lines. Observational only: it gates nothing, so unlike the failure
  // hold above there is no re-open event — the members' own recoveries tell that story.
  states.errorStorm = pollErrorStorm(root, states.errorStorm, runners);

  // Fleet-wide wide-shallow storm alarm (src/failure/failure-spread.ts): when many roles each
  // fail a few times on one provider failure kind, the streak bar needs one role deep,
  // the error storm needs several roles deep, and the hold needs the failures close
  // together — this counts raw failures of one kind across roles in a rolling window,
  // so a degraded backend that fails the fleet widely and shallowly still names itself.
  // Observational only, like the error storm: it gates nothing.
  states.failureSpread = pollFailureSpread(root, states.failureSpread, holdInputs(liveConfig, runners), now);

  return { gate, roleConfig, userPaused, pausedRoles: pausedRolesNow, capPaused, roleQuietHeld, quietNow };
}
