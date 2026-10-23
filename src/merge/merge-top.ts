/** Operator reordering of a waiting merge (PLANS.md `tumwater queue --top <n>`): moving the
 * Nth queued merge to the head of the execution order. Split out of merge-queue.ts so the
 * queue stays the pure reader/writer it is: this module owns the reorder half of an
 * unattempted entry, renaming its queue file to a stamp one below the queue's minimum — the
 * merge-queue twin of inbox-top.ts (which does the same for the prompt queue). It mirrors
 * inbox-top.ts's rename-and-event pairing and merge-cancel.ts's stance: no lock, one file per
 * entry, tolerant of a concurrent drop. */
import path from "node:path";
import fs from "node:fs";
import { logEventBestEffort } from "../events/events.js";
import { errCode } from "../errno.js";
import { queueFileName, queueFileStamp } from "../files/file-queue.js";
import { queuedMergeFiles } from "./merge-queue.js";

/** What moving the Nth queued merge to the front did: `topped` names the moved entry's role,
 * pinned sha and summary (what one `merge_topped` event logged); `already-first` when
 * position 1 is already the head (a no-op the caller prints and exits 0 on); `out-of-range`
 * carries the current readable depth so the caller's failure can name it as the valid range;
 * `gone` when a concurrent drop took the file mid-move, so the caller reports data, not an
 * error (the queue-drain race merge-cancel.ts and inbox-top.ts share). */
export type TopQueuedOutcome =
  | { status: "topped"; role: string; sha: string; summary: string }
  | { status: "already-first"; role: string; sha: string; summary: string }
  | { status: "out-of-range"; depth: number }
  | { status: "gone" };

/** Move the Nth queued merge — 1-based, as `tumwater queue` numbers it and `--cancel`
 * resolves it — to the head of the execution order, so it is the next due entry the queue
 * takes when ready. Position 1 reports `already-first` and changes nothing; an out-of-range
 * position (below 1 or past the readable depth) reports `out-of-range` with the current
 * depth and changes nothing. The move is one rename: the entry JSON is never rewritten, so
 * every field (`enqueuedAt`, `notBefore`, `retry`, `revisionRound`, `priorReview`) is
 * unchanged; giving the file a stamp one below the queue's readable minimum sorts it first
 * (falling back to `Date.now()` when no stamp parses), stepping one lower while the
 * destination exists (a concurrent writer may have just taken the name we computed). One
 * `merge_topped` event is logged under the entry's role. The rename is guarded: if the
 * target vanished between the list and the rename (a concurrent drain took the change), the
 * move answers `gone` and changes nothing rather than throwing. No lock and no pin write:
 * the module mirrors merge-cancel.ts's "one file per entry, tolerant of a concurrent drop"
 * stance. */
export function moveQueuedMergeToTop(root: string, position: number): TopQueuedOutcome {
  const files = queuedMergeFiles(root);
  if (position < 1 || position > files.length) return { status: "out-of-range", depth: files.length };
  const target = files[position - 1]!;
  if (position === 1) {
    return {
      status: "already-first",
      role: target.entry.role,
      sha: target.entry.sha,
      summary: target.entry.summary,
    };
  }
  const stamps = files
    .map((q) => queueFileStamp(path.basename(q.file)))
    .filter((s): s is number => s !== null);
  let stamp = (stamps.length > 0 ? Math.min(...stamps) : Date.now()) - 1;
  const dir = path.dirname(target.file);
  let newFile = path.join(dir, queueFileName(stamp, 0, ".json"));
  while (fs.existsSync(newFile)) {
    stamp--;
    newFile = path.join(dir, queueFileName(stamp, 0, ".json"));
  }
  try {
    fs.renameSync(target.file, newFile);
  } catch (err) {
    // The queue drained the target between our list and this rename (an orchestrator took
    // the change): a concurrent drop is a normal race, never an error — the entry has
    // already left the queue, so there is nothing to top. Any other rename failure is real.
    if (errCode(err) === "ENOENT") return { status: "gone" };
    throw err;
  }
  logEventBestEffort(root, {
    source: target.entry.role,
    type: "merge_topped",
    commit: target.entry.sha,
    summary: target.entry.summary,
  });
  return { status: "topped", role: target.entry.role, sha: target.entry.sha, summary: target.entry.summary };
}
