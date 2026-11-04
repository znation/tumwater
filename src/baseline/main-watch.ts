import { distinctOrdered } from "../collections.js";
import { baselineCache, checkMainBaseline, firstParentWalk, INHERIT_WALK_MAX, settleRedByRerun } from "./main-baseline.js";
import { canRerun, rerunTests } from "../build/build-check-rerun.js";
import { baselineCheckLogger, clearHealKeyOnGreen, dropHealPromptsCoveredBy, withMainTipWorktree } from "./main-red.js";
import { CHECK_TIER } from "../concurrency/check-permit.js";
import { FAILING_TESTS_MAX } from "../build/build-check-report.js";
import { detectBuildCheck } from "../build/build-check-detect.js";
import { git, gitTry } from "../git/git-run.js";
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
 * OPENED the red (the first red tip since the last green), not the newest red tip: a doc-exempt
 * tip that lands after the red opened cannot have changed the suite, so re-naming it as culprit
 * would blame it in the G1 phrase and the heal prompt. Forward, never back, part 4/6: a red main
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
): {
  source: typeof TUMWATER_SOURCE;
  type: "main_check";
  sha: string;
  status: "failed" | "passed";
  durationMs: number;
  covered: number;
  failingTests?: string[];
  quarantined?: readonly string[];
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
    ...(baseline.inheritedFrom !== undefined ? { inherited: true } : {}),
  };
}

/** The main watch: after main's head moves, run the full check on the new tip in the `_gate-main`
 * mirror and record the verdict — a `main_check` event, and the failing tests on the red baseline
 * (which persists beside the greens). The watch checks every new red tip, but the CULPRIT for an
 * ongoing red is the commit that opened it — the first red tip since the last green: a doc-exempt
 * tip that lands after the red opened cannot have changed the suite, so re-naming it would blame
 * a merge that did not break the check in the G1 phrase and ci's heal prompt. On a red tip it
 * logs a `main_culprit` event naming the opener (with its merging runner when a recent merged
 * event names one), and a green closes the spell, so the next red names its own opener. No run,
 * gate or merge waits on it; the culprit goes to the optional `onCulprit` callback, which the
 * orchestrator wires to ci's heal prompt (Forward, never back, part 4/6): a red main is healed
 * forward, never reverted.
 *
 * One watch run is in flight at a time, and it covers every commit since the last watched head;
 * a head that moves during a run is watched next. The full check runs at most once per
 * `check.fullIntervalMinutes` (default 60), on main's latest tip, and only while a non-exempt
 * code commit sits above the newest verdict a full check actually produced — `checkedAt` (part
 * 2a/4) is the age; a doc-only range inherits green and starts no run; a verdict without
 * `checkedAt` reads as due now; `0` restores one full run per new code head. The diff rules run on
 * every new head either way, and a red is confirmed once before it is final — by re-running only
 * its failing tests when it can (build-check-rerun.ts), else the whole check again
 * (`reverifyRed`). The check queues at the merge tier of the check permits. */
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

/** The commit each root's red spell was opened at, keyed by root — the tip of the first red
 * verdict since the last green. It stays the named culprit while the spell is open: a later tip
 * re-checks red (the red never inherits across a doc commit) but did not open it, so it is not
 * re-attributed. A green verdict clears it, so a red that opens after a green names its own
 * opener. In-memory only: a restart mid-red loses the spell's opener, and the next settled red
 * tip then names itself as culprit — the pre-fix behaviour, and a bounded one (one tip per
 * restart, since a spell's later tips inherit the red and settle without a re-run). */
const redSpellOpeners = new Map<string, string>();

/** Main's known failures: the failing tests of the watch's newest verdict — main's tip, or the
 * nearest tip it checked while the newest head waits — and every quarantined flaky test
 * (review/known-flakes.ts). Empty when the verdict is green, red with no parsed test, or none has
 * been recorded yet in this process, and nothing is quarantined. */
