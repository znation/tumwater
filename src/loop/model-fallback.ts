import type { BackendFailureKind } from "../pi/pi-stream.js";
import type { PiRunResult } from "../pi/pi-run-result.js";

/** Per-role model-fallback state machine (PLANS.md "Model failure fallback, part 1/2").
 *
 * When a role's primary model keeps failing with provider-class errors (a 429 or a
 * connection/timeout/server/model-load/stream-severed backend failure — the classes a pi run
 * reports as `transientRateLimit`/`transientBackend`), the loop temporarily runs the role's
 * ticks on its tier's resolved fallback pair instead of burning the error ladder until the
 * streak breaker pauses it. Once the cooldown elapses the next tick runs on the primary as a
 * probe; a probe that ANSWERS without a provider failure ends the episode.
 *
 * Only the authoring run of a tick is evidence: a tick that never invoked pi (a director's
 * empty inbox, a recovered leftover, a red-main block) leaves the state untouched, and a run
 * that was aborted, quiet-killed, or timed out gives no verdict either. The module is pure:
 * every function takes `now` from the caller, so the scheduling rules are unit-testable
 * without a real clock. The loop owns the persistence (LoopState.modelFallback). */

/** Persisted state of one role's model-fallback episode. */
export interface ModelFallbackState {
  /** Consecutive provider-class failures observed on the primary before the trip. Reset to 0
   * once the episode begins; the pre-trip count is what an answering run clears. */
  failures: number;
  /** Epoch ms the fallback episode began; 0 while the role is still counting failures on its
   * primary. `since > 0` is the "in fallback" mark the two predicates below read. */
  since: number;
  /** Epoch ms at or after which the next tick runs on the primary as a probe; 0 while the
   * role is still on its primary. */
  probeAt: number;
  /** The current probe cooldown; each failed probe doubles it up to MODEL_FALLBACK_MAX_COOLDOWN_MS. */
  cooldownMs: number;
  /** The provider-class failure that tripped the episode, for the started event and the
   * surfaces that render why a loop is off-model. */
  reason: string;
}

/** What one authoring pi run says about the primary it ran on. */
export type ModelFallbackVerdict =
  /** The run ended on a 429 or a provider backend failure. */
  | "provider-failure"
  /** The run produced its verdict (completed, refused, or declared nothing-to-do) without a
   * provider failure: the primary answered, so it is trusted again. */
  | "answered"
  /** The run was aborted, quiet-killed, or timed out before it reached a verdict: no evidence
   * either way, so the episode is neither ended nor re-tripped. */
  | "inconclusive";

/** Consecutive provider-class failures that trip a fallback episode. */
export const MODEL_FALLBACK_FAILURES = 3;
/** The first probe cooldown after a trip; a failed probe doubles it. */
export const MODEL_FALLBACK_COOLDOWN_MS = 5 * 60_000;
/** The ceiling a repeatedly-failing probe's cooldown doubles toward. */
export const MODEL_FALLBACK_MAX_COOLDOWN_MS = 30 * 60_000;

/** True only while the role is in a fallback episode whose probe is still in the future — the
 * ticks that run on the fallback pair. */
export function modelFallbackActive(state: ModelFallbackState | undefined, now: number): boolean {
  return state !== undefined && state.since > 0 && now < state.probeAt;
}

/** True only while the role is in a fallback episode whose cooldown has elapsed: the next
 * tick runs on the primary as the probe. */
export function modelFallbackProbe(state: ModelFallbackState | undefined, now: number): boolean {
  return state !== undefined && state.since > 0 && now >= state.probeAt;
}

/** Classify one authoring run's verdict about the primary (src/tick/tick-usage.ts records the
 * same flags for the fleet-wide hold). A run that was aborted, quiet-killed, or timed out is
 * inconclusive even when it also reports provider evidence: the harness killed it, so it is
 * no verdict about the primary's health. */
export function modelFallbackVerdict(
  pi: Pick<
    PiRunResult,
    "ok" | "transientRateLimit" | "transientBackend" | "aborted" | "quietKilled" | "timedOut"
  >,
): ModelFallbackVerdict {
  if (pi.aborted || pi.quietKilled || pi.timedOut) return "inconclusive";
  if (!pi.ok && (pi.transientRateLimit || pi.transientBackend)) return "provider-failure";
  return "answered";
}

/** Fold one authoring run's verdict into the role's fallback state, returning the next state
 * or undefined for "running the primary" (no episode).
 *
 * - Not in fallback, provider failure: increment the consecutive count; the
 *   MODEL_FALLBACK_FAILURES-th trips the episode.
 * - Not in fallback, an answering run: clear the running count (undefined).
 * - Not in fallback, an inconclusive run: unchanged — a harness kill is not evidence the
 *   primary recovered, so the running count survives it.
 * - In fallback, a fallback tick (`probe` false): unchanged — its outcome neither returns
 *   the role to primary nor re-trips it.
 * - In fallback, a probe tick: an inconclusive probe is unchanged (retried on the next tick);
 *   an answering probe clears the episode; a provider-class failed probe doubles the cooldown
 *   (capped) and schedules the next one.
 */
export function recordModelFallback(
  state: ModelFallbackState | undefined,
  outcome: { verdict: ModelFallbackVerdict; probe: boolean; now: number; reason: string },
): ModelFallbackState | undefined {
  const { verdict, probe, now, reason } = outcome;
  if (state !== undefined && state.since > 0) {
    if (!probe) return state;
    if (verdict === "inconclusive") return state;
    if (verdict === "answered") return undefined;
    const cooldownMs = Math.min(state.cooldownMs * 2, MODEL_FALLBACK_MAX_COOLDOWN_MS);
    return { ...state, cooldownMs, probeAt: now + cooldownMs, reason: reason || state.reason };
  }
  if (verdict === "inconclusive") return state;
  if (verdict === "answered") return undefined;
  const failures = (state?.failures ?? 0) + 1;
  if (failures >= MODEL_FALLBACK_FAILURES) {
    return {
      failures: 0,
      since: now,
      probeAt: now + MODEL_FALLBACK_COOLDOWN_MS,
      cooldownMs: MODEL_FALLBACK_COOLDOWN_MS,
      reason: reason || "backend failure",
    };
  }
  return { failures, since: 0, probeAt: 0, cooldownMs: 0, reason };
}

/** The reason label one run's provider evidence yields: "rate-limit" for a 429, else the
 * backend-failure kind. Exported so the loop's evidence assembly and tests share one
 * spelling. */
export function providerFailureReason(
  rateLimit: boolean,
  kind: BackendFailureKind | undefined,
): string {
  return rateLimit ? "rate-limit" : (kind ?? "backend failure");
}
