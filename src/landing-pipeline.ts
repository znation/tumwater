import type { LoopRunner } from "./loop.js";
import type { Semaphore } from "./semaphore.js";
import type { TumwaterConfig } from "./config-schema.js";
import { deleteRef } from "./git.js";
import { removeLandingChange, writeLandingOutcome } from "./landing-slot.js";
import { landingRefName } from "./paths.js";
import type { AbortableLanding } from "./operator-requests.js";
import type { LandingEntry } from "./landing-queue.js";
import type { TickResult } from "./tick-outcome.js";
import type { FoldsUsage } from "./loop-pi.js";
import type { LoopState } from "./loop-state.js";

/** One landing task the pipeline owns (merge queue 3/5, land-queue speed 2c) — a vet or the
 * merge: its task, the controller that aborts it (harness shutdown OR `tumwater abort --role`
 * for any of its roles), and whether the abort was a deliberate user stop — which decides what
 * happens to the pinned refs when it ends. `roles` is every role the task holds: one for a vet,
 * every change the merge is landing for the merge. */
export interface InFlightLanding {
  promise: Promise<void>;
  controller: AbortController;
  roles: string[];
  userAborted: boolean;
  /** True while a vet waits for its permit: it holds nothing and has started nothing, so it is
   * not in flight (landingTasks) and not abortable, it has no marker record, and its role reads
   * as plainly queued. */
  parked?: boolean;
}

/** A change the vetting stage approved (or found exempt), waiting for the merge slot: still
 * queued — its author stays interlocked until it lands — with the head its gate approved in
 * its landing ref (`sha`) and the approval's patch-id in its state (2a). In memory only: after a
 * restart the entry is vetted again, and its review carries over through the patch-id while
 * its check runs once more. It holds no task, so `tumwater abort --role` only flags it
 * (AbortableLanding); the next drain settles it as "aborted" and discards its pin. */
export interface VettedLanding extends AbortableLanding, FoldsUsage {
  entry: LandingEntry;
  /** The queue file to drop once its outcome is written. */
  file: string;
  /** The head its gate approved — the synced pin its landing ref names. */
  sha: string;
  /** `sha` again when the gate's pre-check ran green on exactly it (VetVerdict). */
  verifiedHead?: string;
  /** When its vet started: its landed/land_failed event's durationMs runs from here. */
  startedAt: number;
  /** The authoring runner its vet ran with — reused by its merge, so both fold into one state. */
  author: LoopRunner;
  /** The landing's own spend so far (its reviewer). */
  usage: { tokens: number; cost: number };
}

/** The per-poll state the pipeline reads from the scheduler, resolved once by the poll loop.
 * The scheduler keeps WHEN to drain (after the gates, never while a restart or a fleet hold is
 * pending); landing-drain.ts owns HOW — from the queue to each vet and the merge. */
export interface LandingPipelineContext {
  root: string;
  mainBranch: string;
  /** The combined caller+internal stop signal: harness shutdown aborts every landing task. */
  signal: AbortSignal;
  /** The shared maxConcurrent semaphore role ticks draw from. A landing's pi runs cost the
   * backend what an author run costs, so landings count as active work: every vet holds one
   * permit for its whole length, and the merge's conflict resolver takes one for its run
   * (BUGS.md 2026-09-18 — exempting the landing let total load float to maxConcurrent +
   * landing + director on a single-GPU backend, where the extra stream is what starves
   * sessions into the quiet watchdog's kills). The permits are all that bounds how many vets
   * run at once. Both landing tiers sit ahead of every role tick's, and a vet takes the slot
   * its author would have used: the interlock keeps that author from ticking until its change
   * lands. */
  semaphore: Semaphore;
  /** Live runners, searched first when resolving a landing's author. */
  runners: LoopRunner[];
  /** The live config: supplies `landBatchMax` and the director's budget-exempt config. */
  liveConfig: TumwaterConfig;
  /** The derived config non-director roles run under (the fallback view). */
  roleConfig: TumwaterConfig;
  /** The scheduler's start gate for new work (a pending restart, a fleet hold), re-checked the
   * moment a parked vet is granted its permit — the one moment it actually starts, exactly as a
   * parked role tick re-checks it (tick-timing.ts's runTimedRoleTick): a vet queued before the
   * hold must not start a reviewer mid-drain or into the storm. A held vet hands its permit
   * back and starts nothing; its entry stays queued for the next drain. */
  startHeld(): boolean;
}

