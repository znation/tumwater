import { distinctOrdered } from "../collections.js";
import { checkMainBaseline } from "./main-baseline.js";
import { baselineCheckLogger, clearHealKeyOnGreen, withMainTipWorktree } from "./main-red.js";
import { CHECK_TIER } from "../concurrency/check-permit.js";
import { FAILING_TESTS_MAX } from "../build/build-check-report.js";
import { detectBuildCheck } from "../build/build-check-detect.js";
import { git, gitTry } from "../git/git-run.js";
import { logEventBestEffort, TUMWATER_SOURCE } from "../events/events.js";
import type { TumwaterConfig } from "../config/config-schema.js";
import { errorMessage } from "../text/text.js";
import { fileQuarantineBugsOnMain } from "../backlog/backlog-file-bugs.js";
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
 * (src/baseline/main-red.ts mainRedHealPrompt). Forward, never back, part 4/6: a red main heals
 * forward and is never reverted, so this holds nothing a revert would need. */
interface MainCulprit {
  commit: string;
  failingTests: string[];
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
    sha: baseline.sha,
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
 * (which persists beside the greens). The watch checks every new red tip, so the newest head is
 * the culprit for what it finds: on a red tip it logs a `main_culprit` event naming that head
 * (with its merging runner when a recent merged event names one). No run, gate or merge waits on
 * it; the culprit goes to the optional `onCulprit` callback, which the orchestrator wires to ci's
 * heal prompt (Forward, never back, part 4/6): a red main is healed forward, never reverted.
 *
 * One watch run is in flight at a time, and it covers every commit since the last watched head; a
 * head that moves during a run is watched next. The run goes through checkMainBaseline, so a
 * cached verdict (every merge seeds a green) and a doc-only tip's inherited green answer without a
 * run, and a red is re-run once (`reverifyRed`) before it is final. The check queues at the merge
 * tier of the check permits. */
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
): MainWatch {
  let lastWatched: string | undefined;
  let inFlight: Promise<void> | null = null;
  let housekeeping: Promise<void> | null = null;
  let lastFilingWarning = "";

  /** Release quarantined tests whose bug left `## Open`, and file the bugs of newly quarantined
   * ones on main. A filing the primary checkout cannot take warns (once per reason) and is
   * retried on a later poll. Never throws. */
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
      const pending = loadQuarantine(root).filter((e) => e.bug === "");
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
    } catch (err: unknown) {
      logEventBestEffort(root, {
        source: TUMWATER_SOURCE,
        type: "warning",
        message: `quarantine housekeeping failed: ${errorMessage(err)}`,
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

    /** Run the declared build check on main's tip, re-running a red once and quarantining a flake
     * whose re-run turns green. Returns the check's result and whether any run actually executed
     * (false for a cache hit, a skip, or a sleep-spanned run). `config` and `root` are captured
     * from `watchOnce`. */
    async function runBaselineCheck(wt: string): Promise<{ check: BaselineCheck; ran: boolean }> {
      let ran = false;
      const onRun = baselineCheckLogger(root, TUMWATER_SOURCE);
      const hook: typeof onRun = (run) => {
        ran = true;
        onRun(run);
      };
      let check = await checkMainBaseline(wt, config, hook, false, false, undefined, false, CHECK_TIER.merge);
      if (check.baseline?.status === "red") {
        const first = check.baseline;
        check = await checkMainBaseline(wt, config, hook, true, false, undefined, false, CHECK_TIER.merge);
        // A red the same tree's confirming re-run turns green is a flake: quarantine its tests.
        if (check.baseline?.status === "green") quarantineTests(root, first.failingTests, (first.failingTests ?? []).join("\n"));
      }
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
     * main's known failures, count the covered commits, and log the main_check event. Returns
     * whether the tip settled red (a red naming tests that are not all quarantined). */
    async function recordMainCheck(
      wt: string,
      baseline: MainBaseline,
      previous: string | undefined,
      ran: boolean,
      started: number,
    ): Promise<boolean> {
      // A red naming only quarantined tests counts as green: no redeploy hold.
      const quarantined = baseline.status === "red" ? onlyQuarantined(root, baseline.failingTests) : null;
      const red = baseline.status === "red" && !quarantined;
      knownFailures.set(root, red ? (baseline.failingTests ?? []) : []);
      const covered = await countCovered(wt, previous, baseline.sha);
      logEventBestEffort(root, mainCheckEvent(baseline, red, quarantined, covered, ran ? Date.now() - started : 0));
      return red;
    }

    /** Name a settled red tip as the culprit: its merging runner, the main_culprit event, and
     * the onCulprit callback with the tip and its failing tests. */
    function reportCulprit(baseline: MainBaseline): void {
      // The newest head is the culprit ("Every commit is verified on main, part 2/3"): the watch
      // checks each new red tip, so whatever it found belongs to the head it checked. Once per red
      // head — lastWatched already holds it, so a later poll does not attribute it again — name
      // the tip with its own failing tests and, when the newest merged event names it, its runner.
      const runner = mergingRoleOf(root, baseline.sha);
      logEventBestEffort(root, {
        source: TUMWATER_SOURCE,
        type: "main_culprit",
        commit: baseline.sha,
        ...(runner !== undefined ? { runner } : {}),
        failingTests: baseline.failingTests ?? [],
      });
      onCulprit?.({
        commit: baseline.sha,
        failingTests: baseline.failingTests ?? [],
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
      return;
    }
    await withMainTipWorktree(root, mainBranch, async (wt) => {
      const started = Date.now();
      const { check, ran } = await runBaselineCheck(wt);
      const baseline = check.baseline;
      const previous = lastWatched;
      // A skipped or sleep-spanned run made no verdict: the head still counts as watched, so the
      // next poll does not start another run for it — but the diff rules still run on this tip.
      if (!baseline) {
        const tip = await headOf(wt);
        await watchRules(wt, previous, tip);
        return void (lastWatched = tip);
      }
      lastWatched = baseline.sha;
      const red = await recordMainCheck(wt, baseline, previous, ran, started);
      // The diff rules judge the tip whether the build is green or red; the build-red path below
      // names the whole tip as the culprit, so the two red kinds are judged independently.
      await watchRules(wt, previous, baseline.sha);
      // A settled non-red verdict (a green, or a red naming only quarantined tests) clears the
      // heal-dedup key, so a failing set that returns after a green main is healed again. A
      // settled red verdict below does NOT clear it: the heal-dedup key stays set while main
      // is red.
      if (!red) {
        clearHealKeyOnGreen();
        return;
      }
      reportCulprit(baseline);
    });
  }

  return {
    poll(mainHead, held, config) {
      if (!held && !housekeeping) {
        housekeeping = settleQuarantine().finally(() => {
          housekeeping = null;
        });
      }
      if (held || mainHead === "" || inFlight || mainHead === lastWatched) return;
      inFlight = watchOnce(mainHead, config)
        .catch((err: unknown) => {
          // A failed watch (main unreadable, checkout refused) records nothing and is not
          // retried until main moves, so a persistent failure warns once per head.
          lastWatched = mainHead;
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

async function headOf(wt: string): Promise<string> {
  return ((await gitTry(wt, "rev-parse", "HEAD")) ?? "").trim();
}
