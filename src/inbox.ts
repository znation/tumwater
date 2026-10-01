import fs from "node:fs";
import path from "node:path";
import { ensureParentDir, readTextOrNull, writeTextAtomic } from "./files.js";
import { listQueueFiles, queueFileName, removeQueueFile } from "./file-queue.js";
import { cachedByStat, type StatKeyedValue } from "./stat-cache.js";
import { logEvent } from "./events.js";
import { roleInboxDir } from "./paths.js";
import { DIRECTOR_ROLE } from "./roles.js";
import { INITIAL_PROMPT_MAX_CHARS } from "./readme.js";
import { truncate } from "./text.js";
import { errCode } from "./errno.js";
import {
  imageReferenceLines,
  promptImagesProblem,
  savePromptImages,
  type PromptImageInput,
} from "./inbox-attachments.js";

/** File-based queues of user prompts. Any process can enqueue; the orchestrator pops. Ordering
 * comes from the timestamped filenames. The director's queue is the historical one at the inbox
 * root; every other loop has its own subdirectory (roleInboxDir), so `tumwater prompt --role <id>`
 * queues a request only that loop's next tick sees (PLANS.md "Per-role prompts 1/2"). */

/** Cap on a queued prompt's one-line preview, so an over-long prompt cannot bloat an event
 * log line, the dashboard payload, or the CLI output. */
const PROMPT_PREVIEW_MAX = 80;

/** One-line preview of a queued prompt — the single width shared by the prompt_enqueued and
 * prompt_cancelled event previews (this module), the dashboards' inboxPrompts (status-data.ts), and
 * the CLI's cancel output (cli.ts). Surrogate-safe via truncate: an over-long prompt is marked
 * with an ellipsis like every other label and never carries a lone surrogate at the cut point. */
export function promptPreview(text: string): string {
  return truncate(text, PROMPT_PREVIEW_MAX);
}

let seq = 0;

/** Append a prompt to a loop's queue as one timestamped file (creating the queue dir if needed)
 * and return its path. The filename orders prompts across processes by wall-clock time; the
 * per-process counter and pid break ties within one process. No event is logged — submitPrompt
 * and submitRolePrompt are the user-facing wrappers that add the prompt_enqueued line, and
 * loop.ts's re-queue of an unfulfilled prompt calls this directly. The write is atomic
 * (writeTextAtomic) because the queue's readers — the dashboards' 1 s poll, `tumwater prompt
 * --list`, and the dequeuing loop — run in other processes, and a read that raced a plain
 * writeFileSync could see a truncated prompt and run a tick on a half user request. The
 * optional decorate hook runs before that one write with the file's path and may return the
 * final text instead — submitPromptWithImages uses it to save the prompt's images beside the
 * queue file and append their reference lines, so the queue file is born complete and no
 * reader can ever see a prompt whose image lines point at not-yet-written files. */
export function enqueueRolePrompt(root: string, role: string, prompt: string, decorate?: (file: string) => string): string {
  const dir = roleInboxDir(root, role);
  // Timestamp orders across processes; the counter orders within one; pid breaks ties.
  const name = queueFileName(Date.now(), seq++, ".md");
  const file = path.join(dir, name);
  // The decorate hook may write files beside the queue file (submitPromptWithImages's
  // images), so the directory must exist before it runs — not only at the write below.
  if (decorate) ensureParentDir(file);
  writeTextAtomic(file, decorate ? decorate(file) : prompt);
  return file;
}

function queuedFiles(root: string, role: string): string[] {
  return listQueueFiles(roleInboxDir(root, role), ".md");
}

/** Number of prompts currently queued for one loop — a directory listing only; no file
 * content is read. Defaults to the director's queue; a role argument counts that loop's own
 * per-role queue (scheduling passes it so a queued prompt makes its loop due by itself).
 * A missing inbox dir reads as 0, like queuedPrompts and dequeuePrompt. */
