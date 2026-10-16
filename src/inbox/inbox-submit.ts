// vocabulary: plain
import { enqueueRolePrompt, promptPreview } from "./inbox.js";
import { unlinkAllMissingTolerant } from "../files/files.js";
import {
  imageReferenceLines,
  promptImagesProblem,
  savePromptImages,
  type PromptImageInput,
} from "./inbox-attachments.js";
import { logEventBestEffort } from "../events/events.js";
import { INITIAL_PROMPT_MAX_CHARS } from "../brief/brief.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";
import { tooLongMessage } from "../text/text.js";
import { defaultConfig, loadConfigSafe } from "../config/config.js";
import { roleImageInfo } from "../agent/image-input.js";
import { readImageProbeCache } from "../doctor/image-probe.js";
import { roleLabel } from "../roles/role-labels.js";

/** The user-facing submission pipeline for the prompt queues (the store's mechanics —
 * listing, peeking, dequeuing, cancelling, and their race policy — live in src/inbox/inbox.ts,
 * and the image side of a submission in src/inbox/inbox-attachments.ts): the shared length cap,
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
 * gui-server-transport test pins. */
export function promptLengthProblem(text: string, role: string = DIRECTOR_ROLE): string | null {
  const prompt = text.trim();
  if (prompt.length <= DIRECTOR_PROMPT_MAX_CHARS) return null;
  return tooLongMessage(
    "the prompt",
    prompt.length,
    DIRECTOR_PROMPT_MAX_CHARS,
    `it rides into the ${roleLabel(role)} run's prefill`,
  );
}

/** The image-input submit guidance for one loop (plans/image-input.md "Surfaces" and
 * "Attachments", part 5/5): what an image-carrying prompt to `role` means. `refusal` is the
 * throw-and-submit-nothing message when the loop's seam reads no images and no peer tier can
 * (an attachment no configured model can read is refused at submit, not discovered at tick
 * time); `notice` is what a surface prints/shows when the prompt will instead rerun on another
 * tier. Both null when the loop's own model reads images (or capability is unknown — an
 * unknown seam is never assumed incapable, mirroring the doctor's `tier models` stance), so
 * the common text-only or vision path says nothing. One resolver (roleImageInfo), shared with
 * the status rows and role page, so the gate cannot disagree with what `tumwater role` or the
 * images alert claim. */
export function imagePromptGuidance(root: string, role: string): { refusal?: string; notice?: string } {
  const { config } = loadConfigSafe(root);
  const cfg = config ?? defaultConfig();
  // The same probe cache the status rows, role page, and images alert read (roleImageInfo's
  // fourth argument): a claimed pi model whose doctor probe failed reads text-only here too,
  // so the gate never grants image capability that the surfaces report as absent.
  const { imageInput, imageReroute } = roleImageInfo(cfg, role, undefined, readImageProbeCache(root));
  if (imageInput !== false) return {};
  if (imageReroute) {
    return {
      notice: `${role}'s model can't read images; this prompt runs on ${imageReroute}`,
    };
  }
  return {
    refusal: `${role}'s model can't read images and no configured model reads images for it — declare image input on a vision model in pi's models.json, or point a tier at one`,
  };
}

/** A user submits a new prompt for one loop (TUI, GUI, or CLI): enqueue it there and record it
 * in the event log under that loop, best-effort — the queue write is the durable effect the
 * caller asked for, so an unwritable feed must not report the submit as failed. Returns the
 * trimmed prompt that was queued. The logged
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
    // Image input gate (plans/image-input.md "Attachments", part 5/5): an attachment no
    // configured model can read is refused here, before anything is queued or written — the
    // tick would only fail discovering it. A loop that reroutes a blind read is not refused;
    // the surface prints/shows the notice instead (imagePromptGuidance is called again there).
    const guidance = imagePromptGuidance(root, role);
    if (guidance.refusal) throw new Error(guidance.refusal);
    return submitPromptWithImages(root, role, text, images, notBeforeMs);
  }
  const prompt = text.trim();
  enqueueRolePrompt(root, role, prompt, notBeforeMs);
  logEventBestEffort(root, { source: role, type: "prompt_enqueued", preview: promptPreview(prompt) });
  return prompt;
}

/** submitRolePrompt's image-carrying path: save each image beside the queue file and queue the
 * text with one reference line per image. The images are saved and the reference lines
 * composed inside enqueueRolePrompt's decorate hook — a single atomic write, so the queue
 * file is born complete: no poller can read a prompt whose image lines point at
 * not-yet-written files, and a concurrent cancel's sibling sweep cannot race the writes. The
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
  logEventBestEffort(root, { source: role, type: "prompt_enqueued", preview: promptPreview(final) });
  return final;
}

/** A user submits a new director prompt; see submitRolePrompt. The optional `notBeforeMs` is
 * the director-queue twin of submitRolePrompt's deferral (PLANS.md "tumwater prompt --at
 * <duration>"). */
export function submitPrompt(root: string, text: string, images?: PromptImageInput[], notBeforeMs?: number): string {
  return submitRolePrompt(root, DIRECTOR_ROLE, text, images, notBeforeMs);
}
