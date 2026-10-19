// vocabulary: plain
import { baselineBlocked, BUGFIX_ROLE } from "../roles/roles.js";
import { baseRoleOf } from "../roles/runner-ids.js";
import { enqueueRolePrompt } from "../inbox/inbox.js";
import { isCustomRole, liveConfig } from "../config/config.js";
import { BUILD_CHECK_TIMEOUT_MS } from "../build/build-check-detect.js";
import { failureHeadline, FAILING_TESTS_MAX } from "../build/build-check-report.js";
import { baselineCheckEventLogger, buildCheckSkipWarning, sleptPhrase, type BaselineCheckRun } from "../build/build-check-events.js";
import { checkMainBaseline } from "./main-baseline.js";
import { buildMainRedNote } from "../prompt/gate-prompts.js";
import { logEventBestEffort, warnEventBestEffort, TUMWATER_SOURCE } from "../events/events.js";
import type { TickOutcome } from "../tick/tick-outcome.js";
import type { TumwaterConfig } from "../config/config-schema.js";
import { errorMessage } from "../text/text.js";
import { mainRedPhrase } from "../text/phrases.js";
import { shortSha } from "../text/format.js";
import { branchHead } from "../git/git.js";
import { gateMainWorktreePath } from "../paths.js";
import { useWorktree } from "../git/worktree-use.js";
import { ensureDetachedWorktree } from "../git/worktree.js";

/** Red-main baseline gate for fresh authoring ticks: before an
 * authoring run is spent on top of pristine main, verify that MAIN ITSELF is green — a red main
 * rejects every code diff deterministically at the review gate (BUGS.md's "Build broken on main"
 * and "Tests red on main" entries), so while a SHA is known red the blocked roles skip authoring
 * instead of burning runs that are guaranteed to fail. Split out of runner.ts — which keeps the
 * tick lifecycle around it — because this is a self-contained policy with its own per-process
 * state (one harness-level `main_red_hold` event AND one queued healer prompt per
 * newly-discovered red SHA) and its own
 * event contract; what it borrows from the loop is identity and the role's worktree, and it
 * consumes
 * build/build-check.ts's checkMainBaseline machinery (detection + execution + per-SHA cache),
 * which stays unaware of ticks. */

/** The last main SHA for which this process logged a red-main hold event (the baseline check): one
 * harness-level warning per newly-discovered red SHA, not one per blocked role's tick —
 * module-level so every runner in the team shares it. A restart re-logs once: the cache is cold
 * then too, and an operator restarting into a still-red main should see why nothing merges. */
let lastMainRedSha: string | null = null;

/** The key of the last failing set the healer was sent a prompt for: the sorted failing test
 * names, or the red SHA when the red names none. Two red commits with the same failing set send
 * one heal prompt, not one per commit; a green main observed by the gate or the bugfix handoff
 * clears it, so a set that returns after green is healed again. */
let lastHealKey: string | null = null;

/** The failing tests a red verdict names, when the list is complete — non-empty and short of
 * FAILING_TESTS_MAX, which may have been cut short (the same rule as onlyKnownMainFailures).
 * Empty when it names none: main's red is then not a set of known failures, and the block stays. */
function namedFailures(red: { failingTests?: string[] }): string[] {
  const tests = red.failingTests ?? [];
  return tests.length > 0 && tests.length < FAILING_TESTS_MAX ? tests : [];
}

/** The red-main message's shared spine — the SHA, script, and failure headline a red baseline
 * carries, phrased once so the once-per-SHA warning and the main_red outcome cannot drift apart
 * over what main looks like. `action` is the consequence each caller names. */
function redMainMessage(red: { sha: string; script?: string; outputTail?: string[] }, action: string): string {
  const firstLine = failureHeadline(red.outputTail);
  return `${mainRedPhrase(red.sha)} (${red.script}${firstLine ? `: ${firstLine}` : ""}) — ${action}`;
}

/** Log the team-wide `main_red_hold` event (the notify hook pages it) for `red`'s SHA at
 * most once per process, and hand the red suite to the healer. Module-level (with
 * lastMainRedSha) so the gate and the bugfix handoff share one guard: whichever observes the
 * red first logs it, the other stays silent. `foundBy` is the role whose path verified the
 * red — when that role is not bugfix itself, one prompt is enqueued to bugfix's own inbox so
 * the healer ticks on the orchestrator's next poll instead of waiting out its own interval or
 * deferral; bugfix finding its own red skips the enqueue because its running tick already
 * carries the note and IS the heal (and enqueuing from inside it would queue a second run). A
 * queued per-role prompt makes the loop due by itself (`isEligible`, scheduling.ts, returns
 * `{ run: true, reason: "inbox" }` on a non-empty inbox before any interval, backoff, or
 * deferral check), and `pollRunnerReasons` skips the need-based deferral block for reason
 * `inbox`, so no scheduler change is needed. */
