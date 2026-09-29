/** The harness's runtime types for one tick's lifecycle: what one tick produces
 * (TickResult, TickOutcome) and the durable land queue's entry (LandingEntry). The
 * per-loop persisted state's type (LoopState) lives beside its loader/saver in
 * loop-state.ts. The event log's line shape (HarnessEvent) lives beside its writer in
 * events.ts. One pi run's distilled result (PiRunResult) lives beside runPi in pi.ts,
 * with the landing wiring contracts (RunsPi, FoldsUsage, PiRunWiring) in loop-pi.ts.
 * The tumwater.json config schema types live in config-schema.ts — the config on disk
 * and the runtime state below are two layers, changed for different reasons. */

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
 * Consumed by the orchestrator's dashboards and by tick-outcome.ts's post-tick scheduling
 * (applyTickOutcome). */
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
   * red-main baseline gate (src/main-red.ts) so the tick's `tick_end` names what broke: the
   * failure digest's error clusters include main_red ticks, and without a cause on the event
   * the Outcome table's main_red cells would read as a bare count (BUGS.md 2026-09-28). */
  error?: string;
  /** The tick ended on leftover recovery (src/leftover.ts) — the leftover went on the land queue
   * (or already was there, or could not be pinned) — without an authoring run. No model ran, so
   * the orchestrator's fallback breaker takes the tick as no evidence about the backend. */
  recoveredLeftover?: boolean;
}



/** One entry in the durable land queue (.tumwater/land-queue/; src/landing-queue.ts): a commit
 * the tick pinned by `refs/tumwater/landing/<role>` and enqueued at tick end. One file per
 * entry, filename-ordered (`<ts>-<seq>-<pid>.json`); the entry is dropped after EVERY landing
 * outcome, so the queue holds only unattempted landings. No attempt counter lives in the file —
 * retry bookkeeping is the persisted `LoopState.unreviewFailures`, which governs the strike cap.
 */
export interface LandingEntry {
  /** The owning loop — events, session naming, and the lander worktree all key off it. */
  role: string;
  /** The pinned commit to land — checked out detached in this role's lander worktree. */
  sha: string;
  /** The authoring tick number, for the unique per-run session names (review + conflict resolution). */
  tick: number;
  /** The change's one-line summary (the commit subject minus its prefix). */
  summary: string;
  /** The author's claimed WHY/RISK/VERIFIED — the reviewer checks it against the diff. */
  body?: string;
  /** The authoring run burned past the friction thresholds: the reviewer applies extra scrutiny. */
  highFriction?: boolean;
  /** Enqueue time (epoch ms) — the filename orders the queue by it across processes. */
  enqueuedAt: number;
}
