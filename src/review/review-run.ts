// vocabulary: plain
import { APPROVED_PATCH_IDS_MAX, REVIEW_RESUME_LIMIT, saveRunnerState, type RunnerState } from "../runner/runner-state.js";
import { modelSelectorField, resolvedBackendConfig, reviewRunConfig } from "../config/config-views.js";
import { logEventBestEffort, warnEventBestEffort } from "../events/events.js";
import { git } from "../git/git-run.js";
import { changeBaseRev, headOf } from "../git/git.js";
import { aheadOfMainDiff, revisionInterdiff } from "../git/git-diff.js";
import { resetWorktreeToMain } from "../git/worktree.js";
import { nativeLogPath, piLogPath } from "../paths.js";
import type { PiRunResult } from "../pi/pi-run-result.js";
import { readPrinciples } from "../prompt/principles.js";
import { buildReviewPrompt, buildReviewResumePrompt } from "../prompt/gate-prompts.js";
import { backendSessionResumable } from "../agent/agent-backend.js";
import { requestNoRerun, requestVerdict } from "./review-followup.js";
import { parseVerdict } from "./review-verdict.js";
import { recordReview } from "../run/run-apply.js";
import { shortSha } from "../text/format.js";
import { suiteRerunWarning, type ToolCallStart } from "./suite-rerun.js";
import { setMergeStage } from "../merge/merge-slot.js";
import type { CheckOverlap, GateResult, ReviewContext, ReviewRetry } from "./review.js";

/** Attach the review gate's pi runs onto a partial GateResult — `run` plus the optional
 * verdict-recovery follow-up (`followUpRun`) and no-re-run nudge (`nudgeRun`) fields, each
 * present only when its turn actually ran. Spelled once so every return site of
 * reviewAheadOfMain that carries runs shares one shape for the usage-folding caller
 * (merge-core.ts folds run, then followUpRun, then nudgeRun), instead of one conditional
 * spread per site that a new run kind would have to update everywhere. */
export function withRuns(r: GateResult, run: PiRunResult, followUp: PiRunResult | null, nudge: PiRunResult | null): GateResult {
  return {
    ...r,
    run,
    ...(followUp ? { followUpRun: followUp } : {}),
    ...(nudge ? { nudgeRun: nudge } : {}),
  };
}

/** Put the worktree back on the exact head the gate reviewed: the reviewer's only output is its
 * verdict, so a commit it made must never reach the merge pin or the next re-review. */
export async function restoreReviewedHead(wt: string, head: string, root: string, role: string): Promise<void> {
  const now = await headOf(wt, "HEAD").catch(() => null);
  if (now && now !== head) {
    warnEventBestEffort(root, role, `the reviewer moved HEAD to ${shortSha(now)} during review; restored the reviewed head ${shortSha(head)}`);
  }
  await git(wt, "reset", "--hard", head);
}

/** Consecutive failed reviews of one branch HEAD after which the leftover is discarded with
 * a warning: a misconfigured reviewer model must not be able to wedge a role into re-reviewing
 * the same commit forever. */
export const REVIEW_FAILURE_LIMIT = 3;

function combineSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  return a ? AbortSignal.any([a, b]) : b;
}

/** What the gate phase of reviewAttempt hands the reviewer run: the head under review, the
 * locals both phases share, and the closures that settle the attempt. */
interface ReviewRunInput {
  head: string;
  /** The patch-id of the reviewed diff, undefined when unreadable. */
  reviewedPatchId: string | undefined;
  overlap: CheckOverlap | undefined;
  knownMainFailures: string[] | undefined;
  retry: ReviewRetry;
  summary: string | undefined;
  commitBody: string | undefined;
  highFriction: boolean | undefined;
  reject: (reasons: string[], durationMs?: number) => Promise<GateResult>;
  keep: (r: GateResult) => Promise<GateResult>;
  settleFailedCheck: (o: CheckOverlap, pre: { resolved?: GateResult }, pi?: PiRunResult) => Promise<GateResult>;
}

/** The reviewer run: resume-vs-fresh session choice, prompt, run, follow-up turns, verdict parse
 * and the approve/reject bookkeeping. Called by reviewAttempt once the deterministic gate has
 * passed the change on to a reviewer. */
