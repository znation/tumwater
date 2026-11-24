/** The per-runner skip decision of the scheduling pass (pollRunnerReasons), lifted out of
 * orchestrator-scheduling.ts so the WHY-due policy reads on its own screen: every gate that
 * decides a runner is due or skipped, and the once/deferral bookkeeping that travels with
 * them. Part 2/3 of the pollRunnerReasons split; reads the shared pass context and admission
 * state from scope.ts's SchedulingScope. Part 3/3 lifts the admit tail (admit.ts) that
 * follows a skip:false verdict. */
import type { RoleRunner } from "../runner/runner.js";
import { logEventBestEffort } from "../events/events.js";
import { baseRoleOf, configuredInstances, runnerPaused } from "../roles/runner-ids.js";
import { BUGFIX_ROLE, DIRECTOR_ROLE, commitTier } from "../roles/roles.js";
import { deferRunReason, isEligible, type DeferReason } from "./scheduling.js";
import { inboxSize, deliverablePromptStamps } from "../inbox/inbox.js";
import { freshlyWoken, type SkipReason } from "../runner/runner-state.js";
import { MERGE_CONFLICT_LIMIT } from "../runner/runner-leftover.js";
import { noteSkip, type SchedulingScope } from "./scope.js";
import { heldStarts } from "../team/team-hold.js";

/** A runner's skip verdict under the per-runner gates: `skip: true` when a gate declined the
 * run (its once/deferral/noteSkip bookkeeping already happened), or `skip: false` with the
 * reason the isEligible check returned, which the caller's admit tail starts a run from. */
type SkipVerdict =
  | { skip: true }
  | { skip: false; reason: string };

/** Decide whether this runner is due this poll, running every skip gate and the once/deferral
 * bookkeeping against scope.ts's scope. Returns skip:true when a gate declined the run, and
 * skip:false with the due reason otherwise (the admit tail in admit.ts consumes the reason).
 * Mutates the shared scope — deferredDue, quotaAdmitted, once-mode settlement — and writes skip
 * reasons as its only side effects. */
export async function skipRunner(scope: SchedulingScope, runner: RoleRunner): Promise<SkipVerdict> {
  const { root, once, now, mainHead, planBacklogFull, pinnedDirector, directorDrainingPin } = scope;
  // The role's inbox size and operator demand, computed once per runner per poll: every
  // consumer (the holds, isEligible's inbox count, the maintenance admission) shares
  // this one directory listing + per-file stat read instead of each re-scanning the queue.
  // The queue is append-only while this pass runs (nothing dequeues until launch, after the
  // pass), so one read per runner is stable, and `now` here matches the poll's own clock.
  const inboxCount = inboxSize(root, runner.role);
  const demand = inboxCount > 0 || freshlyWoken(runner.state);
  settleOncePaused(scope, runner, demand);
  // Once mode's at-most-one-run contract (src/scheduling/once-round.ts): a role that already had
  // its run — or was settled with a skip reason — runs nothing further this round, even
  // when its backoff has expired or the clock override would admit it again. Without this
  // gate the one-run guarantee held only for deferrable built-ins (their deferral
  // settles them); a custom role or work role with a short backoff re-qualified every
  // poll and the round never ended.
  if (once.active && !runner.state.running && once.isSettled(runner)) return { skip: true };
  if (heldFromStarting(scope, runner, demand)) return { skip: true };
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
    // A runner re-queues its own unfulfilled prompt at the end of a recovery run
    // (requeueUnfulfilled); left ungated that re-queue re-fires the inbox arm back to back at
    // the ~2 s poll cadence (BUGS.md hot loops: the director's on 2026-11-19, a work role's
    // relief_wait spin on 2026-11-23). True when the queue holds only work this runner enqueued
    // for itself — every deliverable prompt stamped at or before the run that just ended — so
    // that inbox is due on the min-run-interval clock instead. A prompt an operator submitted
    // since (stamped after lastRunEndedAt) reads false and runs immediately, as before. Cheap:
    // no new file reads, only the enqueue stamps in the filenames and the pass's stat cache.
    inboxSelfRequeued:
      inboxCount > 0 &&
      (() => {
        const t = runner.state.lastRunEndedAt;
        if (!t) return false;
        return deliverablePromptStamps(root, runner.role, Date.now()).every((stamp) => stamp <= t);
      })(),
    // The director's own change still drains: its pin is the sha its queued run stashed
    // (queuedSummary), so a run now is the promptless recovery run that can only end
    // `skipped`. A pin the stash does not name (a crashed run's, or one whose merge failed)
    // still gets its one recovery run, which re-pins it and stashes the sha.
    ownPinDraining:
      runner.role === DIRECTOR_ROLE &&
      directorDrainingPin !== null &&
      runner.state.queuedSummary?.sha === directorDrainingPin,
  });
  if (!run) return notDue(scope, runner, skip);
  if (admissionHolds(scope, runner)) return { skip: true };
  if (await deferMaintenance(scope, runner, reason)) return { skip: true };
  if (admitMaintenance(scope, runner, demand)) return { skip: true };
  return { skip: false, reason: reason as string };
}

