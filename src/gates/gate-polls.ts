import type { TumwaterConfig, FallbackModelConfig, ModelTier } from "../config/config-schema.js";
import type { BudgetGate } from "../budget/budget.js";
import {
  gateRoleConfig,
  newBudgetGateState,
  pollBudgetGate,
  runOnPair,
  subscriptionBackendOf,
  type BudgetGateState,
} from "./budget-gates.js";
import { backendsInUse } from "./startup-gate.js";
import { fallbackDemotion, type FallbackDemotion } from "../budget/fallback-breaker.js";
import { newPauseGateState, pollPauseGates, type PauseGateState } from "./pause-gates.js";
import { newStreakGateState, pollStreakGate, type StreakGateState } from "./streak-gate.js";
import {
  newRoleCapGateState,
  pollRoleCapGate,
  type RoleCapGateState,
} from "./role-cap-gates.js";
import {
  newMaintenanceQuotaGateState,
  pollMaintenanceQuotaGate,
  type MaintenanceQuotaGateState,
  type MaintenanceQuotaVerdict,
} from "./maintenance-quota.js";
import {
  newBootstrapGateState,
  pollBootstrapGate,
  type BootstrapGateState,
} from "./bootstrap-gates.js";
import {
  newQuietHoursGateState,
  pollQuietHoursGate,
  roleQuietHold,
  type QuietHoursGateState,
} from "../scheduling/quiet-hours.js";
import {
  BYTES_PER_GB,
  newDiskGateState,
  pollDiskGate,
  sampleFreeBytes,
  type DiskGateState,
} from "./disk-gate.js";
import { pollErrorStorm, pollFailureSpread, pollTeamHold, pollClaudeWindowWarning, pollClaudeWindowReserve, windowObservation, type HoldInputs } from "../team/team-polls.js";
import { readAccount } from "../agent/subscription-account.js";
import type { ReclaimController } from "../team/reclaim.js";
import { standingHolds, type TeamHold } from "../team/team-hold.js";
import { ERROR_STORM_QUIET, type ErrorStorm } from "../team/error-storm.js";
import { FAILURE_SPREAD_QUIET, type FailureSpread } from "../team/failure-spread.js";
import type { RoleRunner } from "../runner/runner.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";
import { baseRoleOf, instancePauseKey, runnerEnabled } from "../roles/runner-ids.js";
import { queuedMergeRoles } from "../merge/merge-queue.js";
import { MODEL_TIERS } from "../config/config-schema.js";
import { logEventBestEffort, TUMWATER_SOURCE } from "../events/events.js";
import { publishInfoFields, type OrchestratorInfo } from "../team/orchestrator-info.js";
import { configForRole, roleSeamTier, windowReserveFor, withModelOverrides } from "../config/config-views.js";
import type { TierFallbackMap } from "../config/config-fallbacks.js";

/** The orchestrator poll loop's team-wide gates and alarms, as one family: the daily cost budget
 * gate, the operator and per-role pause gates, quiet hours, the disk floor's hold, the team-wide
 * failure hold, and the two observational storm alarms. Each gate's reads, edge-triggered events,
 * and cross-poll bookkeeping live in its own module (src/gates/budget-gates.ts,
 * src/gates/pause-gates.ts, src/gates/streak-gate.ts, src/gates/role-cap-gates.ts,
 * src/scheduling/quiet-hours.ts, src/gates/disk-gate.ts, and the team-health trio in
 * src/team/team-polls.ts); this owns the wiring half — one poll advances every gate's state in
 * place. Split out of orchestrator.ts so the poll loop reads as phases (reload → requests → gates →
 * redeploy → merges → schedule → start) and the gate family's wiring sits in one place, the same
 * split team/team-polls.ts made for the team-health trio. Dependency direction: orchestrator →
 * gate-polls → the gate modules. */

/** The gate family's cross-poll memory, constructed once per orchestrator run and mutated in place
 * by each poll. In memory only — a restart re-trusts the fallback, re-opens the hold, and can
 * re-log at most one event per gate. Two members are also mutated from outside this module: the
 * budget gate's breaker collects the start pass's run evidence and its probe
 * (src/budget/fallback-breaker.ts), and `teamHold` is the holds-per-provider map — the holds'
 * LATEST verdicts, read at permit time by the start pass's closures — read it from
 * `states.teamHold` at call time, never from a per-poll snapshot (the poll loop's docs below). Key
 * presence is not "held": providers whose hold re-opened stay in the map for their relapse memory,
 * so every consumer goes through team/team-hold.ts's heldProviders(). */
