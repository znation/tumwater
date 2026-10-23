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
import { deferRunReason, isEligible, type DeferReason } from "../scheduling/scheduling.js";
import { BUGFIX_ROLE, DIRECTOR_ROLE, commitTier } from "../roles/roles.js";
import { baseRoleOf, configuredInstances, instanceIndex, runnerPaused } from "../roles/runner-ids.js";
import { freshlyWoken, hasOutstandingWork } from "../runner/runner-state.js";
import { inboxSize } from "../inbox/inbox.js";
import { MERGE_CONFLICT_LIMIT } from "../runner/leftover.js";
import { logEventBestEffort } from "../events/events.js";
import { eligibleEntries } from "../backlog/backlog-eligibility.js";
import { assignNext, planBacklogFull } from "../scheduling/claims.js";
import {
  buildSchedulingScope,
  noteSkip,
  type SchedulingPassCtx,
  type SchedulingScope,
} from "./scheduling-scope.js";

/** Decide which runners are due this poll. Mutates `deferredDue` (and once-mode settlement)
 * as its only side effects; returns the reason per admitted runner. The once-per-poll
 * precompute lives on the scope scheduling-scope.ts's buildSchedulingScope builds (the
 * merge-queue snapshot, director pin, per-base claim groups, gate predicates and admission
 * state); this per-runner loop reads them all through it. */
export async function pollRunnerReasons(
  ctx: SchedulingPassCtx,
): Promise<Map<RoleRunner, string | undefined>> {
  const scope: SchedulingScope = await buildSchedulingScope(ctx);
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
    heldProviders,
    openBugsNow,
    workBacklogOpen,
    planBacklogFull,
    deferredDue,
    workMergedSince,
    queuedRoles,
    pinnedDirector,
    claimGroups,
    writing,
    eligibleMemo,
    reasons,
    maintenanceQuota,
    maintenanceQuotaOverLine,
    bootstrapHeldNow,
    operatorPauseBlocks,
    hasDemand,
  } = scope;
  for (const runner of scope.ordered) {
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
    if (runnerPaused(pausedRoles, runner.role)) continue;
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
    const { run, reason, skip } = isEligible(runner, now, mainHead, inboxSize(root, runner.role), {
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
        noteSkip(root, runner, "instances-full");
        continue;
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
      if (scope.quotaAdmitted >= maintenanceQuota.allowance - maintenanceQuota.used) {
        noteSkip(root, runner, "maintenance-due-cap");
        continue;
      }
      scope.quotaAdmitted++;
    }
    // Parallel work instances (part 4/7): a multi-runner base role's claim assignment, after
    // every gate has admitted this runner. A runner that already holds a claim proceeds — its
    // revision, resume or retry is the same entry. An unclaimed runner with outstanding work
    // (a revision) is the mid-entry runner the group hold waits on: it proceeds unassigned —
    // holding it too would deadlock the whole group, since only its run can settle the hold.
    // Otherwise, when the run is not an inbox/resume run, it takes the first free entry; an
    // extra instance with none free is skipped without touching its backoff, and the primary
    // stands down too while siblings hold every eligible entry, unless an operator wake is fresh
    // (then it runs unassigned).
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
        } else if (
          instanceIndex(runner.role) >= 2 ||
          (heldTitles.length > 0 && !freshlyWoken(runner.state))
        ) {
          // An idle extra instance, or a primary whose eligible entries siblings all hold
          // (unless an operator wake is fresh): no run, no backoff climb.
          noteSkip(root, runner, "no-free-entry");
          if (once.active) once.settle(runner.role, "no free entry");
          continue;
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
 * one (deferRun) — openBugsNow is that emptiness, read once here and reused for both
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
