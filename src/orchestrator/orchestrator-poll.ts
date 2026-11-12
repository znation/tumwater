/** The orchestrator's per-poll steps (src/orchestrator/orchestrator.ts keeps the setup, the loop
 * skeleton and the shutdown drain): each step names what it reads from the PollContext and what
 * it reads or writes in the PollState, so one poll's passes read apart from one another. Called
 * in this order every poll — requests and watch, gates, redeploy, merge drain, scheduling,
 * reserve and exit — and moved here without reordering any of them. */
import type { TumwaterConfig } from "../config/config-schema.js";
import { publishInfoFields, type OrchestratorInfo } from "../team/team-orchestrator-info.js";
import { runnerEnabled } from "../roles/runner-ids.js";
import type { newLiveConfigReload } from "../config/config-live.js";
import type { FallbackBreakerPolicy } from "../budget/fallback-breaker.js";
import { reviewHoldKey, reviewPairKey, pollDeferralInputs, pollRunnerReasons } from "./orchestrator-scheduling.js";
import { seamPairName } from "../config/config-views.js";
import { refreshPendingPlans } from "../backlog/backlog-pending.js";
import { launchDueRuns } from "./orchestrator-launch.js";
import type { RoleRunner } from "../runner/runner.js";
import { branchHead, currentBranch } from "../git/git.js";
import { readMergePins } from "../merge/merge-pins.js";
import { drainMergeQueue } from "../merge/merge-drain.js";
import { abortableMerges, mergeTasks, type MergePipeline } from "../merge/merge-pipeline.js";
import { TUMWATER_SOURCE, type HarnessEventInput } from "../events/events.js";
import type { OnceRound } from "../scheduling/once-round.js";
import type { newNotifier } from "../events/event-notify.js";
import {
  consumeAbortRequests,
  consumeModelCheckRequest,
  consumeReclaimRequest,
  consumeRestartRequest,
  consumeResetRequest,
  consumeWakeRequest,
} from "../operator/operator-requests.js";
import { checkPermitSnapshot } from "../concurrency/check-permit.js";
import { slotPoolSnapshot } from "../git/worktree-pool.js";
import type { Semaphore } from "../concurrency/semaphore.js";
import type { createMainWatch } from "../baseline/main-watch.js";
import { watchVerifiesMain } from "../baseline/main-baseline.js";
import { redeployTarget } from "../redeploy/redeploy-target.js";
import type { Redeployer } from "../redeploy/redeployer.js";
import type { LaunchServicesWatch } from "../process/launch-services.js";
import type { RetentionPruner } from "./retention.js";
import type { newOpencodeCatalogRefresh } from "../gates/startup-gates.js";
import type { WorkMergedCache } from "../scheduling/work-merged-cache.js";
import { p75RunDurationMs } from "../run/run-timing.js";
import { dueForOrphanReap, reapAttributableOrphans, type OrphanSignals } from "../doctor/doctor-orphans.js";
import type { ProcessProbe } from "../process/process-table.js";
// The reap's policy (its interval, and the due-check it throttles with) lives in
// doctor-orphans.ts beside the age gate (PLANS.md 2026-11-11); re-exported from here
// because test/doctor-orphans.test.ts imports them from this module.
export { dueForOrphanReap, ORPHAN_REAP_INTERVAL_MS } from "../doctor/doctor-orphans.js";
import { pollTeamGates, type TeamGateStates } from "../gates/gate-polls.js";
import type { ReclaimController } from "../team/team-reclaim.js";
import { heldProviders, heldPairs, heldStarts, windowHeldProviders } from "../team/team-hold.js";
import { workReserveCount } from "../scheduling/claims.js";
import type { ModelCheckGate } from "../model-check/model-check-gate.js";
import { requestPrinciplesConsolidation } from "../prompt/principles-consolidation.js";

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
  redeploy: Redeployer | null;
  launchServicesWatch: LaunchServicesWatch | null;
  reclaim: ReclaimController;
  liveReload: ReturnType<typeof newLiveConfigReload>;
  notifier: ReturnType<typeof newNotifier>;
  retentionPruner: RetentionPruner;
  opencodeCatalogRefresh: ReturnType<typeof newOpencodeCatalogRefresh>;
  mainWatch: ReturnType<typeof createMainWatch>;
  workMergedSince: WorkMergedCache;
  deferredDue: Map<string, boolean>;
  /** The model check (src/model-check/model-check-gate.ts), or null while it is off (a
   * `--once` round, an in-process test that injects no prober). */
  modelCheck: ModelCheckGate | null;
  breakerPolicy: FallbackBreakerPolicy;
  breakerNow: () => number;
  roleInFlight: Set<Promise<void>>;
  rolePermitHolders: Set<RoleRunner>;
  directorInFlight: Set<Promise<void>>;
  roleRunDurationsMs: number[];
  emit: (event: HarnessEventInput) => void;
  warn: (message: string) => void;
}

