import { enqueueRolePrompt, promptPreview } from "./inbox.js";
import { unlinkAllMissingTolerant } from "../files.js";
import {
  imageReferenceLines,
  promptImagesProblem,
  savePromptImages,
  type PromptImageInput,
} from "./inbox-attachments.js";
import { logEvent } from "../events/events.js";
import { INITIAL_PROMPT_MAX_CHARS } from "../readme.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";
import { tooLongMessage } from "../text.js";

/** The user-facing submission pipeline for the prompt queues (the store's mechanics —
 * listing, peeking, dequeuing, cancelling, and their race policy — live in src/inbox/inbox.ts,
 * and the image side of a submission in src/inbox-attachments.ts): the shared length cap,
 * the validation, and the submit wrappers the TUI, GUI, and CLI all go through. */

/** Cap on a submitted prompt's length: the same ceiling for every loop's queue, director and
 * role alike, because every prompt rides into its target tick's prefill — a megabyte pasted
 * into the TUI, a GUI POST, or a shell-mistaken `tumwater prompt $(cat …)` would otherwise
 * ride into the next tick's context wholesale. submitPrompt and submitRolePrompt reject
 * over-long text before it is queued, so no surface can enqueue it. */
export const DIRECTOR_PROMPT_MAX_CHARS = INITIAL_PROMPT_MAX_CHARS;

/** The one length rule for a submitted prompt, scoped to the loop it targets: the error
 * message when the trimmed text exceeds DIRECTOR_PROMPT_MAX_CHARS, null when it fits. The
 * message names the target loop's tick — `--role qa` must not be told its text rides into
 * the director's prefill. submitPrompt/submitRolePrompt throw it before anything is queued
 * or logged; the GUI asks it first so an over-long prompt answers 400 (a user-input error)
 * while an unexpected submit failure (a broken inbox's EACCES) stays the 500 its
 * gui-server test pins. */
export function promptLengthProblem(text: string, role: string = DIRECTOR_ROLE): string | null {
  const prompt = text.trim();
  if (prompt.length <= DIRECTOR_PROMPT_MAX_CHARS) return null;
  return tooLongMessage(
    "the prompt",
    prompt.length,
    DIRECTOR_PROMPT_MAX_CHARS,
    `it rides into the ${role} tick's prefill`,
  );
}

/** A user submits a new prompt for one loop (TUI, GUI, or CLI): enqueue it there and record it
 * in the event log under that loop. Returns the trimmed prompt that was queued. The logged
 * preview goes through promptPreview — not a raw slice — so an over-long prompt is marked with
 * an ellipsis like every other label and never carries a lone surrogate at the cut point.
 * Throws (before anything is queued or logged) when the trimmed prompt exceeds
 * DIRECTOR_PROMPT_MAX_CHARS (promptLengthProblem's message) — callers report it to their
 * operator. An optional images array (the GUI composer's drop/paste attachments) rides
 * through savePromptImages beside the queue file, with one [image attached: …] reference line
 * appended to the queued text; image problems throw before anything is queued — and so does
 * an over-cap composed text: the reference lines ride into the tick's prefill just like the
 * prompt body, so the length cap is enforced on the final text (body + image lines), not the
 * body alone.
 * An optional `notBeforeMs` defers the prompt (PLANS.md "tumwater prompt --at <duration>"):
 * it rides into enqueueRolePrompt's one atomic write as the queue file's marker line. */
export function submitRolePrompt(
  root: string,
  role: string,
  text: string,
  images?: PromptImageInput[],
  notBeforeMs?: number,
): string {
  const problem = promptLengthProblem(text, role);
  if (problem) throw new Error(problem);
  if (images && images.length > 0) {
    const imageProblem = promptImagesProblem(images);
    if (imageProblem) throw new Error(imageProblem);
    return submitPromptWithImages(root, role, text, images, notBeforeMs);
  }
  const prompt = text.trim();
  enqueueRolePrompt(root, role, prompt, notBeforeMs);
  logEvent(root, { loop: role, type: "prompt_enqueued", preview: promptPreview(prompt) });
  return prompt;
}

/** submitRolePrompt's image-carrying path: save each image beside the queue file and queue the
 * text with one reference line per image. The images are saved and the reference lines
 * composed inside enqueueRolePrompt's decorate hook — a single atomic write, so the queue
 * file is born complete: no poller can read a prompt whose image lines point at
 * not-yet-written files, and the dequeuer's sibling cleanup cannot race the writes. The
 * images were validated before the enqueue (submitRolePrompt above), so savePromptImages's
 * own re-check failing here is unreachable — and if it ever fired, the decorate throw
 * happens before writeTextAtomic, leaving no queue file behind at all. */
function submitPromptWithImages(root: string, role: string, text: string, images: PromptImageInput[], notBeforeMs?: number): string {
  const prompt = text.trim();
  let final = prompt;
  let savedImagePaths: string[] = [];
  try {
    enqueueRolePrompt(root, role, prompt, notBeforeMs, (file) => {
      const saved = savePromptImages(root, role, file, images);
      if ("problem" in saved) throw new Error(saved.problem); // Unreachable: validated above.
      savedImagePaths = saved.paths;
      final = prompt + imageReferenceLines(saved.paths);
      // The image reference lines ride into the target tick's prefill exactly like the
      // prompt body, so the shared length cap applies to the composed text, not the body
      // alone. This runs inside the decorate hook, before enqueueRolePrompt's one atomic
      // write, so an over-cap composition queues nothing; the images saved above are
      // removed again, since with no queue file nothing will ever dequeue them.
      const lengthProblem = promptLengthProblem(final, role);
      if (lengthProblem) throw new Error(lengthProblem);
      return final;
    });
  } catch (err) {
    unlinkAllMissingTolerant(savedImagePaths);
    throw err;
  }
  logEvent(root, { loop: role, type: "prompt_enqueued", preview: promptPreview(final) });
  return final;
}

/** A user submits a new director prompt; see submitRolePrompt. */
export function submitPrompt(root: string, text: string, images?: PromptImageInput[]): string {
  return submitRolePrompt(root, DIRECTOR_ROLE, text, images);
}
