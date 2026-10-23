/** Operator cancellation of a waiting merge (PLANS.md `tumwater queue --cancel <n>`), split
 * out of merge-queue.ts so the queue stays the pure reader/writer it is: this module owns the
 * destructive half of an unattempted entry — removing the queue file and deleting the role's
 * merge pin so next-run leftover recovery cannot silently re-enqueue the change. It mirrors
 * merge-requeue.ts (the other settled-entry editor living outside merge-queue.ts) and takes no
 * lock: the queue is the inbox idiom (one file per entry, dropMerge tolerant of a concurrent
 * drop) and the pin delete is value-guarded. */
import { queuedMergeFiles, dropMerge, type MergeEntry } from "./merge-queue.js";
import { mergeRefName } from "../paths.js";
import { deleteRefIfAt } from "../git/git.js";
import { logEventBestEffort } from "../events/events.js";

/** What removing the Nth queued merge did: `cancelled` names the removed entry's role, pinned
 * sha and summary (what one `merge_cancelled` event logged); `out-of-range` carries the
 * current readable depth so the caller's failure can name it as the valid range. */
export type CancelQueuedOutcome =
  | { status: "cancelled"; role: string; sha: string; summary: string }
  | { status: "out-of-range"; depth: number };

/** Remove one readable queue entry: delete that role's merge pin first (deleteRefIfAt, a no-op
 * when the ref is gone or names a different sha, so a newer pin is never removed), then drop
 * the queue file (ENOENT already a no-op), logging one `merge_cancelled` event under the role,
 * and return the `cancelled` outcome naming what was removed. The single removal both
 * `cancelQueuedMerge` (by position) and `cancelQueuedMergeBySha` (by sha) share, so the CLI and
 * the dashboard's queue-cancel cannot drift on what cancelling means. */
async function removeQueuedEntry(root: string, target: { entry: MergeEntry; file: string }): Promise<CancelQueuedOutcome> {
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
  return removeQueuedEntry(root, files[position - 1]!);
}

/** What removing a queued merge by its pinned sha did: `cancelled` names the removed entry's
 * role, sha and summary as `CancelQueuedOutcome` does; `gone` — a concurrent drain already
 * took the entry, so the client gets data, not an error, in the `/api/prompt-cancel` gone idiom. */
export type CancelQueuedByShaOutcome = CancelQueuedOutcome | { status: "gone" };

/** Remove the queued merge whose entry's pinned sha is `sha` (the browser twin of
 * `tumwater queue --cancel <n>`, resolving by sha because the dashboard rows carry one). An
 * entry whose sha matches none is `{ status: "gone" }` and changes nothing; otherwise it runs
 * the same `removeQueuedEntry` the position variant uses. */
export async function cancelQueuedMergeBySha(root: string, sha: string): Promise<CancelQueuedByShaOutcome> {
  const target = queuedMergeFiles(root).find((q) => q.entry.sha.toLowerCase() === sha.toLowerCase());
  if (!target) return { status: "gone" };
  return removeQueuedEntry(root, target);
}
