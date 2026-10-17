// vocabulary: plain
import { mergeApproved, type BatchRoleWiring } from "./merge-batch.js";
import { removeMergeChange, resolveWaitStage, setMergeChangeStatus } from "./merge-slot.js";
import { seamConcurrencyKey } from "../config/config-views.js";
import { withProviderLease } from "../concurrency/provider-lease.js";
import { dropMerge, queuedMergeFiles } from "./merge-queue.js";
import { errorMessage } from "../text/text.js";
import { warnEventBestEffort, TUMWATER_SOURCE } from "../events/events.js";
import { saveLoopState } from "../loop/loop-state.js";
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
import { drainVerify, VERIFY_TIER } from "./merge-verify.js";
import type { TickResult } from "../tick/tick-outcome.js";

/** The tier the merge slot's conflict-resolution runs wait at: ahead of any verification parked for
 * a permit, because the merge is the one serial step every queued change waits on. (Nothing that
 * holds a permit ever waits on the merge: no verification takes the merge lock, and the resolver
 * runs outside it — merge-to-main.ts's mergeToMain — so this cannot deadlock.) */
const MERGE_TIER = VERIFY_TIER - 1;

/** One poll of the land queue (the scheduler's WHEN: after the gates, never while a restart or
 * a team hold is pending): start a verification for every queued change the pipeline does not
 * already hold (drainVerify, in merge-verify.ts), and start the merge when the slot is free and
 * something is approved (drainMerge). A queued merge is COMMITTED work awaiting completion, not
 * a new tick, so the budget and user-pause gates deliberately do not hold it (pausing it would
 * leave main behind while the interlock blocks that role's next tick forever). Starts tasks and
 * returns; never awaits them — authors keep ticking behind them, which is the entire point. */
