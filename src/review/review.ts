import type { TumwaterConfig } from "../config/config-schema.js";
import type { RunnerState } from "../runner/runner-state.js";
import { logEventBestEffort, warnEventBestEffort } from "../events/events.js";
import { changeBaseRev, headOf, patchId } from "../git/git.js";
import { aheadOfMainFiles } from "../git/git-diff.js";
import type { PriorReview } from "../merge/merge-queue.js";
import { resetWorktreeToMain } from "../git/worktree.js";
import type { PiRunResult } from "../pi/pi-run-result.js";
import type { GateRunsPi } from "../runner/runner-pi.js";
import { recordReview } from "../run/run-apply.js";
import { reviewedAfterMerge } from "../config/config-views.js";
import { errorMessage, parseNonNegativeInt } from "../text/text.js";
import { firstReason } from "../text/phrases.js";
import type { SleepSampler } from "../build/host-sleep.js";
import { isExemptDiff } from "./exemptions.js";
import { idleWithoutProviderLease } from "../concurrency/provider-lease.js";
import { setMergeStage } from "../merge/merge-slot.js";
import type { SlotLeaseHandle } from "../git/worktree-pool.js";
import { gateBuildPrecheck } from "./review-precheck.js";
import { diffRuleReasons } from "./diff-rules.js";

export { REVIEW_FAILURE_LIMIT } from "./review-run.js";
import { restoreReviewedHead, runReviewer, withRuns } from "./review-run.js";


/** Everything reviewAheadOfMain needs from its caller (a RoleRunner run or recovery). */
export interface ReviewContext {
  root: string;
  role: string;
  /** The author's worktree, post-commit — the reviewer reads the full tree there. */
  wt: string;
  mainBranch: string;
  config: TumwaterConfig;
  /** Current run number, for the unique per-run session name. */
  runNumber: number;
  /** This review's own per-run directory (reviewRunSessionDir in paths.ts). Unique per
   * review of one change, so continuing the run — a verdict/nudge follow-up now, a resumed
   * timed-out review later — reaches exactly this run's session. A resumed attempt uses the
   * marker's directory instead, and its follow-up turns follow whichever one the run used. */
  sessionDir: string;
  signal?: AbortSignal;
  /** Cap for the deterministic build pre-check run; defaults to BUILD_CHECK_TIMEOUT_MS.
   * A test seam — production callers leave it unset. */
  buildCheckTimeoutMs?: number;
  /** The sleep clock the pre-check measures host suspension with; defaults to the real
   * sampleSleepClock. A test seam — production callers leave it unset. */
  sampleSleep?: SleepSampler;
  /** The revision round this merge is, absent for a fresh change — labeled on `review_start`
   * and paired with `priorReview` (plans/revise-rejected.md part 2/2). */
  revisionRound?: number;
  /** The rejected change's head and objections when this merge is a revision, absent
   * otherwise: built from the merge entry's PriorReview and used to show the re-review what
   * the revision had to resolve. A recovery merge carries none. */
  priorReview?: PriorReview;
  /** The reviewer's pi runs (the review run and the verdict follow-up), through the owning
   * runner's shared transient-retry wiring (RunnerPi.runGatePi — BUGS.md 2026-10-01: a 429 in the
   * gate gets the same retry as an authoring run). Every caller supplies it; the tests'
   * gateCtx wires the bare runPi so the offline fake-pi shim still drives the reviewer. */
  runGatePi: GateRunsPi["runGatePi"];
  /** Folds the usage of a reviewer attempt that is retried in place (the final attempt's runs
   * are folded by the caller). Absent in tests that ignore usage. */
  foldUsage?: (run: PiRunResult) => void;
  /** Whether the reviewer's provider is held; a retry waits for the hold to lift instead of
   * spending one of its retries. */
  reviewHeld?: () => boolean;
  /** Leases a second pool slot at `ref` without waiting, or resolves null when none is free: the
   * gate check then runs there alongside the reviewer instead of before it (Fast merge part 12).
   * Absent (the run path, most tests) the check runs first, as it always did. */
  leaseCheckSlot?: (ref: string) => Promise<SlotLeaseHandle | null>;
  /** In-place retries of a failed reviewer run; defaults to 2. A test seam. */
  retries?: number;
  /** The pause before an in-place retry; defaults to 30 s. A test seam. */
  retryDelayMs?: number;
}

/** What the gate decided and what the caller should do next. "approved"/"exempt": safe to
 * merge (the work was reviewed, or needed no review). "rejected"/"failed": already handled
 * per policy (branch reset / commit left for retry) — never merge. */
