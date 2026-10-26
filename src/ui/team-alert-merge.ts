/** The quarantine, flapped-check, and post-merge review team alerts, in emission order: a stale
 * or oversized flake quarantine, checks flapping more than once, a burst of post-merge review
 * rejections, a post-merge review one failed run from being dropped, a post-merge review the
 * drain dropped leaves its commit on main unreviewed, a main tip the watch's diff rules
 * rejected, and the ci role's full suite stalled over three days without covering a new tip.
 * One of the per-domain builders split out of src/ui/team-alerts.ts; the shared types and
 * wording helpers live in team-alert-shared.ts. */

import { seeFailures, type TeamAlert, type QuarantinedTests, type FlappedChecks, type PostReviewRisk } from "./team-alert-shared.js";
import type { StatusSnapshot } from "../status/status-data.js";
import type { DroppedPostReviews, MainRuleFailure, PostMergeChurn, QaCoverageStale } from "./status-payload.js";
import { CI_PARITY_STALE_MS, ciParityStalled } from "../run/ci-parity.js";
import { QA_COVERAGE_STALE_MS } from "../run/qa-coverage.js";
import { plural } from "../text/phrases.js";
import { humanAgo, DAY_MS } from "../text/datetime.js";
import { squash } from "../text/text.js";
import { roleLabel } from "../roles/role-labels.js";
import { shortSha } from "../text/format.js";

interface MergeAlertsInput {
  quarantined: QuarantinedTests | null;
  flappedChecks: FlappedChecks | null;
  postMergeChurn: PostMergeChurn | null;
  postReviewRisk: PostReviewRisk | null;
  droppedPostReviews: DroppedPostReviews | null;
  mainRuleFailure: MainRuleFailure | null;
  ciParity?: StatusSnapshot["ciParity"];
  qaCoverage?: QaCoverageStale | null;
  now: number;
}

// A stale or oversized flake quarantine — the always-on twin of the doctor's `flaky checks`
// row (main-guardrails.ts checkFlakyChecks, quarantineWarning): a quarantined test counts as
// a known failure until its filed bug leaves BUGS.md `## Open`, so an old entry means the
// team is merging on a suite whose red is being excused. alert-feeds.ts's quarantineAlert
// feeds it from the same quarantineWarning the doctor calls, so the alert and the doctor
// cannot drift on when the list is a problem; the warning phrase and the oldest test's age
// are shown, folded through squash like other long names.
function pushQuarantineAlert(out: TeamAlert[], quarantined: QuarantinedTests | null, now: number): void {
  if (quarantined) {
    out.push({
      key: "quarantine",
      tone: "amber",
      title: `${plural(quarantined.count, "test")} in the flake quarantine — the gate is excusing their failures`,
      detail:
        `${quarantined.warning} · oldest: ${squash(quarantined.oldestTest, 80)} (${humanAgo(quarantined.oldestFirstSeen, now)}) — a quarantined test counts as a known failure until its filed bug leaves BUGS.md \`## Open\`, so fix the test or file the missing bug`,
      actions: seeFailures(),
    });
  }
}

// Checks that flapped more than once in the last day — the always-on twin of the doctor's
// `flaky checks` row (doctor-project-checks.ts checkFlakyChecks): the gate's single re-run
// absorbs a one-off flake, but a check flapping twice silently pays that re-run on every
// merge it touches, so the tally belongs on every observer surface while it happens.
// alert-feeds.ts's flappedChecksAlert feeds it from the same repeatedFlakeCounts and
// flappedChecksPhrase the doctor calls, so the alert and the doctor cannot drift on the
// count or the wording.
function pushFlappedChecksAlert(out: TeamAlert[], flappedChecks: FlappedChecks | null): void {
  if (flappedChecks) {
    out.push({
      key: "flapped-checks",
      tone: "amber",
      title: `${plural(flappedChecks.count, "check has", "checks have")} flapped more than once in the last day`,
      detail: `${flappedChecks.detail} — a flapping check pays the gate's one re-run on every merge it touches; fix it or file it with \`tumwater bug\``,
      actions: seeFailures(),
    });
  }
}

