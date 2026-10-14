import { queuedRolePromptEntries } from "../inbox/inbox.js";
import { deliverableAt } from "../inbox/prompt-not-before.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";

/** The inbox-shaped slice of a status snapshot: the director queue's count/previews/addresses
 * and the per-role counts and cancel-addressable entries. Built from one directory-listing
 * pass per role per poll, so the count and the previews and the per-role entries all come out
 * of the same read and cannot drift. */
interface InboxCollectResult {
  inbox: number;
  inboxPrompts: string[];
  inboxFiles: string[];
  inboxQueuedAt: Array<number | null>;
  inboxNotBefore: Array<number | null>;
  roleInbox: Record<string, number>;
  roleInboxPrompts: Record<
    string,
    Array<{ file: string; preview: string; queuedAtMs: number | null; notBeforeMs: number | null }>
  >;
}

/** One inbox pass per poll serves all four director fields (queuedRolePromptEntries lists the
 * directory and reads each file once): the count is the entries' length, so a prompt enqueued
 * or dequeued mid-snapshot can never make the header badge disagree with its numbered previews,
 * and each preview keeps its queue-file address beside it. A second listing pass per role (all
 * non-director loops) fills the per-role counts and their cancel-addressable entries from the
 * same `queuedRolePromptEntries` records, with deliverableAt (prompt-not-before.ts) over the
 * same cached text. `roles` is the already-computed loop list so one `loopIds` read serves the
 * caller and both passes; `now` is the snapshot's pinned clock, so deliverability and the
 * counts advance together instead of racing the wall clock. */
export function collectInboxes(root: string, roles: string[], now: number): InboxCollectResult {
  const queued = queuedRolePromptEntries(root, DIRECTOR_ROLE);
  const inboxPrompts = queued.map((e) => e.preview);
  const inboxFiles = queued.map((e) => e.file);
  const inboxQueuedAt = queued.map((e) => e.queuedAtMs);
  const inboxNotBefore = queued.map((e) => e.notBeforeMs);
  // One directory listing pass per role per poll fills the per-role counts; the director is
  // excluded because its queue is the shared inbox above. A role with prompts queued also
  // fills its cancel-addressable entries — the stat-keyed prompt cache keeps an unchanged
  // file at one stat per poll. Entries follow the full list, deferred prompts included (the
  // Queued tab lists and cancels them; only the deliverable count above excludes them).
  const roleInbox: Record<string, number> = {};
  const roleInboxPrompts: InboxCollectResult["roleInboxPrompts"] = {};
  for (const r of roles) {
    if (r === DIRECTOR_ROLE) continue;
    const entries = queuedRolePromptEntries(root, r);
    roleInbox[r] = entries.filter((e) => deliverableAt(e.notBeforeMs, now)).length;
    if (entries.length) roleInboxPrompts[r] = entries;
  }
  return {
    inbox: inboxPrompts.length,
    inboxPrompts,
    inboxFiles,
    inboxQueuedAt,
    inboxNotBefore,
    roleInbox,
    roleInboxPrompts,
  };
}
