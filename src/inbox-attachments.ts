import fs from "node:fs";
import path from "node:path";
import { errCode } from "./errno.js";
import { roleInboxDir } from "./paths.js";
import { agree } from "./phrases.js";

/** Images attached to queued prompts: a GUI drop or paste into the composer saves each image
 * beside the prompt's queue file (same stem, an image extension — the `.md` filter in
 * listQueueFiles never sees them) and appends one `[image attached: <absolute path>]` line per
 * image to the queued text, so the receiving loop's pi agent can view the file with its read
 * tool. Validation lives here once; every surface (the GUI endpoints through submitRolePrompt,
 * the requeue policy through stripVanishedImageReferences) shares it. */

/** The image extensions pi's read tool renders — exactly what an attachment may carry.
 * Exported for src/inbox.ts's same-stem sibling cleanup, which must recognize the exact
 * `<stem>-<n>.<ext>` shape savePromptImages writes and nothing else. */
export const PROMPT_IMAGE_EXTENSIONS: readonly string[] = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"];

/** Per-image decoded-size cap. */
const PROMPT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** Per-prompt image count cap. */
export const PROMPT_IMAGES_MAX_COUNT = 4;

/** One image as it arrives over the GUI's POST body. */
export interface PromptImageInput {
  name: string;
  dataBase64: string;
}

const IMAGE_REF_LINE = /^\[image attached: (.+)\]$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Validate an `images` body field before anything is written: an array of at most
 * PROMPT_IMAGES_MAX_COUNT entries, each an object whose name carries an image extension and
 * whose dataBase64 is valid base64 decoding to at most PROMPT_IMAGE_MAX_BYTES. Returns the
 * first rule broken, phrased for the 400 the GUI endpoint answers with, or null when the
 * images are acceptable. */
export function promptImagesProblem(images: unknown): string | null {
  if (!Array.isArray(images)) return "images must be an array of { name, dataBase64 }";
  if (images.length > PROMPT_IMAGES_MAX_COUNT) {
    return `at most ${PROMPT_IMAGES_MAX_COUNT} images per prompt (got ${images.length})`;
  }
  for (const image of images) {
    if (typeof image !== "object" || image === null || Array.isArray(image)) {
      return "each image must be { name, dataBase64 }";
    }
    const { name, dataBase64 } = image as Record<string, unknown>;
    if (typeof name !== "string" || name.trim() === "") return "each image needs a file name";
    const ext = path.extname(name).toLowerCase();
    if (!PROMPT_IMAGE_EXTENSIONS.includes(ext)) {
      return `unsupported image type ${JSON.stringify(ext === "" ? name : `*${ext}`)} — expected one of ${PROMPT_IMAGE_EXTENSIONS.join(" ")}`;
    }
    if (typeof dataBase64 !== "string") return `image ${JSON.stringify(name)}: dataBase64 must be a base64 string`;
    const b64 = dataBase64.replace(/\s+/g, "");
    if (b64.length === 0 || b64.length % 4 !== 0 || !BASE64_RE.test(b64)) {
      return `image ${JSON.stringify(name)}: dataBase64 must be valid base64`;
    }
    const bytes = Buffer.from(b64, "base64").byteLength;
    if (bytes > PROMPT_IMAGE_MAX_BYTES) {
      return `image ${JSON.stringify(name)} is ${bytes} bytes — at most ${PROMPT_IMAGE_MAX_BYTES} (${PROMPT_IMAGE_MAX_BYTES / (1024 * 1024)} MiB) per image`;
    }
  }
  return null;
}

/** Save already-validated images beside a queued prompt's queue file — one file per image,
 * named with the queue file's stem plus the image's extension (`<stem>.png`); same-extension
 * images after the first get a `-<n>` suffix so they cannot overwrite each other. The client's
 * name is never used as a file name — only its extension, which promptImagesProblem already
 * validated against PROMPT_IMAGE_EXTENSIONS on the raw name, so the extension survives any
 * basename (a name whose safe characters are all stripped, like a non-ASCII `截图.png`, keeps
 * its extension instead of collapsing to an extension-less file the dequeue cleanup could
 * never match). Returns the absolute paths in order, for imageReferenceLines. Fails closed:
 * promptImagesProblem runs again here, so a caller that skipped it gets { problem } and
 * nothing written. */
export function savePromptImages(
  root: string,
  role: string,
  queueFile: string,
  images: readonly PromptImageInput[],
): { paths: string[] } | { problem: string } {
  const problem = promptImagesProblem(images);
  if (problem) return { problem };
  const dir = roleInboxDir(root, role);
  const stem = path.basename(queueFile).replace(/\.md$/, "");
  const taken = new Set<string>();
  const paths: string[] = [];
  try {
    for (const image of images) {
      const ext = path.extname(image.name).toLowerCase();
      let name = `${stem}${ext}`;
      for (let n = 2; taken.has(name); n++) name = `${stem}-${n}${ext}`;
      taken.add(name);
      const file = path.join(dir, name);
      fs.writeFileSync(file, Buffer.from(image.dataBase64, "base64"));
      paths.push(path.resolve(file));
    }
  } catch (err) {
    // A write that failed after earlier images were written (EISDIR on an occupied target,
    // ENOSPC, …) must not strand those earlier images in the inbox dir: nothing here is
    // ever referenced by a queue file yet, so an unwound partial save removes its own
    // writes and leaves the directory exactly as it found it.
    for (const written of paths) {
      try {
        fs.unlinkSync(written);
      } catch (unlinkErr) {
        if (errCode(unlinkErr) !== "ENOENT") throw unlinkErr;
      }
    }
    throw err;
  }
  return { paths };
}

/** The text to append to a prompt for its saved images: a blank line, then one
 * `[image attached: <absolute path>]` line per path — empty string for no images. */
export function imageReferenceLines(paths: readonly string[]): string {
  if (paths.length === 0) return "";
  return "\n\n" + paths.map((p) => `[image attached: ${p}]`).join("\n");
}

/** Drop the `[image attached: …]` lines whose files are no longer on disk from a prompt being
 * re-queued after a tick that already consumed them — takeQueuedFile removes an attached
 * image with its prompt, so a re-queued copy would otherwise send the loop's agent after
 * files that are gone. Each vanished line is replaced by one honest note naming what
 * happened; references whose files still exist are kept. Unchanged text comes back untouched
 * (dropped: []) so the common no-images case costs nothing. */
export function stripVanishedImageReferences(text: string): { text: string; dropped: number } {
  const kept: string[] = [];
  let dropped = 0;
  for (const line of text.split("\n")) {
    const referenced = IMAGE_REF_LINE.exec(line.trim())?.[1];
    if (referenced !== undefined && !fs.existsSync(referenced)) {
      dropped++;
      continue;
    }
    kept.push(line);
  }
  if (dropped === 0) return { text, dropped: 0 };
  const body = kept.join("\n").replace(/\n+$/, "");
  const note =
    `[image attachments dropped: ${dropped} image file${dropped === 1 ? "" : "s"} ${agree(dropped, "was", "were")} consumed` +
    ` when an earlier tick dequeued this prompt and ${agree(dropped, "is", "are")} no longer on disk]`;
  return { text: `${body}\n\n${note}`, dropped };
}
