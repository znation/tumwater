import { BASELINE_BLOCKED_ROLES } from "./roles.js";
import { defaultConfig, isCustomRole, loadConfigCached } from "./config.js";
import { BUILD_CHECK_TIMEOUT_MS, buildCheckRunFields, buildCheckSkipWarning, failureHeadline } from "./build-check.js";
import type { BuildCheckOutcome } from "./build-check.js";
import { checkMainBaseline } from "./main-baseline.js";
import { buildMainRedNote } from "./gate-prompts.js";
import { logEvent, warnEvent } from "./events.js";
import type { TickOutcome } from "./types.js";
import type { TumwaterConfig } from "./config-schema.js";
import { errorMessage, shortSha } from "./text.js";
import { gitTry } from "./git.js";
import { gateMainWorktreePath } from "./paths.js";
import { ensureDetachedWorktree } from "./worktree.js";

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
  warnEvent(
    root,
    "harness",
    `main ${shortSha(red.sha)} is red (${red.script}${firstLine ? `: ${firstLine}` : ""}) — code merges blocked until main is green`,
  );
}

/** checkMainBaseline's per-run hook: log the one run per SHA (cache misses only) under the role
 * that paid for it, with its duration — the gate's build_check sibling, so both halves of the
 * fleet's deterministic verification are priced in the feed. Shared by the bugfix healer, the
 * gate, and the batch lander's red-check attribution (land-batch.ts) so the event's shape
 * cannot drift between them. */
export function baselineCheckLogger(
  root: string,
  role: string,
): (run: { outcome: BuildCheckOutcome; durationMs: number }) => void {
  return ({ outcome, durationMs }) =>
    logEvent(root, {
      loop: role,
      type: "build_check",
      scope: "baseline",
      status: outcome.status,
      script: outcome.script,
      durationMs,
      ...buildCheckRunFields(outcome),
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
  // The declared check is detected through the live config (plans/portability.md §6/7); a
  // broken file degrades to defaults, which declare none — the tick then proceeds as before.
  const config = loadConfigCached(root).config ?? defaultConfig();
  const baseline = await checkMainBaseline(wt, config, baselineCheckLogger(root, role));
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
  const baseline = await checkMainBaseline(wt, cfg, baselineCheckLogger(root, role));
  if (baseline.skipReason) {
    warnEvent(
      root,
      role,
      buildCheckSkipWarning(
        baseline.skipReason,
        "main baseline check",
        "proceeding with authoring unverified",
        BUILD_CHECK_TIMEOUT_MS,
        undefined,
        baseline.run,
      ),
    );
    return null;
  }
  if (baseline.baseline?.status === "red") {
    warnMainRedOnce(root, baseline.baseline);
    return { result: "main_red", summary: "code merges blocked until main is green" };
  }
  return null;
}

/** What the review gate learns about main's current tip when a change's check failed twice
 * (mainTipVerdict): `green` — main passes, so the change broke the check; `red` — main fails
 * too, so the failure is not the change's and this module's gate and bugfix handoff own the
 * repair; `unavailable` — no verdict could be had, with `why` for the rejection's reasons. */
export type MainTipVerdict =
  | { status: "green"; sha: string }
  | { status: "red"; sha: string }
  | { status: "unavailable"; why: string };

/** Serializes mainTipVerdict's use of its one worktree: the landing pipeline's vets run their
 * gates concurrently, and a second gate re-pointing the checkout at a newer main while the first's
 * check ran in it would measure a tree that is neither. Each link is bounded — a few git
 * commands plus at most one check run, which runBuildCheck kills at its timeout — and takes no
 * other lock, so a waiter waits at most for the gates queued ahead of it. */
let gateMainQueue: Promise<unknown> = Promise.resolve();

/** Main's baseline verdict at its current tip, for attributing a gate check that failed twice
 * (src/review.ts): gateMainWorktreePath is re-pointed at `mainBranch`'s tip and asked through
 * checkMainBaseline — the same per-SHA, fleet-wide cache mainRedGate reads, which every landing
 * seeds green for the SHA it moved main to, so the common case is a cache hit. A miss (or a
 * provisional red from another worktree) runs the declared check once here, bounded by its
 * timeout. A red is warned fleet-wide once per SHA, exactly as mainRedGate warns it. Never
 * throws: an unreadable main, a checkout that fails, no declared check on main, or a skipped
 * run all read as `unavailable`. */
export function mainTipVerdict(
  root: string,
  role: string,
  mainBranch: string,
  config: TumwaterConfig,
): Promise<MainTipVerdict> {
  const run = gateMainQueue.then(() => verdictAtMainTip(root, role, mainBranch, config));
  gateMainQueue = run.catch(() => undefined);
  return run;
}

async function verdictAtMainTip(
  root: string,
  role: string,
  mainBranch: string,
  config: TumwaterConfig,
): Promise<MainTipVerdict> {
  try {
    const tip = await gitTry(root, "rev-parse", mainBranch);
    if (!tip) return { status: "unavailable", why: `${mainBranch} is unreadable` };
    const wt = await ensureDetachedWorktree(root, gateMainWorktreePath(root), tip);
    const check = await checkMainBaseline(wt, config, baselineCheckLogger(root, role));
    const baseline = check.baseline;
    if (baseline?.status === "green") return { status: "green", sha: baseline.sha };
    if (baseline?.status === "red") {
      warnMainRedOnce(root, baseline);
      return { status: "red", sha: baseline.sha };
    }
    return {
      status: "unavailable",
      why: check.skipReason ? `its check was skipped (${check.skipReason})` : "it declares no check",
    };
  } catch (err) {
    return { status: "unavailable", why: errorMessage(err) };
  }
}
