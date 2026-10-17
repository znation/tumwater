// vocabulary: plain
import path from "node:path";
import { existsSync } from "node:fs";
import { logEventBestEffort, warnEventBestEffort } from "../events/events.js";
import { queueFileName, queueFileStamp, removeQueueFile } from "../files/file-queue.js";
import { readTextIfExists, writeTextAtomic } from "../files/files.js";
import { promptPreview, queuedFileAtPosition, queuedFiles } from "./inbox.js";
import { movePromptImages, stripVanishedImageReferences } from "./inbox-attachments.js";

/** The top half of the prompt queues: moving one queued prompt to the head of its role's
 * inbox (`tumwater prompt --top <n>`). Mirrors inbox-cancel.ts (the position- and
 * list-addressed removal) and inbox-edit.ts (the in-place rewrite): the store — enqueue,
 * list, peek, dequeue, and the shared queuedFileAtPosition resolution and race policy — stays
 * in inbox.ts, and this verb's reorder-and-event pairing lives beside the only code that does
 * it. */

/** Outcome of movePromptToTop: `topped` carries the moved prompt's one-line preview (via
 * promptPreview, like the enqueue/cancel/edit siblings), or `gone` when the loop dequeued it
 * between listing and rename (a concurrent pop is a normal race, not an error). */
export type TopOutcome = { status: "topped"; preview: string } | { status: "gone" };

/** Move the Nth prompt queued for one loop — 1-based, as shown by `tumwater prompt --list` —
 * to the head of its queue, so the loop dequeues it next. Inbox order is the queue-file name
 * (`queueFileName`'s timestamp stamp), so the only way to make one prompt next is to give it a
 * stamp one below the queue's minimum; the file's text (and its `tumwater:not-before` marker,
 * which rides in the text) is carried byte-for-byte to the new stem, its image attachments
 * move to that new stem too (movePromptImages, with stripVanishedImageReferences dropping any
 * already-gone reference), and one `prompt_topped` event is logged under the loop.
 *
 * Throws for out-of-range positions and for position 1 ("already first"), both with no side
 * effects — the moveEntryToTop precedent. Returns { status: "gone" } when the file disappears
 * between listing and rename instead of throwing. The race policy and event live here, sharing
 * the store's takeQueuedFile convention: a vanished file is a normal race, never an error. */
export function movePromptToTop(root: string, role: string, position: number): TopOutcome {
  const file = queuedFileAtPosition(root, role, position);
  if (position === 1) throw new Error(`prompt ${position} is already first`);
  const text = readTextIfExists(file);
  if (text === null) return { status: "gone" }; // Dequeued or cancelled mid-listing.
  // One stamp below the queue's minimum makes the renamed file the oldest (first) entry; a
  // queue with no parseable stamps falls back to now (it is before every hand-placed name).
  const stamps = queuedFiles(root, role)
    .map((f) => queueFileStamp(path.basename(f)))
    .filter((s): s is number => s !== null);
  let stamp = (stamps.length > 0 ? Math.min(...stamps) : Date.now()) - 1;
  const dir = path.dirname(file);
  let newFile = path.join(dir, queueFileName(stamp, 0, ".md"));
  // A concurrent writer may have just taken a name we computed — step one lower rather than
  // overwrite it; the pid in queueFileName keeps two concurrent tops' names apart too.
  while (existsSync(newFile)) {
    stamp--;
    newFile = path.join(dir, queueFileName(stamp, 0, ".md"));
  }
  // The attachments travel with the prompt to the new stem, so the fulfil/cancel sweep finds
  // them; a move that could not carry one attachment is warned but never fails the reorder.
  const moved = movePromptImages(file, newFile, text);
  if (moved.problem !== null) warnEventBestEffort(root, role, moved.problem);
  const carried = stripVanishedImageReferences(moved.text).text;
  writeTextAtomic(newFile, carried);
  removeQueueFile(file);
  logEventBestEffort(root, { source: role, type: "prompt_topped", preview: promptPreview(carried) });
  return { status: "topped", preview: promptPreview(carried) };
}
