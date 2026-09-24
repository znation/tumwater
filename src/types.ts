/** The harness's runtime types: what one tick produces (TickResult, TickOutcome), the
 * per-loop state persisted under .tumwater/state (LoopState), the event log's line shape
 * (HarnessEvent), the durable land queue's entry (LandingEntry), and one pi run's
 * distilled result (PiRunResult). The tumwater.json config schema types live in
 * config-schema.ts — the config on disk and the runtime state below are two layers,
 * changed for different reasons. */

export type TickResult =
  | "changed" // a landing completed: the change is merged to main
  | "queued" // the tick's change is committed and pinned; the orchestrator's landing slot will pick it up from the durable land queue (plans/merge-queue.md 3/5) — the commit count and final outcome are recorded when the landing completes; never stored as `lastResult`, which keeps the last completed outcome
  | "refused" // pi declined the work (TUMWATER_REFUSED); only its markdown objection note landed
  | "no_change" // pi decided there was nothing to do
  | "merge_conflict" // change was made but could not be merged; discarded next tick
  | "merge_blocked" // fast-forward into main failed (e.g. dirty primary checkout)
  | "rejected" // the review gate rejected the change; branch reset, reasons recorded
  | "review_error" // the review gate failed (no parseable verdict); commit left for retry
  | "error" // pi errored or timed out
  | "aborted" // harness shutdown killed the run mid-tick; partial work discarded
  | "quiet_killed" // the quiet watchdog killed a stalled tool call mid-run; session + worktree edits preserved and resumed promptly
  | "user_aborted" // a user-initiated abort (tumwater abort) killed the run mid-tick; work discarded, loop backed off
  | "main_red" // baseline check found main's build/test suite red; authoring run skipped, code merges blocked until main is green
  | "skipped"; // nothing to run (e.g. director with an empty inbox);

/** The outcome of one full tick: its result plus what the harness learned from it.
 * Consumed by the orchestrator's dashboards and by state.ts's post-tick scheduling
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
  /** A leftover-recovery landing failed and kept the pin for another attempt (review_error,
   * merge_conflict, merge_blocked): the tick's own authoring run may be healthy, but the
   * persistent landing failure must still feed the error streak so a dead reviewer backend
   * raises the alarm instead of resetting it every tick (BUGS.md 2026-09-21). Carries the
   * failure detail for the warning: `lastError` is deliberately cleared off the tick so the
   * failure never rides its `tick_end` (the sibling mislabel fix). */
  recoveryFailure?: string;
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
   * renders. A `queued` tick never writes it (state.ts's applyTickOutcome): its change is still
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
   * (state.ts's ERROR_STREAK_WARN) the state cell reads "failing" instead of "sleeping",
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
  /** Consecutive failed reviews of the SAME branch HEAD (reset when the reviewed HEAD
   * changes or a review succeeds). Past the limit the leftover is discarded with a warning,
   * so a misconfigured reviewer cannot wedge a loop re-reviewing one commit forever. */
  unreviewFailures?: number;
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

/** One line in .tumwater/log/events.jsonl. */
export interface HarnessEvent {
  ts: number;
  loop: string;
  type:
    | "tick_start"
    | "tick_end"
    | "land_queued" // a changed tick pinned its commit and enqueued it for the orchestrator's landing slot (merge queue 3/5); carries sha + summary
    | "landed" // the landing slot finished with the change on main; carries sha, the lander's outcome, durationMs, and the landing's own usage
    | "land_failed" // the landing slot finished without landing (review rejection, under-cap review failure, conflict, blocked ff, shutdown abort); carries the same payload — retry rides next-tick leftover recovery, never the queue
    | "merged"
    | "question_posted" // a merged diff added an entry to QUESTIONS.md's ## Open
    | "wake"
    | "tick_deferred" // need-based prioritization: a due maintenance tick was deferred (no feature/bugfix/director/human commit landed since its last no_change tick); one per deferral episode
    | "orchestrator_start"
    | "orchestrator_stop"
    | "prompt_enqueued"
    | "prompt_cancelled" // a queued prompt was removed before the director ran it (tumwater prompt --cancel)
    | "counters_reset"
    | "tick_aborted" // a user-initiated abort killed one loop's in-flight tick (tumwater abort)
    | "resume"
    | "review_start"
    | "review_verdict" // approved; carries durationMs of the reviewer run
    | "review_rejected" // build pre-check or reviewer said no; durationMs when a reviewer ran
    | "review_failed"
    | "build_check" // the project's declared check ran: scope gate|baseline|landing|batch (landing is the merge lock's post-rebase re-check; batch is the batch lander's one check over the stacked tree), status, script, durationMs
    | "budget_paused" // fleet daily spend reached maxDailyCostUsd with no usable free fallback; role loops stop starting ticks
    | "budget_fallback" // fleet daily spend reached maxDailyCostUsd and a cost-free fallback model is configured; role loops keep ticking on it
    | "budget_resumed" // the cap was raised/disabled or a new local day started; role loops tick again
    | "fleet_paused" // operator pause via `tumwater pause`; role loops stop starting new ticks, director exempt
    | "fleet_resumed" // the pause was lifted (`tumwater resume`); role loops tick again
    | "max_concurrent_changed" // a live tumwater.json edit resized the concurrency cap (from → to)
    | "retention_changed" // a live tumwater.json edit changed sessionRetentionDays (from → to)
    | "config_changed" // a live tumwater.json edit changed other settings (keys)
    | "build_stale" // main's build inputs moved past the running build (self-hosting fleets; src/redeploy.ts)
    | "restart_pending" // main is green and compiling; no new ticks start until the restart lands
    | "restart" // dist/ now holds the new build; the orchestrator exits for the supervisor to respawn it
    | "warning";
  [key: string]: unknown;
}

/** One entry in the durable land queue (.tumwater/land-queue/; src/land-queue.ts): a commit
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
