import type { RoleRunner } from "../runner/runner.js";
import type { Semaphore } from "../concurrency/semaphore.js";
import type { SemaphoreLease } from "../concurrency/semaphore.js";
import { runOnAbort } from "../process/process.js";
import { warnEventBestEffort, TUMWATER_SOURCE } from "../events/events.js";
import { errorMessage } from "../text/text.js";
import type { TumwaterConfig } from "../config/config-schema.js";
import { deleteRef } from "../git/git.js";
import { removeMergeChange, writeMergeOutcome, type MergeUsage } from "./merge-slot.js";
import { requeueKeptChange } from "./merge-requeue.js";
import { mergeRefName, rejectedRefName } from "../paths.js";
import type { AbortableMerge } from "../operator/operator-requests.js";
import type { MergeEntry } from "./merge-queue.js";
import type { RunResult } from "../run/run-outcome.js";
import type { FoldsUsage } from "../runner/runner-pi.js";
import type { RunnerState } from "../runner/runner-state.js";

/** One merge task the pipeline owns (merge queue 3/5, land-queue speed 2c) — the merge slot's
 * one gate-then-merge task, or a post-merge review: its task, the controller that aborts it
 * (harness shutdown OR `tumwater abort --role` for any of its roles), and whether the abort was
 * a deliberate user stop — which decides what happens to the pinned refs when it ends. `roles`
 * is every role the task holds: the one queued change the merge task gates and merges. */
export interface InFlightMerge {
  promise: Promise<void>;
  controller: AbortController;
  roles: string[];
  userAborted: boolean;
  /** True while a post-merge review waits for its permit: it holds nothing and has started
   * nothing, so it is not in flight (mergeTasks) and not abortable, and no marker record is
   * open for it. */
  parked?: boolean;
}

/** The change-shaped record the drain task holds while it gates and merges one queue head (and
 * the shape the verify stage's approved map was typed to — that map stays here, empty, until
 * part 3d/6 deletes it): the queue entry, the head its gate judges from its merge ref (`sha`),
 * the author's wiring and the merge's own usage fold. Built in memory by startMerge for its one
 * task; the `controller`/`userAborted` fields ride the AbortableMerge footing and are not used
 * separately — the task's own InFlightMerge controller is what an abort fires. */
export interface ApprovedMerge extends AbortableMerge, FoldsUsage {
  entry: MergeEntry;
  /** The queue file to drop once its outcome is written. */
  file: string;
  /** The head its gate approved — the synced pin its merge ref names. */
  sha: string;
  /** `sha` again when the gate's pre-check ran green on exactly it (VerifyVerdict). */
  verifiedHead?: string;
  /** When its gate-then-merge task started: its merge_done/merge_failed event's durationMs runs
   * from here. */
  startedAt: number;
  /** The authoring runner the change's merge runs with — its gate and merge fold into one
   * state. */
  author: RoleRunner;
  /** The merge's own spend so far (its reviewer). */
  usage: MergeUsage;
}

/** The per-poll state the pipeline reads from the scheduler, resolved once by the poll loop.
 * The scheduler keeps WHEN to drain (after the gates; the startHeld gate applies to the
 * no-role post-merge review drain only — the reviewer hold parks no named entry, so no role
 * start, verify or landing waits on the reviewer); merge-drain.ts owns HOW — one gate-then-merge
 * task per queue head. */
