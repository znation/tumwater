/** The poll loop's per-runner scheduling pass (src/orchestrator/orchestrator.ts): decide, for each
 * runner, whether this poll admits a tick and why — the pause/quiet/cost-cap/failure-hold
 * gates, the merge-queue interlock, need-based deferral, and once-mode settlement —
 * producing the reasons map orchestrator-launch.ts's launchDueTicks starts ticks from.
 * Split out of runOrchestrator's poll body so the WHY-due policy reads on its own screen;
 * the poll body keeps the poll's other passes (config reload, markers, gates, redeploy,
 * landing drain) and the launch call itself. */
import type { LoopRunner } from "../loop/loop.js";
import type { OnceRound } from "../scheduling/once-round.js";
import type { WorkLandedCache } from "../scheduling/work-landed-cache.js";
import { deferTickReason, isEligible, type DeferReason } from "../scheduling/scheduling.js";
import { BUGFIX_ROLE, DIRECTOR_ROLE, commitTier } from "../roles/roles.js";
import type { MaintenanceQuotaVerdict } from "../gates/maintenance-quota.js";
import { baseRoleOf, instanceIndex, loopEnabled } from "../roles/loop-ids.js";
import { inboxSize } from "../inbox/inbox.js";
import { queuedLandingFiles } from "../landing/landing-queue.js";
import { logEventBestEffort, warnEventBestEffort } from "../events/events.js";
import { type EligibleEntry, eligibleEntries } from "../backlog/backlog-eligibility.js";
import {
  CLAIM_IDLE_MAX_MS,
  assignNext,
  claimReleaseReason,
  heldKeys,
  listedKeys,
  type ClaimReleaseReason,
} from "../scheduling/claims.js";

/** One poll's gate verdicts and context, exactly the local view the poll body holds when
 * the scheduling pass runs (FleetGatePoll's fields beside the pass's own inputs). */
interface SchedulingPassCtx {
  root: string;
  runners: readonly LoopRunner[];
  once: OnceRound;
  now: number;
  mainHead: string;
  userPaused: boolean;
  quietNow: boolean;
  pausedRoles: ReadonlySet<string>;
  capPaused: ReadonlySet<string>;
  /** The loops the new-project bootstrap holds (plans/work-ratio.md, part 2/2). */
  bootstrapHeld: ReadonlySet<string>;
  /** The maintenance allowance's verdict this poll (plans/work-ratio.md, part 1b/4): `allowance`
   * is what the rolling window permits and `used` is the landed maintenance count plus the
   * maintenance loops already in flight. The pass admits at most the remaining
   * `allowance - used` due maintenance loops, so the headroom is never overshot within a poll. */
  maintenanceQuota: MaintenanceQuotaVerdict;
  /** Whether bootstrap is active this poll: plan runs on the global min-tick gap when so. */
  bootstrapActive: boolean;
  /** The roles (the director excluded) whose own `quietHoursPerRole` window holds right now. */
  roleQuietHeld: ReadonlySet<string>;
  /** The roles (the director excluded) whose budget tier resolved to pause while the cap is
   * reached (part 5c/8, gate-polls.ts's budgetPausedRoles): a role in this set starts no new
   * tick beside the per-role cap set — unless its tier is the one a due probe tests
   * (probeRoles), which pierces the hold for exactly the probed pair's own tier. */
  budgetPausedRoles: ReadonlySet<string>;
  /** The roles whose model tier resolves to the probed pair (part 5c/8): the ONLY roles the
   * budget hold exempts this poll, and the only runners the launch pass may admit as the
   * probe. A probe blind to the pair's tier lifted the pause for every role (an objection to
   * an earlier draft of this pass). */
  probeRoles: ReadonlySet<string>;
  /** With the review gate on, an unresolvable strong tier means nothing could land, so every
   * role is held (the director exempt) — not only the strong ones. budgetGate's second pause
   * cause, split from the per-tier set so the dashboards can name the tiers' own holds
   * separately from this fleet-wide one. */
  reviewStrongPaused: boolean;
  /** The providers whose fleet-wide failure hold stands (fleet/fleet-hold.ts heldProviders —
   * `until` non-null; key presence is relapse memory, not a hold). A role starts no new
   * tick while ITS provider is held (the director exempt). */
  heldProviders: ReadonlySet<string | undefined>;
  /** The reviewer's provider is held while the review gate is on: nothing could land, so
   * EVERY role is blocked, not just roles ticking on that provider. */
  reviewHeld: boolean;
  /** Each runner's tick model provider (configForRole at poll time): the key the
   * heldProviders check reads for that role. */
  roleProviders: ReadonlyMap<string, string | undefined>;
  /** BUGS.md `## Open` non-empty (backlog.ts's openBugs), read once per poll by the poll body. */
  openBugsNow: boolean;
  /** A pending self-redeploy hold: nothing new starts, on any loop. */
  holdForRestart: boolean;
  /** The disk floor holds new work (plans/disk-floor.md, part 1/4): like a restart, nothing new
   * starts on any loop — the director included — until free space recovers. */
  diskHeld: boolean;
  /** PLANS.md `## Planned` or BUGS.md `## Open` non-empty, read once per poll by the poll body. */
  workBacklogOpen: boolean;
  /** Per-role deferred-due memory (one-shot tick_deferred events), advanced in place. */
  deferredDue: Map<string, boolean>;
  workLandedSince: WorkLandedCache;
}

