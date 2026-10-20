// vocabulary: plain
/** The poll loop's per-runner scheduling pass (src/orchestrator/orchestrator.ts): decide, for each
 * runner, whether this poll admits a run and why — the pause/quiet/cost-cap/failure-hold
 * gates, the merge-queue interlock, need-based deferral, and once-mode settlement —
 * producing the reasons map orchestrator-launch.ts's launchDueRuns starts runs from.
 * Split out of runOrchestrator's poll body so the WHY-due policy reads on its own screen;
 * orchestrator-poll.ts keeps the poll's other passes (config reload, markers, gates, redeploy,
 * merge drain) and the launch call itself. */
import { increment } from "../collections.js";
import type { TumwaterConfig } from "../config/config-schema.js";
import { reviewRunConfig, roleSeamTier, seamHoldKey } from "../config/config-views.js";
import { openBugs } from "../backlog/backlog.js";
import { fallbackProbeDuePair } from "../budget/fallback-breaker.js";
import { modelPairName } from "../budget/budget.js";
import type { pollTeamGates, TeamGateStates } from "../gates/gate-polls.js";
import type { RoleRunner } from "../runner/runner.js";
import type { OnceRound } from "../scheduling/once-round.js";
import type { WorkMergedCache } from "../scheduling/work-merged-cache.js";
import { deferTickReason, isEligible, type DeferReason } from "../scheduling/scheduling.js";
import { BUGFIX_ROLE, DIRECTOR_ROLE, commitTier } from "../roles/roles.js";
import type { MaintenanceQuotaVerdict } from "../gates/maintenance-quota.js";
import { baseRoleOf, configuredInstances, instanceIndex, runnerEnabled, runnerPaused } from "../roles/runner-ids.js";
import { freshlyWoken, hasOutstandingWork, saveRunnerState, type SkipReason } from "../runner/runner-state.js";
import { inboxSize } from "../inbox/inbox.js";
import { queuedMergeRoles } from "../merge/merge-queue.js";
import { hasUnmergedPin, MERGE_CONFLICT_LIMIT } from "../runner/leftover.js";
import { logEventBestEffort, warnEventBestEffort } from "../events/events.js";
import { type EligibleEntry, eligibleEntries } from "../backlog/backlog-eligibility.js";
import {
  CLAIM_IDLE_MAX_MS,
  assignNext,
  claimReleaseReason,
  planBacklogFull,
  heldKeys,
  listedKeys,
  type ClaimReleaseReason,
} from "../scheduling/claims.js";

/** One poll's gate verdicts and context, exactly the local view the poll body holds when
 * the scheduling pass runs (TeamGatePoll's fields beside the pass's own inputs). */
