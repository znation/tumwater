import { readTextIfExists, unlinkAllMissingTolerant, writeTextAtomic } from "../files/files.js";
import { logEventBestEffort } from "../events/events.js";
import path from "node:path";
import { promptPreview, queuedFileAtPosition } from "./inbox.js";
import {
  imageReferenceLines,
  imageReferencePaths,
  promptImagesCountProblem,
  savePromptImages,
  stripImageReferenceLines,
  type PromptImageInput,
} from "./inbox-attachments.js";
import { promptLengthProblem } from "./inbox-submit.js";
import { assertQueueFileName, listedQueueOutcome, resolveListedQueue, type ListedQueueMiss } from "./inbox-cancel.js";
import { notBeforeMs, notBeforeMarker, stripNotBeforeMarker } from "./prompt-not-before.js";
import { roleInboxDir } from "../paths.js";

/** The edit half of the prompt queues: rewriting one queued prompt's text in place
 * (`tumwater prompt --edit`), by per-loop position or by list-wide position numbering.
 * Mirrors inbox-cancel.ts: the store (enqueue, list, peek, dequeue) stays in inbox.ts and
 * the shared resolveListedQueue lives in inbox-cancel.ts, so edit and cancel cannot drift
 * on how a listed position resolves. Split out of inbox.ts so the store module carries no
 * edit vocabulary and the edit path's event/preview pairing lives beside the only code
 * that pairs them. */

/** Outcome of editRolePrompt: the edited prompt's old and new operator-facing text (the
 * not-before marker stripped from both — the marker is plumbing, not content), or "gone"
 * when the loop dequeued it or another operator cancelled it between listing and write
 * (a concurrent pop is a normal race, not an error). */
export type EditOutcome =
  | { status: "edited"; oldText: string; newText: string }
  | { status: "gone" };

/** Rewrite one queued prompt's file in place — the shared core behind editRolePrompt (address
 * by per-loop position) and editQueuedFile (address by queue-file basename): same queue file
 * (so the filename's enqueue stamp and the entry's position behind older prompts are
 * untouched), same atomic write enqueueRolePrompt uses
 * (writeTextAtomic's temp file + rename, so a concurrent dequeue or another edit can never
 * expose a half-written file), and the existing not-before deferral carried over — when the
 * old file starts with the marker, the new text is written under the same marker; a
 * non-deferred prompt stays marker-free even if the new text's first line resembles a
 * marker. Logs one prompt_edited event under that loop (preview via promptPreview, exactly
 * like its prompt_cancelled sibling) after a successful write, best-effort: the rewrite is
 * the durable effect, so an unwritable feed must not report the edit as failed.
 *
 * Carries an attached prompt's `[image attached: …]` reference lines (and so their sibling
 * files) over the rewrite — the edit replaces the prompt's text, not its attachments, which
 * stay beside the edited queue file until a cancel or the fulfilling tick's sweep removes
 * them. An optional `images` array (the CLI's
 * `prompt --edit … --attach`) appends its newly saved reference lines after the carried ones,
 * so one command corrects the text and the images in place instead of cancel-and-re-queue;
 * the combined count must fit the per-prompt cap, and any throw after the save unlinks the
 * new files again.
 *
 * Enforces the same prefill length cap as a submission (promptLengthProblem): the edited
 * text plus its carried image lines ride into the target tick's prefill exactly like a
 * queued prompt, so an edit to an over-cap value must not bypass the cap every enqueue path
 * applies. The initial text check throws before any read or write; the composed check (body
 * plus carried image lines) throws before the write when the body alone fit.
 *
 * Throws for out-of-range positions with no side effects in editRolePrompt's position form;
 * the image-address form throws for a name failing queueFileNameProblem before touching disk.
 * The race policy pairs with the outcome: the file is read first, and a read that hits ENOENT
 * returns { status: "gone" } —
 * the loop dequeued it or a cancel removed it between listing and write, a normal race
 * exactly like takeCancelledPrompt's; any other read error propagates (a permission failure
 * is not a race). The write itself is unconditional once the read succeeded: a dequeue that
 * lands between that read and the rename is a narrower race than takeQueuedFile's own
 * read-then-remove window, and the atomic rename means every observer sees either the whole
 * old file or the whole new one — never a half-written prompt. */