export interface MergePipelineContext {
  root: string;
  mainBranch: string;
  /** The combined caller+internal stop signal: harness shutdown aborts every merge task. */
  signal: AbortSignal;
  /** The shared maxConcurrent semaphore role runs draw from. A merge's pi runs cost the
   * backend what an author run costs, so merges count as active work: the merge task's gate holds
   * one permit (VERIFY_TIER) for the gate's whole length, and the merge's conflict resolver takes
   * one for its run (MERGE_TIER)
   * (BUGS.md 2026-09-18 — exempting the merge let total load float to maxConcurrent +
   * merge + director on a single-GPU backend, where the extra stream is what starves
   * sessions into the quiet watchdog's kills). One task runs at a time, so the permits
   * bound its parking as much as its running. Both merge tiers sit ahead of every role run's, and a
   * merge takes the slot its author would have used: the interlock keeps that author from
   * running until its change merges. */
  semaphore: Semaphore;
  /** Live runners, searched first when resolving a merge's author. */
  runners: RoleRunner[];
  /** The live config: supplies the director's budget-exempt config. */
  liveConfig: TumwaterConfig;
  /** The derived config non-director roles run under (the fallback view). */
  roleConfig: TumwaterConfig;
  /** The director's config (the live config unless a used-up window moved it to its fallback). */
  directorConfig: TumwaterConfig;
  /** The scheduler's start gate for new work (a pending restart, a disk hold, or the reviewer
   * hold), read by the merge drain before it starts a queue head's gate-then-merge task and by
   * the post-merge review drain: a task queued before the hold must not start a gate mid-drain
   * or into the storm; its entry stays queued for the next drain. The reviewer hold parks only
   * the no-role form — the post-merge review drain, which calls startHeld() with no role —
   * never a named entry: no role start, verify or landing waits on the reviewer. `role` names
   * the entry's authoring role; a caller that cannot name one (the post-review drain) passes
   * no argument. */
  startHeld(role?: string): boolean;
}

/** The scheduler's merge state across polls (land-queue speed 2c):
 * - `verifying` and `approved`: the verify stage's maps — unpopulated since the drain collapse
 *   (part 3/4 of the split): a queued change is gated and merged by the one `merge` task. They
 *   stay in the type, empty, until part 3d/6 deletes them, so `mergeTasks`, `abortableMerges`
 *   and `liveRoles` keep compiling over them.
 * - `merge`: the one task that writes main — the first eligible queue head, in queue
 *   order, gated and merged one at a time through mergeApprovedChange (a rebase and a
 *   fast-forward, no shared check).
 * - `postReview`: the one post-merge review in flight (src/merge/merge-post-review-drain.ts). It
 *   holds a permit but no role, queue entry or the merge slot.
 * A role is in at most one of them: its one queued change is held by the one merge task until
 * it settles, so no two tasks ever touch the same worktree or ref. */
export interface MergePipeline {
  verifying: Map<string, InFlightMerge>;
  approved: Map<string, ApprovedMerge>;
  merge: InFlightMerge | null;
  /** The one post-merge review in flight (src/merge/merge-post-review-drain.ts). It holds a
   * permit but no role, queue entry or the merge slot. */
  postReview: InFlightMerge | null;
}

/** A fresh pipeline: nothing in flight anywhere — no merge holding main, no post-merge review
 * running. The orchestrator builds one per team start (orchestrator.ts). */
export function newMergePipeline(): MergePipeline {
  return { verifying: new Map(), approved: new Map(), merge: null, postReview: null };
}

/** Every merge task in flight — the merge slot's gate-then-merge task and each post-merge
 * review — for the shutdown and restart waits. A parked post-merge review is not one of them:
 * it has started nothing, and a shutdown (its controller) or a closed start gate (at its grant)
 * settles it without a run. */
export function mergeTasks(p: MergePipeline): InFlightMerge[] {
  return [...[...p.verifying.values()].filter((v) => !v.parked), ...(p.merge ? [p.merge] : []), ...(p.postReview && !p.postReview.parked ? [p.postReview] : [])];
}

/** Everything `tumwater abort --role` can reach: every task in flight (the one merge slot's
 * task and each post-merge review), plus the verify stage's approved-map values — a map the
 * drain no longer populates, kept for part 3d/6. A parked post-merge review is out of reach, as
 * a plainly queued entry always was: its change has not started merging. */
export function abortableMerges(p: MergePipeline): AbortableMerge[] {
  return [...mergeTasks(p), ...p.approved.values()];
}

/** Wire harness shutdown to one task's own controller — through the shared register/abort
 * race helper, so an already-fired signal aborts at once. Returns the detach function. The
 * team shutdown signal outlives every merge, so each task that settles while the signal is
 * still live must detach in its own finally; without that, the one long-lived signal
 * accumulates a listener (and the retained controller behind it) for every merge the team
 * ever runs, growing without bound until the shutdown it was waiting for. */
export function abortOnShutdown(signal: AbortSignal, controller: AbortController): () => void {
  return runOnAbort(signal, () => controller.abort());
}

