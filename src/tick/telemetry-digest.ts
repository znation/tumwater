/** The `telemetry` role's tick-time evidence: the failure digest rendered over the role's own
 * trailing 24 h window. Split out of src/failure/failure-render.ts — which stays the pure
 * renderer — so every observer role's evidence builder has its own module the way
 * qa-coverage.ts and backlog-structure.ts do, and the tick lifecycle (tick-prompt.ts) injects
 * it from there instead of reaching into a report module. */
import { collectFailureReportSince } from "../failure/failure-data.js";
import { renderFailureMarkdown } from "../failure/failure-render.js";

/** The `telemetry` role's own digest window: the trailing 24 h ending now, not the local
 * calendar day. A calendar day starts at midnight, so a run at 06:32 would never see the
 * previous evening. The CLI keeps the usage report's 14-day default; the role reads 24 h so a
 * cluster re-surfaces only while it is live. The collector's equal-length prior window is what
 * makes the delta line meaningful. */
export const TELEMETRY_DIGEST_MS = 24 * 60 * 60 * 1000;

/** The `telemetry` role's tick-time evidence: the failure digest rendered over its own
 * trailing 24 h window. A missing or corrupt log omits the block (undefined) and never fails the
 * tick — an observer must not break on bookkeeping (plans/telemetry-role.md). The window and
 * the swallow-errors policy live with the digest, not in the tick lifecycle that injects it. */
export function telemetryDigest(root: string): string | undefined {
  try {
    return renderFailureMarkdown(collectFailureReportSince(root, TELEMETRY_DIGEST_MS));
  } catch {
    return undefined;
  }
}