function editPromptAtFile(root: string, role: string, file: string, newText: string, images?: PromptImageInput[]): EditOutcome {
  // Trim once, then measure and store that one text: promptLengthProblem judges the trimmed
  // value, and submitRolePrompt queues the trimmed value, so writing the raw replacement let
  // whitespace the probe discarded smuggle an over-cap body past the cap.
  const text = newText.trim();
  const lengthProblem = promptLengthProblem(text, role);
  if (lengthProblem) throw new Error(lengthProblem); // Before any read or write, like submitRolePrompt.
  const oldFileText = readTextIfExists(file);
  if (oldFileText === null) return { status: "gone" }; // Dequeued or cancelled mid-listing.
  // The marker is plumbing: the edit replaces only the content beneath it. notBeforeMs
  // reads the writer's exact marker shape, so content that merely resembles a marker is
  // content, and the new text goes in marker-free.
  const deferral = notBeforeMs(oldFileText);
  // The rewritten text carries the prompt's attachments over: only the text is editable, and
  // an edit that dropped the reference lines would leave the image files unreferenced. A
  // non-empty `images` appends its own reference lines after the carried ones, saved beside
  // the same queue file; the combined count is checked before a single file is written, and
  // any throw after those saves unlinks them again — the same unwind submitPromptWithImages
  // uses, so a failed edit strands no images.
  const carriedPaths = imageReferencePaths(oldFileText);
  let savedImagePaths: string[] = [];
  let composed: string;
  try {
    if (images !== undefined && images.length > 0) {
      const countProblem = promptImagesCountProblem(carriedPaths.length + images.length);
      if (countProblem) throw new Error(countProblem); // Before any save.
      const saved = savePromptImages(root, role, file, images);
      if ("problem" in saved) throw new Error(saved.problem);
      savedImagePaths = saved.paths;
    }
    // The composed text is what a tick's prefill receives, so the submission cap covers the
    // body plus every reference line; the carried paths stay first, the new ones append after
    // them in one reference block.
    composed = text + imageReferenceLines([...carriedPaths, ...savedImagePaths]);
    const composedProblem = promptLengthProblem(composed, role);
    if (composedProblem) throw new Error(composedProblem); // Before the write.
    const fileText = (deferral !== null ? notBeforeMarker(deferral) : "") + composed;
    writeTextAtomic(file, fileText);
  } catch (err) {
    unlinkAllMissingTolerant(savedImagePaths);
    throw err;
  }
  const oldText = stripNotBeforeMarker(oldFileText);
  logEventBestEffort(root, { loop: role, type: "prompt_edited", preview: promptPreview(composed) });
  return { status: "edited", oldText, newText: composed };
}

/** Rewrite the Nth prompt queued for one loop — 1-based, as shown by `tumwater prompt
 * --list` — in place, through the shared editPromptAtFile. See that helper for the full
 * contract (deferral carry-over, attachment carry-over, the prompt_edited event, the race
 * policy). */
export function editRolePrompt(root: string, role: string, position: number, newText: string, images?: PromptImageInput[]): EditOutcome {
  return editPromptAtFile(root, role, queuedFileAtPosition(root, role, position), newText, images);
}

/** Rewrite one queued prompt addressed by its queue-file basename — the file-addressed twin of
 * editRolePrompt, for the dashboard's per-row edit affordance (PLANS.md 2026-10-11): the
 * address is the file itself, so a stale poll's snapshot can never rewrite the wrong entry.
 * Same race policy, deferral carry-over, attachment carry-over, and prompt_edited event as
 * editRolePrompt, through the shared editPromptAtFile. Throws for a name failing
 * queueFileNameProblem — the GUI endpoint pre-checks the same guard and answers 400 before
 * anything is touched on disk. */
export function editQueuedFile(root: string, role: string, name: string, newText: string, images?: PromptImageInput[]): EditOutcome {
  assertQueueFileName(name);
  return editPromptAtFile(root, role, path.join(roleInboxDir(root, role), name), newText, images);
}

/** Read one queued prompt's editable body — the text an edit replaces, for the dashboard's
 * edit affordance (PLANS.md 2026-10-11): stripNotBeforeMarker drops the deferral plumbing,
 * stripImageReferenceLines drops the `[image attached: …]` reference block the edit carries
 * over unchanged (so it is never shown in the editor and cannot be edited away), and trimEnd
 * drops any blank lines left behind. null when the file is gone — the loop dequeued it or
 * another operator cancelled it, which the endpoint reports as { status: "gone" } rather than
 * an error. Throws for a name failing queueFileNameProblem. Reading the one named file directly
 * keeps the dashboard's lazy fetch off the per-poll path. */
export function readQueuedPromptBody(root: string, role: string, name: string): string | null {
  assertQueueFileName(name);
  const text = readTextIfExists(path.join(roleInboxDir(root, role), name));
  if (text === null) return null;
  return stripImageReferenceLines(stripNotBeforeMarker(text)).trimEnd();
}

/** Outcome of editListedPrompt: a resolved edit (naming the loop it landed in, since the
 * caller scoped nothing), an ambiguity, or a miss across every loop it scoped. */
export type ListedEditOutcome =
  | { status: "edited"; role: string; outcome: EditOutcome }
  | ListedQueueMiss;

/** Edit by the position numbering `tumwater prompt --list` prints with no --role: the same
 * candidate resolution cancelListedPrompt uses — resolveListedQueue, in inbox-cancel.ts, so
 * the two cannot drift — followed by editRolePrompt in the resolved loop. One loop holding
 * the position resolves, several are an ambiguity the caller reports with a --role escape
 * hatch, none is a miss carrying the largest queue length for the error's count. */
export function editListedPrompt(root: string, scope: string[], position: number, newText: string, images?: PromptImageInput[]): ListedEditOutcome {
  const resolved = resolveListedQueue(root, scope, position);
  return listedQueueOutcome(resolved, (role) => ({
    status: "edited",
    role,
    outcome: editRolePrompt(root, role, position, newText, images),
  }));
}