/** The flags that outlive one poll. */
export interface PollState {
  /** dist/ already holds the new build: set by the redeploy step, read by the shutdown drain
   * and the exit value. */
  restart: boolean;
  /** Whether the last poll found a self-redeploy pending (`hold`). Read at scheduling (no new
   * run is reserved) and — through runStartHeld — whenever a parked waiter is granted its
   * permit, which happens between polls. */
  holdForRestart: boolean;
  /** Whether the last poll's disk gate held new work (plans/disk-floor.md, part 1/4); read at
   * permit time by runStartHeld, like holdForRestart. */
  diskHeld: boolean;
  /** The primary checkout moved off the target branch and the one warning was logged; re-armed
   * when the checkout returns. */
  warnedBranchDivergence: boolean;
  /** The maintenance permits withheld for work roles that have work to take (part 7/7), so the
   * event logs only the crossings into and out of a reserved state. */
  lastReserve: number;
  /** The last poll at which the orphan reap ran (src/doctor/doctor-orphans.ts's
   * reapAttributableOrphans), 0 before the first reap so the first poll reaps immediately. */
  lastOrphanReapAt: number;
}

export function newPollState(): PollState {
  return { restart: false, holdForRestart: false, diskHeld: false, warnedBranchDivergence: false, lastReserve: 0, lastOrphanReapAt: 0 };
}

/** The start gate every reserved run passes the moment its permit is granted
 * (runTimedRoleRun's `held`): closed while a restart is pending, and after one is decided so
 * no waiter the shutdown hands a permit to starts on the build being replaced. One predicate,
 * so another team-wide hold on new runs can close the same gate point. */
function runStartHeld(state: PollState): boolean {
  return state.holdForRestart || state.restart || state.diskHeld;
}

/** The one start-gate rule for merges: a restart/disk hold's `held` counts against every role,
 * while a hold on the reviewer's provider (`reviewHeld`) parks only the entries a caller that
 * names no role admits — the post-merge review drain. A role named (every merge entry) is never
 * held by the reviewer: no role start or landing waits on the reviewer. Shared by
 * pollMergeDrain's startHeld and the merge tests, so the production wiring and its coverage
 * cannot drift. */
export function mergeStartHeld(held: boolean, reviewHeld: boolean, role?: string): boolean {
  return held || (reviewHeld && role === undefined);
}

/** The team's standing self-heal sweep (PLANS.md 2026-11-11): at most once per interval, kill
 * the orphans the doctor row already reports that are old enough that no live run can still own
 * them — the automatic counterpart to the human click `doctor --kill-orphans`/dashboard/TUI
 * makes. The time is stamped before the await, so a slow scan cannot overlap the next poll's
 * reap (this is the running team's only caller). A stopped team never runs the sweep — nothing
 * polls — so it never calls this; the dashboards and status read the standing alert's show-rule
 * (alert-feeds.ts's orphanAlertVisible) instead, which is what shows for a stopped team. `reap`
 * is injectable for tests, which stub
 * the kill and pin the stamp-then-reap call shape without a real process table. */
