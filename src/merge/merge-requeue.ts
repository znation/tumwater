/** Re-queuing a settled merge entry (plans/fast-merge.md "Lever 1"), split out of
 * merge-slot.ts so the kept-change policy reads on its own screen: merge-slot.ts owns the
 * in-flight marker, the per-merge usage accounting, and the write-back that folds an outcome
 * into the authoring role's state and drops its queue entry; this module owns the other half
 * of a settled entry — putting a kept change back on the queue itself, either at once (a
 * retriable result) or once main's head stops being red (a `main_red` pin). */
import { enqueueMerge, queuedMerges, type MergeEntry } from "./merge-queue.js";
import { RETRIABLE_MERGE_RESULTS } from "./merge-core.js";
import { pinnedRetrySha } from "../runner/leftover.js";
import { branchHead } from "../git/git.js";
import { cachedBaselineVerdict } from "../baseline/main-baseline.js";
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
  const { notBefore: _notBefore, retry: _retry, ...rest } = from;
  return {
    ...rest,
    sha,
    retry: result,
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
 * state with main's head, for requeueMainRedPin to re-queue once main moves to a head whose
 * verdict is not red. Anything else, or a pin that is gone, changes nothing — leftover recovery
 * stays the backstop. */
export async function requeueKeptChange(
  root: string,
  mainBranch: string,
  entry: MergeEntry,
  state: RunnerState,
  result: RunResult,
): Promise<void> {
  const isMainRed = result === "main_red";
  if (!isMainRed && !RETRIABLE_MERGE_RESULTS.has(result)) return;
  const sha = await pinnedRetrySha(root, entry.role, mainBranch, state);
  if (!sha) return;
  if (isMainRed) {
    const { sha: _sha, notBefore: _nb, retry: _r, ...rest } = entry;
    state.mainRedRetry = { head: (await branchHead(root, mainBranch)) ?? "", entry: rest };
    saveRunnerStateBestEffort(root, state);
    return;
  }
  if (queuedMerges(root).some((e) => e.role === entry.role)) return;
  enqueueRetry(root, retryEntry(entry, sha, result));
}

/** The longest a kept `main_red` pin waits for the main watch's verdict on a moved head before it
 * is re-queued anyway. This bounds the wait when no verdict ever arrives, for example after a
 * watch check that timed out or a restart's cold cache. */
export const MAIN_RED_VERDICT_WAIT_MS = 15 * 60_000;

/** Re-queue a `main_red` pin once main's head differs from the one recorded when its attempt
 * settled (the orchestrator poll calls this for every runner), by the head's cached verdict: red
 * leaves the record untouched, so a later poll asks again; no verdict starts (and saves) a wait
 * at `now`, and the pin re-queues once MAIN_RED_VERDICT_WAIT_MS has passed; green re-queues at
 * once. Re-queuing clears the record; no entry is queued when the pin is gone or held back by
 * pinnedRetrySha, or the role already has one queued. It never throws: the poll
 * loop calls it with no catch. */
export async function requeueMainRedPin(
  root: string,
  mainBranch: string,
  state: RunnerState,
  mainHead: string,
  now = Date.now(),
): Promise<void> {
  const kept = state.mainRedRetry;
  if (!kept || mainHead === "" || mainHead === kept.head) return;
  const verdict = cachedBaselineVerdict(mainHead);
  if (verdict === "red") return;
  if (verdict === undefined) {
    if (kept.waitingSince === undefined) {
      state.mainRedRetry = { ...kept, waitingSince: now };
      saveRunnerStateBestEffort(root, state);
      return;
    }
    if (now - kept.waitingSince < MAIN_RED_VERDICT_WAIT_MS) return;
  }
  state.mainRedRetry = undefined;
  saveRunnerStateBestEffort(root, state);
  const sha = await pinnedRetrySha(root, kept.entry.role, mainBranch, state);
  if (!sha || queuedMerges(root).some((e) => e.role === kept.entry.role)) return;
  try {
    enqueueRetry(root, retryEntry(kept.entry, sha, "main_red"));
  } catch (err) {
    warnEventBestEffort(root, kept.entry.role, `the kept main_red change could not be re-queued: ${errorMessage(err)}`);
  }
}
