import type { RunnerState } from "../runner/runner-state.js";
import { enqueueRolePrompt, removeSameStemSiblings, takeQueuedFile } from "./inbox.js";
import { movePromptImages, stripVanishedImageReferences } from "./inbox-attachments.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";
import { warnEventBestEffort } from "../events/events.js";

/**
 * The raw user prompt a director run is executing, and the requeue policy for every outcome
 * that leaves the request unfulfilled — extracted from RoleRunner's private methods
 * (src/runner/runner.ts) so the subtle fresh-vs-resume requeue semantics have one named home beside
 * the queue mechanics they ride on (src/inbox/inbox.ts).
 */
export class PendingPrompt {
  /** The dequeued request, memory-only: the queue file is the durable store, and every
   * unfulfilled outcome hands the request back to it before the run ends. */
  private value: string | null = null;

  /** The queue file the recorded request was dequeued from, so a fulfilled run sweeps the
   * request's same-stem image attachments by that file's stem (settleImages). Null when the
   * request was recorded without one (tests) or carried no file. */
  private queueFile: string | null = null;

  /** Whether the current request's images were handed back to a queue (requeue*), so a
   * settle must keep them for the next run instead of removing them. */
  private retain = false;

  constructor(
    private readonly root: string,
    private readonly role: string,
  ) {}

  /** Record the user request a just-dequeued run prompt carries (assembleRunPrompt's
   * userPrompt) together with the queue file it came from (userPromptFile), so an unfulfilled
   * run can re-queue it instead of losing the request and a fulfilled one can clean its
   * attachments. */
  record(userPrompt: string | null, queueFile: string | null = null): void {
    if (userPrompt === null) return;
    this.value = userPrompt;
    this.queueFile = queueFile;
    this.retain = false;
  }

  /** The raw user prompt this run is executing (null for roles), so an unfulfilled
   * outcome below can re-queue it. */
  get(): string | null {
    return this.value;
  }

  /** Drop the recorded request without re-queueing it — the explicit-stop arm of
   * finishAbortedRun and every fulfilled path. Leaves the image files for settleImages:
   * the same clear runs before the requeue branches, whose requeue* methods mark the images
   * retained, so only a genuinely unrequeued request loses them. */
  clear(): void {
    this.value = null;
  }

  /** The end-of-run half of the attachment lifetime: sweep the fulfilled request's same-stem
   * image files (removeSameStemSiblings, keyed on the dequeued file's stem — never on paths
   * named by prompt text) UNLESS an unfulfilled outcome handed the request back to a queue
   * (retain), then the files must survive for the requeued prompt to read. Always forgets the
   * request afterwards, so a fresh run starts clean. */
  settleImages(): void {
    if (!this.retain && this.queueFile !== null) removeSameStemSiblings(this.root, this.role, this.queueFile);
    this.queueFile = null;
    this.retain = false;
    this.value = null;
  }

  /** Put an unfulfilled user prompt back in the queue it came from so the next run retries it
   * — the one place that policy lives, shared by every outcome that leaves the request undone
   * (abort, timeout, failure without changes, review abort, context-ceiling cut-off, red-main
   * gate). The queue is the role's own (the director's historical inbox for the director), so a
   * re-queued per-role request never leaks across roles. A fulfilled no_change never reaches
   * here: re-queueing it would loop the prompt forever. Image attachments ride along: the
   * re-queue moves them to the new queue file's stem so a later cancel or fulfilling sweep
   * finds them, and a reference whose file is genuinely gone (removed out of band) is dropped
   * and replaced by one note naming the loss — a re-queued prompt must never send the next
   * run's agent after files that are no longer there. Either way the images are marked
   * retained, so settleImages keeps them for the next run. */
  requeueUnfulfilled(userPrompt: string | null): void {
    if (!userPrompt) return;
    this.enqueueCarryingImages(userPrompt);
    this.retain = true;
  }

  /** Re-queue whatever request is still recorded and drop it from memory: an exception between
   * the dequeue/reclaim and the pi run leaves the request only in this field — memory the
   * failed run is about to drop, with no outcome handler left to re-queue it (the handlers
   * run inside runOnce, after the pi run). The queue is the durable store, so the catch
   * re-queues whatever is still pending, like every unfulfilled outcome does; it is always
   * null once a pi run has been accounted for. */
  requeuePendingUnfulfilled(): void {
    this.requeueUnfulfilled(this.value);
    this.value = null;
  }

  /** Re-queue an unfulfilled prompt whose pi session the next run will resume: the resumed
   * session still owns the request in its (compacted) context, so the re-queued copy is only
   * the durable store for a restart — the resume must reclaim exactly it as its own user
   * prompt (the resume's fulfillment consumes it; only its failure paths re-queue it) instead
   * of leaving it queued for a later fresh run to run the same request twice. The queue file
   * is recorded so the reclaim takes that exact prompt whatever else was enqueued meanwhile.
   * Director runs never resume — their re-queued prompt always reruns fresh — so they take
   * the plain path. */
  requeueForResume(state: RunnerState, userPrompt: string | null): void {
    if (!userPrompt) return;
    if (this.role === DIRECTOR_ROLE) {
      this.requeueUnfulfilled(userPrompt);
      return;
    }
    state.resumePromptFile = this.enqueueCarryingImages(userPrompt);
    this.retain = true;
  }

  /** Reclaim the prompt the interrupted run re-queued (requeueForResume): the resumed session
   * still owns that request in its context, so this run's outcome bookkeeping — re-queue on
   * unfulfilled, clear on fulfillment — must operate on the queue's copy, or a fulfilling
   * resume leaves it queued for a later fresh run to run the same request twice. The exact
   * recorded file is taken, so an enqueue or cancel meanwhile cannot divert the reclaim; a
   * vanished file (cancelled) reclaims nothing. The flag is consumed even when this run does
   * not resume: a fresh fallback re-derives its prompt from the queue like any other run, and
   * a stale record must never survive into a later resume. */
  reclaimForResume(state: RunnerState, resuming: boolean): void {
    const reclaimFile = state.resumePromptFile;
    state.resumePromptFile = undefined;
    if (resuming && reclaimFile) {
      const reclaimed = takeQueuedFile(reclaimFile);
      if (reclaimed !== null) {
        this.value = reclaimed;
        this.queueFile = reclaimFile;
        this.retain = false;
      }
    }
  }

  /** Enqueue one re-queued copy of `userPrompt`, carrying its attachments from the dequeued
   * file's stem to the new queue file's stem (movePromptImages) so the cancel and fulfillment
   * sweeps find them under the stem the queue file actually names. The move runs inside
   * enqueueRolePrompt's decorate hook, so the atomic write lands the prompt with the rewritten
   * references and no reader ever sees the old paths. Each attachment moves on its own, so one
   * file that is gone or cannot be renamed is left where it is and named in a warning while the
   * rest still move; the re-queued prompt keeps the references that moved and drops the
   * vanished ones with a loss note. */
  private enqueueCarryingImages(userPrompt: string): string {
    const fromFile = this.queueFile;
    return enqueueRolePrompt(this.root, this.role, userPrompt, undefined, (newFile) => {
      if (fromFile === null) return stripVanishedImageReferences(userPrompt).text;
      const moved = movePromptImages(fromFile, newFile, userPrompt);
      if (moved.problem !== null) {
        warnEventBestEffort(
          this.root,
          this.role,
          `could not move every attachment of the prompt returned to the inbox: ${moved.problem}`,
        );
      }
      return stripVanishedImageReferences(moved.text).text;
    });
  }
}