export function inboxSize(root: string, role: string = DIRECTOR_ROLE): number {
  return queuedFiles(root, role).length;
}

// Per-poll prompt-content cache (stat-cache.cachedByStat): both dashboards poll snapshot() every
// second and read every queued prompt in full — to show an 80-char preview — but each file is
// written once by enqueuePrompt and only deleted on dequeue/cancel, never rewritten. Serve an
// unchanged file from the stat-keyed cache: one stat per file per poll instead of re-reading a
// (possibly long) prompt in its entirety every second until the director consumes it. Capped
// inside cachedByStat so many short-lived roots in tests cannot grow it unbounded.
const promptCache = new Map<string, StatKeyedValue<string>>();

/** One queued prompt paired with the queue-file basename that addresses it: the file name is
 * what the dashboard's per-row cancel affordance sends (/api/prompt-cancel) — addressed by
 * file, not by list position, so a 1 s-stale poll can never cancel the wrong entry. */
interface QueuedPromptEntry {
  file: string;
  preview: string;
}

/** The one read pass over a loop's queue that serves every preview-shaped consumer: each
 * queued file paired with its basename and full text. Same listing order and race policy as
 * queuedRolePrompts (a file that vanishes mid-listing is skipped, not thrown), and the same
 * stat-keyed cache, so an unchanged file still costs one stat per poll. */
function queuedRoleFileTexts(root: string, role: string): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  for (const f of queuedFiles(root, role)) {
    // Strings are immutable — no copy needed; a file that vanished mid-listing reads null.
    const text = cachedByStat(promptCache, f, f, () => readTextOrNull(f), (t) => t);
    if (text !== null) out.push({ file: path.basename(f), text });
  }
  return out;
}

/** Full text of every prompt queued for one loop, in execution order (oldest first) — the same
 * filename sort dequeueRolePrompt pops by. A missing queue directory reads as an empty queue,
 * like inboxSize and dequeueRolePrompt; a file that vanishes between listing and reading (a
 * concurrent dequeue or cancel) is skipped rather than throwing, so a polled snapshot can never
 * crash on it. Unchanged files are served from the stat-keyed cache above — fresh content
 * requires an actual write to the path, which enqueueRolePrompt never does for an existing file. */
export function queuedRolePrompts(root: string, role: string): string[] {
  return queuedRoleFileTexts(root, role).map((e) => e.text);
}

/** Every queued prompt of one loop with the queue-file basename that addresses it, in
 * execution order — the snapshot's cancel-addressable payload (StatusSnapshot.inboxFiles and
 * roleInboxPrompts). Same pass, order, race policy, and stat cache as queuedRolePrompts. */
export function queuedRolePromptEntries(root: string, role: string): QueuedPromptEntry[] {
  return queuedRoleFileTexts(root, role).map((e) => ({ file: e.file, preview: promptPreview(e.text) }));
}

/** How many prompts are queued for one loop, without reading their contents — the snapshot's
 * per-role counts (PLANS.md "Per-role prompts 2/2") poll every role every second, so the
 * count stays a directory listing rather than a read per queued file. A missing queue
 * directory reads as an empty queue, like queuedRolePrompts. */
export function queuedRolePromptCount(root: string, role: string): number {
  return queuedFiles(root, role).length;
}

/** Outcome of cancelPrompt: the cancelled prompt's text, or "gone" when the director dequeued
 * it between listing and removal (a concurrent pop is a normal race, not an error). */
export type CancelOutcome = { status: "cancelled"; text: string } | { status: "gone" };

/** Read a queued prompt and remove its file, treating either half of the concurrent-cancel
 * race as "the prompt is gone": null when the file has already vanished before the read
 * (ENOENT — a cancel or a prior dequeue won) or when the removal itself finds it gone (a
 * concurrent cancel won after our read). Any other read error propagates — it is not a race.
 * Shared by cancelRolePrompt (position-addressed), dequeueRolePrompt (oldest-first pop), and
 * loop.ts's resume reclaim — which calls this for one exact queue file instead of popping
 * oldest-first, so the prompt recorded at requeue time is the one reclaimed, whatever else
 * was enqueued or cancelled meanwhile — so the race policy lives once. */
