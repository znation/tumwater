import path from "node:path";
import { logEvent } from "./events.js";
import { roleInboxDir } from "./paths.js";
import { DIRECTOR_ROLE } from "./roles.js";
import { promptPreview, queuedFileAtPosition, queuedFiles, takeQueuedFile } from "./inbox.js";

/** The cancel half of the prompt queues: removing a queued prompt by per-loop position
 * (`tumwater prompt --cancel`), by list-wide position numbering, by queue-file basename
 * (the dashboard's per-row cancel affordance), and the race policy both share. Split out
 * of inbox.ts — which keeps the store (enqueue, list, peek, dequeue) and the shared
 * takeQueuedFile race policy — so the store module carries no cancel vocabulary and the
 * cancel paths' event/preview pairing lives beside the only code that pairs them. */

/** Outcome of cancelPrompt: the cancelled prompt's text, or "gone" when the director dequeued
 * it between listing and removal (a concurrent pop is a normal race, not an error). */
export type CancelOutcome = { status: "cancelled"; text: string } | { status: "gone" };

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
  return takeCancelledPrompt(root, role, queuedFileAtPosition(root, role, position));
}

/** The miss half of a list-wide position outcome — an ambiguity (several loops hold the
 * position) or a miss (none does, carrying the largest queue length for the error's count) —
 * exactly the two shapes resolveListedQueue returns when it finds no single loop, restated
 * once so the three outcome types (ListedQueueResolution, ListedCancelOutcome,
 * ListedEditOutcome) and their two forwarders cannot drift on the miss fields. */
export type ListedQueueMiss =
  | { status: "ambiguous"; roles: string[] }
  | { status: "missing"; queued: number };

/** Forward a resolution to a list-wide command's outcome: a miss shape returns verbatim, a
 * found one calls `found` with the resolved loop (so the command's own side-effecting queue
 * action stays lazy — it runs only for the single loop that holds the position). Both
 * list-wide commands — cancelListedPrompt and editListedPrompt — are the call sites. */
export function listedQueueOutcome<T>(
  resolved: ListedQueueResolution,
  found: (role: string) => T,
): T | ListedQueueMiss {
  switch (resolved.status) {
    case "ambiguous":
    case "missing":
      return resolved;
    case "found":
      return found(resolved.role);
  }
}

/** Outcome of cancelListedPrompt: a resolved cancel (naming the loop it landed in, since the
 * caller scoped nothing), an ambiguity, or a miss across every loop it scoped. */
export type ListedCancelOutcome =
  | { status: "cancelled"; role: string; outcome: CancelOutcome }
  | ListedQueueMiss;

/** Resolve a list-wide position to the one loop whose queue holds it — the shared half of
 * cancelListedPrompt and editListedPrompt (inbox-edit.ts), so the two cannot drift on how
 * `--list`'s numbering resolves: its per-loop sections, each numbered from 1, in `scope`
 * order (the director first, then the roles). Only loops whose queue is long enough to hold
 * the position are candidates — exactly one resolves, several are an ambiguity the caller
 * reports with a --role escape hatch (the list itself shows two "N." lines there, so no
 * silent default), and none is a miss carrying the largest queue length for the error's
 * count. Sizes only — no queue content is read — so a resolution that finds nothing touches
 * no file. */
type ListedQueueResolution =
  | { status: "found"; role: string }
  | ListedQueueMiss;

export function resolveListedQueue(root: string, scope: string[], position: number): ListedQueueResolution {
  const candidates = scope.filter((role) => queuedFiles(root, role).length >= position);
  if (candidates.length === 0) {
    return { status: "missing", queued: Math.max(0, ...scope.map((role) => queuedFiles(root, role).length)) };
  }
  if (candidates.length > 1) return { status: "ambiguous", roles: candidates };
  const role = candidates[0];
  if (!role) return { status: "missing", queued: 0 }; // Unreachable: candidates.length is 1.
  return { status: "found", role };
}

/** Cancel by the position numbering `tumwater prompt --list` prints with no --role: the
 * position resolves through the shared resolveListedQueue (above), then one loop's queue
 * takes the cancel (cancelRolePrompt's race policy and event). */
export function cancelListedPrompt(root: string, scope: string[], position: number): ListedCancelOutcome {
  const resolved = resolveListedQueue(root, scope, position);
  return listedQueueOutcome(resolved, (role) => ({
    status: "cancelled",
    role,
    outcome: cancelRolePrompt(root, role, position),
  }));
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

/** Remove the Nth queued director prompt; see cancelRolePrompt. */
export function cancelPrompt(root: string, position: number): CancelOutcome {
  return cancelRolePrompt(root, DIRECTOR_ROLE, position);
}