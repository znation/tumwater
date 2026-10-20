// vocabulary: plain
import fs from "node:fs";
import path from "node:path";
import { removeQuiet, unlinkAllMissingTolerant } from "../files/files.js";
import { isJsonObject } from "../files/json-object.js";
import { roleInboxDir } from "../paths.js";
import { errorMessage, isNonBlankString } from "../text/text.js";
import { typoSuffix } from "../text/suggest.js";
import { agree, plural } from "../text/phrases.js";

/** Images attached to queued prompts: a GUI drop or paste into the composer saves each image
 * beside the prompt's queue file (same stem, an image extension — the `.md` filter in
 * listQueueFiles never sees them) and appends one `[image attached: <absolute path>]` line per
 * image to the queued text, so the receiving role's pi agent can view the file with its read
 * tool. Validation lives here once; every surface (the GUI endpoints through submitRolePrompt,
 * the requeue policy through stripVanishedImageReferences) shares it. */

/** The image extensions pi's read tool renders — exactly what an attachment may carry.
 * Exported for src/inbox/inbox.ts's same-stem sibling cleanup, which must recognize the exact
 * `<stem>-<n>.<ext>` shape savePromptImages writes and nothing else. */
export const PROMPT_IMAGE_EXTENSIONS: readonly string[] = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"];

/** Whether one directory entry is an image sibling savePromptImages writes beside a queue
 * file whose stem is `stem`: `<stem>.<image extension>` or its same-extension dedup suffix
 * `<stem>-<n>.<ext>` (n a digit run). The call sites — savePromptImages seeding its `taken`
 * set from siblings already on disk, inbox.ts's cancel and fulfillment sweeps, and the
 * requeue's move to a new stem — share this one definition, so what an edit treats as a
 * collision is exactly what a cleanup or a requeue matches. A bare prefix match is never
 * enough: a hand-placed sibling prompt's file may share the stem followed by a hyphen
 * (`a-notes.md` beside `a.md`), and must not match. */
export function isPromptImageSibling(stem: string, entry: string): boolean {
  if (!entry.startsWith(stem)) return false;
  const rest = entry.slice(stem.length);
  return (
    (rest.startsWith(".") && PROMPT_IMAGE_EXTENSIONS.includes(rest.toLowerCase())) ||
    (/^-\d+\./.test(rest) && PROMPT_IMAGE_EXTENSIONS.includes(rest.slice(rest.indexOf(".")).toLowerCase()))
  );
}

/** Pick a file name with extension `ext` under `stem` that does not collide with any name
 * already in `taken`, and record it: `<stem><ext>` when free, else the first
 * `<stem>-<n><ext>` (n from 2 up) that is. The one home of the dedup-suffix rule
 * savePromptImages and movePromptImages both use, so a same-stem sibling can never overwrite
 * another. `taken` is updated with the chosen name. */
function uniqueStemName(stem: string, ext: string, taken: Set<string>): string {
  let name = `${stem}${ext}`;
  for (let n = 2; taken.has(name); n++) name = `${stem}-${n}${ext}`;
  taken.add(name);
  return name;
}

/** Per-image decoded-size cap. Exported so a surface that holds a file before reading it
 * (the GUI composer's drop/paste handler) can refuse an oversized image with the same bound
 * the endpoint enforces, instead of offering a chip the server later rejects. */
export const PROMPT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** Per-prompt image count cap. */
export const PROMPT_IMAGES_MAX_COUNT = 4;

/** One image as it arrives over the GUI's POST body. */
export interface PromptImageInput {
  name: string;
  dataBase64: string;
}

const IMAGE_REF_LINE = /^\[image attached: (.+)\]$/;

/** The path a prompt line references, or undefined when the line (trimmed) is not exactly the
 * `[image attached: …]` shape imageReferenceLines writes. */
function referencedImagePath(line: string): string | undefined {
  return IMAGE_REF_LINE.exec(line.trim())?.[1];
}
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** The image-count rule: at most PROMPT_IMAGES_MAX_COUNT entries. Split out of
 * promptImagesProblem so a surface holding the raw path list can refuse an over-long
 * `--attach` list before reading or encoding a single file, with the count wording still the
 * one definition every raw-path surface renders. Null when the count is acceptable. */
