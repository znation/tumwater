/** Shared types for the tumwater harness. */

/** Per-role configuration in tumwater.json. */
export interface RoleConfig {
  enabled: boolean;
  /** Extra instructions appended to this role's prompt. */
  instructions?: string;
  /** pi provider override for this role; falls back to the top-level value. */
  provider?: string;
  /** pi model override for this role; falls back to the top-level value. */
  model?: string;
  /** pi thinking-level override for this role; falls back to the top-level value. */
  thinking?: string;
  /** Minimum seconds between two ticks of THIS role, overriding the top-level value — a
   * slow clock for roles that should act rarely (the steward curates on ~6 h). */
  minTickIntervalSeconds?: number;
}

/** Top-level review-gate config in tumwater.json (see src/review.ts). */
interface ReviewConfig {
  /** Enable the adversarial pre-merge review gate (default true). */
  enabled: boolean;
  /** Repo-relative path patterns whose diffs are exempt from review when EVERY changed
   * file matches some pattern (doc-only changes stay cheap). A pattern without "/" matches
   * the basename at any depth; one with "/" matches the full path (* within a segment,
   * ** across segments). */
  exemptPaths: string[];
  /** pi provider override for reviewer runs; falls back to the top-level value. */
  provider?: string;
  /** pi model override for reviewer runs — e.g. the strong model reviews what the cheap
   * model wrote. Falls back to the top-level value. */
  model?: string;
  /** pi thinking-level override for reviewer runs; falls back to the top-level value. */
  thinking?: string;
}

/** Idle backoff: how long a loop sleeps after a tick that changed nothing. */
export interface BackoffConfig {
  /** Seconds to sleep after the first no-change tick. */
  initialSeconds: number;
  /** Multiplier applied on each consecutive no-change tick. */
  factor: number;
  /** Ceiling in seconds. */
  maxSeconds: number;
}

/** The tracked tumwater.json config. */
export interface TumwaterConfig {
  /** pi provider name; omitted = pi's own default. */
  provider?: string;
  /** pi model pattern; omitted = pi's own default. */
  model?: string;
  /** pi thinking level; omitted = pi's own default. */
  thinking?: string;
  /** Extra argv passed straight to pi. */
  piArgs: string[];
  /** Max pi runs in flight at once across all loops. */
  maxConcurrent: number;
  /** Minimum seconds between two ticks of the same loop, even when woken early. */
  minTickIntervalSeconds: number;
  /** Hard cap on a single pi run, in seconds. */
  tickTimeoutSeconds: number;
  /** Kill a pi run when it emits NO output for this many seconds (0 disables). A healthy
   * run streams events continuously even when slow; prolonged silence means a hung tool
   * (interactive command, zombie socket) that would otherwise burn the whole tick timeout. */
  quietTimeoutSeconds: number;
  /** Rotate events.jsonl and per-role pi logs when they exceed this size. */
  logMaxBytes: number;
  /** Delete pi session files older than this many days at orchestrator start (0 disables). */
  sessionRetentionDays: number;
  /** Daily cost budget in USD for the fleet's autonomous spend: while the sum of every loop's
   * spend for the local day has reached this, role loops stop starting new ticks until the next
   * local midnight or a live edit raises/disables it (0 disables). The director is exempt — an
   * explicit human prompt outranks the autonomous-spend cap. See plans/daily-cost-budget.md. */
  maxDailyCostUsd: number;
  /** Friction threshold in assistant turns: a changed tick using MORE than this many turns is
   * flagged high-friction (Friction trailer line on its commit, warning event, and extra review
   * scrutiny) — difficulty is a signal that the work may not fit. See plans/refusal-and-thrash.md.
   */
  thrashTurns: number;
  /** Friction threshold in wall-clock minutes, same semantics as thrashTurns. */
  thrashMinutes: number;
  idleBackoff: BackoffConfig;
  /** Self-redeploy for a self-hosting fleet (src/redeploy.ts): when main's build inputs move past
   * the running build and main is green, rebuild, drain, and restart onto the new code (default
   * true). Off, the dashboards still flag the build as stale but nothing restarts. */
  autoRestart: boolean;
  /** Adversarial pre-merge review gate (see src/review.ts). */
  review: ReviewConfig;
  roles: Record<string, RoleConfig>;
}

