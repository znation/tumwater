/** Re-queuing a settled merge entry (plans/fast-merge.md "Lever 1"), split out of
 * merge-slot.ts so the kept-change policy reads on its own screen: merge-slot.ts owns the
 * in-flight marker, the per-merge usage accounting, and the write-back that folds an outcome
 * into the authoring role's state and drops its queue entry; this module owns the other half
 * of a settled entry — putting a kept change back on the queue itself, either at once (a
 * retriable result) or once main's head moves on (a `main_red` pin). */
import { enqueueMerge, queuedMerges, type MergeEntry } from "./merge-queue.js";
import { RETRIABLE_MERGE_RESULTS } from "./merge-core.js";
import { pinnedRetrySha } from "../runner/runner-leftover.js";
import { branchHead } from "../git/git.js";
import { cachedBaselineVerdict } from "../baseline/main-baseline.js";
import { watchVerdictCovering, type WatchWait } from "../baseline/main-red.js";
import { saveRunnerStateBestEffort, type RunnerState } from "../runner/runner-state.js";
import type { RunResult } from "../run/run-outcome.js";
import { logEventBestEffort, warnEventBestEffort } from "../events/events.js";
import { errorMessage } from "../text/text.js";

/** How long a re-queued `review_error` change waits before its verification may start. */
const REVIEW_ERROR_RETRY_MS = 60_000;

/** The queue entry that re-queues a settled one: its run, summary, body, friction flag and
 * revision fields unchanged (so the summary is not a recovery label), the pin's current `sha`,
 * and `retry` naming the result it retries. */
function retryEntry(from: Omit<MergeEntry, "sha">, sha: string, result: string): MergeEntry {
  const { notBefore: _notBefore, retry: _retry, watchWait: _watchWait, ...rest } = from;
  return {
    ...rest,
    sha,
    retry: result,
    retryCount: (from.retryCount ?? 0) + 1,
    enqueuedAt: Date.now(),
    ...(result === "review_error" ? { notBefore: Date.now() + REVIEW_ERROR_RETRY_MS } : {}),
  };
}

function enqueueRetry(root: string, entry: MergeEntry): void {
  enqueueMerge(root, entry);
  logEventBestEffort(root, {
    source: entry.role,
    type: "merge_queued",
    commit: entry.sha,
    summary: entry.summary,
    retry: entry.retry,
  });
}

/** After a settled merge dropped its entry, put a kept change back on the queue itself, so a
 * retry needs no author run (plans/fast-merge.md "Lever 1"). A `merge_blocked`, `review_error`
 * or `merge_conflict` result re-queues at once when its pin survives and pinnedRetrySha allows
 * it (not stale, not held, under MERGE_CONFLICT_LIMIT); a `main_red` pin is recorded on the
 * state with main's head, for requeueMainRedPin to re-queue once main moves to a head with a
 * verdict. A `main_red` change its gate kept for the main watch (`awaitingWatch`, the
 * commit it waits on) is recorded with that commit and the time it was kept, for
 * requeueMainRedPin to re-queue once the watch's verdict covers it. Anything else, or a pin
 * that is gone, changes nothing — leftover recovery stays the backstop. */
export async function requeueKeptChange(
  root: string,
  mainBranch: string,
  entry: MergeEntry,
  state: RunnerState,
  result: RunResult,
  awaitingWatch?: string,
): Promise<void> {
  const isMainRed = result === "main_red";
  if (!isMainRed && !RETRIABLE_MERGE_RESULTS.has(result)) return;
  const sha = await pinnedRetrySha(root, entry.role, mainBranch, state);
  if (!sha) return;
  if (isMainRed) {
    const { sha: _sha, notBefore: _nb, retry: _r, ...rest } = entry;
    const head = (await branchHead(root, mainBranch)) ?? "";
    state.mainRedRetry =
      awaitingWatch === undefined ? { head, entry: rest } : { head, entry: rest, awaitingWatch, waitingSince: Date.now() };
    saveRunnerStateBestEffort(root, state);
    return;
  }
  if (queuedMerges(root).some((e) => e.role === entry.role)) return;
  enqueueRetry(root, retryEntry(entry, sha, result));
}

