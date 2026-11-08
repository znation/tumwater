import { distinctOrdered } from "../collections.js";
import { baselineCache, checkMainBaseline, commitsAboveFullGreen, firstParentWalk, INHERIT_WALK_MAX, settleRedByRerun } from "./main-baseline.js";
import { canRerun, rerunTests } from "../build/build-check-rerun.js";
import { baselineCheckLogger, clearHealKeyOnGreen, dropHealPromptsCoveredBy, withFullMainTipWorktree, withMainTipWorktree } from "./main-red.js";
import { CHECK_TIER } from "../concurrency/check-permit.js";
import { FAILING_TESTS_MAX } from "../build/build-check-report.js";
import { detectBuildCheck } from "../build/build-check-detect.js";
import { git, gitTry } from "../git/git-run.js";
import { gitLines } from "../git/git.js";
import { logEventBestEffort, TUMWATER_SOURCE } from "../events/events.js";
import type { TumwaterConfig } from "../config/config-schema.js";
import { errorMessage } from "../text/text.js";
import { fileQuarantineBugsOnMain } from "../backlog/backlog-file-bugs.js";
import { closeQuietBugWaitsOnMain } from "../backlog/backlog-bug-waits.js";
import { BUGFIX_WAIT_QUIET_DAYS } from "../roles/role-guidance.js";
import {
  loadQuarantine,
  markQuarantineFiled,
  onlyQuarantined,
  quarantinedTests,
  quarantineTests,
  releaseQuarantine,
} from "../review/known-flakes.js";
import { shortSha } from "../text/format.js";
import { treeDiffFiles } from "../git/git-diff.js";
import { mergingRoleOf } from "../events/event-read.js";
import { isExemptDiff } from "../review/exemptions.js";
import { diffRuleReasons } from "../review/diff-rules.js";

/** What the main watch hands to `onCulprit` for a red tip: the red head it was found at (`tip`)
 * and the failing tests that made it red — exactly the fields ci's red-main heal prompt needs
 * (src/baseline/main-red.ts mainRedHealPrompt). `commit` is the culprit itself — the commit that
 * OPENED the red (by bisecting the first-parent commits since the last full green and re-running
 * only those tests, part 3a/4; never a doc-exempt tip, which cannot have changed the suite) —
 * not the newest red tip, so re-naming the tip as culprit would blame a merge that did not break
 * the check in the G1 phrase and the heal prompt. Forward, never back, part 4/6: a red main
 * heals forward and is never reverted, so this holds nothing a revert would need. */
interface MainCulprit {
  commit: string;
  failingTests: string[];
  /** The file each failing test lives in, when the failure output named it — what the heal
   * prompt's re-run of only those tests selects files by. */
  failingTestFiles?: Record<string, string>;
  tip: string;
}

/** checkMainBaseline's result and its baseline verdict, derived from the imported check (the
 * baseline interfaces are not exported from main-baseline.ts). */
type BaselineCheck = Awaited<ReturnType<typeof checkMainBaseline>>;
type MainBaseline = NonNullable<BaselineCheck["baseline"]>;

/** The main_check event payload for a settled verdict: the baseline sha and status, the run
 * duration (0 when nothing ran), the covered-commit count, and, on a red, the failing tests and
 * the quarantined-only marker. */
function mainCheckEvent(
  baseline: MainBaseline,
  red: boolean,
  quarantined: readonly string[] | null,
  covered: number,
  durationMs: number,
  /** The commit the red is attributed to: the opener of a freshly-opened red spell (redOpener),
   * which differs from the checked tip only when the tip is doc-exempt; undefined otherwise.
   * A green or a re-check of an open spell keeps the tip (baseline.sha). */
  sha?: string,
  /** True when this pass cleared an open red by re-running only its failing tests (part 3b/4):
   * a `{ status: "passed", cleared: true }` main_check with ran=false — no full verdict is
   * written, so the hour's anchor stays the last real full verdict and redeployTarget does not
   * target the cleared head until the confirming full run lands. */
  cleared = false,
): {
  source: typeof TUMWATER_SOURCE;
  type: "main_check";
  sha: string;
  status: "failed" | "passed";
  durationMs: number;
  covered: number;
  failingTests?: string[];
  quarantined?: readonly string[];
  cleared?: boolean;
  inherited?: boolean;
} {
  return {
    source: TUMWATER_SOURCE,
    type: "main_check",
    sha: sha ?? baseline.sha,
    status: red ? "failed" : "passed",
    durationMs,
    covered,
    ...(red ? { failingTests: baseline.failingTests ?? [] } : {}),
    ...(quarantined ? { quarantined } : {}),
    ...(cleared ? { cleared: true } : {}),
    ...(baseline.inheritedFrom !== undefined ? { inherited: true } : {}),
  };
}

/** The main watch: after main's head moves, run the full check on the new tip in its own
 * `_main-full` mirror and record the verdict — a `main_check` event, and the failing tests on the
 * red baseline (which persists beside the greens). The watch checks every new red tip, but the
 * CULPRIT for an ongoing red is the commit that opened it — the first red tip since the last green:
 * a doc-exempt tip that lands after the red opened cannot have changed the suite, so re-naming it
 * would blame a merge that did not break the check in the G1 phrase and ci's heal prompt. On a red
 * tip it logs a `main_culprit` event naming the opener (with its merging runner when a recent
 * merged event names one), and a green closes the spell, so the next red names its own opener. No
 * run, gate or merge waits on it; the culprit goes to the optional `onCulprit` callback, which the
 * orchestrator wires to ci's heal prompt (Forward, never back, part 4/6): a red main is healed
 * forward, never reverted. The opener a fresh red names is bisected (part 3a/4): the oldest
 * first-parent commit above the newest full green at which re-running only the failing tests
 * still fails.
 *
 * One watch run is in flight at a time, and it covers every commit since the last watched head;
 * a head that moves during a run is watched next. The full check runs at most once per
 * `check.fullIntervalMinutes` (default 60), on main's latest tip, and only while a non-exempt
 * code commit sits above the newest verdict a full check actually produced — `checkedAt` (part
 * 2a/4) is the age; a doc-only range inherits green and starts no run; a verdict without
 * `checkedAt` reads as due now; `0` restores one full run per new code head. The diff rules run on
 * every new head either way, and a red is confirmed once before it is final — by re-running only
 * its failing tests when it can (build-check-rerun.ts), else the whole check again
 * (`reverifyRed`). The check queues at the merge tier of the check permits.
 *
 * The two passes run in separate mirrors (Hourly full check, part 2c/4): the per-head diff-rules
 * pass runs in the shared `_gate-main` mirror (withMainTipWorktree), and the full-check pass runs
 * in its own `_main-full` mirror (withFullMainTipWorktree) on its own queue, so a rules pass or a
 * gate's main-tip verdict never waits behind a full run. `poll` starts each pass independently and
 * `idle()` waits for both, plus housekeeping. */