export function promptImagesCountProblem(count: number): string | null {
  return count > PROMPT_IMAGES_MAX_COUNT
    ? `at most ${PROMPT_IMAGES_MAX_COUNT} images per prompt (got ${count})`
    : null;
}

/** The image-extension rule: a name whose lowercased extension is one pi's read tool renders.
 * A name with no extension is echoed whole (there is no `*` part to show), otherwise the
 * `*<ext>` shape. Split out so an `--attach` path can be refused before it is read. */
export function promptImageExtensionProblem(name: string): string | null {
  const ext = path.extname(name).toLowerCase();
  if (PROMPT_IMAGE_EXTENSIONS.includes(ext)) return null;
  return `unsupported image type ${JSON.stringify(ext === "" ? name : `*${ext}`)} — expected one of ${PROMPT_IMAGE_EXTENSIONS.join(" ")}${typoSuffix(ext, PROMPT_IMAGE_EXTENSIONS)}`;
}

/** The per-image size rule, in decoded bytes: at most PROMPT_IMAGE_MAX_BYTES. Split out so a
 * surface holding an on-disk path can stat it and refuse an oversized file before reading it
 * into memory. */
export function promptImageSizeProblem(name: string, bytes: number): string | null {
  return bytes > PROMPT_IMAGE_MAX_BYTES
    ? `image ${JSON.stringify(name)} is ${bytes} bytes — at most ${PROMPT_IMAGE_MAX_BYTES} (${PROMPT_IMAGE_MAX_BYTES / (1024 * 1024)} MiB) per image`
    : null;
}

/** Validate an `images` body field before anything is written: an array of at most
 * PROMPT_IMAGES_MAX_COUNT entries, each an object whose name carries an image extension and
 * whose dataBase64 is valid base64 decoding to at most PROMPT_IMAGE_MAX_BYTES. Returns the
 * first rule broken, phrased for the 400 the GUI endpoint answers with, or null when the
 * images are acceptable. The count, extension, and size rules are the exported helpers
 * above — the CLI's pre-read check of an `--attach` path list refuses those same three with
 * the same wording. */
export function promptImagesProblem(images: unknown): string | null {
  if (!Array.isArray(images)) return "images must be an array of { name, dataBase64 }";
  const countProblem = promptImagesCountProblem(images.length);
  if (countProblem !== null) return countProblem;
  for (const image of images) {
    if (!isJsonObject(image)) {
      return "each image must be { name, dataBase64 }";
    }
    const { name, dataBase64 } = image;
    if (!isNonBlankString(name)) return "each image needs a file name";
    const extProblem = promptImageExtensionProblem(name);
    if (extProblem !== null) return extProblem;
    if (typeof dataBase64 !== "string") return `image ${JSON.stringify(name)}: dataBase64 must be a base64 string`;
    const b64 = dataBase64.replace(/\s+/g, "");
    if (b64.length === 0 || b64.length % 4 !== 0 || !BASE64_RE.test(b64)) {
      return `image ${JSON.stringify(name)}: dataBase64 must be valid base64`;
    }
    const sizeProblem = promptImageSizeProblem(name, Buffer.from(b64, "base64").byteLength);
    if (sizeProblem !== null) return sizeProblem;
  }
  return null;
}

/** Read and validate an on-disk `--attach` path list into the GUI's image input shape — the
 * throwing core the CLI's `readPromptImages` and the TUI's prompt-line image attach share, so
 * both surfaces validate from one home. It applies the same cheap path-only rules first — the
 * shared count cap before any file is read (so a glob that expanded past it is rejected
 * without reading or base64-encoding dozens of files), then each path's extension,
 * regular-file shape, and on-disk size (the regular-file check keeps this from reading a FIFO
 * or device node that would block the caller indefinitely); a path that cannot be statted is
 * left for the read below to report with its own missing-file wording. It reads each
 * surviving file whole and re-runs the endpoint's validation (promptImagesProblem) so the
 * error names the broken rule with the same wording the dashboard answers 400 with. Each
 * failure is a thrown Error carrying that existing wording. */
