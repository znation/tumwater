/** One poll's scheduling-scope precompute, built by orchestrator-scheduling.ts's
 * pollRunnerReasons: the shared pass context and the values computed once per poll before the
 * per-runner loop — the merge-queue snapshot, the director pin, per-base claim groups, the
 * gate predicates, and the mutable admission state (quota counter, ordered runners, eligible
 * memo, reasons map). Parts 2/3 and 3/3 lift the loop's skip and admit halves against this
 * scope. */
import { increment } from "../collections.js";
import type { RoleRunner } from "../runner/runner.js";
import type { OnceRound } from "../scheduling/once-round.js";
import type { WorkMergedCache } from "../scheduling/work-merged-cache.js";
import { DIRECTOR_ROLE, commitTier } from "../roles/roles.js";
import type { MaintenanceQuotaVerdict } from "../gates/maintenance-quota.js";
import { baseRoleOf, runnerEnabled, runnerPaused } from "../roles/runner-ids.js";
import { hasOutstandingWork, saveRunnerStateBestEffort, type SkipReason } from "../runner/runner-state.js";
import { queuedMergeRoles } from "../merge/merge-queue.js";
import { hasUnmergedPin } from "../runner/leftover.js";
import { logEventBestEffort, warnEventBestEffort } from "../events/events.js";
import { type EligibleEntry, eligibleEntries } from "../backlog/backlog-eligibility.js";
import {
  CLAIM_IDLE_MAX_MS,
  claimReleaseReason,
  heldKeys,
  listedKeys,
  type ClaimReleaseReason,
} from "../scheduling/claims.js";

/** One poll's gate verdicts and context, exactly the local view the poll body holds when
 * the scheduling pass runs (TeamGatePoll's fields beside the pass's own inputs). */
export interface SchedulingPassCtx {
  root: string;
  runners: readonly RoleRunner[];
  once: OnceRound;
  now: number;
  mainHead: string;
  userPaused: boolean;
  quietNow: boolean;
  pausedRoles: ReadonlySet<string>;
  capPaused: ReadonlySet<string>;
  /** The roles the new-project bootstrap holds (plans/work-ratio.md, part 2/2). */
  bootstrapHeld: ReadonlySet<string>;
  /** The maintenance allowance's verdict this poll (plans/work-ratio.md, part 1b/4): `allowance`
   * is what the rolling window permits and `used` is the merged maintenance count plus the
   * maintenance roles already in flight. The pass admits at most the remaining
   * `allowance - used` due maintenance roles, so the headroom is never overshot within a poll. */
  maintenanceQuota: MaintenanceQuotaVerdict;
  /** The roles (the director excluded) whose own `quietHoursPerRole` window holds right now. */
  roleQuietHeld: ReadonlySet<string>;
  /** The roles (the director excluded) whose budget tier resolved to pause while the cap is
   * reached (part 5c/8, gate-polls.ts's budgetPausedRoles): a role in this set starts no new
   * run beside the per-role cap set — unless its tier is the one a due probe tests
   * (probeRoles), which pierces the hold for exactly the probed pair's own tier. */
  budgetPausedRoles: ReadonlySet<string>;
  /** The roles whose model tier resolves to the probed pair (part 5c/8): the ONLY roles the
   * budget hold exempts this poll, and the only runners the launch pass may admit as the
   * probe. A probe blind to the pair's tier lifted the pause for every role (an objection to
   * an earlier draft of this pass). */
  probeRoles: ReadonlySet<string>;
  /** With the review gate on, an unresolvable strong tier means nothing could merge, so every
   * role is held (the director exempt) — not only the strong ones. budgetGate's second pause
   * cause, split from the per-tier set so the dashboards can name the tiers' own holds
   * separately from this team-wide one. */
  reviewStrongPaused: boolean;
  /** The providers whose team-wide failure hold stands (team/team-hold.ts heldProviders —
   * `until` non-null; key presence is relapse memory, not a hold). A role starts no new
   * run while ITS provider is held (the director exempt). */
  heldProviders: ReadonlySet<string | undefined>;
  /** The subset of `heldProviders` held by a subscription window (team-hold.ts
   * windowHeldProviders): the one hold the director is NOT exempt from. */
  windowHeldProviders: ReadonlySet<string | undefined>;
  /** The reviewer's provider is held while the review gate is on: nothing could merge, so
   * EVERY role is blocked, not just roles running on that provider. */
  reviewHeld: boolean;
  /** Each runner's run model provider (configForRole at poll time): the key the
   * heldProviders check reads for that role. */
  roleProviders: ReadonlyMap<string, string | undefined>;
  /** BUGS.md `## Open` non-empty (backlog.ts's openBugs), read once per poll by the poll body. */
  openBugsNow: boolean;
  /** A pending self-redeploy hold: nothing new starts, on any role. */
  holdForRestart: boolean;
  /** The disk floor holds new work (plans/disk-floor.md, part 1/4): like a restart, nothing new
   * starts on any role — the director included — until free space recovers. */
  diskHeld: boolean;
  /** PLANS.md `## Planned` or BUGS.md `## Open` non-empty, read once per poll by the poll body. */
  workBacklogOpen: boolean;
  /** PLANS.md already holds the plan role's eligible-plan target (planBacklogFull). */
  planBacklogFull: boolean;
  /** Per-role deferred-due memory (one-shot run_deferred events), advanced in place. */
  deferredDue: Map<string, boolean>;
  workMergedSince: WorkMergedCache;
}

