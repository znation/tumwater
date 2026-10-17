// vocabulary: plain
import { deleteRef, headOf, patchId } from "../git/git.js";
import { mergeRefName } from "../paths.js";
import { recordReview } from "../tick/tick-apply.js";
import { saveLoopState, type LoopState } from "../loop/loop-state.js";
import { unverifiedTreeOutcome } from "../build/build-check-events.js";
import { checkFailureReasons, describeCheck, failureHeadline } from "../build/build-check-report.js";
import { mainTipVerdict } from "../baseline/main-red.js";
import { logEventBestEffort, warnEventBestEffort } from "../events/events.js";
import { mainRedNotMine } from "../text/phrases.js";
import { normalizeClusterKey } from "../failure/failure-cluster.js";
import { MERGE_FLAKY_WARNING_PREFIX, isKnownFlake } from "../review/known-flakes.js";
import type { BuildCheckOutcome } from "../build/build-check.js";
import type { BuildCheck } from "../build/build-check-detect.js";
import type { TumwaterConfig } from "../config/config-schema.js";
import type { TickResult } from "../tick/tick-outcome.js";
import type { LanderContext } from "./merge-core.js";

/** Consecutive red in-lock merge checks of one patch (LoopState.mergeCheckFailures) before
 * the merge is attributed instead of retried: the first red keeps the pin for one more
 * attempt — a load flake gets its retry, as the gate's pre-check gets one (PLANS.md land-queue
 * 1/3) — and the second is judged by main's own verdict at its tip (attributeRedCheck). Without
 * a limit a change whose gate passes but whose merge check fails (a cheaper check.gateCommand
 * than the full check) would re-queue as merge_blocked forever, its role never authoring. */
export const MERGE_CHECK_FAILURE_LIMIT = 2;

/** Whether a deterministic failure keeps its pin for one more re-merge instead of being
 * attributed to the change: always when the patch-id could not be read (it cannot be matched
 * to a prior strike, so it never reaches MERGE_CHECK_FAILURE_LIMIT — the pre-cap behavior,
 * never a wrong attribution), otherwise while the strike count is still under the limit. The
 * one home of that rule: tallyCheckFailure's strike store and keepPinOrAttribute's
 * keep-or-attribute branch both read it, so the two cannot disagree on when the limit is
 * reached. */
function pinKept(patch: string | null, count: number): boolean {
  return patch === null || count < MERGE_CHECK_FAILURE_LIMIT;
}

/** Tally one deterministic failure of the same patch toward attribution: read the worktree's
 * head and its patch-id against main, carry LoopState.mergeCheckFailures's count across
 * re-merges of the identical patch (a clean rebase onto a moved main keeps the patch-id, so the
 * retries of one change add up while a different change starts fresh), and store the strike.
 * An unreadable patch-id cannot be matched, so pinKept never counts it toward the limit.
 * Keeping the strike only under the limit (pinKept) is what ends the streak at attribution. */
async function tallyCheckFailure(
  ctx: LanderContext,
  wt: string,
): Promise<{ head: string; patch: string | null; count: number }> {
  const head = await headOf(wt, "HEAD");
  const patch = await patchId(wt, ctx.mainBranch, head);
  const prior = ctx.state.mergeCheckFailures;
  const count = (patch !== null && prior?.patchId === patch ? prior.count : 0) + 1;
  if (pinKept(patch, count)) {
    ctx.state.mergeCheckFailures = patch === null ? undefined : { patchId: patch, count };
  } else {
    ctx.state.mergeCheckFailures = undefined;
  }
  return { head, patch, count };
}

/** The shared re-merge rule of the two deterministic-block paths below (mergeCheckRed and
 * mergeBlocked): tally the strike on this patch (tallyCheckFailure), then either keep the
 * pin for one more attempt — merge_blocked with `reason` named in lastError — or hand the head
 * to the caller's terminal sink `attribute`. Both paths decide keep-vs-attribute through
 * pinKept, so the MERGE_CHECK_FAILURE_LIMIT rule has one home. */
async function keepPinOrAttribute(
  ctx: LanderContext,
  wt: string,
  reason: string,
  attribute: (head: string) => Promise<TickResult>,
): Promise<TickResult> {
  const { head, patch, count } = await tallyCheckFailure(ctx, wt);
  if (pinKept(patch, count)) {
    ctx.state.lastError = `merge failed: merge_blocked — ${reason}`;
    return "merge_blocked";
  }
  return attribute(head);
}

