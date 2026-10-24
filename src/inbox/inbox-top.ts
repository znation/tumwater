import path from "node:path";
import { renameSync } from "node:fs";
import { logEventBestEffort, warnEventBestEffort } from "../events/events.js";
import { lowestStampName, queueFileStamp, removeQueueFile } from "../files/file-queue.js";
import { readTextIfExists, writeTextAtomic } from "../files/files.js";
import { roleInboxDir } from "../paths.js";
import { assertQueueFileName } from "./inbox-cancel.js";
import { promptPreview, queuedFileAtPosition, queuedFiles } from "./inbox.js";
import { movePromptImages, stripVanishedImageReferences } from "./inbox-attachments.js";

/** The top half of the prompt queues: moving one queued prompt to the head of its role's
 * inbox (`tumwater prompt --top <n>` and, addressed by queue-file basename, the dashboard's
 * per-row Move to top). Mirrors inbox-cancel.ts (the position-, list-, and file-addressed
 * removal) and inbox-edit.ts (the in-place rewrite): the store — enqueue, list, peek,
 * dequeue, and the shared queuedFileAtPosition resolution and race policy — stays in
 * inbox.ts, and this verb's rename-and-event pairing lives beside the only code that does it. */

/** Outcome of movePromptToTop: `topped` carries the moved prompt's one-line preview (via
 * promptPreview, like the enqueue/cancel/edit siblings), or `gone` when the role dequeued it
 * between listing and rename (a concurrent pop is a normal race, not an error). */
export type TopOutcome = { status: "topped"; preview: string } | { status: "gone" };

/** Outcome of topQueuedFile: TopOutcome's `topped`/`gone`, or `already_first` when the named
 * file is already the queue head — a no-op, never a write, so the first row's absent button
 * is the common case and a race onto the head needs no reorder. */
export type FileTopOutcome = TopOutcome | { status: "already_first" };

/** The rename-and-event pairing behind both address forms, given a resolved queue file: one
 * stamp below the queue's minimum carries the file to the head — its text (and its
 * `tumwater:not-before` marker, which rides in the text) byte-for-byte to the new stem, its
 * image attachments moving to that new stem too (movePromptImages, with
 * stripVanishedImageReferences dropping any already-gone reference) — and one `prompt_topped`
 * event is logged under the role. Returns { status: "gone" } when the file disappears between
 * the caller's listing and the read here (a concurrent pop is a normal race, never an
 * error), sharing the store's takeQueuedFile convention. A failed write of the new queue file
 * moves the attachments back and rethrows, so the prompt stays queued at its old position with
 * its images. */
function moveFileToTop(root: string, role: string, file: string): TopOutcome {
  const text = readTextIfExists(file);
  if (text === null) return { status: "gone" }; // Dequeued or cancelled mid-listing.
  // One stamp below the queue's minimum makes the renamed file the oldest (first) entry; a
  // queue with no parseable stamps falls back to now (it is before every hand-placed name).
  const stamps = queuedFiles(root, role)
    .map((f) => queueFileStamp(path.basename(f)))
    .filter((s): s is number => s !== null);
  // A concurrent writer may have just taken a name we computed — step one lower rather than
  // overwrite it; the pid in queueFileName keeps two concurrent tops' names apart too.
  const dir = path.dirname(file);
  const newFile = lowestStampName(stamps, dir, ".md");
  // The attachments travel with the prompt to the new stem, so the fulfil/cancel sweep finds
  // them; a move that could not carry one attachment is warned but never fails the reorder.
  const moved = movePromptImages(file, newFile, text);
  if (moved.problem !== null) warnEventBestEffort(root, role, moved.problem);
  const carried = stripVanishedImageReferences(moved.text).text;
  try {
    writeTextAtomic(newFile, carried);
  } catch (err) {
    // Put the attachments back under the old stem, so the prompt still queued there keeps its
    // images; one failed rename must not stop the others or mask the write error.
    for (const m of moved.moves) {
      try {
        renameSync(m.to, m.from);
      } catch {
        // Best effort: the write error is the one the caller sees.
      }
    }
    throw err;
  }
  removeQueueFile(file);
  logEventBestEffort(root, { source: role, type: "prompt_topped", preview: promptPreview(carried) });
  return { status: "topped", preview: promptPreview(carried) };
}

/** Move the Nth prompt queued for one role — 1-based, as shown by `tumwater prompt --list` —
 * to the head of its queue, so the role dequeues it next. Inbox order is the queue-file name
 * (`queueFileName`'s timestamp stamp), so the only way to make one prompt next is to give it a
 * stamp one below the queue's minimum; the file's text (and its `tumwater:not-before` marker,
 * which rides in the text) is carried byte-for-byte to the new stem, its image attachments
 * move to that new stem too (movePromptImages, with stripVanishedImageReferences dropping any
 * already-gone reference), and one `prompt_topped` event is logged under the role.
 *
 * Throws for out-of-range positions and for position 1 ("already first"), both with no side
 * effects — the moveEntryToTop precedent. Returns { status: "gone" } when the file disappears
 * between listing and rename instead of throwing. The race policy and event live here,
 * sharing the store's takeQueuedFile convention: a vanished file is a normal race, never an
 * error. */
export function movePromptToTop(root: string, role: string, position: number): TopOutcome {
  const file = queuedFileAtPosition(root, role, position);
  if (position === 1) throw new Error(`prompt ${position} is already first`);
  return moveFileToTop(root, role, file);
}

/** Move one queued prompt addressed by its queue-file basename to the head of its role's
 * queue — the file-addressed twin of movePromptToTop, for the dashboard's per-row Move to
 * top affordance: the address is the file itself, so a stale poll can never reorder the
 * wrong prompt. Throws for a name failing queueFileNameProblem (re-checked through
 * assertQueueFileName, so a caller that skips the guard fails closed); a file the role
 * already dequeued answers "gone", and the queue head answers "already_first" with no write.
 * Reuses moveFileToTop's rename-and-event pairing, so both address forms cannot drift. */
export function topQueuedFile(root: string, role: string, name: string): FileTopOutcome {
  assertQueueFileName(name);
  const target = path.join(roleInboxDir(root, role), name);
  const index = queuedFiles(root, role).indexOf(target);
  if (index === -1) return { status: "gone" };
  if (index === 0) return { status: "already_first" };
  return moveFileToTop(root, role, target);
}