export interface GateResult {
  decision: "approved" | "exempt" | "rejected" | "failed";
  /** The branch HEAD this gate invocation's pre-check just ran green on — the one tree the
   * merge path may trust without re-running the check (src/merge/merge-to-main.ts seeds the
   * red-main baseline with it when the rebase is a no-op, and re-verifies anything else). Absent
   * when no fresh green observation was made: gate disabled, exempt diff, already-approved early
   * return, or a pre-check that failed or skipped. */
  verifiedHead?: string;
  /** The reviewer run was killed by harness shutdown mid-review: fail closed, leave the
   * commit, and let the run report aborted (resume re-reviews via the combined diff). */
  aborted?: boolean;
  /** The strike-cap discard fired: the gate itself reset the worktree off the reviewed head,
   * so the commit is gone and any pin naming the old head must go too. An under-cap failure
   * leaves this absent — its commit stays for re-review. The discard is invisible in the
   * decision alone, which is the same "failed" shape an under-cap failure reports. */
  discarded?: boolean;
  /** The pre-check failed twice on a tree whose main is red at its tip ("failed"): not this
   * change's failure, so its merge reports `main_red` — pin kept, no strike, and none of the
   * error streak a dead reviewer backend feeds (the batch's own attribution says the same). */
  mainRed?: boolean;
  /** The pre-check's every attempt spanned a host sleep, so nothing judged the tree
   * ("failed"): not this change's failure either — its merge keeps the pin for a re-merge
   * with no strike, and the detail names the sleep (BUGS.md 2026-09-30). */
  unverified?: boolean;
  /** Failure message ("failed") or first rejection reason ("rejected"), for lastSummary. */
  detail?: string;
  /** The failure was a permanent provider configuration error (a 4xx other than 408/429, or
   * the provider's model_not_supported/invalid_request_error spelling): the request can never
   * succeed until the config changes. The merge path holds the pin instead of re-queuing it
   * at suite speed (BUGS.md 2026-10-06). Absent on every other failure. */
  configError?: boolean;
  /** The reviewer's pi run, for usage folding into the runner totals — absent when no review
   * ran (gate disabled, exempt diff, or an already-approved HEAD or patch). */
  run?: PiRunResult;
  /** The follow-up turn that recovered (or failed to recover) a missing VERDICT line, when
   * one ran — folded into the runner totals by the caller right after `run`. Absent when the
   * reviewer's own reply parsed (no follow-up needed) or there was no session to continue. */
  followUpRun?: PiRunResult;
  /** The no-re-run nudge turn (requestNoRerun, BUGS.md 2026-10-02), when one ran — folded
   * into the runner totals like followUpRun. Absent when the reviewer never broke the
   * no-re-run rule (or there was no session to continue). */
  nudgeRun?: PiRunResult;
  /** Internal to reviewAheadOfMain: the attempt failed in a way worth retrying in place. Never
   * set on a result the wrapper returns. */
  retryable?: boolean;
}

/** In-place retries of a failed reviewer run within one verify, after the first run. */
const REVIEW_RETRIES = 2;
/** The pause before each retry (ReviewContext.retryDelayMs overrides it in tests). */
const REVIEW_RETRY_DELAY_MS = 30_000;
/** Overrides the pause for tests that drive a whole runner or orchestrator, where no context
 * reaches the review. */
const REVIEW_RETRY_DELAY_ENV = "TUMWATER_REVIEW_RETRY_DELAY_MS";

/** The pause before each retry: the context override wins; else the tunable env knob read through
 * the shared plain-decimal rule (parseNonNegativeInt — a 0 ms delay, the test-suite's setting, is
 * valid). A malformed spelling falls back to REVIEW_RETRY_DELAY_MS rather than silently becoming
 * NaN: `sleepUnlessAborted(NaN)` resolves at ~0 ms and the retries would fire back-to-back instead
 * of 30 s apart. */
export function reviewRetryDelayMs(ctxRetryDelayMs: number | undefined): number {
  const raw = process.env[REVIEW_RETRY_DELAY_ENV];
  return ctxRetryDelayMs ?? (raw === undefined ? REVIEW_RETRY_DELAY_MS : (parseNonNegativeInt(raw) ?? REVIEW_RETRY_DELAY_MS));
}

/** Per-verify state shared by a review's attempts: the attempt number the `review_failed` event
 * carries, the retries still allowed, and the first attempt's green pre-check. */
export interface ReviewRetry {
  attempt: number;
  retriesLeft: number;
  pre?: { verifiedHead?: string; knownMainFailures?: string[] };
}