interface SchedulingPassCtx {
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

/** Record why the poll skipped a due role on its state (RunnerState.skipReason), saving only when
 * the value changes: a skipped role gets no run to save its own state, and a role that stays
 * skipped must not rewrite its file every poll. */
function noteSkip(root: string, runner: RoleRunner, reason: SkipReason | undefined): void {
  if (runner.state.skipReason === reason) return;
  runner.state.skipReason = reason;
  saveRunnerState(root, runner.state);
}

/** Decide which runners are due this poll. Mutates `deferredDue` (and once-mode settlement)
 * as its only side effects; returns the reason per admitted runner. */
export async function pollRunnerReasons(
  ctx: SchedulingPassCtx,
): Promise<Map<RoleRunner, string | undefined>> {
  const {
    root,
    runners,
    once,
    now,
    mainHead,
    userPaused,
    quietNow,
    pausedRoles: pausedRolesSet,
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
  const reasons = new Map<RoleRunner, string | undefined>();
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
  const claimGroups = new Map<
    string,
    { eligible: EligibleEntry[]; eligibleKeys: Set<string>; held: Set<string>; hold: boolean }
  >();
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
        paused: runnerPaused(pausedRolesSet, r.role) && !pausedRolesSet.has(base),
      });
      if (released === null) continue;
      const title = r.state.claim?.title ?? "";
      r.state.claim = undefined;
      // Persist the release: an idle extra instance gets no run to save its state, so the dead
      // claim would stay on disk for status/doctor to show and for a restart to release again.
      saveRunnerState(root, r.state);
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
  // drift on what counts as demand.
  const hasDemand = (runner: RoleRunner): boolean =>
    inboxSize(root, runner.role) > 0 || freshlyWoken(runner.state);
  // The new-project bootstrap hold (part 2/2): held unless the role has a fresh operator wake
  // or a queued prompt.
  const bootstrapHeldNow = (runner: RoleRunner): boolean =>
    bootstrapHeld.has(runner.role) && !hasDemand(runner);
  // The maintenance allowance's team-level hold (part 1b/4): `used` has reached `allowance`,
  // so no maintenance role starts unless it carries demand (`tumwater wake <maintenance-role>`
  // gets exactly one run). The per-poll admission headroom is spent separately, after each
  // role's due check, where the pass knows what actually runs; the verdict alone cannot.
  const maintenanceQuotaOverLine = (runner: RoleRunner): boolean =>
    commitTier(baseRoleOf(runner.role)) === "maintenance" &&
    maintenanceQuota.used >= maintenanceQuota.allowance &&
    !hasDemand(runner);
  // The one-poll admission budget: each due maintenance role this pass admits spends one of
  // the remaining `allowance - used` slots, reset every pass, so two due maintenance roles
  // cannot start in the same poll and overshoot the allowance.
  let maintenanceQuotaAdmitted = 0;
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
  for (const runner of ordered) {
    // Once mode: a paused role gets no run this round and must be reported as skipped,
    // so it settles here — before the gates that would otherwise skip it silently (a
    // once round has to end even when a pause marker is left over; a later resume within
    // the same round cannot un-settle it, which is the at-most-one-run contract).
    if (
      once.active &&
      !once.isSettled(runner) &&
      !runner.state.running &&
      (runnerPaused(pausedRolesSet, runner.role) ||
        capPaused.has(runner.role) ||
        maintenanceQuotaOverLine(runner) ||
        bootstrapHeldNow(runner) ||
        operatorPauseBlocks(runner.role))
    ) {
      once.settle(runner.role, "paused");
    }
    // Once mode's at-most-one-run contract (src/scheduling/once-round.ts): a role that already had
    // its run — or was settled with a skip reason — runs nothing further this round, even
    // when its backoff has expired or the clock override would admit it again. Without this
    // gate the one-run guarantee held only for deferrable built-ins (their deferral
    // settles them); a custom role or work role with a short backoff re-qualified every
    // poll and the round never ended.
    if (once.active && !runner.state.running && once.isSettled(runner)) continue;
    if (holdForRestart || diskHeld)
      continue; // a restart or a low disk is pending: nothing new starts, on any role
    // The per-role pause gates BEFORE the team check and exempts nothing — the director
    // included (the operator named that one role deliberately).
    if (runnerPaused(pausedRolesSet, runner.role)) continue;
    // The role's own daily cost cap (src/gates/role-cap-gates.ts): no start-gate change — a
    // parked waiter finishes (in-flight runs finish, NEW runs are gated at scheduling,
    // exactly like every per-role pause), and there is no fallback-probe exception: the
    // stop is about spend, and probing it adds noise, not signal. The lift is a live
    // config edit or local midnight — no marker exists for `resume --role` to touch.
    if (capPaused.has(runner.role)) continue;
    // The maintenance allowance (plans/work-ratio.md, part 1b/4): no new maintenance run while
    // the rolling 24 h window is over its line. A fresh operator wake or a queued prompt admits
    // one anyway (maintenanceQuotaOverLine), the same demand override the bootstrap hold honors.
    if (maintenanceQuotaOverLine(runner)) continue;
    // The new-project bootstrap (part 2/2): no new maintenance runs until the plan target is
    // met; a fresh wake or queued prompt admits one anyway (bootstrapHeldNow).
    if (bootstrapHeldNow(runner)) continue;
    if (operatorPauseBlocks(runner.role))
      continue; // no new role runs while either gate holds
    // The director honors only the subscription-window hold: the per-run 429 retry that backs
    // its other exemptions does not answer a window rejection, so its prompt would fail and
    // re-queue every poll until the repeated-failure pause stops it.
    if (runner.role === DIRECTOR_ROLE && windowHeldProviders.has(roleProviders.get(runner.role)))
      continue;
    if (
      runner.role !== DIRECTOR_ROLE &&
      (reviewHeld || heldProviders.has(roleProviders.get(runner.role)))
    )
      continue; // nor while ITS provider's failure storm holds — or the reviewer's (nothing could merge)
    // The role's OWN queue decides inbox due-ness: the director counts its historical
    // inbox, every other role its per-role queue (tumwater prompt --role <id>) — so a
    // queued prompt makes its role due by itself, no wake marker needed (isEligible).
    const { run, reason } = isEligible(runner, now, mainHead, inboxSize(root, runner.role), {
      once: once.active,
      planBacklogOpen: !planBacklogFull,
      // A pin at the conflict cap whose lineage is not yet handed back is owed an authoring run
      // (the promptless path would skip it unchanged every poll), so only a prompt makes it due.
      leftoverPending:
        pinnedDirector &&
        !(
          (runner.state.mergeConflicts?.count ?? 0) >= MERGE_CONFLICT_LIMIT &&
          runner.state.conflictHandback === undefined
        ),
    });
    if (!run) {
      // Not due this poll: any deferral episode has ended (or never started). No event —
      // the run's own events cover it.
      if (deferredDue.get(runner.role)) deferredDue.set(runner.role, false);
      // Once mode: idle and not due — settleSkipped records the skip reason (the caller's
      // summary reports it).
      if (once.active && !runner.state.running) once.settleSkipped(runner);
      noteSkip(root, runner, undefined);
      continue;
    }
    // Merge queue 3/5 interlock (invariant 3): a role with a QUEUED or IN-FLIGHT merge never
    // starts a run — the entry stays in the queue until its merge completes, so one check
    // covers both. Uniform over every role, director included: its prompt is not finished until it
    // merges. Placed before the need-based deferral block on purpose — no episode bookkeeping is
    // needed (the run that queued the merge finished, which closed any deferral episode; its
    // `queued` can leave a prior no_change in lastResult — runner-state.ts records only completed
    // results — but the merge's outcome replaces it before the interlock lets the role back into
    // this pass), and skipping here saves that branch's workMergedSince git-range query for the
    // skipped role.
    if (queuedRoles.has(runner.role)) {
      noteSkip(root, runner, undefined);
      continue;
    }
    // The role's `instances` limit on concurrent runs: a multi-runner base admits a runner only
    // while fewer than `instances` of its runners are running. A parked runner (queued change)
    // was skipped by the interlock above and holds no place.
    const writingBase = baseRoleOf(runner.role);
    if (claimGroups.has(writingBase) && !runner.state.running) {
      if ((writing.get(writingBase) ?? 0) >= configuredInstances(runner.config, runner.role)) {
        noteSkip(root, runner, undefined);
        continue;
      }
    }
    // Need-based deferral: a due maintenance run (scheduled or main-moved wake) whose last
    // run did nothing stays deferred while the feature/bugfix backlog is open or no new
    // work has merged to react to — nextRunAt is left untouched, so it re-checks every poll
    // until the backlog drains and qualifying work merges. Resume wakes precede this check in
    // isEligible, the director's "inbox" reason skips it, work roles are not in
    // DEFERRABLE_ROLES (bugfix is the exception while its backlog is empty — deferTick), and
    // a fresh operator wake overrides it (deferTick's woken check — an explicit "try again
    // now" is a demand, not idle maintenance). Sitting before reasons.set also keeps a
    // deferred role out of the wake-event pass below.
    if (reason === "scheduled" || reason === "main moved") {
      const s = runner.state;
      // The git range is only consulted when the other conditions already hold — a
      // never-run role, or one with pending business, runs without paying for it, and an
      // open backlog defers regardless of what merged. bugfix in search mode is the
      // exception: its deferral keys on the work-merged verdict alone, so the backlog-open
      // shortcut must not stand in for the query.
      const searchBugfix = baseRoleOf(runner.role) === BUGFIX_ROLE && !openBugsNow;
      const merged =
        (!workBacklogOpen || searchBugfix) && s.lastMainHead !== ""
          ? await workMergedSince.since(s.lastMainHead, mainHead)
          : true;
      const deferral: DeferReason | null = deferTickReason(
        s,
        runner.role,
        merged,
        workBacklogOpen,
        openBugsNow,
        now,
        planBacklogFull,
      );
      const deferredNow = deferral !== null;
      if (deferredNow !== (deferredDue.get(runner.role) ?? false)) {
        if (deferral)
          logEventBestEffort(root, { source: runner.role, type: "run_deferred", reason: deferral });
        deferredDue.set(runner.role, deferredNow);
      }
      if (deferredNow) {
        // Once mode: a maintenance run that deferred itself — its once-round
        // answer, so it settles instead of holding the round open for DEFER_MAX_MS.
        if (once.active) once.settle(runner.role, "deferred");
        noteSkip(
          root,
          runner,
          deferral === "backlog"
            ? "deferred-backlog"
            : deferral === "plans-full"
              ? "deferred-plans-full"
              : "deferred-no-work",
        );
        continue;
      }
    } else if (deferredDue.get(runner.role)) {
      deferredDue.set(runner.role, false); // an inbox/resume run ends the episode
    }
    // The allowance's in-flight admission (plans/work-ratio.md, part 1b/4): `used` counts the
    // maintenance roles already in flight, so a due maintenance run admitted here spends one
    // of the remaining `allowance - used` slots. This must sit after the due check — the pure
    // verdict cannot know which roles will be eligible this poll, so the reservation lives in
    // the pass that does; without it two due maintenance roles start in the same poll. Demand
    // spends no slot: it is an explicit operator request, not idle maintenance.
    if (commitTier(baseRoleOf(runner.role)) === "maintenance" && !hasDemand(runner)) {
      if (maintenanceQuotaAdmitted >= maintenanceQuota.allowance - maintenanceQuota.used) {
        noteSkip(root, runner, undefined);
        continue;
      }
      maintenanceQuotaAdmitted++;
    }
    // Parallel work instances (part 4/7): a multi-runner base role's claim assignment, after
    // every gate has admitted this runner. A runner that already holds a claim proceeds — its
    // revision, resume or retry is the same entry. An unclaimed runner with outstanding work
    // (a revision) is the mid-entry runner the group hold waits on: it proceeds unassigned —
    // holding it too would deadlock the whole group, since only its run can settle the hold.
    // Otherwise, when the run is not an inbox/resume run, it takes the first free entry; an
    // extra instance with none free is skipped without touching its backoff, and the primary
    // runs unassigned only while some eligible entry exists (all of them held by siblings).
    // Stand-down: the feature charter says "If PLANS.md is empty or everything is done, there is
    // nothing to do" and the bugfix charter says "when every open entry carries [a Refused note],
    // there is nothing to do", so a feature runner (primary included) with no eligible plan at all,
    // or a bugfix runner whose open bugs are all held (no open bugs at all is search mode, which
    // still runs), skips its scheduled and main-moved runs instead of paying a model run that
    // can only end in
    // nothing-to-do. Startup, inbox and resume runs, a fresh operator wake, and a runner with a
    // claim or outstanding work still run. nextRunAt and backoff stay put, so the first poll
    // after a plan turns eligible starts a run for it.
    const standDownBase = baseRoleOf(runner.role);
    if (
      (standDownBase === "feature" || (standDownBase === BUGFIX_ROLE && openBugsNow)) &&
      (reason === "scheduled" || reason === "main moved") &&
      !freshlyWoken(runner.state) &&
      runner.state.claim === undefined &&
      !hasOutstandingWork(runner.state)
    ) {
      let eligible = eligibleMemo.get(standDownBase);
      if (eligible === undefined) {
        eligible = claimGroups.get(standDownBase)?.eligible ?? eligibleEntries(root, standDownBase);
        eligibleMemo.set(standDownBase, eligible);
      }
      if (eligible.length === 0) {
        noteSkip(root, runner, "no-free-entry");
        runner.state.heldElsewhere = undefined;
        if (once.active) once.settle(runner.role, "no free entry");
        continue;
      }
    }
    const claimGroup = claimGroups.get(baseRoleOf(runner.role));
    if (claimGroup) {
      if (runner.state.claim) {
        // keeps its claim
      } else if (hasOutstandingWork(runner.state)) {
        // finishes its own unrecorded entry
      } else if (reason !== "inbox" && reason !== "resume") {
        // The group holds an unclaimed mid-entry sibling: assign nothing this poll, or a
        // sibling could be handed that same entry (the reported `feature-2`/`bugfix-2`
        // duplication). It resolves the moment the sibling settles.
        if (claimGroup.hold) {
          noteSkip(root, runner, "claim-hold");
          continue;
        }
        const free = claimGroup.eligible.filter((e) => !claimGroup.held.has(e.key));
        const pick = assignNext(free);
        // An unassigned runner is told which entries its siblings hold (cleared when none).
        const heldTitles = claimGroup.eligible.filter((e) => claimGroup.held.has(e.key)).map((e) => e.title);
        runner.state.heldElsewhere = !pick && heldTitles.length > 0 ? heldTitles : undefined;
        if (pick) {
          runner.state.claim = {
            file: baseRoleOf(runner.role) === BUGFIX_ROLE ? "BUGS.md" : "PLANS.md",
            key: pick.key,
            title: pick.title,
            at: now,
            source: "assigned",
          };
          claimGroup.held.add(pick.key);
          logEventBestEffort(root, {
            source: runner.role,
            type: "claim",
            action: "assigned",
            key: pick.key,
            title: pick.title,
          });
        } else if (instanceIndex(runner.role) >= 2) {
          noteSkip(root, runner, "no-free-entry");
          if (once.active) once.settle(runner.role, "no free entry");
          continue; // an idle extra instance: no run, no backoff climb
        }
      }
    } else {
      runner.state.heldElsewhere = undefined; // no claim group (e.g. instances lowered to 1)
    }
    noteSkip(root, runner, undefined);
    reasons.set(runner, reason);
    if (claimGroup && !runner.state.running) increment(writing, baseRoleOf(runner.role));
  }
  return reasons;
}