// Last day's post-merge review rejections — the reviewer-fix signal for the `review.afterMerge`
// tiering (src/review/post-merge-review.ts `reviewMergedCommit`). A post-merge rejection is the
// costly kind: the commit already reached main, so the rejection is answered only by the
// reviewer's own fix, and the always-on signal for a day crossing POST_MERGE_REJECT_WARN is
// this alert. alert-feeds.ts's postMergeChurnAlert feeds it
// from the same `afterMerge: true` `review_rejected` events the report's
// postMergeRejectionsByRole folds, so the alert and the report cannot disagree on which
// rejections are post-merge.
function pushPostMergeChurnAlert(out: TeamAlert[], postMergeChurn: PostMergeChurn | null): void {
  if (postMergeChurn) {
    out.push({
      key: "post-merge-churn",
      tone: "amber",
      title: `${plural(postMergeChurn.count, "post-merge review rejection", "post-merge review rejections")} in the last day`,
      detail: `${postMergeChurn.roles.map((r) => `${roleLabel(r.role)} ×${r.count}`).join(", ")} — each commit already reached main and stays there with the reviewer's recorded reasons (never re-reviewed — Forward, never back); narrow \`review.afterMerge\` for the noisy role or raise the authoring bar`,
      actions: seeFailures(),
    });
  }
}

// A post-merge review one failed run from being dropped — the always-on twin of the doctor's
// `post-merge reviews` row (src/doctor/doctor-backlog.ts checkPostReviews) — the last moment
// an operator can fix the reviewer backend or deliberately accept the commit unreviewed.
// postReviewRiskAlert feeds it from the same atRiskPostReviews traversal and phrase the doctor
// calls, so the alert and the doctor cannot drift on the trigger or the wording.
function pushPostMergeRiskAlert(out: TeamAlert[], postReviewRisk: PostReviewRisk | null): void {
  if (postReviewRisk) {
    out.push({
      key: "post-merge-risk",
      tone: "amber",
      title: `${plural(postReviewRisk.count, "post-merge review is", "post-merge reviews are")} one failed run from being dropped`,
      detail: postReviewRisk.detail,
      actions: seeFailures(),
    });
  }
}

// A post-merge review the drain actually dropped — the commit it leaves on main unreviewed
// (src/merge/merge-post-review-drain.ts `startPostReview` at POST_REVIEW_FAILURE_LIMIT).
// Reads only the `warning` event the drop branch writes, after the at-risk alert is moot:
// the entry is gone, so no surface names the commit without this.
// droppedPostReviewsAlert feeds it from the same DROPPED_POST_REVIEW_MARKER the drain's
// cannot drift on what a drop is (the per-run failed-review warning never matches).
function pushDroppedPostReviewsAlert(out: TeamAlert[], droppedPostReviews: DroppedPostReviews | null, now: number): void {
  if (droppedPostReviews) {
    out.push({
      key: "dropped-post-reviews",
      tone: "amber",
      title: `${plural(droppedPostReviews.count, "post-merge review was dropped", "post-merge reviews were dropped")} in the last day — ${plural(droppedPostReviews.count, "the commit sits", "the commits sit")} on main unreviewed`,
      detail: `most recently ${humanAgo(droppedPostReviews.latestTs, now)}: ${squash(droppedPostReviews.latestMessage, 160)} — the reviewer kept failing past \`POST_REVIEW_FAILURE_LIMIT\`, so the commit is beyond the review gate; fix the reviewer backend so later commits are reviewed`,
      actions: [{ label: "See failures", act: "view", arg: "failures" }],
    });
  }
}

// A main tip the watch's five diff rules rejected in the trailing day — the always-on
// surface for the `warning` main-watch.ts's `watchRules` logs (`main's tip <short sha> fails
// the diff rules: <reason>`). The gate judges one change; the watch judges each first-parent
// commit's own diff, so a conflict marker, a protected edit, a leaked secret, a phantom fix
// claim or a broken backlog structure that reached main through a gate blind spot sits on
// main with only that event log to say so. alert-feeds.ts's mainRuleFailures feeds it
// from the same marker, so the alert and the watch cannot drift on what a rule failure is (a
// `main_check` or `review_rejected` carrying the same text never matches).
function pushMainDiffRulesAlert(out: TeamAlert[], mainRuleFailure: MainRuleFailure | null, now: number): void {
  if (mainRuleFailure) {
    out.push({
      key: "main-diff-rules",
      tone: "amber",
      title: `${plural(mainRuleFailure.count, "diff-rule failure on main", "diff-rule failures on main")} in the last day`,
      detail: `most recently ${humanAgo(mainRuleFailure.latestTs, now)}: ${squash(mainRuleFailure.latestMessage, 160)} — the gate approved a diff the watch's five rules reject, so main carries what the gate would refuse; repair the tip or revert it with \`tumwater revert <sha>\``,
      actions: seeFailures(),
    });
  }
}