export interface TeamGateStates {
  budget: BudgetGateState;
  pause: PauseGateState;
  streak: StreakGateState;
  cap: RoleCapGateState;
  /** The maintenance allowance's rolling-window memo and hold edge (plans/work-ratio.md, part
   * 1b/4). */
  quota: MaintenanceQuotaGateState;
  /** The new-project bootstrap hold (plans/work-ratio.md, part 2/2). */
  bootstrap: BootstrapGateState;
  quiet: QuietHoursGateState;
  /** The disk floor's cross-poll hold (plans/disk-floor.md, part 1/4). */
  disk: DiskGateState;
  teamHold: ReadonlyMap<string | undefined, TeamHold>;
  /** The subscription usage window's once-per-window warning memory (team/team-polls.ts
   * pollClaudeWindowWarning): the `type:resetsAt` keys whose `subscription_window_warning` was
   * logged for a still-open window. The hold itself rides `teamHold`. */
  claudeWindowWarned: ReadonlySet<string>;
  /** The `type:resetsAt` keys whose `subscription_window_reserved` was logged
   * (pollClaudeWindowReserve). */
  claudeWindowReserved: ReadonlySet<string>;
  errorStorm: ErrorStorm;
  failureSpread: FailureSpread;
}

/** A fresh gate family: nothing seen yet, so the first poll of an unpaused, unheld team
 * logs nothing. The budget gate seeds its breaker and derived fallback view from the
 * startup config; a live reload replaces the config on the next poll. */
export function newTeamGateStates(config: TumwaterConfig): TeamGateStates {
  return {
    budget: newBudgetGateState(config),
    pause: newPauseGateState(),
    streak: newStreakGateState(),
    cap: newRoleCapGateState(),
    quota: newMaintenanceQuotaGateState(),
    bootstrap: newBootstrapGateState(),
    quiet: newQuietHoursGateState(),
    disk: newDiskGateState(),
    teamHold: new Map(),
    claudeWindowWarned: new Set(),
    claudeWindowReserved: new Set(),
    errorStorm: ERROR_STORM_QUIET,
    failureSpread: FAILURE_SPREAD_QUIET,
  };
}

/** One poll's verdicts, for the poll loop's scheduling and start passes of THIS poll: the
 * budget gate's value and the config roles run under, the two pause views, and
 * whether quiet hours hold now. Deliberately NOT the failure hold or the storm alarms:
 * the hold's verdict must be read fresh from `states.teamHold` wherever it gates — a
 * permit-time closure runs after later polls have advanced the hold, so a destructured
 * per-poll copy would freeze the poll-time verdict and let a parked run start into a
 * storm (or stay parked through a lift) that the latest poll already settled. */
