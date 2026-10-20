// vocabulary: plain
/** The orchestrator's per-poll steps (src/orchestrator/orchestrator.ts keeps the setup, the loop
 * skeleton and the shutdown drain): each step names what it reads from the PollContext and what
 * it reads or writes in the PollState, so one poll's passes read apart from one another. Called
 * in this order every poll — requests and watch, gates, redeploy, merge drain, scheduling,
 * reserve and exit — and moved here without reordering any of them. */
import type { TumwaterConfig } from "../config/config-schema.js";
import { publishInfoFields, type OrchestratorInfo } from "../team/orchestrator-info.js";
import { runnerEnabled } from "../roles/runner-ids.js";
import type { newLiveConfigReload } from "../config/config-live.js";
import type { FallbackBreakerPolicy } from "../budget/fallback-breaker.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";
import { reviewHoldKey, pollDeferralInputs, pollRunnerReasons } from "./orchestrator-scheduling.js";
import { seamConcurrencyKey } from "../config/config-views.js";
import { launchDueTicks } from "./orchestrator-launch.js";
import type { RoleRunner } from "../runner/runner.js";
import { branchHead, currentBranch } from "../git/git.js";
import { queuedMergeFiles, queuedMergeRoles } from "../merge/merge-queue.js";
import { requeueMainRedPin } from "../merge/merge-slot.js";
import { drainMergeQueue, settleAbortedApproved } from "../merge/merge-drain.js";
import { abortableMerges, mergeTasks, type MergePipeline } from "../merge/merge-pipeline.js";
import { TUMWATER_SOURCE, type HarnessEventInput } from "../events/events.js";
import type { OnceRound } from "../scheduling/once-round.js";
import type { newNotifier } from "../events/notify.js";
import {
  consumeAbortRequests,
  consumeReclaimRequest,
  consumeRestartRequest,
  consumeResetRequest,
  consumeWakeRequest,
} from "../operator/operator-requests.js";
import type { readPiDefaultModel } from "../pi/pi-settings.js";
import { checkPermitSnapshot } from "../concurrency/check-permit.js";
import { slotPoolSnapshot } from "../git/worktree-pool.js";
import type { Semaphore } from "../concurrency/semaphore.js";
import type { createMainWatch } from "../baseline/main-watch.js";
import { redeployTarget } from "../baseline/main-baseline.js";
import type { Redeployer } from "../redeploy/redeployer.js";
import type { LaunchServicesWatch } from "../process/launch-services.js";
import type { RetentionPruner } from "./retention.js";
import type { WorkMergedCache } from "../scheduling/work-merged-cache.js";
import { p75TickDurationMs } from "../run/run-timing.js";
import { pollTeamGates, type TeamGateStates } from "../gates/gate-polls.js";
import type { ReclaimController } from "../team/reclaim.js";
import { heldProviders, windowHeldProviders } from "../team/team-hold.js";
import { workReserveCount } from "../scheduling/claims.js";

/** The setup's constants and collaborators, fixed for the whole run. */
export interface PollContext {
  root: string;
  mainBranch: string;
  /** Once mode (`run --once`): no main watch, and the poll may fire the internal stop. */
  onceMode: boolean;
  /** The full stop signal (caller's plus internalStop); roleSignal adds the role-only stop. */
  signal: AbortSignal;
  roleSignal: AbortSignal;
  internalStop: AbortController;
  internalRoleStop: AbortController;
  runners: RoleRunner[];
  semaphore: Semaphore;
  merges: MergePipeline;
  gateStates: TeamGateStates;
  once: OnceRound;
  info: OrchestratorInfo;
  modelsPath: string;
  piDefault: ReturnType<typeof readPiDefaultModel>;
  redeploy: Redeployer | null;
  launchServicesWatch: LaunchServicesWatch | null;
  reclaim: ReclaimController;
  liveReload: ReturnType<typeof newLiveConfigReload>;
  notifier: ReturnType<typeof newNotifier>;
  retentionPruner: RetentionPruner;
  mainWatch: ReturnType<typeof createMainWatch>;
  workMergedSince: WorkMergedCache;
  deferredDue: Map<string, boolean>;
  breakerPolicy: FallbackBreakerPolicy;
  breakerNow: () => number;
  roleInFlight: Set<Promise<void>>;
  rolePermitHolders: Set<RoleRunner>;
  directorInFlight: Set<Promise<void>>;
  roleTickDurationsMs: number[];
  emit: (event: HarnessEventInput) => void;
  warn: (message: string) => void;
}

