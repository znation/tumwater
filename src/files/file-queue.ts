import fs from "node:fs";
import path from "node:path";
import { errCode } from "../errno.js";

/** The directory-of-timestamped-files queue convention shared by the director's prompt inbox
 * (inbox.ts) and the durable merge queue (merge-queue.ts): one file per entry, ordered by
 * filename across processes and listed by a directory read. Split out because both queues
 * would otherwise carry their own copy of the listing, naming, and ENOENT-tolerant removal
 * rules — exactly the parts that must not drift between the two. */

/** Every entry file under `dir` whose name ends in `ext`, oldest first by filename sort. A
 * missing directory reads as an empty queue, like every reader in both queues. */
export function listQueueFiles(dir: string, ext: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    // The "no queue here" cases — a directory removed between the caller's existence check
    // and this read (ENOENT), or a regular file squatting at the path (ENOTDIR) — read the
    // same empty list a missing directory does, per the contract. Any other error (EACCES:
    // a real but unreadable directory) is a genuine failure the caller must see, never a
    // silently empty queue that would hide queued work.
    const code = errCode(err);
    if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
    return [];
  }
  return entries
    .filter((f) => f.endsWith(ext))
    .sort()
    .map((f) => path.join(dir, f));
}

/** One queue entry's filename: `<stamp>-<seq, 6 digits>-<pid><ext>`. The timestamp orders
 * entries across processes; the per-process counter and pid break ties within one. */
export function queueFileName(stamp: number, seq: number, ext: string): string {
  return `${stamp}-${String(seq).padStart(6, "0")}-${process.pid}${ext}`;
}


/** The epoch-ms stamp queueFileName writes into every entry filename, parsed back out of a
 * listing — the age an entry has waited, read from the name alone with no file content. The
 * leading run must be exactly 13 digits (epoch ms of any instant since 2001-09-09): anything
 * shorter is a hand-placed name the convention does not cover, so `2026-notes.md` reads as
 * unstamped (null) rather than as 2026 ms after the epoch. Returns null for such names, never
 * a guessed date. */
export function queueFileStamp(name: string): number | null {
  const m = /^(\d{13})-/.exec(name);
  return m ? Number(m[1]) : null;
}

/** The queue-file name one stamp below `stamps`' minimum — naming an entry to sort before
 * every listed one, the "move to head" rename both queues share. With no parseable stamps it
 * falls back to just before now (before every hand-placed name). Decrements while the computed
 * name exists on disk, because a concurrent writer may have just taken the name we computed;
 * the pid in queueFileName keeps two concurrent tops' names apart too. `ext` is the queue's own
 * entry extension. The caller hands in its already-listed stamps (parsed with queueFileStamp),
 * not a fresh scan, so the smallest stamp reflects the same read that picked the entry being
 * moved. */
export function lowestStampName(stamps: readonly number[], dir: string, ext: string): string {
  let stamp = (stamps.length > 0 ? Math.min(...stamps) : Date.now()) - 1;
  let file = path.join(dir, queueFileName(stamp, 0, ext));
  while (fs.existsSync(file)) {
    stamp--;
    file = path.join(dir, queueFileName(stamp, 0, ext));
  }
  return file;
}

/** Remove one queue entry's file, reporting whether it was there: true when removed, false
 * when it had already vanished (ENOENT). Any other error is rethrown. Both queues treat a
 * vanished file as a normal race with a concurrent dequeue/cancel, never as a failure. */
export function removeQueueFile(file: string): boolean {
  try {
    fs.rmSync(file);
    return true;
  } catch (err) {
    if (errCode(err) === "ENOENT") return false;
    throw err;
  }
}
