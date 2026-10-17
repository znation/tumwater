// vocabulary: plain
/** The renderer behind `tumwater queue` — the operator-facing text for the merge queue view the
 * reader gathers (merge-queue.ts's readMergeQueue, beside it): one line per queued merge
 * in execution order, plus the count of queue files the reader skipped. Pure function of the
 * collected view and a `now` instant — no I/O, no clock reads — so the age it prints can be
 * pinned by a test. */

import { humanSeconds, secondsSince } from "../text/datetime.js";
import { roleLabel } from "../roles/role-labels.js";
import { shortSha } from "../text/format.js";
import { plural } from "../text/phrases.js";
import type { MergeQueueView } from "./merge-queue.js";
import { mergeChanges, MERGE_STAGE_LABELS, type MergeInFlight } from "./merge-slot.js";

/** The bracketed-label text for one queue entry, in the wording the loop rows use (status-model's
 * loopPhase): `merge <elapsed> · <stage>` while a verify or the merge holds the change,
 * `approved, awaiting merge` once approved, and "" when the marker is absent, names no record for
 * `sha`, or the record is `done`. Reads the marker through mergeChanges, so an older-generation
 * single-change marker counts as one `merge` record. */
export function queueEntryMergeLabel(sha: string, inFlight: MergeInFlight | undefined, now: number): string {
  if (!inFlight) return "";
  const change = mergeChanges(inFlight).find((c) => c.sha === sha);
  if (!change || change.status === "done") return "";
  if (change.status === "approved") return "approved, waiting to merge";
  let label = "merging";
  if (change.startedAt) label += ` ${humanSeconds(secondsSince(change.startedAt, now))}`;
  if (change.stage) label += ` · ${MERGE_STAGE_LABELS[change.stage]}`;
  if (change.stageSince !== undefined) label += ` ${humanSeconds(secondsSince(change.stageSince, now))}`;
  return label;
}

/** Render the queue as the text `tumwater queue` prints: a `merge queue (<depth>):` header then
 * one 1-based line per readable entry, oldest first, carrying the loop, tick number, short
 * pinned sha, age, and summary. An empty queue (no entries and nothing skipped) prints
 * `merge queue empty`; a non-zero skip count appends one `(+N unreadable queue file(s) skipped)`
 * line so a torn or foreign file the reader dropped is visible rather than silent. An entry the
 * optional in-flight marker has a live record for carries ` · [<label>]` after its age
 * (queueEntryMergeLabel). */
export function renderMergeQueue(view: MergeQueueView, now: number, inFlight?: MergeInFlight): string {
  const depth = view.entries.length + view.unreadable;
  const lines: string[] = [];
  if (depth === 0) {
    lines.push("merge queue empty");
  } else {
    lines.push(`merge queue (${depth}):`);
    view.entries.forEach((e, i) => {
      const age = humanSeconds(secondsSince(e.enqueuedAt, now));
      const label = queueEntryMergeLabel(e.sha, inFlight, now);
      const tag = label ? ` · [${label}]` : "";
      lines.push(`  ${i + 1}. ${roleLabel(e.role)} run #${e.run} · ${shortSha(e.sha)} · ${age} ago${tag} · ${e.summary}`);
    });
  }
  if (view.unreadable > 0) {
    lines.push(`  (+${plural(view.unreadable, "unreadable queue file")} skipped)`);
  }
  return lines.join("\n");
}