export async function runReviewer(ctx: ReviewContext, state: RunnerState, input: ReviewRunInput): Promise<GateResult> {
  const { root, role, wt, mainBranch, config } = ctx;
  const { head, reviewedPatchId, overlap, knownMainFailures, retry, summary, commitBody, highFriction } = input;
  const { reject, keep, settleFailedCheck } = input;
  // The reviewer's model selector (plans/model-tiers.md "Observability"): resolved from the
  // same config the run below gets, so the event names what the reviewer actually runs on —
  // the budget fallback included. Omitted when no model is configured (pi's own default).
  const reviewCfg = reviewRunConfig(config);
  // The team claude config dir (plans/notes-command.md "Keeping funes out of team runs"), so
  // a claude review's resume guard looks under the same dir the review run writes its transcript
  // to — a team that set one must resume under it, not the default ~/.claude.
  const claudeConfigDir = resolvedBackendConfig(config, "claude").configDir;
  // A progressing timeout left this run's session for the next attempt (RunnerState.reviewResume):
  // resume it only while the patch is unchanged (the same diff), the resume budget lasts, and
  // the directory still holds a gate session to `--continue`. Otherwise the stale marker is
  // cleared and this attempt reviews the change from scratch.
  const priorResume = state.reviewResume;
  const resuming =
    priorResume !== undefined &&
    priorResume.patchId === reviewedPatchId &&
    priorResume.attempts < REVIEW_RESUME_LIMIT &&
    backendSessionResumable(priorResume.sessionDir, {
      kind: "gate",
      agent: reviewCfg.agent ?? "pi",
    }, claudeConfigDir);
  if (resuming) {
    // Count the resume before the run: a crash must not let the same session be resumed
    // forever without ever spending the budget.
    priorResume.attempts += 1;
    saveRunnerState(root, state);
  } else {
    state.reviewResume = undefined;
  }
  // The directory this run actually uses: a resumed attempt continues the timed-out run's
  // session, a fresh one its own. Both the run and its follow-up turns must target this dir —
  // a follow-up that used ctx.sessionDir while the review resumed another dir would
  // `--continue` a session that never held this review.
  const reviewSessionDir = resuming ? state.reviewResume!.sessionDir : ctx.sessionDir;
  // The follow-up turns (verdict recovery, no-re-run nudge) continue the just-finished review,
  // so they must read the same directory. A fresh run's dir is already ctx's, so only a resume
  // needs the override.
  const followupCtx = reviewSessionDir === ctx.sessionDir ? ctx : { ...ctx, sessionDir: reviewSessionDir };
  logEventBestEffort(root, {
    source: role,
    type: "review_start",
    head,
    ...(ctx.revisionRound !== undefined ? { revision: ctx.revisionRound } : {}),
    ...(resuming ? { resumed: true } : {}),
    ...modelSelectorField(reviewCfg),
  });
  // Persist the phase BEFORE the run so a dashboard mid-review shows "reviewing" and a crash
  // mid-review is distinguishable from a crash mid-author-run on resume (stray edits are the
  // reviewer's then, not the author's). Cleared at run end alongside `running`.
  state.phase = "review";
  saveRunnerState(root, state);

  // Freeze the revision the diff is measured from once, before the run: main moves while a
  // merge is approved, and a reviewer comparing against the live `main` ref reads another role's
  // just-merged work as this change reverting it (BUGS.md 2026-10-06). The prompt names this SHA
  // and tells the reviewer to compare against it instead.
  const base = await changeBaseRev(wt, mainBranch);
  const diff = await aheadOfMainDiff(wt, mainBranch);
  // A revision's re-review gets the prior review's objections and the interdiff between the two
  // versions (plans/revise-rejected.md part 2/2), so it checks what the revision had to resolve
  // instead of starting from no memory. A missing prior object yields an empty interdiff, never
  // a throw (revisionInterdiff).
  const priorReview = ctx.priorReview
    ? {
        round: ctx.revisionRound ?? 1,
        reasons: ctx.priorReview.reasons,
        interdiff: await revisionInterdiff(wt, mainBranch, ctx.priorReview.sha, head),
      }
    : undefined;
  // The reviewer run's wall time rides on its verdict event: a reviewer that takes an hour per
  // merge on local hardware is a team-level cost an operator must be able to see.
  const reviewStartedAt = Date.now();
  // The reviewer's started tool calls: the no-re-run rule always stands (tumwater runs the
  // check), so the suite-rerun tripwire below always applies.
  const reviewerCalls: ToolCallStart[] = [];
  // The merge cell switches to the reviewer run's live detail (no-op outside a queued
  // merge). runPi writes the run's `tumwater_run` label line before spawning pi, and that
  // line resets the gate progress accumulator, so the cell never shows a previous run's counts.
  setMergeStage(root, role, overlap ? "reviewing-check" : "reviewing");
  // A check that already went red has aborted the overlap: no reviewer run starts, the verdict
  // below is the gate's alone.
  if (overlap?.abort.signal.aborted) return settleFailedCheck(overlap, await overlap.gate);
  // The author's claimed WHY/RISK/VERIFIED ride along when present — checking those claims
  // against the actual diff is exactly the adversarial angle (recovery merges reconstruct
  // them from the pinned commit's message).
  const pi = await ctx.runGatePi({
    cwd: wt,
    kind: "gate",
    prompt: resuming
      ? buildReviewResumePrompt(base, state.reviewResume!.patchId)
      : buildReviewPrompt(
          diff,
          summary,
          commitBody,
          readPrinciples(root),
          highFriction,
          base,
          undefined,
          priorReview,
          knownMainFailures,
        ),
    // The reviewer runs on its own time budget (review.timeoutSeconds), never longer than a
    // run's: a timed-out review is a FAILED run (pi.ok false), so it takes the dead-backend
    // path below — commit kept, no strike — and re-merges through the author's next run
    // instead of holding the merge queue for a whole authoring run.
    config: reviewCfg,
    // This run's own session directory (per-run, keyed by run and pinned sha): a follow-up
    // turn, or a later attempt that resumes this review, continues exactly this run instead
    // of whichever review wrote last. A fresh review carries no --continue — the reviewer
    // must not inherit the author's context — and old files are collected by the age-based
    // prune at orchestrator start.
    sessionDir: reviewSessionDir,
    ...(resuming ? { continueSession: true } : {}),
    sessionName: `tumwater-review-${role}-${ctx.runNumber}`,
    rawLogFile: piLogPath(root, role),
    nativeLogFile: nativeLogPath(root, role, reviewCfg.agent ?? "pi"),
    // Label this run in the shared transcript (src/ui/transcript.ts renders it as
    // `── review @ <ts> ──`) so an operator can tell reviewer runs from author runs.
    label: "review",
    signal: overlap ? combineSignals(ctx.signal, overlap.abort.signal) : ctx.signal,
    // A stalled tool call during review hangs the gate just like one during authoring —
    // name it in the event feed while the quiet watchdog still counts down.
    onToolCallStalled: (message) => warnEventBestEffort(root, role, message),
    onToolCallStart: (toolName, args) => {
      reviewerCalls.push({ toolName, args });
    },
    // A gate run that read an image its model cannot see is logged, not killed (plans/
    // image-input.md "Detecting a blind read"): the reviewer keeps working from what it CAN
    // see, and the image_blind line names the file, the model, and this run so the operator
    // knows the diff was judged under a blind read.
    onBlindRead: (path, action) =>
      logEventBestEffort(root, {
        source: role,
        type: "image_blind",
        run: ctx.runNumber,
        path,
        model: reviewCfg.model,
        action,
      }),
  });

  // A reviewer told the pre-check passed that re-ran the full suite anyway held the merge
  // slot and loaded the shared host for a result the harness already had (BUGS.md 2026-09-23:
  // scratch copies under /tmp, `npm ci` and `npm test` there). Warned on every outcome, abort
  // included — the run happened either way; the verdict itself is not touched.
  const rerun = suiteRerunWarning(reviewerCalls);
  if (rerun) warnEventBestEffort(root, role, rerun);

  // Join the overlapped check (Fast merge part 12): a gate that did not pass settles the attempt;
  // a green gate lets the reviewer's outcome stand, and a reviewer that finished first waited
  // here for the gate.
  if (overlap) {
    if (!overlap.done) setMergeStage(root, role, "build-check");
    const pre = await overlap.gate;
    if (pre.resolved) return settleFailedCheck(overlap, pre, pi);
    retry.pre = { verifiedHead: pre.verifiedHead, knownMainFailures: pre.knownMainFailures };
  }
  const verifiedHead = retry.pre?.verifiedHead;

  if (pi.aborted) {
    // Shutdown mid-review: fail closed — the commit stays on the branch and the
    // resumed/following run re-reviews it via the combined ahead-of-main diff. Any resume
    // marker from an earlier attempt is dropped: an abort says nothing about the diff, and the
    // next attempt starts clean rather than inheriting a half-counted session.
    state.reviewResume = undefined;
    return keep(withRuns({ decision: "failed", aborted: true }, pi, null, null));
  }

  // The bounded nudge (BUGS.md 2026-10-02): the reviewer broke the no-re-run rule despite a
  // green pre-check, so one turn on its own session names the call and asks it to finish
  // without re-running. A repeat on the nudge's own tool calls fails the review — strike-free,
  // commit kept, re-reviewed under the normal path — instead of paying a third suite run.
  let nudge: PiRunResult | null = null;
  let nudgeRepeat: string | null = null;
  if (rerun && pi.ok) {
    const nudgeCalls: ToolCallStart[] = [];
    nudge = await requestNoRerun(followupCtx, rerun, nudgeCalls);
    if (nudge?.aborted) {
      return keep(withRuns({ decision: "failed", aborted: true }, pi, null, nudge));
    }
    nudgeRepeat = nudge ? (suiteRerunWarning(nudgeCalls) ?? null) : null;
    if (nudgeRepeat) {
      warnEventBestEffort(
        root,
        role,
        `${nudgeRepeat} the repeat fails this review: the commit stays, and the merge re-reviews it without a third suite run`,
      );
    }
  }

  let verdict = parseVerdict(pi.verdictText ?? "");
  // The nudge turn's reply can carry the verdict the review run lost — use it before spending
  // any other recovery turn, but never on a repeat (the repeat fails the review regardless).
  if (!verdict && nudge && !nudgeRepeat) {
    const recovered = parseVerdict(nudge.verdictText ?? "");
    if (recovered) {
      verdict = recovered;
      warnEventBestEffort(root, role, "the reviewer's reply had no VERDICT line — recovered it with the no-re-run nudge turn on its session");
    }
  }
  // A run that FAILED (`ok` false: transport error, failed spawn, timeout) produced no reply,
  // so no follow-up is attempted — it is evidence about the backend, and the strike-free
  // branch below keeps it that way (BUGS.md 2026-09-20). Only a run that completed and
  // replied without a parseable VERDICT earns the recovery turn: that is evidence about the
  // reviewer's output format, not about the diff, and it is as recoverable as the author
  // side's missing SUMMARY (BUGS.md 2026-09-29). The nudge turn is the bounded follow-up when
  // the reviewer broke the no-re-run rule — one turn total, so a spent nudge never earns the
  // verdict-recovery turn on top.
  let followUp: PiRunResult | null = null;
  if (!verdict && pi.ok && !nudge) {
    followUp = await requestVerdict(followupCtx);
    if (followUp?.aborted) return keep(withRuns({ decision: "failed", aborted: true }, pi, followUp, nudge));
    const recovered = followUp ? parseVerdict(followUp.verdictText ?? "") : null;
    if (recovered) {
      verdict = recovered;
      warnEventBestEffort(root, role, "the reviewer's reply had no VERDICT line — recovered it with a follow-up turn on its own session");
    }
  }
  // A repeat after the nudge (BUGS.md 2026-10-02): the reviewer re-ran the suite on the nudge
  // turn too. Fail the review — strike-free like a dead backend (BUGS.md 2026-09-20): the
  // commit stays for the next merge's re-review, the discard counter never advances, and no
  // rejection is recorded against the author's diff.
  if (nudgeRepeat) {
    const message = `${nudgeRepeat} The review is failed on this repeat: the commit is kept, and the merge re-reviews it under the normal path.`;
    logEventBestEffort(root, { source: role, type: "review_failed", head, message, attempt: retry.attempt, durationMs: Date.now() - reviewStartedAt });
    state.reviewResume = undefined;
    recordReview(state, "failed", [message], head);
    return keep(withRuns({ decision: "failed", detail: message }, pi, followUp, nudge));
  }

  if (!verdict) {
    return settleUnparsedReview(ctx, state, input, {
      pi, followUp, nudge, resuming, reviewSessionDir, reviewStartedAt, reviewCfg, claudeConfigDir,
    });
  }

  if (verdict.verdict === "reject") {
    const rejected = await reject(verdict.reasons, Date.now() - reviewStartedAt);
    return withRuns({ ...rejected }, pi, followUp, nudge);
  }

  // Approve: record the reviewed HEAD and discard any stray working-tree edits the reviewer
  // made while reading around — its only output channel is the verdict. The patch-id keys the
  // approval to the diff it judged; unreadable, it is not remembered.
  state.lastApprovedHead = head;
  if (reviewedPatchId !== undefined) {
    const kept = (state.approvedPatchIds ?? []).filter((id) => id !== reviewedPatchId);
    state.approvedPatchIds = [...kept, reviewedPatchId].slice(-APPROVED_PATCH_IDS_MAX);
  }
  state.reviewResume = undefined;
  recordReview(state, "approve", verdict.reasons, head);
  state.unreviewFailures = 0;
  await restoreReviewedHead(wt, head, root, role);
  logEventBestEffort(root, {
    source: role,
    type: "review_verdict",
    head,
    reason: verdict.reasons[0],
    durationMs: Date.now() - reviewStartedAt,
  });
  return withRuns({ decision: "approved", verifiedHead }, pi, followUp, nudge);
}