interface MainWatch {
  /** Look at main's head; starts a background watch run when it is unwatched and none is in
   * flight. `held` (a restart pending, or the disk hold) starts nothing; `config` is the live
   * one. Never throws, never waits for the run. */
  poll(mainHead: string, held: boolean, config: TumwaterConfig): void;
  /** Resolves when no watch run is in flight — a test seam. */
  idle(): Promise<void>;
}

/** The failing tests of each root's newest watch verdict, keyed by root. */
const knownFailures = new Map<string, string[]>();

/** Each root's open red spell (Hourly full check, part 3b/4): the commit that OPENED the red —
 * the tip of the first red verdict since the last green — and the failing tests STILL open on
 * the newest red tip. The open set starts from the confirmed red's tests and narrows as a later
 * head's re-run shows tests passing, so a healed test leaves the set (and `knownMainFailures`)
 * before the whole set clears. The opener stays the named culprit while the spell is open: a
 * later tip re-checks only the open set and never re-attributes. A green verdict clears the
 * whole entry, so a red that opens after a green names its own opener. In-memory only: a
 * restart mid-red loses the spell's opener, and the next settled red tip then names itself as
 * culprit — the pre-fix behaviour, and a bounded one (one tip per restart, since a spell's
 * later tips inherit the red and settle without a re-run). */
interface OpenRedSpell {
  opener: string;
  tests: string[];
  /** The file each open test lives in, from the latest red baseline that named it — what a
   * re-run of only those tests selects files by (build-check-rerun.ts). Red only; absent when
   * the output named no file or a previous re-run dropped it. */
  files?: Readonly<Record<string, string>>;
}
const redSpellOpeners = new Map<string, OpenRedSpell>();

/** The open failing tests of `root`'s red spell: empty when no spell is open (a green, or none
 * ever opened). A red's <main-known-red> note reads this so a test a later head showed passing
 * leaves the set while the spell is still open. */
function openRedTests(root: string): string[] {
  return redSpellOpeners.get(root)?.tests ?? [];
}

/** Main's known failures: while a red spell is open, the spell's remaining open failing tests —
 * narrowed on every new head by re-running only them, so a test a later head showed passing
 * stops being named before the whole red clears (part 3b/4). With no spell open, the failing
 * tests of the watch's newest verdict (the knownFailures map). Either way plus every quarantined
 * flaky test (review/known-flakes.ts). Empty when the verdict is green, red with no parsed test,
 * or none has been recorded yet in this process, and nothing is quarantined. */
export function knownMainFailures(root: string): string[] {
  const open = openRedTests(root);
  const base = open.length > 0 ? open : (knownFailures.get(root) ?? []);
  return distinctOrdered([...base, ...quarantinedTests(root)]);
}

/** The failing tests of a failed check when every one of them is a known main failure; null when
 * the output names no test, any test is outside the known set, or none is known. A list at
 * FAILING_TESTS_MAX may have been cut short, so it never counts as complete. */
export function onlyKnownMainFailures(root: string, failingTests: readonly string[] | undefined): string[] | null {
  if (!failingTests || failingTests.length === 0 || failingTests.length >= FAILING_TESTS_MAX) return null;
  const known = new Set(knownMainFailures(root));
  return failingTests.every((t) => known.has(t)) ? [...failingTests] : null;
}

