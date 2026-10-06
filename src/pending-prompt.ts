import type { LoopState } from "./loop/loop-state.js";
import { enqueueRolePrompt, takeQueuedFile } from "./inbox/inbox.js";
import { stripVanishedImageReferences } from "./inbox/inbox-attachments.js";
import { DIRECTOR_ROLE } from "./roles/roles.js";

/**
 * The raw user prompt a director tick is executing, and the requeue policy for every outcome
 * that leaves the request unfulfilled — extracted from LoopRunner's private methods
 * (src/loop/loop.ts) so the subtle fresh-vs-resume requeue semantics have one named home beside
 * the queue mechanics they ride on (src/inbox/inbox.ts).
 */
export class PendingPrompt {
  /** The dequeued request, memory-only: the queue file is the durable store, and every
   * unfulfilled outcome hands the request back to it before the tick ends. */
  private value: string | null = null;

  constructor(
    private readonly root: string,
    private readonly role: string,
  ) {}

  /** Record the user request a just-dequeued tick prompt carries (assembleTickPrompt's
   * userPrompt), so an unfulfilled tick (abort, timeout, or failure without changes) can
   * re-queue it instead of losing the request. */
  record(userPrompt: string | null): void {
    if (userPrompt !== null) this.value = userPrompt;
  }

  /** The raw user prompt this tick is executing (null for role loops), so an unfulfilled
   * outcome below can re-queue it. */
  get(): string | null {
    return this.value;
  }

  /** Drop the recorded request without re-queueing it — the explicit-stop arm of
   * finishAbortedTick and every fulfilled path. */
  clear(): void {
    this.value = null;
  }

  /** Put an unfulfilled user prompt back in the queue it came from so the next tick retries it
   * — the one place that policy lives, shared by every outcome that leaves the request undone
   * (abort, timeout, failure without changes, review abort, context-ceiling cut-off, red-main
   * gate). The queue is the role's own (the director's historical inbox for the director), so a
   * re-queued per-role request never leaks across loops. A fulfilled no_change never reaches
   * here: re-queueing it would loop the prompt forever. Image attachments ride along only
   * while they still exist: takeQueuedFile removed them from disk when the prompt was
   * dequeued, so reference lines whose files are gone are dropped and replaced by one note
   * naming the loss — a re-queued prompt must never send the next tick's agent after files
   * that are no longer on disk, and the loss is recorded in the queue itself where the
   * preview and the agent both see it. */
  requeueUnfulfilled(userPrompt: string | null): void {
    if (userPrompt) enqueueRolePrompt(this.root, this.role, stripVanishedImageReferences(userPrompt).text);
  }

  /** Re-queue whatever request is still recorded and drop it from memory: an exception between
   * the dequeue/reclaim and the pi run leaves the request only in this field — memory the
   * failed tick is about to drop, with no outcome handler left to re-queue it (the handlers
   * run inside runTick, after the pi run). The queue is the durable store, so the catch
   * re-queues whatever is still pending, like every unfulfilled outcome does; it is always
   * null once a pi run has been accounted for. */
  requeuePendingUnfulfilled(): void {
    this.requeueUnfulfilled(this.value);
    this.value = null;
  }

  /** Re-queue an unfulfilled prompt whose pi session the next tick will resume: the resumed
   * session still owns the request in its (compacted) context, so the re-queued copy is only
   * the durable store for a restart — the resume must reclaim exactly it as its own user
   * prompt (the resume's fulfillment consumes it; only its failure paths re-queue it) instead
   * of leaving it queued for a later fresh tick to run the same request twice. The queue file
   * is recorded so the reclaim takes that exact prompt whatever else was enqueued meanwhile.
   * Director ticks never resume — their re-queued prompt always reruns fresh — so they take
   * the plain path. */
  requeueForResume(state: LoopState, userPrompt: string | null): void {
    if (!userPrompt) return;
    if (this.role === DIRECTOR_ROLE) {
      this.requeueUnfulfilled(userPrompt);
      return;
    }
    state.resumePromptFile = enqueueRolePrompt(this.root, this.role, userPrompt);
  }

  /** Reclaim the prompt the interrupted tick re-queued (requeueForResume): the resumed session
   * still owns that request in its context, so this tick's outcome bookkeeping — re-queue on
   * unfulfilled, clear on fulfillment — must operate on the queue's copy, or a fulfilling
   * resume leaves it queued for a later fresh tick to run the same request twice. The exact
   * recorded file is taken, so an enqueue or cancel meanwhile cannot divert the reclaim; a
   * vanished file (cancelled) reclaims nothing. The flag is consumed even when this tick does
   * not resume: a fresh fallback re-derives its prompt from the queue like any other tick, and
   * a stale record must never survive into a later resume. */
  reclaimForResume(state: LoopState, resuming: boolean): void {
    const reclaimFile = state.resumePromptFile;
    state.resumePromptFile = undefined;
    if (resuming && reclaimFile) {
      const reclaimed = takeQueuedFile(reclaimFile);
      if (reclaimed !== null) this.value = reclaimed;
    }
  }
}
