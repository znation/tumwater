import { withProviderLease } from "../concurrency/provider-lease.js";
import { reviewRunConfig, seamConcurrencyKey } from "../config/config-views.js";
import { subscribeEvents, warnEventBestEffort, TUMWATER_SOURCE } from "../events/events.js";
import { deleteRef, headOf, subjectOfCommit } from "../git/git.js";
import { ensureDetachedWorktree } from "../git/worktree.js";
import { useWorktree } from "../git/worktree-use.js";
import { postReviewWorktreePath, reviewFixRef } from "../paths.js";
import {
  POST_REVIEW_FAILURE_LIMIT,
  readPostReviews,
  reviewMergedCommit,
  settlePostReview,
  type PostReview,
} from "../review/post-merge-review.js";
import { shortSha } from "../text/format.js";
import { errorMessage } from "../text/text.js";
import { abortOnShutdown, acquireUnlessAborted, guardMergeTask, type InFlightMerge, type MergePipeline, type MergePipelineContext } from "./merge-pipeline.js";
import { resolveWaitStage } from "./merge-slot.js";
import { mergeToMain } from "./merge-to-main.js";
import { MERGE_TIER, resolveAuthor, VERIFY_TIER } from "./merge-verify.js";
import type { RunResult } from "../run/run-outcome.js";

/** One poll of the post-merge reviews (review.afterMerge): a rejected-and-not-fixed commit is
 * answered by the reviewer's own landed fix (Forward, never back 1/6) — never by a revert — and
 * the next unreviewed commit starts its review when a permit is free right now. One review at a
 * time; starts a task and returns. */
export function drainPostReviews(ctx: MergePipelineContext, p: MergePipeline): void {
  const pending = readPostReviews(ctx.root);
  if (pending.length === 0) return;
  if (p.postReview !== null || ctx.startHeld()) return;
  // A `fixed` entry is a settled record naming both shas (the reviewed commit and its landed fix)
  // — it is not a pending unreviewed commit, so it is never re-reviewed (Forward never back 1a/6).
  const next = pending.find((e) => e.rejected === undefined && e.fixed === undefined);
  if (next) p.postReview = startPostReview(ctx, p, next);
}

function startPostReview(ctx: MergePipelineContext, p: MergePipeline, entry: PostReview): InFlightMerge {
  const { root, semaphore } = ctx;
  const task: InFlightMerge = { promise: Promise.resolve(), controller: new AbortController(), roles: [], userAborted: false, parked: true };
  const detach = abortOnShutdown(ctx.signal, task.controller);
  const author = resolveAuthor(ctx, entry.role);
  const key = seamConcurrencyKey(reviewRunConfig(ctx.liveConfig), ctx.piDefault);
  const run = (async () => {
    try {
      if (!semaphore.canLeaseAtOnce(VERIFY_TIER, key)) return; // permits are busy; try again next poll
      const lease = await acquireUnlessAborted(semaphore, VERIFY_TIER, task.controller.signal, key);
      task.parked = false;
      if (lease === null) return;
      let outcome;
      try {
        outcome = await reviewMergedCommit(root, ctx.liveConfig, entry, (opts) => author.runGatePi(opts), task.controller.signal);
      } finally {
        lease.release();
      }
      if (task.controller.signal.aborted) return; // a shutdown: the entry stays for the next generation
      if (outcome.kind === "approve") settlePostReview(root, entry.commit, null);
      else if (outcome.kind === "reject") settlePostReview(root, entry.commit, { ...entry, rejected: outcome.reasons });
      else if (outcome.kind === "fixed") await mergeReviewerFix(ctx, entry, outcome.fix);
      else {
        const failures = (entry.failures ?? 0) + 1;
        warnEventBestEffort(root, entry.role, `the post-merge review of ${shortSha(entry.commit)} failed (${outcome.detail})`);
        if (failures >= POST_REVIEW_FAILURE_LIMIT) {
          warnEventBestEffort(root, entry.role, `dropping the post-merge review of ${shortSha(entry.commit)} after ${failures} failed runs; it stays on main unreviewed`);
          settlePostReview(root, entry.commit, null);
        } else settlePostReview(root, entry.commit, { ...entry, failures, lastFailure: outcome.detail });
      }
    } catch (err) {
      warnEventBestEffort(root, TUMWATER_SOURCE, `the post-merge review of ${shortSha(entry.commit)} could not run: ${errorMessage(err)}`);
    } finally {
      detach();
      p.postReview = null;
    }
  })();
  task.promise = guardMergeTask(root, `post-merge review of ${shortSha(entry.commit)}`, run);
  return task;
}

/** Land a reviewer's fix commit on main through the ordinary change path — mergeToMain, whose
 * gate runs over the fix tree and whose mergeLockDir lock serializes it with every other write
 * to main — then settle the entry `fixed` naming both shas. A landing that fails (a conflict, a
 * red gate, a refused fast-forward) leaves main at the reviewed commit and keeps the entry with
 * its failure recorded for the next poll's retry, exactly as a failed run is kept today — up to
 * the same POST_REVIEW_FAILURE_LIMIT the verdict-less-review path obeys, so the at-risk doctor
 * row/alert's "one more failed run drops it" stays true and the reviewer is not re-run forever;
 * the review-fix ref survives so leftover recovery can still reach the commit.
 * Throws when git could not start; a failed merge itself returns a non-terminal RunResult and
 * is never a throw. */
