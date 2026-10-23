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
import { BUGFIX_ROLE, DIRECTOR_ROLE } from "../roles/roles.js";
import { baseRoleOf, instanceIndex } from "../roles/runner-ids.js";
import { freshlyWoken, hasOutstandingWork } from "../runner/runner-state.js";
import { logEventBestEffort } from "../events/events.js";
import { eligibleEntries } from "../backlog/backlog-eligibility.js";
import { assignNext, planBacklogFull } from "../scheduling/claims.js";
import { skipRunner } from "./scheduling-skip.js";
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
  const { root, once, now, claimGroups, writing, eligibleMemo, reasons, openBugsNow } = scope;
  for (const runner of scope.ordered) {
    // The WHY-due policy: every gate that decides this runner is due or skipped, and the
    // once/deferral bookkeeping that travels with them, lives in scheduling-skip.ts's
    // skipRunner. What follows keeps only the claim-admission tail (part 3/3 lifts it).
    const verdict = await skipRunner(scope, runner);
    if (verdict.skip) continue;
    const reason = verdict.reason;
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