/** Decide which runners are due this poll. Mutates `deferredDue` (and once-mode settlement)
 * as its only side effects; returns the reason per admitted runner. */
export async function pollRunnerReasons(
  ctx: SchedulingPassCtx,
): Promise<Map<LoopRunner, string | undefined>> {
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
    bootstrapActive,
    budgetPausedRoles,
    probeRoles,
    reviewStrongPaused,
    roleQuietHeld,
    heldProviders,
    reviewHeld,
    roleProviders,
    openBugsNow,
    workBacklogOpen,
    holdForRestart,
    diskHeld,
    deferredDue,
    workLandedSince,
  } = ctx;
  const reasons = new Map<LoopRunner, string | undefined>();
  // Merge-queue interlock data, listed ONCE per poll (was once per runner per poll — each
  // queuedLandingFiles() re-lists the land-queue directory and re-stats every queued entry): the
  // check below only asks whether the runner's role has a queued entry. The queue changes
  // only when a landing completes or a tick enqueues — both asynchronous events this pass
  // observes on its next poll — so one snapshot is as fresh as per-runner reads, and a
  // landing that completes mid-pass just keeps its role blocked one extra poll (conservative).
  const queuedLandingRoles = new Set(queuedLandingFiles(root).map((q) => q.entry.role));
  // Parallel work instances (plans/parallel-work-instances.md "Claims", part 4/7): a base role
  // with more than one runner assigns each due instance a distinct eligible entry, and releases
  // the claims whose entry left, turned ineligible, was disabled or went stale. Computed once
  // per poll and only for a multi-runner base, so a single-runner fleet is unchanged. The
  // release runs before assignment so a freed key counts as free below.
  const claimGroups = new Map<
    string,
    { eligible: EligibleEntry[]; eligibleKeys: Set<string>; held: Set<string> }
  >();
  const baseCounts = new Map<string, number>();
  for (const runner of runners) {
    const base = baseRoleOf(runner.role);
    baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1);
  }
  for (const [base, count] of baseCounts) {
    if (count <= 1) continue;
    const groupRunners = runners.filter((r) => baseRoleOf(r.role) === base);
    const eligible = eligibleEntries(root, base);
    const eligibleKeys = new Set(eligible.map((e) => e.key));
    const listed = listedKeys(root, base);
    for (const r of groupRunners) {
      const released = claimReleaseReason(r, {
        listedKeys: listed,
        eligibleKeys,
        now,
        hasQueuedLanding: queuedLandingRoles.has(r.role),
        // Per instance, not per base role: a lowered `instances` leaves the surplus runner in
        // place with `loopEnabled` false, and its idle claim must be released so a sibling can
        // take the entry instead of the key staying held until the 24h stale sweep.
        enabled: loopEnabled(r.config, r.role),
      });
      if (released === null) continue;
      const title = r.state.claim?.title ?? "";
      r.state.claim = undefined;
      const reason: ClaimReleaseReason = released;
      logEventBestEffort(root, { loop: r.role, type: "claim", action: "released", title, reason });
      if (reason === "stale") {
        warnEventBestEffort(
          root,
          r.role,
          `released a stale claim on "${title}" after ${Math.round(CLAIM_IDLE_MAX_MS / 3_600_000)}h idle`,
        );
      }
    }
    claimGroups.set(base, {
      eligible,
      eligibleKeys,
      held: heldKeys(groupRunners, eligibleKeys, listed),
    });
  }
  // The fleet gates' block predicate (the director exempt — an explicit human prompt
  // outranks any autonomous gate, quiet hours included): the once-mode settle below and
  // the start gate must agree on exactly when a fleet gate holds, so the compound lives
  // here once. Quiet hours fold in beside the operator pause and the budget gate — the
  // schedule is not probe-worthy the way a paused budget is, so no probeDue exception.
  // The per-role windows (quietHoursPerRole) fold in beside the fleet one as a fourth
  // disjunct — a role held by either window (or both, held once) starts no new ticks;
  // the director stays exempt by the same role check that covers the other disjuncts.
  // The budget hold, per role (part 5c/8): a tier that resolved to pause holds its own roles,
  // and — with review on — an unresolvable strong tier holds every role (nothing could land).
  // The probe of a demoted pair pierces the hold for EXACTLY the probed pair's tier's roles:
  // the earlier draft's pair-blind pierce lifted the pause fleet-wide on any due probe.
  // Quiet hours fold in beside the operator pause — the schedule is not probe-worthy the way a
  // paused budget is.
  const budgetHolds = (role: string): boolean =>
    (reviewStrongPaused || budgetPausedRoles.has(role)) && !probeRoles.has(role);
  const operatorPauseBlocks = (role: string): boolean =>
    (userPaused || quietNow || roleQuietHeld.has(role) || budgetHolds(role)) &&
    role !== DIRECTOR_ROLE;
  // Fresh operator demand: a queued prompt or a wake newer than the loop's last tick end. The
  // same override the need-based deferral honors (an explicit "try again now" is not idle
  // maintenance); shared by the bootstrap and maintenance-allowance holds so the two cannot
  // drift on what counts as demand.
  const hasDemand = (runner: LoopRunner): boolean =>
    inboxSize(root, runner.role) > 0 ||
    (runner.state.wokenAt !== undefined && runner.state.wokenAt > (runner.state.lastTickEndedAt ?? 0));
  // The new-project bootstrap hold (part 2/2): held unless the loop has a fresh operator wake
  // or a queued prompt.
  const bootstrapHeldNow = (runner: LoopRunner): boolean =>
    bootstrapHeld.has(runner.role) && !hasDemand(runner);
  // The maintenance allowance's fleet-level hold (part 1b/4): `used` has reached `allowance`,
  // so no maintenance loop starts unless it carries demand (`tumwater wake <maintenance-role>`
  // runs exactly one tick). The per-poll admission headroom is spent separately, after each
  // loop's due check, where the pass knows what actually ticks; the verdict alone cannot.
  const maintenanceQuotaOverLine = (runner: LoopRunner): boolean =>
    commitTier(baseRoleOf(runner.role)) === "maintenance" &&
    maintenanceQuota.used >= maintenanceQuota.allowance &&
    !hasDemand(runner);
  // The one-poll admission budget: each due maintenance loop this pass admits spends one of
  // the remaining `allowance - used` slots, reset every pass, so two due maintenance loops
  // cannot start in the same poll and overshoot the allowance.
  let maintenanceQuotaAdmitted = 0;
  for (const runner of runners) {
    // Once mode: a paused role runs no tick this round and must be reported as skipped,
    // so it settles here — before the gates that would otherwise skip it silently (a
    // once round has to end even when a pause marker is left over; a later resume within
    // the same round cannot un-settle it, which is the at-most-one-tick contract).
    if (
      once.active &&
      !once.isSettled(runner) &&
      !runner.state.running &&
      (pausedRolesSet.has(runner.role) ||
        pausedRolesSet.has(baseRoleOf(runner.role)) ||
        capPaused.has(runner.role) ||
        maintenanceQuotaOverLine(runner) ||
        bootstrapHeldNow(runner) ||
        operatorPauseBlocks(runner.role))
    ) {
      once.settle(runner.role, "paused");
    }
    // Once mode's at-most-one-tick contract (src/scheduling/once-round.ts): a role that already ran
    // its tick — or was settled with a skip reason — runs nothing further this round, even
    // when its backoff has expired or the clock override would admit it again. Without this
    // gate the one-tick guarantee held only for deferrable built-ins (their deferral
    // settles them); a custom loop or work role with a short backoff re-qualified every
    // poll and the round never ended.
    if (once.active && !runner.state.running && once.isSettled(runner)) continue;
    if (holdForRestart || diskHeld)
      continue; // a restart or a low disk is pending: nothing new starts, on any loop
    // The per-role pause gates BEFORE the fleet check and exempts nothing — the director
    // included (the operator named that one loop deliberately).
    if (pausedRolesSet.has(runner.role) || pausedRolesSet.has(baseRoleOf(runner.role))) continue;
    // The role's own daily cost cap (src/gates/role-cap-gates.ts): no start-gate change — a
    // parked waiter finishes (in-flight ticks finish, NEW ticks are gated at scheduling,
    // exactly like every per-role pause), and there is no fallback-probe exception: the
    // stop is about spend, and probing it adds noise, not signal. The lift is a live
    // config edit or local midnight — no marker exists for `resume --role` to touch.
    if (capPaused.has(runner.role)) continue;
    // The maintenance allowance (plans/work-ratio.md, part 1b/4): no new maintenance tick while
    // the rolling 24 h window is over its line. A fresh operator wake or a queued prompt admits
    // one anyway (maintenanceQuotaOverLine), the same demand override the bootstrap hold honors.
    if (maintenanceQuotaOverLine(runner)) continue;
    // The new-project bootstrap (part 2/2): no new maintenance ticks until the plan target is
    // met; a fresh wake or queued prompt admits one anyway (bootstrapHeldNow).
    if (bootstrapHeldNow(runner)) continue;
    if (operatorPauseBlocks(runner.role))
      continue; // no new role ticks while either gate holds
    if (
      runner.role !== DIRECTOR_ROLE &&
      (reviewHeld || heldProviders.has(roleProviders.get(runner.role)))
    )
      continue; // nor while ITS provider's failure storm holds — or the reviewer's (nothing could land)
    // The loop's OWN queue decides inbox due-ness: the director counts its historical
    // inbox, every other loop its per-role queue (tumwater prompt --role <id>) — so a
    // queued prompt makes its loop due by itself, no wake marker needed (isEligible).
    const { run, reason } = isEligible(runner, now, mainHead, inboxSize(root, runner.role), {
      once: once.active,
      bootstrapActive,
    });
    if (!run) {
      // Not due this poll: any deferral episode has ended (or never started). No event —
      // the tick's own events cover it.
      if (deferredDue.get(runner.role)) deferredDue.set(runner.role, false);
      // Once mode: idle and not due — settleSkipped records the skip reason (the caller's
      // summary reports it).
      if (once.active && !runner.state.running) once.settleSkipped(runner);
      continue;
    }
    // Merge queue 3/5 interlock (invariant 3): a role with a QUEUED or IN-FLIGHT landing never
    // starts a tick — the entry stays in the queue until its landing completes, so one check
    // covers both. Uniform over every role, director included: its prompt is not finished until it
    // lands. Placed before the need-based deferral block on purpose — no episode bookkeeping is
    // needed (the tick that queued the landing ran, which closed any deferral episode; its `queued`
    // can leave a prior no_change in lastResult — loop-state.ts records only completed results
    // — but the landing's outcome replaces it before the interlock lets the role back into this
    // pass), and skipping here saves that branch's workLandedSince git-range query for the skipped
    // role.
    if (queuedLandingRoles.has(runner.role)) continue;
    // Need-based deferral: a due maintenance tick (scheduled or main-moved wake) whose last
    // tick did nothing stays deferred while the feature/bugfix backlog is open or no new
    // work has landed to react to — nextRunAt is left untouched, so it re-checks every poll
    // until the backlog drains and qualifying work lands. Resume wakes precede this check in
    // isEligible, the director's "inbox" reason skips it, work roles are not in
    // DEFERRABLE_ROLES (bugfix is the exception while its backlog is empty — deferTick), and
    // a fresh operator wake overrides it (deferTick's woken check — an explicit "try again
    // now" is a demand, not idle maintenance). Sitting before reasons.set also keeps a
    // deferred role out of the wake-event pass below.
    if (reason === "scheduled" || reason === "main moved") {
      const s = runner.state;
      // The git range is only consulted when the other conditions already hold — a
      // never-ticked role or a tick with pending business runs without paying for it, and an
      // open backlog defers regardless of what landed. bugfix in search mode is the
      // exception: its deferral keys on the work-landed verdict alone, so the backlog-open
      // shortcut must not stand in for the query.
      const searchBugfix = baseRoleOf(runner.role) === BUGFIX_ROLE && !openBugsNow;
      const landed =
        (!workBacklogOpen || searchBugfix) && s.lastMainHead !== ""
          ? await workLandedSince.since(s.lastMainHead, mainHead)
          : true;
      const deferral: DeferReason | null = deferTickReason(
        s,
        runner.role,
        landed,
        workBacklogOpen,
        openBugsNow,
        now,
      );
      const deferredNow = deferral !== null;
      if (deferredNow !== (deferredDue.get(runner.role) ?? false)) {
        if (deferral)
          logEventBestEffort(root, { loop: runner.role, type: "tick_deferred", reason: deferral });
        deferredDue.set(runner.role, deferredNow);
      }
      if (deferredNow) {
        // Once mode: a deferred maintenance tick decided not to run — its once-round
        // answer, so it settles instead of holding the round open for DEFER_MAX_MS.
        if (once.active) once.settle(runner.role, "deferred");
        continue;
      }
    } else if (deferredDue.get(runner.role)) {
      deferredDue.set(runner.role, false); // an inbox/resume run ends the episode
    }
    // The allowance's in-flight admission (plans/work-ratio.md, part 1b/4): `used` counts the
    // maintenance loops already in flight, so a due maintenance tick admitted here spends one
    // of the remaining `allowance - used` slots. This must sit after the due check — the pure
    // verdict cannot know which loops will be eligible this poll, so the reservation lives in
    // the pass that does; without it two due maintenance loops start in the same poll. Demand
    // spends no slot: it is an explicit operator request, not idle maintenance.
    if (commitTier(baseRoleOf(runner.role)) === "maintenance" && !hasDemand(runner)) {
      if (maintenanceQuotaAdmitted >= maintenanceQuota.allowance - maintenanceQuota.used) continue;
      maintenanceQuotaAdmitted++;
    }
    // Parallel work instances (part 4/7): a multi-runner base role's claim assignment, after
    // every gate has admitted this runner. A runner that already holds a claim proceeds — its
    // revision, resume or retry is the same entry. Otherwise, when the tick is not an
    // inbox/resume run, it takes the first free entry; an extra instance with none free is
    // skipped without touching its backoff, and the primary runs unassigned as today.
    const claimGroup = claimGroups.get(baseRoleOf(runner.role));
    if (claimGroup) {
      if (runner.state.claim) {
        // keeps its claim
      } else if (reason !== "inbox" && reason !== "resume") {
        const free = claimGroup.eligible.filter((e) => !claimGroup.held.has(e.key));
        const pick = assignNext(free);
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
            loop: runner.role,
            type: "claim",
            action: "assigned",
            key: pick.key,
            title: pick.title,
          });
        } else if (instanceIndex(runner.role) >= 2) {
          continue; // an idle extra instance: no tick, no backoff climb
        }
      }
    }
    reasons.set(runner, reason);
  }
  return reasons;
}
