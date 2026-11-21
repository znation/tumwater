import { baselineCache } from "./main-baseline.js";
import { gitTry } from "../git/git-run.js";
import { warnEventBestEffort, TUMWATER_SOURCE } from "../events/events.js";
import { errorMessage } from "../text/text.js";

/** The shared mutable state of one `createMainWatch` instance. The 481-line closure used to
 * hold these 10 vars; the concern modules (main-watch-full.ts, main-watch-rules.ts,
 * main-watch-quarantine.ts) now read and write them through this object instead of closing over
 * them. The three in-flight guards, the cadence trio, the shared verdict cursor, and the three
 * once-per-head dedup keys are the only mutable state the watch carries. */
export interface MainWatchState {
  /** The newest head settled by a full verdict or counted as watched by a pass that makes no
   * verdict. The `lastWatched` cursor the poll's early-return and the full pass's due rule read. */
  lastWatched: string | undefined;
  /** While a full check is suspended for the interval (part 2b/4), or backed off after a full
   * run that made no verdict (FULL_RETRY_BACKOFF_MS), the clock time it becomes due again.
   * `lastWatched` still advances to the tip, so repeat polls of the same head do nothing until
   * this time passes — no duplicate diff-rule warnings every poll — and the poll
   * that crosses it starts the full check on the latest tip. */
  fullCheckDueAt: number | undefined;
  /** The anchor a suspended full check must cover from: the newest full verdict the interval is
   * measured from. It overrides `lastWatched` for the covered-commit count when the check finally
   * runs, so the event reports every commit the skip passed over. */
  fullCheckBase: string | undefined;
  rulesInFlight: Promise<void> | null;
  fullInFlight: Promise<void> | null;
  /** The newest head for which the rules pass has been started, independent of the full pass's
   * `lastWatched`: a rules pass that was busy when a head arrived must still judge that head. */
  lastRulesWatched: string | undefined;
  housekeeping: Promise<void> | null;
  lastFilingWarning: string;
  lastCloseWarning: string;
  /** The head a "main watch could not check main" warning was last logged for: the rules pass
   * and the full pass fail independently, and a broken main must not warn twice for one head. */
  lastFailedWatchHead: string | undefined;
}

/** Build a fresh `MainWatchState` for one `createMainWatch` instance: every in-flight guard
 * and head cursor starts unset, and the two once-per-reason warning strings start empty (the
 * "no reason warned yet" sentinel the quarantine pass compares before re-warning). */
export function newMainWatchState(): MainWatchState {
  return {
    lastWatched: undefined,
    fullCheckDueAt: undefined,
    fullCheckBase: undefined,
    rulesInFlight: null,
    fullInFlight: null,
    lastRulesWatched: undefined,
    housekeeping: null,
    lastFilingWarning: "",
    lastCloseWarning: "",
    lastFailedWatchHead: undefined,
  };
}

/** Count a head as watched and clear the suspended full check (Hourly full check, part 2b/4):
 * the paths that settle a head without a full verdict all advance to that head and leave
 * no suspended check, so they share this instead of re-spelling the three assignments. Three
 * sites cannot use it and keep the assignments spelled: the skipped-interval plan and the
 * no-verdict full run set a due time (not a clear), and the settled-verdict site must read the
 * base before clearing.
 */
export function markWatched(state: MainWatchState, head: string): void {
  state.lastWatched = head;
  state.fullCheckDueAt = undefined;
  state.fullCheckBase = undefined;
}

/** Whether a suspended full check has come due on this head: its clock deadline has passed, or
 * another check (the gate's main-tip attribution) recorded that same head red. A red is settled
 * and healed at once, never held back by the interval. */
export function suspendedFullCheckDue(state: MainWatchState, mainHead: string, now: () => number): boolean {
  return (
    state.fullCheckDueAt !== undefined &&
    (now() >= state.fullCheckDueAt || baselineCache.get(mainHead)?.status === "red")
  );
}

/** Warn that a watch pass could not check `mainHead`, once per head: both passes share this
 * so an unreadable main (both throw) produces one warning, not two. */
export function warnCouldNotCheck(root: string, state: MainWatchState, mainHead: string, err: unknown): void {
  if (state.lastFailedWatchHead === mainHead) return;
  state.lastFailedWatchHead = mainHead;
  warnEventBestEffort(root, TUMWATER_SOURCE, `main watch could not check main: ${errorMessage(err)}`);
}

/** The checked-out head of a worktree. The one pure helper both concern passes share — the
 * rules pass and the full pass each read the tip of their own mirror through it. */
export async function headOf(wt: string): Promise<string> {
  return ((await gitTry(wt, "rev-parse", "HEAD")) ?? "").trim();
}
