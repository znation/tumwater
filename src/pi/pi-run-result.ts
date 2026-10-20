/** Distilled result of one pi run (`runPi`) — the shared vocabulary every consumer of a
 * pi run reads: the run loop, the merge wiring, the usage accounting, the failure
 * digests. It lives apart from pi.ts so callers that only handle run results (run-usage,
 * failure-data, the merge batch) need not import the spawn machinery to name the type. */
import type { BackendFailureKind } from "./pi-failure.js";
import type { RateWindow } from "./pi-stream.js";

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
   * and the high-friction flag; a run sums it across its pre-commit agent runs. */
  turns: number;
  costUsd: number;
  stopReason?: string;
  errorMessage?: string;
  timedOut: boolean;
  /** The run timeout fired on a run that was still making progress — a real progress event
   * within the last quietTimeoutSeconds. A slow run, not a hung one: the runner preserves its
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
   * intended), not a slow run. Distinct from timedOut (the whole-run deadline): the session
   * and any worktree edits are intact, so the runner resumes them promptly instead of discarding.
   */
  quietKilled: boolean;
  /** The provider rejected the context as too large. With fresh-per-run sessions this is
   * purely diagnostic: the next run starts a new session regardless. */
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
   * "later": one retry after retryAfterSeconds usually succeeds, so the runner's transient
   * retry covers it instead of discarding the run's work. */
  transientRateLimit: boolean;
  /** True when any event reported a provider-wide failure that is not rate limiting — the
   * connection down, a 5xx, the model failing to load, the stream severed mid-run
   * (src/pi/pi-failure.ts TRANSIENT_BACKEND). A transient failure of the world like the 429 flag,
   * but with no Retry-After hint to wait out: the team-wide hold (src/team/team-hold.ts) and —
   * for the stream-severed kind only — the per-run retry answer it. */
  transientBackend: boolean;
  /** Which kind of backend failure the run ended on (src/pi/pi-failure.ts backendKind's
   * classification) — the team-wide hold groups its storms by kind. Undefined when
   * transientBackend is false. */
  backendKind?: BackendFailureKind;
  /** True when the run ended on a permanent provider configuration error (a 4xx other than
   * 408/429, or the provider's model_not_supported/invalid_request_error spelling): the
   * request can never succeed until the config changes, so the merge path holds the pin
   * instead of re-queuing it at suite speed (BUGS.md 2026-10-06). */
  configError: boolean;
  /** The provider's Retry-After delay (seconds) from the rate-limit error text, when one was
   * sent; undefined otherwise. Caps the runner's wait before the transient retry. */
  retryAfterSeconds?: number;
  /** The run's last assistant message carried no text and no tool call (thinking-only or
   * empty). A compliant finish always ends with a text block, so this signals a generation
   * cut off mid-stream — typically pi clamping max output tokens to the sliver left under
   * the declared context window, with the provider misreporting the truncation as a normal
   * stop. Used to diagnose otherwise-mysterious no-sentinel no_change runs. */
  finalMessageContentless: boolean;
  /** True when any assistant message carried a tool call or non-empty text — the run did
   * something of its own. False on a run that ended on a provider error turn with empty
   * `content` (one completed turn, no content), which lets resolveRunVerdict tell a resumed
   * run that added nothing from a failed run whose dirty worktree is its own (BUGS.md
   * 2026-10-06). */
  producedAssistantContent: boolean;
  /** pi auto-compacted the session during (or at the end of) the run. */
  compacted: boolean;
  /** True when a backend translator classified the run as hitting a per-run budget cap
   * (claude's `error_max_budget_usd`, plans/agent-backends.md part 7). Undefined on backends
   * that report no such signal. */
  budgetCapped?: boolean;
  /** True when a backend translator classified the run as resuming a session its backend
   * cannot find (`No conversation found with session ID`): the caller retries fresh as a
   * handoff (plans/agent-backends.md part 3c). Undefined on backends that report no such
   * signal. */
  resumeMissing?: boolean;
  /** The one image this run's agent read that its model cannot see (plans/image-input.md
   * "Detecting a blind read"): pi strips such an image from the request, so the agent was
   * about to answer about a picture it never saw. The runner kills an authoring run at once;
   * a gate run only records it. Undefined when the run read no blind image. */
  imageBlind?: { path: string };
  /** How the run was paid for, from the backend's own report: a subscription window or API
   * credit (plans/agent-backends.md parts 3a and 6). Undefined when the backend names neither. */
  billing?: "subscription" | "api";
  /** The newest account rate-limit reading per window type, when the backend reports them
   * (plans/agent-backends.md part 6). Undefined on backends that report no windows. */
  rateWindows?: RateWindow[];
  /** True when any reported rate-limit window showed the account spending into overage. */
  usedOverage?: boolean;
}

/** Whether a run's cost is real money that charges the daily cap (plans/agent-backends.md
 * part 6a): an API-billed run, or a subscription run that saw overage. A plain subscription
 * run's cost is notional — API-equivalent spend that never moves the cap. The one predicate
 * both the run-usage fold and the merge accumulator split on, so the two cannot drift. */
export function runCostIsReal(run: Pick<PiRunResult, "billing" | "usedOverage">): boolean {
  return run.billing !== "subscription" || run.usedOverage === true;
}
