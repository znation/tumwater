/** The poll loop's per-runner admission tail (part 3/3, split out of pollRunnerReasons): the
 * stand-down turn-down and the parallel-work-instance claim assignment, run after every skip
 * gate has admitted a runner. Returns "admitted" when the runner may start a run, or "skipped"
 * (having recorded its skip reason and settled its once-round answer) when it stands down or
 * yields its place. Split out of orchestrator-scheduling.ts so the post-gate admission policy
 * reads on its own screen; orchestrator-scheduling.ts's loop owns the binder: the final
 * `noteSkip(root, runner, undefined)`, the `reasons` entry and the `writing` increment when an
 * admitted runner actually starts. */
import { assignNext } from "../scheduling/claims.js";
import { eligibleEntries, type EligibleEntry } from "../backlog/backlog-eligibility.js";
import { logEventBestEffort } from "../events/events.js";
import type { RoleRunner } from "../runner/runner.js";
import { freshlyWoken, hasOutstandingWork } from "../runner/runner-state.js";
import { BUGFIX_ROLE } from "../roles/roles.js";
import { baseRoleOf, instanceIndex } from "../roles/runner-ids.js";
import { noteSkip, type SchedulingScope } from "./scheduling-scope.js";

/** Decide a runner's post-gate admission. `reason` is the runner's due reason — the
 * `skipRunner` verdict's reason, itself `isEligible`'s — which the stand-down block keyed on
 * scheduled/main-moved and the claim-group block keyed on inbox/resume read. Mutates the
 * runner's claim/heldElsewhere state, the claim group's held set, and once-mode settlement on
 * the skip paths. */
export function admitRunner(
  scope: SchedulingScope,
  runner: RoleRunner,
  reason: string | undefined,
): "admitted" | "skipped" {
  if (standDownForNoWork(scope, runner, reason)) return "skipped";
  return claimGroupAdmission(scope, runner, reason);
}

/** The candidate half of the stand-down test: true when a feature runner, or a bugfix runner
 * whose open bugs are non-empty (no open bugs at all is search mode, which still runs), is due
 * a scheduled or main-moved run, is not freshly woken, and holds no claim or outstanding work —
 * so startup, inbox and resume runs, a fresh operator wake, and a claimed or mid-entry runner
 * all pass through. The caller stands the runner down only when this holds and no entry is
 * eligible. */
function noWorkScheduledRun(
  scope: SchedulingScope,
  runner: RoleRunner,
  reason: string | undefined,
): boolean {
  const base = baseRoleOf(runner.role);
  return (
    (base === "feature" || (base === BUGFIX_ROLE && scope.openBugsNow)) &&
    (reason === "scheduled" || reason === "main moved") &&
    !freshlyWoken(runner.state) &&
    runner.state.claim === undefined &&
    !hasOutstandingWork(runner.state)
  );
}

/** The eligible-entries list for a base role, computed once per poll and memoized on the
 * scope so the stand-down and claim-group paths share it. */
function eligibleForBase(scope: SchedulingScope, base: string): EligibleEntry[] {
  let eligible = scope.eligibleMemo.get(base);
  if (eligible === undefined) {
    eligible =
      scope.claimGroups.get(base)?.eligible ?? eligibleEntries(scope.root, base);
    scope.eligibleMemo.set(base, eligible);
  }
  return eligible;
}

/** Stand down a runner with no eligible entry at all on its scheduled and main-moved runs: the
 * feature charter says "If PLANS.md is empty or everything is done, there is nothing to do" and
 * the bugfix charter says "when every open entry carries [a Refused note], there is nothing to
 * do", so a feature runner (primary included) with no eligible plan at all, or a bugfix runner
 * whose open bugs are all held (no open bugs at all is search mode, which still runs), skips
 * its scheduled and main-moved runs instead of paying a model run that can only end in
 * nothing-to-do. nextRunAt and backoff stay put, so the first poll after a plan turns eligible
 * starts a run for it. */