function warnMainRedOnce(
  root: string,
  red: { sha: string; script?: string; outputTail?: string[]; failingTests?: string[] },
  foundBy: string,
): void {
  if (lastMainRedSha === red.sha) return;
  lastMainRedSha = red.sha;
  const named = namedFailures(red);
  logEventBestEffort(root, {
    source: TUMWATER_SOURCE,
    type: "main_red_hold",
    sha: red.sha,
    script: red.script,
    message:
      named.length > 0
        ? `${mainRedPhrase(red.sha)} (${named.length} failing tests); changes that add no new failures still merge`
        : redMainMessage(red, "code merges blocked until main is green"),
  });
  // Bugfix is the only repairer, and it is exempt from mainRedGate — but it is a work role
  // that with no open bugs defers like a maintenance role, so a red main discovered by any
  // other path could sit unrepaired until bugfix's own interval or a coincidental wake.
  // Queue the heal: one prompt per newly-verified red SHA per process (a restart re-queues
  // once, desirable because the cache is cold then too). With named failures the key is the
  // failing set, so a second red commit with the same failures queues nothing.
  const healKey = named.length > 0 ? [...named].sort().join("\n") : red.sha;
  if (lastHealKey === healKey) return;
  lastHealKey = healKey;
  if (baseRoleOf(foundBy) !== BUGFIX_ROLE) {
    enqueueRolePrompt(root, BUGFIX_ROLE, mainRedHealPrompt(red.sha));
  }
}

/** The one-line, self-limiting directive queued for the bugfix healer when a non-bugfix path
 * newly verifies a red main. It names the short SHA the check was reported red at, tells the
 * healer to verify main is green now, and to reproduce and land the fix only if it is still
 * red. The self-limiting wording is the green race's whole handling: if main turned green
 * before the healer consumes the prompt, bugfixMainRedNote returns undefined (no `<main-red>`
 * note is appended) and the "verify green" clause makes the tick a no-op. */
export function mainRedHealPrompt(
  sha: string,
  detail?: { culprit: string; failingTests: readonly string[]; outputTail?: readonly string[] },
): string {
  const base = `Main was reported red at commit ${shortSha(sha)}. Verify main is green now; if it is still red, reproduce the failure and land the fix.`;
  if (!detail) return base;
  const tests = detail.failingTests.length > 0 ? ` Failing: ${detail.failingTests.join("; ")}.` : "";
  const tail = detail.outputTail && detail.outputTail.length > 0 ? ` Output tail: ${detail.outputTail.join(" | ")}` : "";
  return `${base} The watch named ${shortSha(detail.culprit)} as the commit that turned it red.${tests}${tail}`;
}

/** Queue the heal prompt for bugfix with the culprit's detail: the fallback when the automatic
 * revert (src/baseline/main-revert.ts) is skipped or fails. */
export function queueCulpritHeal(
  root: string,
  tip: string,
  detail: { culprit: string; failingTests: readonly string[]; outputTail?: readonly string[] },
): void {
  enqueueRolePrompt(root, BUGFIX_ROLE, mainRedHealPrompt(tip, detail));
}

/** checkMainBaseline's per-run hook: log the one run per SHA (cache misses only) under the role
 * that paid for it, with its duration — the gate's build_check sibling, so both halves of the
 * team's deterministic verification are priced in the feed. The one logger for every baseline
 * check this module runs — the bugfix handoff, the authoring gate, and mainTipVerdict's tip
 * check (which review.ts's gate and merge-check-failures.ts's attributeRedCheck reach
 * through it) — so the event's shape cannot drift between them. */
export function baselineCheckLogger(
  root: string,
  role: string,
): (run: BaselineCheckRun) => void {
  return baselineCheckEventLogger(role, (event) => logEventBestEffort(root, event));
}

