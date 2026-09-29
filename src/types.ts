/** The harness's runtime types: what one tick produces (TickResult, TickOutcome), the
 * durable land queue's entry (LandingEntry), and one pi run's distilled result
 * (PiRunResult). The per-loop persisted state's type (LoopState) lives beside its
 * loader/saver in loop-state.ts. The event log's line shape (HarnessEvent) lives beside
 * its writer in events.ts. The tumwater.json config schema types live in config-schema.ts
 * — the config on disk and the runtime state below are two layers, changed for different
 * reasons. */

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

/** Distilled result of one pi run. */
export interface PiRunResult {
  ok: boolean;
  /** Text of the last assistant message. */
  finalText: string;
  /** True when any assistant message in the run declared nothing-to-do (the sentinel).
   * Covers the whole reply, not just the last message, so a sentinel emitted in an
   * intermediate turn is not lost to a later closing remark. */
  nothingToDo: boolean;
  /** True when any assistant message carried the TUMWATER_REFUSED sentinel — the run declined
   * its task (see plans/refusal-and-thrash.md). Same whole-reply scan as nothingToDo. */
  refused: boolean;
  /** The one-line reason captured from the first TUMWATER_REFUSED line; empty/undefined when
   * the sentinel appeared without a reason. */
  refusedReason?: string;
  /** Text of the LAST assistant message carrying a parseable VERDICT line — the review
   * gate's reply contract (see buildReviewPrompt). Scanned across every message like the
   * sentinel, so a verdict in an intermediate turn survives later closing remarks. */
  verdictText?: string;
  /** Tokens the model generated in this run (usage.output summed across turns). */
  outputTokens: number;
  /** Largest single-request context of the run. */
  peakContextTokens: number;
  /** Assistant turns completed in this run (message_end events) — feeds the commit trailer
   * and the high-friction flag; a tick sums it across its pre-commit runs. */
  turns: number;
  costUsd: number;
  stopReason?: string;
  errorMessage?: string;
  timedOut: boolean;
  /** The run was killed because the harness is shutting down. */
  aborted: boolean;
  /** The run was killed by the quiet watchdog: no pi progress for over quietTimeoutSeconds —
   * typically one hung tool call (a command waiting on input or scanning far more than
   * intended), not a slow run. Distinct from timedOut (the whole-run tick budget): the session
   * and any worktree edits are intact, so the loop resumes them promptly instead of discarding.
   */
  quietKilled: boolean;
  /** The provider rejected the context as too large. With fresh-per-tick sessions this is
   * purely diagnostic: the next tick starts a new session regardless. */
  contextExceeded: boolean;
  /** True when any event reported the model server killing an idle predict stream (LM
   * Studio's "Engine protocol predict stream timed out", e.g. after OS sleep). A transient
   * failure of the world, not of the session: one fresh retry usually succeeds. */
  transientServerTimeout: boolean;
  /** True when pi itself crashed on malformed JSON — its stderr ends in a JSON.parse failure
   * ("Unterminated string in JSON at position N", "Expected ',' or '}' …") — which in observed
   * runs came from a torn model-server chunk, never from the session. Like the predict-stream
   * timeout it is a transient failure of the world: the session is intact on disk and one
   * `--continue` retry picks the run up where it stopped instead of losing hours of work. */
  transientPiCrash: boolean;
  /** True when any event reported the provider rejecting the request with HTTP 429 (rate
   * limiting). A transient failure of the world, not of the session — the world saying
   * "later": one retry after retryAfterSeconds usually succeeds, so the loop's transient
   * retry covers it instead of discarding the tick's work. */
  transientRateLimit: boolean;
  /** The provider's Retry-After delay (seconds) from the rate-limit error text, when one was
   * sent; undefined otherwise. Caps the loop's wait before the transient retry. */
  retryAfterSeconds?: number;
  /** The run's last assistant message carried no text and no tool call (thinking-only or
   * empty). A compliant finish always ends with a text block, so this signals a generation
   * cut off mid-stream — typically pi clamping max output tokens to the sliver left under
   * the declared context window, with the provider misreporting the truncation as a normal
   * stop. Used to diagnose otherwise-mysterious no-sentinel no_change ticks. */
  finalMessageContentless: boolean;
  /** pi auto-compacted the session during (or at the end of) the run. */
  compacted: boolean;
}

/** The loop's shared pi wiring as landing code reaches it, split into the two halves the
 * landing contexts need. `RunsPi` is one pi run in `wt` through the loop's shared wiring
 * (role config, session dir, raw log, transient-failure retry — src/loop-pi.ts); `FoldsUsage`
 * adds one run's spend to the owning loop's counters exactly once (the reviewer and
 * conflict-resolution runs charge to the authoring role). Declared once here so the contract
 * — and its wording — cannot drift apart across the four contexts that restate it:
 * LanderContext and BatchRoleWiring carry both halves (PiRunWiring), MergeContext only the
 * runner (its runPi folds usage internally), and VettedLanding only the fold. */
export interface RunsPi {
  runPi(wt: string, prompt: string, sessionName: string): Promise<PiRunResult>;
}

export interface FoldsUsage {
  foldUsage(run: PiRunResult): void;
}

export interface PiRunWiring extends RunsPi, FoldsUsage {}
