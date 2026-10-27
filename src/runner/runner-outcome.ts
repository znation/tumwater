/** The post-run outcome half of a role run, split out of src/runner/runner-run.ts: after the
 * authoring pi run finishes, everything that turns the result into an outcome — the verdict
 * classification (abort, config request, quiet kill, timeout, refusal, failure, no-change)
 * through resolveRunVerdict, and the fulfillable path's staging of the work for the merge
 * queue — plus the refusal-note merge path. The run-lifecycle phases that lead up to the pi
 * run live in runner-run.ts; this module keeps only the outcome's own dependencies, and
 * shares runner-run.ts's `RunnerRunContext` binder — the one contract between the two halves —
 * so either half can change without touching the other's imports. */

import type { RunnerRunContext } from "./runner-run.js";
import type { RunOutcome, RunResult } from "../run/run-outcome.js";
import type { PiRunResult } from "../pi/pi-run-result.js";
import type { ResolvedModelConfig } from "../config/config-views.js";
import type { CiResult, FlowResult, FiledResult } from "../verdict/reply-contract.js";
import { mergeToMain } from "../merge/merge-to-main.js";
import { MERGE_LOCK_WAIT_MS } from "../paths.js";
import { resolveRunVerdict } from "../run/run-verdict.js";
import { modelTrailerLine } from "../git/commit-message.js";
import { seamAgent } from "../config/model-selector.js";
import { stageRunMerge } from "../run/run-stage.js";
import { stageCheckFindings } from "../run/stage-check.js";

/** Merge the worktree branch on main (see src/merge/merge-to-main.ts for the
 * rebase → verify → ff-merge → conflict-retry flow): delegates with the runner identity, run
 * number, and shared pi wiring so a conflict-resolution run folds into this run's counters
 * like any other pi run. Only the refusal-note merge (src/verdict/refusal.ts) still uses it —
 * reviewed changes merge through the merge pipeline's leased verification slot instead; md-only
 * notes are review-exempt by construction, so they keep this branch path (plans/merge-queue.md
 * 2/5). The refusal path waits MERGE_LOCK_WAIT_MS for merge.lock, not withLock's default: a
 * merge holds it through its in-lock check, which outlasts the default. */
async function mergePhase(ctx: RunnerRunContext, wt: string, summary: string): Promise<RunResult> {
  return mergeToMain(
    {
      root: ctx.root,
      role: ctx.role,
      mainBranch: ctx.mainBranch,
      exemptPaths: ctx.config.review.exemptPaths,
      config: ctx.config,
      runNumber: ctx.state.runs,
      lockTimeoutMs: MERGE_LOCK_WAIT_MS,
      runPi: (w, prompt, sessionName, config) => ctx.pi.runRolePi(w, prompt, sessionName, false, config),
    },
    wt,
    summary,
  );
}

/** Turn a finished pi run into its RunOutcome: the post-run half of runOnce, split off so each
 * half reads on its own screen — the setup above ends at the pi return. The verdict
 * classification (abort, config request, quiet kill, timeout, refusal, failure, no-change) lives
 * in resolveRunVerdict (src/run/run-verdict.ts), and the fulfillable path — staging —
 * stays here. `userPrompt` is the raw director prompt this run is executing (null for role
 * runners) so unfulfilled outcomes can re-queue it; `revisionRound` is the revision this run holds
 * (undefined when it is not a revision); `flow` is the qa observer's FLOW line (null for every
 * other role); `filed` is the feedback observer's FILED line (null for every other role);
 * `ci` is the ci observer's CI line (null for every other role). */
export async function handlePiResultPhase(
  ctx: RunnerRunContext,
  pi: PiRunResult,
  userPrompt: string | null,
  revisionRound: number | undefined,
  wt: string,
  flow: FlowResult | null,
  filed: FiledResult | null,
  ci: CiResult | null,
  piStartedAt: number,
  cfg: ResolvedModelConfig,
): Promise<RunOutcome> {
  // Everything that decides the run left nothing mergeable — abort, config request,
  // quiet kill, timeout, refusal, failure without changes, no change — lives in
  // resolveRunVerdict (src/run/run-verdict.ts); null means the run IS fulfillable.
  const modelLine = modelTrailerLine(seamAgent(cfg), cfg.provider, cfg.model);
  const verdict = await resolveRunVerdict({
    modelLine,
    root: ctx.root,
    role: ctx.role,
    mainBranch: ctx.mainBranch,
    state: ctx.state,
    pending: ctx.pending,
    turns: ctx.usage.turns,
    userPrompt,
    revisionRound,
    wt,
    pi,
    flow,
    filed,
    ci,
    warn: (message) => ctx.warn(message),
    merge: (w, sum) => mergePhase(ctx, w, sum),
    finishAbortedRun: () => ctx.finishAbortedRun(userPrompt, wt),
  });
  if (verdict) return verdict;

  // The commit is pinned and the worktree is free (src/run/run-stage.ts): stage it for the
  // merge queue and END the run — the orchestrator drains the queue on its single merge
  // slot, outside the author semaphore, so this slot is free the moment the work is
  // committed (plans/merge-queue.md 3/5). Staging derives the commit message from the reply's
  // SUMMARY block (one bounded follow-up turn when the run left none), flags high-friction
  // runs, pins the commit by the role's merge ref BEFORE freeing the worktree (invariant
  // 4 — a failed pin defers to next-run recovery), and enqueues the merge, which runs the
  // same gate + merge flow through runMergePi/foldMergeUsage on this same state object
  // — recording the commit count, the outcome, and the reviewer spend into it — and logs
  // merge_done/merge_failed; a non-terminal outcome keeps the pin for next-run leftover recovery.
  // `commits` was NOT incremented above: it counts merged changes only.
  return stageRunMerge({
    modelLine,
    root: ctx.root,
    role: ctx.role,
    state: ctx.state,
    config: ctx.config,
    runTurns: ctx.usage.turns,
    userPrompt,
    revisionRound,
    mainBranch: ctx.mainBranch,
    wt,
    finalText: pi.finalText,
    flow,
    filed,
    piStartedAt,
    warn: (message) => ctx.warn(message),
    requestSummary: (w, n) => ctx.pi.requestSummary(w, cfg, n),
    stageCheck: (w) => stageCheckFindings(w, ctx.mainBranch, ctx.config.review.exemptPaths, ctx.role),
    requestStageFix: (w, findings, change) => ctx.pi.requestStageFix(w, findings, change, cfg),
    pinAndReset: (w, sha) => ctx.pinAndReset(w, sha),
    finishAbortedRun: () => ctx.finishAbortedRun(userPrompt, wt),
  });
}