/** Red-main handoff for the `bugfix` healer: mainRedGate exempts
 * bugfix so the only role that can unblock the team may author, but its prompt then starts from
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
  if (red?.status === "green") lastHealKey = null;
  if (red?.status !== "red") return undefined;
  warnMainRedOnce(root, red, role);
  return buildMainRedNote(red.sha, red.script, failureHeadline(red.outputTail), red.outputTail);
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
  /** Called with main's failing tests when the red names them: the role then runs on the red
   * main instead of ending `main_red`, and the caller puts them in its prompt. */
  onKnownRed?: (failingTests: string[]) => void,
): Promise<TickOutcome | null> {
  // User-defined loops are blocked alongside the built-in code roles (plans/user-defined-loops.md):
  // an unknown charter may produce code, and on red main such diffs are rejected deterministically
  // at the gate's pre-check — an authoring run would be pure waste. Customs come from
  // tumwater.json, not the catalog, so read the live config (stat-cached; a broken file
  // degrades to defaults, which know no customs).
  const cfg = liveConfig(root);
  if (!baselineBlocked(role) && !isCustomRole(cfg, role)) return null;
  const baseline = await checkMainBaseline(wt, cfg, baselineCheckLogger(root, role), false, false, sampleSleep);
  if (baseline.unverified) {
    // The baseline run spanned a host sleep: no verdict about main, nothing cached (BUGS.md
    // 2026-09-30). Warn-and-proceed, like a skip — the sleep is named, not a test failure.
    warnEventBestEffort(
      root,
      role,
      sleptPhrase("main baseline check", baseline.run?.sleptMs ?? 0, "proceeding with authoring unverified"),
    );
    return null;
  }
  if (baseline.skipReason) {
    warnEventBestEffort(
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
    warnMainRedOnce(root, red, role);
    const named = namedFailures(red);
    if (named.length > 0) {
      onKnownRed?.(named);
      return null;
    }
    return {
      result: "main_red",
      summary: "code merges blocked until main is green",
      // The cause rides the outcome so the tick's `run_end` carries it
      // (tick-finalize.ts folds it into state.lastError before logging): the digest itemizes
      // the outcome that blocks every merge, instead of leaving it a bare count behind a
      // once-per-SHA warning (BUGS.md 2026-09-28).
      error: redMainMessage(red, "authoring skipped until main is green"),
    };
  }
  if (baseline.baseline?.status === "green") lastHealKey = null;
  return null;
}

/** What the review gate learns about main's current tip when a change's check failed twice
 * (mainTipVerdict): `green` — main passes (observed by a run on this tree, never inherited), so
 * the change broke the check; `red` — main fails
 * too, so the failure is not the change's and this module's gate and bugfix handoff own the
 * repair; `unavailable` — no verdict could be had, with `why` for the rejection's reasons. */
type MainTipVerdict =
  | { status: "green"; sha: string }
  | { status: "red"; sha: string }
  | { status: "unavailable"; why: string };

/** Serializes mainTipVerdict's use of its one worktree: the merge pipeline's verifies run their
 * gates concurrently, and a second gate re-pointing the checkout at a newer main while the first's
 * check ran in it would measure a tree that is neither. Each link is bounded — a few git commands
 * plus at most one check run, which runBuildCheck kills at its timeout — and takes no other lock,
 * so a waiter waits at most for the gates queued ahead of it. */
let gateMainQueue: Promise<unknown> = Promise.resolve();

/** Main's baseline verdict at its current tip, for attributing a gate check that failed twice
 * (src/review/review.ts): gateMainWorktreePath is re-pointed at `mainBranch`'s tip and asked
 * through checkMainBaseline — the same per-SHA, team-wide cache mainRedGate reads, which every
 * merge seeds green for the SHA it moved main to, so the common case is a cache hit. A miss (or a
 * provisional red from another worktree, or a green that was only inherited across doc commits)
 * runs the declared check once here, bounded by its timeout. A red is warned team-wide once per
 * SHA, exactly as mainRedGate warns it. Never throws: an unreadable main, a checkout that fails, no
 * declared check on main, or a skipped run all read as `unavailable`.
 *
 * `forceFresh` bypasses that per-SHA cache and runs main's declared check now, even over a cached
 * green (checkMainBaseline's forceFresh): the review gate needs it to re-attribute a repeated gate
 * failure on a clock- or load-sensitive test whose cached green has gone stale (BUGS.md
 * 2026-10-06). The merge pipeline's attribution reads the cached verdict instead. */
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

/** Run `fn` in the `_gate-main` mirror re-pointed at `mainBranch`'s tip, queued behind the gates
 * mainTipVerdict serves (gateMainQueue) and holding the mirror as they do. The main watch's way in
 * (main-watch.ts): it hands `fn` the checkout and the tip it holds. Rejects when main is
 * unreadable or the checkout fails — the caller is a background task that must catch. */
export function withMainTipWorktree<T>(
  root: string,
  mainBranch: string,
  fn: (wt: string) => Promise<T>,
): Promise<T> {
  const run = gateMainQueue.then(() =>
    useWorktree(root, gateMainWorktreePath(root), async () => {
      const tip = await branchHead(root, mainBranch);
      if (!tip) throw new Error(`${mainBranch} is unreadable`);
      return fn(await ensureDetachedWorktree(root, gateMainWorktreePath(root), tip));
    }),
  );
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
    // observedOnly: this verdict convicts or clears a change, so a green carried over doc commits
    // does not count (main-baseline.ts's inheritedGreen). A doc edit can break a test that reads
    // the docs, and then the change would be rejected for main's failure.
    const check = await checkMainBaseline(wt, config, baselineCheckLogger(root, role), false, forceFresh, undefined, true);
    const baseline = check.baseline;
    if (baseline?.status === "green") return { status: "green", sha: baseline.sha };
    if (baseline?.status === "red") {
      warnMainRedOnce(root, baseline, role);
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