/** The scheduler's landing state across polls (land-queue speed 2c), in three parts:
 * - `vetting`: one task per queued change, in queue order, each in its own `_land-<role>`
 *   worktree — checkout, rebase onto main, gate check and review (vetRequest) — on a shared
 *   permit (a vet still waiting for its permit is `parked`). Any verdict but an approval writes
 *   its outcome at once and frees its author.
 * - `vetted`: the approved changes waiting to merge, still queued.
 * - `merge`: the one task that writes main — every vetted change up to landBatchMax, in queue
 *   order, through landVetted (a stack of two or more shares one check and one fast-forward).
 *   It never waits for an unvetted queue head.
 * A role is in at most one of them: its one queued change is vetted, then waits, then merges, so
 * a vet and a merge never touch the same worktree or ref. */
export interface LandingPipeline {
  vetting: Map<string, InFlightLanding>;
  vetted: Map<string, VettedLanding>;
  merge: InFlightLanding | null;
}

/** A fresh pipeline: nothing in flight anywhere — no vet running, no approved change waiting,
 * no merge holding main. The orchestrator builds one per fleet start (orchestrator.ts). */
export function newLandingPipeline(): LandingPipeline {
  return { vetting: new Map(), vetted: new Map(), merge: null };
}

/** Every landing task in flight — each vet holding its permit, and the merge — for the shutdown
 * and restart waits. A parked vet is not one of them: it has started nothing, and a shutdown
 * (its controller) or a closed start gate (at its grant) settles it without a run. */
export function landingTasks(p: LandingPipeline): InFlightLanding[] {
  return [...[...p.vetting.values()].filter((v) => !v.parked), ...(p.merge ? [p.merge] : [])];
}

/** Everything `tumwater abort --role` can reach: every task in flight, plus each vetted change
 * waiting with no task of its own. A parked vet is out of reach, as a plainly queued entry
 * always was: its change has not started landing. */
export function abortableLandings(p: LandingPipeline): AbortableLanding[] {
  return [...landingTasks(p), ...p.vetted.values()];
}

/** Wire harness shutdown to one task's own controller — at once when it has already fired,
 * since a listener added after the event never runs. */
export function abortOnShutdown(signal: AbortSignal, controller: AbortController): void {
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", () => controller.abort(), { once: true });
}

/** Take a permit at `tier` unless `signal` fires first: resolves to its release, or to null
 * when the signal won — a grant that arrives after that is handed straight back (a hop, never
 * a leak), so a parked vet that a shutdown settles holds nothing. */
export async function acquireUnlessAborted(
  semaphore: Semaphore,
  tier: number,
  signal: AbortSignal,
): Promise<(() => void) | null> {
  if (signal.aborted) return null;
  const granted = semaphore.acquire(tier).then(() => true as const);
  const stopped = new Promise<false>((resolve) => signal.addEventListener("abort", () => resolve(false), { once: true }));
  if (await Promise.race([granted, stopped])) return () => semaphore.release();
  void granted.then(() => semaphore.release());
  return null;
}

/** The roles the pipeline holds right now — vetting (parked or not), vetted, or merging. */
export function liveRoles(p: LandingPipeline): Set<string> {
  return new Set([...p.vetting.keys(), ...p.vetted.keys(), ...(p.merge?.roles ?? [])]);
}

/** Discard the pinned landing refs of every role in a deliberately-aborted landing.
 * `tumwater abort --role` throws the committed work away, and the pin is what would otherwise
 * recover it, so the ref must go; a shutdown abort leaves `userAborted` unset and every ref
 * survives for recovery. Shared by every task's settling code so their discard semantics
 * cannot drift. A ref that is already gone is not an error. */
export async function discardPinnedRefs(root: string, roles: string[]): Promise<void> {
  for (const role of roles) {
    try {
      await deleteRef(root, landingRefName(role));
    } catch {
      /* already gone */
    }
  }
}

/** Settle a landing queue entry that reached a terminal outcome — the one home of the
 * write-plus-drop pairing every settled landing goes through: the result lands in the role's
 * state and the landed/land_failed event (writeLandingOutcome), then the change's marker record
 * is dropped (removeLandingChange — landing-slot leaves the marker to the caller). Shared by
 * settleAbortedVetted, the vet's final-verdict branch, and the merge's per-change write-back, so
 * no settled entry can keep a stale marker or lose its outcome write. The pinned-ref discard
 * stays with the callers: only a user abort throws work away, and the merge discards its whole
 * stack at once rather than change by change. */
export function settleLandingOutcome(
  root: string,
  entry: LandingEntry,
  state: LoopState,
  result: TickResult,
  durationMs: number,
  usage: { tokens: number; cost: number },
  file: string,
): void {
  writeLandingOutcome(root, entry, state, result, durationMs, usage, file);
  removeLandingChange(root, entry.role);
}