export async function pollOrphanReap(
  root: string,
  state: PollState,
  reap: (root: string, probe?: ProcessProbe, signals?: OrphanSignals) => Promise<unknown> = reapAttributableOrphans,
): Promise<void> {
  if (dueForOrphanReap(state.lastOrphanReapAt, Date.now())) {
    state.lastOrphanReapAt = Date.now();
    await reap(root);
  }
}

/** What the request-and-watch step hands the rest of the poll. */
interface PollInputs {
  liveConfig: TumwaterConfig;
  mainHead: string;
  now: number;
}

/** Live-reload, notify/retention/launchservices, CLI request markers, abort settling, the
 * branch-divergence watch, and the over-cap PRINCIPLES.md consolidation request (one assignment
 * at a time; the doctor `principles` row and the `principlesTruncated` key stay the diagnostic).
 * Writes state.warnedBranchDivergence. */
export async function pollRequestsAndWatch(ctx: PollContext, state: PollState): Promise<PollInputs> {
  const { root, mainBranch, runners } = ctx;
  // Live-reload tumwater.json — the single reload point shared by all roles.
  // src/config/config-live.ts owns the last-known-good retention and the edge-triggered
  // warnings/events around it.
  const liveConfig = ctx.liveReload.poll();
  // The notify command rides the same last-known-good reload (src/events/event-notify.ts): a live
  // `config set notify` edit takes effect on the next poll, no restart.
  ctx.notifier.update(liveConfig);

  // Live session retention (the last restart-only setting): the edge-triggered
  // retention_changed event, the once-per-day gate, and the prune itself live in
  // src/orchestrator/retention.ts. The live config (last-known-good while the file is broken or
  // missing) drives the check, like the budget gate.
  ctx.retentionPruner.poll(root, liveConfig.sessionRetentionDays);
  // The orphan self-reap (doctor-orphans.ts): the throttled sweep pollOrphanReap owns — kill
  // each listed orphan old enough that no live run can still own it, at most once per
  // interval. This await holds the poll step, so a slow scan cannot overlap the next poll's.
  await pollOrphanReap(root, state);
  // A missing or stale opencode catalog is refetched at most once an hour while opencode is routed.
  ctx.opencodeCatalogRefresh.poll(liveConfig);

  // launchservicesd's Mach-port budget (src/process/launch-services.ts owns it):
  // a background sample at most every 15 minutes, and a warning days before the kernel
  // kills the daemon and wedges the Mac's GUI session. Never awaited — a poll does not
  // wait on `top`.
  void ctx.launchServicesWatch?.poll();

  // Consume CLI request markers: a reset-counters request, a wake request, a forced-restart
  // request, a model-check re-check request (before pollGates runs the model-check poll, so a
  // requested re-check takes effect on the same poll), and per-role abort requests.
  consumeResetRequest(root, runners);
  consumeWakeRequest(root, runners);
  consumeRestartRequest(root, ctx.redeploy);
  consumeReclaimRequest(root, ctx.reclaim);
  consumeModelCheckRequest(root, ctx.modelCheck);
  consumeAbortRequests(root, runners, abortableMerges(ctx.merges));

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
  // PRINCIPLES.md over its prompt cap: the orchestrator queues the director (the role allowed
  // to edit PRINCIPLES.md) a one-shot consolidation prompt instead of the team surfacing the
  // old standing amber `principles-truncated` alert. `principlesBlockOverCap` is stat-cached
  // per root, so the under-cap common case is one cheap read per poll; the queued/busy/pin
  // checks inside keep an over-cap episode to one assignment at a time. An enqueue failure
  // only warns — it never ends the poll loop.
  {
    const consolidation = await requestPrinciplesConsolidation(root, {
      directorBusy: ctx.directorInFlight.size > 0,
    });
    if (!consolidation.requested && consolidation.error) {
      ctx.warn(`could not queue the PRINCIPLES.md consolidation: ${consolidation.error}`);
    }
  }
  return { liveConfig, mainHead, now: Date.now() };
}