export function createMainWatch(
  root: string,
  mainBranch: string,
  onCulprit?: (culprit: MainCulprit) => void,
  /** The clock the full check's due decision reads (Hourly full check, part 2b/4); defaults to
   * the real wall clock. Tests advance it to cross the interval. The `checkedAt` stamp a full
   * run carries stays real time (part 2a/4). */
  now: () => number = Date.now,
): MainWatch {
  let lastWatched: string | undefined;
  /** While a full check is suspended for the interval (part 2b/4), the clock time it becomes
   * due again. `lastWatched` still advances to the tip, so repeat polls of the same head do
   * nothing until this time passes — no duplicate diff-rule warnings every poll — and the poll
   * that crosses it starts the full check on the latest tip. */
  let fullCheckDueAt: number | undefined;
  /** The anchor a suspended full check must cover from: the newest full verdict the interval is
   * measured from. It overrides `lastWatched` for the covered-commit count when the check finally
   * runs, so the event reports every commit the skip passed over. */
  let fullCheckBase: string | undefined;
  let rulesInFlight: Promise<void> | null = null;
  let fullInFlight: Promise<void> | null = null;
  /** The newest head for which the rules pass has been started, independent of the full pass's
   * `lastWatched`: a rules pass that was busy when a head arrived must still judge that head. */
  let lastRulesWatched: string | undefined;
  let housekeeping: Promise<void> | null = null;
  let lastFilingWarning = "";
  let lastCloseWarning = "";
  /** The head a "main watch could not check main" warning was last logged for: the rules pass
   * and the full pass fail independently, and a broken main must not warn twice for one head. */
  let lastFailedWatchHead: string | undefined;

  /** Release quarantined tests whose bug left `## Open`, file the bugs of newly quarantined
   * ones on main — recording a filed test's new flake under its bug when that bug waits for one —
   * and close the bugs whose bugfix wait went quiet (backlog-bug-waits.ts). A write the primary
   * checkout cannot take warns (once per reason) and is retried on a later poll. Never throws. */
  async function settleQuarantine(): Promise<void> {
    try {
      const released = releaseQuarantine(root);
      if (released.length > 0) {
        logEventBestEffort(root, {
          source: TUMWATER_SOURCE,
          type: "warning",
          message: `quarantine released ${released.join(", ")}: its BUGS.md entry is no longer open`,
        });
      }
      await filePendingQuarantine();
      await closeQuietWaits();
    } catch (err: unknown) {
      logEventBestEffort(root, {
        source: TUMWATER_SOURCE,
        type: "warning",
        message: `quarantine housekeeping failed: ${errorMessage(err)}`,
      });
    }
  }

  /** File the quarantined tests no bug has heard of yet: new ones, and filed ones marked
   * `recurred`. */
  async function filePendingQuarantine(): Promise<void> {
    const pending = loadQuarantine(root).filter((e) => e.bug === "" || e.recurred === true);
    if (pending.length === 0) return;
    const outcome = await fileQuarantineBugsOnMain(root, pending);
    if (outcome.status === "filed") {
      markQuarantineFiled(root, outcome.bugs);
      lastFilingWarning = "";
      return;
    }
    if (outcome.reason !== lastFilingWarning) {
      lastFilingWarning = outcome.reason;
      logEventBestEffort(root, {
        source: TUMWATER_SOURCE,
        type: "warning",
        message: `quarantined flaky tests are not filed in BUGS.md yet: ${outcome.reason}`,
      });
    }
  }

  /** Close the bugs whose bugfix wait saw no recurrence for BUGFIX_WAIT_QUIET_DAYS, naming them in
   * one warning; a close the primary checkout cannot take warns once per reason. */
  async function closeQuietWaits(): Promise<void> {
    const outcome = await closeQuietBugWaitsOnMain(root);
    if (outcome.status === "closed") {
      lastCloseWarning = "";
      logEventBestEffort(root, {
        source: TUMWATER_SOURCE,
        type: "warning",
        message:
          `closed ${outcome.titles.join("; ")}: its bugfix wait saw no recurrence in ` +
          `${BUGFIX_WAIT_QUIET_DAYS} days`,
      });
      return;
    }
    if (outcome.status === "skipped" && outcome.reason !== lastCloseWarning) {
      lastCloseWarning = outcome.reason;
      logEventBestEffort(root, {
        source: TUMWATER_SOURCE,
        type: "warning",
        message: `bugs whose bugfix wait went quiet are not closed yet: ${outcome.reason}`,
      });
    }
  }

  /** The shared settlement helpers, captured once per watch so the rules pass and the full-check
   * pass (Hourly full check, part 2c/4) settle a verdict identically. */
  /** Run the declared build check on main's tip, confirming a red once and quarantining a flake
   * whose confirmation passes. A red whose failing tests can be re-run on their own (canRerun) is
   * confirmed by re-running just those tests, so the full check runs once per tip: a test that
   * passes there is quarantined, and the red narrows to the tests that failed again (or turns
   * green when none did). A re-run that reaches no verdict leaves the first red standing. Without
   * a re-run command the whole check runs again, as before. Returns the check's result and
   * whether any full run actually executed (false for a cache hit, a skip, or a sleep-spanned
   * run). `config` is the live one at the moment of the run. */
  async function runBaselineCheck(wt: string, config: TumwaterConfig): Promise<{ check: BaselineCheck; ran: boolean }> {
    let ran = false;
    const onRun = baselineCheckLogger(root, TUMWATER_SOURCE);
    const hook: typeof onRun = (run) => {
      ran = true;
      onRun(run);
    };
    let check = await checkMainBaseline(wt, config, hook, false, false, undefined, false, CHECK_TIER.merge, true);
    if (check.baseline?.status !== "red") return { check, ran };
    const first = check.baseline;
    const named = first.failingTests ?? [];
    if (canRerun(wt, config, named)) {
      const rerun = await rerunTests(root, TUMWATER_SOURCE, wt, config, named, first.failingTestFiles, CHECK_TIER.merge);
      if (rerun) {
        // Each test that failed and then passed on this same tree is a flake.
        const passed = named.filter((t) => !rerun.failing.includes(t));
        if (passed.length > 0) quarantineTests(root, passed, passed.join("\n"));
        const settled = settleRedByRerun(first.sha, rerun.failing);
        if (settled) check = { baseline: settled };
      }
      return { check, ran };
    }
    check = await checkMainBaseline(wt, config, hook, true, false, undefined, false, CHECK_TIER.merge, true);
    // A red the same tree's confirming re-run turns green is a flake: quarantine its tests.
    if (check.baseline?.status === "green") quarantineTests(root, named, named.join("\n"));
    return { check, ran };
  }

  /** The covered-commit count for a main_check event: the first-parent commits between the
   * previous and new watched heads, or 1 when there is no previous head. */
  async function countCovered(wt: string, previous: string | undefined, sha: string): Promise<number> {
    if (previous === undefined) return 1;
    const counted = Number(((await gitTry(wt, "rev-list", "--first-parent", "--count", `${previous}..${sha}`)) ?? "").trim());
    return Number.isFinite(counted) && counted > 0 ? counted : 1;
  }

  /** Settle the verdict for a checked baseline: distinguish quarantined-only reds, record
   * main's known failures, count the covered commits, and log the main_check event. For a
   * freshly-opened red spell the event's sha is the spell's opener (redOpener), not the tip
   * checked, so G1's "red since <sha>" names the commit that broke the suite; a green or a
   * re-check of an already-open spell keeps the tip. Returns whether the tip settled red (a
   * red naming tests that are not all quarantined). */
  async function recordMainCheck(
    wt: string,
    baseline: MainBaseline,
    previous: string | undefined,
    ran: boolean,
    started: number,
    openerSha?: string,
  ): Promise<boolean> {
    // A red naming only quarantined tests counts as green: no redeploy hold.
    const quarantined = baseline.status === "red" ? onlyQuarantined(root, baseline.failingTests) : null;
    const red = baseline.status === "red" && !quarantined;
    knownFailures.set(root, red ? (baseline.failingTests ?? []) : []);
    const covered = await countCovered(wt, previous, baseline.sha);
    logEventBestEffort(
      root,
      mainCheckEvent(baseline, red, quarantined, covered, ran ? Date.now() - started : 0, red ? openerSha : undefined),
    );
    return red;
  }

  /** The commit that OPENED a settled red: the newest first-parent commit since the previous
   * settled green whose tree is red — the first commit to turn the suite red above that green.
   * The watch checks only the newest tip per poll, so when several commits land in one poll
   * batch and an earlier one broke the suite, the first red is first SEEN at the non-breaker
   * tip (BUGS.md 2026-11-04: the guardrail named the newest red tip instead of the breaker two
   * first-parent commits behind it). To name the actual breaker, walk first-parent commits from
   * the tip back toward the previous green head (`since`), running the declared check on each
   * tree, and return the oldest commit whose tree reads red (a red naming only quarantined
   * tests settles as non-red, so it is a green boundary, not a breaker). A red-only range with
   * no green in the walk — or a missing `since` (no previous head) — returns the oldest red
   * found within the walk's bound (INHERIT_WALK_MAX); a git failure or a skipped (no-verdict)
   * run reads conservative and stops the walk at the newest red it already holds. Never throws. */
  async function redOpener(
    wt: string,
    tip: string,
    since: string | undefined,
    config: TumwaterConfig,
  ): Promise<string> {
    // Newest-first first-parent commits: from `since` (exclusive, the previous green head) to the
    // tip, or the whole walk (newest-first) when there is no previous head to bound it by.
    const raw = since
      ? await gitTry(wt, "rev-list", "--first-parent", `${since}..${tip}`)
      : await gitTry(wt, "rev-list", "--first-parent", `--max-count=${INHERIT_WALK_MAX}`, tip);
    const commits = gitLines(raw);
    if (commits.length === 0) return tip;
    let lastRed: string | undefined;
    try {
      for (const commit of commits) {
        // A checkout that fails reads as no further evidence (never throws, like the walks):
        // stop with the newest red already held rather than check the wrong tree.
        if ((await gitTry(wt, "checkout", "-q", "--detach", "--force", commit)) === null) break;
        const { baseline } = await checkMainBaseline(wt, config, undefined, false, false, undefined, false, CHECK_TIER.merge, true);
        // A red that names only quarantined tests settles as non-red (recordMainCheck), so it is a
        // green boundary here too; counting it as a breaker would name the quarantined commit
        // instead of the later commit that added the real failure.
        const quarantinedOnly =
          baseline?.status === "red" && onlyQuarantined(root, baseline.failingTests) !== null;
        if (baseline?.status === "red" && !quarantinedOnly) {
          lastRed = commit;
          continue;
        }
        // A green, a quarantined-only red, or no verdict (a skipped red-required run): the breaker
        // is the red just above this boundary.
        break;
      }
    } finally {
      // The mirror is shared; put it back on the tip the way the rules pass does. Best effort so
      // a failed restore cannot lose the verdict this walk was only decorating.
      await gitTry(wt, "checkout", "-q", "--detach", "--force", tip);
    }
    return lastRed ?? tip;
  }

  /** Settle a freshly-set red's opener (Hourly full check, part 3a/4): bisect the first-parent
   * commits above the newest full green, re-running only the confirmed failing tests at each
   * candidate in the shared `_gate-main` mirror (withMainTipWorktree), and name the oldest at
   * which they fail. An indecisive bisection — no full green below, a one-commit range, no
   * re-run command, or a candidate whose re-run reaches no verdict — falls back to `redOpener`,
   * which walks the merged batch from `since` (the previous watched head) to the tip and names
   * its oldest red commit, still skipping a doc-exempt tip; a fallback that returns the tip names
   * the checked tip as today. Never throws. */
  async function settleOpener(
    wt: string,
    tip: string,
    since: string | undefined,
    config: TumwaterConfig,
    failingTests: readonly string[],
    files: Readonly<Record<string, string>> | undefined,
  ): Promise<string | undefined> {
    if (!canRerun(wt, config, failingTests)) return redOpener(wt, tip, since, config);
    const candidates = await commitsAboveFullGreen(wt, tip);
    if (candidates.length === 0) return redOpener(wt, tip, since, config);
    const bisected = await withMainTipWorktree(root, mainBranch, async (mirror) =>
      bisectAt(mirror, tip, candidates, config, failingTests, files),
    ).catch(() => undefined);
    return bisected ?? redOpener(wt, tip, since, config);
  }

  /** The bisection body over `candidates` (oldest-first) in `mirror`, which withMainTipWorktree
   * holds at main's tip: binary-search the oldest candidate at which `failingTests` still fail
   * when re-run alone, checking each candidate out in turn and leaving the mirror at main's tip.
   * Undefined when a candidate's re-run reaches no verdict (nothing the bisection can conclude
   * from). Never throws. */
  async function bisectAt(
    mirror: string,
    mainTip: string,
    candidates: readonly string[],
    config: TumwaterConfig,
    failingTests: readonly string[],
    files: Readonly<Record<string, string>> | undefined,
  ): Promise<string | undefined> {
    let lo = 0;
    let hi = candidates.length;
    let found: string | undefined;
    try {
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const commit = candidates[mid]!;
        await git(mirror, "checkout", "-q", "--detach", "--force", commit);
        const rerun = await rerunTests(root, TUMWATER_SOURCE, mirror, config, failingTests, files, CHECK_TIER.merge);
        if (rerun === null) return undefined;
        if (rerun.failing.length > 0) {
          found = commit;
          hi = mid;
        } else {
          lo = mid + 1;
        }
      }
    } finally {
      await git(mirror, "checkout", "-q", "--detach", "--force", mainTip);
    }
    return found;
  }

  /** The per-head pass (Hourly full check, part 2c/4): the deterministic diff rules run in the
   * shared `_gate-main` mirror on every new head, covering every commit since the last watched
   * head. The full check no longer runs here — its own pass (fullPass) owns it in `_main-full` —
   * so a slow full run never holds this mirror behind the gate's main-tip verdicts. `previous`
   * is the newest head the rules pass has already been started for (lastRulesWatched), so a head
   * whose pass was busy when it arrived is still judged once rather than dropped. */
  async function rulesPass(mainHead: string, previous: string | undefined, config: TumwaterConfig): Promise<void> {
    const hasBuildCheck = detectBuildCheck(root, config);
    if (!hasBuildCheck) {
      // No declared build check: nothing to watch for a build red, but the diff rules still run on
      // the tip, and the head counts as watched (the full-check pass never runs here, so it owns
      // no lastWatched either). No suspended full check can be due without a build check.
      lastWatched = mainHead;
      fullCheckDueAt = undefined;
      fullCheckBase = undefined;
    }
    // The deterministic diff rules ("Every commit is verified on main, part 1/3"): run the full
    // five-check set the watch and gate share — the gate now runs only the three a later commit
    // cannot repair — against main's new tip. A rule failure is a deterministic red — it takes no
    // confirming re-run and never quarantines — reported as a warning naming the rule and the
    // head (and each committing role, when a recent merged event names one). It runs on every tip
    // the watch covers in a poll — a build green, a build red, and a head with no verdict (a
    // skipped or sleep-spanned check) or no declared build check at all — because a tip counts as
    // watched (lastWatched) either way, so this is the one chance to judge its diff before the
    // next head moves. The full check no longer runs here — its own pass (fullPass) owns it in
    // `_main-full` — so a slow full run never holds this mirror behind the gate's main-tip
    // verdicts (Hourly full check, part 2c/4).
    let judgedThrough: string | undefined;
    await withMainTipWorktree(root, mainBranch, async (wt) => {
      const tip = await headOf(wt);
      judgedThrough = tip;
      // Judge each first-parent commit in the range by its own diff and its own merged-event role,
      // not the tip's: a multi-commit range's union diff attributed to whichever role merged the
      // tip would report a legitimate director/steward PRINCIPLES.md edit in an intermediate commit
      // as unauthorized by the role that merged later. previous is undefined only before the first
      // watched head, when the range is the tip's own commit.
      //
      // The diff rules read the change's "head" side from the worktree (conflict markers,
      // brief/protected-file content, secrets, backlog structure) against a base revision, so the
      // mirror checkout must sit ON the commit being judged — not on the tip — or an intermediate
      // commit would be compared against the tip's content of its touched files rather than its
      // own. The range is walked oldest-first and ends back on the tip.
      const commits =
        previous === undefined
          ? [tip]
          : gitLines(await gitTry(wt, "rev-list", "--first-parent", "--reverse", `${previous}..${tip}`));
      for (const commit of commits) {
        await git(wt, "checkout", "-q", "--detach", "--force", commit);
        const parent = `${commit}^`;
        const files = (await treeDiffFiles(wt, parent, commit)) ?? [];
        const [ruleReason] = await diffRuleReasons(
          wt,
          parent,
          files,
          mergingRoleOf(root, commit) ?? "",
          isExemptDiff(files, config.review.exemptPaths),
          "watch",
        );
        judgedThrough = commit;
        if (ruleReason !== undefined) {
          logEventBestEffort(root, {
            source: TUMWATER_SOURCE,
            type: "warning",
            message: `main's tip ${shortSha(tip)} fails the diff rules: ${ruleReason}`,
          });
          // A finding stops the walk mid-range; put the mirror back on the tip. The first finding
          // across the range is reported once, like the gate's short-circuit.
          await git(wt, "checkout", "-q", "--detach", "--force", tip);
          return;
        }
      }
    });
    // The mirror can be re-pointed at a newer tip while this pass waited for the shared gate
    // mirror: mark the newest commit actually judged, or the next poll re-judges the commits this
    // pass already covered (the poll's optimistic lastRulesWatched was only the head it saw). A
    // finding stops the walk before later commits, so it marks the finding's own commit and a
    // newer head it never finished is still retried from the next commit.
    if (judgedThrough !== undefined) {
      lastRulesWatched = judgedThrough;
      if (!hasBuildCheck) lastWatched = judgedThrough;
    }
  }

  /** Name a settled red tip's spell as the culprit: the merging runner, the main_culprit
   * event, and the onCulprit callback with the tip and its failing tests. The commit named is
   * the one that OPENED the red (settleOpener) — by bisecting the first-parent commits above
   * the newest full green at which re-running only the failing tests fails (part 3a/4), or the
   * nearest non-exempt first-parent value when the bisection cannot run or a doc-exempt tip
   * cannot have changed the suite — never a doc-only tip: blaming one would name a merge in
   * the G1 phrase (src/baseline/main-guardrails.ts) and the ci heal prompt
   * (src/baseline/main-red.ts) that did not break anything. `culprit` is that opener
   * (already computed by settleOpener in the red branch and shared with the first-red
   * main_check's sha), so the blame and the re-attributed red event name the same commit.
   * The opener is named once per spell with the tip's failing tests and, when the newest
   * merged event names the opener, its runner; while the spell is open a later tip
   * re-settling red re-attributes nothing. */
  function reportCulprit(baseline: MainBaseline, culprit: string): void {
    // A red spell that is already open keeps its opener named: the first red tip since the
    // last green caused the red, so a later tip re-settling red (a doc-exempt tip cannot
    // change the suite, and a code tip does not open a SECOND spell until a green closed the
    // first) is not re-attributed — no new event, no new heal prompt (the heal dedup already
    // re-queues when the failing set returns after a green).
    const open = redSpellOpeners.get(root);
    if (open !== undefined) {
      // A full-check fallback on a later head re-settles the spell's open set from that check:
      // the head may have healed one failure and introduced another, and `knownMainFailures`
      // reads the open set while the spell is open. Keep the opener (no re-attribution).
      redSpellOpeners.set(root, {
        opener: open.opener,
        tests: baseline.failingTests ?? [],
        ...(baseline.failingTestFiles ? { files: baseline.failingTestFiles } : {}),
      });
      return;
    }
    redSpellOpeners.set(root, {
      opener: culprit,
      tests: baseline.failingTests ?? [],
      ...(baseline.failingTestFiles ? { files: baseline.failingTestFiles } : {}),
    });
    const runner = mergingRoleOf(root, culprit);
    logEventBestEffort(root, {
      source: TUMWATER_SOURCE,
      type: "main_culprit",
      commit: culprit,
      ...(runner !== undefined ? { runner } : {}),
      failingTests: baseline.failingTests ?? [],
    });
    onCulprit?.({
      commit: culprit,
      failingTests: baseline.failingTests ?? [],
      ...(baseline.failingTestFiles ? { failingTestFiles: baseline.failingTestFiles } : {}),
      tip: baseline.sha,
    });
  }

  /** Warn that a watch pass could not check `mainHead`, once per head: both passes share this
   * so an unreadable main (both throw) produces one warning, not two. */
  function warnCouldNotCheck(mainHead: string, err: unknown): void {
    if (lastFailedWatchHead === mainHead) return;
    lastFailedWatchHead = mainHead;
    logEventBestEffort(root, {
      source: TUMWATER_SOURCE,
      type: "warning",
      message: `main watch could not check main: ${errorMessage(err)}`,
    });
  }

  /** The full-check pass (Hourly full check, part 2c/4): runs in the `_main-full` mirror on its
   * own queue, so the per-head rules pass and a gate's main-tip verdict in `_gate-main` never
   * wait behind it. The due rule (part 2b/4) decides whether the full check runs at all this
   * poll: within the interval and code uncovered, the head counts as watched at the anchor with
   * no run; otherwise the declared check runs on the latest tip, a red is confirmed once, the
   * verdict is settled and the spell's opener named. `previous` is the last watched head at the
   * moment of the poll. */
  async function fullPass(previous: string | undefined, config: TumwaterConfig): Promise<void> {
    // Called only when a build check is declared (poll gates it); the rules pass owns the
    // no-check path. The full check runs in the `_main-full` mirror, on its own queue.
    await withFullMainTipWorktree(root, mainBranch, async (wt) => {
      const tip = await headOf(wt);
      // The due rule (Hourly full check, part 2b/4): the full check runs at most once per
      // check.fullIntervalMinutes (default 60), on main's latest tip, and only while a
      // non-exempt code commit sits above the newest verdict a full check actually produced
      // (checkedAt, part 2a/4). A doc-only range inherits green and starts no run; a verdict
      // without checkedAt reads as due now; 0 restores one full run per new code head.
      const plan = await fullCheckPlan(wt, tip, config, now());
      if (plan.skip) {
        // The full check is within the interval and code is uncovered (part 2b/4): the diff
        // rules still judge this head, in their own pass, and the head counts as watched so
        // repeat polls do nothing. `fullCheckDueAt` keeps the due decision alive across those
        // polls without regressing `lastWatched` to the anchor (which would re-judge the same
        // range and re-log its rule warnings every poll). No main_check, no full run, until the
        // interval passes or main turns red.
        lastWatched = tip;
        fullCheckDueAt = plan.dueAt;
        fullCheckBase = plan.anchorSha;
        return;
      }
      // A spell already open (part 3b/4): a new head re-runs only the open failures on the
      // `_main-full` mirror's new tip instead of the full check. A test that passes leaves the
      // open set; when none fail the red clears as `{ status: "passed", cleared: true }` with
      // no full verdict written, and one full run starts at once on this head to confirm it.
      // When the open failures cannot be re-run alone (no re-run command, a cut-off list, or a
      // re-run that reaches no verdict), `narrowOpenRed` returns false and the head falls through
      // to the normal full-check path below — the pre-part-3b/4 behaviour, so a project without
      // a re-run command still re-checks every red head in full.
      const spell = redSpellOpeners.get(root);
      if (spell !== undefined && (await narrowOpenRed(wt, tip, spell, config))) {
        return;
      }
      const started = Date.now();
      const { check, ran } = await runBaselineCheck(wt, config);
      const baseline = check.baseline;
      // A skipped or sleep-spanned run made no verdict: the head still counts as watched, so the
      // next poll does not start another run for it. The diff rules still run on this tip, in
      // the rules pass.
      if (!baseline) {
        lastWatched = tip;
        fullCheckDueAt = undefined;
        fullCheckBase = undefined;
        return;
      }
      lastWatched = baseline.sha;
      fullCheckDueAt = undefined;
      // A check that follows a suspended interval covers every commit the skip passed over, not
      // just those since the last watched tip.
      const coveredFrom = fullCheckBase ?? previous;
      fullCheckBase = undefined;
      // A freshly-settled red (no spell open yet) is the spell's opener: its main_check is
      // recorded at the commit that OPENED the red (settleOpener, by bisecting the commits since
      // the last full green where the failing tests fail; failing that, redOpener walks the
      // merged batch from `coveredFrom`) so G1's "red since <sha>" names the breaker, not a doc
      // tip that only happened to be current. The fallback walk is bounded by `coveredFrom`, the
      // previous watched head, so a multi-commit batch's breaker — the oldest red first-parent
      // commit above it — is named even when it is not the checked tip. A re-check of an
      // already-open spell keeps the tip's sha (INV-AZ4: the re-check re-checks without
      // re-attributing).
      // A spell still open (the narrowing fell back to a full check) re-settles red without
      // re-attributing: the opener guard below keeps the spell's own opener (INV-AZ4). A fresh
      // red (no spell open) names the breaker; the confirming run inside narrowOpenRed runs with
      // the spell already deleted, so it too names its own opener.
      const opener = redSpellOpeners.has(root)
        ? undefined
        : await settleOpener(wt, baseline.sha, coveredFrom, config, baseline.failingTests ?? [], baseline.failingTestFiles);
      const red = await recordMainCheck(wt, baseline, coveredFrom, ran, started, opener);
      // A settled non-red verdict (a green, or a red naming only quarantined tests) clears the
      // heal-dedup key, so a failing set that returns after a green main is healed again, and
      // drops the heal prompts still waiting for a red this tip has passed. A settled red
      // verdict below does NOT clear it: the heal-dedup key stays set while main is red.
      if (!red) {
        clearHealKeyOnGreen();
        await dropHealPromptsCoveredBy(root, wt, baseline.sha);
        redSpellOpeners.delete(root); // a green closes the red spell; the next red names its own opener
        return;
      }
      // The spell's opener is blamed once: the first settled red tip since the last green names
      // the opener (or the nearest non-exempt commit before it, when the checked tip is
      // doc-exempt) and a later tip re-settling the same open red re-checks the suite without
      // re-naming the culprit (BUGS.md 2026-10-30 mis-attribution). The map holds the open
      // spell's opener, so a second red while the spell is still open re-checks without
      // re-naming; a green clears the entry (above) so a later red names its own opener.
      reportCulprit(baseline, opener ?? baseline.sha);
    });
  }

  /** While `root`'s red spell is open (part 3b/4): re-run only the spell's remaining open
   * failing tests on the new head `tip` — no full run. A test that passes on this head leaves
   * the open set (and `knownMainFailures`); when none fail, the red clears: a
   * `{ status: "passed", cleared: true }` main_check with no full verdict written, the spell
   * deleted, and one full run started at once on this head to confirm it. When the re-run
   * reaches no verdict (no re-run command, a cut-off list, or a skipped run), it returns false
   * and the caller re-checks the head in full, leaving the spell for that verdict to settle.
   * Never throws. */
  async function narrowOpenRed(
    wt: string,
    tip: string,
    spell: OpenRedSpell,
    config: TumwaterConfig,
  ): Promise<boolean> {
    const before = lastWatched;
    lastWatched = tip;
    fullCheckDueAt = undefined;
    fullCheckBase = undefined;
    const rerun = await rerunTests(root, TUMWATER_SOURCE, wt, config, spell.tests, spell.files, CHECK_TIER.merge);
    if (rerun === null) return false; // cannot narrow: the caller re-checks in full
    const stillFailing = spell.tests.filter((t) => rerun.failing.includes(t));
    if (stillFailing.length > 0) {
      // The spell stays open, narrowed: a passing test leaves the open set and the read of main's
      // known failures. The failing tests obey the spell's own opener attribution — no
      // re-attribution, no new culprit — and `redSpellOpeners` keeps the opener.
      redSpellOpeners.set(root, { ...spell, tests: stillFailing });
      knownFailures.set(root, stillFailing);
      logEventBestEffort(root, mainCheckEvent(
        { status: "red", sha: tip, failingTests: stillFailing },
        true, // red
        null, // quarantined
        1,
        0, // a re-run, not a full run: no durationMs to print
        spell.opener,
      ));
      return true;
    }
    // Every open test passed on this head: the red clears. Record a passed main_check with
    // `cleared: true` that writes no full verdict (so redeployTarget does not target this head
    // and the hour's anchor stays the last real full verdict), clear the heal-dedup key, drop
    // the heal prompts still waiting for this red, delete the spell, and start one confirming
    // full run at once on this head.
    const covered = await countCovered(wt, before, tip);
    knownFailures.set(root, []);
    redSpellOpeners.delete(root);
    logEventBestEffort(root, mainCheckEvent({ status: "green", sha: tip }, false, null, covered, 0, undefined, true));
    clearHealKeyOnGreen();
    await dropHealPromptsCoveredBy(root, wt, tip);
    // One confirming full run, once per cleared red, bypassing the interval: the `_main-full`
    // mirror (`wt`) already holds this head, so run the declared check on it directly — no nested
    // withFullMainTipWorktree (which would queue behind this very pass).
    if (detectBuildCheck(root, config)) {
      const confirmStarted = Date.now();
      const { check: confirmCheck } = await runBaselineCheck(wt, config);
      const confirmBaseline = confirmCheck.baseline;
      if (!confirmBaseline) return true; // no verdict: the cleared head stays watched, with no full verdict
      lastWatched = confirmBaseline.sha;
      fullCheckDueAt = undefined;
      fullCheckBase = undefined;
      const confirmedOpener = await settleOpener(
        wt,
        confirmBaseline.sha,
        tip,
        config,
        confirmBaseline.failingTests ?? [],
        confirmBaseline.failingTestFiles,
      );
      const confirmRed = await recordMainCheck(
        wt,
        confirmBaseline,
        tip,
        true,
        confirmStarted,
        confirmedOpener,
      );
      if (!confirmRed) {
        clearHealKeyOnGreen();
        await dropHealPromptsCoveredBy(root, wt, confirmBaseline.sha);
        redSpellOpeners.delete(root);
        return true;
      }
      reportCulprit(confirmBaseline, confirmedOpener ?? confirmBaseline.sha);
    }
    return true; // the open red was narrowed or cleared on this head
  }

  /** Start one quarantine housekeeping pass unless one is already in flight. */
  function startQuarantineHousekeeping(held: boolean): void {
    if (!held && !housekeeping) {
      housekeeping = settleQuarantine().finally(() => {
        housekeeping = null;
      });
    }
  }

  /** Whether a suspended full check has come due on this head: its clock deadline has passed, or
   * another check (the gate's main-tip attribution) recorded that same head red. A red is settled
   * and healed at once, never held back by the interval. */
  function suspendedFullCheckDue(mainHead: string): boolean {
    return (
      fullCheckDueAt !== undefined &&
      (now() >= fullCheckDueAt || baselineCache.get(mainHead)?.status === "red")
    );
  }

  /** Start the per-head diff-rules pass behind its own in-flight guard: a rules pass that was
   * busy when a head arrived must still judge that head. */
  function startRulesPass(mainHead: string, config: TumwaterConfig, rulesCovered: boolean): void {
    if (!rulesInFlight && !rulesCovered) {
      const previous = lastRulesWatched;
      lastRulesWatched = mainHead;
      rulesInFlight = rulesPass(mainHead, previous, config)
        .catch((err: unknown) => {
          // A failed rules pass (main unreadable, checkout refused) is not retried until main
          // moves, so a persistent failure warns once per head.
          warnCouldNotCheck(mainHead, err);
        })
        .finally(() => {
          rulesInFlight = null;
        });
    }
  }

  /** Start the due full-check pass behind its own in-flight guard, so a slow full run never
   * holds the `_gate-main` mirror a later poll's rules pass or a gate's main-tip verdict needs.
   * (Hourly full check, part 2c/4) */
  function startFullPass(mainHead: string, config: TumwaterConfig, fullDue: boolean): void {
    if (detectBuildCheck(root, config) && !fullInFlight && (mainHead !== lastWatched || fullDue)) {
      const previous = lastWatched;
      fullInFlight = fullPass(previous, config)
        .catch((err: unknown) => {
          // A failed full pass (main unreadable, checkout refused) records nothing and is not
          // retried until main moves, so a persistent failure warns once per head.
          lastWatched = mainHead;
          fullCheckDueAt = undefined;
          fullCheckBase = undefined;
          warnCouldNotCheck(mainHead, err);
        })
        .finally(() => {
          fullInFlight = null;
        });
    }
  }

  return {
    poll(mainHead, held, config) {
      startQuarantineHousekeeping(held);
      if (held || mainHead === "") return;
      const rulesCovered = lastRulesWatched === mainHead;
      const fullDue = suspendedFullCheckDue(mainHead);
      if (mainHead === lastWatched && rulesCovered && !fullDue) return;
      startRulesPass(mainHead, config, rulesCovered);
      startFullPass(mainHead, config, fullDue);
    },
    idle: async () => {
      while (rulesInFlight || fullInFlight || housekeeping) {
        await (rulesInFlight ?? fullInFlight ?? housekeeping);
      }
    },
  };
}

