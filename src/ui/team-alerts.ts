/** The team ALERT model: everything about the team that needs the operator — or that they
 * should know — phrased once for both observer surfaces: the dashboard's alert banners
 * (shipped in the status payload as `alerts`) and the TUI's attention lines
 * (tui-frame.ts alertLines). Split from status-model.ts, whose per-role derivation this reads
 * as input; `tone` ranks an
 * alert (red and amber ask for action, indigo asks a question, blue and gray inform), and
 * `actions` are the dashboard's buttons (`act` names a page action — open a role, a view,
 * the cap editor…).
 *
 * This module is the composition root: it imports the four per-domain builder modules
 * (team-alert-status, team-alert-backlog, team-alert-merge,
 * team-alert-tail) and runs them in emission order, and it re-exports the shared alert types
 * (defined in team-alert-shared.ts) so consumers keep importing them from this one path. */

import type { StatusSnapshot } from "../status/status-data.js";
import type { StrandedPlanEntry } from "../backlog/backlog-structure.js";
import type { FixClaimProblem, ValidationGapProblem } from "../doctor/doctor-backlog-plans.js";
import type { CapacityBottleneck, DroppedPostReviews, MainRuleFailure, PostMergeChurn, RegressedFixAlert, QaCoverageStale } from "./status-payload.js";
import type { RefusedEntry, StalledEntry } from "../backlog/backlog-eligibility.js";
import type { ClaimState } from "../scheduling/claim-entries.js";
import type { StaleWorkspacePin } from "../doctor/doctor-contention-checks.js";
import type {
  AlertRole, TeamAlert, StaleQuestion,
  PlanDependencyProblem, QuarantinedTests,
  FlappedChecks, PostReviewRisk, BacklogHeadingDuplicate, LiveFinishedEntry,
} from "./team-alert-shared.js";
import { buildStatusAlerts } from "./team-alert-status.js";
import { buildBacklogAlerts } from "./team-alert-backlog.js";
import { buildMergeAlerts } from "./team-alert-merge.js";
import { buildTailAlerts } from "./team-alert-tail.js";

export type {
  StaleQuestion,
  PlanDependencyProblem, QuarantinedTests, FlappedChecks, PostReviewRisk,
  BacklogHeadingDuplicate, LiveFinishedEntry, TeamAlert, AlertRole,
} from "./team-alert-shared.js";

/** Everything about the team that needs the operator, most urgent first: a spent budget, a red
 * main, roles failing run after run, roles that look stuck, a stale running build, open
 * questions, refused entries, a plan stalled by a Needs
 * review note, checks that flapped more than once in the last day, a stale or
 * oversized flake quarantine, a burst of post-merge review rejections, each a commit that
 * already reached main, a post-merge review one failed run from being dropped, a post-merge
 * review dropped after repeated failures, leaving its commit on main unreviewed, a main tip the
 * watch's five diff rules rejected, the team
 * waiting on capacity slots (workspace, provider or
 * check), parallel instances sharing a workspace pool smaller than the run cap, a plan
 * filed under the wrong backlog section, a duplicated
 * backlog section heading, finished history still under a live backlog file's `## Done` or
 * `## Fixed`, a Fixed record with a bad Validation gap trace, a pause, a
 * stopped team.
 * `now` is passed so a timed
 * pause's countdown agrees with the rest of the frame. */
export function teamAlerts(
  snap: Pick<
    StatusSnapshot,
    | "running"
    | "budget"
    | "build"
    | "paused"
    | "pausedUntil"
    | "pauseReason"
    | "quietHours"
    | "inQuietHours"
    | "disk"
    | "rootInstallDrift"
    | "noDeclaredCheck"
    | "noBrief"
    | "briefTruncated"
    | "roleNotesOverCap"
    | "principlesTruncated"
    | "chain"
    | "capPaused"
    | "budgetPausedRoles"
    | "maintenanceQuota"
    | "providerHolds"
    | "ciParity"
    | "mainCheck"
  >,
  questions: readonly string[],
  roles: readonly AlertRole[],
  now: number,
  refused: readonly RefusedEntry[] = [],
  planDependency: PlanDependencyProblem | null = null,
  stalledEntries: readonly StalledEntry[] = [],
  quarantined: QuarantinedTests | null = null,
  strandedPlans: readonly StrandedPlanEntry[] = [],
  duplicatedHeadings: readonly BacklogHeadingDuplicate[] = [],
  validationGaps: readonly ValidationGapProblem[] = [],
  contention: readonly CapacityBottleneck[] = [],
  flappedChecks: FlappedChecks | null = null,
  regressedFixes: RegressedFixAlert | null = null,
  postMergeChurn: PostMergeChurn | null = null,
  postReviewRisk: PostReviewRisk | null = null,
  droppedPostReviews: DroppedPostReviews | null = null,
  mainRuleFailure: MainRuleFailure | null = null,
  staleClaims: readonly ClaimState[] = [],
  staleQuestions: readonly StaleQuestion[] = [],
  fixClaims: readonly FixClaimProblem[] = [],
  qaCoverage: QaCoverageStale | null = null,
  workspacePins: readonly StaleWorkspacePin[] = [],
  liveFinished: readonly LiveFinishedEntry[] = [],
  instancePool: readonly string[] = [],
  providerCaps: readonly string[] = [],
): TeamAlert[] {
  const out: TeamAlert[] = [];
  out.push(...buildStatusAlerts({ snap, roles, staleClaims }));
  out.push(...buildBacklogAlerts({ questions, staleQuestions, refused, stalledEntries, planDependency, strandedPlans, duplicatedHeadings, liveFinished, validationGaps, fixClaims }));
  out.push(...buildMergeAlerts({ quarantined, flappedChecks, postMergeChurn, postReviewRisk, droppedPostReviews, mainRuleFailure, ciParity: snap.ciParity, qaCoverage, now }));
  out.push(...buildTailAlerts({ snap, now, contention, regressedFixes, roles, workspacePins, instancePool, providerCaps }));

  return out;
}

/** Does this alert ask something of the operator (red, amber, indigo), rather than inform? */
export function alertNeedsYou(alert: TeamAlert): boolean {
  return alert.tone === "red" || alert.tone === "amber" || alert.tone === "indigo";
}