/** A gate check running in a second leased checkout while the reviewer runs (Fast merge part 12).
 * `gate` settles with the pre-check's result and frees the lease; a check that did not pass
 * aborts `abort`, which stops the reviewer run. */
export interface CheckOverlap {
  gate: Promise<Awaited<ReturnType<typeof gateBuildPrecheck>>>;
  abort: AbortController;
  /** Set once the check settled. */
  done: boolean;
  /** The reasons of a rejection the check reached: reviewAttempt applies it through its reject
   * path once the reviewer has stopped touching the tree. */
  rejectedReasons?: string[];
}

/** A second pool slot for the gate check, or null when the context cannot lease one, none is free
 * right now, or the lease failed (the check then runs first, in the change's own slot). */
async function leaseCheckSlot(ctx: ReviewContext, head: string): Promise<SlotLeaseHandle | null> {
  if (!ctx.leaseCheckSlot) return null;
  try {
    return await ctx.leaseCheckSlot(head);
  } catch (err) {
    warnEventBestEffort(ctx.root, ctx.role, `no second workspace for the gate check (${errorMessage(err)}); running it before the review`);
    return null;
  }
}

/** Start the gate check in `lease`'s checkout of `head`. A rejection is recorded, not applied:
 * resetting the change's branch is left to reviewAttempt, after the reviewer has stopped. */
function startOverlappedCheck(ctx: ReviewContext, state: RunnerState, head: string, lease: SlotLeaseHandle): CheckOverlap {
  const overlap = { abort: new AbortController(), done: false } as CheckOverlap;
  const reject = async (reasons: string[]): Promise<GateResult> => {
    overlap.rejectedReasons = reasons;
    return { decision: "rejected", detail: firstReason(reasons) };
  };
  overlap.gate = gateBuildPrecheck({ ...ctx, wt: lease.dir }, state, head, reject)
    .then(
      (pre) => {
        overlap.done = true;
        if (pre.resolved) overlap.abort.abort();
        else setMergeStage(ctx.root, ctx.role, "reviewing");
        return pre;
      },
      (err: unknown) => {
        overlap.done = true;
        overlap.abort.abort();
        throw err;
      },
    )
    .finally(() => lease.release());
  overlap.gate.catch(() => {}); // surfaced where reviewAttempt awaits it
  return overlap;
}

/** Run the adversarial review gate over everything ahead of main in `wt` and update `state`
 * accordingly. Shared by the run path (after commitAll) and leftover recovery
 * (leftover.ts's recoverLeftover) — every path
 * that can move a commit into main routes through here, so no crash or abort path smuggles
 * unreviewed work in:
 * - gate disabled, or an already-approved HEAD, or an exempt (doc-only) diff → merge as-is;
 * - a new HEAD carrying an approved patch (approvedPatchIds) → approved after the
 *   build pre-check, with no reviewer run;
 * - approve → record lastApprovedHead and its patch-id, and discard the reviewer's stray
 *   working-tree edits (its only output channel is the verdict);
 * - reject → reset the branch to main, record reasons in state.lastReview (injected into the
 *   role's next run prompt), log review_rejected;
 * - fail with an unparseable reply (the reviewer ran to completion but emitted no VERDICT) →
 *   one capped follow-up turn on the reviewer's own session asks for the missing line
 *   (mirroring requestSummary — BUGS.md 2026-09-29); only a follow-up that also yields
 *   nothing counts the strike. Leave the commit on the branch for the next run's re-review,
 *   counting consecutive failures per HEAD; past REVIEW_FAILURE_LIMIT discard the leftover
 *   with a warning.
 * - fail because the run itself failed (transport/spawn/timeout, pi.ok false) → leave the
 *   commit and do NOT advance the count: the reviewer never judged the diff, so the failure
 *   is evidence about the backend, never about the commit (BUGS.md 2026-09-20).
 * - the declared check fails, and fails again on its one re-run → reject with the check's
 *   reasons, no pi run, when main's own tip is green (or has no verdict); when main is red too,
 *   fail without advancing the count and leave the commit — the failure is main's. Never throws.
 * `highFriction` marks a change whose authoring run burned more than the configured turn/time
 * thresholds (plans/refusal-and-thrash.md): the flag rides along in the review prompt so the
 * reviewer applies extra scrutiny to whether the work should exist at all. */