/** The longest a kept `main_red` pin waits for the main watch's verdict on a moved head before it
 * is re-queued anyway. This bounds the wait when no verdict ever arrives, for example after a
 * watch check that timed out or a restart's cold cache. A pin its gate kept for the watch waits
 * at most this long from the moment it was kept. */
export const MAIN_RED_VERDICT_WAIT_MS = 15 * 60_000;

/** Re-queue a `main_red` pin once main's head differs from the one recorded when its attempt
 * settled (the orchestrator poll calls this for every runner), by the head's cached verdict: a
 * verdict — green or red — re-queues at once; no verdict starts (and saves) a wait at `now`, and
 * the pin re-queues once MAIN_RED_VERDICT_WAIT_MS has passed. A red head no longer holds the pin:
 * the gate judges a change on a red main by the failures main does not share
 * (review-precheck.ts), so waiting for main to turn green would only block a change main's
 * failures cannot explain. Re-queuing clears the record; no entry is queued when the pin is gone
 * or held back by pinnedRetrySha, or the role already has one queued. A pin its gate kept for
 * the main watch (`awaitingWatch`) follows requeueAwaitingWatch's rule instead. It never throws:
 * the poll loop calls it with no catch. */
export async function requeueMainRedPin(
  root: string,
  mainBranch: string,
  state: RunnerState,
  mainHead: string,
  now = Date.now(),
): Promise<void> {
  const kept = state.mainRedRetry;
  if (!kept || mainHead === "") return;
  if (kept.awaitingWatch !== undefined) {
    await requeueAwaitingWatch(root, mainBranch, state, mainHead, now);
    return;
  }
  if (mainHead === kept.head) return;
  if (cachedBaselineVerdict(mainHead) === undefined) {
    if (kept.waitingSince === undefined) {
      state.mainRedRetry = { ...kept, waitingSince: now };
      saveRunnerStateBestEffort(root, state);
      return;
    }
    if (now - kept.waitingSince < MAIN_RED_VERDICT_WAIT_MS) return;
  }
  await requeueKeptPin(root, mainBranch, state);
}

/** requeueMainRedPin for a change its gate kept for the main watch (`awaitingWatch`): re-queue
 * it once the watch's newest observed verdict at or below main's head covers the commit it
 * waits on (main-red.ts's watchVerdictCovering), or once MAIN_RED_VERDICT_WAIT_MS has passed
 * since it was kept. Main need not move first: the watch often catches up on the same head. The
 * re-queued entry carries which of the two happened (MergeEntry.watchWait), so its gate does not
 * wait again. A record without a start time (from before this field) starts its wait now. */
async function requeueAwaitingWatch(
  root: string,
  mainBranch: string,
  state: RunnerState,
  mainHead: string,
  now: number,
): Promise<void> {
  const kept = state.mainRedRetry;
  if (kept?.awaitingWatch === undefined) return;
  const { covers } = await watchVerdictCovering(root, mainHead, kept.awaitingWatch);
  if (!covers) {
    if (kept.waitingSince === undefined) {
      state.mainRedRetry = { ...kept, waitingSince: now };
      saveRunnerStateBestEffort(root, state);
      return;
    }
    if (now - kept.waitingSince < MAIN_RED_VERDICT_WAIT_MS) return;
  }
  await requeueKeptPin(root, mainBranch, state, covers ? "covered" : "timed_out");
}

/** Clear the kept `main_red` record and put its pin back on the queue — unless the pin is gone,
 * pinnedRetrySha holds it back, or the role already has an entry queued. `watchWait` marks the
 * re-queue of a change that waited for the main watch. Never throws: a failed enqueue warns. */
async function requeueKeptPin(root: string, mainBranch: string, state: RunnerState, watchWait?: WatchWait): Promise<void> {
  const kept = state.mainRedRetry;
  if (!kept) return;
  state.mainRedRetry = undefined;
  saveRunnerStateBestEffort(root, state);
  const sha = await pinnedRetrySha(root, kept.entry.role, mainBranch, state);
  if (!sha || queuedMerges(root).some((e) => e.role === kept.entry.role)) return;
  try {
    enqueueRetry(root, { ...retryEntry(kept.entry, sha, "main_red"), ...(watchWait !== undefined ? { watchWait } : {}) });
  } catch (err) {
    warnEventBestEffort(root, kept.entry.role, `the kept main_red change could not be re-queued: ${errorMessage(err)}`);
  }
}
