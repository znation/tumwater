import { deleteRef, headOf, patchId, removeLandWorktree } from "../git/git.js";
import { landingRefName } from "../paths.js";
import { recordReview } from "../tick/tick-apply.js";
import { saveLoopState } from "../loop/loop-state.js";
import { unverifiedTreeOutcome } from "../build/build-check-events.js";
import { checkFailureReasons } from "../build/build-check-report.js";
import { mainTipVerdict } from "../main-red.js";
import { logEvent } from "../events/events.js";
import { mainRedNotMine } from "../phrases.js";
import type { BuildCheckOutcome } from "../build/build-check.js";
import type { BuildCheck } from "../build/build-check-detect.js";
import type { TumwaterConfig } from "../config/config-schema.js";
import type { TickResult } from "../tick/tick-outcome.js";
import type { LoopState } from "../loop/loop-state.js";
import type { LanderContext } from "./landing-core.js";

/** Consecutive red in-lock landing checks of one patch (LoopState.landingCheckFailures) before
 * the landing is attributed instead of retried: the first red keeps the pin for one more
 * attempt — a load flake gets its retry, as the gate's pre-check gets one (PLANS.md land-queue
 * 1/3) — and the second is judged by main's own verdict at its tip (attributeRedCheck). Without
 * a limit a change whose gate passes but whose landing check fails (a cheaper check.gateCommand
 * than the full check) would re-queue as merge_blocked forever, its role never authoring. */
export const LANDING_CHECK_FAILURE_LIMIT = 2;

/** Tally one deterministic failure of the same patch toward attribution: read the worktree's
 * head and its patch-id against main, carry LoopState.landingCheckFailures's count across
 * re-lands of the identical patch (a clean rebase onto a moved main keeps the patch-id, so the
 * retries of one change add up while a different change starts fresh), and store the strike.
 * An unreadable patch-id cannot be matched, so it never reaches the limit: the pre-cap
 * behavior, never a wrong attribution. */
async function tallyCheckFailure(
  ctx: LanderContext,
  wt: string,
): Promise<{ head: string; patch: string | null; count: number }> {
  const head = await headOf(wt, "HEAD");
  const patch = await patchId(wt, ctx.mainBranch, head);
  const prior = ctx.state.landingCheckFailures;
  const count = (patch !== null && prior?.patchId === patch ? prior.count : 0) + 1;
  if (patch === null || count < LANDING_CHECK_FAILURE_LIMIT) {
    ctx.state.landingCheckFailures = patch === null ? undefined : { patchId: patch, count };
  } else {
    ctx.state.landingCheckFailures = undefined;
  }
  return { head, patch, count };
}

/** The terminal deterministic-reject sink shared by landingBlocked and attributeRedCheck:
 * record the reject review, reset the unreviewed-failure streak, persist state, delete the
 * landing ref, release the disposable lander worktree when one is held, and log
 * review_rejected. Returns "rejected". review.ts's reject path is a different sink — it
 * resets the branch instead of deleting the ref — and keeps its own copy deliberately. */
async function rejectChange(
  ctx: { root: string },
  role: string,
  head: string,
  reasons: string[],
  state: LoopState,
  wt?: string,
): Promise<TickResult> {
  recordReview(state, "reject", reasons, head);
  state.unreviewFailures = 0;
  saveLoopState(ctx.root, state);
  await deleteRef(ctx.root, landingRefName(role));
  if (wt) await removeLandWorktree(ctx.root, wt);
  logEvent(ctx.root, { loop: role, type: "review_rejected", head, reasons });
  return "rejected";
}

/** A landing blocked because its in-lock check went red on the rebased tree (landing-merge.ts's
 * verifyLanding). The count is keyed by the patch-id; under LANDING_CHECK_FAILURE_LIMIT the
 * pin is kept (merge_blocked) for recovery's re-land; at the limit the red is attributed like
 * any single-change red. The other merge_blocked causes — a fast-forward that fails on a dirty
 * primary checkout, or main moving under the ff — are never the change's fault and never
 * counted. An unverified red made no verdict about the tree — the run spanned a host sleep
 * (BUGS.md 2026-09-30) — so it is not a strike against the patch: the pin stays for the next
 * attempt and the lastError names the sleep instead of a test failure. */
