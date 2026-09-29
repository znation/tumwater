/** The harness's runtime types: what one tick produces (TickResult, TickOutcome), the
 * per-loop state persisted under .tumwater/state (LoopState), the durable land queue's
 * entry (LandingEntry), and one pi run's distilled result (PiRunResult). The event log's
 * line shape (HarnessEvent) lives beside its writer in events.ts. The tumwater.json config
 * schema types live in
 * config-schema.ts — the config on disk and the runtime state below are two layers,
 * changed for different reasons. */

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

/** Persisted per-loop state in .tumwater/state/<role>.json. */
export interface LoopState {
  role: string;
  ticks: number;
  commits: number;
  /** Epoch ms before which the loop must not run again. */
  nextRunAt: number;
  /** Current backoff in seconds (0 = not backing off). */
  backoffSeconds: number;
  /** main HEAD observed at the end of the last tick; a different HEAD wakes the loop. */
  lastMainHead: string;
  /** The last COMPLETED result and its summary — the pair the dashboards' "last result" cell
   * renders. A `queued` tick never writes it (tick-outcome.ts's applyTickOutcome): its change is still
   * in flight, which the state column already shows, so the pair keeps the prior outcome until
   * the landing resolves and applyLandingOutcome records the landing's own. */
  lastResult?: TickResult;
  lastSummary?: string;
  /** The summary a `queued` tick reported for the change it pinned (the text its tick_end
   * carries, high-friction annotation included), keyed by that change's sha. Held back from
   * `lastSummary` while the change waits, then paired with the landing's result by
   * applyLandingOutcome, which clears it — so after a landing the cell reads the landing's
   * outcome next to the summary of the change it landed, never next to the prior tick's.
   * Persisted: the land queue is durable, so the landing can resolve in a later process. */
  queuedSummary?: { sha: string; summary: string };
  lastTickStartedAt?: number;
  lastTickEndedAt?: number;
  /** True while a tick is in flight (best-effort; cleared on orchestrator start). */
  running?: boolean;
  /** Epoch ms since the orchestrator reserved this loop but its tick still waits in the
   * semaphore queue: it holds no maxConcurrent permit and runs no pi yet. Transient — set
   * by the orchestrator, cleared the moment the permit is granted (and defensively on tick
   * outcome / orchestrator start) — and never persisted, so dashboards can render the
   * parked waiter as `awaiting slot` and keep the active-state rows equal to the real
   * permit holders (BUGS.md 2026-09-24). */
  parkedSince?: number;
  /** True when the last tick was interrupted mid-task — aborted by a harness shutdown, or
   * truncated at the model's context ceiling — with its pi session (and any uncommitted
   * worktree edits, for shutdowns) left in place: the next tick resumes that session
   * (--continue) instead of starting fresh. Consumed (cleared) by that tick; set again only
   * by another interruption, so a failing resume falls back to a fresh start. */
  resumePending?: boolean;
  /** Why a pending resume happened when it was not a cut-off: "hung-tool" when the quiet
   * watchdog killed a run on a stalled tool call, so the bridge prompt names that cause (and
   * warns against re-running the hung command unchanged). Cleared with resumePending at tick
   * start; absent for restart/cut-off resumes, whose causes are derived. */
  resumeCause?: "hung-tool";
  /** Queue file holding the user prompt a resume-owning tick re-queued: the interrupted pi
   * session still owns that request in its context, so the resume must reclaim exactly this
   * file as its own user prompt — the resume's fulfillment consumes it, and only its failure
   * paths re-queue it — instead of leaving the copy queued for a later fresh tick to run the
   * same request twice. Cleared at every tick's start; reclaimed only by a tick that resumes. */
  resumePromptFile?: string;
  /** Epoch ms of the last operator wake (`tumwater wake`, or the auto-wake a queued
   * per-role prompt sends) that cleared this loop's schedule. Scheduling input, not
   * observation: isEligible exempts the role's min-tick interval when the wake is newer
   * than the last tick's end, so an explicit "try again now" brings a slow-clock loop
   * (qa, steward) in within one poll instead of waiting out the interval it ticked inside
   * — the same exemption the director's inbox already grants user prompts. Self-clearing:
   * the next tick's end re-stamps lastTickEndedAt past the wake, restoring the ordinary
   * gap without a separate erase. */
  wokenAt?: number;
  /** Consecutive ticks that ended truncated at the context ceiling. Bounds cut-off resumes:
   * past the limit the loop abandons the runaway task and falls back to a fresh tick. */
  cutOffStreak?: number;
  /** Consecutive ticks ended by the quiet watchdog (`quiet_killed`). Bounds quiet-kill
   * resumes: while at or under the limit the loop resumes the starved session promptly,
   * past it the loop abandons the session and takes a fresh tick on the idle ladder, so a
   * session the backend will not schedule cannot retry immediately forever (BUGS.md
   * 2026-09-18). Reset by any non-quiet-kill outcome. */
  quietKillStreak?: number;
  /** Consecutive failed ticks: an `error`-result tick OR one whose leftover recovery left a
   * landing pin behind (TickOutcome.recoveryFailure). While at or past the warning threshold
   * (tick-outcome.ts's ERROR_STREAK_WARN) the state cell reads "failing" instead of "sleeping",
   * and the crossing fires one warning event per episode (BUGS.md 2026-09-15: 44
   * identical tick failures looked like a quiet fleet; BUGS.md 2026-09-21: a dead reviewer
   * backend left every recovery landing failing silently and reset this streak each tick).
   * Reset by any result that is neither. */
  consecutiveErrors?: number;
  /** Where in its cycle the loop was when it last persisted state: "review" means the
   * interruption hit during the review gate, so any uncommitted worktree edits are the
   * reviewer's stray output (discarded on resume), not author work. Set + saved around the
   * reviewer run; cleared at tick end alongside `running`. */
  phase?: "pi" | "review";
  /** The most recent review-gate outcome for this loop: what was decided, why, and which
   * branch HEAD it covered. A reject's reasons are injected into the role's next tick prompt
   * — every tick starts a fresh session, so this is the only cross-tick memory of what was
   * built and why it failed. */
  lastReview?: { verdict: string; reasons: string[]; head?: string; at: number };
  /** Branch HEAD that passed review most recently. Leftover commits at exactly this HEAD
   * merge without re-review (a merge_blocked retry must not burn another review run). */
  lastApprovedHead?: string;
  /** git.ts patchId of the change at lastApprovedHead against main — the diff the reviewer
   * judged. A different head carrying the same patch (a clean rebase onto a moved main) reuses
   * the approval: no second model review, though the gate's build pre-check still runs. */
  lastApprovedPatchId?: string;
  /** Consecutive failed reviews of the SAME branch HEAD (reset when the reviewed HEAD
   * changes or a review succeeds). Past the limit the leftover is discarded with a warning,
   * so a misconfigured reviewer cannot wedge a loop re-reviewing one commit forever. */
  unreviewFailures?: number;
  /** Consecutive landings of the SAME pinned sha that ended `merge_conflict` — each one a failed
   * conflict-resolution run. Keyed by sha: a pin that rebased cleanly onto a moved main is a new
   * attempt and starts fresh. At MERGE_CONFLICT_LIMIT leftover recovery discards the pin instead
   * of re-queuing it, so an unmergeable change cannot hold its role off authoring forever. */
  mergeConflicts?: { sha: string; count: number };
  /** The change leftover recovery discarded at MERGE_CONFLICT_LIMIT, named in the role's
   * prompts until its next change is queued — the author's only memory that the work is gone
   * and must be redone against current main if it is still wanted. */
  conflictDiscard?: { sha: string; summary: string; attempts: number; at: number };
  /** Consecutive landings of one patch (git.ts patchId, stable across a clean rebase) whose
   * in-lock check went red on the rebased tree. At lander.ts's LANDING_CHECK_FAILURE_LIMIT the
   * red is attributed through main's own verdict instead of re-queued as merge_blocked again. */
  landingCheckFailures?: { patchId: string; count: number };
  /** Tokens the model generated in this loop's current or last completed tick — a per-tick
   * window (loop.ts resets it at tick start), not a lifetime total. */
  generatedTokens: number;
  /** Largest single-request context of this loop's current or last completed tick (per-tick
   * window, reset at tick start). */
  peakContextTokens: number;
  totalCostUsd: number;
  /** Local calendar day (YYYY-MM-DD) that `dayCostUsd` belongs to; a stale or missing stamp
   * reads as $0 today — spend before this field existed is unknown, and a tick crossing local
   * midnight attributes its spend to the new day. See plans/daily-cost-budget.md. */
  dayStamp?: string;
  /** This loop's spend for `dayStamp`'s local day (the daily cost budget window). Deliberately
   * NOT zeroed by reset-counters: the budget is a safety valve, not an observation window. */
  dayCostUsd?: number;
  lastError?: string;
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
