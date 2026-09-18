import fs from "node:fs";
import path from "node:path";

/** The directory-of-timestamped-files queue convention shared by the director's prompt inbox
 * (inbox.ts) and the durable land queue (land-queue.ts): one file per entry, ordered by
 * filename across processes and listed by a directory read. Split out because both queues
 * would otherwise carry their own copy of the listing, naming, and ENOENT-tolerant removal
 * rules — exactly the parts that must not drift between the two. */

/** Every entry file under `dir` whose name ends in `ext`, oldest first by filename sort. A
 * missing directory reads as an empty queue, like every reader in both queues. */
export function listQueueFiles(dir: string, ext: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(ext))
    .sort()
    .map((f) => path.join(dir, f));
}

/** One queue entry's filename: `<stamp>-<seq, 6 digits>-<pid><ext>`. The timestamp orders
 * entries across processes; the per-process counter and pid break ties within one. */
export function queueFileName(stamp: number, seq: number, ext: string): string {
  return `${stamp}-${String(seq).padStart(6, "0")}-${process.pid}${ext}`;
}

/** Remove one queue entry's file, reporting whether it was there: true when removed, false
 * when it had already vanished (ENOENT). Any other error is rethrown. Both queues treat a
 * vanished file as a normal race with a concurrent dequeue/cancel, never as a failure. */
export function removeQueueFile(file: string): boolean {
  try {
    fs.rmSync(file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}