/** The terminal deterministic-reject sink shared by mergeBlocked and attributeRedCheck:
 * record the reject review, reset the unreviewed-failure streak, persist state, delete the
 * merge ref, and log review_rejected. The shared `_merge` checkout is left in place
 * (plans/worktree-pool.md, part 2c): it persists across merges like `_gate-main`, and a
 * rejection discards the pinned ref, not the checkout. Returns "rejected". review.ts's reject
 * path is a different sink — it resets the branch instead of deleting the ref — and keeps its
 * own copy deliberately. */
async function rejectChange(
  ctx: { root: string },
  role: string,
  head: string,
  reasons: string[],
  state: LoopState,
): Promise<TickResult> {
  recordReview(state, "reject", reasons, head);
  state.unreviewFailures = 0;
  saveLoopState(ctx.root, state);
  await deleteRef(ctx.root, mergeRefName(role));
  logEventBestEffort(ctx.root, { source: role, type: "review_rejected", head, reasons });
  return "rejected";
}

/** The one-line reason a red check's lastError carries: checkFailureReasons' first entry (it
 * always returns at least one). Shared by the blocked-merge paths below — mergeCheckRed's
 * two branches and attributeRedCheck's unverified branch — so the "name the red by its first
 * reason" rule has one home while the full reason list stays where a whole review needs it
 * (attributeRedCheck's reject reasons). */
function firstCheckReason(red: { check: BuildCheck; outcome: BuildCheckOutcome }): string {
  return checkFailureReasons(red.check, red.outcome)[0]!;
}

/** A merge blocked because its in-lock check went red on the rebased tree (merge-to-main.ts's
 * verifyMerge). The count is keyed by the patch-id; under MERGE_CHECK_FAILURE_LIMIT the
 * pin is kept (merge_blocked) for recovery's re-merge; at the limit the red is attributed like
 * any single-change red. The other merge_blocked causes — a fast-forward that fails on a dirty
 * primary checkout, or main moving under the ff — are never the change's fault and never
 * counted. An unverified red made no verdict about the tree — the run spanned a host sleep
 * (BUGS.md 2026-09-30) — so it is not a strike against the patch: the pin stays for the next
 * attempt and the lastError names the sleep instead of a test failure. */
export async function mergeCheckRed(
  ctx: LanderContext,
  role: string,
  wt: string,
  red: { check: BuildCheck; outcome: BuildCheckOutcome },
): Promise<TickResult> {
  if (unverifiedTreeOutcome(red.outcome)) {
    ctx.state.lastError = `merge failed: ${firstCheckReason(red)}`;
    return "merge_blocked";
  }
  const reason = firstCheckReason(red);
  let attributed = false;
  const result = await keepPinOrAttribute(ctx, wt, reason, (head) => {
    attributed = true;
    return attributeRedCheck(ctx, role, head, "merge check", red, ctx.state);
  });
  // The first red of a patch's in-lock check is exactly the retry that exists for load flakes,
  // so it is the ONE signal that could name a flaky test after the fact — and lastError, the
  // only place this reason is written, is overwritten by the leftover-recovery tick a second
  // later (BUGS.md 2026-10-14). Log it as a warning so the failure digest and a later audit can
  // name the flaky test; the second red at MERGE_CHECK_FAILURE_LIMIT is attributed through
  // review_rejected, whose reasons are already durable.
  if (result === "merge_blocked" && !attributed) {
    warnEventBestEffort(ctx.root, role, `merge check failed (kept for one retry): ${reason}`);
    if (ctx.state.mergeCheckFailures) {
      ctx.state.mergeCheckFailures.headline = failureHeadline(red.outcome.outputTail) ?? describeCheck(red.check);
    }
  }
  return result;
}

/** Record a merge check that failed and then passed on its kept-pin retry as a flake, in the
 * form the gate's pre-check uses (MERGE_FLAKY_WARNING_PREFIX), so the gate's known-flake memory,
 * doctor's `flaky checks` and the tick prompt's flake note count it (PLANS.md 2026-10-16). Reads
 * the headline mergeCheckRed stored on the strike record only when its patch-id is the merged
 * pin's (a stale strike of a discarded pin must not be logged); a pin that was never red (or
 * only cross-check blocked) has none and logs nothing. Call before the strike is cleared. */
export function noteMergeRetryPassed(
  ctx: LanderContext,
  role: string,
  pinPatch: string | null,
): void {
  const strike = ctx.state.mergeCheckFailures;
  const headline = strike?.patchId === pinPatch ? strike?.headline : undefined;
  if (headline) warnEventBestEffort(ctx.root, role, MERGE_FLAKY_WARNING_PREFIX + headline);
}

