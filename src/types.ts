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
  /** Delete pi session files older than this many days at orchestrator start. */
  sessionRetentionDays: number;
  idleBackoff: BackoffConfig;
  roles: Record<string, RoleConfig>;
}

export type TickResult =
  | "changed" // pi made changes; committed and merged to main
  | "no_change" // pi decided there was nothing to do
  | "merge_conflict" // change was made but could not be merged; discarded next tick
  | "merge_blocked" // fast-forward into main failed (e.g. dirty primary checkout)
  | "error" // pi errored or timed out
  | "aborted" // harness shutdown killed the run mid-tick; partial work discarded
  | "skipped"; // nothing to run (e.g. director with an empty inbox)

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
  /** True once this loop has a pi session to resume; ticks then run with --continue so
   * the loop keeps its accumulated context (pi auto-compacts when it grows too large). */
  hasSession?: boolean;
  /** Consecutive error ticks; repeated errors drop the session as a self-healing measure. */
  consecutiveErrors?: number;
  /** Tokens the model actually generated for this loop, summed across all runs. */
  generatedTokens: number;
  /** Largest single-request context this loop has ever submitted. */
  peakContextTokens: number;
  totalCostUsd: number;
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
    | "wake"
    | "orchestrator_start"
    | "orchestrator_stop"
    | "prompt_enqueued"
    | "counters_reset"
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
  /** Tokens the model generated in this run (usage.output summed across turns). */
  outputTokens: number;
  /** Largest single-request context of the run. */
  peakContextTokens: number;
  costUsd: number;
  stopReason?: string;
  errorMessage?: string;
  timedOut: boolean;
  /** The run was killed because the harness is shutting down. */
  aborted: boolean;
  /** The provider rejected the context as too large; the resumed session is poisoned. */
  contextExceeded: boolean;
  /** True when any event reported the model server killing an idle predict stream (LM
   * Studio's "Engine protocol predict stream timed out", e.g. after OS sleep). A transient
   * failure of the world, not of the session: one fresh retry usually succeeds. */
  transientServerTimeout: boolean;
  /** The run's last assistant message carried no text and no tool call (thinking-only or
   * empty). A compliant finish always ends with a text block, so this signals a generation
   * cut off mid-stream — typically pi clamping max output tokens to the sliver left under
   * the declared context window, with the provider misreporting the truncation as a normal
   * stop. Used to diagnose otherwise-mysterious no-sentinel no_change ticks. */
  finalMessageContentless: boolean;
  /** pi auto-compacted the session during (or at the end of) the run. */
  compacted: boolean;
}
