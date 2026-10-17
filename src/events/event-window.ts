import type { Stats } from "node:fs";
import { dayAt, dayKey, humanSeconds } from "../text/datetime.js";
import { eventDayKey, parseEventLine } from "./event-read.js";
import type { HarnessEvent } from "./events.js";
import { eventsArchivePath, eventsLogPath } from "../paths.js";
import { statOrNull } from "../files/files.js";
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

/** Why a trailing-window length is refused, as the rejection text naming the out-of-range
 * value (`sinceMs must be between 1 and 7d (got 604800000)`). The single home of the report
 * window's bound wording, shared by the data-layer guard (assertReportSinceMs) and the
 * dashboard's ?sinceMs= 400 (gui-endpoints.ts) so the two cannot drift apart; the `--since`
 * CLI flag uses parseSinceFlag's own distinct wording. */
export function reportSinceMsg(sinceMs: number): string {
  return `sinceMs must be between 1 and ${humanSeconds(REPORT_SINCE_MAX_MS / 1000)} (got ${sinceMs})`;
}

/** Reject a trailing-window length outside the report bound before a collector reads the log.
 * The CLI's parseSinceFlag already rejects one, but both trailing-window collectors are also
 * called directly (tests, future callers), so the data layer enforces the bound too. A
 * non-finite length is refused here as well: NaN slips past both comparisons (`NaN <= 0` and
 * `NaN > MAX` are each false) and would reach the window arithmetic, so the guard tests
 * finiteness first — the same rule the persisted-state readers apply. The message comes from
 * reportSinceMsg so the data layer and the dashboard share the bound's wording. */
export function assertReportSinceMs(sinceMs: number): void {
  if (!Number.isFinite(sinceMs) || sinceMs <= 0 || sinceMs > REPORT_SINCE_MAX_MS)
    throw new Error(reportSinceMsg(sinceMs));
}

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

/** How a read found the event feed — the read OUTCOME, distinct from what the window holds.
 * "ok": at least one parseable event line was read from the live log or its archive.
 * "empty": neither file exists or both are zero bytes (a team that has not written yet).
 * "unreadable": a file exists with bytes but none of them parse as an event — a directory at
 * the path, a permission failure, or a run whose every complete line is corrupt. The failure
 * digest branches on this so an observer role can tell "the team was idle" from "I could not
 * read the log"; the never-fail-the-tick policy still holds — a read reports the state, it
 * never throws to do so. */
export type EventLogState = "ok" | "empty" | "unreadable";

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
  /** The live log's byte offset where an incremental append read must resume: the scan's own
   * end, past every complete line it read and past a trailing newline-less fragment it parsed as
   * an event (a write in flight whose newline has not landed). It is not a caller's earlier stat:
   * an event appended between the stat and the read is already folded, and recording the stale
   * size would fold it again on the next append. A fragment that did not parse was not consumed
   * and stays past this offset for the next read. */
  liveEnd: number;
  /** The live log's and archive's combined read outcome (EventLogState). */
  logState: EventLogState;
}

/** One file's scanned window plus the byte offset the scan consumed through: its own end, past
 * the last complete line and past a trailing fragment it parsed as an event. */
interface ScannedFile {
  events: HarnessEvent[];
  coversFullWindow: boolean;
  end: number;
  logState: EventLogState;
}

/** Classify a decoded event-log read by whether any line parses: "ok" once one line is an
 * event, "unreadable" when complete lines exist but none parse, and "empty" when the read held
 * no non-empty complete line. A newline-less trailing fragment is a write in flight, not
 * corruption, so it never makes a file unreadable — but a fragment that parses still proves
 * the feed readable. */
function classifyLogText(text: string): EventLogState {
  const endsWithNewline = text.endsWith("\n");
  const lines = text.split("\n");
  let parsedAny = false;
  let corruptLine = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line) continue;
    if (parseEventLine(line)) parsedAny = true;
    else if (endsWithNewline || i !== lines.length - 1) corruptLine = true;
  }
  if (parsedAny) return "ok";
  return corruptLine ? "unreadable" : "empty";
}

