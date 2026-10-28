/** The per-runner skip decision of the scheduling pass (pollRunnerReasons), lifted out of
 * orchestrator-scheduling.ts so the WHY-due policy reads on its own screen: every gate that
 * decides a runner is due or skipped, and the once/deferral bookkeeping that travels with
 * them. Part 2/3 of the pollRunnerReasons split; reads the shared pass context and admission
 * state from scheduling-scope.ts's SchedulingScope. Part 3/3 lifts the admit tail
 * (scheduling-admit.ts) that follows a skip:false verdict. */
import type { RoleRunner } from "../runner/runner.js";
import { logEventBestEffort } from "../events/events.js";
import { baseRoleOf, configuredInstances, runnerPaused } from "../roles/runner-ids.js";
import { BUGFIX_ROLE, DIRECTOR_ROLE, commitTier } from "../roles/roles.js";
import { isAfterMergeRole } from "../review/post-merge-review.js";
import { deferRunReason, isEligible, type DeferReason } from "../scheduling/scheduling.js";
import { inboxSize } from "../inbox/inbox.js";
import { freshlyWoken } from "../runner/runner-state.js";
import { MERGE_CONFLICT_LIMIT } from "../runner/runner-leftover.js";
import { noteSkip, type SchedulingScope } from "./scheduling-scope.js";

/** A runner's skip verdict under the per-runner gates: `skip: true` when a gate declined the
 * run (its once/deferral/noteSkip bookkeeping already happened), or `skip: false` with the
 * reason the isEligible check returned, which the caller's admit tail starts a run from. */
type SkipVerdict =
  | { skip: true }
  | { skip: false; reason: string };

/** Decide whether this runner is due this poll, running every skip gate and the once/deferral
 * bookkeeping against scheduling-scope.ts's scope. Returns skip:true when a gate declined the
 * run, and skip:false with the due reason otherwise (the admit tail in scheduling-admit.ts
 * consumes the reason). Mutates the shared scope —
 * deferredDue, quotaAdmitted, once-mode settlement — and writes skip reasons as its only
 * side effects. */
