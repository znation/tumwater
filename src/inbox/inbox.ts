// vocabulary: plain
import fs from "node:fs";
import path from "node:path";
import { ensureParentDir, readTextIfExists, writeTextAtomic } from "../files/files.js";
import { listQueueFiles, queueFileName, queueFileStamp, removeQueueFile } from "../files/file-queue.js";
import { cachedByStat, type StatKeyedValue } from "../files/stat-cache.js";
import { roleInboxDir } from "../paths.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";
import { knownRoleIdsCached } from "../config/config.js";
import { humanAgo, humanSeconds, secondsUntil } from "../text/datetime.js";
import { errorMessage, truncate } from "../text/text.js";
import { warnEvent } from "../events/events.js";
import { isPromptImageSibling } from "./inbox-attachments.js";

/** File-based queues of user prompts. Any process can enqueue; the orchestrator pops. Ordering
 * comes from the timestamped filenames. The director's queue is the historical one at the inbox
 * root; every other loop has its own subdirectory (roleInboxDir), so `tumwater prompt --role <id>`
 * queues a request only that loop's next tick sees.
 *
 * This module is the store: enqueueing, listing, peeking, and dequeuing, plus the shared
 * takeQueuedFile race policy. The cancel half — position-, list-, and file-addressed removal
 * and its event pairing — lives in inbox-cancel.ts; the in-place edit of one queued
 * prompt's text (`prompt --edit`, position-addressed like cancel and sharing its
 * resolveListedQueue) lives in inbox-edit.ts; moving one queued prompt to its queue's
 * head (`prompt --top`, position-addressed like cancel) lives in inbox-top.ts; the
 * submission pipeline that validates and
 * logs a user-submitted prompt lives in inbox-submit.ts; the image side of a submission in
 * inbox-attachments.ts. The not-before marker vocabulary for deferred prompts lives in
 * prompt-not-before.ts (compose, parse, strip, and the deliverableNow predicate this module
 * filters on). */

import { deliverableAt, deliverableNow, notBeforeMarker, notBeforeMs, stripNotBeforeMarker } from "./prompt-not-before.js";

/** Cap on a queued prompt's one-line preview, so an over-long prompt cannot bloat an event
 * log line, the dashboard payload, or the CLI output. */
const PROMPT_PREVIEW_MAX = 80;

/** One-line preview of a queued prompt — the single width shared by the prompt_enqueued
 * event preview (this module) and the prompt_cancelled preview (inbox-cancel.ts),
 * the dashboards' inboxPrompts (status/status-data.ts), and the CLI's cancel output (cli.ts).
 * Surrogate-safe via truncate: an over-long prompt is marked with an ellipsis like every other
 * label and never carries a lone surrogate at the cut point. */
export function promptPreview(text: string): string {
  // The queued preview never shows the marker line — plumbing, not content.
  return truncate(stripNotBeforeMarker(text), PROMPT_PREVIEW_MAX);
}

let seq = 0;

/** Append a prompt to a loop's queue as one timestamped file (creating the queue dir if needed)
 * and return its path. The filename orders prompts across processes by wall-clock time; the
 * per-process counter and pid break ties within one process. No event is logged —
 * inbox-submit.ts's submitPrompt and submitRolePrompt are the user-facing wrappers that add the
 * prompt_enqueued line, and PendingPrompt's re-queue of an unfulfilled prompt calls this directly.
 * The write is atomic (writeTextAtomic) because the queue's readers — the dashboards' 1 s poll,
 * `tumwater prompt --list`, and the dequeuing loop — run in other processes, and a read that
 * raced a plain writeFileSync could see a truncated prompt and run a tick on a half user request.
 * The optional decorate hook runs before that one write with the file's path and may return the
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

/** Every queued prompt file for one loop as a path joined onto the loop's inbox dir, oldest
 * first (listQueueFiles over the loop's inbox dir, .md entries only). Prompts still deferred by
 * a not-before marker are included — deliverability filtering is the callers' job
 * (deliverablePredicate, deliverablePromptCount) — and a missing inbox dir reads as an empty
 * queue. */
