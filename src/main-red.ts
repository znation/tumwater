import { BASELINE_BLOCKED_ROLES } from "./roles.js";
import { BUILD_CHECK_TIMEOUT_MS, checkMainBaseline } from "./build-check.js";
import { logEvent } from "./events.js";
import type { TickOutcome } from "./types.js";
import { shortSha } from "./text.js";

/** Red-main baseline gate for fresh authoring ticks (PLANS.md "Red-main baseline check"):
 * before an authoring run is spent on top of pristine main, verify that MAIN ITSELF is green —
 * a red main rejects every code diff deterministically at the review gate (BUGS.md's nine
 * "build/tests red on main" entries), so while a SHA is known red the blocked roles skip
 * authoring instead of burning runs that are guaranteed to fail. Split out of loop.ts — which
 * keeps the tick lifecycle around it — because this is a self-contained policy with its own
 * per-process state (one harness-level warning per newly-discovered red SHA) and its own event
 * contract; what it borrows from the loop is identity only, and it consumes build-check.ts's
 * checkMainBaseline machinery (detection + execution + per-SHA cache), which stays unaware of
 * ticks. */

/** The last main SHA for which this process logged a red-main warning (the baseline check):
 * one harness-level warning per newly-discovered red SHA, not one per blocked role's tick —
 * module-level so every runner in the fleet shares it. A restart re-logs once: the cache is
 * cold then too, and an operator restarting into a still-red main should see why nothing lands. */
let lastMainRedSha: string | null = null;

/** Gate one fresh tick on main's baseline. Returns null when authoring may proceed — role not
 * blocked, no declared check, green, or an environmental skip (warned under the role and
 * proceeded with, exactly like the review gate's pre-check) — otherwise the terminal
 * `main_red` outcome for the caller to return as-is. Never throws: git, detection, and
 * execution failures all resolve to "nothing blocks authoring" inside checkMainBaseline. */
export async function mainRedGate(root: string, role: string, wt: string): Promise<TickOutcome | null> {
  if (!BASELINE_BLOCKED_ROLES.has(role)) return null;
  const baseline = await checkMainBaseline(wt);
  if (baseline.skipReason) {
    logEvent(root, {
      loop: role,
      type: "warning",
      message:
        baseline.skipReason === "no-npm"
          ? "no npm on PATH; skipping main baseline check"
          : `main baseline check timed out after ${BUILD_CHECK_TIMEOUT_MS / 1000}s; proceeding with authoring unverified`,
    });
    return null;
  }
  if (baseline.baseline?.status === "red") {
    const red = baseline.baseline;
    if (lastMainRedSha !== red.sha) {
      lastMainRedSha = red.sha;
      const firstLine = red.outputTail?.[0];
      logEvent(root, {
        loop: "harness",
        type: "warning",
        message: `main ${shortSha(red.sha)} is red (${red.script}${firstLine ? `: ${firstLine}` : ""}) — code merges blocked until main is green`,
      });
    }
    return { result: "main_red", summary: "code merges blocked until main is green" };
  }
  return null;
}
