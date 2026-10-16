// vocabulary: plain
/** The renderer behind `tumwater queue` — the operator-facing text for the land queue view the
 * reader gathers (landing-queue.ts's readLandingQueue, beside it): one line per queued landing
 * in execution order, plus the count of queue files the reader skipped. Pure function of the
 * collected view and a `now` instant — no I/O, no clock reads — so the age it prints can be
 * pinned by a test. */

import { humanSeconds, secondsSince } from "../text/datetime.js";
import { roleLabel } from "../roles/role-labels.js";
import { shortSha } from "../text/format.js";
import { plural } from "../text/phrases.js";
import type { LandingQueueView } from "./landing-queue.js";
import { landingChanges, LANDING_STAGE_LABELS, type LandingInFlight } from "./landing-slot.js";

/** The bracketed-label text for one queue entry, in the wording the loop rows use (status-model's
 * loopPhase): `landing <elapsed> · <stage>` while a vet or the merge holds the change,
 * `vetted, awaiting merge` once vetted, and "" when the marker is absent, names no record for
 * `sha`, or the record is `done`. Reads the marker through landingChanges, so an older-generation
 * single-change marker counts as one `landing` record. */
export function queueEntryLandingLabel(sha: string, inFlight: LandingInFlight | undefined, now: number): string {
  if (!inFlight) return "";
  const change = landingChanges(inFlight).find((c) => c.sha === sha);
  if (!change || change.status === "done") return "";
  if (change.status === "vetted") return "approved, waiting to merge"; // vocabulary-ok: persisted status value
  let label = "merging";
  if (change.startedAt) label += ` ${humanSeconds(secondsSince(change.startedAt, now))}`;
  if (change.stage) label += ` · ${LANDING_STAGE_LABELS[change.stage]}`;
  if (change.stageSince !== undefined) label += ` ${humanSeconds(secondsSince(change.stageSince, now))}`;
  return label;
}

/** Render the queue as the text `tumwater queue` prints: a `land queue (<depth>):` header then
 * one 1-based line per readable entry, oldest first, carrying the loop, tick number, short
 * pinned sha, age, and summary. An empty queue (no entries and nothing skipped) prints
 * `land queue empty`; a non-zero skip count appends one `(+N unreadable queue file(s) skipped)`
 * line so a torn or foreign file the reader dropped is visible rather than silent. An entry the
 * optional in-flight marker has a live record for carries ` · [<label>]` after its age
 * (queueEntryLandingLabel). */
export function renderLandingQueue(view: LandingQueueView, now: number, inFlight?: LandingInFlight): string {
  const depth = view.entries.length + view.unreadable;
  const lines: string[] = [];
  if (depth === 0) {
    lines.push("merge queue empty");
  } else {
    lines.push(`merge queue (${depth}):`);
    view.entries.forEach((e, i) => {
      const age = humanSeconds(secondsSince(e.enqueuedAt, now));
      const label = queueEntryLandingLabel(e.sha, inFlight, now);
      const tag = label ? ` · [${label}]` : "";
      lines.push(`  ${i + 1}. ${roleLabel(e.role)} run #${e.tick} · ${shortSha(e.sha)} · ${age} ago${tag} · ${e.summary}`);
    });
  }
  if (view.unreadable > 0) {
    lines.push(`  (+${plural(view.unreadable, "unreadable queue file")} skipped)`);
  }
  return lines.join("\n");
}
