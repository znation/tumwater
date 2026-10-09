import { dayKey } from "../text/datetime.js";
import { eventDayKey, parseEventLine } from "./event-read.js";
import type { HarnessEvent } from "./events.js";
import { eventsArchivePath, eventsLogPath } from "../paths.js";
import { readTailTextWithEnd } from "../files/tail.js";

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

/** The one-line note every windowed render prints when its read cannot prove the window was
 * fully covered (coversFullWindow false or eventWindowCovers false): the log's oldest retained
 * event lies inside the window, so older events may have rotated out. The phrasing is hedged
 * on purpose and stays true whenever it prints — a flat "rotated out" claim would be false for
 * a log born inside the window — so all four renders (`logs --since`, `report --since`,
 * `report --days`, `history --since`) must share this exact wording rather than re-derive it.
 * Lives here beside the coverage proof it restates, not in the presentation layer, so every
 * renderer imports it from the one place that defines what "covered" means. */
export const SPARSE_WINDOW_NOTE =
  "note: the log's oldest retained event lies inside this window; older events may have rotated out";

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
  /** The live log's byte offset through the scan's last complete line — where an incremental
   * append read must resume. This is the scan's own end, not a caller's earlier stat: an event
   * appended between the stat and the read is already folded, and recording the stale size
   * would fold it again on the next append. */
  liveEnd: number;
}

/** One file's scanned window plus the byte offset the scan covered through (its own end, backed
 * up to the last complete line). */
