import { revertSkipReason } from "../baseline/main-revert.js";
import { reviewRunConfig, seamConcurrencyKey } from "../config/config-views.js";
import { warnEventBestEffort, TUMWATER_SOURCE } from "../events/events.js";
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
import { resolveAuthor, VERIFY_TIER } from "./merge-verify.js";

/** Pipelines with a revert skip check in flight, so a poll does not start a second one. */
const skipChecks = new WeakSet<MergePipeline>();

/** One poll of the post-merge reviews (review.afterMerge): a reviewed-and-rejected commit goes to
 * the revert slot when it and the merge slot are free, and the next unreviewed commit starts its
 * review when a permit is free right now. One review at a time; starts a task and returns. */
export function drainPostReviews(ctx: MergePipelineContext, p: MergePipeline): void {
  const pending = readPostReviews(ctx.root);
  if (pending.length === 0) return;
  const rejected = pending.find((e) => e.rejected !== undefined);
  // The entry stays in the file until its revert has run (startRevert settles it), so a shutdown,
  // or the main-red watch replacing the slot, only delays the revert to a later poll.
  if (rejected && p.revert === null && p.merge === null && !skipChecks.has(p)) {
    // Check the skip reason before filling the slot: drainMerge starts the revert in the same poll.
    skipChecks.add(p);
    const culprit = { commit: rejected.commit, runner: rejected.role, failingTests: [], tip: rejected.commit, postReview: { reasons: rejected.rejected! } };
    void revertSkipReason(ctx.root, ctx.mainBranch, culprit)
      .then((skip) => {
        if (skip !== null) {
          settlePostReview(ctx.root, rejected.commit, null);
          warnEventBestEffort(ctx.root, rejected.role, `not reverting ${shortSha(rejected.commit)} after its post-merge rejection: ${skip}`);
        } else if (p.revert === null && p.merge === null) p.revert = culprit;
      })
      .finally(() => skipChecks.delete(p));
  }
  if (p.postReview !== null || ctx.startHeld()) return;
  const next = pending.find((e) => e.rejected === undefined);
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
