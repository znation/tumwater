/** The renderer behind `tumwater queue` — the operator-facing text for the land queue view the
 * reader gathers (landing-queue.ts's readLandingQueue, beside it): one line per queued landing
 * in execution order, plus the count of queue files the reader skipped. Pure function of the
 * collected view and a `now` instant — no I/O, no clock reads — so the age it prints can be
 * pinned by a test. */

import { humanSeconds, secondsSince } from "../text/datetime.js";
import { shortSha } from "../text/format.js";
import { plural } from "../text/phrases.js";
import type { LandingQueueView } from "./landing-queue.js";

/** Render the queue as the text `tumwater queue` prints: a `land queue (<depth>):` header then
 * one 1-based line per readable entry, oldest first, carrying the loop, tick number, short
 * pinned sha, age, and summary. An empty queue (no entries and nothing skipped) prints
 * `land queue empty`; a non-zero skip count appends one `(+N unreadable queue file(s) skipped)`
 * line so a torn or foreign file the reader dropped is visible rather than silent. */
export function renderLandingQueue(view: LandingQueueView, now: number): string {
  const depth = view.entries.length + view.unreadable;
  const lines: string[] = [];
  if (depth === 0) {
    lines.push("land queue empty");
  } else {
    lines.push(`land queue (${depth}):`);
    view.entries.forEach((e, i) => {
      const age = humanSeconds(secondsSince(e.enqueuedAt, now));
      lines.push(`  ${i + 1}. ${e.role} tick #${e.tick} · ${shortSha(e.sha)} · ${age} ago · ${e.summary}`);
    });
  }
  if (view.unreadable > 0) {
    lines.push(`  (+${plural(view.unreadable, "unreadable queue file")} skipped)`);
  }
  return lines.join("\n");
}
