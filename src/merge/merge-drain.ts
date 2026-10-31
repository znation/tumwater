import { mergeApprovedChange, type MergerContext } from "./merge-core.js";
import { removeMergeChange, resolveWaitStage, setMergeChangeStatus } from "./merge-slot.js";
import { withRunPermit } from "../concurrency/run-permit.js";
import { dropMerge, entryRevisionFields, queuedMergeFiles } from "./merge-queue.js";
import { errorMessage } from "../text/text.js";
import { warnEventBestEffort, TUMWATER_SOURCE } from "../events/events.js";
import { saveRunnerState } from "../runner/runner-state.js";

import { addPostReview } from "../review/post-merge-review.js";
import { drainPostReviews } from "./merge-post-review-drain.js";
import { subscribeEvents } from "../events/events.js";
import { treeDiffFiles } from "../git/git-diff.js";
import { isExemptDiff } from "../review/exemptions.js";
import type { TumwaterConfig } from "../config/config-schema.js";
import {
  abortOnShutdown,
  discardPinnedRefs,
  guardMergeTask,
  settleMergeOutcome,
  type InFlightMerge,
  type MergePipeline,
  type MergePipelineContext,
  type ApprovedMerge,
} from "./merge-pipeline.js";
import { drainVerify, MERGE_TIER } from "./merge-verify.js";
import type { RunResult } from "../run/run-outcome.js";

/** Whether a merged change still needs a post-merge review: the pre-merge gate skips review when
 * it is disabled or the diff is exempt, so those changes queue none either. A diff that cannot be
 * read queues the review. */
async function postReviewDue(config: TumwaterConfig, root: string, commit: string): Promise<boolean> {
  if (!config.review.enabled) return false;
  const files = await treeDiffFiles(root, `${commit}^`, commit);
  return files === null || !isExemptDiff(files, config.review.exemptPaths);
}

/** One poll of the merge queue (the scheduler's WHEN: after the gates, never while a restart
 * or a disk hold is pending — a reviewer-provider hold does not stop the whole drain: it parks
 * only the post-merge review drain, whose no-role startHeld reads it, never a merge entry, so
 * no verify or landing waits on the reviewer): start a
 * verification for every queued change the pipeline does not already hold (drainVerify, in
 * merge-verify.ts), and start the merge when the slot is free and something is approved
 * (drainMerge). A queued merge is COMMITTED work awaiting completion, not a new run, so the
 * budget and user-pause gates deliberately do not hold it (pausing it would leave main behind
 * while the interlock blocks that role's next run forever). Starts tasks and returns; never
 * awaits them — authors keep running behind them, which is the entire point. */
export async function drainMergeQueue(ctx: MergePipelineContext, p: MergePipeline): Promise<void> {
  await drainVerify(ctx, p);
  drainPostReviews(ctx, p);
  drainMerge(ctx, p);
}

/** Settle every approved change `tumwater abort --role` flagged (consumeAbortRequests over
 * abortableMerges): it has no task to stop, so it ends here exactly as an aborted merge
 * does — "aborted" written back, entry dropped, pin discarded (the deliberate stop throws the
 * committed work away). The scheduler runs it every poll right after consuming the requests,
 * held or not: a restart hold that skipped it would hand the flagged change, pin intact, to
 * the next generation to merge.
 *
 * Unlike a verification or a merge, this settles in the poll body with nothing to guard it: a throw
 * out of the outcome write — an unwritable state file — would end the team's run. It must also
 * never leave the deliberately aborted change queued (an abandoned queue file would be
 * re-verified and merged next poll, against the operator's intent) or keep its pin. So a failed
 * write is reported and the abort honored by hand: queue file and marker dropped, pin
 * discarded. */
export async function settleAbortedApproved(root: string, p: MergePipeline): Promise<void> {
  for (const [role, v] of [...p.approved]) {
    if (!v.userAborted) continue;
    p.approved.delete(role);
    try {
      await settleMergeOutcome(root, v.entry, v.author.state, "aborted", Date.now() - v.startedAt, v.usage, v.file);
    } catch (err) {
      warnEventBestEffort(root, TUMWATER_SOURCE, `the stopped merge for ${role} could not be settled: ${errorMessage(err)}`);
      dropMerge(v.file);
      removeMergeChange(root, role);
    }
    await discardPinnedRefs(root, [role]);
  }
}

