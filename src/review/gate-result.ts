/** The review gate's fail-closed-on-abort verdict — its own module so both the gate
 * (review.ts) and the pre-check (review-precheck.ts) can build it without a runtime import
 * cycle between them (docs/code-metrics.md records "no runtime import cycles").
 *
 * A gate path returns this when its signal has aborted: fail closed, leave the commit, and let
 * the run report aborted (resume re-reviews via the combined diff). The reviewer retry loop in
 * review.ts and the pre-check's four abort guards in review-precheck.ts all settle a consumed
 * abort on this same shape, so a stopped change never slips through an approving path and a
 * late kill never waits a parked check out. */
import type { GateResult } from "./review.js";

/** The gate's verdict when its own signal has aborted: failed, with `aborted` set so the caller
 * reports the run aborted rather than the change rejected. Both review.ts and review-precheck.ts
 * settle every consumed abort on this one shape. */
export function abortedGateResult(): GateResult {
  return { decision: "failed", aborted: true };
}
