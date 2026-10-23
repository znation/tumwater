/** Operator cancellation of a waiting merge (PLANS.md `tumwater queue --cancel <n>`), split
 * out of merge-queue.ts so the queue stays the pure reader/writer it is: this module owns the
 * destructive half of an unattempted entry — removing the queue file and deleting the role's
 * merge pin so next-run leftover recovery cannot silently re-enqueue the change. It mirrors
 * merge-requeue.ts (the other settled-entry editor living outside merge-queue.ts) and takes no
 * lock: the queue is the inbox idiom (one file per entry, dropMerge tolerant of a concurrent
 * drop) and the pin delete is value-guarded. */
import { queuedMergeFiles, dropMerge } from "./merge-queue.js";
import { mergeRefName } from "../paths.js";
import { deleteRefIfAt } from "../git/git.js";
import { logEventBestEffort } from "../events/events.js";

/** What removing the Nth queued merge did: `cancelled` names the removed entry's role, pinned
 * sha and summary (what one `merge_cancelled` event logged); `out-of-range` carries the
 * current readable depth so the caller's failure can name it as the valid range. */
export type CancelQueuedOutcome =
  | { status: "cancelled"; role: string; sha: string; summary: string }
  | { status: "out-of-range"; depth: number };

/** Remove the Nth queued merge — 1-based, as `tumwater queue` numbers it — and delete that
 * entry's role's merge pin, so next-run leftover recovery finds no pin and no branch-ahead
 * commit and does not re-enqueue the change. `position` is resolved against
 * `queuedMergeFiles` (the same readable, filename-ordered list the queue renderer shows), so
 * the position matches the line `tumwater queue` printed. The pin is deleted first with
 * deleteRefIfAt (a no-op when the ref is gone or names a different sha, so a newer pin is
 * never removed), then the queue file is dropped (ENOENT already a no-op). Logs one
 * `merge_cancelled` event under the role. Out-of-range changes nothing and returns the
 * current readable depth. */
export async function cancelQueuedMerge(root: string, position: number): Promise<CancelQueuedOutcome> {
  const files = queuedMergeFiles(root);
  if (position < 1 || position > files.length) return { status: "out-of-range", depth: files.length };
  const target = files[position - 1]!;
  await deleteRefIfAt(root, mergeRefName(target.entry.role), target.entry.sha);
  dropMerge(target.file);
  logEventBestEffort(root, {
    source: target.entry.role,
    type: "merge_cancelled",
    commit: target.entry.sha,
    summary: target.entry.summary,
  });
  return { status: "cancelled", role: target.entry.role, sha: target.entry.sha, summary: target.entry.summary };
}