/** Start the merge when the slot is free and something is approved: every approved change, in
 * queue order among the approved — an unapproved entry ahead of them in the queue
 * (a slow review) does not hold them back. An approved change whose queue entry is gone is
 * forgotten (nothing in-process drops one; defensive). */
export function drainMerge(ctx: MergePipelineContext, p: MergePipeline): void {
  if (p.merge !== null) return;
  if (p.approved.size === 0) return;
  const queued = queuedMergeFiles(ctx.root);
  const files = new Set(queued.map((q) => q.file));
  for (const [role, v] of [...p.approved]) {
    if (files.has(v.file)) continue;
    p.approved.delete(role);
    removeMergeChange(ctx.root, role);
  }
  const picks = queued.flatMap((q) => {
    const v = p.approved.get(q.entry.role);
    return v?.file === q.file ? [v] : [];
  });
  if (picks.length === 0) return;
  for (const v of picks) p.approved.delete(v.entry.role);
  p.merge = startMerge(ctx, p, picks);
}

/** The merge task — main's one writer in the pipeline: merge `picks` one change at a time,
 * each through mergeApprovedChange (a rebase onto main's tip then the fast-forward under the
 * merge lock), with no second review and no shared stack check — a merge is a rebase and a
 * fast-forward. Each defined result is written back and its entry dropped; a change whose merge
 * leaves it non-terminal (a resolver conflict, a loss to main) keeps entry + ref for the next
 * merge, or is re-queued by settleMergeOutcome. A plumbing throw keeps every entry queued, but
 * unapproved: each is verified afresh from its pin next poll. A user abort of any merged role
 * stops the merge, and every change it had not merged ends "aborted" with its pin discarded; a
 * shutdown keeps the pins. The task takes no permit of its own — its only model run is
 * mergeToMain's conflict resolver, which takes a shared permit at MERGE_TIER for the run's
 * length, outside the merge lock. */
