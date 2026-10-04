import fs from "node:fs";
import path from "node:path";
import { ensureParentDir, writeTextAtomic } from "./files.js";
import { listQueueFiles, queueFileName, queueFileStamp, removeQueueFile } from "./file-queue.js";
import { cachedByStat, type StatKeyedValue } from "./stat-cache.js";
import { roleInboxDir } from "./paths.js";
import { DIRECTOR_ROLE } from "./roles.js";
import { truncate } from "./text.js";
import { errCode } from "./errno.js";

/** File-based queues of user prompts. Any process can enqueue; the orchestrator pops. Ordering
 * comes from the timestamped filenames. The director's queue is the historical one at the inbox
 * root; every other loop has its own subdirectory (roleInboxDir), so `tumwater prompt --role <id>`
 * queues a request only that loop's next tick sees (PLANS.md "Per-role prompts 1/2").
 *
 * This module is the store: enqueueing, listing, peeking, and dequeuing, plus the shared
 * takeQueuedFile race policy. The cancel half — position-, list-, and file-addressed removal
 * and its event pairing — lives in inbox-cancel.ts; the in-place edit of one queued
 * prompt's text (`prompt --edit`, position-addressed like cancel and sharing its
 * resolveListedQueue) lives in inbox-edit.ts; the submission pipeline that validates and
 * logs a user-submitted prompt lives in inbox-submit.ts; the image side of a submission in
 * inbox-attachments.ts. The not-before
 * marker vocabulary for deferred prompts lives in prompt-not-before.ts (compose, parse, strip,
 * and the deliverableNow predicate this module filters on). */

import { deliverableNow, notBeforeMarker, notBeforeMs, stripNotBeforeMarker } from "./prompt-not-before.js";

/** Cap on a queued prompt's one-line preview, so an over-long prompt cannot bloat an event
 * log line, the dashboard payload, or the CLI output. */
const PROMPT_PREVIEW_MAX = 80;

/** One-line preview of a queued prompt — the single width shared by the prompt_enqueued
 * event preview (this module) and the prompt_cancelled preview (inbox-cancel.ts),
 * the dashboards' inboxPrompts (status-data.ts), and
 * the CLI's cancel output (cli.ts). Surrogate-safe via truncate: an over-long prompt is marked
 * with an ellipsis like every other label and never carries a lone surrogate at the cut point. */
export function promptPreview(text: string): string {
  // The queued preview never shows the marker line — plumbing, not content.
  return truncate(stripNotBeforeMarker(text), PROMPT_PREVIEW_MAX);
}

let seq = 0;

/** Append a prompt to a loop's queue as one timestamped file (creating the queue dir if needed)
 * and return its path. The filename orders prompts across processes by wall-clock time; the
 * per-process counter and pid break ties within one process. No event is logged — inbox-submit.ts's
 * submitPrompt and submitRolePrompt are the user-facing wrappers that add the prompt_enqueued
 * line, and
 * loop.ts's re-queue of an unfulfilled prompt calls this directly. The write is atomic
 * (writeTextAtomic) because the queue's readers — the dashboards' 1 s poll, `tumwater prompt
 * --list`, and the dequeuing loop — run in other processes, and a read that raced a plain
 * writeFileSync could see a truncated prompt and run a tick on a half user request. The
 * optional decorate hook runs before that one write with the file's path and may return the
 * final text instead — submitPromptWithImages uses it to save the prompt's images beside the
 * queue file and append their reference lines, so the queue file is born complete and no
 * reader can ever see a prompt whose image lines point at not-yet-written files. An optional
 * `notBeforeMs` defers the prompt (PLANS.md "tumwater prompt --at <duration>"): its queue file
 * is born with the `tumwater:not-before <iso-utc>` marker line in that same single atomic
 * write, so no reader can ever see the text without the marker that hides it. */
export function enqueueRolePrompt(
  root: string,
  role: string,
  prompt: string,
  notBeforeMs?: number,
  decorate?: (file: string) => string,
): string {
  const dir = roleInboxDir(root, role);
  // Timestamp orders across processes; the counter orders within one; pid breaks ties.
  const name = queueFileName(Date.now(), seq++, ".md");
  const file = path.join(dir, name);
  // The decorate hook may write files beside the queue file (submitPromptWithImages's
  // images), so the directory must exist before it runs — not only at the write below.
  if (decorate || notBeforeMs !== undefined) ensureParentDir(file);
  const text = (notBeforeMs !== undefined ? notBeforeMarker(notBeforeMs) : "") + (decorate ? decorate(file) : prompt);
  writeTextAtomic(file, text);
  return file;
}

