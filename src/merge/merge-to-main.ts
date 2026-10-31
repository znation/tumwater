import { openQuestions } from "../backlog/backlog.js";
import { logEventBestEffort, warnEventBestEffort } from "../events/events.js";
import { changeBaseRev, commitMessage, headOf } from "../git/git.js";
import { resolvedDiffDiverges } from "./merge-diff.js";
import {
  conflictedFileHunks,
  conflictedFiles,
  continueRebase,
  ffMainToOrWhy,
  overwriteBlockedReason,
  primaryCheckoutBlockers,
  hasConflictMarkers,
  mainCommitsTouching,
  rebaseOntoMain,
  rebaseOntoMainLeaveConflicts,
} from "./merge-git.js";
import { resolveBacklogInsertConflicts } from "./merge-backlog-conflicts.js";
import { abortSync } from "../git/worktree.js";
import { detectBuildCheck } from "../build/build-check-detect.js";
import { withLock } from "../concurrency/lock.js";
import { buildConflictPrompt } from "../prompt/gate-prompts.js";
import { mergeLockDir } from "../paths.js";
import { logNewQuestions } from "./merge-questions.js";
import { setMergeStage } from "./merge-slot.js";
import { syncRootInstall } from "../build/dep-install.js";
import type { TumwaterConfig } from "../config/config-schema.js";
import { resolverConfig } from "../config/config-views.js";
import type { RunResult } from "../run/run-outcome.js";
import type { RunsPi } from "../runner/runner-pi.js";
import type { PiRunResult } from "../pi/pi-run-result.js";

/** Merge a change on main: rebase onto main (keeping history linear), fast-forward with no
 * in-lock check (part 4l/3: the main watch checks the tip after it lands), and — when the rebase
 * conflicts — one pi-driven resolution attempt before giving up. The merge is
 * worktree-parameterized: whatever `wt` holds at its HEAD after the rebase is what merges — a role
 * branch (whose ref tracks its own tip through the rebase) or a detached merger worktree pinned at
 * a bare sha (which does not move when git rebase rewrites it, so fast-forwarding to the original
 * pin would fail whenever main moved between commit and merge). Split out of runner.ts — which
 * keeps the run lifecycle around it — because this is a self-contained concern with its own flow
 * (lock → rebase → ff-merge → conflict retry) and its own git surface; the only things it
 * borrows from the runner are identity (root/mainBranch), `role` for events and session naming
 * only, the current run number for session naming, and the runner's shared pi wiring so a
 * conflict-resolution run folds into the same run counters as an authoring run. */

/** MergeContext: what mergeToMain needs from its owning runner (merge-core.ts's MergerContext is
 * the merger's, a different shape): identity (root, main branch), the role for events
 * and session naming only — the merge code never re-derives it into a branch — plus the run
 * number that names the conflict-resolution session, and the runner's shared pi runner (role
 * config, session dir, raw log, transient-timeout retry) with usage folded into the run counters
 * — every pi run of a run merges there exactly once. */
export interface MergeContext extends RunsPi {
  root: string;
  role: string;
  mainBranch: string;
  /** The live config — the conflict resolver detects the project's declared check through it
   * (plans/portability.md §6/7), exactly as the review gate's pre-check does. */
  config: TumwaterConfig;
  /** The current run number (names the conflict-resolution pi session). */
  runNumber: number;
  /** How long to wait for merge.lock; defaults to withLock's. */
  lockTimeoutMs?: number;
  /** The gate, re-run over a conflict resolution's tree: a resolution whose diff ahead of main
   * is not a subset of the diff the reviewer approved has authored bytes the reviewer never
   * judged (BUGS.md 2026-10-01: a resolver restored code main had deliberately reverted, and
   * the build check alone waved it onto main). mergeToMain calls this once, only on the conflict
   * path, only when the resolved diff diverges, with the worktree sitting on the resolved head;
   * "rejected" is terminal for the pin (the closure owns the ref and
   * the reject bookkeeping); "retry" keeps the ref for recovery's re-merge (an aborted or
   * under-cap-failed reviewer is not a verdict about the tree). Optional: without it no
   * re-rejection happens. */
  recheckResolved?(wt: string): Promise<{
    verdict: "approved" | "rejected" | "retry";
  }>;
}