interface ScannedFile {
  events: HarnessEvent[];
  coversFullWindow: boolean;
  end: number;
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

/** True when a windowed read provably covers a request whose cutoff instant is `cutoff`: either the
 * day-keyed scan saw a complete line older than the window's first day (coversFullWindow), or the
 * window's oldest retained event predates the cutoff — the same-day case a day key cannot decide
 * — or the read returned no events at all, which proves coverage vacuously (with no retained
 * events nothing can have rotated away). Callers that must distinguish the empty-log case do their
 * own emptiness check before asking. Shared by the `logs --since` view and the `report --since`
 * collector so the coverage proof — and its reasoning about rotation — lives in exactly one
 * place beside the coversFullWindow semantics it builds on.
 *
 * The failure digest's variant works at day-key granularity (its windows are whole local days, not
 * instants), so it keeps its own comparison rather than forcing a timestamp through here. */
export function eventWindowCovers(w: EventWindow, cutoff: number): boolean {
  const oldest = w.events[0];
  return (
    w.coversFullWindow ||
    w.events.length === 0 ||
    (oldest !== undefined && typeof oldest.ts === "number" && oldest.ts <= cutoff)
  );
}

/** One file's in-window events, scanned backwards with bounded I/O: the log is append-only and
 * chronological, so we scan backwards in chunks from EOF (tail.readTailText) and stop as soon
 * as the oldest complete line in hand predates the window — cost scales with the window's size,
 * not the file's. `coversFullWindow` records whether this file reaches back before the window
 * (see EventWindow's field doc), so the caller can tell "retention cut the window" from "the
 * fleet was idle": both leave the oldest returned event later than the window start, but only
 * the former means data was lost. */
function scanEventsFile(file: string, fromKey: string): ScannedFile {
  let coversFullWindow = false;
  const { text, coveredEnd } = readTailTextWithEnd(file, (_chunk, parts) => {
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
  return { events, coversFullWindow, end: coveredEnd };
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
  if (live.coversFullWindow) return { events: live.events, coversFullWindow: true, liveEnd: live.end };
  const archive = scanEventsFile(eventsArchivePath(root), fromKey);
  return {
    events: [...archive.events, ...live.events],
    coversFullWindow: archive.coversFullWindow || live.coversFullWindow,
    liveEnd: live.end,
  };
}

/** The duration-shaped windowed read whose consumer needs a SECOND view of the same window
 * with a wider cutoff (history's tick-row join: a queued tick spanning the rows' cutoff logged
 * its land_queued pin before that cutoff, so its landing verdict must be joined from evidence
 * up to `joinBackslackMs` older). One backwards scan serves both: the wide read's day key never
 * sits after the narrow one's, so every `ts >= cutoff` event it holds is exactly the narrow
 * read's event list — the narrow scan reads a prefix of the wide scan's bytes and stops no
 * later (a line older than the narrow day key triggers its early stop before any line older
 * than the wide day key can) — and the narrow coverage follows from the same scan:
 * a retained line older than the narrow day key is either older than the wide day key too
 * (coversFullWindow, which therefore covers the narrow window as well) or sits inside the wide
 * event list, whose day keys span [wideFromKey, now); the same-day case a day key cannot decide
 * is decided by the narrow window's oldest retained event predating the narrow cutoff, exactly
 * as eventWindowCovers decides it for a single read. Calling readEventsSince twice instead
 * re-scanned and re-parsed the same log bytes a second time — on this repo's own log, a
 * duplicate ~4 MB scan and ~26k line parses per `history --since`. */
export function readEventsSinceJoined(
  root: string,
  sinceMs: number,
  joinBackslackMs: number,
): { cutoff: number; events: HarnessEvent[]; join: { cutoff: number; events: HarnessEvent[] }; covered: boolean } {
  const now = Date.now();
  const cutoff = now - sinceMs;
  const joinCutoff = now - (sinceMs + joinBackslackMs);
  const window = readWindowEvents(root, dayKey(joinCutoff));
  const joinEvents = window.events.filter((e) => typeof e.ts === "number" && e.ts >= joinCutoff);
  // The rows' view: the wide day-key read filtered to the narrow cutoff instant — every
  // such event's day key is >= the narrow day key (day keys are monotone in ts), so the
  // wide read's day filter cannot have dropped one the narrow read would hold.
  const events = joinEvents.filter((e) => typeof e.ts === "number" && e.ts >= cutoff);
  // Coverage of the NARROW window, decided from the one wide scan. The narrow day's local
  // midnight turns the day-key comparisons into ts comparisons — day(ts) < narrowFromKey is
  // exactly ts < that midnight — so the checks below are numeric and the event list's
  // oldest-first order makes them one bounded pass instead of a day-key formatting per event.
  const cut = new Date(cutoff);
  const narrowDayStartMs = new Date(cut.getFullYear(), cut.getMonth(), cut.getDate()).getTime();
  // One pass up the oldest-first list: the oldest numerically-timestamped event (any line
  // older than the narrow day proves the narrow scan would have early-stopped on it) and
  // the first event inside the narrow day (the narrow window's oldest retained event, for
  // the same-day clause eventWindowCovers decides a single read's coverage with).
  let oldestTs: number | null = null;
  let firstNarrowIdx = -1;
  for (let i = 0; i < window.events.length; i++) {
    const ts = window.events[i]?.ts;
    if (typeof ts !== "number") continue;
    if (oldestTs === null) oldestTs = ts;
    if (ts >= narrowDayStartMs) {
      firstNarrowIdx = i;
      break;
    }
  }
  const covered =
    window.coversFullWindow ||
    (oldestTs !== null && oldestTs < narrowDayStartMs) ||
    firstNarrowIdx === -1 ||
    (window.events[firstNarrowIdx]?.ts ?? Number.POSITIVE_INFINITY) <= cutoff;
  return { cutoff, events, join: { cutoff: joinCutoff, events: joinEvents }, covered };
}

/** The duration-shaped windowed read behind `logs --since` (log-commands.ts): the cutoff is
 * now − sinceMs, the rotation-spanning read is keyed on the cutoff's local calendar day
 * (dayKey — the shared dayKey helper eventDayKey buckets events with, so the read's day keys
 * cannot disagree with the ts filter), the day-keyed read may include earlier hours of that
 * day and the ts filter removes them (over-read is at most one day's events), and `covered` is
 * the exact eventWindowCovers predicate so neither surface can claim coverage the other would
 * hedge. `cutoff` comes back too, since both renderers name the window in their messages.
 * Pure over root: reads the event log, writes nothing. */
export function readEventsSince(
  root: string,
  sinceMs: number,
): { cutoff: number; events: HarnessEvent[]; covered: boolean } {
  const cutoff = Date.now() - sinceMs;
  const window = readWindowEvents(root, dayKey(cutoff));
  const events = window.events.filter((e) => typeof e.ts === "number" && e.ts >= cutoff);
  return { cutoff, events, covered: eventWindowCovers(window, cutoff) };
}