/** Every queued prompt file for one loop as a path joined onto the loop's inbox dir, oldest first (listQueueFiles
 * over the loop's inbox dir, .md entries only). Prompts still deferred by a not-before marker
 * are included — deliverability filtering is the callers' job (deliverablePredicate,
 * deliverablePromptCount) — and a missing inbox dir reads as an empty queue. */
export function queuedFiles(root: string, role: string): string[] {
  return listQueueFiles(roleInboxDir(root, role), ".md");
}

/** Resolve the 1-based position `tumwater prompt --list`'s per-loop numbering shows into one
 * queue file — the shared range-check-and-pick half of cancelRolePrompt (inbox-cancel.ts)
 * and editRolePrompt (inbox-edit.ts), so the two cannot drift on the error or the numbering.
 * Throws for out-of-range positions with no side effects; the pick's null check exists only
 * to satisfy the array-index narrowing and is unreachable (the range check above). */
export function queuedFileAtPosition(root: string, role: string, position: number): string {
  const files = queuedFiles(root, role);
  if (position < 1 || position > files.length) {
    throw new Error(`no prompt at position ${position} (${files.length} queued)`);
  }
  const file = files[position - 1];
  if (!file) throw new Error(`no prompt at position ${position} (${files.length} queued)`); // Unreachable: the range check above.
  return file;
}

/** Number of prompts currently queued for one loop and deliverable now — a directory listing
 * plus, per file, one stat-cached content read (the prompt cache below; an unchanged file
 * costs one stat). Defaults to the director's queue; a role argument counts that loop's own
 * per-role queue (scheduling passes it so a queued prompt makes its loop due by itself).
 * A prompt deferred by the not-before marker (its time still in the future) stays excluded,
 * so a deferred prompt alone never makes its loop due; once due, the marker falls out of the
 * count naturally. A missing inbox dir reads as 0, like queuedPrompts and dequeuePrompt. */
export function inboxSize(root: string, role: string = DIRECTOR_ROLE): number {
  return deliverablePromptCount(root, role);
}

/** The shared deliverability predicate over one queue file (the prompt cache's read, plus the
 * not-before check): the callers are deliverablePromptCount's count and dequeueRolePrompt's
 * oldest-first find, and nothing else. */
function deliverablePredicate(now: number): (f: string) => boolean {
  return (f) => {
    const text = cachedPromptText(f);
    return text !== null && deliverableNow(text, now);
  };
}

/** The shared body of the two deliverable-prompt counters (inboxSize, queuedRolePromptCount):
 * a directory listing plus one stat-cached content read per file (the prompt cache above),
 * counting only files whose text is readable and deliverable now. */
function deliverablePromptCount(root: string, role: string): number {
  return queuedFiles(root, role).filter(deliverablePredicate(Date.now())).length;
}

// Per-poll prompt-content cache (stat-cache.cachedByStat): both dashboards poll snapshot() every
// second and read every queued prompt in full — to show an 80-char preview — but each file is
// written once by enqueuePrompt and only deleted on dequeue/cancel, never rewritten. Serve an
// unchanged file from the stat-keyed cache: one stat per file per poll instead of re-reading a
// (possibly long) prompt in its entirety every second until the director consumes it. Capped
// inside cachedByStat so many short-lived roots in tests cannot grow it unbounded.
const promptCache = new Map<string, StatKeyedValue<string>>();

/** One cached read of a queue file's text through the stat cache above — the single reader
 * both the listing passes and the deliverability filters (inboxSize, queuedRolePromptCount,
 * dequeueRolePrompt) go through, so an unchanged file costs one stat wherever it is touched. */
function cachedPromptText(file: string): string | null {
  return cachedByStat(promptCache, file, file, () => readQueueText(file), (t) => t);
}

/** Read one queue file, tolerating only its disappearance (a concurrent dequeue or cancel —
 * null, like readTextOrNull) and rethrowing any other error: a permission failure is not a
 * race, and reporting it as "empty queue" would make a loop skip its tick while the prompt
 * stays queued — the same ENOENT discrimination cancelPrompt's and dequeuePrompt's take
 * already pin (test/inbox.test.ts). */
function readQueueText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    if (errCode(err) === "ENOENT") return null;
    throw err;
  }
}

/** One queued prompt paired with the queue-file basename that addresses it: the file name is
 * what the dashboard's per-row cancel affordance sends (/api/prompt-cancel) — addressed by
 * file, not by list position, so a 1 s-stale poll can never cancel the wrong entry. The stamp
 * is the enqueue time parsed from that filename (queueFileStamp), null for a hand-placed
 * name — the age the `prompt --list` CLI and the dashboard's Queued tab render. */
interface QueuedPromptEntry {
  file: string;
  preview: string;
  queuedAtMs: number | null;
  notBeforeMs: number | null;
}