/** Merge the worktree branch on main under the shared merge lock: rebase it onto main (keeping
 * history linear) and fast-forward. On conflict, makes one pi-driven resolution attempt
 * (outside the lock) before giving up. A routine conflict is normal operation, not a warning:
 * success merges as an ordinary `merged` event and failure surfaces via the run's merge_conflict
 * result — no separate log line for the hand-off itself. A merged diff that adds entries under
 * QUESTIONS.md's ## Open also emits one `question_posted` per new heading alongside the `merged`
 * event, so `tumwater logs` shows what the team is asking for (plans/questions-outbox.md). */
export async function mergeToMain(
  ctx: MergeContext,
  wt: string,
  summary: string,
): Promise<RunResult> {
  // The branch tip before ANY rebase of this merge. Captured once here — not per tryMerge —
  // because the conflict-retry path rebases twice: after pi resolves, the second attempt's
  // rebase is a no-op even though its tree (the resolution) was never checked.
  const preMergeHead = await headOf(wt, "HEAD");
  const first = await tryMerge(ctx, wt, summary);
  if (first !== "merge_conflict") return first;
  if (!(await resolveConflict(ctx, wt, preMergeHead))) return "merge_conflict";
  // A resolution whose diff ahead of main introduces lines the reviewed change never added, or
  // removes lines the reviewed change never removed, has left the reviewer's scope: those bytes
  // were never judged (BUGS.md 2026-10-01: a
  // resolver restored 158 lines main had deliberately reverted). Re-run the gate over the
  // resolved tree before anything merges; a resolution that stays inside the reviewed change's
  // lines — including one that drops branch edits main superseded — re-merges with no extra run.
  if (ctx.recheckResolved && (await resolvedDiffDiverges(ctx, wt, preMergeHead))) {
    const recheck = await ctx.recheckResolved(wt);
    if (recheck.verdict === "rejected") return "rejected";
    if (recheck.verdict === "retry") return "merge_conflict";
    return tryMerge(ctx, wt, summary);
  }
  return tryMerge(ctx, wt, summary);
}

/** Emit one `question_posted` event per entry QUESTIONS.md's ## Open gained since `before`,
 * recorded by merge-questions.ts's logNewQuestions alongside this module's `merged` event. */
async function tryMerge(
  ctx: MergeContext,
  wt: string,
  summary: string,
): Promise<RunResult> {
  return withLock(mergeLockDir(ctx.root), async () => {
    // Capture the Open questions before the rebase so a merged diff that posts new ones can
    // emit one question_posted per entry. The lock keeps no other merge between capture
    // and compare, so the diff is exact; on the conflict path only the second tryMerge call ever
    // reaches the post-ff code, so nothing double-emits.
    const before = openQuestions(ctx.root);
    if (!(await rebaseOntoMain(wt, ctx.mainBranch))) return "merge_conflict";
    // The worktree's POST-REBASE HEAD: a pinned bare sha does not move when git
    // rebase rewrites it — ff'ing main to the original pin would fail as merge_blocked whenever
    // main moved between commit and merge, which under concurrency is the common case (review
    // runs outside this lock). A branch ref tracks its own tip through the rebase, so this is
    // behavior-preserving for role branches.
    const target = await headOf(wt, "HEAD");
    const dirty = await primaryCheckoutBlockers(ctx.root, ctx.mainBranch, target);
    if (dirty !== null) {
      warnEventBestEffort(ctx.root, ctx.role, `merge blocked: ${overwriteBlockedReason(dirty)}`);
      return "merge_blocked";
    }
    const mainBefore = await headOf(ctx.root, ctx.mainBranch);
    const ffFailure = await ffMainToOrWhy(ctx.root, target, ctx.mainBranch);
    if (ffFailure !== null) {
      warnEventBestEffort(ctx.root, ctx.role, `merge blocked: ${ffFailure}`);
      return "merge_blocked";
    }
    const commit = await headOf(ctx.root, ctx.mainBranch);
    // A fast-forward to a commit main already contains is a no-op ("Already up to date"): the
    // change is already an ancestor of main (a leftover-recovery re-merge of an entry main
    // holds), so main's head is some later commit that did not produce this summary. Logging a
    // `merged` event there would count the already-counted merge a second time and pair the
    // change's summary with the wrong commit (BUGS.md 2026-10-10). Only a fast-forward that
    // moved main records a merge.
    // Best-effort: main has already fast-forwarded, so an unwritable events feed must not turn
    // a completed merge into a rejected one and skip syncRootInstall below — the same
    // no-torn-feed policy as the orchestrator's other post-effect logging.
    if (commit !== mainBefore) {
      logEventBestEffort(ctx.root, {
        source: ctx.role,
        type: "merged",
        commit,
        summary,
      });
    }
    logNewQuestions(ctx.root, before, ctx.role);
    // Still under the lock: a merge that moved main's lockfile re-syncs the root install
    // every worktree resolves through before the next merge's check runs (BUGS.md 2026-10-01).
    await syncRootInstall(ctx.root, ctx.role);
    return "changed";
  }, ctx.lockTimeoutMs);
}

