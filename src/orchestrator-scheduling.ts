/** The poll loop's per-runner scheduling pass (src/orchestrator.ts): decide, for each
 * runner, whether this poll admits a tick and why — the pause/quiet/cost-cap/failure-hold
 * gates, the merge-queue interlock, need-based deferral, and once-mode settlement —
 * producing the reasons map orchestrator-launch.ts's launchDueTicks starts ticks from.
 * Split out of runOrchestrator's poll body so the WHY-due policy reads on its own screen;
 * the poll body keeps the poll's other passes (config reload, markers, gates, redeploy,
 * landing drain) and the launch call itself. */
import type { LoopRunner } from "./loop.js";
import type { OnceRound } from "./once-round.js";
import type { WorkLandedCache } from "./work-landed-cache.js";
import type { BudgetGate } from "./budget.js";
import { deferTick, isEligible } from "./scheduling.js";
import { BUGFIX_ROLE, DIRECTOR_ROLE } from "./roles.js";
import { inboxSize } from "./inbox/inbox.js";
import { queuedLandingFiles } from "./landing/landing-queue.js";
import { logEvent } from "./events/events.js";

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
  /** The roles (the director excluded) whose own `quietHoursPerRole` window holds right now. */
  roleQuietHeld: ReadonlySet<string>;
  gate: BudgetGate;
  /** A demoted fallback's half-open window: the pass may admit one role tick past the
   * `paused` budget gate as the breaker's probe. */
  probeDue: boolean;
  /** The providers whose fleet-wide failure hold stands (fleet-hold.ts heldProviders —
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
    roleQuietHeld,
    gate,
    probeDue,
    heldProviders,
    reviewHeld,
    roleProviders,
    openBugsNow,
    workBacklogOpen,
    holdForRestart,
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
  // The fleet gates' block predicate (the director exempt — an explicit human prompt
  // outranks any autonomous gate, quiet hours included): the once-mode settle below and
  // the start gate must agree on exactly when a fleet gate holds, so the compound lives
  // here once. Quiet hours fold in beside the operator pause and the budget gate — the
  // schedule is not probe-worthy the way a paused budget is, so no probeDue exception.
  // The per-role windows (quietHoursPerRole) fold in beside the fleet one as a fourth
  // disjunct — a role held by either window (or both, held once) starts no new ticks;
  // the director stays exempt by the same role check that covers the other disjuncts.
  const operatorPauseBlocks = (role: string): boolean =>
    (userPaused || quietNow || roleQuietHeld.has(role) || (gate === "paused" && !probeDue)) &&
    role !== DIRECTOR_ROLE;
  for (const runner of runners) {
    // Once mode: a paused role runs no tick this round and must be reported as skipped,
    // so it settles here — before the gates that would otherwise skip it silently (a
    // once round has to end even when a pause marker is left over; a later resume within
    // the same round cannot un-settle it, which is the at-most-one-tick contract).
    if (
      once.active &&
      !once.isSettled(runner) &&
      !runner.state.running &&
      (pausedRolesSet.has(runner.role) || capPaused.has(runner.role) || operatorPauseBlocks(runner.role))
    ) {
      once.settle(runner.role, "paused");
    }
    // Once mode's at-most-one-tick contract (src/once-round.ts): a role that already ran
    // its tick — or was settled with a skip reason — runs nothing further this round, even
    // when its backoff has expired or the clock override would admit it again. Without this
    // gate the one-tick guarantee held only for deferrable built-ins (their deferral
    // settles them); a custom loop or work role with a short backoff re-qualified every
    // poll and the round never ended.
    if (once.active && !runner.state.running && once.isSettled(runner)) continue;
    if (holdForRestart) continue; // a restart is pending: nothing new starts, on any loop
    // The per-role pause gates BEFORE the fleet check and exempts nothing — the director
    // included (the operator named that one loop deliberately).
    if (pausedRolesSet.has(runner.role)) continue;
    // The role's own daily cost cap (src/role-cap-gates.ts): no start-gate change — a
    // parked waiter finishes (in-flight ticks finish, NEW ticks are gated at scheduling,
    // exactly like every per-role pause), and there is no fallback-probe exception: the
    // stop is about spend, and probing it adds noise, not signal. The lift is a live
    // config edit or local midnight — no marker exists for `resume --role` to touch.
    if (capPaused.has(runner.role)) continue;
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
    // Merge queue 3/5 interlock (invariant 3): a role with a QUEUED or IN-FLIGHT landing
    // never starts a tick — the entry stays in the queue until its landing completes, so
    // one check covers both. Uniform over every role, director included: its prompt is not
    // finished until it lands. Placed before the need-based deferral block on purpose —
    // no episode bookkeeping is needed (the tick that queued the landing ran, which closed
    // any deferral episode; its `queued` can leave a prior no_change in lastResult — loop-state.ts
    // records only completed results — but the landing's outcome replaces it before the
    // interlock lets the role back into this pass), and skipping here saves that branch's
    // workLandedSince git-range query for the skipped role.
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
      const searchBugfix = runner.role === BUGFIX_ROLE && !openBugsNow;
      const landed =
        (!workBacklogOpen || searchBugfix) && s.lastMainHead !== ""
          ? await workLandedSince.since(s.lastMainHead, mainHead)
          : true;
      const deferredNow = deferTick(s, runner.role, landed, workBacklogOpen, openBugsNow, now);
      if (deferredNow !== (deferredDue.get(runner.role) ?? false)) {
        if (deferredNow)
          logEvent(root, { loop: runner.role, type: "tick_deferred" });
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
    reasons.set(runner, reason);
  }
  return reasons;
}