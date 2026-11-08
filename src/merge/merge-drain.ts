import fs from "node:fs";
import path from "node:path";
import { mergeApprovedChange, RETRIABLE_MERGE_RESULTS, type MergerContext } from "./merge-core.js";
import { addMergeChange, mergeUsage, removeMergeChange, resolveWaitStage, setMergeChangeStatus } from "./merge-slot.js";
import { withRunPermit } from "../concurrency/run-permit.js";
import { dropMerge, entryRevisionFields, queuedMergeFiles, type MergeEntry } from "./merge-queue.js";
import { branchHead } from "../git/git.js";
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
  acquireUnlessAborted,
  discardPinnedRefs,
  guardMergeTask,
  settleMergeOutcome,
  type InFlightMerge,
  type MergePipeline,
  type MergePipelineContext,
} from "./merge-pipeline.js";
import { dropTornHead, mergedIntoMain } from "./merge-head.js";
import { MERGE_TIER, VERIFY_TIER, resolveAuthor } from "./merge-author.js";
import type { RoleRunner } from "../runner/runner.js";
import type { PiRunResult } from "../pi/pi-run-result.js";
import type { RunResult } from "../run/run-outcome.js";

/** The one change a gate-then-merge task holds, built in memory by startMerge: the queue
 * entry, when the task started (the outcome event's durationMs runs from here), and the
 * authoring runner's wiring — the gate and merge run with its state, usage fold and pi. The
 * task's own InFlightMerge carries the controller and the abort flags. */