export async function skipRunner(scope: SchedulingScope, runner: RoleRunner): Promise<SkipVerdict> {
  const {
    root,
    once,
    now,
    mainHead,
    pausedRoles,
    capPaused,
    holdForRestart,
    diskHeld,
    windowHeldProviders,
    roleProviders,
    reviewHeld,
    afterMergeRoles,
    heldProviders,
    openBugsNow,
    workBacklogOpen,
    planBacklogFull,
    deferredDue,
    workMergedSince,
    queuedRoles,
    interlockedHold,
    pinnedDirector,
    claimGroups,
    writing,
    maintenanceQuota,
    maintenanceQuotaOverLine,
    bootstrapHeldNow,
    operatorPauseBlocks,
  } = scope;
  // The role's inbox size and operator demand, computed once per runner per poll: every
  // consumer below (the holds, isEligible's inbox count, the maintenance admission) shares
  // this one directory listing + per-file stat read instead of each re-scanning the queue.
  // The queue is append-only while this pass runs (nothing dequeues until launch, after the
  // pass), so one read per runner is stable, and `now` here matches the poll's own clock.
  const inboxCount = inboxSize(root, runner.role);
  const demand = inboxCount > 0 || freshlyWoken(runner.state);
  // Once mode: a paused role gets no run this round and must be reported as skipped,
  // so it settles here — before the gates that would otherwise skip it silently (a
  // once round has to end even when a pause marker is left over; a later resume within
  // the same round cannot un-settle it, which is the at-most-one-run contract).
  if (
    once.active &&
    !once.isSettled(runner) &&
    !runner.state.running &&
    (runnerPaused(pausedRoles, runner.role) ||
      capPaused.has(runner.role) ||
      maintenanceQuotaOverLine(runner, demand) ||
      bootstrapHeldNow(runner, demand) ||
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
  if (once.active && !runner.state.running && once.isSettled(runner)) return { skip: true };
  if (holdForRestart || diskHeld)
    return { skip: true }; // a restart or a low disk is pending: nothing new starts, on any role
  // The per-role pause gates BEFORE the team check and exempts nothing — the director
  // included (the operator named that one role deliberately).
  if (runnerPaused(pausedRoles, runner.role)) return { skip: true };
  // The role's own daily cost cap (src/gates/role-cap-gates.ts): no start-gate change — a
  // parked waiter finishes (in-flight runs finish, NEW runs are gated at scheduling,
  // exactly like every per-role pause), and there is no fallback-probe exception: the
  // stop is about spend, and probing it adds noise, not signal. The lift is a live
  // config edit or local midnight — no marker exists for `resume --role` to touch.
  if (capPaused.has(runner.role)) return { skip: true };
  // The maintenance allowance (plans/work-ratio.md, part 1b/4): no new maintenance run while
  // the rolling 24 h window is over its line. A fresh operator wake or a queued prompt admits
  // one anyway (maintenanceQuotaOverLine), the same demand override the bootstrap hold honors.
  if (maintenanceQuotaOverLine(runner, demand)) return { skip: true };
  // The new-project bootstrap (part 2/2): no new maintenance runs until the plan target is
  // met; a fresh wake or queued prompt admits one anyway (bootstrapHeldNow).
  if (bootstrapHeldNow(runner, demand)) return { skip: true };
  if (operatorPauseBlocks(runner.role))
    return { skip: true }; // no new role runs while either gate holds
  // The director honors only the subscription-window hold: the per-run 429 retry that backs
  // its other exemptions does not answer a window rejection, so its prompt would fail and
  // re-queue every poll until the repeated-failure pause stops it.
  if (runner.role === DIRECTOR_ROLE && windowHeldProviders.has(roleProviders.get(runner.role)))
    return { skip: true };
  if (
    runner.role !== DIRECTOR_ROLE &&
    (heldProviders.has(roleProviders.get(runner.role)) ||
      (reviewHeld && !afterMergeRoles.has(baseRoleOf(runner.role))))
  )
    return { skip: true }; // nor while ITS provider's failure storm holds — or the reviewer's, which a pre-merge review gates (a review.afterMerge role is exempt)
  // The role's OWN queue decides inbox due-ness: the director counts its historical
  // inbox, every other role its per-role queue (tumwater prompt --role <id>) — so a
  // queued prompt makes its role due by itself, no wake marker needed (isEligible).
  const { run, reason, skip } = isEligible(runner, now, mainHead, inboxCount, {
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
    // Thread a gate-specific skip through (e.g. the yield-stretched gap) so a runner the
    // poll declined and will keep declining does not read as "due — starts on the next
    // poll"; stays undefined for every ordinary not-due path.
    noteSkip(root, runner, skip);
    return { skip: true };
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
  // Interlock relief (parts 1-3/4): a post-merge-review role (its own config `review.afterMerge`
  // names it) with a queued change is held only while it is in a non-admissible stage — the
  // pre-approval/conflict/branch-ahead holds buildSchedulingScope put in `interlockedHold` — and
  // otherwise falls through to author (the merge no longer parks it). A pre-merge-review role,
  // and a post-merge role still in a held stage, keep the full interlock: their rejection must
  // reach the runner before it authors again.
  if (queuedRoles.has(runner.role)) {
    if (!isAfterMergeRole(runner.config, runner.role) || interlockedHold.has(runner.role)) {
      noteSkip(root, runner, undefined);
      return { skip: true };
    }
  }
  // The role's `instances` limit on concurrent runs: a multi-runner base admits a runner only
  // while fewer than `instances` of its runners are running. A parked runner (queued change)
  // was skipped by the interlock above and holds no place.
  const writingBase = baseRoleOf(runner.role);
  if (claimGroups.has(writingBase) && !runner.state.running) {
    if ((writing.get(writingBase) ?? 0) >= configuredInstances(runner.config, runner.role)) {
      noteSkip(root, runner, "instances-full");
      return { skip: true };
    }
  }
  // Need-based deferral: a due maintenance run (scheduled or main-moved wake) whose last
  // run did nothing stays deferred while the feature/bugfix backlog is open or no new
  // work has merged to react to — nextRunAt is left untouched, so it re-checks every poll
  // until the backlog drains and qualifying work merges. Resume wakes precede this check in
  // isEligible, the director's "inbox" reason skips it, work roles are not in
  // DEFERRABLE_ROLES (bugfix is the exception while its backlog is empty — deferRun), and
  // a fresh operator wake overrides it (deferRun's woken check — an explicit "try again
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
    const deferral: DeferReason | null = deferRunReason(
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
      return { skip: true };
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
  if (commitTier(baseRoleOf(runner.role)) === "maintenance" && !demand) {
    if (scope.quotaAdmitted >= maintenanceQuota.allowance - maintenanceQuota.used) {
      noteSkip(root, runner, "maintenance-due-cap");
      return { skip: true };
    }
    scope.quotaAdmitted++;
  }
  return { skip: false, reason: reason as string };
}