function startMerge(ctx: MergePipelineContext, p: MergePipeline, picks: ApprovedMerge[]): InFlightMerge {
  const { root, mainBranch, signal, roleConfig, semaphore } = ctx;
  const merge: InFlightMerge = {
    promise: Promise.resolve(), // Replaced below; the placeholder satisfies the type.
    controller: new AbortController(),
    roles: picks.map((v) => v.entry.role),
    userAborted: false,
  };
  const detachShutdown = abortOnShutdown(signal, merge.controller);
  // Each change's MergerContext, resolved from its authoring runner: the live state, the role's
  // usage fold and shared pi wiring (the resolver's permit rides in the run-permit store for its
  // run, so an idle pause inside it re-takes the same team permit).
  const mergerCtxOf = (v: ApprovedMerge): MergerContext => ({
    root,
    mainBranch,
    config: roleConfig,
    state: v.author.state,
    foldUsage: v.foldUsage,
    runGatePi: (opts) => v.author.runGatePi(opts),
    runPi: async (w, prompt, s, cfg) => {
      // A parked resolver names its wait (resolve-wait, then resolving once granted) the way
      // a parked check does (withCheckPermit): on 2026-10-12 one waited 2.5 min for a permit
      // with the merge queue behind it, reading as "merging". The resolution waits on the
      // one team total (maxConcurrent) like any other MERGE_TIER run
      // (plans/provider-concurrency.md §4). canLeaseAtOnce is acquireLease's own fast path
      // decided synchronously, so a free permit shows no wait; MERGE_TIER ignores the
      // maintenance reserve.
      const hooks = resolveWaitStage(root, v.entry.role);
      if (!semaphore.canLeaseAtOnce(MERGE_TIER)) hooks.waiting();
      const lease = await semaphore.acquireLease(MERGE_TIER);
      hooks.granted();
      try {
        // The resolver's lease rides in the run-permit store for its run, so an idle
        // pause inside it (a failed review's in-place retry) re-takes the same permit.
        return await withRunPermit(lease, () => v.author.runMergePi(w, prompt, s, cfg));
      } finally {
        lease.release();
      }
    },
    signal: () => merge.controller.signal,
    reviewHeld: () => ctx.startHeld(),
  });
  const task = (async () => {
    // Each change's terminal outcome: `undefined` means the merge did not reach it (a plumbing
    // throw, or a change stopped short) and it keeps its entry for the next merge.
    const results: Array<RunResult | undefined> = picks.map(() => undefined);
    const settled = new Set<number>();
    // A `merged` event names the commit each role produced, identified by its `source`: the
    // post-merge review of every merged role is queued once the change settles as merged.
    const mergedCommits = new Map<string, string>();
    const unsubscribe = subscribeEvents((e) => {
      if (e.type === "merged" && typeof e.commit === "string") mergedCommits.set(e.source, e.commit);
    });
    // A result reaches settleMergeOutcome the moment its merge finalizes it — a change whose
    // merge is already final settles before a later change's conflict resolver returns.
    const settleOne = async (s: number, result: RunResult): Promise<void> => {
      const v = picks[s]!;
      settled.add(s);
      const mergedCommit = mergedCommits.get(v.entry.role);
      if (result === "changed" && mergedCommit !== undefined && (await postReviewDue(ctx.liveConfig, root, mergedCommit))) {
        addPostReview(root, { commit: mergedCommit, role: v.entry.role, summary: v.entry.summary, ...(v.entry.body !== undefined ? { body: v.entry.body } : {}) });
      }
      await settleMergeOutcome(root, v.entry, v.author.state, result, Date.now() - v.startedAt, v.usage, v.file, mainBranch);
    };
    for (let s = 0; s < picks.length; s++) {
      const v = picks[s]!;
      const { role } = v.entry;
      if (merge.userAborted) {
        // A user abort between merges stops the run at its next step boundary: the roles it had
        // not merged end "aborted" here (their pins discarded in the finally).
        results[s] = "aborted";
        continue;
      }
      setMergeChangeStatus(root, role, "merging");
      try {
        results[s] = await mergeApprovedChange(
          mergerCtxOf(v),
          {
            role,
            sha: v.sha,
            runNumber: v.entry.run,
            summary: v.entry.summary,
            body: v.entry.body,
            highFriction: v.entry.highFriction,
            ...entryRevisionFields(v.entry),
            ...(v.verifiedHead !== undefined ? { verifiedHead: v.verifiedHead } : {}),
          },
        );
        await settleOne(s, results[s]!);
      } catch (err) {
        // A plumbing throw keeps every entry queued and unapproved: this change's merge did not
        // complete, the message rides on its role's state, and the next poll re-verifies every
        // not-yet-settled change from its surviving pin. (The changes already settled above keep
        // their outcomes.)
        v.author.state.lastError = errorMessage(err);
        // The catch exists to keep every entry queued and unapproved when a merge throws. A
        // throw out of this write — an unwritable state file — must not skip the settle loop
        // and the finally that frees the merge slot, or the pipeline wedges with p.merge set
        // forever; the write is bookkeeping a later save retries, so warn and keep going.
        try {
          saveRunnerState(root, v.author.state);
        } catch (writeErr) {
          warnEventBestEffort(
            root,
            TUMWATER_SOURCE,
            `the merge error for ${role} could not be saved: ${errorMessage(writeErr)}`,
          );
        }
        break;
      }
    }
    // The roles the merge stopped short of (a throw on s, or roles behind it) keep their
    // queue entries and pins for the next poll — each is verified afresh from its pin then;
    // clear their marker records so no role reads as still "merging". A user abort stopping
    // the run instead settles every unsettled role as "aborted" and discards its pin in the
    // finally below.
    for (let s = 0; s < picks.length; s++) {
      if (settled.has(s)) continue; // already written back
      if (merge.userAborted) await settleOne(s, "aborted");
      else removeMergeChange(root, picks[s]!.entry.role);
    }
    try {
    } finally {
      unsubscribe();
      detachShutdown();
      if (merge.userAborted) await discardPinnedRefs(root, merge.roles);
      p.merge = null;
    }
  })();
  merge.promise = guardMergeTask(root, merge.roles.join(", "), task);
  return merge;
}
