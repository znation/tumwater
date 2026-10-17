// vocabulary: plain
/**
 * The model's declared context window, as the bundled pi extensions read it: the one home of the
 * window arithmetic bounded-output, context-shake and strip-thinking share.
 *
 * The extensions' fixed limits and thresholds were tuned on the local fallback's 127k–128k window.
 * On a smaller one (a 64k local model) the same numbers are too big for it: a 12k-char read is a
 * larger share of the window, and context-shake's 85% pass sits past the point where pi compacts
 * the run with a lossy summary (contextWindow − its 16,384-token reserve, 75% of a 64k window).
 * So each tuned value holds at or above REFERENCE_WINDOW_TOKENS and scales down below it.
 *
 * Pure and filesystem-free; pi itself loads the extensions, so this imports nothing pi-specific.
 */

import { nonNegativeNumber } from "../files/json-object.js";

/** The window the extensions' fixed values were tuned on (128k). At or above it they hold; below
 * it each scales down. */
export const REFERENCE_WINDOW_TOKENS = 131_072;

/** pi's default `compaction.reserveTokens`: pi compacts the run once its context passes the
 * window minus this. tumwater leaves the setting at its default. */
export const PI_COMPACTION_RESERVE_TOKENS = 16_384;

/** A declared window as a positive finite token count, or null when it is missing or unusable
 * (not a number, non-finite, negative, or zero). */
export function declaredWindow(value: unknown): number | null {
  const window = nonNegativeNumber(value, null);
  return window !== null && window > 0 ? window : null;
}

/** The factor a value tuned on the reference window scales by on `window`: its share of the
 * reference window, capped at 1. An unknown window keeps the tuned value (1). */
export function windowScale(window: unknown): number {
  const tokens = declaredWindow(window);
  return tokens === null ? 1 : Math.min(1, tokens / REFERENCE_WINDOW_TOKENS);
}

/** The fill percentage at which pi compacts a run on a known `window`: 87.5 at 128k, 75 at 64k,
 * 0 for a window no larger than the reserve. */
export function compactionPercent(window: number): number {
  return Math.max(0, ((window - PI_COMPACTION_RESERVE_TOKENS) / window) * 100);
}