async function reviewAttempt(
  ctx: ReviewContext,
  state: RunnerState,
  summary: string | undefined,
  commitBody: string | undefined,
  highFriction: boolean | undefined,
  retry: ReviewRetry,
): Promise<GateResult> {
  const { root, role, wt, mainBranch, config } = ctx;
  if (!config.review.enabled) {
    state.reviewResume = undefined;
    return { decision: "exempt" };
  }

  const head = await headOf(wt, "HEAD");

  // The one reject path: every rejection of this HEAD — deterministic build-check failure or
  // model verdict — shares this bookkeeping. Record lastReview (injected into the role's next
  // run prompt), reset the failure count (a verdict about this HEAD is a successful review
  // either way), discard the branch by resetting it to main, and log review_rejected.
  // Callers attach `run` when a pi run was consumed.
  const reject = async (reasons: string[], durationMs?: number): Promise<GateResult> => {
    recordReview(state, "reject", reasons, head);
    state.reviewResume = undefined;
    state.unreviewFailures = 0;
    await resetWorktreeToMain(wt, mainBranch);
    logEventBestEffort(root, {
      source: role,
      type: "review_rejected",
      head,
      reasons,
      ...(durationMs === undefined ? {} : { durationMs }),
    });
    return { decision: "rejected", detail: firstReason(reasons) };
  };

  // Every exit below that keeps the change leaves the worktree at the head this gate reviewed.
  const keep = async (r: GateResult): Promise<GateResult> => {
    await restoreReviewedHead(wt, head, root, role);
    return r;
  };

  // Settle the attempt on an overlapped check that did not pass: the sequential pre-check's own
  // outcome, with the reviewer's run (when one started) dropped and no verdict recorded. A
  // rejection is applied now, after the reviewer stopped touching the tree; every other outcome
  // keeps the change at the head the gate reviewed.
  const settleFailedCheck = async (
    o: CheckOverlap,
    pre: { resolved?: GateResult },
    pi?: PiRunResult,
  ): Promise<GateResult> => {
    state.reviewResume = undefined;
    const settled = o.rejectedReasons
      ? await reject(o.rejectedReasons)
      : await keep(pre.resolved ?? { decision: "failed", detail: "the gate check did not complete" });
    return pi ? withRuns(settled, pi, null, null) : settled;
  };

  // Already reviewed this exact HEAD (e.g. a merge_blocked retry): do not burn another run.
  if (state.lastApprovedHead === head) {
    state.reviewResume = undefined;
    return { decision: "approved" };
  }

  const files = await aheadOfMainFiles(wt, mainBranch);
  // The five deterministic diff rules (conflict markers, protected edits, secret leaks, a false
  // fix claim on an exempt md-only diff, and backlog structure) are judged by diffRuleReasons in
  // the gate's own order and scope — the one call site the gate and the main watch share (the
  // watch runs them on main's tip, "Every commit is verified on main, part 1/3"). A rejection is
  // a hard stop and deterministic, like the pre-check below: no pi run consumed, reasons
  // injected into the author's next run. A conflict marker must not merge raw `<<<<<<<` lines
  // (PLANS.md "Robust conflict landing, part 2/2"), and an md-only diff skips the reviewer, so
  // each rule below is what catches a change the reviewer would never see: an edit to the brief
  // prompt block or PRINCIPLES.md (protectedEditReason), a leaked credential
  // (secretLeakReason), an md-only fix claim with no backing code (falseFixReason, BUGS.md
  // 2026-09-22), and a duplicated or dropped `## ` section heading (backlogStructureReason,
  // PLANS.md 2026-09-25).
  const baseRev = await changeBaseRev(wt, mainBranch);
  const exempt = isExemptDiff(files, config.review.exemptPaths);
  const [firstFinding] = await diffRuleReasons(wt, baseRev, files, role, exempt);
  if (firstFinding !== undefined) return reject([firstFinding]);
  if (exempt) {
    state.reviewResume = undefined;
    return { decision: "exempt" };
  }

  // Deterministic build pre-check — after BOTH early returns above (an md-only diff cannot
  // break the build) and before any reviewer run or the phase/event that would show
  // "reviewing": a deterministic rejection never shows as reviewing on the dashboards. Both
  // gate callers (the run path and leftover.ts's recoverLeftover) get it for free. Its run,
  // flake re-run, and attribution live in review-precheck.ts (the check run itself lives in
  // runScopedBuildCheck, shared with the merge path's in-lock re-check); a resolved result
  // here is returned verbatim and a pass hands the verified head to the merge path below.
  // The pre-check sets the merge cell's stage (a no-op outside a queued merge) —
  // "build-check" while it runs, "reviewing" when the reviewer run starts below.
  // A retried attempt keeps the first attempt's passing pre-check (a green, or a red naming
  // only main's known failures): the tree is the same head.
  // A review judges a diff, not a sha: a head carrying exactly the patch this role's last
  // approval judged (the approved head cleanly rebased onto a moved main) reuses that verdict
  // instead of paying a second reviewer run. Only the model review is reused — the pre-check
  // has just run on this tree (a failure rejected it there), and its verifiedHead rides on the
  // result as for any approval.
  const reviewedPatchId = (await patchId(wt, mainBranch, head)) ?? undefined;
  const patchApproved = reviewedPatchId !== undefined && state.approvedPatchIds?.includes(reviewedPatchId) === true;

  // The check runs alongside the reviewer when a second pool slot is free right now (Fast merge
  // part 12): it starts here, in its own checkout of this head, while the reviewer run below
  // starts in the change's own slot. An already-approved patch has no reviewer to overlap, and
  // with no free slot (or no way to lease one) the check runs first, as it always did.
  const afterMerge = reviewedAfterMerge(config, role);
  let overlap: CheckOverlap | undefined;
  if (!retry.pre) {
    const lease = patchApproved || afterMerge ? null : await leaseCheckSlot(ctx, head);
    if (lease) overlap = startOverlappedCheck(ctx, state, head, lease);
    else {
      const pre = await gateBuildPrecheck(ctx, state, head, reject);
      if (pre.resolved) {
        state.reviewResume = undefined;
        return pre.resolved;
      }
      retry.pre = { verifiedHead: pre.verifiedHead, knownMainFailures: pre.knownMainFailures };
    }
  }
  const knownMainFailures = retry.pre?.knownMainFailures;
  // A role listed in review.afterMerge merges on its gate alone: the deterministic rejects and the
  // pre-check above still ran, and the merged commit is reviewed after it lands
  // (reviewMergedCommit, run by the merge pipeline's post-review drain).
  if (afterMerge && retry.pre) {
    state.reviewResume = undefined;
    state.lastApprovedHead = head;
    return { decision: "approved", verifiedHead: retry.pre.verifiedHead };
  }
  if (patchApproved && retry.pre) {
    state.reviewResume = undefined;
    state.lastApprovedHead = head;
    return { decision: "approved", verifiedHead: retry.pre.verifiedHead };
  }

  return runReviewer(ctx, state, {
    head, overlap, knownMainFailures, retry, summary, commitBody, highFriction,
    reviewedPatchId, reject, keep, settleFailedCheck,
  });
}