/** What the reviewer run left behind, for settleUnparsedReview. */
interface ReviewOutcome {
  pi: PiRunResult;
  followUp: PiRunResult | null;
  nudge: PiRunResult | null;
  resuming: boolean;
  reviewSessionDir: string;
  reviewStartedAt: number;
  reviewCfg: ReturnType<typeof reviewRunConfig>;
  claudeConfigDir: string | undefined;
}

/** Settle a review that produced no verdict: a dead backend keeps the commit (strike-free, retried
 * in place while retries last), a reply that stayed unparseable counts a strike per HEAD and
 * discards the leftover at REVIEW_FAILURE_LIMIT. */
async function settleUnparsedReview(
  ctx: ReviewContext,
  state: RunnerState,
  input: ReviewRunInput,
  outcome: ReviewOutcome,
): Promise<GateResult> {
  const { root, role, wt, mainBranch } = ctx;
  const { head, retry, reviewedPatchId, keep } = input;
  const { pi, followUp, nudge, resuming, reviewSessionDir, reviewStartedAt, reviewCfg, claudeConfigDir } = outcome;
  const followUpError = followUp && !followUp.ok ? followUp.errorMessage : undefined;
  // The nudge turn's own death is backend evidence, exactly like the verdict-recovery
  // follow-up's: a nudge that died with a transport error is the backend failing after the
  // reviewer judged nothing — about the world, never about the diff — so the strike-free
  // branch below must see it, and its error names the failure.
  const nudgeError = nudge && !nudge.ok ? nudge.errorMessage : undefined;
  // A progressing timeout of the REVIEW run itself (never a follow-up or nudge turn, both of
  // which run only after pi ok) leaves the session for the next attempt while the patch is
  // identifiable and the resume budget lasts. That is what makes the recorded failure honest:
  // while a resume remains the next attempt continues this review, and once the budget is
  // spent or the failure cannot resume, it reviews the change from scratch (BUGS.md
  // 2026-09-30). A string rewrite of runPi's exact suffix, so any other cause — and the plain
  // no-progress timeout, which promises nothing — passes through untouched.
  const resumeAttempts = resuming ? state.reviewResume?.attempts ?? 0 : 0;
  const resumeRemains =
    !pi.ok &&
    !pi.aborted &&
    pi.timedOutProgressing &&
    reviewedPatchId !== undefined &&
    resumeAttempts < REVIEW_RESUME_LIMIT &&
    // The promise must be one the next attempt can keep: only a dir whose backend still
    // holds a gate session to resume earns the marker (and the "continues this review"
    // wording). Without this a backend that leaves no session file would record a resume the
    // next attempt silently declines, reviewing from scratch anyway.
    backendSessionResumable(reviewSessionDir, {
      kind: "gate",
      agent: reviewCfg.agent ?? "pi",
    }, claudeConfigDir);
  const reviewTimeoutRewrite = (message: string): string =>
    message.replace(
      " — session and worktree edits preserved for resume",
      resumeRemains
        ? " — the commit is kept; the next attempt continues this review"
        : " — the commit is kept; the next attempt reviews it from scratch",
    );
  const message = reviewTimeoutRewrite(
    followUpError ??
      nudgeError ??
      pi.errorMessage ??
      `no parseable VERDICT line in the reviewer's reply${
        nudge
          ? ", even after the no-re-run nudge turn on its session"
          : followUp
            ? ", even after a follow-up turn on its session"
            : ""
      }`,
  );
  logEventBestEffort(root, { source: role, type: "review_failed", head, message, attempt: retry.attempt, durationMs: Date.now() - reviewStartedAt });
  // A dead reviewer must never destroy committed work (BUGS.md 2026-09-20): leave the commit
  // for the next run's re-review and do not advance the per-HEAD discard counter. That
  // holds for the review run itself (BUGS.md 2026-09-20), for the verdict-recovery
  // follow-up (BUGS.md 2026-09-29), and for the no-re-run nudge turn (BUGS.md 2026-10-02):
  // each one's death is the backend failing after the reviewer had already judged nothing —
  // evidence about the world, never about the diff.
  if (!pi.ok || (followUp && !followUp.ok) || (nudge && !nudge.ok)) {
    if (resumeRemains) {
      // Record the session this run used (the resumed directory, or this fresh run's own),
      // so the next attempt `--continue`s exactly it.
      state.reviewResume = {
        patchId: reviewedPatchId,
        sessionDir: reviewSessionDir,
        attempts: resumeAttempts,
        at: Date.now(),
      };
      saveRunnerState(root, state);
    } else {
      state.reviewResume = undefined;
    }
    const configError = pi.configError || Boolean(followUp?.configError) || Boolean(nudge?.configError);
    // Retried in place (reviewAheadOfMain): the failure is about the world, so the verify tries
    // the reviewer again before the attempt ends. A configuration error can never succeed.
    if (retry.retriesLeft > 0 && !configError) {
      return keep(withRuns({ decision: "failed", detail: message, retryable: true }, pi, followUp, nudge));
    }
    recordReview(state, "failed", [message], head);
    return keep(
      withRuns(
        { decision: "failed", detail: message, ...(configError ? { configError: true } : {}) },
        pi,
        followUp,
        nudge,
      ),
    );
  }
  // Consecutive failures of THIS HEAD only: a new commit (new HEAD) starts fresh. Read
  // *before* overwriting lastReview with this failure.
  // Retry before counting: the strike below is per verify's final outcome, not per run.
  if (retry.retriesLeft > 0) {
    state.reviewResume = undefined;
    return keep(withRuns({ decision: "failed", detail: message, retryable: true }, pi, followUp, nudge));
  }
  const prev = state.lastReview;
  const sameHead = prev?.verdict === "failed" && prev.head === head;
  state.reviewResume = undefined;
  state.unreviewFailures = (sameHead ? (state.unreviewFailures ?? 0) : 0) + 1;
  recordReview(state, "failed", [message], head);
  let discarded = false;
  if ((state.unreviewFailures ?? 0) >= REVIEW_FAILURE_LIMIT) {
    await resetWorktreeToMain(wt, mainBranch);
    state.unreviewFailures = 0; // The HEAD is gone; nothing left to count against.
    discarded = true;
    warnEventBestEffort(root, role, `discarding unreviewed leftover after ${REVIEW_FAILURE_LIMIT} failed reviews (${shortSha(head)})`);
  }
  const failed = { ...withRuns({ decision: "failed", detail: message }, pi, followUp, nudge), ...(discarded ? { discarded: true } : {}) };
  return discarded ? failed : keep(failed);
}