interface TeamGatePoll {
  gate: BudgetGate;
  roleConfig: TumwaterConfig;
  /** The director's config this poll (pollBudgetGate's `directorConfig`). */
  directorConfig: TumwaterConfig;
  userPaused: boolean;
  pausedRoles: ReadonlySet<string>;
  capPaused: ReadonlySet<string>;
  /** The maintenance allowance's verdict this poll (plans/work-ratio.md, part 1b/4): `allowance` is
   * what the rolling window permits, `used` is the merged maintenance count plus the maintenance
   * roles already in flight, and `held` is `used >= allowance`. The scheduling pass admits at most
   * the remaining `allowance - used` due maintenance roles, so the headroom is never overshot
   * within a poll. */
  maintenanceQuota: MaintenanceQuotaVerdict;
  /** The roles the new-project bootstrap holds (plans/work-ratio.md, part 2/2): every role but
   * plan, feature and director — and bugfix while BUGS.md `## Open` is empty. A held role
   * starts no new run unless it has a fresh operator wake or a queued prompt (the scheduling
   * pass admits that demand), exactly like the need-based deferral. Empty when no bootstrap is
   * configured or the latch has ended it. */
  bootstrapHeld: ReadonlySet<string>;
  /** The roles (the director excluded) whose budget tier resolved to pause while the cap is
   * reached (part 5c/8) or while a usage-window move holds the tier on a demoted fallback: a
   * role whose own `model` tier (roleSeamTier) has no usable free pair
   * — none configured, one priced above zero, or its breaker demoted — starts no new runs,
   * beside `capPaused` (the scheduling pass folds the sets the same way). Roles on tiers that
   * DID resolve keep running under the same poll, so a demoted strong pair no longer pauses
   * the whole team. The probe of a demoted pair pierces this set for exactly the pair's own
   * tier's roles (orchestrator-scheduling.ts's probeRoles). */
  budgetPausedRoles: ReadonlySet<string>;
  /** The demotion-aware per-tier resolution behind `budgetPausedRoles`, handed to the poll
   * loop so the probe's eligible roles (the tiers that resolve to the probed pair) are
   * computed from the SAME resolution the pause set came from. */
  servingResolved: TierFallbackMap;
  /** The price-based resolution (budget-gates.ts's priceResolved): the pairs the tiers would
   * run absent a demotion — the probe's eligibility reads THIS, since the probed pair is by
   * definition not usable in the serving resolution. */
  priceResolved: TierFallbackMap;
  /** Whether the cap is reached this poll: the budget hold only holds while it is. */
  budgetActive: boolean;
  /** The roles (the director excluded) a usage-window move put on a fallback pair — their tier
   * moved because the role's OWN subscription backend's window stands, so a role on the tier whose
   * own backend is healthy (another backend moved it) is not in it: their run outcomes fold into
   * the fallback breaker even below the cap. Empty while no window moved. */
  windowMovedRoles: ReadonlySet<string>;
  /** The roles (the director excluded) whose own `quietHoursPerRole` window holds right now:
   * a stateless verdict recomputed every poll beside `capPaused` — no event, no bookkeeping
   * (the pause marker is anonymous and must never masquerade as an operator's schedule). */
  roleQuietHeld: ReadonlySet<string>;
  quietNow: boolean;
  /** The disk floor holds new work right now (plans/disk-floor.md, part 1/4). */
  diskHeld: boolean;
}

/** Inputs one poll needs: the live config the reload produced, the runner list (its states
 * feed the spend read and its config field is assigned here), and the orchestrator's info
 * file for the derived-state publish. */
interface TeamGatePollCtx {
  root: string;
  runners: readonly RoleRunner[];
  liveConfig: TumwaterConfig;
  modelsPath: string;
  now: number;
  info: OrchestratorInfo;
  /** The free-bytes sampler for the disk floor: production reads statfs through
   * sampleFreeBytes; tests inject a fixed sample. */
  sampleFree?: (root: string) => number | null;
  /** Pressure reclaim (plans/disk-floor.md, part 2/4). Optional so the gate's unit tests can
   * poll a disk hold without a reclaim pass; the orchestrator supplies the controller. */
  reclaim?: ReclaimController;
}