function standDownForNoWork(
  scope: SchedulingScope,
  runner: RoleRunner,
  reason: string | undefined,
): boolean {
  if (!noWorkScheduledRun(scope, runner, reason)) return false;
  if (eligibleForBase(scope, baseRoleOf(runner.role)).length > 0) return false;
  noteSkip(scope.root, runner, "no-free-entry");
  runner.state.heldElsewhere = undefined;
  if (scope.once.active) scope.once.settle(runner.role, "no free entry");
  return true;
}

/** Parallel work instances (part 4/7): a multi-runner base role's claim assignment, after
 * every gate has admitted this runner. A runner that already holds a claim proceeds — its
 * revision, resume or retry is the same entry. An unclaimed runner with outstanding work
 * (a revision) is the mid-entry runner the group hold waits on: it proceeds unassigned —
 * holding it too would deadlock the whole group, since only its run can settle the hold.
 * Otherwise, when the run is not an inbox/resume run, it takes the first free entry; an
 * extra instance with none free is skipped without touching its backoff, and the primary
 * stands down too while siblings hold every eligible entry, unless an operator wake is fresh
 * (then it runs unassigned). */
function claimGroupAdmission(
  scope: SchedulingScope,
  runner: RoleRunner,
  reason: string | undefined,
): "admitted" | "skipped" {
  const claimGroup = scope.claimGroups.get(baseRoleOf(runner.role));
  if (claimGroup) {
    if (runner.state.claim) {
      // keeps its claim
      return "admitted";
    } else if (hasOutstandingWork(runner.state)) {
      // finishes its own unrecorded entry
      return "admitted";
    } else if (reason !== "inbox" && reason !== "resume") {
      // The group holds an unclaimed mid-entry sibling: assign nothing this poll, or a
      // sibling could be handed that same entry (the reported `feature-2`/`bugfix-2`
      // duplication). It resolves the moment the sibling settles.
      if (claimGroup.hold) {
        noteSkip(scope.root, runner, "claim-hold");
        return "skipped";
      }
      return assignClaim(scope, runner, claimGroup.eligible, claimGroup.held);
    }
  } else {
    runner.state.heldElsewhere = undefined; // no claim group (e.g. instances lowered to 1)
  }
  return "admitted";
}

/** Assign the first free eligible entry to an unclaimed admitted runner: record the claim on
 * the runner, add it to the group's held set, and log the assignment. With no free entry, an
 * idle extra instance, or a primary whose eligible entries siblings all hold (unless an
 * operator wake is fresh), stands down rather than run unassigned. */
function assignClaim(
  scope: SchedulingScope,
  runner: RoleRunner,
  eligible: EligibleEntry[],
  held: Set<string>,
): "admitted" | "skipped" {
  const free = eligible.filter((e) => !held.has(e.key));
  const pick = assignNext(free);
  // An unassigned runner is told which entries its siblings hold (cleared when none).
  const heldTitles = eligible.filter((e) => held.has(e.key)).map((e) => e.title);
  runner.state.heldElsewhere = !pick && heldTitles.length > 0 ? heldTitles : undefined;
  if (pick) {
    recordAssignedClaim(scope, runner, pick, held);
    return "admitted";
  } else if (
    instanceIndex(runner.role) >= 2 ||
    (heldTitles.length > 0 && !freshlyWoken(runner.state))
  ) {
    // An idle extra instance, or a primary whose eligible entries siblings all hold
    // (unless an operator wake is fresh): no run, no backoff climb.
    noteSkip(scope.root, runner, "no-free-entry");
    if (scope.once.active) scope.once.settle(runner.role, "no free entry");
    return "skipped";
  }
  return "admitted";
}

/** Build the runner's claim record, add the picked entry to the group's held set, and log the
 * assignment to the events feed. */
function recordAssignedClaim(
  scope: SchedulingScope,
  runner: RoleRunner,
  pick: EligibleEntry,
  held: Set<string>,
): void {
  runner.state.claim = {
    file: baseRoleOf(runner.role) === BUGFIX_ROLE ? "BUGS.md" : "PLANS.md",
    key: pick.key,
    title: pick.title,
    at: scope.now,
    source: "assigned",
  };
  held.add(pick.key);
  logEventBestEffort(scope.root, {
    source: runner.role,
    type: "claim",
    action: "assigned",
    key: pick.key,
    title: pick.title,
  });
}