export type TickResult =
  | "changed" // pi made changes; committed and merged to main
  | "refused" // pi declined the work (TUMWATER_REFUSED); only its markdown objection note landed
  | "no_change" // pi decided there was nothing to do
  | "merge_conflict" // change was made but could not be merged; discarded next tick
  | "merge_blocked" // fast-forward into main failed (e.g. dirty primary checkout)
  | "rejected" // the review gate rejected the change; branch reset, reasons recorded
  | "review_error" // the review gate failed (no parseable verdict); commit left for retry
  | "error" // pi errored or timed out
  | "aborted" // harness shutdown killed the run mid-tick; partial work discarded
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
  /** The tick's authoring run burned more than the configured thrashTurns/thrashMinutes
   * thresholds (plans/refusal-and-thrash.md): difficulty is a signal, so the change went to
   * review flagged and a warning event was logged. */
  highFriction?: boolean;
  /** The run was truncated at the model's context ceiling before it could finish (a
   * no_change tick whose final message carried no text or tool call). The work so far
   * survives in the pi session, which pi compacted at end of run — so the loop resumes
   * it promptly instead of backing off as if the role were idle. */
  cutOff?: boolean;
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
  lastResult?: TickResult;
  lastSummary?: string;
  lastTickStartedAt?: number;
  lastTickEndedAt?: number;
  /** True while a tick is in flight (best-effort; cleared on orchestrator start). */
  running?: boolean;
  /** True when the last tick was interrupted mid-task — aborted by a harness shutdown, or
   * truncated at the model's context ceiling — with its pi session (and any uncommitted
   * worktree edits, for shutdowns) left in place: the next tick resumes that session
   * (--continue) instead of starting fresh. Consumed (cleared) by that tick; set again only
   * by another interruption, so a failing resume falls back to a fresh start. */
  resumePending?: boolean;
  /** Consecutive ticks that ended truncated at the context ceiling. Bounds cut-off resumes:
   * past the limit the loop abandons the runaway task and falls back to a fresh tick. */
  cutOffStreak?: number;
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
    | "build_check" // the project's declared check ran: scope gate|baseline, status, script, durationMs
    | "budget_paused" // fleet daily spend reached maxDailyCostUsd; role loops stop starting ticks
    | "budget_resumed" // the cap was raised/disabled or a new local day started; role loops tick again
    | "fleet_paused" // operator pause via `tumwater pause`; role loops stop starting new ticks, director exempt
    | "fleet_resumed" // the pause was lifted (`tumwater resume`); role loops tick again
    | "max_concurrent_changed" // a live tumwater.json edit resized the concurrency cap (from → to)
    | "retention_changed" // a live tumwater.json edit changed sessionRetentionDays (from → to)
    | "build_stale" // main's build inputs moved past the running build (self-hosting fleets; src/redeploy.ts)
    | "restart_pending" // main is green and compiling; no new ticks start until the restart lands
    | "restart" // dist/ now holds the new build; the orchestrator exits for the supervisor to respawn it
    | "warning";
  [key: string]: unknown;
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
  /** The run's last assistant message carried no text and no tool call (thinking-only or
   * empty). A compliant finish always ends with a text block, so this signals a generation
   * cut off mid-stream — typically pi clamping max output tokens to the sliver left under
   * the declared context window, with the provider misreporting the truncation as a normal
   * stop. Used to diagnose otherwise-mysterious no-sentinel no_change ticks. */
  finalMessageContentless: boolean;
  /** pi auto-compacted the session during (or at the end of) the run. */
  compacted: boolean;
}