// The ci role's full suite silently stopped covering new tips — the always-on twin of the
// doctor's `ci parity` row (doctor-project-checks.ts checkCiParity), read from the same
// ciParityStalled predicate and CI_PARITY_STALE_MS threshold so the alert and the row cannot
// disagree on when a post-merge gap is a stall. A `stale` record is normal right after a
// merge (main moves on every merge and the role runs on its own clock), but one that stays
// stale past three days means the role that is now the full suite's own runner has silently
// stopped covering new tips (disabled, paused, wedged, or failing before it records). The
// fix is a role toggle the role drawer already has, so there is no action button here.
function pushCiStaleAlert(out: TeamAlert[], ciParity: StatusSnapshot["ciParity"], now: number): void {
  if (ciParity && ciParityStalled(ciParity, now)) {
    out.push({
      key: "ci-stale",
      tone: "amber",
      title: `main's full suite has not covered a tip in over ${CI_PARITY_STALE_MS / DAY_MS} days`,
      detail: `the ci role's last full-suite run covered ${shortSha(ciParity.covered)} ${humanAgo(
        ciParity.lastRunAt,
        now,
      )}; main has moved since, so no full-suite run covers the current tip — the ci role is disabled, paused, or unable to record; resume or enable it, or check \`tumwater doctor\``,
      actions: [],
    });
  }
}

// The qa role's flow coverage silently stopped advancing — the always-on twin of the
// doctor's `qa coverage` row (doctor-project-checks.ts checkQaCoverage), fed from the same
// qaCoverageStalled predicate via alert-feeds.ts's qaCoverageAlert so the alert and the
// row cannot disagree on when a quiet qa is a stall. A missing ledger (no record yet) is not
// a stall, so this fires only once a recorded flow's newest exercise is over three days old —
// the team's only flow-level observer has silently stopped recording (disabled, paused,
// wedged, or failing before it records). The fix is a role toggle the role drawer already has,
// so there is no action button here.
function pushQaStaleAlert(out: TeamAlert[], qaCoverage: QaCoverageStale | null | undefined, now: number): void {
  if (qaCoverage) {
    out.push({
      key: "qa-stale",
      tone: "amber",
      title: `qa's flow coverage has not advanced in over ${QA_COVERAGE_STALE_MS / DAY_MS} days`,
      detail: `the qa role's newest flow ${qaCoverage.newestFlow} was exercised ${humanAgo(
        qaCoverage.newestAt,
        now,
      )}; coverage has not advanced since, so the qa role is disabled, paused, or unable to record; resume or enable it, or check \`tumwater doctor\``,
      actions: [],
    });
  }
}

/** The quarantine, flapped-check, and post-merge review alerts, in emission order: a
 * stale or oversized flake quarantine, checks flapping more than once, a
 * burst of post-merge review rejections, a post-merge review one failed run from being
 * dropped, a post-merge review the drain dropped leaves its commit on main unreviewed, a
 * main tip the watch's diff rules rejected, and the ci role's full suite stalled over three
 * days without covering a new tip.
 * Extracted from teamAlerts (part 4/5 of the teamAlerts split) so the shared module stays
 * small; the input names exactly the fields this run reads (including `now`, which the
 * quarantine and dropped-post-reviews age lines need). The caller pushes the returned alerts
 * at the position this run used to occupy, so the emitted key order is unchanged. */
export function buildMergeAlerts(input: MergeAlertsInput): TeamAlert[] {
  const out: TeamAlert[] = [];
  const { quarantined, flappedChecks, postMergeChurn, postReviewRisk, droppedPostReviews, mainRuleFailure, ciParity, qaCoverage, now } = input;
  pushQuarantineAlert(out, quarantined, now);
  pushFlappedChecksAlert(out, flappedChecks);
  pushPostMergeChurnAlert(out, postMergeChurn);
  pushPostMergeRiskAlert(out, postReviewRisk);
  pushDroppedPostReviewsAlert(out, droppedPostReviews, now);
  pushMainDiffRulesAlert(out, mainRuleFailure, now);
  pushCiStaleAlert(out, ciParity, now);
  pushQaStaleAlert(out, qaCoverage, now);
  return out;
}