/** The opening once-mode pause settlement: a paused role gets no run this round and must be
 * reported as skipped, so it settles here — before the gates that would otherwise skip it
 * silently (a once round has to end even when a pause marker is left over; a later resume
 * within the same round cannot un-settle it, which is the at-most-one-run contract). */
function settleOncePaused(scope: SchedulingScope, runner: RoleRunner, demand: boolean): void {
  const { once } = scope;
  if (once.active && !once.isSettled(runner) && !runner.state.running) {
    const label = onceHoldLabel(scope, runner, demand);
    if (label !== undefined) once.settle(runner.role, label);
  }
}

/** The once-mode settle label naming WHICH starting hold declined this round, or undefined when
 * no starting hold does. Each label reuses the name the status side gives that gate
 * (`capPaused` → `cap paused`, bootstrap → `held: bootstrap`, the maintenance allowance →
 * `held: maintenance quota <used>/<allowance>`, the budget tier's pause → `budget paused`), so a
 * `--json` consumer sees the same distinction the payload carries; plain `paused` stays only for
 * the holds `tumwater resume` answers (the per-role pause marker and the team pause marker), and
 * the scheduled quiet window — which `resume` does not lift — is named as its own hold. The order
 * mirrors heldFromStarting, so the label names the hold that declines the run first, and inside
 * the team gate it mirrors status-model.ts's heldPhase: the team pause outranks the quiet window,
 * which outranks the budget pause. Every arm of that run needs a label: an unlabeled hold leaves
 * the runner unsettled, and OnceRound.exitReady waits for a settle on EVERY runner, so the round
 * sat idle-polling while the hold stood — with no settle to end it and no deferral episode to
 * time out (a starting hold returns before the due check, so DEFER_MAX_MS never applies here) —
 * until the hold itself lifted, or never on a full disk, instead of reporting the skip and
 * exiting. */
function onceHoldLabel(scope: SchedulingScope, runner: RoleRunner, demand: boolean): string | undefined {
  const {
    pausedRoles,
    capPaused,
    maintenanceQuota,
    budgetHolds,
    operatorPauseBlocks,
    bootstrapHeldNow,
    maintenanceQuotaOverLine,
  } = scope;
  // The self-redeploy's hold first, as heldFromStarting tests it: `--once` forces the redeployer
  // null, so this arm cannot stand in a once round today — labeled anyway so the every-arm rule
  // above holds if that ever changes, and named after the status side's `waiting: update — <step>`
  // family without the stage phrase (the label reads no build snapshot).
  if (scope.holdForRestart) return "waiting: update";
  if (scope.diskHeld) return "waiting: low disk"; // status-model's own wording for the disk floor
  if (runnerPaused(pausedRoles, runner.role)) return "paused"; // `resume --role <id>` answers this one
  if (capPaused.has(runner.role)) return "cap paused"; // lifted by a live config edit or local midnight
  if (maintenanceQuotaOverLine(runner, demand))
    return `held: maintenance quota ${maintenanceQuota.used}/${maintenanceQuota.allowance}`;
  if (bootstrapHeldNow(runner, demand)) return "held: bootstrap"; // lifted by the plan target, or `wake --role`
  if (operatorPauseBlocks(runner.role)) {
    // The team gate's four disjuncts each name their own verdict (the scheduled quiet window the
    // header's quiet badge reports; the budget tier's pause status-data.ts names `budget paused`),
    // but the team pause marker leads them: status-model.ts's heldPhase ranks the operator's own
    // pause ahead of the quiet window and the spend state (user intent is more specific than
    // spend), and `tumwater resume` is that pause's lever — a quiet window lifts when it ends or
    // `config set quietHours` changes it.
    if (scope.userPaused) return "paused";
    if (scope.quietNow || scope.roleQuietHeld.has(runner.role)) return "held: quiet hours";
    if (budgetHolds(runner.role)) return "budget paused";
    return "paused";
  }
  // The team-failure hold, last exactly as heldFromStarting runs it last: the role's provider
  // storm, its pair's model-load hold, or (the director) a subscription window. No status label
  // names this gate per role — the payload publishes the holds as structured `providerHolds`
  // entries — so the settle uses the held: family like the bootstrap and quiet-hours holds.
  if (heldStarts(
    runner.role,
    scope.roleProviders.get(runner.role),
    scope.rolePairs.get(runner.role) ?? "",
    scope.windowHeldProviders,
    scope.heldProviders,
    scope.heldPairs,
  )) {
    return "held: provider failure";
  }
  return undefined;
}