/** The team-hold key of the reviewer's seam, read from the config merges actually review under
 * (the poll's roleConfig, which a used-up claude window or the cap has moved to a fallback), so
 * a reviewer that left claude no longer holds the whole team on the claude hold. */
export function reviewHoldKey(roleConfig: TumwaterConfig): string | undefined {
  return seamHoldKey(reviewRunConfig(roleConfig));
}

/** The deferral inputs one poll computes for pollRunnerReasons and the launch pass. */
interface DeferralInputs {
  openBugsNow: boolean;
  workBacklogOpen: boolean;
  plansFull: boolean;
  probePair: string | null;
  probeRoles: Set<string>;
  reviewStrongPaused: boolean;
}

/** Backlog-aware deferral: while PLANS.md `## Planned` or BUGS.md `## Open` on main
 * holds an entry feature or bugfix may take (eligibleEntries), idle maintenance runs
 * stay deferred — queued feature/bugfix work outranks them regardless of what merged.
 * Stat-cached reads (backlog.ts): one stat per file per poll while the files are unchanged.
 * bugfix is not a maintenance role, but while BUGS.md `## Open` is empty it defers like
 * one (deferTick) — openBugsNow is that emptiness, read once here and reused for both
 * predicates. Also the demoted fallback's half-open window (part 5c/8): the pair whose probe
 * is due, and the roles whose model tier WOULD run on that pair absent the demotion (the
 * price-based resolution — the serving resolution has already dropped the pair, which is
 * exactly why it is being probed). Only those roles pierce the budget hold, and the launch
 * pass admits exactly one of them as the probe — a probe blind to the pair's tier would lift
 * the pause for every role, and a probe with no eligible runner must not hijack the poll's
 * other launches. The review-on strong pause (budgetGate): with the review gate on, an
 * unresolvable strong tier means nothing could merge, so EVERY role is held — the per-tier
 * pause set alone would let small/default roles author changes no reviewer could judge. The
 * probe of the strong pair pierces this hold for exactly the probed tier's roles too. */
