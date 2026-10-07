import { BASELINE_BLOCKED_ROLES } from "../roles/roles.js";
import { isCustomRole, liveConfig } from "../config/config.js";
import { BUILD_CHECK_TIMEOUT_MS } from "../build/build-check-detect.js";
import { failureHeadline } from "../build/build-check-report.js";
import { baselineCheckEventLogger, buildCheckSkipWarning, sleptPhrase, type BaselineCheckRun } from "../build/build-check-events.js";
import { checkMainBaseline } from "./main-baseline.js";
import { buildMainRedNote } from "../gates/gate-prompts.js";
import { logEvent, warnEvent } from "../events/events.js";
import type { TickOutcome } from "../tick/tick-outcome.js";
import type { TumwaterConfig } from "../config/config-schema.js";
import { errorMessage } from "../text/text.js";
import { mainRedPhrase } from "../text/phrases.js";
import { branchHead } from "../git/git.js";
import { gateMainWorktreePath } from "../paths.js";
import { useWorktree } from "../git/worktree-use.js";
import { ensureDetachedWorktree } from "../git/worktree.js";

/** Red-main baseline gate for fresh authoring ticks (PLANS.md "Red-main baseline check"):
 * before an authoring run is spent on top of pristine main, verify that MAIN ITSELF is green —
 * a red main rejects every code diff deterministically at the review gate (BUGS.md's "Build
 * broken on main" and "Tests red on main" entries), so while a SHA is known red the blocked
 * roles skip authoring instead of burning runs that are guaranteed to fail. Split out of loop.ts —
 * which keeps the tick lifecycle around it — because this is a self-contained policy with its own
 * per-process state (one harness-level warning per newly-discovered red SHA) and its own event
 * contract; what it borrows from the loop is identity only, and it consumes build/build-check.ts's
 * checkMainBaseline machinery (detection + execution + per-SHA cache), which stays unaware of
 * ticks. */

/** The last main SHA for which this process logged a red-main warning (the baseline check):
 * one harness-level warning per newly-discovered red SHA, not one per blocked role's tick —
 * module-level so every runner in the fleet shares it. A restart re-logs once: the cache is
 * cold then too, and an operator restarting into a still-red main should see why nothing lands. */
let lastMainRedSha: string | null = null;

/** The red-main message's shared spine — the SHA, script, and failure headline a red baseline
 * carries, phrased once so the once-per-SHA warning and the main_red outcome cannot drift apart
 * over what main looks like. `action` is the consequence each caller names. */
function redMainMessage(red: { sha: string; script?: string; outputTail?: string[] }, action: string): string {
  const firstLine = failureHeadline(red.outputTail);
  return `${mainRedPhrase(red.sha)} (${red.script}${firstLine ? `: ${firstLine}` : ""}) — ${action}`;
}

/** Log the fleet-wide red-main warning for `red`'s SHA at most once per process. Module-level
 * (with lastMainRedSha) so the gate and the bugfix handoff share one guard: whichever observes
 * the red first logs it, the other stays silent. */
function warnMainRedOnce(root: string, red: { sha: string; script?: string; outputTail?: string[] }): void {
  if (lastMainRedSha === red.sha) return;
  lastMainRedSha = red.sha;
  warnEvent(root, "harness", redMainMessage(red, "code merges blocked until main is green"));
}

/** checkMainBaseline's per-run hook: log the one run per SHA (cache misses only) under the role
 * that paid for it, with its duration — the gate's build_check sibling, so both halves of the
 * fleet's deterministic verification are priced in the feed. The one logger for every baseline
 * check this module runs — the bugfix handoff, the authoring gate, and mainTipVerdict's
 * tip check (which review.ts's gate and landing-check-failures.ts's attributeRedCheck reach through it) —
 * so the event's shape cannot drift between them. */