export function queuedFiles(root: string, role: string): string[] {
  return listQueueFiles(roleInboxDir(root, role), ".md");
}

/** Resolve the 1-based position `tumwater prompt --list`'s per-loop numbering shows into one
 * queue file — the shared range-check-and-pick half of cancelRolePrompt (inbox-cancel.ts)
 * and editRolePrompt (inbox-edit.ts), so the two cannot drift on the error or the numbering.
 * Throws for out-of-range positions with no side effects. The undefined-pick check folds into
 * the same condition as the range check (the pick is undefined exactly when out of range), so
 * the error is thrown from one place and the array-index narrowing is satisfied. */
export function queuedFileAtPosition(root: string, role: string, position: number): string {
  const files = queuedFiles(root, role);
  const file = files[position - 1];
  if (position < 1 || position > files.length || !file) {
    // Name the valid range when the queue is non-empty, so the operator sees the fix in the
    // same line instead of deriving `1..N` from the count; an empty queue needs no range.
    const range = files.length > 0 ? ` — valid: 1-${files.length}` : "";
    throw new Error(`no prompt at position ${position} (${files.length} in the inbox)${range}`);
  }
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
  return cachedByStat(promptCache, file, file, () => readTextIfExists(file), (t) => t);
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
 * reads as an empty queue, like inboxSize and dequeueRolePrompt; a file that vanishes between
 * listing and reading (a concurrent dequeue or cancel) is skipped rather than throwing, so a
 * polled snapshot can never crash on it. Unchanged files are served from the stat-keyed cache
 * above — fresh content requires an actual write to the path, which enqueueRolePrompt never
 * does for an existing file. */
export function queuedRolePrompts(root: string, role: string): string[] {
  const now = Date.now();
  return queuedRolePromptRecords(root, role)
    .filter((e) => deliverableAt(e.notBeforeMs, now))
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

/** The loop order a list-wide position (`--cancel`/`--edit` with no `--role`) resolves across:
 * the director first, then the remaining cached catalog ids — the per-loop sections `prompt
 * --list` and the TUI Queued pane print, each numbered from 1. The single home of that scope,
 * shared by the cancel and edit branches so neither can drift from what the list showed. */
export function listWideScope(root: string): string[] {
  return [DIRECTOR_ROLE, ...knownRoleIdsCached(root).filter((r) => r !== DIRECTOR_ROLE)];
}

/** One row of the list-shaped queue view (`prompt --list`'s prose and --json, the TUI Queued
 * pane): `position` is the 1-based per-loop number the prose prints and `--cancel` consumes;
 * `text` is the full verbatim prompt; `queuedAtMs` is the enqueue stamp parsed from the queue
 * filename (null for a hand-placed name), which the prose turns into a `queued <age> ago`
 * suffix; `notBeforeMs` is the prompt's not-before time parsed from its queue file's marker
 * line (null when absent or malformed), which the prose turns into a `delivers in <duration>`
 * countdown instead of the age — and `--json` carries both as-is. */
export interface QueuedListRow {
  role: string;
  position: number;
  /** The queue-file basename that addresses this entry, so a list-shaped surface (the TUI
   * Queued pane's Ctrl+E edit) can read and rewrite the exact file the row names instead of
   * a position a concurrent dequeue could invalidate — the same file-addressed policy the
   * dashboard's Edit uses. `renderQueuedList` ignores it; `--json` carries it additively. */
  file: string;
  text: string;
  queuedAtMs: number | null;
  notBeforeMs: number | null;
}

/** One traversal of the queues behind the list-shaped queue views: with `role`, that loop's
 * queue alone; otherwise the director first (its queue is the shared pre-1/2 inbox), then the
 * remaining catalog ids in order, empty queues skipped — exactly the sections the prose
 * prints. */
export function queuedListRows(root: string, role: string | null, validIds: string[]): QueuedListRow[] {
  const prompts: QueuedListRow[] = [];
  const record = (r: string, position: number, e: { file: string; text: string; queuedAtMs: number | null; notBeforeMs: number | null }) =>
    // The marker is stripped from the text both shapes print (stripNotBeforeMarker): the
    // prose and --json are the operator's view of what a loop will tick, and the marker is
    // plumbing, not content. Full verbatim prompt text minus plumbing, still not a preview.
    prompts.push({ role: r, position, file: e.file, text: stripNotBeforeMarker(e.text), queuedAtMs: e.queuedAtMs, notBeforeMs: e.notBeforeMs });
  if (role !== null) {
    queuedRolePromptRecords(root, role).forEach((e, i) => record(role, i + 1, e));
    return prompts;
  }
  queuedRolePromptRecords(root, DIRECTOR_ROLE).forEach((e, i) => record(DIRECTOR_ROLE, i + 1, e));
  for (const r of validIds) {
    if (r === DIRECTOR_ROLE) continue;
    queuedRolePromptRecords(root, r).forEach((e, i) => record(r, i + 1, e));
  }
  return prompts;
}

/** The ` (queued <age> ago)` suffix a prose list line carries when its queue filename stamps
 * the enqueue time (queueFileStamp) — omitted when the stamp is unparseable, so a hand-placed
 * file renders exactly as it did before the age existed. Age buckets through humanSeconds, the
 * same phrasing every other relative time in the harness prints.
 * A deferred prompt (the not-before marker still in the future) shows its countdown instead
 * — ` (delivers in <duration>)` from the same humanSeconds — since the age of a prompt that
 * has not been delivered yet is not the fact an operator scanning the list needs. */
function queuedAgeSuffix(queuedAtMs: number | null, notBeforeMs: number | null, now: number): string {
  if (notBeforeMs !== null && notBeforeMs > now) {
    const seconds = secondsUntil(notBeforeMs, now);
    return ` (delivers in ${humanSeconds(seconds)})`;
  }
  if (queuedAtMs === null) return "";
  return ` (queued ${humanAgo(queuedAtMs, now)})`;
}

/** Render the list-shaped queue view as the prose `prompt --list` prints and the TUI Queued
 * pane shows: consecutive rows grouped by role, one `<role>:` section per loop holding
 * `"<position>. <text><queuedAgeSuffix>"` lines, sections joined by `\n`. Empty rows render
 * the empty string, so each surface keeps its own empty-state note. One renderer so the CLI
 * and the TUI cannot drift on order, numbering, or the age/countdown wording. */
export function renderQueuedList(rows: readonly QueuedListRow[], now: number): string {
  const sections: string[] = [];
  let currentRole: string | null = null;
  let lines: string[] = [];
  for (const p of rows) {
    if (p.role !== currentRole) {
      if (currentRole !== null) sections.push(`${currentRole}:\n${lines.join("\n")}`);
      currentRole = p.role;
      lines = [];
    }
    lines.push(`${p.position}. ${p.text}${queuedAgeSuffix(p.queuedAtMs, p.notBeforeMs, now)}`);
  }
  if (currentRole !== null) sections.push(`${currentRole}:\n${lines.join("\n")}`);
  return sections.join("\n");
}

/** How many prompts are queued for one loop and deliverable now, without re-reading unchanged
 * contents — the snapshot's per-role counts poll every role
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
 * (oldest-first pop), and PendingPrompt's resume reclaim — which calls this for one exact
 * queue file instead of popping oldest-first, so the prompt recorded at requeue time is the
 * one reclaimed, whatever else was enqueued or cancelled meanwhile — so the race policy lives
 * once. */
export function takeQueuedFile(file: string): string | null {
  const text = readTextIfExists(file);
  if (text === null) return null; // Cancelled mid-listing.
  if (!removeQueueFile(file)) return null; // A concurrent cancel won the race — do not run a cancelled prompt.
  return text;
}

/** Remove the image files a queued prompt's [image attached: …] lines pointed at — the
 * same-stem siblings savePromptImages wrote beside the queue file — the exact shapes it
 * produces: `<stem>.<image extension>` and the same-extension dedup suffix `<stem>-<n>.<ext>`
 * (n a digit run), checked against inbox-attachments.ts's PROMPT_IMAGE_EXTENSIONS. A bare
 * prefix match is never enough: a hand-placed sibling prompt's file may share the stem followed
 * by a hyphen (`a-notes.md` beside `a.md`), and deleting it would take another prompt with
 * this one — files like that are left alone. ENOENT-tolerant through removeQueueFile, and a
 * queue directory that is already gone leaves nothing to clean. Called by the cancel paths
 * (inbox-cancel.ts's takeCancelledPrompt) and by a fulfilled tick's settle sweep
 * (src/inbox/pending-prompt.ts's settleImages): a cancelled or consumed prompt takes its
 * attachments with it. A DEQUEUE does not call this — the tick's agent still reads the
 * referenced files, so they must survive until the prompt is fulfilled or cancelled, and a
 * requeue first moves them to the new queue file's stem (movePromptImages) so this sweep
 * finds them under the stem the requeued file actually names.
 * Best-effort: the prompt file is already off the queue by the time this runs, so a sibling
 * that cannot be removed (EACCES, a directory standing where an image should be, EBUSY) must
 * not throw — that would lose the taken text, with no queue entry left to retry it. Each
 * failure is warned so the orphaned file stays visible. */
export function removeSameStemSiblings(root: string, role: string, file: string): void {
  const dir = path.dirname(file);
  const stem = path.basename(file, ".md");
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return; // The queue directory itself is gone — nothing to clean.
  }
  for (const entry of entries) {
    if (entry === path.basename(file) || !isPromptImageSibling(stem, entry)) continue;
    try {
      removeQueueFile(path.join(dir, entry));
    } catch (err) {
      // Warn, but never let even the warning cost the caller the prompt: if the event log is
      // unwritable too, the dequeued text is still the state that must survive.
      try {
        warnEvent(root, role, `could not remove a queued prompt's attachment ${entry}: ${errorMessage(err)}`);
      } catch {
        // Cleanup must not throw; the prompt is already taken.
      }
    }
  }
}

/** Remove and return the oldest queued prompt, or null when empty — including when a
 * concurrent `tumwater prompt --cancel` removes it between listing and reading (or between
 * reading and removal): the module's race policy is that a vanished file is skipped rather
 * than throwing, so the director sees an empty inbox and skips its tick instead of failing
 * with a raw ENOENT. When the removal itself hits ENOENT the cancel won after our read —
 * the prompt was cancelled, so it must not be executed: null (skip), never the text we
 * already read. Non-ENOENT errors (e.g. EACCES) are rethrown — they are not a race with a
 * cancel. A caller that must clean the prompt's attachments afterwards (a tick's
 * pending-prompt bookkeeping) needs the file's stem too, so dequeueRolePromptEntry also
 * returns the queue file it took. */
export function dequeueRolePromptEntry(root: string, role: string): { text: string; file: string } | null {
  const oldest = queuedFiles(root, role).find(deliverablePredicate(Date.now()));
  if (!oldest) return null;
  const text = takeQueuedFile(oldest);
  return text === null ? null : { text, file: oldest };
}

/** Remove and return the oldest prompt queued for one loop; see dequeueRolePromptEntry. */
export function dequeueRolePrompt(root: string, role: string): string | null {
  return dequeueRolePromptEntry(root, role)?.text ?? null;
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
// wrappers keep every existing caller (the status dashboards, the GUI server, PendingPrompt's
// re-queue, the pre-1/2 CLI) working unchanged, with no queue format migration.

/** Append a prompt to the director's queue; see enqueueRolePrompt. */
export function enqueuePrompt(root: string, prompt: string): string {
  return enqueueRolePrompt(root, DIRECTOR_ROLE, prompt);
}

/** Remove and return the oldest prompt queued for the director, with its queue file; see
 * dequeueRolePromptEntry. */
export function dequeuePromptEntry(root: string): { text: string; file: string } | null {
  return dequeueRolePromptEntry(root, DIRECTOR_ROLE);
}

/** Remove and return the oldest prompt queued for the director; see dequeueRolePrompt. */
export function dequeuePrompt(root: string): string | null {
  return dequeueRolePromptEntry(root, DIRECTOR_ROLE)?.text ?? null;
}

/** Full text of every prompt queued for the director; see queuedRolePrompts. */
export function queuedPrompts(root: string): string[] {
  return queuedRolePrompts(root, DIRECTOR_ROLE);
}