/** One poll's gate verdicts (src/gates/gate-polls.ts) plus the failure-hold views derived
 * from them. */
type PollGates = ReturnType<typeof pollTeamGates> & {
  teamHeldProviders: ReadonlySet<string | undefined>;
  teamHeldPairs: ReadonlySet<string>;
  /** Fresh reads for the permit-time closures: they run after later polls have advanced
   * gateStates.teamHold, so they re-derive from the LATEST poll's map, not this snapshot. */
  teamHeldNow: () => ReadonlySet<string | undefined>;
  reviewHeldNow: () => boolean;
  roleProviders: Map<string, string | undefined>;
  rolePairs: Map<string, string>;
  /** The roles the model check holds this poll (empty while the check is off). */
  modelCheckHeld: ReadonlySet<string>;
};

/** The team's gates and alarms, one poll of the family (src/gates/gate-polls.ts): the daily
 * budget gate — with its derived-state publish and the fallback handback to the primary — the
 * operator and per-role pause gates, quiet hours, the team-wide failure hold, and the two
 * observational storm alarms. The family's cross-poll memory lives in gateStates, advanced in
 * place. The failure hold is deliberately not among the returned verdicts — its provider scope
 * (teamHeldNow) re-derives from the LATEST gateStates.teamHold at permit time, so a waiter
 * granted its permit after later polls ran meets the provider hold as it stands then; a
 * model-load hold's PAIR scope (teamHeldPairs) is this poll's snapshot and does not re-derive —
 * a waiter met after later polls still reads this poll's pair set.
 * Writes state.diskHeld. */
