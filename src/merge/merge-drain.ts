import fs from "node:fs";
import path from "node:path";
import { mergeApprovedChange, RETRIABLE_MERGE_RESULTS, type MergerContext } from "./merge-core.js";
import { addMergeChange, mergeUsage, removeMergeChange, resolveWaitStage, setMergeChangeStatus } from "./merge-slot.js";
import { withRunPermit } from "../concurrency/run-permit.js";
import { dropMerge, entryRevisionFields, queuedMergeFiles, queuedMergeRoles, type MergeEntry } from "./merge-queue.js";
import { branchHead, refAbsentFromFiles } from "../git/git.js";
import { mergeRefName } from "../paths.js";
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
import { withdrawnEntries } from "./merge-withdrawn.js";
import { pinnedMergeEntry, pinnedRetrySha } from "../runner/runner-leftover.js";
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
 * queue head in queue order — or, when no queue entry is eligible, for a kept pin that has no
 * queue file (a crash between a run's commit and its queue write, or a pin-only writer). The
 * checks the verify stage used to own — torn-head recovery, the
 * already-merged dedupe, `notBefore` and `startHeld` — run here in the serial drain, so a
 * queued change is gated and merged by the one task (startMerge) and no verification starts at
 * all. An entry whose gate/merge the pipeline does not reach stays queued for the next poll;
 * the merge slot frees when its task settles, so the next poll starts the next head. The drain
 * is single-flight (INV-G6): it reserves the slot at the first check and re-checks it right
 * before each startMerge, so overlapping drains (a test that runs a background pump and a
 * pumpUntil) never start a duplicate task for the same head. */
export async function drainMerge(ctx: MergePipelineContext, p: MergePipeline): Promise<void> {
  // First gate (INV-G6): a merge already in flight means this poll starts nothing. Because this
  // runs before the drain's first await, a concurrent drain that begins while one is in flight
  // sees the slot taken and returns here; the re-checks right before each startMerge below cover
  // the overlap that passes this gate in the drain's async gaps.
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
    // The dedupe awaited git: a concurrent drain that passed the reservation before that await
    // may have assigned the slot in the meantime. Re-check synchronously, in the same block
    // as the assignment, so the single-flight invariant holds regardless of how the overlap
    // interleaved (INV-G6).
    if (p.merge !== null) return;
    p.merge = startMerge(ctx, p, entry, file);
    return;
  }
  // A kept pin with no queue file — a crash between the run's commit and its queue write, or
  // the pin-only writers of parts 3e/7 and 3i/7 — merges through the same serial task: after
  // the queue path starts nothing, scan the live runners and start the one task for the first
  // role whose pin pinnedRetrySha allows. A role with a queued entry is skipped (the queue
  // path owns it and drains it first); pinnedRetrySha deletes a dangling or stale pin and
  // refuses a pin at MERGE_CONFLICT_LIMIT, which the drain leaves untouched for its author's
  // hand-back, exactly as recovery does. One task per poll, as the queue path does.
  const queuedRoles = queuedMergeRoles(ctx.root);
  for (const runner of ctx.runners) {
    if (p.merge !== null) return; // one task at a time: the next pin waits in its ref
    if (queuedRoles.has(runner.role)) continue;
    // A withdrawn claim's pin is not merged here: its role's next run sets the work aside
    // before leftover recovery (runner-leftover.ts setAsideWithdrawnWork), because such a pin
    // carries no claim the merge's own withdrawn check can read. The scheduling pass that
    // leaves this marker runs after the drain, so the pin check below also reads the runner's
    // live claim on the first poll after a withdrawal.
    if (runner.state.withdrawn !== undefined) continue;
    // Skip a runner the ref files settle as having no pin, without yielding: an empty-queue
    // poll must not add an async hop just to confirm, on most polls, that nothing is pinned
    // (a concurrent parked task's permit window). A present or unsettled ref falls through to
    // pinnedRetrySha, which resolves it through git.
    if (refAbsentFromFiles(ctx.root, mergeRefName(runner.role))) continue;
    const sha = await pinnedRetrySha(ctx.root, runner.role, ctx.mainBranch, runner.state);
    if (sha === null) continue;
    const entry = await pinnedMergeEntry(ctx.root, runner.role, sha, { currentRun: runner.state.runs });
    if (await pinClaimWithdrawn(ctx, runner, entry.run)) continue;
    if (ctx.startHeld(runner.role)) continue;
    // Same single-flight re-check as the queue path: the pin's pinnedRetrySha / pinnedMergeEntry /
    // pinClaimWithdrawn each awaited git, so a concurrent drain may have assigned the slot since
    // the reservation at the top of the drain.
    if (p.merge !== null) return;
    p.merge = startMerge(ctx, p, entry, null);
    return;
  }
}

/** Whether the pin's own run still owes its live claim and main no longer lists that entry.
 * The scheduling poll that turns such a claim into RunnerState.withdrawn runs after the drain,
 * so without this read the drain would merge the pin on the first poll after a withdrawal,
 * before the marker exists. Only the pin's authoring run may lend its claim: a role can hold
 * an older pin while a later run's claim names another entry. */
async function pinClaimWithdrawn(
  ctx: MergePipelineContext,
  runner: RoleRunner,
  pinRun: number,
): Promise<boolean> {
  const { claim, revision, resumePending, resumePromptFile, runs } = runner.state;
  const owesClaim = revision !== undefined || (resumePending === true && resumePromptFile === undefined);
  if (!owesClaim || claim === undefined || pinRun !== runs) return false;
  // Read the claim against main itself, not the pin: this asks only whether the claim's
  // entry is still listed, while the pin's own moved-out entries stay the merge's check.
  const withdrawn = await withdrawnEntries(ctx.root, ctx.mainBranch, runner.role, ctx.mainBranch, claim);
  return withdrawn.length > 0;
}