async function mergeReviewerFix(ctx: MergePipelineContext, entry: PostReview, fix: string): Promise<void> {
  const author = resolveAuthor(ctx, entry.role);
  // The fix merge's conflict resolver rides the same provider lease the merge slot's resolver
  // does (merge-drain.ts startMerge): the MERGE_TIER lease is keyed on the resolver config's
  // provider and rides in the provider-lease store, so a conflict resolution counts against the
  // strong tier's cap like any other strong-tier run instead of acquiring a provider unchecked.
  const runPi = async (wt: string, prompt: string, sessionName: string, config?: Parameters<typeof author.runMergePi>[3]) => {
    const key = config ? seamConcurrencyKey(config, ctx.piDefault) : undefined;
    const hooks = resolveWaitStage(ctx.root, entry.role);
    if (!ctx.semaphore.canLeaseAtOnce(MERGE_TIER, key)) hooks.waiting();
    const lease = await ctx.semaphore.acquireLease(MERGE_TIER, key);
    hooks.granted();
    try {
      return await withProviderLease(
        lease,
        ctx.semaphore,
        () => author.runMergePi(wt, prompt, sessionName, config),
        { piDefault: ctx.piDefault },
      );
    } finally {
      lease.release();
    }
  };
  // Land through the merge's own write path — mergeToMain fast-forwards main under the shared
  // mergeLockDir mutex, so a fix landing and the ordinary merge slot serialize on main's one
  // writer either way — but from the DEDICATED post-review worktree (which already holds the fix
  // commit), NOT the shared `_merge` checkout that belongs to the merge slot. That removes the
  // race the merge slot's mergeApprovedChangeIn has: each resets and merges its own worktree, so
  // a fix landing can never reset or merge the shared `_merge` worktree concurrently with the
  // merge slot (both could start in one poll), while main's writes stay serialized by the real
  // mergeLockDir mutex. Hold the worktree from before ensureDetachedWorktree through the merge
  // (plans/disk-floor.md part 2/4); this task is the only user of the post-review worktree while
  // p.postReview is held, so the reset-and-merge cannot collide with a fresh review.
  let result: RunResult;
  // The commit that actually merges, from our own `merged` event (not the pre-rebase `fix`):
  // mergeToMain rebases `fix` onto main's tip, so when main moved under the review the landed
  // commit is a different sha — and `fixed` must name a commit that is provably on main.
  // Subscribing mirrors the merge slot's startMerge, so a concurrent merge of another role
  // landing after ours cannot overwrite the sha we record.
  const mergedMine = new Map<string, string>();
  const unsubscribe = subscribeEvents((e) => {
    if (e.type === "merged" && typeof e.commit === "string") mergedMine.set(e.source, e.commit);
  });
  try {
    result = await useWorktree(ctx.root, postReviewWorktreePath(ctx.root), async () => {
      const wt = await ensureDetachedWorktree(ctx.root, postReviewWorktreePath(ctx.root), fix);
      return mergeToMain(
        {
          root: ctx.root,
          role: entry.role,
          mainBranch: ctx.mainBranch,
          config: ctx.liveConfig,
          exemptPaths: ctx.liveConfig.review.exemptPaths,
          runNumber: author.state.runs,
          runPi,
          // A conflict resolution of the reviewer's fix is resolver-authored bytes the reviewer
          // never judged; unlike the merge slot's mergeApprovedChangeIn there is no review gate
          // here to re-run, so a diverging resolution must not merge on the in-lock build check
          // alone (BUGS.md 2026-10-01). Withhold it: the landing reports the conflict, the fix
          // ref and the entry stay for the next poll's retry, and main never carries resolver
          // bytes it was never judged against.
          recheckResolved: async () => ({ verdict: "retry" }),
        },
        wt,
        (await subjectOfCommit(wt, fix)) ?? `Fix ${shortSha(entry.commit)}`,
      );
    });
  } finally {
    unsubscribe();
  }
  if (result === "changed") {
    const merged = mergedMine.get(entry.role) ?? (await headOf(ctx.root, ctx.mainBranch));
    await deleteRef(ctx.root, reviewFixRef(entry.commit)); // the fix is on main; the ref has done its job
    settlePostReview(ctx.root, entry.commit, { ...entry, fixed: merged }); // the entry names the landed fix
    return;
  }
  // A failed merge: main is unmoved, the fix ref survives. Count it against the drop limit -
  // keeping the entry (with the failure recorded) so the next poll retries the review, but
  // dropping it once the limit is reached, so the reviewer is not re-run unboundedly.
  const failures = (entry.failures ?? 0) + 1;
  if (failures >= POST_REVIEW_FAILURE_LIMIT) {
    warnEventBestEffort(ctx.root, entry.role, `dropping the post-merge review of ${shortSha(entry.commit)} after ${failures} failed fix merges; the fix stays unreviewed`);
    await deleteRef(ctx.root, reviewFixRef(entry.commit)); // the merge gave up on the fix; the ref must not pin it forever
    settlePostReview(ctx.root, entry.commit, null);
    return;
  }
  warnEventBestEffort(ctx.root, entry.role, `the post-merge fix of ${shortSha(entry.commit)} could not merge (${result}); it stays queued for the next poll`);
  settlePostReview(ctx.root, entry.commit, { ...entry, failures, lastFailure: `fix did not merge: ${result}` });
}