export function pollGatesAndHolds(
  ctx: PollContext,
  state: PollState,
  { liveConfig, now }: PollInputs,
): PollGates {
  const { root, runners, gateStates } = ctx;
  const modelCheck = ctx.modelCheck;
  const gates = pollTeamGates(gateStates, {
    root,
    runners,
    liveConfig,
    modelsPath: ctx.modelsPath,
    now,
    info: ctx.info,
    reclaim: ctx.reclaim,
    ...(modelCheck !== null
      ? {
          modelCheckFailed: (pair: string) => modelCheck.failed(pair),
          modelCheckVerified: (pair: string) => modelCheck.verified(pair),
        }
      : {}),
  });
  // The model check (src/model-check/model-check-gate.ts), after the budget gate has assigned
  // each runner the config its next run uses: re-key to the pairs in use (the primaries of the
  // tiers it moved included), start the due probes in the background, and hold the roles whose
  // pair has not answered.
  const modelCheckHeld: ReadonlySet<string> =
    modelCheck?.poll({
      runners,
      liveConfig,
      roleConfig: gates.roleConfig,
      checkMoved: gates.checkMoved,
      info: ctx.info,
    }) ?? new Set<string>();
  // The latest poll's disk verdict, hoisted for runStartHeld's permit-time reads
  // (plans/disk-floor.md, part 1/4).
  state.diskHeld = gates.diskHeld;
  // Publish the permit pool's live state (plans/provider-concurrency.md §8): observers
  // (status, TUI, GUI) read one file instead of coupling to this Semaphore, and the team
  // line shows the team total. Written only when it changes, like budget and disk. The
  // check-permit pool rides along, so status can show checks
  // running and waiting while merges stall. The workspace pool's live state rides along too:
  // one small slots.json read per poll, and publishInfoFields rewrites the info file only
  // when a value changed.
  publishInfoFields(root, ctx.info, [
    ["permits", ctx.semaphore.snapshot()],
    ["checkPermits", checkPermitSnapshot()],
    ["slotPool", slotPoolSnapshot(root)],
  ]);

  // The failure hold, keyed per provider (PLANS.md 2026-10-05): a role is held when ITS
  // run model's provider stands under a hold. A model-load hold that names its pairs is the
  // exception (PLANS.md "One unavailable model pair stops only the roles on that pair",
  // part 2/2): it holds exactly the roles on the pairs whose model failed to load, and a
  // role on another model at the same provider keeps running — heldProviders skips that
  // provider, and heldPairs is the pair scope the scheduling and start passes read. A hold
  // on the reviewer's provider parks only the post-merge review drain, never a role start,
  // verify or landing. Key presence in the
  // map is relapse memory, not a hold: heldProviders() reads only standing holds (`until`
  // non-null), so a lifted hold never keeps blocking.
  const teamHeldProviders = heldProviders(gateStates.teamHold);
  const teamHeldNow = () => heldProviders(gateStates.teamHold);
  const teamHeldPairs = heldPairs(gateStates.teamHold);
  // The reviewer's seam is read from the config merges actually review under — the poll's
  // roleConfig, which a used-up claude window or the cap has already moved to a fallback —
  // so a reviewer that left claude no longer parks the post-merge review drain on the
  // claude hold. Its PAIR is the model-load scope: a standing model-load hold naming the
  // reviewer's pair parks the drain, because the review run would fail to load the same
  // model — exactly as the provider-wide kinds do via reviewHoldKey.
  const reviewSeamKey = reviewHoldKey(gates.roleConfig);
  const reviewSeamPair = reviewPairKey(gates.roleConfig);
  return {
    ...gates,
    teamHeldProviders,
    teamHeldNow,
    teamHeldPairs,
    // `modelCheck.poll` ran above in this same poll, so its verdict is this poll's: the
    // failed-or-checking reviewer pair parks the drain beside the reviewer's provider hold
    // and its model-load pair hold.
    reviewHeldNow: () =>
      liveConfig.review.enabled &&
      (teamHeldNow().has(reviewSeamKey) ||
        teamHeldPairs.has(reviewSeamPair) ||
        (modelCheck?.reviewHeld() ?? false)),
    roleProviders: new Map(runners.map((r) => [r.role, r.runProvider()])),
    rolePairs: new Map(runners.map((r) => [r.role, seamPairName(r.runConfig())])),
    modelCheckHeld,
  };
}

/** Self-redeploy (src/redeploy/redeployer.ts): with main's head in hand, let the state
 * machine observe it. `hold` starts no new runs at all — director included; a restart
 * takes effect within the drain's window plus a bounded merge hand-off, and its prompt waits
 * in the inbox for the new build — while the green check/compile/drain run in the
 * background. That covers runs reserved before the hold too: a waiter parked in the
 * semaphore queue that is granted a permit mid-drain meets the closed start gate
 * (runStartHeld), releases the permit, and hands its reservation back so it re-schedules
 * once the hold lifts or on the new build. `restart` means dist/ already holds the new
 * build: stop scheduling, abort whatever role runs the drain gave up waiting for — the
 * permit holders; they resume on the new build — and return true. A director run can never
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
    await redeployTarget(ctx.root, mainHead, redeploy.build.sha, watchVerifiesMain(ctx.root, liveConfig)),
    {
      roleInFlight: ctx.rolePermitHolders.size,
      directorInFlight: ctx.directorInFlight.size,
      roleRunP75Ms: p75RunDurationMs(ctx.roleRunDurationsMs),
    },
    liveConfig.autoRestart,
    now,
  );
  // The tip beside the target: a tip no passing check covers yet is published as waitingForCheck.
  await redeploy.noteTip(mainHead);
  publishInfoFields(ctx.root, ctx.info, [["build", redeploy.status(now)]]);
  if (action === "restart") {
    state.restart = true;
    // Only permit holders have a pi run to cut off (the director is guaranteed finished by
    // then): a parked waiter meets the closed start gate whenever the shutdown hands it a
    // permit, so it needs no abort — and aborting for it alone would also cut off an
    // in-flight merge that no permit-holding run put at stake. The role-only controller
    // keeps that promise: the merge, wired to the full signal, runs on into the hand-off
    // window the wait announces (BUGS.md 2026-09-30).
    if (ctx.rolePermitHolders.size > 0) ctx.internalRoleStop.abort();
    return true;
  }
  state.holdForRestart = action === "hold";
  return false;
}

/** Merge queue 3/5 — drain the durable merge queue while neither a restart nor a disk hold is
 * pending (the scheduler's WHEN; merge-drain.ts owns the HOW — the verification stage, its
 * merge slot, and the dedupe against main). A restart or disk hold stops the whole drain, as it
 * starts no run; what is already in flight carries on, and a verify parked for its permit
 * meets the same start gate as a parked run when the permit comes. A hold on the reviewer's
 * provider parks nothing in the drain — no merge entry is held by the reviewer (its hold parks
 * only the post-merge review drain, whose no-role start gate reads it). */
