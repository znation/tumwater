/** The `telemetry` role's tick-time evidence: the failure digest rendered over the role's own
 * one-day window. Split out of src/failure/failure-render.ts — which stays the pure
 * renderer — so every observer role's evidence builder has its own module the way
 * qa-coverage.ts and backlog-structure.ts do, and the tick lifecycle (tick-prompt.ts) injects
 * it from there instead of reaching into a report module. */
import { collectFailureReport } from "../failure/failure-data.js";
import { renderFailureMarkdown } from "../failure/failure-render.js";

/** The `telemetry` role's own digest window, in local calendar days (plans/telemetry-role.md).
 * The CLI keeps the usage report's 14-day default; the role reads one day so a cluster
 * re-surfaces only while it is live. The 2×-window read below still spans two days, which is
 * what makes the delta line meaningful. */
export const TELEMETRY_DIGEST_DAYS = 1;

/** The `telemetry` role's tick-time evidence: the failure digest rendered over its own
 * one-day window. A missing or corrupt log omits the block (undefined) and never fails the
 * tick — an observer must not break on bookkeeping (plans/telemetry-role.md). The window and
 * the swallow-errors policy live with the digest, not in the tick lifecycle that injects it. */
export function telemetryDigest(root: string): string | undefined {
  try {
    return renderFailureMarkdown(collectFailureReport(root, TELEMETRY_DIGEST_DAYS));
  } catch {
    return undefined;
  }
}