/** The flags that outlive one poll. */
export interface PollState {
  /** dist/ already holds the new build: set by the redeploy step, read by the shutdown drain
   * and the exit value. */
  restart: boolean;
  /** Whether the last poll found a self-redeploy pending (`hold`). Read at scheduling (no new
   * tick is reserved) and — through tickStartHeld — whenever a parked waiter is granted its
   * permit, which happens between polls. */
  holdForRestart: boolean;
  /** Whether the last poll's disk gate held new work (plans/disk-floor.md, part 1/4); read at
   * permit time by tickStartHeld, like holdForRestart. */
  diskHeld: boolean;
  /** The primary checkout moved off the target branch and the one warning was logged; re-armed
   * when the checkout returns. */
  warnedBranchDivergence: boolean;
  /** The maintenance permits withheld for work roles that have work to take (part 7/7), so the
   * event logs only the crossings into and out of a reserved state. */
  lastReserve: number;
}

export function newPollState(): PollState {
  return { restart: false, holdForRestart: false, diskHeld: false, warnedBranchDivergence: false, lastReserve: 0 };
}

/** The start gate every reserved tick passes the moment its permit is granted
 * (runTimedRoleTick's `held`): closed while a restart is pending, and after one is decided so
 * no waiter the shutdown hands a permit to starts on the build being replaced. One predicate,
 * so another team-wide hold on new ticks can close the same gate point. */
function tickStartHeld(state: PollState): boolean {
  return state.holdForRestart || state.restart || state.diskHeld;
}

/** What the request-and-watch step hands the rest of the poll. */
interface PollInputs {
  liveConfig: TumwaterConfig;
  mainHead: string;
  now: number;
}

/** Live-reload, notify/retention/launchservices, CLI request markers, abort settling and the
 * branch-divergence watch. Writes state.warnedBranchDivergence. */
export async function pollRequestsAndWatch(ctx: PollContext, state: PollState): Promise<PollInputs> {
  const { root, mainBranch, runners } = ctx;
  // Live-reload tumwater.json — the single reload point shared by all roles.
  // src/config/config-live.ts owns the last-known-good retention and the edge-triggered
  // warnings/events around it.
  const liveConfig = ctx.liveReload.poll();
  // The notify command rides the same last-known-good reload (src/events/notify.ts): a live
  // `config set notify` edit takes effect on the next poll, no restart.
  ctx.notifier.update(liveConfig);

  // Live session retention (the last restart-only setting): the edge-triggered
  // retention_changed event, the once-per-day gate, and the prune itself live in
  // src/orchestrator/retention.ts. The live config (last-known-good while the file is broken or
  // missing) drives the check, like the budget gate.
  ctx.retentionPruner.poll(root, liveConfig.sessionRetentionDays);

  // launchservicesd's Mach-port budget (src/process/launch-services.ts owns it):
  // a background sample at most every 15 minutes, and a warning days before the kernel
  // kills the daemon and wedges the Mac's GUI session. Never awaited — a poll does not
  // wait on `top`.
  void ctx.launchServicesWatch?.poll();

  // Consume CLI request markers: a reset-counters request, a wake request, a forced-restart
  // request, and per-role abort requests.
  consumeResetRequest(root, runners);
  consumeWakeRequest(root, runners);
  consumeRestartRequest(root, ctx.redeploy);
  consumeReclaimRequest(root, ctx.reclaim);
  consumeAbortRequests(root, runners, abortableMerges(ctx.merges));
  await settleAbortedApproved(root, ctx.merges);

  // branchHead reads the ref files first (microsecond-scale; this runs every poll) and
  // spawns `git rev-parse` only when they cannot resolve it. "" means main does not exist
  // yet — isEligible treats an empty head as "no wake".
  const mainHead = (await branchHead(root, mainBranch)) ?? "";
  // Branch-divergence watch, once per poll: the team keeps fast-forwarding the branch it
  // resolved at startup — the safe behavior, since role worktrees are based on it — and one
  // warning names the divergence instead of leaving it mysterious. Back on the target branch
  // re-arms the check.
  const liveBranch = await currentBranch(root);
  if (liveBranch !== null && liveBranch !== mainBranch) {
    if (!state.warnedBranchDivergence) {
      state.warnedBranchDivergence = true;
      ctx.warn(`your checkout moved to ${liveBranch} — the team keeps merging into ${mainBranch}`);
    }
  } else {
    state.warnedBranchDivergence = false;
  }
  return { liveConfig, mainHead, now: Date.now() };
}

/** One poll's gate verdicts (src/gates/gate-polls.ts) plus the failure-hold views derived
 * from them. */