/** Continue a stopped rebase, aborting it when it stops again on a second conflict, and
 * report whether the branch now sits cleanly on top of main. resolveConflict reaches this
 * from two points — the deterministic insert-only pass and the pi resolver — and both owe
 * the same abort-on-failure discipline, so it lives here once. */
async function continueOrAbortRebase(wt: string): Promise<boolean> {
  try {
    await continueRebase(wt);
    return true;
  } catch {
    await abortSync(wt);
    return false;
  }
}

/** Re-run the conflicting rebase leaving markers in place, settle insert-only backlog
 * conflicts deterministically, hand the rest to pi, and continue the rebase. Returns true
 * when the branch now sits cleanly on top of main. */
async function resolveConflict(ctx: MergeContext, wt: string, preMergeHead: string): Promise<boolean> {
  const state = await rebaseOntoMainLeaveConflicts(wt, ctx.mainBranch);
  if (state === "clean") return true;
  if (state === "failed") return false;
  const files = await conflictedFiles(wt);
  // Deterministic first pass (plans/parallel-work-instances.md, part 3/7): insert-only
  // conflicts in the backlog markdown — two merges pasting different entries as the first
  // under ## Done, or new entries above an entry the other side deleted — carry no authored
  // bytes, so they are settled without a model run. Only the files it could not resolve (code,
  // or a same-entry edit) reach the resolver below.
  const remaining = await resolveBacklogInsertConflicts(wt, files);
  if (remaining.length === 0) {
    // A second stop is only possible when the branch holds more than the one insert-only
    // commit. One attempt per run.
    return continueOrAbortRebase(wt);
  }
  // The prompt names the project's own check, detected the way the review pre-check detects it
  // — so the resolver neither guesses a runner (BUGS.md 2026-10-05) nor re-runs the check
  // itself while the merge slot waits on it.
  const check = detectBuildCheck(wt, ctx.config) ?? undefined;
  // Show both sides' intent: the change's own commit message and the main commits that touched
  // a conflicted file since the merge-base. The
  // markers alone never said why either side made the edit.
  const since = await changeBaseRev(wt, ctx.mainBranch, preMergeHead);
  const change = (await commitMessage(wt, preMergeHead)) ?? "";
  const { commits, omitted } = await mainCommitsTouching(wt, since, ctx.mainBranch, remaining);
  // The merge cell names the resolver run, not "merging" (a no-op outside a queued merge):
  // the run holds the merge slot, and every queued merge waits on it. Back to `merging` once it
  // ends, whatever happened — the merge's git steps come next, or the merge ends.
  setMergeStage(ctx.root, ctx.role, "resolving");
  let pi: PiRunResult;
  try {
    pi = await ctx.runPi(
      wt,
      // Each file's hunk ranges, so the resolver reads the hunks rather than the file from line 1.
      buildConflictPrompt(ctx.role, conflictedFileHunks(wt, remaining), check, {
        change,
        main: commits,
        mainOmitted: omitted,
      }),
      `tumwater-${ctx.role}-${ctx.runNumber}-conflict`,
      // The resolver rides the strong tier (plans/model-tiers.md part 4/8): resolution is rare,
      // tolerant of latency, and edits code inside merge. Its spend still folds into the
      // authoring role's usage — the fold belongs to the runner's wiring, not to the config.
      resolverConfig(ctx.config),
    );
  } finally {
    setMergeStage(ctx.root, ctx.role, "merging");
  }
  if (!pi.ok || hasConflictMarkers(wt, remaining)) {
    await abortSync(wt);
    return false;
  }
  // A second stop is only possible when pi itself authored extra commits during the run.
  // One resolution attempt per run.
  return continueOrAbortRebase(wt);
}