/** A base role's compiled claim group (part 4/7, per-base, computed once per poll). */
interface ClaimGroup {
  eligible: EligibleEntry[];
  eligibleKeys: Set<string>;
  held: Set<string>;
  /** A group whose runner is mid-entry with no recorded claim holds the whole group's
   * assignment until that runner settles (see buildSchedulingScope). */
  hold: boolean;
}

/** One poll's shared scheduling state: the pass metadata and the once-per-poll precompute the
 * per-runner loop reads — and the mutable admission state the loop advances in place. */
export interface SchedulingScope {
  root: string;
  runners: readonly RoleRunner[];
  once: OnceRound;
  now: number;
  mainHead: string;
  userPaused: boolean;
  quietNow: boolean;
  pausedRoles: ReadonlySet<string>;
  capPaused: ReadonlySet<string>;
  bootstrapHeld: ReadonlySet<string>;
  maintenanceQuota: MaintenanceQuotaVerdict;
  budgetPausedRoles: ReadonlySet<string>;
  probeRoles: ReadonlySet<string>;
  reviewStrongPaused: boolean;
  roleQuietHeld: ReadonlySet<string>;
  heldProviders: ReadonlySet<string | undefined>;
  windowHeldProviders: ReadonlySet<string | undefined>;
  reviewHeld: boolean;
  roleProviders: ReadonlyMap<string, string | undefined>;
  openBugsNow: boolean;
  workBacklogOpen: boolean;
  planBacklogFull: boolean;
  holdForRestart: boolean;
  diskHeld: boolean;
  deferredDue: Map<string, boolean>;
  workMergedSince: WorkMergedCache;
  queuedRoles: Set<string>;
  pinnedDirector: boolean;
  claimGroups: Map<string, ClaimGroup>;
  /** Runs writing code per multi-runner base role, advanced in place by the loop. */
  writing: Map<string, number>;
  ownsOutstanding: (r: RoleRunner) => boolean;
  ordered: RoleRunner[];
  eligibleMemo: Map<string, EligibleEntry[]>;
  reasons: Map<RoleRunner, string | undefined>;
  /** The one-poll maintenance admission budget, advanced in place by the loop. */
  quotaAdmitted: number;
  budgetHolds: (role: string) => boolean;
  operatorPauseBlocks: (role: string) => boolean;
  bootstrapHeldNow: (runner: RoleRunner, demand: boolean) => boolean;
  maintenanceQuotaOverLine: (runner: RoleRunner, demand: boolean) => boolean;
}

/** Record why the poll skipped a due role on its state (RunnerState.skipReason), saving only when
 * the value changes: a skipped role gets no run to save its own state, and a role that stays
 * skipped must not rewrite its file every poll. */
export function noteSkip(root: string, runner: RoleRunner, reason: SkipReason | undefined): void {
  if (runner.state.skipReason === reason) return;
  runner.state.skipReason = reason;
  saveRunnerStateBestEffort(root, runner.state);
}

/** Compute the once-per-poll precompute the scheduling pass's per-runner loop reads. Has the
 * same side effects the poll body's own precompute had: the merge-queue snapshot, the
 * hasUnmergedPin director pin, the per-base claim-group build (with its claim-release loop,
 * which mutates runner state, persists and logs), and the writing count. */