export function knownMainFailures(root: string): string[] {
  return distinctOrdered([...(knownFailures.get(root) ?? []), ...quarantinedTests(root)]);
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
  let inFlight: Promise<void> | null = null;
  let housekeeping: Promise<void> | null = null;
  let lastFilingWarning = "";
  let lastCloseWarning = "";

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

  async function watchOnce(mainHead: string, config: TumwaterConfig): Promise<void> {
    // The deterministic diff rules ("Every commit is verified on main, part 1/3"): run the full
    // five-check set the watch and gate share — the gate now runs only the three a later commit
    // cannot repair — against main's new tip. A rule failure is a
    // deterministic red — it takes no confirming re-run and never quarantines — reported as a
    // warning naming the rule and the head (and each committing role, when a recent merged event
    // names one). It runs on every tip the watch covers in a poll — a build green, a build
    // red, and a head with no verdict (a skipped or sleep-spanned check) or no declared build
    // check at all — because a tip counts as watched (lastWatched) either way, so this is the one
    // chance to judge its diff before the next head moves.
    const watchRules = async (wt: string, base: string | undefined, tip: string): Promise<void> => {
      // Judge each first-parent commit in the range by its own diff and its own merged-event role,
      // not the tip's: a multi-commit range's union diff attributed to whichever role merged the
      // tip would report a legitimate director/steward PRINCIPLES.md edit in an intermediate commit
      // as unauthorized by the role that merged later. base is undefined only before the first
      // watched head, when the range is the tip's own commit.
      //
      // The diff rules read the change's "head" side from the worktree (conflict markers,
      // brief/protected-file content, secrets, backlog structure) against a base revision, so the
      // mirror checkout must sit ON the commit being judged — not on the tip — or an intermediate
      // commit would be compared against the tip's content of its touched files rather than its
      // own. The range is walked oldest-first and ends back on the tip.
      const commits =
        base === undefined
          ? [tip]
          : ((await gitTry(wt, "rev-list", "--first-parent", "--reverse", `${base}..${tip}`)) ?? "")
              .trim()
              .split(/\s+/)
              .filter(Boolean);
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
    };

    /** Run the declared build check on main's tip, confirming a red once and quarantining a flake
     * whose confirmation passes. A red whose failing tests can be re-run on their own (canRerun) is
     * confirmed by re-running just those tests, so the full check runs once per tip: a test that
     * passes there is quarantined, and the red narrows to the tests that failed again (or turns
     * green when none did). A re-run that reaches no verdict leaves the first red standing. Without
     * a re-run command the whole check runs again, as before. Returns the check's result and
     * whether any full run actually executed (false for a cache hit, a skip, or a sleep-spanned
     * run). `config` and `root` are captured from `watchOnce`. */
    async function runBaselineCheck(wt: string): Promise<{ check: BaselineCheck; ran: boolean }> {
      let ran = false;
      const onRun = baselineCheckLogger(root, TUMWATER_SOURCE);
      const hook: typeof onRun = (run) => {
        ran = true;
        onRun(run);
      };
      let check = await checkMainBaseline(wt, config, hook, false, false, undefined, false, CHECK_TIER.merge);
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
      check = await checkMainBaseline(wt, config, hook, true, false, undefined, false, CHECK_TIER.merge);
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

    /** The commit that OPENED a settled red: the checked tip when its own diff could have
     * changed the suite, else — for a review-exempt (doc-only) tip that cannot have — the
     * nearest first-parent ancestor (the tip itself first) whose own diff is not exempt, i.e.
     * the most recent commit whose change the suite could react to. The watch checks the tip,
     * not each merged commit, so when a code commit and a doc commit land in one poll interval
     * the red is first seen at the doc tip (BUGS.md 2026-11-02: the guardrail named the doc
     * merge as the red's opener), and the code commit that broke it is a first-parent ancestor
     * of the tip. A non-exempt tip is returned at once (no walk); only a doc-exempt tip walks
     * its ancestors, bounded at INHERIT_WALK_MAX like the inheritance walks, and a git failure
     * or an all-exempt walk reads as "the tip itself". Never throws. */
    async function redOpener(wt: string, tip: string, exemptPaths: readonly string[]): Promise<string> {
      const tipFiles = (await treeDiffFiles(wt, `${tip}^`, tip)) ?? [];
      if (!isExemptDiff(tipFiles, [...exemptPaths])) return tip;
      for (const ancestor of await firstParentWalk(wt, tip, INHERIT_WALK_MAX)) {
        const files = (await treeDiffFiles(wt, `${ancestor}^`, ancestor)) ?? [];
        if (!isExemptDiff(files, [...exemptPaths])) return ancestor;
      }
      return tip;
    }

    /** Name a settled red tip's spell as the culprit: the merging runner, the main_culprit
     * event, and the onCulprit callback with the tip and its failing tests. The commit named is
     * the one that OPENED the red (redOpener) — the first red tip since the last green, or, when
     * that tip is review-exempt (a doc-only diff that cannot have changed the suite), the nearest
     * first-parent commit before it whose own diff is not exempt — never a doc-only tip: blaming
     * one would name a merge in the G1 phrase (src/baseline/main-guardrails.ts) and the ci heal
     * prompt (src/baseline/main-red.ts) that did not break anything. `culprit` is that opener
     * (already computed by redOpener in the red branch and shared with the first-red
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
      if (redSpellOpeners.has(root)) return;
      redSpellOpeners.set(root, culprit);
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

    if (!detectBuildCheck(root, config)) {
      // No declared build check: nothing to watch for a build red, but the diff rules still run on
      // the tip. The build-red path below is what never runs here.
      await withMainTipWorktree(root, mainBranch, async (wt) => {
        await watchRules(wt, lastWatched, await headOf(wt));
      });
      lastWatched = mainHead; // no declared check: nothing else to watch until main moves
      fullCheckDueAt = undefined;
      fullCheckBase = undefined;
      return;
    }
    await withMainTipWorktree(root, mainBranch, async (wt) => {
      const previous = lastWatched;
      const tip = await headOf(wt);
      // The due rule (Hourly full check, part 2b/4): the full check runs at most once per
      // check.fullIntervalMinutes (default 60), on main's latest tip, and only while a
      // non-exempt code commit sits above the newest verdict a full check actually produced
      // (checkedAt, part 2a/4). A doc-only range inherits green and starts no run; a verdict
      // without checkedAt reads as due now; 0 restores one full run per new code head.
      const plan = await fullCheckPlan(wt, tip, config, now());
      if (plan.skip) {
        // The full check is within the interval and code is uncovered (part 2b/4): the diff
        // rules still judge this head, and the head counts as watched so repeat polls do nothing.
        // `fullCheckDueAt` keeps the due decision alive across those polls without regressing
        // `lastWatched` to the anchor (which would re-judge the same range and re-log its rule
        // warnings every poll). No main_check, no full run, until the interval passes or main
        // turns red.
        await watchRules(wt, previous, tip);
        lastWatched = tip;
        fullCheckDueAt = plan.dueAt;
        fullCheckBase = plan.anchorSha;
        return;
      }
      const started = Date.now();
      const { check, ran } = await runBaselineCheck(wt);
      const baseline = check.baseline;
      // A skipped or sleep-spanned run made no verdict: the head still counts as watched, so the
      // next poll does not start another run for it — but the diff rules still run on this tip.
      if (!baseline) {
        const tip = await headOf(wt);
        await watchRules(wt, previous, tip);
        fullCheckDueAt = undefined;
        fullCheckBase = undefined;
        return void (lastWatched = tip);
      }
      lastWatched = baseline.sha;
      fullCheckDueAt = undefined;
      // A check that follows a suspended interval covers every commit the skip passed over, not
      // just those since the last watched tip.
      const coveredFrom = fullCheckBase ?? previous;
      fullCheckBase = undefined;
      // A freshly-settled red (no spell open yet) is the spell's opener: its main_check is
      // recorded at the commit that OPENED the red (redOpener) so G1's "red since <sha>" names
      // the breaker, not a doc tip that only happened to be current. A re-check of an already-open
      // spell keeps the tip's sha (INV-AZ4: the re-check re-checks without re-attributing).
      const opener = redSpellOpeners.has(root) ? undefined : await redOpener(wt, baseline.sha, config.review.exemptPaths);
      const red = await recordMainCheck(wt, baseline, coveredFrom, ran, started, opener);
      // The diff rules judge the tip whether the build is green or red; the build-red path below
      // names the whole tip as the culprit, so the two red kinds are judged independently.
      await watchRules(wt, previous, baseline.sha);
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
      if (redSpellOpeners.has(root)) return;
      reportCulprit(baseline, opener ?? baseline.sha);
    });
  }

  return {
    poll(mainHead, held, config) {
      if (!held && !housekeeping) {
        housekeeping = settleQuarantine().finally(() => {
          housekeeping = null;
        });
      }
      if (held || mainHead === "" || inFlight) return;
      // A head already watched is a no-op unless a suspended full check has now come due, or
      // another check (the gate's main-tip attribution) recorded that same head red: a red is
      // settled and healed at once, never held back by the interval.
      if (mainHead === lastWatched) {
        if (fullCheckDueAt === undefined) return;
        if (now() < fullCheckDueAt && baselineCache.get(mainHead)?.status !== "red") return;
      }
      inFlight = watchOnce(mainHead, config)
        .catch((err: unknown) => {
          // A failed watch (main unreadable, checkout refused) records nothing and is not
          // retried until main moves, so a persistent failure warns once per head.
          lastWatched = mainHead;
          fullCheckDueAt = undefined;
          fullCheckBase = undefined;
          logEventBestEffort(root, {
            source: TUMWATER_SOURCE,
            type: "warning",
            message: `main watch could not check main: ${errorMessage(err)}`,
          });
        })
        .finally(() => {
          inFlight = null;
        });
    },
    idle: async () => {
      while (inFlight || housekeeping) await (inFlight ?? housekeeping);
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