function baselineCheckLogger(
  root: string,
  role: string,
): (run: BaselineCheckRun) => void {
  return baselineCheckEventLogger(role, (event) => logEvent(root, event));
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
  const config = liveConfig(root);
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
export async function mainRedGate(
  root: string,
  role: string,
  wt: string,
  /** The sleep clock the baseline run measures host suspension with; defaults to the real
   * sampleSleepClock. A test seam — production callers leave it unset. */
  sampleSleep?: Parameters<typeof checkMainBaseline>[5],
): Promise<TickOutcome | null> {
  // User-defined loops are blocked alongside the built-in code roles (plans/user-defined-loops.md):
  // an unknown charter may produce code, and on red main such diffs are rejected deterministically
  // at the gate's pre-check — an authoring run would be pure waste. Customs come from tumwater.json,
  // not the catalog, so read the live config (stat-cached; a broken file degrades to defaults,
  // which know no customs).
  const cfg = liveConfig(root);
  if (!BASELINE_BLOCKED_ROLES.has(role) && !isCustomRole(cfg, role)) return null;
  const baseline = await checkMainBaseline(wt, cfg, baselineCheckLogger(root, role), false, false, sampleSleep);
  if (baseline.unverified) {
    // The baseline run spanned a host sleep: no verdict about main, nothing cached (BUGS.md
    // 2026-09-30). Warn-and-proceed, like a skip — the sleep is named, not a test failure.
    warnEvent(
      root,
      role,
      sleptPhrase("main baseline check", baseline.run?.sleptMs ?? 0, "proceeding with authoring unverified"),
    );
    return null;
  }
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
    const red = baseline.baseline;
    warnMainRedOnce(root, red);
    return {
      result: "main_red",
      summary: "code merges blocked until main is green",
      // The cause rides the outcome so the tick's `tick_end` carries it (loop.ts folds it into
      // state.lastError before logging): the digest itemizes the outcome that blocks every
      // merge, instead of leaving it a bare count behind a once-per-SHA warning (BUGS.md
      // 2026-09-28).
      error: redMainMessage(red, "authoring skipped until main is green"),
    };
  }
  return null;
}

/** What the review gate learns about main's current tip when a change's check failed twice
 * (mainTipVerdict): `green` — main passes, so the change broke the check; `red` — main fails
 * too, so the failure is not the change's and this module's gate and bugfix handoff own the
 * repair; `unavailable` — no verdict could be had, with `why` for the rejection's reasons. */
type MainTipVerdict =
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
 * (src/review/review.ts): gateMainWorktreePath is re-pointed at `mainBranch`'s tip and asked through
 * checkMainBaseline — the same per-SHA, fleet-wide cache mainRedGate reads, which every landing
 * seeds green for the SHA it moved main to, so the common case is a cache hit. A miss (or a
 * provisional red from another worktree) runs the declared check once here, bounded by its
 * timeout. A red is warned fleet-wide once per SHA, exactly as mainRedGate warns it. Never
 * throws: an unreadable main, a checkout that fails, no declared check on main, or a skipped
 * run all read as `unavailable`.
 *
 * `forceFresh` bypasses that per-SHA cache and runs main's declared check now, even over a
 * cached green (checkMainBaseline's forceFresh): the review gate needs it to re-attribute a
 * repeated gate failure on a clock- or load-sensitive test whose cached green has gone stale
 * (BUGS.md 2026-10-06). The landing pipeline's attribution reads the cached verdict instead. */
export function mainTipVerdict(
  root: string,
  role: string,
  mainBranch: string,
  config: TumwaterConfig,
  forceFresh = false,
): Promise<MainTipVerdict> {
  const run = gateMainQueue.then(() => verdictAtMainTip(root, role, mainBranch, config, forceFresh));
  gateMainQueue = run.catch(() => undefined);
  return run;
}

async function verdictAtMainTip(
  root: string,
  role: string,
  mainBranch: string,
  config: TumwaterConfig,
  forceFresh: boolean,
): Promise<MainTipVerdict> {
  // Hold the `_gate-main` mirror from before ensureDetachedWorktree (its reset is part of the
  // use) through the baseline check (plans/disk-floor.md, part 2/4).
  return useWorktree(root, gateMainWorktreePath(root), () =>
    verdictAtMainTipIn(root, role, mainBranch, config, forceFresh),
  );
}

async function verdictAtMainTipIn(
  root: string,
  role: string,
  mainBranch: string,
  config: TumwaterConfig,
  forceFresh: boolean,
): Promise<MainTipVerdict> {
  try {
    const tip = await branchHead(root, mainBranch);
    if (!tip) return { status: "unavailable", why: `${mainBranch} is unreadable` };
    const wt = await ensureDetachedWorktree(root, gateMainWorktreePath(root), tip);
    const check = await checkMainBaseline(wt, config, baselineCheckLogger(root, role), false, forceFresh);
    const baseline = check.baseline;
    if (baseline?.status === "green") return { status: "green", sha: baseline.sha };
    if (baseline?.status === "red") {
      warnMainRedOnce(root, baseline);
      return { status: "red", sha: baseline.sha };
    }
    return {
      status: "unavailable",
      why: check.skipReason
        ? `its check was skipped (${check.skipReason})`
        : check.unverified
          ? "its check ran while the host slept mid-run"
          : "it declares no check",
    };
  } catch (err) {
    return { status: "unavailable", why: errorMessage(err) };
  }
}