export function readPromptImageFiles(paths: readonly string[]): PromptImageInput[] {
  const countProblem = promptImagesCountProblem(paths.length);
  if (countProblem !== null) throw new Error(countProblem);
  for (const p of paths) {
    const extProblem = promptImageExtensionProblem(p);
    if (extProblem !== null) throw new Error(extProblem);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(p);
    } catch {
      // Missing or unreadable: the read below names it.
      continue;
    }
    if (!stat.isFile())
      throw new Error(`attached image ${JSON.stringify(p)} is not a regular file — pass a path to an image file`);
    const sizeProblem = promptImageSizeProblem(path.basename(p), stat.size);
    if (sizeProblem !== null) throw new Error(sizeProblem);
  }
  const images = paths.map((p): PromptImageInput => {
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(p);
    } catch (err) {
      throw new Error(`cannot read attached image ${JSON.stringify(p)}: ${errorMessage(err)}`);
    }
    return { name: path.basename(p), dataBase64: bytes.toString("base64") };
  });
  const problem = promptImagesProblem(images);
  if (problem !== null) throw new Error(problem);
  return images;
}

/** Save already-validated images beside a queued prompt's queue file — one file per image,
 * named with the queue file's stem plus the image's extension (`<stem>.png`); same-extension
 * images after the first get a `-<n>` suffix so they cannot overwrite each other. The client's
 * name is never used as a file name — only its extension, which promptImagesProblem already
 * validated against PROMPT_IMAGE_EXTENSIONS on the raw name, so the extension survives any
 * basename (a name whose safe characters are all stripped, like a non-ASCII `截图.png`, keeps
 * its extension instead of collapsing to an extension-less file the same-stem cleanup could
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
  // Seed the collision set from image siblings already beside the queue file, so an edit
  // that adds a `.png` to a prompt whose image is already `<stem>.png` lands as `<stem>-2.png`
  // instead of overwriting (and orphaning the reference to) the existing file. A directory
  // that does not exist yet leaves the set empty; the write below creates it.
  const taken = new Set<string>();
  try {
    for (const entry of fs.readdirSync(dir)) {
      if (isPromptImageSibling(stem, entry)) taken.add(entry);
    }
  } catch {
    // No inbox dir yet (or unreadable): the write below reports the real failure, if any.
  }
  const paths: string[] = [];
  // The image whose write is in flight: it only joins `paths` once its write returns, so a
  // write that throws after creating the file (ENOSPC, EIO) would otherwise be the one
  // partial file the catch below cannot see.
  let inFlight: string | null = null;
  try {
    for (const image of images) {
      const ext = path.extname(image.name).toLowerCase();
      const name = uniqueStemName(stem, ext, taken);
      const file = path.join(dir, name);
      inFlight = file;
      fs.writeFileSync(file, Buffer.from(image.dataBase64, "base64"));
      inFlight = null;
      paths.push(path.resolve(file));
    }
  } catch (err) {
    // A write that failed after earlier images were written (EISDIR on an occupied target,
    // ENOSPC, …) must not strand those earlier images in the inbox dir: nothing here is
    // ever referenced by a queue file yet, so an unwound partial save removes its own
    // writes and leaves the directory exactly as it found it. removeQuiet best-effort also
    // takes the in-flight target a failed write left part-written, without masking `err`
    // (and without touching a pre-existing directory the write could not overwrite).
    if (inFlight !== null) removeQuiet(inFlight);
    unlinkAllMissingTolerant(paths);
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

/** The absolute paths named by a prompt's `[image attached: …]` lines, in order — the reader
 * counterpart to imageReferenceLines. Used by the edit path to carry an attached prompt's
 * references (and so their sibling files) over a text rewrite: an edit replaces the prompt's
 * text, not its attachments, which travel with the prompt until a cancel or the fulfilling
 * tick's sweep removes them. A line that is not exactly the writer's shape is content, not a
 * reference, and is ignored. */
export function imageReferencePaths(text: string): string[] {
  const paths: string[] = [];
  for (const line of text.split("\n")) {
    const referenced = referencedImagePath(line);
    if (referenced !== undefined) paths.push(referenced);
  }
  return paths;
}