/** The interval in milliseconds the full check's due decision measures against: the config's
 * `check.fullIntervalMinutes`, the default 60 when absent or a torn slice, or 0 — one full run
 * per new code head — when the operator set it to 0 (Hourly full check, part 2b/4). */
function fullIntervalMs(config: TumwaterConfig): number {
  const minutes = config.check?.fullIntervalMinutes;
  return (typeof minutes === "number" && Number.isFinite(minutes) ? minutes : 60) * 60_000;
}

/** The full check's scheduling for `tip` (Hourly full check, part 2b/4): find the newest
 * first-parent commit (tip first, bounded at INHERIT_WALK_MAX) whose cached verdict a full check
 * actually produced — one that carries `checkedAt` (part 2a/4); inherited and merge-seeded
 * verdicts carry none and are skipped, as are verdicts a previous generation saved before it
 * carried the field. The anchor's kind decides:
 * - no anchor in range — nothing to measure the hour from; the full check runs.
 * - a RED anchor — a red is cleared only by checking a new tree, so the full check runs on
 *   every new head (a confirming re-run, or a cache answer on the same tip); the hour never
 *   delays a re-check (part 3/4's per-head narrowing builds on that).
 * - a GREEN anchor within the interval — the full check is SUSPENDED while a non-exempt code
 *   commit sits uncovered above it (`skip`): the diff rules still judge the head, and no
 *   `main_check` is recorded until the interval passes. A doc-only range above the anchor is
 *   NOT suspended: it goes through the check as today, where it records its inherited green
 *   without a run, so a doc head still settles green as before.
 * - a GREEN anchor past the interval (or interval 0, due while any code commit is uncovered) —
 *   the full check runs on the latest tip, covering every uncovered commit.
 * Never throws: a git failure reads as due, so the cadence can never silently starve the check. */