/** Signals that a restart or disk hold closed the start gate while the task waited for its
 * gate permit, so the gate must not start. The task keeps its entry queued exactly as a parked
 * verification did; it is control flow, not a failure, so the task's catch does not record it. */
class GateDeferredByHold extends Error {}

/** Distinguishes the tasks' `merged` events: a role's other merges can run concurrently with
 * its queue entry's gate-then-merge (a post-merge-review fix or a refusal note merges through
 * mergeToMain as the same `source` role), so the task must recognise its OWN landing. */
let mergeTaskSeq = 0;

/** How many gate-then-merge tasks this process has started, for the mergeTaskStarts() getter.
 * Bumped once per startMerge call, before its task runs. */
let mergeTaskStartsTotal = 0;

/** How many gate-then-merge tasks this process has started. A single queue head may own at
 * most one at a time (the single-flight invariant, INV-G6), so a drain that starts one for a
 * head already held by a live task is the duplicate the drain race can produce; the merge-drain
 * regression drives two overlapping drains and reads this to pin the shape. */
export function mergeTaskStarts(): number {
  return mergeTaskStartsTotal;
}

/** Clear the gate-then-merge start counter so a test that starts tasks can read its own starts
 * in isolation. Exported for test/merge-drain.test.ts; production code never calls it. */
export function resetMergeTaskStarts(): void {
  mergeTaskStartsTotal = 0;
}

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
function startMerge(ctx: MergePipelineContext, p: MergePipeline, entry: MergeEntry, file: string | null): InFlightMerge {
  const { root, mainBranch, signal, roleConfig, semaphore } = ctx;
  const author = resolveAuthor(ctx, entry.role);
  const { usage, foldUsage } = mergeUsage(author, root);
  const merge: InFlightMerge = {
    promise: Promise.resolve(), // Replaced below; the placeholder satisfies the type.
    controller: new AbortController(),
    roles: [entry.role],
    userAborted: false,
  };
  // Stamped on this task's own `merged` event, so a concurrent merge for the same role cannot
  // look like this change's landing.
  const mergedTag = `merge-${++mergeTaskSeq}`;
  // Bumped once per call so a test can pin that a queue head started at most one task (INV-G6):
  // the drain race starts a duplicate for the same head, and this is what that duplicate does
  // (a second startMerge) even when both tasks' downstream effects look like a normal merge.
  mergeTaskStartsTotal += 1;
  const detachShutdown = abortOnShutdown(signal, merge.controller);
  // The one change the task holds. `file` is the entry's queue file (dropped once the outcome
  // is written) or null for a pin-only merge with no queue entry — a null file writes no
  // queue file and keeps the pin on a retriable outcome; `usage` is the task's own spend —
  // both ride the closures below.
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
    mergedTag,
    reviewHeld: () => ctx.startHeld(),
    gatePermit: async () => {
      // A gating call holds a VERIFY_TIER team lease around its gate — the tier a verification
      // used to hold — and merge-core's mergeApprovedChange releases it before
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
    // A `merged` event names the commit the role produced: the post-merge review of the merged
    // change is queued once it settles as merged. Only this task's own tagged event counts —
    // another merge for the same role (a post-merge-review fix, a refusal note) logs `merged`
    // under the same source and must not stand in for this change's landing.
    let mergedCommit: string | undefined;
    const unsubscribe = subscribeEvents((e) => {
      if (e.type === "merged" && e.mergedTag === mergedTag && e.source === role && typeof e.commit === "string") mergedCommit = e.commit;
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
        // A `merged` event fires inside the lock the moment the fast-forward moves main, and the
        // subscription keeps only THIS task's tagged event (a concurrent post-merge-review fix
        // or refusal note also logs `merged` under the same role). So a set mergedCommit is the
        // ground truth that this change LANDED — it outranks whatever the merge reported. If a
        // consumed abort lands after the ff, the merge can still throw before it finalizes
        // (result stays undefined), and the branch below would otherwise rewrite the
        // already-landed change to "aborted". Landing means main holds the commit, so the only
        // honest outcome is "changed" — the same path the ordinary merged settle takes. The
        // retriable branch keeps the operator's stop for outcomes that never landed; a change
        // with no result and no landing settles aborted for a user stop, or clears its marker
        // otherwise.
        if (mergedCommit !== undefined) await settleOne("changed");
        else if (result !== undefined && !(merge.userAborted && RETRIABLE_MERGE_RESULTS.has(result))) await settleOne(result);
        else if (merge.userAborted) await settleOne("aborted");
        else removeMergeChange(root, role);
      }
    } finally {
      unsubscribe();
      detachShutdown();
      if (merge.userAborted) await discardPinnedRefs(root, merge.roles);
      // Free the slot only if this task still owns it (INV-G6). The drain is single-flight, so
      // in practice this is always true — but an orphaned task (one a duplicate drain started
      // before the single-flight guard) or a test that overwrote p.merge must not clear the
      // slot another live task now holds: it would free the slot early and let the next poll
      // start a second task for the same head while this task is still running.
      if (p.merge === merge) p.merge = null;
    }
  })();
  merge.promise = guardMergeTask(root, merge.roles.join(", "), task);
  return merge;
}