/** Wrap a merge task's stored promise so it can never reject: the tasks are fire-and-forget
 * during normal operation (only the shutdown/restart drain awaits them), and an unexpected
 * throw out of their bookkeeping — an unwritable state file, event feed, or marker while
 * settling an outcome — would otherwise surface as an unhandled rejection and take the
 * orchestrator down. The throw is reported best-effort; the task's own finally has already
 * released its slot and controller, and the surviving queue entry and pin recover on the next
 * poll. */
export function guardMergeTask(root: string, role: string, promise: Promise<void>): Promise<void> {
  return promise.catch((err: unknown) => {
    warnEventBestEffort(root, TUMWATER_SOURCE, `merge task for ${role} could not settle: ${errorMessage(err)}`);
  });
}

/** Take a permit at `tier` unless `signal` fires first: resolves to its release, or to null
 * when the signal won — a grant that arrives after that is handed straight back (a hop, never a
 * leak), so a parked gate-permit wait that a shutdown settles holds nothing. The permit is the
 * one team total (`maxConcurrent`). */
export async function acquireUnlessAborted(
  semaphore: Semaphore,
  tier: number,
  signal: AbortSignal,
): Promise<SemaphoreLease | null> {
  if (signal.aborted) return null;
  const granted = semaphore.acquireLease(tier);
  const stopped = new Promise<false>((resolve) => signal.addEventListener("abort", () => resolve(false), { once: true }));
  if (await Promise.race([granted, stopped])) {
    return granted;
  }
  void granted.then((lease) => lease.release());
  return null;
}

/** The roles the pipeline holds right now — the merge task's roles (the approved/verifying maps
 * stay in the type, empty, until part 3d/6). */
export function liveRoles(p: MergePipeline): Set<string> {
  return new Set([...p.verifying.keys(), ...p.approved.keys(), ...(p.merge?.roles ?? [])]);
}

/** Discard the pinned merge refs of every role in a deliberately-aborted merge.
 * `tumwater abort --role` throws the committed work away, and the pin is what would otherwise
 * recover it, so the ref must go; a shutdown abort leaves `userAborted` unset and every ref
 * survives for recovery. Shared by every task's settling code so their discard semantics
 * cannot drift. A ref that is already gone is not an error. */
export async function discardPinnedRefs(root: string, roles: string[]): Promise<void> {
  for (const role of roles) {
    try {
      await deleteRef(root, mergeRefName(role));
    } catch {
      /* already gone */
    }
  }
}

/** Settle a merge queue entry that reached a terminal outcome — the one home of the
 * write-plus-drop pairing every settled merge goes through: the result lands in the role's
 * state and the merge_done/merge_failed event (writeMergeOutcome), then the change's marker
 * record is dropped (removeMergeChange — merge-slot leaves the marker to the caller). Shared by
 * settleAbortedApproved, the verify stage's final-verdict branch, and the merge's per-change
 * write-back, so no settled entry can keep a stale marker or lose its outcome write. The pinned-ref
 * discard stays with the callers: only a user abort throws work away, and a user abort of the
 * merge discards the pins of every change it had not merged. */
export async function settleMergeOutcome(
  root: string,
  entry: MergeEntry,
  state: RunnerState,
  result: RunResult,
  durationMs: number,
  usage: MergeUsage,
  file: string,
  mainBranch?: string,
): Promise<void> {
  writeMergeOutcome(root, entry, state, result, durationMs, usage, file);
  // A revision that merges ends the rejected change's life: drop the rejected ref (plans/revise-
  // rejected.md). A rejection repoints or deletes it in merge-core.ts, so this is the only
  // ref cleanup a merged revision needs here; a withdrawn revision ends it the same way.
  // Guarded on the entry's revisionRound, not just a `changed` result: a fresh change can merge
  // while a different rejection's revision is still pending, and its merge must leave that
  // pending revision's ref alone.
  if ((result === "changed" || result === "withdrawn") && entry.revisionRound !== undefined) {
    await deleteRef(root, rejectedRefName(entry.role));
  }
  removeMergeChange(root, entry.role);
  // A kept change goes straight back on the queue (the callers pass the main branch; a
  // direct caller without one leaves the retry to the author's leftover recovery). The write-back
  // above already happened, so a failure here must not lose the settled outcome.
  if (mainBranch !== undefined) {
    try {
      await requeueKeptChange(root, mainBranch, entry, state, result);
    } catch (err) {
      warnEventBestEffort(root, entry.role, `could not re-queue the kept change: ${errorMessage(err)}`);
    }
  }
}
