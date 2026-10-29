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

/** One merge task the pipeline owns (merge queue 3/5, land-queue speed 2c) — a verification or the
 * merge: its task, the controller that aborts it (harness shutdown OR `tumwater abort --role`
 * for any of its roles), and whether the abort was a deliberate user stop — which decides what
 * happens to the pinned refs when it ends. `roles` is every role the task holds: one for a
 * verification, every change the merge carries. */
export interface InFlightMerge {
  promise: Promise<void>;
  controller: AbortController;
  roles: string[];
  userAborted: boolean;
  /** True while a verification waits for its permit: it holds nothing and has started nothing, so
   * it is not in flight (mergeTasks) and not abortable, it has no marker record, and its role reads
   * as plainly queued. */
  parked?: boolean;
}

/** A change the verify stage approved (or found exempt), waiting for the merge slot: still
 * queued — the scoped interlock no longer parks an approved-and-waiting author (interlock
 * relief, parts 1-3/4), and no role start, verify or landing waits on the reviewer — with the
 * head its gate approved in its merge ref (`sha`) and the approval's patch-id in its state (2a).
 * In memory only: after a
 * restart the entry is verified again, and its review carries over through the patch-id while
 * its check runs once more. It holds no task, so `tumwater abort --role` only flags it
 * (AbortableMerge); the next drain settles it as "aborted" and discards its pin. */
export interface ApprovedMerge extends AbortableMerge, FoldsUsage {
  entry: MergeEntry;
  /** The queue file to drop once its outcome is written. */
  file: string;
  /** The head its gate approved — the synced pin its merge ref names. */
  sha: string;
  /** `sha` again when the gate's pre-check ran green on exactly it (VerifyVerdict). */
  verifiedHead?: string;
  /** When its verification started: its merge_done/merge_failed event's durationMs runs from here.
   * */
  startedAt: number;
  /** The authoring runner its verification ran with — reused by its merge, so both fold into one
   * state. */
  author: RoleRunner;
  /** The merge's own spend so far (its reviewer). */
  usage: MergeUsage;
}

/** The per-poll state the pipeline reads from the scheduler, resolved once by the poll loop.
 * The scheduler keeps WHEN to drain (after the gates; the startHeld gate applies to the
 * no-role post-merge review drain only — the reviewer hold parks no named entry, so no role
 * start, verify or landing waits on the reviewer); merge-drain.ts owns HOW — from the queue to each
 * verification and the merge. */
export interface MergePipelineContext {
  root: string;
  mainBranch: string;
  /** The combined caller+internal stop signal: harness shutdown aborts every merge task. */
  signal: AbortSignal;
  /** The shared maxConcurrent semaphore role runs draw from. A merge's pi runs cost the
   * backend what an author run costs, so merges count as active work: every verification holds one
   * permit for its whole length, and the merge's conflict resolver takes one for its run
   * (BUGS.md 2026-09-18 — exempting the merge let total load float to maxConcurrent +
   * merge + director on a single-GPU backend, where the extra stream is what starves
   * sessions into the quiet watchdog's kills). The permits are all that bounds how many
   * verifications run at once. Both merge tiers sit ahead of every role run's, and a verification
   * takes the slot its author would have used: the interlock keeps that author from running until
   * its change merges. */
  semaphore: Semaphore;
  /** Live runners, searched first when resolving a merge's author. */
  runners: RoleRunner[];
  /** The live config: supplies `mergeBatchMax` and the director's budget-exempt config. */
  liveConfig: TumwaterConfig;
  /** The derived config non-director roles run under (the fallback view). */
  roleConfig: TumwaterConfig;
  /** The director's config (the live config unless a used-up window moved it to its fallback). */
  directorConfig: TumwaterConfig;
  /** The scheduler's start gate for new work (a pending restart, a disk hold, or the reviewer
   * hold), re-checked the moment a parked verification is granted its permit — the one moment
   * it actually starts, exactly as a parked role run re-checks it (run-timing.ts's
   * runTimedRoleRun): a verification queued before the hold must not start a reviewer mid-drain
   * or into the storm. A held verification hands its permit back and starts nothing; its entry
   * stays queued for the next drain. The reviewer hold parks only the no-role form — the
   * post-merge review drain, which calls startHeld() with no role — never a named entry: no
   * role start, verify or landing waits on the reviewer. `role` names the entry's authoring
   * role; a caller that cannot name one (the post-review drain) passes no argument. */
  startHeld(role?: string): boolean;
}

/** The scheduler's merge state across polls (land-queue speed 2c), in three parts:
 * - `verifying`: one task per queued change, in queue order, each in a leased pooled slot —
 *   checkout, rebase onto main, gate check and review (verifyRequest) — on a shared
 *   permit (a verification still waiting for its permit is `parked`). Any verdict but an approval
 *   writes its outcome at once and frees its author.
 * - `approved`: the approved changes waiting to merge, still queued.
 * - `merge`: the one task that writes main — every approved change up to mergeBatchMax, in queue
 *   order, through mergeApproved (a stack of two or more shares one check and one fast-forward).
 *   It never waits for an unapproved queue head.
 * A role is in at most one of them: its one queued change is approved, then waits, then merges, so
 * a verification and a merge never touch the same worktree or ref. */
export interface MergePipeline {
  verifying: Map<string, InFlightMerge>;
  approved: Map<string, ApprovedMerge>;
  merge: InFlightMerge | null;
  /** The one post-merge review in flight (src/merge/merge-post-review-drain.ts), for a
   * commit of a role listed in review.afterMerge. It holds a permit but no role, queue entry
   * or the merge slot. */
  postReview: InFlightMerge | null;
}

/** A fresh pipeline: nothing in flight anywhere — no verification running, no approved change
 * waiting, no merge holding main. The orchestrator builds one per team start (orchestrator.ts). */
export function newMergePipeline(): MergePipeline {
  return { verifying: new Map(), approved: new Map(), merge: null, postReview: null };
}

/** Every merge task in flight — each verification holding its permit, and the merge — for the
 * shutdown and restart waits. A parked verification is not one of them: it has started nothing, and
 * a shutdown (its controller) or a closed start gate (at its grant) settles it without a run. */
export function mergeTasks(p: MergePipeline): InFlightMerge[] {
  return [...[...p.verifying.values()].filter((v) => !v.parked), ...(p.merge ? [p.merge] : []), ...(p.postReview && !p.postReview.parked ? [p.postReview] : [])];
}

/** Everything `tumwater abort --role` can reach: every task in flight, plus each approved change
 * waiting with no task of its own. A parked verification is out of reach, as a plainly queued entry
 * always was: its change has not started merging. */
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
 * leak), so a parked verification that a shutdown settles holds nothing. A verification's
 * permit is the one team total (`maxConcurrent`). */
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

/** The roles the pipeline holds right now — verifying (parked or not), approved, or merging. */
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
 * settleAbortedApproved, the verification's final-verdict branch, and the merge's per-change
 * write-back, so no settled entry can keep a stale marker or lose its outcome write. The pinned-ref
 * discard stays with the callers: only a user abort throws work away, and the merge discards its
 * whole stack at once rather than change by change. */
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
  // ref cleanup a merged revision needs here. Guarded on the entry's revisionRound, not just a
  // `changed` result: a fresh change can merge while a different rejection's revision is still
  // pending, and its merge must leave that pending revision's ref alone.
  if (result === "changed" && entry.revisionRound !== undefined) {
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
