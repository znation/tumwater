// vocabulary: plain
import { checkMainBaseline } from "./main-baseline.js";
import { baselineCheckLogger, withMainTipWorktree } from "./main-red.js";
import { CHECK_TIER } from "../concurrency/check-permit.js";
import { detectBuildCheck } from "../build/build-check-detect.js";
import { gitTry } from "../git/git-run.js";
import { logEventBestEffort, TUMWATER_SOURCE } from "../events/events.js";
import type { TumwaterConfig } from "../config/config-schema.js";
import { errorMessage } from "../text/text.js";

/** The main watch: after main's head moves, run the full check on the new tip in the `_gate-main`
 * mirror and record the verdict — a `main_check` event, and the failing tests on the red baseline
 * (which persists beside the greens). It records only: no run, gate or merge waits on it, and
 * nothing acts on what it sees yet (plans/fast-merge.md, Lever 2, part 3).
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

export function createMainWatch(root: string, mainBranch: string): MainWatch {
  let lastWatched: string | undefined;
  let inFlight: Promise<void> | null = null;

  async function watchOnce(mainHead: string, config: TumwaterConfig): Promise<void> {
    if (!detectBuildCheck(root, config)) {
      lastWatched = mainHead; // no declared check: nothing to watch until main moves
      return;
    }
    await withMainTipWorktree(root, mainBranch, async (wt) => {
      const started = Date.now();
      let ran = false;
      const onRun = baselineCheckLogger(root, TUMWATER_SOURCE);
      const hook: typeof onRun = (run) => {
        ran = true;
        onRun(run);
      };
      let check = await checkMainBaseline(wt, config, hook, false, false, undefined, false, CHECK_TIER.merge);
      if (check.baseline?.status === "red") {
        check = await checkMainBaseline(wt, config, hook, true, false, undefined, false, CHECK_TIER.merge);
      }
      const baseline = check.baseline;
      const previous = lastWatched;
      // A skipped or sleep-spanned run made no verdict: the head still counts as watched, so the
      // next poll does not start another run for it.
      if (!baseline) return void (lastWatched = await headOf(wt));
      lastWatched = baseline.sha;
      const counted =
        previous === undefined
          ? 1
          : Number(((await gitTry(wt, "rev-list", "--first-parent", "--count", `${previous}..${baseline.sha}`)) ?? "").trim());
      logEventBestEffort(root, {
        source: TUMWATER_SOURCE,
        type: "main_check",
        sha: baseline.sha,
        status: baseline.status === "green" ? "passed" : "failed",
        durationMs: ran ? Date.now() - started : 0,
        covered: Number.isFinite(counted) && counted > 0 ? counted : 1,
        ...(baseline.status === "red" ? { failingTests: baseline.failingTests ?? [] } : {}),
        ...(baseline.inheritedFrom !== undefined ? { inherited: true } : {}),
      });
    });
  }

  return {
    poll(mainHead, held, config) {
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
      while (inFlight) await inFlight;
    },
  };
}

async function headOf(wt: string): Promise<string> {
  return ((await gitTry(wt, "rev-parse", "HEAD")) ?? "").trim();
}
