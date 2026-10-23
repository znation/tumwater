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
import { DIRECTOR_ROLE } from "../roles/roles.js";
import { baseRoleOf } from "../roles/runner-ids.js";
import { eligibleEntries } from "../backlog/backlog-eligibility.js";
import { planBacklogFull } from "../scheduling/claims.js";
import { admitRunner } from "./scheduling-admit.js";
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
  const { root, writing, reasons } = scope;
  for (const runner of scope.ordered) {
    // The WHY-due policy: every gate that decides this runner is due or skipped, and the
    // once/deferral bookkeeping that travels with them, lives in scheduling-skip.ts's
    // skipRunner. What follows is only the claim-admission tail (part 3/3, scheduling-admit.ts).
    const verdict = await skipRunner(scope, runner);
    if (verdict.skip) continue;
    const reason = verdict.reason;
    // Post-gate admission (part 3/3, scheduling-admit.ts): the stand-down turn-down and the
    // parallel-work-instance claim assignment, after every skip gate has admitted this runner.
    // Returns "skipped" having recorded its skip reason and settled its once answer; "admitted"
    // runs the binder: the final noteSkip, the reasons entry and the writing increment.
    if (admitRunner(scope, runner, reason) === "admitted") {
      noteSkip(root, runner, undefined);
      reasons.set(runner, reason);
      if (scope.claimGroups.has(baseRoleOf(runner.role)) && !runner.state.running)
        increment(writing, baseRoleOf(runner.role));
    }
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