type PollGates = ReturnType<typeof pollTeamGates> & {
  teamHeldProviders: ReadonlySet<string | undefined>;
  /** Fresh reads for the permit-time closures: they run after later polls have advanced
   * gateStates.teamHold, so they re-derive from the LATEST poll's map, not this snapshot. */
  teamHeldNow: () => ReadonlySet<string | undefined>;
  reviewHeldNow: () => boolean;
  reviewHeld: boolean;
  roleProviders: Map<string, string | undefined>;
};

/** The team's gates and alarms, one poll of the family (src/gates/gate-polls.ts): the daily
 * budget gate — with its derived-state publish and the fallback handback to the primary — the
 * operator and per-role pause gates, quiet hours, the team-wide failure hold, and the two
 * observational storm alarms. The family's cross-poll memory lives in gateStates, advanced in
 * place. The failure hold is deliberately not among the returned verdicts — the start gate and
 * the merges' startHeld read the LATEST poll's verdict at permit time from gateStates.teamHold,
 * so a waiter granted its permit after later polls ran meets the hold as it stands then.
 * Writes state.diskHeld. */
export function pollGatesAndHolds(
  ctx: PollContext,
  state: PollState,
  { liveConfig, now }: PollInputs,
): PollGates {
  const { root, runners, gateStates } = ctx;
  const gates = pollTeamGates(gateStates, {
    root,
    runners,
    liveConfig,
    modelsPath: ctx.modelsPath,
    now,
    info: ctx.info,
    reclaim: ctx.reclaim,
  });
  // The latest poll's disk verdict, hoisted for tickStartHeld's permit-time reads
  // (plans/disk-floor.md, part 1/4).
  state.diskHeld = gates.diskHeld;
  // Publish the permit pool's live state (plans/provider-concurrency.md §8): observers
  // (status, TUI, GUI) read one file instead of coupling to this Semaphore, and the team
  // line shows per-provider counts only while a cap map is configured. Written only when
  // it changes, like budget and disk; a map-less team publishes `byKey` empty, which
  // renders exactly as before. The check-permit pool rides along, so status can show checks
  // running and waiting while merges stall. The workspace pool's live state rides along too:
  // one small slots.json read per poll, and publishInfoFields rewrites the info file only
  // when a value changed.
  publishInfoFields(root, ctx.info, [
    ["permits", ctx.semaphore.snapshot()],
    ["checkPermits", checkPermitSnapshot()],
    ["slotPool", slotPoolSnapshot(root)],
  ]);

  // The failure hold, keyed per provider (PLANS.md 2026-10-05): a role is held when ITS
  // tick model's provider stands under a hold, and every role is held when the
  // reviewer's provider is (with the review gate on, nothing could merge — and the merge
  // queue reads the same reviewHeld verdict). Key presence in the map is relapse
  // memory, not a hold: heldProviders() reads only standing holds (`until` non-null),
  // so a lifted hold never keeps blocking.
  const teamHeldProviders = heldProviders(gateStates.teamHold);
  const teamHeldNow = () => heldProviders(gateStates.teamHold);
  // The reviewer's seam is read from the config merges actually review under — the poll's
  // roleConfig, which a used-up claude window or the cap has already moved to a fallback —
  // so a reviewer that left claude no longer holds the whole team on the claude hold.
  const reviewSeamKey = reviewHoldKey(gates.roleConfig);
  return {
    ...gates,
    teamHeldProviders,
    teamHeldNow,
    reviewHeldNow: () => liveConfig.review.enabled && teamHeldNow().has(reviewSeamKey),
    reviewHeld: liveConfig.review.enabled && teamHeldProviders.has(reviewSeamKey),
    roleProviders: new Map(runners.map((r) => [r.role, r.runProvider(now)])),
  };
}

/** Self-redeploy (src/redeploy/redeployer.ts): with main's head in hand, let the state
 * machine observe it. `hold` starts no new ticks at all — director included; a restart
 * takes effect within the drain's window plus a bounded merge hand-off, and its prompt waits
 * in the inbox for the new build — while the green check/compile/drain run in the
 * background. That covers ticks reserved before the hold too: a waiter parked in the
 * semaphore queue that is granted a permit mid-drain meets the closed start gate
 * (tickStartHeld), releases the permit, and hands its reservation back so it re-schedules
 * once the hold lifts or on the new build. `restart` means dist/ already holds the new
 * build: stop scheduling, abort whatever role ticks the drain gave up waiting for — the
 * permit holders; they resume on the new build — and return true. A director tick can never
 * be in flight here — poll only returns `restart` once it has finished. (holdForRestart keeps
 * the previous poll's verdict until this one's is in: resetting it before the await
 * would open the gate for a waiter granted a permit while poll runs.)
 * Main watch (src/baseline/main-watch.ts): records the full check's verdict on main's new
 * tip in the background; nothing here waits for it. Writes state.restart and
 * state.holdForRestart; returns whether the loop should stop. */