export function takeQueuedFile(file: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (errCode(err) === "ENOENT") return null; // Cancelled mid-listing.
    throw err;
  }
  if (!removeQueueFile(file)) return null; // A concurrent cancel won the race — do not run a cancelled prompt.
  removeSameStemSiblings(file);
  return text;
}

/** Remove the image files a queued prompt's [image attached: …] lines pointed at — the
 * same-stem siblings savePromptImages wrote beside the queue file (a name starting with the
 * .md's stem whose next character is "." or "-" — an extension or a same-extension suffix;
 * a sibling prompt's file differs before the stem ends, so it never matches). ENOENT-tolerant
 * through removeQueueFile, and a queue directory that is already gone leaves nothing to
 * clean. Called by takeQueuedFile, so both dequeue and cancel take the attachments with the
 * prompt — an image never outlives the prompt that referenced it. */
function removeSameStemSiblings(file: string): void {
  const dir = path.dirname(file);
  const stem = path.basename(file, ".md");
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return; // The queue directory itself is gone — nothing to clean.
  }
  for (const entry of entries) {
    if (entry === path.basename(file) || !entry.startsWith(stem)) continue;
    const next = entry.charAt(stem.length);
    if (next === "." || next === "-") removeQueueFile(path.join(dir, entry));
  }
}


/** Read one addressed queue file and turn it into a cancel outcome — the one home of the
 * race-policy-and-event pairing both cancel paths go through: { status: "gone" } when the
 * loop already dequeued or another cancel removed the file (takeQueuedFile's race policy,
 * a normal race, never an error), else one prompt_cancelled event under that loop (preview
 * via promptPreview, exactly like the prompt_enqueued sibling) logged only after a successful
 * removal — a prompt the loop just dequeued ran, it was not cancelled — and
 * { status: "cancelled", text }. Shared by cancelRolePrompt (position-addressed) and
 * cancelQueuedFile (file-addressed), so the two cannot drift on the event, its preview
 * width, or what counts as gone. */
function takeCancelledPrompt(root: string, role: string, file: string): CancelOutcome {
  const text = takeQueuedFile(file);
  if (text === null) return { status: "gone" };
  logEvent(root, { loop: role, type: "prompt_cancelled", preview: promptPreview(text) });
  return { status: "cancelled", text };
}

/** Remove the Nth prompt queued for one loop — 1-based, as shown by `tumwater prompt --list` —
 * and log one prompt_cancelled event under that loop (preview via promptPreview, exactly like
 * its prompt_enqueued sibling). Throws for out-of-range positions with no side effects; returns
 * { status: "gone" } when the file disappears between listing and removal instead of throwing.
 * The race policy and event live in takeCancelledPrompt. */
export function cancelRolePrompt(root: string, role: string, position: number): CancelOutcome {
  const files = queuedFiles(root, role);
  if (position < 1 || position > files.length) {
    throw new Error(`no prompt at position ${position} (${files.length} queued)`);
  }
  const file = files[position - 1];
  if (!file) throw new Error(`no prompt at position ${position} (${files.length} queued)`); // Unreachable: the range check above.
  return takeCancelledPrompt(root, role, file);
}

/** Outcome of cancelListedPrompt: a resolved cancel (naming the loop it landed in, since the
 * caller scoped nothing), an ambiguity, or a miss across every loop it scoped. */
export type ListedCancelOutcome =
  | { status: "cancelled"; role: string; outcome: CancelOutcome }
  | { status: "ambiguous"; roles: string[] }
  | { status: "missing"; queued: number };

