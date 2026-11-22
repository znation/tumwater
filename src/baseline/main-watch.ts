import { detectBuildCheck } from "../build/build-check-detect.js";
import type { TumwaterConfig } from "../config/config-schema.js";
import type { MainCulprit } from "./main-settle.js";
import {
  markWatched,
  newMainWatchState,
  suspendedFullCheckDue,
  warnCouldNotCheck,
} from "./main-watch-state.js";
import { startRulesPass } from "./main-watch-rules.js";
import { fullPass } from "./main-watch-full.js";
import { startQuarantineHousekeeping } from "./main-watch-quarantine.js";

/** Main's known failures, re-exported from main-known-failures.ts, where they live beside the
 * red-spell and known-failure maps they read — this module holds only the watch itself. Kept
 * here so the review gate and the main-watch tests import the reads from the watch's long-standing
 * public home. */
export { knownMainFailures, onlyKnownMainFailures } from "./main-known-failures.js";

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
 * `idle()` waits for both, plus housekeeping. The red-spell and known-failure maps it settles
 * live in main-known-failures.ts (their data home), which also holds `knownMainFailures` /
 * `onlyKnownMainFailures`; this module re-exports those two reads from there. */
interface MainWatch {
  /** Look at main's head; starts a background watch run when it is unwatched and none is in
   * flight. `held` (a restart pending, or the disk hold) starts nothing; `config` is the live
   * one. Never throws, never waits for the run. */
  poll(mainHead: string, held: boolean, config: TumwaterConfig): void;
  /** Resolves when no watch run is in flight — a test seam. */
  idle(): Promise<void>;
}

/** One main watch for a root: the poll entry point the orchestrator calls each cycle, over the
 * shared state newMainWatchState builds (main-watch-state.ts) and the three concern modules the
 * passes live in. `onCulprit` receives each fresh red's bisected opener; `now` is the clock the
 * full check's due decision reads. */
export function createMainWatch(
  root: string,
  mainBranch: string,
  onCulprit?: (culprit: MainCulprit) => void,
  /** The clock the full check's due decision reads (Hourly full check, part 2b/4); defaults to
   * the real wall clock. Tests advance it to cross the interval. The `checkedAt` stamp a full
   * run carries stays real time (part 2a/4). */
  now: () => number = Date.now,
): MainWatch {
  // The shared state of this watch (main-watch-state.ts): the three concern modules
  // (main-watch-full.ts, main-watch-rules.ts, main-watch-quarantine.ts) read and write the 10
  // vars through this object instead of closing over them, so each concern reads from one named
  // module rather than one 481-line closure that answers all three at once.
  const state = newMainWatchState();

  /** Start the due full-check pass behind its own in-flight guard, so a slow full run never
   * holds the `_gate-main` mirror a later poll's rules pass or a gate's main-tip verdict needs.
   * (Hourly full check, part 2c/4) */
  function startFullPass(mainHead: string, config: TumwaterConfig, fullDue: boolean): void {
    if (detectBuildCheck(root, config) && !state.fullInFlight && (mainHead !== state.lastWatched || fullDue)) {
      const previous = state.lastWatched;
      state.fullInFlight = fullPass(root, mainBranch, state, onCulprit, now, previous, config)
        .catch((err: unknown) => {
          // A failed full pass (main unreadable, checkout refused) records nothing and is not
          // retried until main moves, so a persistent failure warns once per head.
          markWatched(state, mainHead);
          warnCouldNotCheck(root, state, mainHead, err);
        })
        .finally(() => {
          state.fullInFlight = null;
        });
    }
  }

  return {
    poll(mainHead, held, config) {
      startQuarantineHousekeeping(root, state, held);
      if (held || mainHead === "") return;
      const rulesCovered = state.lastRulesWatched === mainHead;
      const fullDue = suspendedFullCheckDue(state, mainHead, now);
      if (mainHead === state.lastWatched && rulesCovered && !fullDue) return;
      startRulesPass(root, mainBranch, state, mainHead, config, rulesCovered);
      startFullPass(mainHead, config, fullDue);
    },
    idle: async () => {
      while (state.rulesInFlight || state.fullInFlight || state.housekeeping) {
        await (state.rulesInFlight ?? state.fullInFlight ?? state.housekeeping);
      }
    },
  };
}