/** A merge blocked by a deterministic cross-check (onMergeBlocked's fix-claim or
 * backlog-structure reason — a property of the tree ahead of main, not a flaky run). The
 * block is counted like a red merge check, keyed by the same patch-id: under
 * MERGE_CHECK_FAILURE_LIMIT the pin is kept for one recovery re-merge — main may have moved
 * under the rebase, and a differently-rebased tree can pass the cross-check — but at the
 * limit the block is attributed to the change: rejected deterministically with the block
 * reason, the pin deleted, no model run. Without this a resolution that trips the same
 * cross-check on every re-resolve pays a fresh conflict-resolver run each tick, forever
 * (BUGS.md 2026-10-02: five resolver sessions for one fix-claim-blocked pin). */
export async function mergeBlocked(
  ctx: LanderContext,
  role: string,
  wt: string,
  blocked: string,
): Promise<TickResult> {
  return keepPinOrAttribute(ctx, wt, blocked, (head) =>
    rejectChange(ctx, role, head, [`merge blocked: ${blocked}`], ctx.state),
  );
}

/** Attribute a check that went red over ONE change's tree after its verify approved it — a batch
 * bisect's last step (merge-batch.ts), or a single merge's in-lock check at
 * MERGE_CHECK_FAILURE_LIMIT — by the gate's rule: ask main's own
 * verdict at its current tip (mainTipVerdict — usually a cache hit, since every merge seeds
 * the SHA it moved main to). Main green → the change broke the check: rejected deterministically
 * — reasons in lastReview for the author's next tick, the strike count reset, ref deleted,
 * review_rejected logged, no pi run. Main red → not this change's failure: "main_red" with the
 * ref kept and unreviewFailures untouched, so recovery re-merges it once main-red.ts's repair
 * turns main green. No verdict → reject, the safe default, and the reasons say so. The verdict
 * is persisted before it returns. A red whose headline matches a flake the gate or a merge
 * retry recorded (isKnownFlake) is excused once per headline per pin (LoopState.mergeFlakeExcused):
 * "merge_blocked" with the ref kept, before main's verdict, because that verdict is usually a
 * cached green that would reject a change over a flaky test (PLANS.md 2026-10-16, BUGS.md
 * 2026-10-06). A repeat of the same headline is attributed as above. */
export async function attributeRedCheck(
  ctx: { root: string; mainBranch: string; config: TumwaterConfig },
  role: string,
  head: string,
  label: "merge check",
  red: { check: BuildCheck; outcome: BuildCheckOutcome },
  state: LoopState,
): Promise<TickResult> {
  // An unverified red — a run that spanned a host sleep, the tree never judged — is not the
  // change's failure and not a strike: keep the ref for recovery's re-merge and name the sleep
  // (BUGS.md 2026-09-30). Main's own verdict is beside the point: the attribution question is
  // only live when the check produced a verdict.
  if (unverifiedTreeOutcome(red.outcome)) {
    state.lastError = `${label}: ${firstCheckReason(red)}`;
    saveLoopState(ctx.root, state);
    return "merge_blocked";
  }
  const headline = failureHeadline(red.outcome.outputTail) ?? describeCheck(red.check);
  const key = normalizeClusterKey(headline);
  if (isKnownFlake(ctx.root, headline) && state.mergeFlakeExcused !== key) {
    state.mergeFlakeExcused = key;
    state.lastError = `${label} failed: known-flaky failure, merge kept: ${headline}`;
    warnEventBestEffort(ctx.root, role, `${label}: known-flaky failure, merge kept: ${headline}`);
    saveLoopState(ctx.root, state);
    return "merge_blocked";
  }
  const main = await mainTipVerdict(ctx.root, role, ctx.mainBranch, ctx.config);
  if (main.status === "red") {
    state.lastError = `${label} failed: ${mainRedNotMine(main.sha)}`;
    saveLoopState(ctx.root, state);
    return "main_red";
  }
  const reasons = checkFailureReasons(red.check, red.outcome);
  if (main.status === "unavailable") {
    reasons.push(`main's own baseline was unavailable (${main.why}), so the failed ${label} is attributed to this change`);
  }
  // Terminal rejection: the sink deletes the pin; the shared `_merge` checkout persists.
  return rejectChange(ctx, role, head, reasons, state);
}