/** Cancel by the position numbering `tumwater prompt --list` prints with no --role: its per-loop
 * sections, each numbered from 1, in `scope` order (the director first, then the roles). Only
 * loops whose queue is long enough to hold the position are candidates — exactly one resolves to
 * a cancel in that loop's queue (cancelRolePrompt's race policy and event), several are an
 * ambiguity the caller reports with a --role escape hatch (the list itself shows two "N."
 * lines there, so no silent default), and none is a miss carrying the largest queue length for
 * the error's count. Sizes only — no queue content is read — so a cancel that resolves to
 * nothing touches no file. */
export function cancelListedPrompt(root: string, scope: string[], position: number): ListedCancelOutcome {
  const candidates = scope.filter((role) => queuedFiles(root, role).length >= position);
  if (candidates.length === 0) {
    return { status: "missing", queued: Math.max(0, ...scope.map((role) => queuedFiles(root, role).length)) };
  }
  if (candidates.length > 1) return { status: "ambiguous", roles: candidates };
  const role = candidates[0];
  if (!role) return { status: "missing", queued: 0 }; // Unreachable: candidates.length is 1.
  return { status: "cancelled", role, outcome: cancelRolePrompt(root, role, position) };
}

/** The queue-file-name guard for a file-addressed cancel: a name arriving over HTTP is
 * trusted only as a plain basename inside the loop's queue directory — anything containing a
 * path separator or equal to `..` could name a file elsewhere on disk, a NUL byte is not a
 * character any filename can hold (the fs layer throws on it rather than answering ENOENT,
 * so the endpoint's 400 contract needs it rejected before anything touches the disk), and a
 * non-`.md` name cannot be a queued prompt at all (enqueueRolePrompt writes nothing else).
 * Returns null when the name is safe to join onto roleInboxDir, else the reason the
 * /api/prompt-cancel endpoint sends as its 400. cancelQueuedFile re-checks it, so a caller
 * that skips the guard fails closed. */
export function queueFileNameProblem(name: unknown): string | null {
  if (typeof name !== "string" || name === "") return "file required";
  if (name.includes("/") || name.includes("\\") || name.includes("\0") || name === "..") {
    return "file must be a plain queue-file basename";
  }
  if (!name.endsWith(".md")) return "file must name a queued prompt's .md file";
  return null;
}

/** Remove one queued prompt addressed by its queue-file basename — the file-addressed twin of
 * cancelRolePrompt, for the dashboard's per-row cancel affordance (PLANS.md 2026-09-29): the
 * address is the file itself, so a stale poll's snapshot can never cancel the wrong entry.
 * Same race policy and event as cancelRolePrompt, through the shared takeCancelledPrompt.
 * Throws for a name failing queueFileNameProblem — the GUI endpoint pre-checks the same
 * guard and answers 400 before anything is touched on disk. */
export function cancelQueuedFile(root: string, role: string, name: string): CancelOutcome {
  const problem = queueFileNameProblem(name);
  if (problem) throw new Error(problem);
  return takeCancelledPrompt(root, role, path.join(roleInboxDir(root, role), name));
}

/** Remove and return the oldest queued prompt, or null when empty — including when a
 * concurrent `tumwater prompt --cancel` removes it between listing and reading (or between
 * reading and removal): the module's race policy is that a vanished file is skipped rather
 * than throwing, so the director sees an empty inbox and skips its tick instead of failing
 * with a raw ENOENT. When the removal itself hits ENOENT the cancel won after our read —
 * the prompt was cancelled, so it must not be executed: null (skip), never the text we
 * already read. Non-ENOENT errors (e.g. EACCES) are rethrown — they are not a race with a
 * cancel. */
export function dequeueRolePrompt(root: string, role: string): string | null {
  const [oldest] = queuedFiles(root, role);
  if (!oldest) return null;
  return takeQueuedFile(oldest);
}