/** Classify one event-log file from its stat and the text a read decoded. A missing file and a
 * zero-byte one are both "empty"; a directory, a stat that found bytes the read could not
 * return (`text === ""`), and a file whose complete lines all fail to parse are "unreadable". */
function classifyLogFile(text: string, st: Stats | null): EventLogState {
  if (!st) return "empty";
  if (st.isDirectory()) return "unreadable";
  if (st.size === 0) return "empty";
  if (text === "") return "unreadable";
  return classifyLogText(text);
}

/** Combine the live log's and the archive's read outcomes: an unreadable file outranks a
 * readable sibling, so an archive — the normal steady state once the log has rotated at 16 MB
 * — cannot mask an unreadable live log; otherwise a parseable event proves the feed readable,
 * and an empty pair is empty. */
function combineLogState(a: EventLogState, b: EventLogState): EventLogState {
  if (a === "unreadable" || b === "unreadable") return "unreadable";
  if (a === "ok" || b === "ok") return "ok";
  return "empty";
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
 * team was idle": both leave the oldest returned event later than the window start, but only
 * the former means data was lost. */
function scanEventsFile(file: string, fromKey: string): ScannedFile {
  const st = statOrNull(file);
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

  const lines = text.split("\n");
  const events: HarnessEvent[] = [];
  for (const line of lines) {
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
    const first = lines[0] ?? "";
    const ev = parseEventLine(first);
    const day = ev ? eventDayKey(ev) : null;
    coversFullWindow = day !== null && day < fromKey;
  }
  // The last element is a newline-less trailing fragment (a write in flight). The loop above
  // consumed it when it parsed as an event, so `end` must sit past it: a resume from the last
  // complete line would re-parse the same event once its newline lands. A fragment that did not
  // parse was not consumed, so `end` stays at the last complete line and the next read sees it
  // whole once it completes.
  const trailing = lines[lines.length - 1] ?? "";
  const end =
    trailing !== "" && parseEventLine(trailing) !== null ? coveredEnd + Buffer.byteLength(trailing) : coveredEnd;
  return { events, coversFullWindow, end, logState: classifyLogFile(text, st) };
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
  if (live.coversFullWindow)
    return { events: live.events, coversFullWindow: true, liveEnd: live.end, logState: live.logState };
  const archive = scanEventsFile(eventsArchivePath(root), fromKey);
  return {
    events: [...archive.events, ...live.events],
    coversFullWindow: archive.coversFullWindow || live.coversFullWindow,
    liveEnd: live.end,
    logState: combineLogState(live.logState, archive.logState),
  };
}

/** The event feed's read outcome for a one-shot caller that needs no window — `doctor`'s
 * event-log pre-flight. Reads the live log and its archive whole and classifies each; the
 * combine rule matches readWindowEvents, so the doctor check and the telemetry digest agree on
 * what "unreadable" means. */
export function eventLogState(root: string): EventLogState {
  return combineLogState(scanFileReadState(eventsLogPath(root)), scanFileReadState(eventsArchivePath(root)));
}

/** Read one event-log file whole and classify it, without building a window. Reading whole is
 * deliberate: a one-shot pre-flight can afford it, and only a full read proves a file has no
 * parseable line rather than just a corrupt tail. */
function scanFileReadState(file: string): EventLogState {
  const st = statOrNull(file);
  if (!st || st.isDirectory() || st.size === 0) return classifyLogFile("", st);
  const { text } = readTailTextWithEnd(file, () => false);
  return classifyLogFile(text, st);
}

/** The duration-shaped windowed read whose consumer needs a SECOND view of the same window
 * with a wider cutoff (history's tick-row join: a queued tick spanning the rows' cutoff logged
 * its merge_queued pin before that cutoff, so its merge verdict must be joined from evidence
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
  const narrowDayStartMs = dayAt(0, cut).getTime();
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