/** The one read pass over a loop's queue that serves every list-shaped consumer: each queued
 * file paired with its basename, full text, and the enqueue stamp parsed from the filename
 * (queueFileStamp; null for a hand-placed name). Same listing order and race policy as
 * queuedRolePrompts (a file that vanishes mid-listing is skipped, not thrown), and the same
 * stat-keyed cache, so an unchanged file still costs one stat per poll. Exported so the CLI's
 * `prompt --list` (prompt-commands.ts) reads text and stamp from the same pass the snapshot's
 * entries do — the two views of one queue cannot disagree. Each record also carries the
 * prompt's not-before time parsed from its marker line (notBeforeMs; null when absent or
 * malformed) — deferred entries are listed and cancellable, only not deliverable. */
export function queuedRolePromptRecords(
  root: string,
  role: string,
): Array<{ file: string; text: string; queuedAtMs: number | null; notBeforeMs: number | null }> {
  const out: Array<{ file: string; text: string; queuedAtMs: number | null; notBeforeMs: number | null }> = [];
  for (const f of queuedFiles(root, role)) {
    // Strings are immutable — no copy needed; a file that vanished mid-listing reads null.
    const text = cachedPromptText(f);
    if (text !== null) {
      const name = path.basename(f);
      out.push({ file: name, text, queuedAtMs: queueFileStamp(name), notBeforeMs: notBeforeMs(text) });
    }
  }
  return out;
}

/** Full text of every prompt queued for one loop, in execution order (oldest first) — the same
 * filename sort dequeueRolePrompt pops by. A not-yet-deliverable prompt (the not-before marker
 * still in the future) is not part of the execution order: it is skipped here, so peek and
 * dequeue can never hand a tick a prompt its time has not reached. A missing queue directory
 * reads as an empty queue,
 * like inboxSize and dequeueRolePrompt; a file that vanishes between listing and reading (a
 * concurrent dequeue or cancel) is skipped rather than throwing, so a polled snapshot can never
 * crash on it. Unchanged files are served from the stat-keyed cache above — fresh content
 * requires an actual write to the path, which enqueueRolePrompt never does for an existing file. */
export function queuedRolePrompts(root: string, role: string): string[] {
  const now = Date.now();
  return queuedRolePromptRecords(root, role)
    .filter((e) => e.notBeforeMs === null || e.notBeforeMs <= now)
    .map((e) => e.text);
}

/** Every queued prompt of one loop with the queue-file basename that addresses it and its
 * enqueue stamp, in execution order — the snapshot's cancel-addressable payload
 * (StatusSnapshot.inboxFiles and roleInboxPrompts). Same pass, order, race policy, and stat
 * cache as queuedRolePrompts. */
export function queuedRolePromptEntries(root: string, role: string): QueuedPromptEntry[] {
  return queuedRolePromptRecords(root, role).map((e) => ({
    file: e.file,
    preview: promptPreview(e.text),
    queuedAtMs: e.queuedAtMs,
    notBeforeMs: e.notBeforeMs,
  }));
}

/** How many prompts are queued for one loop and deliverable now, without re-reading unchanged
 * contents — the snapshot's per-role counts (PLANS.md "Per-role prompts 2/2") poll every role
 * every second, so the count stays a listing plus one stat-cached read per file (the prompt
 * cache above keeps an unchanged file at one stat). A deferred prompt (its not-before time
 * still in the future) stays excluded, like inboxSize. A missing queue directory reads as an
 * empty queue, like queuedRolePrompts. */
export function queuedRolePromptCount(root: string, role: string): number {
  return deliverablePromptCount(root, role);
}

/** Read a queued prompt and remove its file, treating either half of the concurrent-cancel
 * race as "the prompt is gone": null when the file has already vanished before the read
 * (ENOENT — a cancel or a prior dequeue won) or when the removal itself finds it gone (a
 * concurrent cancel won after our read). Any other read error propagates — it is not a race.
 * Shared by inbox-cancel.ts's cancel paths (position- and file-addressed), dequeueRolePrompt
 * (oldest-first pop), and
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

/** Remove and return the oldest queued prompt, or null when empty — including when a
 * concurrent `tumwater prompt --cancel` removes it between listing and reading (or between
 * reading and removal): the module's race policy is that a vanished file is skipped rather
 * than throwing, so the director sees an empty inbox and skips its tick instead of failing
 * with a raw ENOENT. When the removal itself hits ENOENT the cancel won after our read —
 * the prompt was cancelled, so it must not be executed: null (skip), never the text we
 * already read. Non-ENOENT errors (e.g. EACCES) are rethrown — they are not a race with a
 * cancel. */
export function dequeueRolePrompt(root: string, role: string): string | null {
  const oldest = queuedFiles(root, role).find(deliverablePredicate(Date.now()));
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