export async function pollRedeploy(
  ctx: PollContext,
  state: PollState,
  { liveConfig, mainHead, now }: PollInputs,
): Promise<boolean> {
  const { redeploy } = ctx;
  if (!ctx.onceMode) ctx.mainWatch.poll(mainHead, state.holdForRestart || state.diskHeld, liveConfig);
  if (!redeploy) return false;
  const action = await redeploy.poll(
    await redeployTarget(ctx.root, mainHead, redeploy.build.sha),
    {
      roleInFlight: ctx.rolePermitHolders.size,
      directorInFlight: ctx.directorInFlight.size,
      roleTickP75Ms: p75TickDurationMs(ctx.roleTickDurationsMs),
    },
    liveConfig.autoRestart,
    now,
  );
  publishInfoFields(ctx.root, ctx.info, [["build", redeploy.status(now)]]);
  if (action === "restart") {
    state.restart = true;
    // Only permit holders have a pi run to cut off (the director is guaranteed finished by
    // then): a parked waiter meets the closed start gate whenever the shutdown hands it a
    // permit, so it needs no abort — and aborting for it alone would also cut off an
    // in-flight merge that no permit-holding tick put at stake. The role-only controller
    // keeps that promise: the merge, wired to the full signal, runs on into the hand-off
    // window the wait announces (BUGS.md 2026-09-30).
    if (ctx.rolePermitHolders.size > 0) ctx.internalRoleStop.abort();
    return true;
  }
  state.holdForRestart = action === "hold";
  return false;
}

/** Merge queue 3/5 — drain the durable merge queue while neither a restart nor a failure
 * hold is pending (the scheduler's WHEN; merge-drain.ts owns the HOW — the verification
 * stage, its merge slot, and the dedupe against main). A held poll starts no verify and no
 * merge, exactly as it starts no tick; what is already in flight runs on, and a verify
 * parked for its permit meets the same start gate as a parked tick when the permit comes. */
export async function pollMergeDrain(
  ctx: PollContext,
  state: PollState,
  { liveConfig, mainHead }: PollInputs,
  gates: PollGates,
): Promise<void> {
  if (state.holdForRestart || gates.reviewHeld || state.diskHeld) return;
  const { root, mainBranch } = ctx;
  // A `main_red` pin the pipeline kept goes back on the queue once main's head has moved.
  for (const r of ctx.runners) await requeueMainRedPin(root, mainBranch, r.state, mainHead);
  await drainMergeQueue(
    {
      root,
      mainBranch,
      signal: ctx.signal,
      semaphore: ctx.semaphore,
      runners: ctx.runners,
      liveConfig,
      roleConfig: gates.roleConfig,
      directorConfig: gates.directorConfig,
      piDefault: ctx.piDefault,
      startHeld: () => tickStartHeld(state) || gates.reviewHeldNow(),
    },
    ctx.merges,
  );
}

/** The scheduling pass: the deferral inputs feed pollRunnerReasons, whose reasons map
 * launchDueTicks starts ticks from. */
