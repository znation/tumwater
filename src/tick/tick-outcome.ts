/** What a finished tick or landing is (the TickResult/TickOutcome vocabulary), shared by the
 * runner that produces it, the dashboards that render it, and the state machine that applies
 * it. The application policy — which outcomes count which streaks, when a session resumes,
 * how the next run is scheduled — lives next door in tick-apply.ts; the clock arithmetic it
 * drives in backoff.ts. This module holds only the shared types. Split out of loop-state.ts —
 * the persisted state file's load/save — and later of the types.ts grab-bag, as LoopState and
 * HarnessEvent were before it. */

export type TickResult =
  | "changed" // a landing completed: the change is merged to main
  | "queued" // the tick's change is committed and pinned; the orchestrator's landing slot will pick it up from the durable land queue (plans/merge-queue.md 3/5) — the commit count and final outcome are recorded when the landing completes; never stored as `lastResult`, which keeps the last completed outcome
  | "refused" // pi declined the work (TUMWATER_REFUSED); only its markdown objection note landed
  | "no_change" // pi decided there was nothing to do
  | "merge_conflict" // change was made but could not be merged; the pin is re-queued next tick, and discarded after MERGE_CONFLICT_LIMIT in a row
  | "merge_blocked" // fast-forward into main failed (e.g. dirty primary checkout)
  | "rejected" // the review gate rejected the change; branch reset, reasons recorded
  | "review_error" // the review gate failed (no parseable verdict); commit left for retry
  | "error" // pi errored or timed out
  | "aborted" // harness shutdown killed the run mid-tick; partial work discarded
  | "quiet_killed" // the quiet watchdog killed a stalled tool call mid-run; session + worktree edits preserved and resumed promptly
  | "user_aborted" // a user-initiated abort (tumwater abort) killed the run mid-tick; work discarded, loop backed off
  | "main_red" // main's build/test suite is red: a tick's baseline check skipped the authoring run, or a landing's check failed on a red main (pin kept, no strike)
  | "skipped"; // nothing to run (e.g. director with an empty inbox);

/** The outcome of one full tick: its result plus what the harness learned from it.
 * Consumed by the orchestrator's dashboards and by tick-apply.ts's post-tick
 * scheduling (applyTickOutcome). */
export interface TickOutcome {
  result: TickResult;
  summary?: string;
  commit?: string;
  /** The tick's authoring run burned more than the configured thrashTurns turns AND thrashMinutes
   * (plans/refusal-and-thrash.md): difficulty is a signal, so the change went to
   * review flagged and a warning event was logged. */
  highFriction?: boolean;
  /** The run was truncated at the model's context ceiling before it could finish (a
   * no_change tick whose final message carried no text or tool call). The work so far
   * survives in the pi session, which pi compacted at end of run — so the loop resumes
   * it promptly instead of backing off as if the role were idle. */
  cutOff?: boolean;
  /** The tick's leftover recovery re-queued a pin whose last landing failed and kept it for
   * another attempt (review_error, merge_conflict, merge_blocked): the tick itself ends
   * `queued`, but the persistent landing failure must still feed the error streak so a dead
   * reviewer backend raises the alarm instead of resetting it every tick (BUGS.md 2026-09-21).
   * Carries the failure detail for the warning: `lastError` is deliberately cleared off the tick
   * so the failure never rides its `tick_end` (the sibling mislabel fix). */
  recoveryFailure?: string;
  /** The outcome's own cause, written deliberately for this result — never a leftover landing
   * failure (those ride `state.lastError` and the recoveryFailure field above). Set by the
   * red-main baseline gate (src/baseline/main-red.ts) so the tick's `tick_end` names what broke: the
   * failure digest's error clusters include main_red ticks, and without a cause on the event
   * the Outcome table's main_red cells would read as a bare count (BUGS.md 2026-09-28). */
  error?: string;
  /** Why a resumed session's bridge prompt names its cause, when the resume's result itself is
   * not specific enough to derive it: a quiet_killed tick can be a hung tool call (the default
   * "hung-tool" bridge) or a tick timeout that fired on a run still making progress (a
   * "timeout" bridge, which asks for the smallest finish against the same limit); an aborted
   * tick handed back at budget_resumed (PLANS.md 2026-09-30) carries "budget-resumed", whose
   * bridge says the run moved back to the primary model. Set only by those outcomes; every
   * other resume cause is derived from state (cut-off streak, restart). */
  resumeCause?: "hung-tool" | "timeout" | "budget-resumed";
  /** The tick ended on leftover recovery (src/loop/leftover.ts) — the leftover went on the land queue
   * (or already was there, or could not be pinned) — without an authoring run. No model ran, so
   * the orchestrator's fallback breaker takes the tick as no evidence about the backend. */
  recoveredLeftover?: boolean;
}

/** Record the review gate's verdict on a HEAD into `lastReview` — the field the author's next
 * tick prompt injects (tick-prompt.ts's buildRejectedReviewNote) and the same-head strike
 * counter reads (review.ts's unreviewFailures). Mutates `s` in place; the timestamp is
 * stamped here so every call site shares one Date.now() read and the shape stays in one place
 * (loop-state.ts's lastReview). */