/** The run of starting holds, in today's order — a restart or low disk, the per-role pause,
 * the role's cost cap, the maintenance-quota and bootstrap holds, the operator pause, the
 * director-window and non-director provider-storm holds, and the non-director model-load
 * pair hold. Returns true when any holds, so the caller skips before the due check. */
function heldFromStarting(scope: SchedulingScope, runner: RoleRunner, demand: boolean): boolean {
  const {
    holdForRestart,
    diskHeld,
    pausedRoles,
    capPaused,
    roleProviders,
    heldProviders,
    heldPairs,
    rolePairs,
    maintenanceQuotaOverLine,
    bootstrapHeldNow,
    operatorPauseBlocks,
  } = scope;
  if (holdForRestart || diskHeld)
    return true; // a restart or a low disk is pending: nothing new starts, on any role
  // The per-role pause gates BEFORE the team check and exempts nothing — the director
  // included (the operator named that one role deliberately).
  if (runnerPaused(pausedRoles, runner.role)) return true;
  // The role's own daily cost cap (src/gates/role-cap-gates.ts): no start-gate change — a
  // parked waiter finishes (in-flight runs finish, NEW runs are gated at scheduling,
  // exactly like every per-role pause), and there is no fallback-probe exception: the
  // stop is about spend, and probing it adds noise, not signal. The lift is a live
  // config edit or local midnight — no marker exists for `resume --role` to touch.
  if (capPaused.has(runner.role)) return true;
  // The maintenance allowance (plans/work-ratio.md, part 1b/4): no new maintenance run while
  // the rolling 24 h window is over its line. A fresh operator wake or a queued prompt admits
  // one anyway (maintenanceQuotaOverLine), the same demand override the bootstrap hold honors.
  if (maintenanceQuotaOverLine(runner, demand)) return true;
  // The new-project bootstrap (part 2/2): no new maintenance runs until the plan target is
  // met; a fresh wake or queued prompt admits one anyway (bootstrapHeldNow).
  if (bootstrapHeldNow(runner, demand)) return true;
  if (operatorPauseBlocks(runner.role)) return true; // no new role runs while either gate holds
  // The team-failure hold, as one shared rule (team-hold.ts heldStarts): the director honors
  // only the subscription-window hold — the per-run 429 retry that backs the other kinds does
  // not answer a window rejection, so its prompt would fail and re-queue every poll until the
  // repeated-failure pause stops it; every other role is held by ITS provider's failure storm
  // (heldProviders — the reviewer's hold parks only the post-merge review queue, never a role
  // start) or, under a model-load hold that names its pairs, by ITS pair (heldPairs), so a
  // role on another model at the same provider keeps running.
  return heldStarts(runner.role, roleProviders.get(runner.role), rolePairs.get(runner.role) ?? "", scope.windowHeldProviders, heldProviders, heldPairs);
}

/** The not-due bookkeeping: the run was declined, so any deferral episode ends, the once-mode
 * skip settles, and the gate-specific skip (if any) is noted. Returns the skip verdict. */
