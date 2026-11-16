import { baselineCache, firstParentWalk, INHERIT_WALK_MAX } from "./main-baseline.js";
import { rerunTests } from "../build/build-check-rerun.js";
import { clearHealKeyOnGreen, dropHealPromptsCoveredBy, withFullMainTipWorktree } from "./main-red.js";
import { CHECK_TIER } from "../concurrency/check-permit.js";
import { detectBuildCheck } from "../build/build-check-detect.js";
import { logEventBestEffort, TUMWATER_SOURCE } from "../events/events.js";
import type { TumwaterConfig } from "../config/config-schema.js";
import { treeDiffFiles } from "../git/git-diff.js";
import { isExemptDiff } from "../review/exemptions.js";
import {
  type OpenRedSpell,
  clearKnown,
  clearSpell,
  narrowStillFailing,
  spellFor,
  spellOpen,
} from "./main-red-spell.js";
import {
  countCovered,
  mainCheckEvent,
  recordMainCheck,
  runBaselineCheck,
  settleOpener,
  reportCulprit,
  type MainCulprit,
} from "./main-settle.js";
import { headOf, markWatched, type MainWatchState } from "./main-watch-state.js";

/** Concern A: the full-check pass — the hourly cadence decision, the red-spell's
 * open/red-narrowing/clearing, and the verdict settle + culprit naming. It runs in the
 * `_main-full` mirror on its own queue, so the per-head rules pass and a gate's main-tip verdict
 * in `_gate-main` never wait behind it. */

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

/** The full-check pass (Hourly full check, part 2c/4): runs in the `_main-full` mirror on its
 * own queue, so the per-head rules pass and a gate's main-tip verdict in `_gate-main` never
 * wait behind it. The due rule (part 2b/4) decides whether the full check runs at all this
 * poll: within the interval and code uncovered, the head counts as watched at the anchor with
 * no run; otherwise the declared check runs on the latest tip, a red is confirmed once, the
 * verdict is settled and the spell's opener named. `previous` is the last watched head at the
 * moment of the poll. */
export async function fullPass(
  root: string,
  mainBranch: string,
  state: MainWatchState,
  onCulprit: ((culprit: MainCulprit) => void) | undefined,
  now: () => number,
  previous: string | undefined,
  config: TumwaterConfig,
): Promise<void> {
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
      state.lastWatched = tip;
      state.fullCheckDueAt = plan.dueAt;
      state.fullCheckBase = plan.anchorSha;
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
    const spell = spellFor(root);
    if (spell !== undefined && (await narrowOpenRed(root, mainBranch, state, onCulprit, wt, tip, spell, config))) {
      return;
    }
    const started = Date.now();
    const { check, ran } = await runBaselineCheck(root, wt, config);
    const baseline = check.baseline;
    // A skipped or sleep-spanned run made no verdict: the head still counts as watched, so the
    // next poll does not start another run for it. The diff rules still run on this tip, in
    // the rules pass.
    if (!baseline) {
      markWatched(state, tip);
      return;
    }
    state.lastWatched = baseline.sha;
    state.fullCheckDueAt = undefined;
    // A check that follows a suspended interval covers every commit the skip passed over, not
    // just those since the last watched tip.
    const coveredFrom = state.fullCheckBase ?? previous;
    state.fullCheckBase = undefined;
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
    const opener = spellOpen(root)
      ? undefined
      : await settleOpener(root, mainBranch, wt, baseline.sha, coveredFrom, config, baseline.failingTests ?? [], baseline.failingTestFiles);
    const red = await recordMainCheck(root, wt, baseline, coveredFrom, ran, started, opener);
    // A settled non-red verdict (a green, or a red naming only quarantined tests) clears the
    // heal-dedup key, so a failing set that returns after a green main is healed again, and
    // drops the heal prompts still waiting for a red this tip has passed. A settled red
    // verdict below does NOT clear it: the heal-dedup key stays set while main is red.
    if (!red) {
      clearHealKeyOnGreen();
      await dropHealPromptsCoveredBy(root, wt, baseline.sha);
      clearSpell(root); // a green closes the red spell; the next red names its own opener
      return;
    }
    // The spell's opener is blamed once: the first settled red tip since the last green names
    // the opener (or the nearest non-exempt commit before it, when the checked tip is
    // doc-exempt) and a later tip re-settling the same open red re-checks the suite without
    // re-naming the culprit (BUGS.md 2026-10-30 mis-attribution). The map holds the open
    // spell's opener, so a second red while the spell is still open re-checks without
    // re-naming; a green clears the entry (above) so a later red names its own opener.
    reportCulprit(root, onCulprit, baseline, opener ?? baseline.sha);
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
  root: string,
  mainBranch: string,
  state: MainWatchState,
  onCulprit: ((culprit: MainCulprit) => void) | undefined,
  wt: string,
  tip: string,
  spell: OpenRedSpell,
  config: TumwaterConfig,
): Promise<boolean> {
  const before = state.lastWatched;
  markWatched(state, tip);
  const rerun = await rerunTests(root, TUMWATER_SOURCE, wt, config, spell.tests, spell.files, CHECK_TIER.merge);
  if (rerun === null) return false; // cannot narrow: the caller re-checks in full
  const stillFailing = spell.tests.filter((t) => rerun.failing.includes(t));
  if (stillFailing.length > 0) {
    narrowStillFailingRed(root, tip, spell, stillFailing);
    return true;
  }
  await confirmClearedRed(root, mainBranch, state, onCulprit, wt, tip, before, config);
  return true; // the open red was narrowed or cleared on this head
}