/** Full text of the oldest prompt queued for one loop, read WITHOUT consuming it — the
 * preview seam behind `tumwater role <id>`'s next-prompt view. Same reader, listing order,
 * and race policy as queuedRolePrompts (a file that vanishes mid-listing is skipped, not
 * thrown), but the queue file is never unlinked: a preview can never cost a queued prompt
 * its tick, which is the property test/tick-prompt.test.ts pins through the preview seam.
 * A missing queue directory reads as null, like dequeueRolePrompt. */
export function peekRolePrompt(root: string, role: string): string | null {
  return queuedRolePrompts(root, role)[0] ?? null;
}

/** The oldest prompt queued for the director, unread and unconsumed; see peekRolePrompt. */
export function peekPrompt(root: string): string | null {
  return peekRolePrompt(root, DIRECTOR_ROLE);
}

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
  return `the prompt is ${prompt.length} chars — shorten it to at most ${DIRECTOR_PROMPT_MAX_CHARS}: it rides into the ${role} tick's prefill`;
}

/** A user submits a new prompt for one loop (TUI, GUI, or CLI): enqueue it there and record it
 * in the event log under that loop. Returns the trimmed prompt that was queued. The logged
 * preview goes through promptPreview — not a raw slice — so an over-long prompt is marked with
 * an ellipsis like every other label and never carries a lone surrogate at the cut point.
 * Throws (before anything is queued or logged) when the trimmed prompt exceeds
 * DIRECTOR_PROMPT_MAX_CHARS (promptLengthProblem's message) — callers report it to their
 * operator. An optional images array (the GUI composer's drop/paste attachments) rides
 * through savePromptImages beside the queue file, with one [image attached: …] reference line
 * per image appended to the queued text; image problems throw before anything is queued. */
export function submitRolePrompt(root: string, role: string, text: string, images?: PromptImageInput[]): string {
  const problem = promptLengthProblem(text, role);
  if (problem) throw new Error(problem);
  if (images && images.length > 0) {
    const imageProblem = promptImagesProblem(images);
    if (imageProblem) throw new Error(imageProblem);
    return submitPromptWithImages(root, role, text, images);
  }
  const prompt = text.trim();
  enqueueRolePrompt(root, role, prompt);
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
function submitPromptWithImages(root: string, role: string, text: string, images: PromptImageInput[]): string {
  const prompt = text.trim();
  let final = prompt;
  enqueueRolePrompt(root, role, prompt, (file) => {
    const saved = savePromptImages(root, role, file, images);
    if ("problem" in saved) throw new Error(saved.problem); // Unreachable: validated above.
    final = prompt + imageReferenceLines(saved.paths);
    return final;
  });
  logEvent(root, { loop: role, type: "prompt_enqueued", preview: promptPreview(final) });
  return final;
}

// --- Director special cases: the director's queue IS the historical inbox root, so these thin
// wrappers keep every existing caller (the status dashboards, the GUI server, loop.ts's
// re-queue, the pre-1/2 CLI) working unchanged, with no queue format migration.

/** Append a prompt to the director's queue; see enqueueRolePrompt. */
export function enqueuePrompt(root: string, prompt: string): string {
  return enqueueRolePrompt(root, DIRECTOR_ROLE, prompt);
}

/** Remove and return the oldest prompt queued for the director; see dequeueRolePrompt. */
export function dequeuePrompt(root: string): string | null {
  return dequeueRolePrompt(root, DIRECTOR_ROLE);
}

/** Full text of every prompt queued for the director; see queuedRolePrompts. */
export function queuedPrompts(root: string): string[] {
  return queuedRolePrompts(root, DIRECTOR_ROLE);
}

/** Remove the Nth queued director prompt; see cancelRolePrompt. */
export function cancelPrompt(root: string, position: number): CancelOutcome {
  return cancelRolePrompt(root, DIRECTOR_ROLE, position);
}

/** A user submits a new director prompt; see submitRolePrompt. */
export function submitPrompt(root: string, text: string, images?: PromptImageInput[]): string {
  return submitRolePrompt(root, DIRECTOR_ROLE, text, images);
}