/** Review the change ahead of main, retrying a failed reviewer run in place (twice, 30 s apart)
 * before the attempt ends `failed`: a run that timed out, was killed, died in transport or at
 * the provider, or stated no VERDICT after its recovery turn. A resumable session is resumed,
 * otherwise the retry starts fresh (reviewAttempt). A configuration error and an abort are not
 * retried. While the reviewer's provider is held the retry waits for the hold to lift and
 * costs nothing. Each pause runs without the caller's team permit (idleWithoutProviderLease):
 * a verification hands its lease back while it waits and takes it back before the next attempt.
 * See reviewAttempt for the rest of the gate's contract. */
export async function reviewAheadOfMain(
  ctx: ReviewContext,
  state: RunnerState,
  summary?: string,
  commitBody?: string,
  highFriction?: boolean,
): Promise<GateResult> {
  const retry: ReviewRetry = { attempt: 1, retriesLeft: ctx.retries ?? REVIEW_RETRIES };
  const delayMs = reviewRetryDelayMs(ctx.retryDelayMs);
  for (;;) {
    const result = await reviewAttempt(ctx, state, summary, commitBody, highFriction, retry);
    if (!result.retryable) return result;
    for (const run of [result.run, result.followUpRun, result.nudgeRun]) if (run) ctx.foldUsage?.(run);
    const held = ctx.reviewHeld?.() ?? false;
    warnEventBestEffort(
      ctx.root,
      ctx.role,
      `the reviewer run failed (${result.detail ?? "no detail"}) — ${held ? "waiting for the provider hold to lift, then " : ""}retrying the review in place`,
    );
    // The pause holds no team permit: a verification's lease is handed back while it waits and
    // re-taken before the next attempt, so a reviewer that keeps failing does not starve the roles.
    await idleWithoutProviderLease(async () => {
      await sleepUnlessAborted(delayMs, ctx.signal);
      while (ctx.reviewHeld?.() && !ctx.signal?.aborted) await sleepUnlessAborted(Math.min(delayMs, 5000), ctx.signal);
    }, ctx.signal);
    if (ctx.signal?.aborted) return { decision: "failed", aborted: true };
    if (!held) retry.retriesLeft -= 1;
    retry.attempt += 1;
  }
}

function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}
