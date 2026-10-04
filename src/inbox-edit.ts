import fs from "node:fs";
import { writeTextAtomic } from "./files.js";
import { logEvent } from "./events.js";
import { errCode } from "./errno.js";
import { promptPreview, queuedFiles } from "./inbox.js";
import { notBeforeMs, notBeforeMarker, stripNotBeforeMarker } from "./prompt-not-before.js";
import { resolveListedQueue } from "./inbox-cancel.js";

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

/** Rewrite the Nth prompt queued for one loop — 1-based, as shown by `tumwater prompt
 * --list` — in place: same queue file (so the filename's enqueue stamp and the entry's
 * position behind older prompts are untouched), same atomic write enqueueRolePrompt uses
 * (writeTextAtomic's temp file + rename, so a concurrent dequeue or another edit can never
 * expose a half-written file), and the existing not-before deferral carried over — when the
 * old file starts with the marker, the new text is written under the same marker; a
 * non-deferred prompt stays marker-free even if the new text's first line resembles a
 * marker. Logs one prompt_edited event under that loop (preview via promptPreview, exactly
 * like its prompt_cancelled sibling) only after a successful write.
 *
 * Throws for out-of-range positions with no side effects. The race policy pairs with the
 * outcome: the file is read first, and a read that hits ENOENT returns { status: "gone" } —
 * the loop dequeued it or a cancel removed it between listing and write, a normal race
 * exactly like takeCancelledPrompt's; any other read error propagates (a permission failure
 * is not a race). The write itself is unconditional once the read succeeded: a dequeue that
 * lands between that read and the rename is a narrower race than takeQueuedFile's own
 * read-then-remove window, and the atomic rename means every observer sees either the whole
 * old file or the whole new one — never a half-written prompt. */
export function editRolePrompt(root: string, role: string, position: number, newText: string): EditOutcome {
  const files = queuedFiles(root, role);
  if (position < 1 || position > files.length) {
    throw new Error(`no prompt at position ${position} (${files.length} queued)`);
  }
  const file = files[position - 1];
  if (!file) throw new Error(`no prompt at position ${position} (${files.length} queued)`); // Unreachable: the range check above.
  let oldFileText: string;
  try {
    oldFileText = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (errCode(err) === "ENOENT") return { status: "gone" }; // Dequeued or cancelled mid-listing.
    throw err;
  }
  // The marker is plumbing: the edit replaces only the content beneath it. notBeforeMs
  // reads the writer's exact marker shape, so content that merely resembles a marker is
  // content, and the new text goes in marker-free.
  const deferral = notBeforeMs(oldFileText);
  const fileText = (deferral !== null ? notBeforeMarker(deferral) : "") + newText;
  writeTextAtomic(file, fileText);
  const oldText = stripNotBeforeMarker(oldFileText);
  logEvent(root, { loop: role, type: "prompt_edited", preview: promptPreview(newText) });
  return { status: "edited", oldText, newText };
}

/** Outcome of editListedPrompt: a resolved edit (naming the loop it landed in, since the
 * caller scoped nothing), an ambiguity, or a miss across every loop it scoped. */
export type ListedEditOutcome =
  | { status: "edited"; role: string; outcome: EditOutcome }
  | { status: "ambiguous"; roles: string[] }
  | { status: "missing"; queued: number };

/** Edit by the position numbering `tumwater prompt --list` prints with no --role: the same
 * candidate resolution cancelListedPrompt uses — resolveListedQueue, in inbox-cancel.ts, so
 * the two cannot drift — followed by editRolePrompt in the resolved loop. One loop holding
 * the position resolves, several are an ambiguity the caller reports with a --role escape
 * hatch, none is a miss carrying the largest queue length for the error's count. */
export function editListedPrompt(root: string, scope: string[], position: number, newText: string): ListedEditOutcome {
  const resolved = resolveListedQueue(root, scope, position);
  if (resolved.status === "ambiguous") return { status: "ambiguous", roles: resolved.roles };
  if (resolved.status === "missing") return { status: "missing", queued: resolved.queued };
  return { status: "edited", role: resolved.role, outcome: editRolePrompt(root, resolved.role, position, newText) };
}