export async function pollSchedule(
  ctx: PollContext,
  state: PollState,
  { liveConfig, mainHead, now }: PollInputs,
  gates: PollGates,
): Promise<void> {
  const { root, runners, gateStates } = ctx;
  const inputs = pollDeferralInputs(root, runners, liveConfig, gateStates, gates, ctx.breakerNow());
  const reasons = await pollRunnerReasons({
    root,
    runners,
    once: ctx.once,
    now,
    mainHead,
    userPaused: gates.userPaused,
    quietNow: gates.quietNow,
    pausedRoles: gates.pausedRoles,
    capPaused: gates.capPaused,
    maintenanceQuota: gates.maintenanceQuota,
    bootstrapHeld: gates.bootstrapHeld,
    budgetPausedRoles: gates.budgetPausedRoles,
    probeRoles: inputs.probeRoles,
    reviewStrongPaused: inputs.reviewStrongPaused,
    roleQuietHeld: gates.roleQuietHeld,
    holdForRestart: state.holdForRestart,
    diskHeld: state.diskHeld,
    heldProviders: gates.teamHeldProviders,
    windowHeldProviders: windowHeldProviders(gateStates.teamHold),
    reviewHeld: gates.reviewHeld,
    roleProviders: gates.roleProviders,
    openBugsNow: inputs.openBugsNow,
    workBacklogOpen: inputs.workBacklogOpen,
    planBacklogFull: inputs.plansFull,
    deferredDue: ctx.deferredDue,
    workMergedSince: ctx.workMergedSince,
  });
  launchDueTicks({
    root,
    reasons,
    // roleSignal, not signal: the timed tick wrapper watches the full signal PLUS the
    // role-only stop, exactly as the pre-extraction inline pass did — the restart drain's
    // give-up abort must also turn away a waiter granted its permit at that moment.
    signal: ctx.roleSignal,
    gateStates,
    breakerPolicy: ctx.breakerPolicy,
    breakerNow: ctx.breakerNow,
    probePair: inputs.probePair,
    probeRoles: inputs.probeRoles,
    budgetActive: gates.budgetActive,
    semaphore: ctx.semaphore,
    piDefault: ctx.piDefault,
    rolePermitHolders: ctx.rolePermitHolders,
    roleInFlight: ctx.roleInFlight,
    directorInFlight: ctx.directorInFlight,
    roleTickDurationsMs: ctx.roleTickDurationsMs,
    startHeld: (role) =>
      tickStartHeld(state) ||
      (role !== DIRECTOR_ROLE
        ? gates.reviewHeldNow() || gates.teamHeldNow().has(gates.roleProviders.get(role))
        : windowHeldProviders(gateStates.teamHold).has(gates.roleProviders.get(role))),
  });
}

/** Priority headroom, then once mode's exit; returns whether the loop should stop. Writes
 * state.lastReserve and, in once mode, fires internalStop. */
export function pollReserveAndExit(ctx: PollContext, state: PollState, { liveConfig, now }: PollInputs): boolean {
  const { root, runners, semaphore } = ctx;
  // Priority headroom (plans/parallel-work-instances.md part 7/7): withhold a few permits
  // from maintenance while a work role has work to take, so a due work tick never waits out
  // a whole maintenance tick. Sized after the launch pass, so a runner launched this poll
  // already reads as running and reserves nothing for itself.
  const poolSnapshot = semaphore.snapshot();
  // The provider-headroom predicate receives the structural ClaimRunner; the config that
  // names the provider lives on the real RoleRunners, so look the runner up by role.
  const runnerByRole = new Map(runners.map((r) => [r.role, r]));
  const reserve = workReserveCount(root, runners, {
    maxConcurrent: liveConfig.maxConcurrent,
    enabled: new Set(runners.filter((r) => runnerEnabled(r.config, r.role)).map((r) => r.role)),
    queuedMergeRoles: queuedMergeRoles(root),
    instancesOf: (base) => liveConfig.roles[base]?.instances ?? 1,
    // Per-provider headroom (plans/provider-concurrency.md §6): an idle work role reserves a
    // permit only when its own provider could use it — capped and full, it would only idle
    // the slot another provider's maintenance tick could take. Read from the pool's live
    // snapshot; an uncapped key (or the team-total-only case) always has headroom.
    providerHasHeadroom: (r) => {
      const runner = runnerByRole.get(r.role);
      const cfg = runner && runner.role !== DIRECTOR_ROLE ? runner.runConfig(now) : null;
      const key = cfg ? seamConcurrencyKey(cfg, ctx.piDefault) : undefined;
      if (key === undefined) return true;
      const k = poolSnapshot.byKey[key];
      if (k?.limit === undefined) return true;
      return k.inUse < k.limit;
    },
  });
  semaphore.setReserve(reserve);
  if ((state.lastReserve === 0) !== (reserve === 0)) {
    ctx.emit({ source: TUMWATER_SOURCE, type: "permit_reserve", reserve });
  }
  state.lastReserve = reserve;

  // Once mode's exit: every enabled role settled, no tick in flight, and the merge queue
  // empty with no merge in flight for one full poll cycle — then fire the internal
  // stop, the same graceful shutdown the restart drain uses (the `finally` awaits
  // in-flight merge tasks to the end). The one-poll-cycle requirement is the guard
  // against dropping a queued-but-not-yet-started merge: a stop that arrives during the
  // shutdown drain drops the queue entry, so the slot gets its poll to pick the entry up
  // before the stop is trusted.
  if (
    ctx.once.exitReady({
      roleTicks: ctx.roleInFlight.size,
      directorTicks: ctx.directorInFlight.size,
      merges: mergeTasks(ctx.merges).length,
      queuedMerges: queuedMergeFiles(root).length,
    })
  ) {
    ctx.internalStop.abort();
    return true;
  }
  return false;
}
