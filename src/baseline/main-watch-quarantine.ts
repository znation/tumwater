import { warnEventBestEffort, TUMWATER_SOURCE } from "../events/events.js";
import { errorMessage } from "../text/text.js";
import { fileQuarantineBugsOnMain } from "../backlog/backlog-file-bugs.js";
import { closeQuietBugWaitsOnMain } from "../backlog/backlog-bug-waits.js";
import { BUGFIX_WAIT_QUIET_DAYS } from "../roles/role-guidance.js";
import {
  loadQuarantine,
  markQuarantineFiled,
  releaseQuarantine,
} from "../review/known-flakes.js";
import type { MainWatchState } from "./main-watch-state.js";

/** Concern C: the quarantine housekeeping — release the quarantined tests whose bug left
 * `## Open`, file the bugs of newly quarantined ones on main, and close the bugs whose bugfix
 * wait went quiet (backlog-bug-waits.ts). Fully independent of the two check passes: it never
 * touches `lastWatched` or the cadence vars, only its own in-flight slot and its two
 * once-per-reason warning dedup keys. */

/** Release quarantined tests whose bug left `## Open`, file the bugs of newly quarantined
 * ones on main — recording a filed test's new flake under its bug when that bug waits for one —
 * and close the bugs whose bugfix wait went quiet (backlog-bug-waits.ts). A write the primary
 * checkout cannot take warns (once per reason) and is retried on a later poll. Never throws. */
export async function settleQuarantine(root: string, state: MainWatchState): Promise<void> {
  try {
    const released = releaseQuarantine(root);
    if (released.length > 0) {
      warnEventBestEffort(
        root,
        TUMWATER_SOURCE,
        `quarantine released ${released.join(", ")}: its BUGS.md entry is no longer open`,
      );
    }
    await filePendingQuarantine(root, state);
    await closeQuietWaits(root, state);
  } catch (err: unknown) {
    warnEventBestEffort(root, TUMWATER_SOURCE, `quarantine housekeeping failed: ${errorMessage(err)}`);
  }
}

/** File the quarantined tests no bug has heard of yet: new ones, and filed ones marked
 * `recurred`. */
async function filePendingQuarantine(root: string, state: MainWatchState): Promise<void> {
  const pending = loadQuarantine(root).filter((e) => e.bug === "" || e.recurred === true);
  if (pending.length === 0) return;
  const outcome = await fileQuarantineBugsOnMain(root, pending);
  if (outcome.status === "filed") {
    markQuarantineFiled(root, outcome.bugs);
    state.lastFilingWarning = "";
    return;
  }
  if (outcome.reason !== state.lastFilingWarning) {
    state.lastFilingWarning = outcome.reason;
    warnEventBestEffort(
      root,
      TUMWATER_SOURCE,
      `quarantined flaky tests are not filed in BUGS.md yet: ${outcome.reason}`,
    );
  }
}

/** Close the bugs whose bugfix wait saw no recurrence for BUGFIX_WAIT_QUIET_DAYS, naming them in
 * one warning; a close the primary checkout cannot take warns once per reason. */
async function closeQuietWaits(root: string, state: MainWatchState): Promise<void> {
  const outcome = await closeQuietBugWaitsOnMain(root);
  if (outcome.status === "closed") {
    state.lastCloseWarning = "";
    warnEventBestEffort(
      root,
      TUMWATER_SOURCE,
      `closed ${outcome.titles.join("; ")}: its bugfix wait saw no recurrence in ` +
        `${BUGFIX_WAIT_QUIET_DAYS} days`,
    );
    return;
  }
  if (outcome.status === "skipped" && outcome.reason !== state.lastCloseWarning) {
    state.lastCloseWarning = outcome.reason;
    warnEventBestEffort(
      root,
      TUMWATER_SOURCE,
      `bugs whose bugfix wait went quiet are not closed yet: ${outcome.reason}`,
    );
  }
}

/** Start one quarantine housekeeping pass unless one is already in flight. */
export function startQuarantineHousekeeping(root: string, state: MainWatchState, held: boolean): void {
  if (!held && !state.housekeeping) {
    state.housekeeping = settleQuarantine(root, state).finally(() => {
      state.housekeeping = null;
    });
  }
}
