/** Distilled result of one pi run (`runPi`) — the shared vocabulary every consumer of a
 * pi run reads: the tick loop, the landing wiring, the usage accounting, the failure
 * digests. It lives apart from pi.ts so callers that only handle run results (tick-usage,
 * failure-data, the landing batch) need not import the spawn machinery to name the type. */
import type { BackendFailureKind } from "./pi-stream.js";

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
  /** Prompt tokens this run sent (usage.input + cacheRead + cacheWrite summed across turns). */
  promptTokens: number;
  /** The cache-read share of promptTokens (usage.cacheRead summed across turns). */
  cacheReadTokens: number;
  /** Prompt tokens sent up to and including the first assistant turn carrying an edit or
   * write tool call; equals promptTokens for a run that never edited. */
  preEditPromptTokens: number;
  /** 1-based index of the first assistant turn carrying an edit or write tool call;
   * undefined when the run never edited. */
  firstEditTurn?: number;
  /** Largest single-request context of the run. */
  peakContextTokens: number;
  /** Assistant turns completed in this run (message_end events) — feeds the commit trailer
   * and the high-friction flag; a tick sums it across its pre-commit runs. */
  turns: number;
  costUsd: number;
  stopReason?: string;
  errorMessage?: string;
  timedOut: boolean;
  /** The tick timeout fired on a run that was still making progress — a real progress event
   * within the last quietTimeoutSeconds. A slow run, not a hung one: the loop preserves its
   * session and worktree edits and resumes it like a quiet kill instead of discarding them
   * (BUGS.md 2026-09-29). Never true without timedOut. */
  timedOutProgressing: boolean;
  /** The run was killed because the harness is shutting down. */
  aborted: boolean;
  /** The stderr line pi printed when the requested model id had no exact definition and pi
   * cloned the provider's default model, inheriting that default's price and context window —
   * the silent mispricing of BUGS.md 2026-10-06. Undefined when pi printed no such warning. */
  fallbackClone?: string;
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
  /** True when any event reported a provider-wide failure that is not rate limiting — the
   * connection down, a 5xx, the model failing to load, the stream severed mid-run
   * (src/pi/pi-stream.ts TRANSIENT_BACKEND). A transient failure of the world like the 429 flag,
   * but with no Retry-After hint to wait out: the fleet-wide hold (src/fleet/fleet-hold.ts) and —
   * for the stream-severed kind only — the per-run retry answer it. */
  transientBackend: boolean;
  /** Which kind of backend failure the run ended on (src/pi/pi-stream.ts backendKind's
   * classification) — the fleet-wide hold groups its storms by kind. Undefined when
   * transientBackend is false. */
  backendKind?: BackendFailureKind;
  /** True when the run ended on a permanent provider configuration error (a 4xx other than
   * 408/429, or the provider's model_not_supported/invalid_request_error spelling): the
   * request can never succeed until the config changes, so the landing path holds the pin
   * instead of re-queuing it at suite speed (BUGS.md 2026-10-06). */
  configError: boolean;
  /** The provider's Retry-After delay (seconds) from the rate-limit error text, when one was
   * sent; undefined otherwise. Caps the loop's wait before the transient retry. */
  retryAfterSeconds?: number;
  /** The run's last assistant message carried no text and no tool call (thinking-only or
   * empty). A compliant finish always ends with a text block, so this signals a generation
   * cut off mid-stream — typically pi clamping max output tokens to the sliver left under
   * the declared context window, with the provider misreporting the truncation as a normal
   * stop. Used to diagnose otherwise-mysterious no-sentinel no_change ticks. */
  finalMessageContentless: boolean;
  /** True when any assistant message carried a tool call or non-empty text — the run did
   * something of its own. False on a run that ended on a provider error turn with empty
   * `content` (one completed turn, no content), which lets resolveTickVerdict tell a resumed
   * run that added nothing from a failed run whose dirty worktree is its own (BUGS.md
   * 2026-10-06). */
  producedAssistantContent: boolean;
  /** pi auto-compacted the session during (or at the end of) the run. */
  compacted: boolean;
}
