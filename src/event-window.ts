import type { HarnessEvent } from "./types.js";
import { eventDayKey, parseEventLine } from "./events.js";
import { eventsLogPath } from "./paths.js";
import { forEachTailChunk } from "./files.js";

/** The report window's bounds, shared by every surface that takes a day count (the CLI's
 * --days, `tumwater report --failures --days`, and /api/report?days=N): 14-day default, at most
 * 90 days. A longer window only re-reads more of the event log and renders more lines without
 * adding signal — and an unbounded count would build one series entry per day (a typo'd "3650"
 * is a ten-year report; a huge value grows until the process runs out of memory), so both
 * surfaces bound it. Lives here rather than in the usage report because the failure digest
 * shares the bound but must not import the presentation layer. */
export const REPORT_DEFAULT_DAYS = 14;
export const REPORT_MAX_DAYS = 90;

/** What one windowed read of events.jsonl yielded. */
export interface EventWindow {
  /** Events whose local day is on or after the `fromKey` the read was asked for, oldest first. */
  events: HarnessEvent[];
  /** True iff the retained log reaches back before `fromKey` — either the backwards scan
   * early-stopped on a complete line older than it, or (when the whole file fit in the scan)
   * the file's own oldest retained line does. False means every retained line lies inside the
   * window, so the window may be truncated by rotation rather than merely idle. This is a
   * property of the read's coverage, not a whole-log survey: the scan never reads past the
   * first line older than `fromKey`. */
  coversFullWindow: boolean;
}

/** The oldest COMPLETE line in a backwards chunk buffer, or null when none is complete yet.
 * `parts` holds the read bytes oldest-first; the oldest chunk's leading segment up to its
 * first newline was cut by a chunk boundary and is discarded (it becomes whole again once the
 * earlier chunk lands). Lines are bounded by \n bytes, which cannot occur inside a multi-byte
 * UTF-8 sequence, so slicing on them is character-safe. */
function oldestCompleteLine(parts: Buffer[]): string | null {
  const first = parts[0];
  if (first === undefined || first.length === 0) return null;
  const firstNl = first.indexOf(10);
  if (firstNl < 0) return null; // Still one partial line in hand.
  const offset = firstNl + 1;
  let line = "";
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? Buffer.alloc(0);
    const start = i === 0 ? offset : 0;
    if (start >= part.length) continue;
    const nl = part.indexOf(10, start);
    line += part.toString("utf8", start, nl >= 0 ? nl : undefined);
    if (nl >= 0) return line;
  }
  return null; // No complete line yet.
}

/** Events whose local day is on or after `fromKey`, read with bounded I/O: the log is
 * append-only and chronological, so we scan backwards in chunks from EOF (files.forEachTailChunk)
 * and stop as soon as the oldest complete line in hand predates the window — cost scales with
 * the window's size, not the log's. `coversFullWindow` records whether the retained log reaches
 * back before the window (see its field doc), so a caller can tell "the log was rotated inside
 * the window" from "the fleet was idle": both leave the oldest returned event later than the
 * window start, but only the former means data was lost. */
export function readWindowEvents(root: string, fromKey: string): EventWindow {
  const file = eventsLogPath(root);
  const parts: Buffer[] = [];
  let coversFullWindow = false;
  forEachTailChunk(file, (chunk) => {
    parts.unshift(chunk);
    // The oldest chunk's leading line may be torn by the chunk boundary, so oldestCompleteLine
    // always drops it; at the file start that merely forgoes an early stop on the final chunk,
    // and the scan ends with the file anyway.
    const oldest = oldestCompleteLine(parts);
    if (oldest !== null) {
      const ev = parseEventLine(oldest);
      const day = ev ? eventDayKey(ev) : null;
      if (day !== null && day < fromKey) {
        coversFullWindow = true;
        return true; // Window passed: everything older is irrelevant to this read.
      }
    }
    return false;
  });
  const text = Buffer.concat(parts).toString("utf8");

  const events: HarnessEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const ev = parseEventLine(line); // A torn leading line fails to parse and is skipped.
    if (!ev) continue;
    const day = eventDayKey(ev);
    if (day !== null && day >= fromKey) events.push(ev);
  }
  // oldestCompleteLine always discards the earliest chunk's first line, so a read that reached
  // the file start without early-stopping has not yet checked the file's own oldest line. On a
  // one-chunk log that is the only line there is: check it here so "the retained log starts
  // before the window" is still detected.
  if (!coversFullWindow) {
    const first = text.split("\n", 1)[0] ?? "";
    const ev = parseEventLine(first);
    const day = ev ? eventDayKey(ev) : null;
    coversFullWindow = day !== null && day < fromKey;
  }
  return { events, coversFullWindow };
}
