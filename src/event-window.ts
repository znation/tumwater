import { eventDayKey, parseEventLine, type HarnessEvent } from "./events.js";
import { eventsArchivePath, eventsLogPath } from "./paths.js";
import { readTailText } from "./files.js";

/** The report window's bounds, shared by every surface that takes a day count (the CLI's
 * --days, `tumwater report --failures --days`, and /api/report?days=N): 14-day default, at most
 * 90 days. A longer window only re-reads more of the event log and renders more lines without
 * adding signal — and an unbounded count would build one series entry per day (a typo'd "3650"
 * is a ten-year report; a huge value grows until the process runs out of memory), so both
 * surfaces bound it. Lives here rather than in the usage report because the failure digest
 * shares the bound but must not import the presentation layer. */
export const REPORT_DEFAULT_DAYS = 14;
export const REPORT_MAX_DAYS = 90;

/** The `tumwater logs --since <duration>` window's cap: 7 days. Same rationale as the report
 * bound above — a longer window only re-reads more log and renders more lines without adding
 * signal, and the log rotates at 16 MB (EVENTS_MAX_BYTES in events.ts) anyway, so a huge window
 * mostly reads rotated-away nothing. Lives here so the CLI's flag validation and its window
 * read share one bound. */
export const LOGS_SINCE_MAX_MS = 7 * 24 * 60 * 60 * 1000;

/** The `tumwater report --since <duration>` window's cap: 7 days. The same bound as the logs
 * view above, for the same rationale — a longer window only re-reads more log without adding
 * signal, and the log rotates at 16 MB (EVENTS_MAX_BYTES in events.ts) anyway. Lives here so
 * the CLI's flag validation and the collector's window read share one bound. */
export const REPORT_SINCE_MAX_MS = 7 * 24 * 60 * 60 * 1000;

/** What one windowed read of events.jsonl yielded. */
interface EventWindow {
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

/** True when a windowed read provably covers a request whose cutoff instant is `cutoff`: either
 * the day-keyed scan saw a complete line older than the window's first day (coversFullWindow),
 * or the window's oldest retained event predates the cutoff — the same-day case a day key
 * cannot decide — or the read returned no events at all, which proves coverage vacuously (with
 * no retained events nothing can have rotated away). Callers that must distinguish the empty-log
 * case do their own emptiness check before asking. Shared by the `logs --since` view and the
 * `report --since` collector so the coverage proof — and its reasoning about rotation — lives in
 * exactly one place beside the coversFullWindow semantics it builds on.
 *
 * The failure digest's variant works at day-key granularity (its windows are whole local days,
 * not instants), so it keeps its own comparison rather than forcing a timestamp through here. */
export function eventWindowCovers(w: EventWindow, cutoff: number): boolean {
  const oldest = w.events[0];
  return (
    w.coversFullWindow ||
    w.events.length === 0 ||
    (oldest !== undefined && typeof oldest.ts === "number" && oldest.ts <= cutoff)
  );
}

/** One file's in-window events, scanned backwards with bounded I/O: the log is append-only and
 * chronological, so we scan backwards in chunks from EOF (files.readTailText) and stop as soon
 * as the oldest complete line in hand predates the window — cost scales with the window's size,
 * not the file's. `coversFullWindow` records whether this file reaches back before the window
 * (see EventWindow's field doc), so the caller can tell "retention cut the window" from "the
 * fleet was idle": both leave the oldest returned event later than the window start, but only
 * the former means data was lost. */
function scanEventsFile(file: string, fromKey: string): EventWindow {
  let coversFullWindow = false;
  const text = readTailText(file, (_chunk, parts) => {
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

/** Events whose local day is on or after `fromKey`, read from the live log and — when the live
 * log alone does not cover the window — its one archived generation (events.jsonl.1, written by
 * rotation). Each file is scanned with bounded I/O (scanEventsFile) and the archive's in-window
 * events are strictly older than the live file's, so prepending them keeps the oldest-first
 * ordering every consumer assumes; the concatenation needs no dedup because rotation moves the
 * whole file, so the two files share no lines. `coversFullWindow` is true when either file's
 * oldest retained event predates the window, which keeps the rotation note honest in both
 * directions: it vanishes once the archive completes the window and still appears when even the
 * archive starts inside it. A window the live file provably covers never touches the archive,
 * and a missing or empty archive (the normal case) reads as nothing, so the no-rotation
 * behavior is unchanged. */
export function readWindowEvents(root: string, fromKey: string): EventWindow {
  const live = scanEventsFile(eventsLogPath(root), fromKey);
  if (live.coversFullWindow) return live;
  const archive = scanEventsFile(eventsArchivePath(root), fromKey);
  return {
    events: [...archive.events, ...live.events],
    coversFullWindow: archive.coversFullWindow || live.coversFullWindow,
  };
}