export async function drainMergeQueue(ctx: MergePipelineContext, p: MergePipeline): Promise<void> {
  await drainVerify(ctx, p);
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

/** Start the merge when the slot is free and something is approved: every approved change, up to
 * mergeBatchMax, in queue order among the approved — an unvetted entry ahead of them in the queue
 * (a slow review) does not hold them back. An approved change whose queue entry is gone is
 * forgotten (nothing in-process drops one; defensive). */
export function drainMerge(ctx: MergePipelineContext, p: MergePipeline): void {
  if (p.merge !== null || p.approved.size === 0) return;
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
  picks.splice(ctx.liveConfig.mergeBatchMax);
  if (picks.length === 0) return;
  for (const v of picks) p.approved.delete(v.entry.role);
  p.merge = startMerge(ctx, p, picks);
}

/** The merge task — main's one writer in the pipeline: merge `picks` through mergeApproved on
 * main's current tip — one change through mergeApprovedChange, two or more as one stack with one
 * scope-`batch` check, one fast-forward, and 3d's largest-passing-prefix bisect — with no second
 * review. An approved change whose main moved since its verification is re-checked on the tree that
 * lands (the in-lock re-check, or the stack's check), so an approval that outlived its base never
 * lands unverified. Each defined result is written back and its entry dropped; an unattempted
 * change (behind a bisect's attributed one) goes back to `approved` for the next merge. A plumbing
 * throw keeps every entry queued, but unapproved: each is verified afresh from its pin next poll. A
 * user abort of any merged role stops the whole stack, and every change it had not merged ends
 * "aborted" with its pin discarded; a shutdown keeps the pins. The task takes no permit of its
 * own — its only model run is mergeToMain's conflict resolver, which takes a shared permit at
 * MERGE_TIER for the run's length, outside the merge lock. */
function startMerge(ctx: MergePipelineContext, p: MergePipeline, picks: ApprovedMerge[]): InFlightMerge {
  const { root, mainBranch, signal, roleConfig, semaphore } = ctx;
  const merge: InFlightMerge = {
    promise: Promise.resolve(), // Replaced below; the placeholder satisfies the type.
    controller: new AbortController(),
    roles: picks.map((v) => v.entry.role),
    userAborted: false,
  };
  const detachShutdown = abortOnShutdown(signal, merge.controller);
  const wiring = new Map<string, BatchRoleWiring>(
    picks.map((v) => [
      v.entry.role,
      {
        state: v.author.state,
        foldUsage: v.foldUsage,
        runGatePi: (opts) => v.author.runGatePi(opts),
        runPi: async (w, prompt, s, cfg) => {
          // A parked resolver names its wait (resolve-wait, then resolving once granted) the way
          // a parked check does (withCheckPermit): on 2026-10-12 one waited 2.5 min for a permit
          // with the merge queue behind it, reading as "merging". The lease is keyed on the
          // resolver config's provider (the `cfg` it is handed), so the conflict resolution
          // counts against the strong tier's provider cap like any other strong-tier run
          // (plans/provider-concurrency.md §4). canLeaseAtOnce is acquireLease's own fast path
          // decided synchronously, so a free permit shows no wait; MERGE_TIER ignores the
          // maintenance reserve.
          const key = cfg ? seamConcurrencyKey(cfg, ctx.piDefault) : undefined;
          const hooks = resolveWaitStage(root, v.entry.role);
          if (!semaphore.canLeaseAtOnce(MERGE_TIER, key)) hooks.waiting();
          const lease = await semaphore.acquireLease(MERGE_TIER, key);
          hooks.granted();
          try {
            // The resolver's lease rides in the provider-lease store for its run, so the run
            // re-keys it to the provider it actually uses (plans/provider-concurrency.md §5).
            return await withProviderLease(
              lease,
              semaphore,
              () => v.author.runLandingPi(w, prompt, s, cfg),
              { piDefault: ctx.piDefault },
            );
          } finally {
            lease.release();
          }
        },
      },
    ]),
  );
  const task = (async () => {
    let results: Array<TickResult | undefined>;
    let threw = false;
    // A result reaches settleMergeOutcome the moment mergeApproved finalizes it, not after the
    // whole batch; this set lets the end-of-batch loop skip what is already written back.
    const settled = new Set<number>();
    const settleOne = async (s: number, result: TickResult): Promise<void> => {
      const v = picks[s]!;
      settled.add(s);
      await settleMergeOutcome(root, v.entry, v.author.state, result, Date.now() - v.startedAt, v.usage, v.file);
    };
    try {
      results = await mergeApproved(
        {
          root,
          mainBranch,
          config: roleConfig,
          signal: () => merge.controller.signal,
          onChangeStatus: (role, status) => setMergeChangeStatus(root, role, status),
          onResult: settleOne,
          runGatePi: (opts) => picks[0]!.author.runGatePi(opts),
        },
        picks.map((v) => ({
          role: v.entry.role,
          sha: v.sha,
          tick: v.entry.run,
          summary: v.entry.summary,
          body: v.entry.body,
          highFriction: v.entry.highFriction,
          ...(v.entry.revisionRound !== undefined ? { revisionRound: v.entry.revisionRound } : {}),
          ...(v.entry.priorReview !== undefined ? { priorReview: v.entry.priorReview } : {}),
          ...(v.verifiedHead !== undefined ? { verifiedHead: v.verifiedHead } : {}),
        })),
        (role) => wiring.get(role)!,
      );
    } catch (err) {
      threw = true;
      results = picks.map(() => undefined);
      const head = picks[0]!.author;
      head.state.lastError = errorMessage(err);
      // The catch exists to keep every entry queued and unapproved when mergeApproved throws. A
      // throw out of this write — an unwritable state file — must not skip the settle loop
      // and the finally that frees the merge slot, or the pipeline wedges with p.merge set
      // forever; the write is bookkeeping a later save retries, so warn and keep going.
      try {
        saveLoopState(root, head.state);
      } catch (writeErr) {
        warnEventBestEffort(
          root,
          TUMWATER_SOURCE,
          `the merge error for ${head.state.role} could not be saved: ${errorMessage(writeErr)}`,
        );
      }
    }
    try {
      for (let s = 0; s < picks.length; s++) {
        const v = picks[s]!;
        const { role } = v.entry;
        if (settled.has(s)) continue; // already written back through onResult
        const result = results[s] ?? (merge.userAborted ? "aborted" : undefined);
        if (result === undefined && !threw) {
          p.approved.set(role, v);
          setMergeChangeStatus(root, role, "approved");
          continue;
        }
        if (result !== undefined) {
          await settleOne(s, result);
        } else {
          removeMergeChange(root, role);
        }
      }
    } finally {
      detachShutdown();
      if (merge.userAborted) await discardPinnedRefs(root, merge.roles);
      p.merge = null;
    }
  })();
  merge.promise = guardMergeTask(root, merge.roles.join(", "), task);
  return merge;
}
