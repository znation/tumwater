import { BASELINE_BLOCKED_ROLES } from "./roles.js";
import { defaultConfig, isCustomRole, loadConfigCached } from "./config.js";
import { BUILD_CHECK_TIMEOUT_MS, buildCheckSkipWarning } from "./build-check.js";
import { checkMainBaseline, failureHeadline } from "./main-baseline.js";
import { buildMainRedNote } from "./prompt.js";
import { logEvent } from "./events.js";
import type { TickOutcome } from "./types.js";
import { shortSha } from "./text.js";

/** Red-main baseline gate for fresh authoring ticks (PLANS.md "Red-main baseline check"):
 * before an authoring run is spent on top of pristine main, verify that MAIN ITSELF is green —
 * a red main rejects every code diff deterministically at the review gate (BUGS.md's "Build
 * broken on main" and "Tests red on main" entries), so while a SHA is known red the blocked
 * roles skip authoring instead of burning runs that are guaranteed to fail. Split out of loop.ts —
 * which keeps the tick lifecycle around it — because this is a self-contained policy with its own
 * per-process state (one harness-level warning per newly-discovered red SHA) and its own event
 * contract; what it borrows from the loop is identity only, and it consumes build-check.ts's
 * checkMainBaseline machinery (detection + execution + per-SHA cache), which stays unaware of
 * ticks. */

/** The last main SHA for which this process logged a red-main warning (the baseline check):
 * one harness-level warning per newly-discovered red SHA, not one per blocked role's tick —
 * module-level so every runner in the fleet shares it. A restart re-logs once: the cache is
 * cold then too, and an operator restarting into a still-red main should see why nothing lands. */
let lastMainRedSha: string | null = null;

/** Log the fleet-wide red-main warning for `red`'s SHA at most once per process. Module-level
 * (with lastMainRedSha) so the gate and the bugfix handoff share one guard: whichever observes
 * the red first logs it, the other stays silent. */
function warnMainRedOnce(root: string, red: { sha: string; script?: string; outputTail?: string[] }): void {
  if (lastMainRedSha === red.sha) return;
  lastMainRedSha = red.sha;
  const firstLine = failureHeadline(red.outputTail);
  logEvent(root, {
    loop: "harness",
    type: "warning",
    message: `main ${shortSha(red.sha)} is red (${red.script}${firstLine ? `: ${firstLine}` : ""}) — code merges blocked until main is green`,
  });
}

/** Red-main handoff for the `bugfix` healer (PLANS.md "Red-main handoff"): mainRedGate exempts
 * bugfix so the only role that can unblock the fleet may author, but its prompt then starts from
 * BUGS.md and knows nothing about the red suite. This runs the same per-SHA baseline check
 * (cache and provisional-red re-verification reused unchanged, so it costs at most the one run
 * the gate would have paid for) and, when main is red, returns the note that points the healer
 * at the failure. Returns undefined on green, no declared check, or an environmental skip — the
 * healer's tick then proceeds exactly as it did before this existed. Never throws. */
export async function bugfixMainRedNote(root: string, role: string, wt: string): Promise<string | undefined> {
  const baseline = await checkMainBaseline(wt, ({ outcome, durationMs }) =>
    logEvent(root, {
      loop: role,
      type: "build_check",
      scope: "baseline",
      status: outcome.status,
      script: outcome.script,
      durationMs,
    }),
  );
  const red = baseline.baseline;
  if (red?.status !== "red") return undefined;
  warnMainRedOnce(root, red);
  return buildMainRedNote(red.sha, red.script, failureHeadline(red.outputTail));
}

/** Gate one fresh tick on main's baseline. Returns null when authoring may proceed — role not
 * blocked, no declared check, green, or an environmental skip (warned under the role and
 * proceeded with, exactly like the review gate's pre-check) — otherwise the terminal
 * `main_red` outcome for the caller to return as-is. Never throws: git, detection, and
 * execution failures all resolve to "nothing blocks authoring" inside checkMainBaseline. */
export async function mainRedGate(root: string, role: string, wt: string): Promise<TickOutcome | null> {
  // User-defined loops are blocked alongside the built-in code roles (plans/user-defined-loops.md):
  // an unknown charter may produce code, and on red main such diffs are rejected deterministically
  // at the gate's pre-check — an authoring run would be pure waste. Customs come from tumwater.json,
  // not the catalog, so read the live config (stat-cached; a broken file degrades to defaults,
  // which know no customs).
  const cfg = loadConfigCached(root).config ?? defaultConfig();
  if (!BASELINE_BLOCKED_ROLES.has(role) && !isCustomRole(cfg, role)) return null;
  // The one run per SHA (cache misses only) is logged under the role that paid for it, with its
  // duration — the gate's build_check sibling, so both halves of the fleet's deterministic
  // verification are priced in the feed.
  const baseline = await checkMainBaseline(wt, ({ outcome, durationMs }) =>
    logEvent(root, {
      loop: role,
      type: "build_check",
      scope: "baseline",
      status: outcome.status,
      script: outcome.script,
      durationMs,
    }),
  );
  if (baseline.skipReason) {
    logEvent(root, {
      loop: role,
      type: "warning",
      message: buildCheckSkipWarning(
        baseline.skipReason,
        "main baseline check",
        "proceeding with authoring unverified",
        BUILD_CHECK_TIMEOUT_MS,
      ),
    });
    return null;
  }
  if (baseline.baseline?.status === "red") {
    warnMainRedOnce(root, baseline.baseline);
    return { result: "main_red", summary: "code merges blocked until main is green" };
  }
  return null;
}
