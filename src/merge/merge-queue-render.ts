/** The renderer behind `tumwater queue` — the operator-facing text for the merge queue view the
 * reader gathers (merge-queue.ts's readMergeQueue, beside it): one line per queued merge
 * in execution order, plus the count of queue files the reader skipped. Pure function of the
 * collected view and a `now` instant — no I/O, no clock reads — so the age it prints can be
 * pinned by a test. */

import { humanAgo, humanSeconds, humanSince, secondsUntil } from "../text/datetime.js";
import { roleLabel } from "../roles/role-labels.js";
import { shortSha } from "../text/format.js";
import { filterKeepPositions } from "../collections.js";
import { plural } from "../text/phrases.js";
import type { MergeEntry, MergeQueueView } from "./merge-queue.js";
import { mergeChanges, MERGE_STAGE_LABELS, type MergeInFlight } from "./merge-slot.js";

/** The bracketed-label text for one queue entry, in the wording the role rows use (status-model's
 * rolePhase): `merge <elapsed> · <stage>` while a verify or the merge holds the change,
 * `approved, awaiting merge` once approved, and "" when the marker is absent, names no record for
 * `sha`, or the record is `done`. Reads the marker through mergeChanges, so an older-generation
 * single-change marker counts as one `merge` record. */
export function queueEntryMergeLabel(sha: string, inFlight: MergeInFlight | undefined, now: number): string {
  if (!inFlight) return "";
  const change = mergeChanges(inFlight).find((c) => c.sha === sha);
  if (!change || change.status === "done") return "";
  if (change.status === "approved") return "approved, waiting to merge";
  let label = "merging";
  if (change.startedAt) label += ` ${humanSince(change.startedAt, now)}`;
  if (change.stage) label += ` · ${MERGE_STAGE_LABELS[change.stage]}`;
  if (change.stageSince !== undefined) label += ` ${humanSince(change.stageSince, now)}`;
  return label;
}

/** One re-submitted change's revision note (plans/revise-rejected.md): `revision <round>`,
 * plus ` · <n> prior objection(s)` when the change answered any prior review objections
 * (its `priorReview.reasons`). "" for a fresh change with no revision-round field, so a
 * first submission's queue line is byte-identical to before. */
export function revisionNote(entry: Pick<MergeEntry, "revisionRound" | "priorReview">): string {
  if (entry.revisionRound === undefined) return "";
  let note = "revision " + entry.revisionRound;
  const reasons = entry.priorReview?.reasons;
  if (Array.isArray(reasons) && reasons.length > 0) note += " · " + plural(reasons.length, "prior objection");
  return note;
}

/** One re-queued entry's what-brought-it-back note:
 * `re-queued after <result>`, plus ` · ×<n>` while it has bounced more than once, plus
 * ` · eligible in <duration>` while a `review_error` 60 s deferral still holds (its `notBefore`
 * in the future). "" for a fresh entry with no `retry` field, so a first submission's queue
 * line is byte-identical. */
export function retryNote(entry: Pick<MergeEntry, "retry" | "notBefore" | "retryCount">, now: number): string {
  if (entry.retry === undefined) return "";
  let note = `re-queued after ${entry.retry}`;
  if ((entry.retryCount ?? 0) > 1) note += ` · ×${entry.retryCount}`;
  if (entry.notBefore !== undefined && entry.notBefore > now) {
    note += ` · eligible in ${humanSeconds(secondsUntil(entry.notBefore, now))}`;
  }
  return note;
}

/** Narrows a whole-queue view to the entries whose role `keep` accepts, and returns the
 * `scope` renderMergeQueue takes: the kept roles, each kept entry's 1-based place in the whole
 * queue, and the whole queue's entry count. `unreadable` stays whole because an unreadable file
 * has no role to attribute it to. */
export function scopeMergeQueue(
  whole: MergeQueueView,
  roles: readonly string[],
  keep: (role: string) => boolean,
): { view: MergeQueueView; scope: { roles: readonly string[]; positions: number[]; total: number } } {
  const { kept, positions } = filterKeepPositions(whole.entries, (e) => keep(e.role));
  return { view: { ...whole, entries: kept }, scope: { roles, positions, total: whole.entries.length } };
}

/** Render the queue as the text `tumwater queue` prints: a `merge queue (<depth>):` header then
 * one 1-based line per readable entry, oldest first, carrying the role, run number, short
 * pinned sha, age, and summary. An empty queue (no entries and nothing skipped) prints
 * `merge queue empty`; a non-zero skip count appends one `(+N unreadable queue file(s) skipped)`
 * line so a torn or foreign file the reader dropped is visible rather than silent. An entry the
 * optional in-flight marker has a live record for carries ` · [<label>]` after its age
 * (queueEntryMergeLabel). With the optional `scope` (`queue --role`: `view` holds only the
 * listed roles' entries, `positions` their 1-based places in the whole queue, `total` the whole
 * queue's entry count) each line keeps its whole-queue number, the header reads
 * `merge queue (<kept> of <whole depth>, --role <ids>):`, and a scope that keeps nothing of a
 * non-empty queue prints `no queued merges for <ids> (merge queue holds <depth>)`. Without
 * `scope` the output is the whole queue's. */
export function renderMergeQueue(
  view: MergeQueueView,
  now: number,
  inFlight?: MergeInFlight,
  scope?: { roles: readonly string[]; positions: readonly number[]; total: number },
): string {
  const depth = view.entries.length + view.unreadable;
  const wholeDepth = scope ? scope.total + view.unreadable : depth;
  const ids = scope ? scope.roles.join(",") : "";
  const lines: string[] = [];
  if (wholeDepth === 0) {
    lines.push("merge queue empty");
  } else if (scope && view.entries.length === 0) {
    lines.push(`no queued merges for ${ids} (merge queue holds ${wholeDepth})`);
  } else {
    lines.push(scope ? `merge queue (${view.entries.length} of ${wholeDepth}, --role ${ids}):` : `merge queue (${depth}):`);
    view.entries.forEach((e, i) => {
      const age = humanAgo(e.enqueuedAt, now);
      const label = queueEntryMergeLabel(e.sha, inFlight, now);
      const tag = label ? ` · [${label}]` : "";
      const note = revisionNote(e);
      const noteTag = note ? ` · ${note}` : "";
      const retry = retryNote(e, now);
      const retryTag = retry ? ` · ${retry}` : "";
      const frictionTag = e.highFriction === true ? " · high friction" : "";
      lines.push(`  ${scope ? scope.positions[i] : i + 1}. ${roleLabel(e.role)} run #${e.run} · ${shortSha(e.sha)} · ${age}${tag}${frictionTag}${retryTag}${noteTag} · ${e.summary}`);
    });
  }
  if (view.unreadable > 0) {
    lines.push(`  (+${plural(view.unreadable, "unreadable queue file")} skipped)`);
  }
  return lines.join("\n");
}