/** Move a re-queued prompt's attachments from its old queue file's stem to the new queue
 * file's stem and rewrite their `[image attached: …]` lines, so an attachment always travels
 * with the prompt's current queue file: the cancel sweep and the fulfilling tick's sweep
 * (removeSameStemSiblings, keyed on that file's stem) then find it, and a requeue can never
 * strand a file under a stem no queue file names. Only a line naming a same-stem sibling of
 * `fromFile` inside its directory is treated as an attachment — a hand-typed or edited
 * `[image attached: …]` line pointing anywhere else is content and passes through unchanged,
 * which keeps cleanup keyed to files the harness actually saved rather than to prompt text. A
 * referenced attachment that is already gone is left for stripVanishedImageReferences to drop
 * and record. Each attachment moves on its own: one file that is gone or cannot be renamed is
 * left in place and named in `problem`, while the attachments around it still move, so a
 * single missing or unmovable file cannot strand the rest under a stem no queue file names. */
export function movePromptImages(
  fromFile: string,
  toFile: string,
  text: string,
): { text: string; problem: string | null } {
  const dir = path.resolve(path.dirname(fromFile));
  const fromStem = path.basename(fromFile, ".md");
  const toStem = path.basename(toFile, ".md");
  const toDir = path.resolve(path.dirname(toFile));
  const taken = new Set<string>();
  try {
    for (const entry of fs.readdirSync(toDir)) {
      if (isPromptImageSibling(toStem, entry)) taken.add(entry);
    }
  } catch {
    // The queue directory is gone; nothing to collide with.
  }
  const problems: string[] = [];
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const referenced = referencedImagePath(line);
    if (referenced === undefined) {
      out.push(line);
      continue;
    }
    const resolved = path.resolve(referenced);
    const base = path.basename(resolved);
    if (path.dirname(resolved) !== dir || !isPromptImageSibling(fromStem, base)) {
      out.push(line); // Content, not this prompt's attachment.
      continue;
    }
    if (!fs.existsSync(resolved)) {
      out.push(line); // Already gone; stripVanishedImageReferences drops the line.
      continue;
    }
    const ext = path.extname(base).toLowerCase();
    const name = uniqueStemName(toStem, ext, taken);
    const target = path.join(toDir, name);
    try {
      fs.renameSync(resolved, target);
    } catch (err) {
      // Keep this attachment where it is and keep moving the others: aborting here would
      // reverse the moves already done and orphan every attachment that survived.
      problems.push(`${base}: ${errorMessage(err)}`);
      out.push(line);
      continue;
    }
    out.push(line.replace(referenced, target));
  }
  return { text: out.join("\n"), problem: problems.length > 0 ? problems.join("; ") : null };
}

/** The prompt text without its `[image attached: …]` reference lines, trailing blank lines
 * trimmed — the editable body an editor should show. The reference block is plumbing the edit
 * path carries over unchanged, never content a user rewrites, and a line that is not exactly
 * the writer's shape is content and stays. The reader-side counterpart to
 * imageReferencePaths: the same line predicate, applied to drop rather than collect. */
export function stripImageReferenceLines(text: string): string {
  const kept = text.split("\n").filter((line) => referencedImagePath(line) === undefined);
  while (kept.length > 0 && (kept[kept.length - 1] as string).trim() === "") kept.pop();
  return kept.join("\n");
}

/** Drop the `[image attached: …]` lines whose files are no longer on disk from a prompt being
 * re-queued after a tick whose attached image is gone (removed out of band, or by a cancel),
 * so a re-queued copy would otherwise send the role's agent after files that are gone. Each
 * vanished line is replaced by one honest note naming what
 * happened; references whose files still exist are kept. Unchanged text comes back untouched
 * (dropped: []) so the common no-images case costs nothing. */
export function stripVanishedImageReferences(text: string): { text: string; dropped: number } {
  const kept: string[] = [];
  let dropped = 0;
  for (const line of text.split("\n")) {
    const referenced = referencedImagePath(line);
    if (referenced !== undefined && !fs.existsSync(referenced)) {
      dropped++;
      continue;
    }
    kept.push(line);
  }
  if (dropped === 0) return { text, dropped: 0 };
  const body = kept.join("\n").replace(/\n+$/, "");
  const note =
    `[image attachments dropped: ${plural(dropped, "image file")} ${agree(dropped, "was", "were")}` +
    ` missing when this prompt was returned to the inbox and ${agree(dropped, "is", "are")} no longer on disk]`;
  return { text: `${body}\n\n${note}`, dropped };
}