function notDue(scope: SchedulingScope, runner: RoleRunner, skip: SkipReason | undefined): SkipVerdict {
  const { root, once, deferredDue } = scope;
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

/** The two post-due admission holds: the model-check hold (which settles the once-mode
 * answer) and the role's `instances` limit on concurrent runs. Returns true when either holds. */
function admissionHolds(scope: SchedulingScope, runner: RoleRunner): boolean {
  const { root, once, modelCheckHeld, claimGroups, writing } = scope;
  // The model check (src/model-check/model-check-gate.ts): a due role whose pair has not
  // answered the probe — still being checked, or failed it — waits, recorded so its row says
  // why. Placed after the due check so only a role that would otherwise run carries the reason;
  // the check's re-probe lifts the hold by itself, no operator step.
  if (modelCheckHeld.has(runner.role)) {
    // Named as the check's own hold, not a pause: no `resume` lifts it — the check's re-probe does.
    if (once.active && !runner.state.running) once.settle(runner.role, "waiting: model check");
    noteSkip(root, runner, "model-check");
    return true;
  }
  // The role's `instances` limit on concurrent runs: a multi-runner base admits a runner only
  // while fewer than `instances` of its runners are running. A parked runner (queued change)
  // was skipped by the interlock above and holds no place.
  const writingBase = baseRoleOf(runner.role);
  if (claimGroups.has(writingBase) && !runner.state.running) {
    if ((writing.get(writingBase) ?? 0) >= configuredInstances(runner.config, runner.role)) {
      noteSkip(root, runner, "instances-full");
      return true;
    }
  }
  return false;
}

/** The deferral verdict: whether this due run enters the deferral episode, returned as its
 * clause (DeferReason) or null when it runs. A scheduled or main-moved run consults the
 * backlog and the work-merged probe to decide; a run in no other shape ends any open episode
 * and returns null. It owns the episode transition — the deferredDue compare/update and the
 * one `run_deferred` event — so the caller can settle the run on the returned clause.
 *
 * Need-based deferral: a due maintenance run (scheduled or main-moved wake) whose last
 * run did nothing stays deferred while the feature/bugfix backlog is open or no new
 * work has merged to react to — nextRunAt is left untouched, so it re-checks every poll
 * until the backlog drains and qualifying work merges. Resume wakes precede this check in
 * isEligible, the director's "inbox" reason skips it, work roles are not in
 * DEFERRABLE_ROLES (bugfix is the exception while its backlog is empty — deferRun), and
 * a fresh operator wake overrides it (deferRun's woken check — an explicit "try again
 * now" is a demand, not idle maintenance). Sitting before reasons.set also keeps a
 * deferred role out of the wake-event pass below. */
async function maintenanceDeferral(
  scope: SchedulingScope,
  runner: RoleRunner,
  reason: string | undefined,
): Promise<DeferReason | null> {
  const {
    root,
    now,
    mainHead,
    openBugsNow,
    workBacklogOpen,
    planBacklogFull,
    deferredDue,
    workMergedSince,
  } = scope;
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
    return deferral;
  }
  if (deferredDue.get(runner.role)) {
    deferredDue.set(runner.role, false); // an inbox/resume run ends the episode
  }
  return null;
}

/** The deferred run's settlement: the once-mode answer and the skip-reason note that carry
 * the deferral's clause into the run's own bookkeeping. */
function settleDeferredMaintenance(scope: SchedulingScope, runner: RoleRunner, deferral: DeferReason): void {
  const { root, once } = scope;
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
}

/** The maintenance deferral episode: a due scheduled or main-moved run whose last run did
 * nothing defers while the backlog is open or no new work has merged; a run that is not in
 * that shape ends any open episode. Returns true when the run deferred (the caller skips). */
async function deferMaintenance(
  scope: SchedulingScope,
  runner: RoleRunner,
  reason: string | undefined,
): Promise<boolean> {
  const deferral = await maintenanceDeferral(scope, runner, reason);
  if (deferral === null) return false;
  settleDeferredMaintenance(scope, runner, deferral);
  return true;
}

/** The allowance's in-flight admission: a due maintenance run without demand spends one of the
 * remaining `allowance - used` slots; at the cap it is held. Returns true when the run is
 * held at the cap (the caller skips). */
function admitMaintenance(scope: SchedulingScope, runner: RoleRunner, demand: boolean): boolean {
  const { root, maintenanceQuota } = scope;
  // The allowance's in-flight admission (plans/work-ratio.md, part 1b/4): `used` counts the
  // maintenance roles already in flight, so a due maintenance run admitted here spends one
  // of the remaining `allowance - used` slots. This must sit after the due check — the pure
  // verdict cannot know which roles will be eligible this poll, so the reservation lives in
  // the pass that does; without it two due maintenance roles start in the same poll. Demand
  // spends no slot: it is an explicit operator request, not idle maintenance.
  if (commitTier(baseRoleOf(runner.role)) === "maintenance" && !demand) {
    if (scope.quotaAdmitted >= maintenanceQuota.allowance - maintenanceQuota.used) {
      noteSkip(root, runner, "maintenance-due-cap");
      return true;
    }
    scope.quotaAdmitted++;
  }
  return false;
}