export async function landingCheckRed(
  ctx: LanderContext,
  role: string,
  wt: string,
  red: { check: BuildCheck; outcome: BuildCheckOutcome },
): Promise<TickResult> {
  if (unverifiedTreeOutcome(red.outcome)) {
    ctx.state.lastError = `merge failed: ${checkFailureReasons(red.check, red.outcome)[0]}`;
    return "merge_blocked";
  }
  const { head, patch, count } = await tallyCheckFailure(ctx, wt);
  if (patch === null || count < LANDING_CHECK_FAILURE_LIMIT) {
    ctx.state.lastError = `merge failed: merge_blocked — ${checkFailureReasons(red.check, red.outcome)[0]}`;
    return "merge_blocked";
  }
  return attributeRedCheck(ctx, role, head, "landing check", red, ctx.state, wt);
}

/** A landing blocked by a deterministic cross-check (onLandingBlocked's fix-claim or
 * backlog-structure reason — a property of the tree ahead of main, not a flaky run). The
 * block is counted like a red landing check, keyed by the same patch-id: under
 * LANDING_CHECK_FAILURE_LIMIT the pin is kept for one recovery re-land — main may have moved
 * under the rebase, and a differently-rebased tree can pass the cross-check — but at the
 * limit the block is attributed to the change: rejected deterministically with the block
 * reason, the pin deleted, no model run. Without this a resolution that trips the same
 * cross-check on every re-resolve pays a fresh conflict-resolver run each tick, forever
 * (BUGS.md 2026-10-02: five resolver sessions for one fix-claim-blocked pin). */
export async function landingBlocked(
  ctx: LanderContext,
  role: string,
  wt: string,
  blocked: string,
): Promise<TickResult> {
  const { head, patch, count } = await tallyCheckFailure(ctx, wt);
  if (patch === null || count < LANDING_CHECK_FAILURE_LIMIT) {
    ctx.state.lastError = `merge failed: merge_blocked — ${blocked}`;
    return "merge_blocked";
  }
  return rejectChange(ctx, role, head, [`landing blocked: ${blocked}`], ctx.state, wt);
}

/** Attribute a check that went red over ONE change's tree after its vet approved it — a batch
 * bisect's last step (landing-batch.ts), or a single landing's in-lock check at
 * LANDING_CHECK_FAILURE_LIMIT — by the gate's rule (PLANS.md land-queue 1/3): ask main's own
 * verdict at its current tip (mainTipVerdict — usually a cache hit, since every landing seeds
 * the SHA it moved main to). Main green → the change broke the check: rejected deterministically
 * — reasons in lastReview for the author's next tick, the strike count reset, ref deleted,
 * review_rejected logged, no pi run. Main red → not this change's failure: "main_red" with the
 * ref kept and unreviewFailures untouched, so recovery re-lands it once main-red.ts's repair
 * turns main green. No verdict → reject, the safe default, and the reasons say so. The verdict
 * is persisted before it returns. */
export async function attributeRedCheck(
  ctx: { root: string; mainBranch: string; config: TumwaterConfig },
  role: string,
  head: string,
  label: "batch check" | "landing check",
  red: { check: BuildCheck; outcome: BuildCheckOutcome },
  state: LoopState,
  wt?: string,
): Promise<TickResult> {
  // An unverified red — a run that spanned a host sleep, the tree never judged — is not the
  // change's failure and not a strike: keep the ref for recovery's re-land and name the sleep
  // (BUGS.md 2026-09-30). Main's own verdict is beside the point: the attribution question is
  // only live when the check produced a verdict.
  if (unverifiedTreeOutcome(red.outcome)) {
    state.lastError = `${label}: ${checkFailureReasons(red.check, red.outcome)[0]}`;
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
    reasons.push(`main's own baseline was unavailable (${main.why}), so the red ${label} is attributed to this change`);
  }
  // Terminal rejection: the sink releases the disposable lander worktree too, matching the
  // other rejected/discarded sinks (reviewPinnedChange, landApprovedChange).
  return rejectChange(ctx, role, head, reasons, state, wt);
}