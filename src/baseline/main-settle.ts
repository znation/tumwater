import { checkMainBaseline, commitsAboveFullGreen, INHERIT_WALK_MAX, settleRedByRerun } from "./main-baseline.js";
import { canRerun, rerunTests } from "../build/build-check-rerun.js";
import { baselineCheckLogger, withMainTipWorktree } from "./main-red.js";
import { onlyQuarantined, quarantineTests } from "../review/known-flakes.js";
import { setKnownFailures, setKnownOffenders, setSpell, spellFor } from "./main-red-spell.js";
import { CHECK_TIER } from "../concurrency/check-permit.js";
import { git, gitTry } from "../git/git-run.js";
import { gitLines } from "../git/git.js";
import { logEventBestEffort, TUMWATER_SOURCE } from "../events/events.js";
import type { TumwaterConfig } from "../config/config-schema.js";
import { mergingRoleOf } from "../events/event-read.js";

/** What the main watch hands to `onCulprit` for a red tip: the red head it was found at (`tip`)
 * and the failing tests that made it red — exactly the fields ci's red-main heal prompt needs
 * (src/baseline/main-red.ts mainRedHealPrompt). `commit` is the culprit itself — the commit that
 * OPENED the red (by bisecting the first-parent commits since the last full green and re-running
 * only those tests, part 3a/4; never a doc-exempt tip, which cannot have changed the suite) —
 * not the newest red tip, so re-naming the tip as culprit would blame a merge that did not break
 * the check in the G1 phrase and the heal prompt. Forward, never back, part 4/6: a red main
 * heals forward and is never reverted, so this holds nothing a revert would need. */
export interface MainCulprit {
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
export function mainCheckEvent(
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

/** The shared settlement helpers: module-level so the rules pass and the full-check pass
 * (Hourly full check, part 2c/4) settle a verdict identically. */
/** Run the declared build check on main's tip, confirming a red once and quarantining a flake
 * whose confirmation passes. A red whose failing tests can be re-run on their own (canRerun) is
 * confirmed by re-running just those tests, so the full check runs once per tip: a test that
 * passes there is quarantined, and the red narrows to the tests that failed again (or turns
 * green when none did). A re-run that reaches no verdict leaves the first red standing. Without
 * a re-run command the whole check runs again, as before. Returns the check's result and
 * whether any full run actually executed (false for a cache hit, a skip, or a sleep-spanned
 * run). `config` is the live one at the moment of the run. */
export async function runBaselineCheck(root: string, wt: string, config: TumwaterConfig): Promise<{ check: BaselineCheck; ran: boolean }> {
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
export async function countCovered(wt: string, previous: string | undefined, sha: string): Promise<number> {
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
export async function recordMainCheck(
  root: string,
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
  setKnownFailures(root, red ? (baseline.failingTests ?? []) : []);
  setKnownOffenders(root, red ? (baseline.failingOffenders ?? {}) : {});
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
  root: string,
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
export async function settleOpener(
  root: string,
  mainBranch: string,
  wt: string,
  tip: string,
  since: string | undefined,
  config: TumwaterConfig,
  failingTests: readonly string[],
  files: Readonly<Record<string, string>> | undefined,
): Promise<string | undefined> {
  if (!canRerun(wt, config, failingTests)) return redOpener(root, wt, tip, since, config);
  const candidates = await commitsAboveFullGreen(wt, tip);
  if (candidates.length === 0) return redOpener(root, wt, tip, since, config);
  const bisected = await withMainTipWorktree(root, mainBranch, async (mirror) =>
    bisectAt(root, mirror, tip, candidates, config, failingTests, files),
  ).catch(() => undefined);
  return bisected ?? redOpener(root, wt, tip, since, config);
}

/** The bisection body over `candidates` (oldest-first) in `mirror`, which withMainTipWorktree
 * holds at main's tip: binary-search the oldest candidate at which `failingTests` still fail
 * when re-run alone, checking each candidate out in turn and leaving the mirror at main's tip.
 * Undefined when a candidate's re-run reaches no verdict (nothing the bisection can conclude
 * from). Never throws. */
async function bisectAt(
  root: string,
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
export function reportCulprit(root: string, onCulprit: ((culprit: MainCulprit) => void) | undefined, baseline: MainBaseline, culprit: string): void {
  // A red spell that is already open keeps its opener named: the first red tip since the
  // last green caused the red, so a later tip re-settling red (a doc-exempt tip cannot
  // change the suite, and a code tip does not open a SECOND spell until a green closed the
  // first) is not re-attributed — no new event, no new heal prompt (the heal dedup already
  // re-queues when the failing set returns after a green).
  const open = spellFor(root);
  if (open !== undefined) {
    // A full-check fallback on a later head re-settles the spell's open set from that check:
    // the head may have healed one failure and introduced another, and `knownMainFailures`
    // reads the open set while the spell is open. Keep the opener (no re-attribution).
    setSpell(
      root,
      open.opener,
      baseline.failingTests ?? [],
      baseline.failingTestFiles,
      baseline.failingOffenders,
    );
    return;
  }
  setSpell(root, culprit, baseline.failingTests ?? [], baseline.failingTestFiles, baseline.failingOffenders);
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