export async function pollMergeDrain(
  ctx: PollContext,
  state: PollState,
  { liveConfig }: PollInputs,
  gates: PollGates,
): Promise<void> {
  if (state.holdForRestart || state.diskHeld) return;
  const { root, mainBranch } = ctx;
  await drainMergeQueue(
    {
      root,
      mainBranch,
      signal: ctx.signal,
      semaphore: ctx.semaphore,
      runners: ctx.runners,
      liveConfig,
      roleConfig: gates.roleConfig,
      directorConfig: liveConfig,
      startHeld: (role) => mergeStartHeld(runStartHeld(state), gates.reviewHeldNow(), role),
    },
    ctx.merges,
  );
}

/** The scheduling pass: the deferral inputs feed pollRunnerReasons, whose reasons map
 * launchDueRuns starts runs from. */
export async function pollSchedule(
  ctx: PollContext,
  state: PollState,
  { liveConfig, mainHead, now }: PollInputs,
  gates: PollGates,
): Promise<void> {
  const { root, runners, gateStates, mainBranch } = ctx;
  // The plan role's stop count reads `## Planned` as it will be once every unmerged change
  // merges (refreshPendingPlans, plans/duplicate-plans.md "Decision" 1): one refresh per poll
  // before the deferral inputs, so a pin written by a merge this poll is seen before the
  // plan deferral decides. A git failure leaves the previous snapshot in place and never
  // throws into the poll.
  await refreshPendingPlans(root, mainBranch);
  const inputs = pollDeferralInputs(root, runners, liveConfig, gateStates, gates, ctx.breakerNow());
  const reasons = await pollRunnerReasons({
    root,
    mainBranch,
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
    roleQuietHeld: gates.roleQuietHeld,
    holdForRestart: state.holdForRestart,
    diskHeld: state.diskHeld,
    heldProviders: gates.teamHeldProviders,
    windowHeldProviders: windowHeldProviders(gateStates.teamHold),
    roleProviders: gates.roleProviders,
    heldPairs: gates.teamHeldPairs,
    rolePairs: gates.rolePairs,
    openBugsNow: inputs.openBugsNow,
    workBacklogOpen: inputs.workBacklogOpen,
    planBacklogFull: inputs.plansFull,
    deferredDue: ctx.deferredDue,
    workMergedSince: ctx.workMergedSince,
    modelCheckHeld: gates.modelCheckHeld,
  });
  const modelCheck = ctx.modelCheck;
  launchDueRuns({
    root,
    reasons,
    // roleSignal, not signal: the timed run wrapper watches the full signal PLUS the
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
    rolePermitHolders: ctx.rolePermitHolders,
    roleInFlight: ctx.roleInFlight,
    directorInFlight: ctx.directorInFlight,
    roleRunDurationsMs: ctx.roleRunDurationsMs,
    startHeld: (role) =>
      runStartHeld(state) ||
      // The model check's LATEST verdict (the gate keeps the newest poll's held set), so a
      // waiter parked before its pair failed does not start on it.
      (modelCheck?.held.has(role) ?? false) ||
      // The team-failure hold, as the same shared rule the scheduling pass applies (team-hold.ts
      // heldStarts — the director honors only the subscription-window hold; every other role is
      // held by ITS provider's storm or, under a model-load hold that names its pairs, by ITS
      // pair). Recomputed per waiter from the live teamHold, so a hold that lands mid-poll
      // (a model-load failure) is honored by a waiter still in the queue.
      heldStarts(role, gates.roleProviders.get(role), gates.rolePairs.get(role) ?? "", windowHeldProviders(gateStates.teamHold), gates.teamHeldNow(), gates.teamHeldPairs),
    // A run that ended without changes and without declaring nothing-to-do (2026-10-30 Flint),
    // or failed before its model replied (2026-10-29 deepinfra), is the shape a serving fault
    // takes: have the model check look at its pair again. A run still waiting on its reply
    // reaches the check sooner, through the check's own poll (RoleRunner.unansweredRunPair).
    ...(modelCheck !== null ? { suspectPair: (pair: string) => modelCheck.suspect(pair) } : {}),
  });
}