/** Poll every team-wide gate and alarm, advancing `states` in place. */
export function pollTeamGates(
  states: TeamGateStates,
  ctx: TeamGatePollCtx,
): TeamGatePoll {
  const { root, runners, liveConfig, modelsPath, now, info } = ctx;

  // The per-backend subscription account lookup (part 2e/9): each backend's account is read on
  // demand — the window hold/reserve/warning loop, the window-move and the handback reads each
  // call accounts fresh — so a second subscription backend is judged from its own account, never
  // from claude's.
  const accounts = (backend: string) => readAccount(root, backend, now);

  // Daily cost budget gate (src/gates/budget-gates.ts owns the reads, the edge-triggered
  // budget_* events, the breaker re-key, and the fallback config view): the orchestrator
  // owns only the wiring — the demotion publish below and the per-runner assignment at
  // the bottom of this block.
  const {
    gate,
    roleConfig,
    spentUsd,
    capUsd,
    onFallback,
    resumed: gateResumed,
    pairs: fallbackPairs,
    priceResolved,
    servingResolved,
    budgetActive,
    windowTiers,
    windowResumedBackends,
    directorConfig,
    chain,
  } = pollBudgetGate(states.budget, {
    root,
    states: runners.map((r) => r.state),
    liveConfig,
    modelsPath,
  });
  // Publish what observers cannot derive themselves: every pair's demotion — a per-tier
  // fallback can demote a pair the legacy single `fallback` never names, and a dashboard that
  // only sees the engaged pair's verdict would show a tier's roles running while the
  // scheduler holds them (part 5c/8) — plus the engaged pair's own (the legacy
  // `fallbackDemoted` field, what `tumwater doctor` and the failure digest read) and the
  // gate's own spend/cap pair — summed over the runners' live states, which every
  // persisted-file reader lags by the in-flight runs' charges. Both rewritten only when they
  // change, like the build status; the exit removes the whole file, so no stale pair survives
  // a stop.
  const demotions: Record<string, FallbackDemotion> = {};
  for (const [name, b] of Object.entries(states.budget.breakers)) {
    const d = fallbackDemotion(b);
    if (d) demotions[name] = d;
  }
  const engagedDemotion =
    states.budget.engaged !== null ? demotions[states.budget.engaged] : undefined;
  const budget = { spentUsd, capUsd };
  publishInfoFields(root, info, [
    ["fallbackDemotions", demotions],
    ["fallbackDemoted", engagedDemotion],
    ["budget", budget],
    ["chain", Object.keys(chain).length > 0 ? chain : undefined],
  ]);
  // One fallback_switched per poll in which a tier's pair or step changed (a return to the
  // primary reads `to: null`, reason "available").
  const switched: Record<string, { from: string | null; to: string | null; reason: string }> = {};
  const prevChain = states.budget.prevChain;
  for (const tier of MODEL_TIERS) {
    const was = prevChain[tier];
    const cur = chain[tier];
    if (was?.pair === cur?.pair && was?.step === cur?.step) continue;
    switched[tier] = { from: was?.pair ?? null, to: cur?.pair ?? null, reason: cur?.reason ?? "available" };
  }
  if (Object.keys(switched).length > 0)
    logEventBestEffort(root, { source: TUMWATER_SOURCE, type: "fallback_switched", tiers: switched });
  states.budget.prevChain = chain;
  // The director keeps the live config — an explicit human prompt outranks the
  // autonomous-spend cap (gateRoleConfig). Assigned every poll (not only on transitions)
  // so a runner created mid-gate, or one left behind by a broken-file poll that skipped
  // the reload, can never run on the wrong model.
  for (const r of runners) {
    r.config = gateRoleConfig(r.role, liveConfig, roleConfig, directorConfig);
    // An image reroute must never spend past the daily cap: while the gate has the team on
    // its free fallback pairs, a reroute looks only among those pairs (plans/image-input.md
    // "Reroute target" "Regime"). Set beside the config assignment so the scheduler's regime
    // and the roles' never disagree.
    r.budgetFallbackActive = onFallback;
  }

  // The budget reopened: a run that started on a fallback pair keeps it until it ends, so hand
  // those runs back — abort them resumably (session and worktree edits kept) and let their next
  // run continue the same session on the primary, whose config the assignment above already
  // installed (PLANS.md 2026-09-30). Per-tier fallbacks put different roles on different pairs
  // (part 5c/8), so the match runs over EVERY pair the price-based resolution hands out, not only
  // one. A run started on the primary keeps running, the director is exempt, and the merges (the
  // slot's own runs) are untouched. One event per pair names who was handed back, so the resulting
  // aborted runs read as the budget reopening, not as unexplained failures. The subscription
  // window reset (below the cap): the same hand-back for the pairs the window move used. A window
  // that resets while the cap still holds hands back nothing.
  const handBack = gateResumed || (windowResumedBackends.length > 0 && !budgetActive);
  // The window handback names the backend whose window resumed (the entry's goal) — not the
  // handed-back pair's own backend: for claude-only the fallback pair carries no backend (it would
  // read undefined), and with two subscription backends it would name the opposite one. A pair
  // belongs to those resumed backends whose tiers' price-resolved pair it is.
  const resumedBackendSet = new Set<string>(windowResumedBackends);
  const resumedBackendForPair = (leftPair: FallbackModelConfig): string | undefined => {
    for (const tier of MODEL_TIERS) {
      const p = priceResolved[tier]?.pair;
      if (p && p.provider === leftPair.provider && p.model === leftPair.model) {
        const b = subscriptionBackendOf(withModelOverrides(liveConfig, tier, {}), accounts);
        if (b !== null && resumedBackendSet.has(b)) return b;
      }
    }
    return undefined;
  };
  if (handBack && fallbackPairs.length > 0) {
    // A cap reopen while the window is still used up leaves the window's tiers on their
    // fallback pairs: handing those runs back would abort them to restart on the same pair.
    const stillMoved = (Object.keys(windowTiers) as (keyof typeof windowTiers)[]).flatMap((t) => {
      const p = priceResolved[t].pair;
      return p ? [p] : [];
    });
    for (const leftPair of fallbackPairs) {
      if (stillMoved.some((p) => p.provider === leftPair.provider && p.model === leftPair.model)) continue;
      const matching = runners.filter(
        (r) => r.role !== DIRECTOR_ROLE && runOnPair(r.runModelPair(), leftPair),
      );
      if (matching.length > 0) {
        logEventBestEffort(root, {
          source: TUMWATER_SOURCE,
          type: "budget_handback",
          roles: matching.map((r) => r.role),
          provider: leftPair.provider,
          model: leftPair.model,
          ...(gateResumed
            ? {}
            : { reason: "window", backend: resumedBackendForPair(leftPair) }),
        });
        for (const r of matching) r.handBackRun();
      }
    }
  }

  // The pause gates (src/gates/pause-gates.ts owns the reads, the edge-triggered pause/resume
  // events, and the cross-poll bookkeeping): the operator pause's marker and the per-role pause's
  // set, both read fresh per cycle so a marker change takes effect on the next poll.
  const { userPaused, pausedRoles } = pollPauseGates(root, states.pause);

  // The error-streak circuit breaker (src/gates/streak-gate.ts): a role past ERROR_STREAK_BREAKER
  // consecutive failed runs is paused through the same per-role marker the operator's
  // `pause --role` writes — act-on-it where the warn bar and the storm alarms only talk. The
  // director is not exempt; a failing director cannot process prompts anyway. Roles it just
  // paused fold into this poll's paused-roles view, so the scheduler blocks them on this very
  // poll instead of the next one.
  const streakPaused = pollStreakGate(root, states.streak, runners, pausedRoles, (role) =>
    instancePauseKey(liveConfig, role),
  );
  // pollPauseGates advanced its edge-triggered bookkeeping BEFORE the breaker wrote its
  // marker, so without this fold the NEXT poll would log a generic role_paused for a pause
  // the breaker already announced as role_streak_paused — one pause, two events, the second
  // mislabeled as an operator action (BUGS.md 2026-09-30). The trips are not the pause
  // gates' to announce; a later operator resume still logs role_resumed as usual.
  for (const role of streakPaused) states.pause.prevPausedRoles.add(role);
  const pausedRolesNow =
    streakPaused.length > 0 ? new Set([...pausedRoles, ...streakPaused]) : pausedRoles;

  // The per-tier budget pause (part 5c/8): a role whose model tier resolved to no usable free
  // pair while the cap is reached starts no new runs — the stateless verdict recomputed every
  // poll from the SAME resolution the gate's value came from, beside `capPaused` (the
  // scheduling pass folds the sets; the director is exempt, as under every autonomous gate).
  // The demoted pair's probe pierces the set for its own tier's roles only — probeRoles in the
  // orchestrator's scheduling pass.
  const budgetPausedRoles = new Set<string>();
  const windowMovedRoles = new Set<string>();
  const movedTiers = Object.keys(windowTiers);
  // The backend whose used-up window moved a given tier: the tier's own seam's backend — the same
  // read budget-gates made to put it in `windowTiers`. A role on a moved tier whose own backend is
  // DIFFERENT (a healthy backend riding the same tier) keeps its pair: only the role whose own
  // backend owns the out window is moved.
  const tierMovedBackend = (tier: ModelTier) =>
    subscriptionBackendOf(withModelOverrides(liveConfig, tier, {}), accounts);
  for (const r of runners) {
    if (r.role === DIRECTOR_ROLE) continue;
    const tier = roleSeamTier(liveConfig, r.role);
    // A role pinned to the moved tier's own subscription backend keeps it through the window move
    // (it is not on a pair); a role on the same tier pinning a healthy backend does not.
    if (
      movedTiers.includes(tier) &&
      subscriptionBackendOf(configForRole(liveConfig, r.role), accounts) === tierMovedBackend(tier)
    )
      windowMovedRoles.add(r.role);
    // Below the cap only a window-moved role can sit on a demoted fallback.
    if (!budgetActive && !windowMovedRoles.has(r.role)) continue;
    if (servingResolved[tier].pair === null) budgetPausedRoles.add(r.role);
  }

  // The per-role daily cost cap (src/gates/role-cap-gates.ts): a role whose local-day spend has
  // reached its own maxDailyCostUsdPerRole entry starts no new runs — the stateless verdict
  // recomputed every poll, no pause marker written (the marker is anonymous; a cap pause must
  // never masquerade as an operator's), so this returns its own set beside pausedRoles and the
  // pause gates' edge bookkeeping never sees it. A live config edit applies on the next poll;
  // local midnight lifts the verdict by itself.
  const capPaused = pollRoleCapGate(root, states.cap, runners, liveConfig.maxDailyCostUsdPerRole, now);

  // The maintenance allowance (plans/work-ratio.md, part 1b/4): code-maintenance merges in a
  // rolling 24 h window are capped at `maintenancePerWorkMerge × work + MAINTENANCE_DAILY_FLOOR`.
  // The gate counts the window, adds the maintenance roles already in flight (running or
  // holding a queued merge, so six concurrent permits cannot overshoot), and logs the one
  // hold/resume event per transition. Enabled only: a disabled role has no runs to count. The
  // scheduling pass spends the returned headroom one due maintenance role at a time, beside
  // capPaused, with the fresh-wake/queued-prompt override the need-based deferral honors.
  const queuedRoles = queuedMergeRoles(root);
  const maintenanceQuota = pollMaintenanceQuotaGate(
    root,
    states.quota,
    runners.map((r) => ({
      role: r.role,
      enabled: runnerEnabled(r.config, r.role),
      running: r.state.running === true,
      hasQueuedMerge: queuedRoles.has(r.role),
    })),
    liveConfig.maintenancePerWorkMerge,
    now,
  );

  // New-project bootstrap (src/gates/bootstrap-gates.ts, plans/work-ratio.md part 2/2): a fresh
  // project's maintenance roles start no new runs until `bootstrap.untilPlansDone` plans are
  // Done. The gate owns the latch write and the one `bootstrap_complete` event; the scheduling
  // pass folds the held set in beside capPaused (with the fresh-wake/queued-prompt override the
  // need-based deferral honors).
  const bootstrapHeld = pollBootstrapGate(root, states.bootstrap, runners, liveConfig, now);

  // Per-role quiet hours (src/scheduling/quiet-hours.ts): a role whose own quietHoursPerRole window
  // covers `now` starts no new runs — the team window's semantics scoped to one role, the
  // director exempt like every autonomous gate. Stateless, recomputed per poll exactly like
  // capPaused: no crossing events, no state — a live config edit applies on the next poll
  // by construction. A role held by BOTH windows is held once: the scheduling pass folds
  // both verdicts into one hold condition, nothing counts a role twice.
  const roleQuietHeld = new Set<string>();
  for (const r of runners) {
    if (r.role === DIRECTOR_ROLE) continue;
    if (roleQuietHold(liveConfig.quietHoursPerRole, baseRoleOf(r.role), new Date(now)))
      roleQuietHeld.add(r.role);
  }

  // Quiet hours (src/scheduling/quiet-hours.ts): the config-driven daily local-time window during
  // which roles start no new runs — the operator pause's semantics on a schedule.
  // The config value is read fresh per cycle, so a live edit applies on the next poll;
  // exactly one quiet_hours_started/ended event per crossing. In-flight runs finish;
  // the gate folds into the same hold site as the pause gates.
  const quietNow = pollQuietHoursGate(
    root,
    liveConfig.quietHours,
    states.quiet,
    new Date(now),
  );

  const freeBytes = (ctx.sampleFree ?? sampleFreeBytes)(root);
  // Pressure reclaim (plans/disk-floor.md, part 2/4): below diskReclaimGB, start one background
  // pass; the hold below defers entry while it runs, so build outputs are deleted before new
  // work is held. Never awaited — a clean that deletes 100k files can take a minute. The
  // controller starts one pass per drop, so a settled pass lets the hold engage rather than
  // starting another pass forever.
  const waitForReclaim = ctx.reclaim?.poll(freeBytes, liveConfig.diskReclaimGB) ?? false;
  // Idle reclaim (plans/disk-floor.md, part 3/4): at most hourly, delete the build outputs of
  // worktrees unused for `worktreeIdleReclaimHours` whatever the free space. On the same
  // single-flight runner as pressure reclaim, so the two never overlap.
  ctx.reclaim?.pollIdle(liveConfig.worktreeIdleReclaimHours);
  const diskHeld = pollDiskGate(
    root,
    freeBytes,
    liveConfig.diskHoldGB,
    states.disk,
    waitForReclaim,
  );
  // Publish the disk floor's measured state (plans/disk-floor.md, part 4/4): observers cannot
  // call statfs in step with this poll, so the orchestrator writes what it measured. Rewritten
  // only when it changes, like the budget block; freeGB rounds to one decimal. A null sample
  // publishes nothing, so an unmeasurable volume renders exactly as before.
  const disk: OrchestratorInfo["disk"] =
    freeBytes === null
      ? undefined
      : {
          freeGB: Math.round((freeBytes / BYTES_PER_GB) * 10) / 10,
          holdGB: liveConfig.diskHoldGB,
          reclaimGB: liveConfig.diskReclaimGB,
          held: diskHeld,
          ...(ctx.reclaim?.lastReclaim ? { lastReclaim: ctx.reclaim.lastReclaim } : {}),
        };
  publishInfoFields(root, info, [["disk", disk]]);

  // Each runner as the two provider-failure polls read it (HoldInputs): the role, its two
  // episodic fields, and the provider its NEXT run will run on (runProvider — the tier
  // fallback pair while a model-fallback episode is active, else the role's resolved config;
  // undefined when pi's default is in charge). Built ONCE per poll so the hold and the spread
  // read the same list, like holdObservations on the reducer side. Keying on the effective
  // provider is what lets a storm on the fallback pair form its own hold while the abandoned
  // primary stays clear (PLANS.md "Model failure fallback, part 1/2").
  //
  // Each stamp (lastRateLimit/lastBackendFailure) carries the hold key of the backend that
  // ACTUALLY failed — a reviewer run folded through the author's role stamps `claude`, not
  // the pi author's provider — and the polls' observation mapper files each stamp under that
  // key, falling back to runProvider here for a stamp without one (PLANS.md "Mixed claude +
  // pi fleets, part 2/4"). The spreads below carry the stamps wholesale, provider included.
  const holdInputs = (rs: readonly RoleRunner[]): HoldInputs[] =>
    rs.map((r) => ({
      role: r.role,
      provider: r.runProvider(now),
      ...(r.lastRateLimit ? { lastRateLimit: r.lastRateLimit } : {}),
      ...(r.lastBackendFailure ? { lastBackendFailure: r.lastBackendFailure } : {}),
    }));

  // Team-wide failure hold, per provider (src/team/team-hold.ts, PLANS.md 2026-10-05): once two
  // roles' runs have ended on the SAME provider AND failure kind within a short window — 429s, or a
  // connection, timeout, 5xx, or model-load backend failure — roles on THAT provider start no
  // new runs, and the merge queue starts no new verify, whose reviewer run has no retry and would
  // spend a review strike on the storm — until the hold re-opens at its own deadline (Retry-After
  // honored on the rate-limit kind, doubling on a relapse, capped). Roles on a healthy provider
  // keep running; a hold on the reviewer's provider (with the review gate on) still blocks
  // everything, since nothing could merge — the orchestrator's scheduling and start passes derive
  // that verdict from this map. The director's runs are exempt, as under the budget gate and the
  // operator pause: an explicit human prompt outranks an autonomous gate, one director run is not
  // the concurrency that sustains a storm, its 429 runs keep the per-run transient retry
  // (backend-failure kinds ride this hold alone), and a prompt its run fails to fulfill goes back
  // to the inbox. In-flight runs finish; NEW runs are gated at scheduling like both siblings, and
  // a role run already parked in the semaphore meets the same hold at its permit (the start gate)
  // and hands its reservation back instead of starting into the storm. The verdicts are written
  // back to states.teamHold — one hold per provider, lifted holds kept keyed for their relapse
  // memory but never reading as held — and the permit-time closures read the LATEST poll's map
  // there, so a waiter granted its permit after a later poll sees that poll's world.
  const windowAccountReads = backendsInUse(liveConfig).map(
    (backend) => [backend, accounts(backend)] as const,
  );
  // The subscription-window hold, reserve and warning, read per backend in use (part 2e/9): a
  // second subscription backend gets its own hold, reserve and warning memory keyed by its own
  // `backend`, so claude's roles, hold and events are untouched by another backend's window.
  // One account read per backend feeds both the hold observations and the reserve/warning polls;
  // a backend whose account implies no hold contributes no observation.
  const windowObservations = windowAccountReads
    .map(([backend, account]) =>
      windowObservation(backend, account, now, windowReserveFor(liveConfig, backend)),
    )
    .filter((o): o is NonNullable<typeof o> => o !== null);
  states.teamHold = pollTeamHold(
    root,
    states.teamHold,
    holdInputs(runners),
    now,
    windowObservations,
    windowTiers,
  );
  // The standings hold, published for observers (PLANS.md 2026-10-17 "the dashboards and
  // `tumwater status` name a standing provider failure hold"): `standingHolds` turns the holds
  // map into the per-provider list the status snapshot and the alert banner name, the same
  // omit-when-empty idiom as `chain`/`disk`, so an open team leaves the file untouched and a
  // hold change writes once.
  const providerHolds = standingHolds(states.teamHold);
  publishInfoFields(root, info, [
    ["providerHolds", providerHolds.length > 0 ? providerHolds : undefined],
  ]);
  // The reserve and warning polls, one per subscription backend in use: each logs its own
  // events keyed by its own backend (the `backend:type:resetsAt` keys), so claude's own reserve
  // and warning memory is unaffected by another backend's crossings (part 2e/9).
  for (const [backend, account] of windowAccountReads) {
    states.claudeWindowReserved = pollClaudeWindowReserve(
      root,
      states.claudeWindowReserved,
      account,
      now,
      backend,
      windowReserveFor(liveConfig, backend),
    );
    // The subscription usage window's warning is observational (the hold above is the gate): the
    // first allowed_warning logs once per window, and the memory lives beside the holds map.
    states.claudeWindowWarned = pollClaudeWindowWarning(
      root,
      states.claudeWindowWarned,
      account,
      now,
      backend,
    );
  }

  // Team-wide error-storm warning (src/team/error-storm.ts): when several roles' run streaks
  // fail consecutively on one shared cause, each role's own "consecutive run failures"
  // warning still fires alone — this adds the one team-level warning that names the
  // cause (and the config knob, when the cause has one) instead of leaving the operator
  // to diff 14 streak lines. Observational only: it gates nothing, so unlike the failure
  // hold above there is no re-open event — the members' own recoveries tell that story.
  states.errorStorm = pollErrorStorm(root, states.errorStorm, runners);

  // Team-wide wide-shallow storm alarm (src/team/failure-spread.ts): when many roles each
  // fail a few times on one provider failure kind, the streak bar needs one role deep,
  // the error storm needs several roles deep, and the hold needs the failures close
  // together — this counts raw failures of one kind across roles in a rolling window,
  // so a degraded backend that fails the team widely and shallowly still names itself.
  // Observational only, like the error storm: it gates nothing.
  states.failureSpread = pollFailureSpread(root, states.failureSpread, holdInputs(runners), now);

  return {
    gate,
    roleConfig,
    directorConfig,
    userPaused,
    pausedRoles: pausedRolesNow,
    capPaused,
    maintenanceQuota,
    bootstrapHeld,
    budgetPausedRoles,
    servingResolved,
    priceResolved,
    budgetActive,
    windowMovedRoles,
    roleQuietHeld,
    quietNow,
    diskHeld,
  };
}