/** While `root`'s red spell is open (part 3b/4) and a re-run of the open failures still
 * fails: narrow the spell to the tests that failed again. A passing test has already left
 * the open set in `stillFailing`; this rewrites the spell to the still-failing set —
 * keeping the spell's own opener, its files, and the narrowed offenders — and the
 * known-failure maps, and logs the narrowed red `main_check` with the spell's opener: no
 * re-attribution, no new culprit. */
function narrowStillFailingRed(root: string, tip: string, spell: OpenRedSpell, stillFailing: string[]): void {
  // The spell stays open, narrowed: a passing test leaves the open set and the read of main's
  // known failures. The failing tests obey the spell's own opener attribution — no
  // re-attribution, no new culprit — and `narrowStillFailing` keeps the opener.
  narrowStillFailing(root, spell, stillFailing);
  logEventBestEffort(root, mainCheckEvent(
    { status: "red", sha: tip, failingTests: stillFailing },
    true, // red
    null, // quarantined
    1,
    0, // a re-run, not a full run: no durationMs to print
    spell.opener,
  ));
}

/** While `root`'s red spell is open (part 3b/4) and a re-run of the open failures shows every
 * test passing: clear the red. Count the covered commits and record a passed `main_check`
 * with `cleared: true` that writes no full verdict (so `redeployTarget` does not target this
 * head and the hour's anchor stays the last real full verdict), clear the known-failure maps,
 * delete the spell, clear the heal-dedup key, and drop the heal prompts still waiting for
 * this red. Then, when a build check is declared, run one confirming full run on the
 * `_main-full` mirror (`wt`, which already holds this head) and settle or report it through
 * `recordMainCheck` and `reportCulprit` — or leave the cleared head watched with no verdict
 * when that run reports none. */
async function confirmClearedRed(
  root: string,
  mainBranch: string,
  state: MainWatchState,
  onCulprit: ((culprit: MainCulprit) => void) | undefined,
  wt: string,
  tip: string,
  before: string | undefined,
  config: TumwaterConfig,
): Promise<void> {
  // Every open test passed on this head: the red clears. Record a passed main_check with
  // `cleared: true` that writes no full verdict (so redeployTarget does not target this head
  // and the hour's anchor stays the last real full verdict), clear the heal-dedup key, drop
  // the heal prompts still waiting for this red, delete the spell, and start one confirming
  // full run at once on this head.
  const covered = await countCovered(wt, before, tip);
  clearKnown(root);
  clearSpell(root);
  logEventBestEffort(root, mainCheckEvent({ status: "green", sha: tip }, false, null, covered, 0, undefined, true));
  clearHealKeyOnGreen();
  await dropHealPromptsCoveredBy(root, wt, tip);
  // One confirming full run, once per cleared red, bypassing the interval: the `_main-full`
  // mirror (`wt`) already holds this head, so run the declared check on it directly — no nested
  // withFullMainTipWorktree (which would queue behind this very pass).
  if (detectBuildCheck(root, config)) {
    const confirmStarted = Date.now();
    const { check: confirmCheck } = await runBaselineCheck(root, wt, config);
    const confirmBaseline = confirmCheck.baseline;
    if (!confirmBaseline) return; // no verdict: the cleared head stays watched, with no full verdict
    markWatched(state, confirmBaseline.sha);
    const confirmedOpener = await settleOpener(
      root,
      mainBranch,
      wt,
      confirmBaseline.sha,
      tip,
      config,
      confirmBaseline.failingTests ?? [],
      confirmBaseline.failingTestFiles,
    );
    const confirmRed = await recordMainCheck(
      root,
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
      clearSpell(root);
      return;
    }
    reportCulprit(root, onCulprit, confirmBaseline, confirmedOpener ?? confirmBaseline.sha);
  }
}