export function pollDeferralInputs(
  root: string,
  runners: readonly RoleRunner[],
  liveConfig: TumwaterConfig,
  gateStates: TeamGateStates,
  gates: Pick<ReturnType<typeof pollTeamGates>, "priceResolved" | "servingResolved" | "budgetActive">,
  breakerNowMs: number,
): DeferralInputs {
  const openBugsNow = openBugs(root).length > 0;
  const workBacklogOpen = eligibleEntries(root, "feature").length > 0 || eligibleEntries(root, "bugfix").length > 0;
  const plansFull = planBacklogFull(root, liveConfig);
  const probePair = fallbackProbeDuePair(gateStates.budget.breakers, breakerNowMs);
  const probeRoles = new Set<string>();
  if (probePair !== null) {
    for (const r of runners) {
      if (r.role === DIRECTOR_ROLE) continue;
      const p = gates.priceResolved[roleSeamTier(liveConfig, r.role)].pair;
      if (p !== null && modelPairName(p) === probePair) probeRoles.add(r.role);
    }
  }
  const reviewStrongPaused =
    gates.budgetActive && liveConfig.review.enabled && gates.servingResolved.strong.pair === null;
  return { openBugsNow, workBacklogOpen, plansFull, probePair, probeRoles, reviewStrongPaused };
}