interface MergeTaskRecord {
  entry: MergeEntry;
  startedAt: number;
  author: RoleRunner;
  foldUsage: (run: PiRunResult) => void;
}

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
 * no verify or landing waits on the reviewer): the no-role post-merge review drain, then the
 * merge drain's one serial gate-then-merge task per queue head — a queued change is gated and
 * merged by the one task (drainMerge, below), and the verify stage no longer runs at all. A
 * queued merge is COMMITTED work awaiting completion, not a new run, so the budget and
 * user-pause gates deliberately do not hold it (pausing it would leave main behind while the
 * interlock blocks that role's next run forever). Starts tasks and returns; never awaits them
 * — authors keep running behind them, which is the entire point. */
export async function drainMergeQueue(ctx: MergePipelineContext, p: MergePipeline): Promise<void> {
  drainPostReviews(ctx, p);
  await drainMerge(ctx, p);
}

/** The merge drain — the queue's one whole stage: drop the torn head, dedupe every
 * already-merged entry against main, then start ONE gate-then-merge task for the first eligible
 * queue head in queue order. The checks the verify stage used to own — torn-head recovery, the
 * already-merged dedupe, `notBefore` and `startHeld` — run here in the serial drain, so a
 * queued change is gated and merged by the one task (startMerge) and no verification starts at
 * all. An entry whose gate/merge the pipeline does not reach stays queued for the next poll;
 * the merge slot frees when its task settles, so the next poll starts the next head. */
export async function drainMerge(ctx: MergePipelineContext, p: MergePipeline): Promise<void> {
  if (p.merge !== null) return;
  await dropTornHead(ctx.root);
  const queued = queuedMergeFiles(ctx.root);
  // One main-head read per poll with a non-empty queue (branchHead's ref-file fast path — no
  // spawn), serving every entry's cached dedupe verdict below.
  const mainHead = queued.length === 0 ? "" : ((await branchHead(ctx.root, ctx.mainBranch)) ?? "");
  for (const { entry, file } of queued) {
    if (p.merge !== null) return; // one task at a time: the rest wait in the queue
    // A re-queued review_error waits out its delay; the entry stays queued and holds its author.
    if (entry.notBefore !== undefined && Date.now() < entry.notBefore) continue;
    if (await mergedIntoMain(ctx.root, entry.sha, ctx.mainBranch, mainHead)) {
      // An entry whose sha main already holds (a crash between the fast-forward and the
      // entry drop) is dropped without a run, with its marker record. The drop can throw (a
      // queue file that is a directory or locked fails fs.rmSync, the shape an ENOSPC or
      // immutable queue file takes); this runs in the poll body with nothing to guard it —
      // report it and leave the entry for the next poll, as dropTornHead guards its own drop.
      try {
        dropMerge(file);
      } catch (err) {
        warnEventBestEffort(ctx.root, TUMWATER_SOURCE, `merge queue entry ${path.basename(file)} could not be dropped: ${errorMessage(err)}`);
      }
      removeMergeChange(ctx.root, entry.role);
      continue;
    }
    // The dedupe awaited git: a task that settled meanwhile may have dropped this very entry
    // while the dedupe was in flight. Start nothing for it.
    if (!fs.existsSync(file)) continue;
    // A reviewer hold parks no named entry — every entry keeps draining (no verify, start or
    // landing waits on the reviewer); only a restart or disk hold (the start gate's other legs)
    // parks it here. The start gate decides.
    if (ctx.startHeld(entry.role)) continue;
    p.merge = startMerge(ctx, p, entry, file);
    return;
  }
}

/** Signals that a restart or disk hold closed the start gate while the task waited for its
 * gate permit, so the gate must not start. The task keeps its entry queued exactly as a parked
 * verification did; it is control flow, not a failure, so the task's catch does not record it. */
class GateDeferredByHold extends Error {}

/** The merge task — main's one writer in the pipeline: the first eligible queue head's gate and
 * merge in one task (a rebase onto main's tip then the fast-forward under the merge lock). The
 * task's `mergeApprovedChange` call owns the change's ONE gate: it runs
 * `reviewQueuedChange` in the merge worktree under the gate's VERIFY_TIER team lease
 * (mergerCtxOf's gatePermit, released by merge-core before `mergeToMain`) before the merge, so
 * a queued diff never merges unreviewed and never pays a second gate. Each defined result is
 * written back and its entry dropped; a merge that leaves the change non-terminal (a resolver
 * conflict, a loss to main) keeps entry + ref for the next merge, or is re-queued by
 * settleMergeOutcome. A plumbing throw keeps the entry queued, but unapproved: its one
 * gate-then-merge is re-run from its pin next poll. A user abort of the task's role stops the
 * merge, and the change ends "aborted" with its pin discarded; a shutdown keeps the pins. The
 * task takes no permit of its own — its only model runs are the gate's reviewer, under the
 * gatePermit VERIFY_TIER lease the gate's call holds, and merge-to-main.ts's conflict
 * resolver, which takes a shared permit at MERGE_TIER for the run's length, outside the merge
 * lock. */
function startMerge(ctx: MergePipelineContext, p: MergePipeline, entry: MergeEntry, file: string): InFlightMerge {
  const { root, mainBranch, signal, roleConfig, semaphore } = ctx;
  const author = resolveAuthor(ctx, entry.role);
  const { usage, foldUsage } = mergeUsage(author, root);
  const merge: InFlightMerge = {
    promise: Promise.resolve(), // Replaced below; the placeholder satisfies the type.
    controller: new AbortController(),
    roles: [entry.role],
    userAborted: false,
  };
  const detachShutdown = abortOnShutdown(signal, merge.controller);
  // The one change the task holds. `file` is the entry's queue file (dropped once the outcome
  // is written), `usage` the task's own spend — both ride the closures below.
  const v: MergeTaskRecord = {
    entry,
    startedAt: Date.now(),
    author,
    foldUsage,
  };
  // Each change's MergerContext, resolved from its authoring runner: the live state, the role's
  // usage fold and shared pi wiring (the resolver's permit rides in the run-permit store for its
  // run, so an idle pause inside it re-takes the same team permit).
  const mergerCtxOf = (v: MergeTaskRecord): MergerContext => ({
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
    gatePermit: async () => {
      // A gating call holds the verify stage's team lease around its gate — the same VERIFY_TIER
      // a verification used to hold — and merge-core's mergeApprovedChange releases it before
      // `mergeToMain`, whose conflict resolver takes MERGE_TIER itself. So one merge never holds
      // both tiers at once, and the gate's lease waits for the same team total as a
      // verification's did. A shutdown hands back any late grant and defers the gate: the entry
      // stays queued for the next generation, exactly as a parked verification did.
      const lease = await acquireUnlessAborted(semaphore, VERIFY_TIER, merge.controller.signal);
      // The start gate can close while the permit wait runs (a restart or disk hold). Re-check it
      // at the grant, as a parked verification does: a task queued before the hold must not start
      // its gate mid-drain or into the storm.
      if (lease === null || merge.controller.signal.aborted || ctx.startHeld(entry.role)) {
        lease?.release();
        throw new GateDeferredByHold();
      }
      return () => {
        lease.release();
      };
    },
  });
  const task = (async () => {
    const { role } = entry;
    // Open the change's marker record — the observers read it from the moment the task starts.
    // The serial drain holds exactly this role's one task, so the marker keeps only its record.
    addMergeChange(root, entry, new Set([entry.role]));
    // The change's terminal outcome: `undefined` means the merge did not reach it (a plumbing
    // throw, or a user abort that stopped the run) and it keeps its entry.
    let result: RunResult | undefined;
    let settled = false;
    // A `merged` event names the commit the role produced, identified by its `source`: the
    // post-merge review of the merged change is queued once it settles as merged.
    let mergedCommit: string | undefined;
    const unsubscribe = subscribeEvents((e) => {
      if (e.type === "merged" && e.source === role && typeof e.commit === "string") mergedCommit = e.commit;
    });
    // A result reaches settleMergeOutcome the moment the merge finalizes it.
    const settleOne = async (r: RunResult): Promise<void> => {
      settled = true;
      if (r === "changed" && mergedCommit !== undefined && (await postReviewDue(ctx.liveConfig, root, mergedCommit))) {
        addPostReview(root, { commit: mergedCommit, role, summary: entry.summary, ...(entry.body !== undefined ? { body: entry.body } : {}) });
      }
      await settleMergeOutcome(root, entry, author.state, r, Date.now() - v.startedAt, usage, file, mainBranch);
    };
    try {
      if (merge.userAborted) {
        // A user abort that lands before the change starts ends it here: "aborted" written back,
        // the entry dropped, and (in the finally) the pin discarded.
        result = "aborted";
      } else {
        setMergeChangeStatus(root, role, "merging");
        try {
          result = await mergeApprovedChange(
            mergerCtxOf(v),
            {
              role,
              sha: entry.sha,
              runNumber: entry.run,
              summary: entry.summary,
              // The task owns the change's one gate: mergeApprovedChange runs reviewQueuedChange
              // under gatePermit before mergeToMain.
              ...(entry.claim !== undefined ? { claim: entry.claim } : {}),
              body: entry.body,
              highFriction: entry.highFriction,
              ...entryRevisionFields(entry),
            },
          );
        } catch (err) {
          // A hold that closed the gate during the permit wait defers the gate: the task keeps
          // its entry for the next poll and records no failure. Any other throw is a plumbing
          // failure: the entry stays queued and unapproved, the message rides on its role's
          // state, and the next poll re-runs it on the surviving pin.
          if (!(err instanceof GateDeferredByHold)) {
            author.state.lastError = errorMessage(err);
            // The catch exists to keep the entry queued when the merge throws. A throw out of
            // this write — an unwritable state file — must not skip the settle and the finally
            // that frees the merge slot, or the pipeline wedges with p.merge set forever; the
            // write is bookkeeping a later save retries, so warn and keep going.
            try {
              saveRunnerState(root, author.state);
            } catch (writeErr) {
              warnEventBestEffort(
                root,
                TUMWATER_SOURCE,
                `the merge error for ${role} could not be saved: ${errorMessage(writeErr)}`,
              );
            }
          }
        }
      }
      // Settle the outcome the task reached — outside the catch, so a throw settling it (an
      // unwritable state or queue file) surfaces through the task's guard and the finally still
      // frees the slot, exactly as the merge's second-loop abort settlement did before the drain
      // collapse. A change the merge did not reach (a plumbing throw) keeps its entry for the
      // next poll and clears its marker record; a user abort settles the change as "aborted" and
      // discards its pin in the finally below.
      if (!settled) {
        // A completed outcome wins over a late abort, so a merge that already landed is never
        // rewritten as "aborted". A retriable outcome has not landed, though: there the
        // operator's stop wins, so the change cannot be re-queued against the pin the finally
        // then discards. A change with no result (deferred or thrown before its outcome)
        // settles aborted for a user stop as well.
        if (result !== undefined && !(merge.userAborted && RETRIABLE_MERGE_RESULTS.has(result))) await settleOne(result);
        else if (merge.userAborted) await settleOne("aborted");
        else removeMergeChange(root, role);
      }
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