export async function buildSchedulingScope(ctx: SchedulingPassCtx): Promise<SchedulingScope> {
  const {
    root,
    runners,
    once,
    now,
    mainHead,
    userPaused,
    quietNow,
    pausedRoles,
    capPaused,
    maintenanceQuota,
    bootstrapHeld,
    budgetPausedRoles,
    probeRoles,
    reviewStrongPaused,
    roleQuietHeld,
    heldProviders,
    windowHeldProviders,
    reviewHeld,
    roleProviders,
    openBugsNow,
    workBacklogOpen,
    planBacklogFull,
    holdForRestart,
    diskHeld,
    deferredDue,
    workMergedSince,
  } = ctx;
  // Merge-queue interlock data, listed ONCE per poll (was once per runner per poll — each
  // queuedMergeFiles() re-lists the merge-queue directory and re-stats every queued entry): the
  // check below only asks whether the runner's role has a queued entry. The queue changes
  // only when a merge completes or a run enqueues — both asynchronous events this pass
  // observes on its next poll — so one snapshot is as fresh as per-runner reads, and a
  // merge that completes mid-pass just keeps its role blocked one extra poll (conservative).
  const queuedRoles = queuedMergeRoles(root);
  // The director's kept merge pin (a non-terminal merge failure kept it): due on its own min-run
  // clock, since its only other run is an operator prompt. A queued or in-flight pin is the
  // merge-queue interlock's to hold, so the leftover reason is not offered then.
  const pinnedDirector = !queuedRoles.has(DIRECTOR_ROLE) && (await hasUnmergedPin(root, DIRECTOR_ROLE));
  // Parallel work instances (plans/parallel-work-instances.md "Claims", part 4/7): a base role
  // with more than one runner assigns each due instance a distinct eligible entry, and releases
  // the claims whose entry left, turned ineligible, was disabled or went stale. Computed once
  // per poll and only for a multi-runner base, so a single-runner team is unchanged. The
  // release runs before assignment so a freed key counts as free below.
  const claimGroups = new Map<string, ClaimGroup>();
  const baseCounts = new Map<string, number>();
  for (const runner of runners) {
    const base = baseRoleOf(runner.role);
    increment(baseCounts, base);
  }
  for (const [base, count] of baseCounts) {
    if (count <= 1) continue;
    const groupRunners = runners.filter((r) => baseRoleOf(r.role) === base);
    const eligible = eligibleEntries(root, base);
    const eligibleKeys = new Set(eligible.map((e) => e.key));
    const listed = listedKeys(root, base);
    // A group whose runner is mid-entry with no recorded claim (it took the entry while it was
    // the only runner, before a live reload raised `instances`) cannot be told WHICH entry that
    // is from state alone. Assigning a free entry to a sibling could then hand it the same
    // work: hold the whole group's assignment until that runner settles (merges, drops or goes
    // idle), at which point its own staging may have recorded a claim. A busy runner that DOES
    // hold a claim is fine — `held` excludes its key and siblings take other entries.
    let hold = false;
    for (const r of groupRunners) {
      const busy =
        r.state.running ||
        queuedRoles.has(r.role) ||
        hasOutstandingWork(r.state);
      if (r.state.claim === undefined && busy) hold = true;
      const released = claimReleaseReason(r, {
        listedKeys: listed,
        eligibleKeys,
        now,
        hasQueuedMerge: queuedRoles.has(r.role),
        // Per instance, not per base role: a lowered `instances` leaves the surplus runner in
        // place with `runnerEnabled` false, and its idle claim must be released so a sibling can
        // take the entry instead of the key staying held until the 24h stale sweep.
        enabled: runnerEnabled(r.config, r.role),
        // Only this instance paused (not its whole role; instance 1 under `<role>-1`): a sibling
        // can take the entry. With the base role paused no sibling runs, so the claim stays.
        paused: runnerPaused(pausedRoles, r.role) && !pausedRoles.has(base),
      });
      if (released === null) continue;
      const title = r.state.claim?.title ?? "";
      r.state.claim = undefined;
      // Persist the release: an idle extra instance gets no run to save its state, so the dead
      // claim would stay on disk for status/doctor to show and for a restart to release again.
      saveRunnerStateBestEffort(root, r.state);
      const reason: ClaimReleaseReason = released;
      logEventBestEffort(root, { source: r.role, type: "claim", action: "released", title, reason });
      if (reason === "stale") {
        warnEventBestEffort(
          root,
          r.role,
          `released "${title}", which a stopped instance was working on (idle ${Math.round(CLAIM_IDLE_MAX_MS / 3_600_000)}h)`,
        );
      }
    }
    claimGroups.set(base, {
      eligible,
      eligibleKeys,
      held: heldKeys(groupRunners, eligibleKeys, listed),
      hold,
    });
  }
  // The team gates' block predicate (the director exempt — an explicit human prompt
  // outranks any autonomous gate, quiet hours included): the once-mode settle below and
  // the start gate must agree on exactly when a team gate holds, so the compound lives
  // here once. Quiet hours fold in beside the operator pause and the budget gate — the
  // schedule is not probe-worthy the way a paused budget is, so no probeDue exception.
  // The per-role windows (quietHoursPerRole) fold in beside the team one as a fourth
  // disjunct — a role held by either window (or both, held once) starts no new runs;
  // the director stays exempt by the same role check that covers the other disjuncts.
  // The budget hold, per role (part 5c/8): a tier that resolved to pause holds its own roles,
  // and — with review on — an unresolvable strong tier holds every role (nothing could merge).
  // The probe of a demoted pair pierces the hold for EXACTLY the probed pair's tier's roles:
  // the earlier draft's pair-blind pierce lifted the pause team-wide on any due probe.
  // Quiet hours fold in beside the operator pause — the schedule is not probe-worthy the way a
  // paused budget is.
  const budgetHolds = (role: string): boolean =>
    (reviewStrongPaused || budgetPausedRoles.has(role)) && !probeRoles.has(role);
  const operatorPauseBlocks = (role: string): boolean =>
    (userPaused || quietNow || roleQuietHeld.has(role) || budgetHolds(role)) &&
    role !== DIRECTOR_ROLE;
  // Fresh operator demand: a queued prompt or a wake newer than the role's last run end. The
  // same override the need-based deferral honors (an explicit "try again now" is not idle
  // maintenance); shared by the bootstrap and maintenance-allowance holds so the two cannot
  // drift on what counts as demand. Computed ONCE per runner per poll (the scheduling loop's
  // per-runner `demand`), so a role's queue is listed a single time a poll instead of once per
  // hold check; every consumer takes the boolean rather than re-calling inboxSize.
  // The new-project bootstrap hold (part 2/2): held unless the role has a fresh operator wake
  // or a queued prompt.
  const bootstrapHeldNow = (runner: RoleRunner, demand: boolean): boolean =>
    bootstrapHeld.has(runner.role) && !demand;
  // The maintenance allowance's team-level hold (part 1b/4): `used` has reached `allowance`,
  // so no maintenance role starts unless it carries demand (`tumwater wake <maintenance-role>`
  // gets exactly one run). The per-poll admission headroom is spent separately, after each
  // role's due check, where the pass knows what actually runs; the verdict alone cannot.
  const maintenanceQuotaOverLine = (runner: RoleRunner, demand: boolean): boolean =>
    commitTier(baseRoleOf(runner.role)) === "maintenance" &&
    maintenanceQuota.used >= maintenanceQuota.allowance &&
    !demand;
  // Runs writing code per multi-runner base role (plans/fast-merge.md "Lever 1"): a runner in
  // flight, not one whose change waits in the merge queue. `instances` limits this count, so the
  // role's extra runner ids start work only while fewer than `instances` are running; admissions
  // this poll count at once, so one pass cannot overshoot.
  const writing = new Map<string, number>();
  for (const r of runners) {
    if (claimGroups.has(baseRoleOf(r.role)) && r.state.running && !queuedRoles.has(r.role)) {
      increment(writing, baseRoleOf(r.role));
    }
  }
  // Admission order: a runner of a multi-runner base with a pending revision or conflict
  // hand-back comes first (its change came back; it holds no new claim), then the rest in runner
  // order, so the lowest-index free runner takes new work. Other roles keep their place.
  const ownsOutstanding = (r: RoleRunner): boolean =>
    claimGroups.has(baseRoleOf(r.role)) && hasOutstandingWork(r.state);
  const ordered = [
    ...runners.filter((r) => ownsOutstanding(r)),
    ...runners.filter((r) => !ownsOutstanding(r)),
  ];
  // The stand-down's eligible lists per base role, read at most once per poll (see the check
  // below).
  const eligibleMemo = new Map<string, EligibleEntry[]>();
  return {
    root,
    runners,
    once,
    now,
    mainHead,
    userPaused,
    quietNow,
    pausedRoles,
    capPaused,
    maintenanceQuota,
    bootstrapHeld,
    budgetPausedRoles,
    probeRoles,
    reviewStrongPaused,
    roleQuietHeld,
    heldProviders,
    windowHeldProviders,
    reviewHeld,
    roleProviders,
    openBugsNow,
    workBacklogOpen,
    planBacklogFull,
    holdForRestart,
    diskHeld,
    deferredDue,
    workMergedSince,
    queuedRoles,
    pinnedDirector,
    claimGroups,
    writing,
    ownsOutstanding,
    ordered,
    eligibleMemo,
    reasons: new Map<RoleRunner, string | undefined>(),
    quotaAdmitted: 0,
    budgetHolds,
    operatorPauseBlocks,
    bootstrapHeldNow,
    maintenanceQuotaOverLine,
  };
}