/** Priority headroom, then once mode's exit; returns whether the loop should stop. Writes
 * state.lastReserve and, in once mode, fires internalStop. */
export async function pollReserveAndExit(ctx: PollContext, state: PollState, { liveConfig }: PollInputs): Promise<boolean> {
  const { root, runners, semaphore } = ctx;
  // Priority headroom (plans/parallel-work-instances.md part 7/7): withhold a few permits
  // from maintenance while a work role has work to take, so a due work run never waits out
  // a whole maintenance run. Sized after the launch pass, so a runner launched this poll
  // already reads as running and reserves nothing for itself.
  const reserve = workReserveCount(root, runners, {
    maxConcurrent: liveConfig.maxConcurrent,
    enabled: new Set(runners.filter((r) => runnerEnabled(r.config, r.role)).map((r) => r.role)),
    instancesOf: (base) => liveConfig.roles[base]?.instances ?? 1,
  });
  semaphore.setReserve(reserve);
  if ((state.lastReserve === 0) !== (reserve === 0)) {
    ctx.emit({ source: TUMWATER_SOURCE, type: "permit_reserve", reserve });
  }
  state.lastReserve = reserve;

  // Once mode's exit: every enabled role settled, no run in flight, and no live merge pin
  // with no merge in flight for one full poll cycle — then fire the internal stop, the same
  // graceful shutdown the restart drain uses (the `finally` awaits in-flight merge tasks to
  // the end). The one-poll-cycle requirement is the guard against dropping a queued-but-
  // not-yet-started merge: a stop that arrives during the shutdown drain drops the queue
  // entry, so the slot gets its poll to pick the entry up before the stop is trusted.
  // The waiting changes are the LIVE PINS (readMergePins), not the queue directory: a
  // production run writes no queue file (part 3e/7), so the old count read 0 even while pins
  // waited and a non-empty queue dir with no live pin never held the round. The count is the
  // honest source of "every waiting change merged or cleared." Read it only in once mode: a
  // daemon round (`once.active` false) makes exitReady return false regardless of the count, so
  // the pin enumeration — a `for-each-ref` spawn the drain already did earlier this same poll —
  // would cost a redundant read every poll for a value that is never used.
  const livePins = ctx.once.active ? (await readMergePins(root)).entries.length : 0;
  if (
    ctx.once.exitReady({
      roleRuns: ctx.roleInFlight.size,
      directorRuns: ctx.directorInFlight.size,
      merges: mergeTasks(ctx.merges).length,
      queuedMerges: livePins,
    })
  ) {
    ctx.internalStop.abort();
    return true;
  }
  return false;
}