async function fullCheckPlan(
  wt: string,
  tip: string,
  config: TumwaterConfig,
  clock: number,
): Promise<{ skip: boolean; anchorSha?: string; dueAt?: number }> {
  const intervalMs = fullIntervalMs(config);
  const exempt = config.review?.exemptPaths ?? [];
  // firstParentWalk lists newest-first and stops at the bound, so the first anchor it names is
  // the newest full-verdict commit — the one the interval is measured from.
  const commits = await firstParentWalk(wt, tip, INHERIT_WALK_MAX);
  let anchor: { sha: string; checkedAt: number; red: boolean } | undefined;
  for (const commit of commits) {
    const verdict = baselineCache.get(commit);
    if (verdict?.checkedAt !== undefined) {
      anchor = { sha: commit, checkedAt: verdict.checkedAt, red: verdict.status === "red" };
      break;
    }
  }
  if (anchor === undefined) return { skip: false };
  if (anchor.red) return { skip: false };
  if (intervalMs !== 0 && clock < anchor.checkedAt + intervalMs) {
    const files = (await treeDiffFiles(wt, anchor.sha, tip)) ?? [];
    const codeUncovered = !isExemptDiff(files, [...exempt]);
    if (codeUncovered) return { skip: true, anchorSha: anchor.sha, dueAt: anchor.checkedAt + intervalMs };
  }
  return { skip: false };
}

async function headOf(wt: string): Promise<string> {
  return ((await gitTry(wt, "rev-parse", "HEAD")) ?? "").trim();
}
