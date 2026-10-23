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
 * depth and changes nothing. The Nth entry is resolved against `queuedMergeFiles` and the
 * same `topQueuedFile` the by-sha twin shares, so the CLI and the surfaces cannot drift on
 * what topping means. */
export function moveQueuedMergeToTop(root: string, position: number): TopQueuedOutcome {
  const files = queuedMergeFiles(root);
  if (position < 1 || position > files.length) return { status: "out-of-range", depth: files.length };
  return topQueuedFile(root, files, position - 1);
}

/** Move the post-position body of a top move to the head of the execution order: the same
 * rename-and-event work both the position and by-sha variants share. `index` is a 0-based
 * index into `files`. Position 1 (index 0) reports `already-first` and changes nothing. The
 * move is one rename: the entry JSON is never rewritten, so every field (`enqueuedAt`,
 * `notBefore`, `retry`, `revisionRound`, `priorReview`) is unchanged; giving the file a
 * stamp one below the queue's readable minimum sorts it first (falling back to `Date.now()`
 * when no stamp parses), stepping one lower while the destination exists (a concurrent
 * writer may have just taken the name we computed). One `merge_topped` event is logged under
 * the entry's role. The rename is guarded: if the target vanished between the list and the
 * rename (a concurrent drain took the change), the move answers `gone` and changes nothing
 * rather than throwing. No lock and no pin write: the module mirrors merge-cancel.ts's "one
 * file per entry, tolerant of a concurrent drop" stance. */
function topQueuedFile(root: string, files: ReturnType<typeof queuedMergeFiles>, index: number): TopQueuedOutcome {
  const target = files[index]!;
  if (index === 0) {
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

/** What moving a queued merge by its pinned sha to the front did: `topped` names the moved
 * entry's role, sha and summary as `TopQueuedOutcome` does; `gone` — a concurrent drain
 * already took the entry, so the client gets data, not an error, in the `/api/queue-cancel`
 * gone idiom. */
export type TopQueuedByShaOutcome = TopQueuedOutcome | { status: "gone" };

/** Move the queued merge whose entry's pinned sha is `sha` to the head of the queue (the
 * browser twin of `tumwater queue --top <n>`, resolving by sha because the dashboard rows
 * carry one). An entry whose sha matches none is `{ status: "gone" }` and changes nothing;
 * otherwise it runs the same `topQueuedFile` the position variant uses. */
export function moveQueuedMergeToTopBySha(root: string, sha: string): TopQueuedByShaOutcome {
  const files = queuedMergeFiles(root);
  const i = files.findIndex((q) => q.entry.sha.toLowerCase() === sha.toLowerCase());
  if (i < 0) return { status: "gone" };
  return topQueuedFile(root, files, i);
}
