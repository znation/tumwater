/** Re-queuing a settled merge entry (plans/fast-merge.md "Lever 1"), split out of
 * merge-slot.ts so the kept-change policy reads on its own screen: merge-slot.ts owns the
 * in-flight marker, the per-merge usage accounting, and the write-back that folds an outcome
 * into the authoring role's state and drops its queue entry; this module owns the other half
 * of a settled entry — putting a kept change back on the queue itself. */
import { enqueueMerge, queuedMerges, type MergeEntry } from "./merge-queue.js";
import { RETRIABLE_MERGE_RESULTS } from "./merge-core.js";
import { pinnedRetrySha } from "../runner/runner-leftover.js";
import type { RunnerState } from "../runner/runner-state.js";
import type { RunResult } from "../run/run-outcome.js";
import { logEventBestEffort } from "../events/events.js";

/** How long a re-queued `review_error` change waits before its gate-then-merge task may start. */
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
 * it (not stale, not held, under MERGE_CONFLICT_LIMIT). Anything else, or a pin that is gone,
 * changes nothing — leftover recovery stays the backstop. */
export async function requeueKeptChange(
  root: string,
  mainBranch: string,
  entry: MergeEntry,
  state: RunnerState,
  result: RunResult,
): Promise<void> {
  if (!RETRIABLE_MERGE_RESULTS.has(result)) return;
  const sha = await pinnedRetrySha(root, entry.role, mainBranch, state);
  if (!sha) return;
  if (queuedMerges(root).some((e) => e.role === entry.role)) return;
  enqueueRetry(root, retryEntry(entry, sha, result));
}
