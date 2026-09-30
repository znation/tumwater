import { dayKey } from "./datetime.js";
import { parseJsonObject } from "./json-object.js";
import { eventsLogPath } from "./paths.js";
import { cachedByStat, type StatKeyedValue } from "./stat-cache.js";
import { readTailTextWithEnd } from "./tail.js";
import type { HarnessEvent } from "./events.js";

/** The READ side of the event feed: everything that consumes events.jsonl after the fact —
 * parseEventLine's skip-without-failing rule, the per-event query conventions (eventDayKey,
 * eventRole, eventUsage, tickStartMap/tickSpanMs) the reports and history share, and the
 * stat-cached backwards tail scan readEvents is built on. The WRITE side — logEvent/warnEvent,
 * the append path with its torn-tail repair, rotation, and the subscriber list — and the
 * HarnessEvent shape itself live beside it in events.ts; the split keeps the append path's
 * fs machinery (and its stat-memo cache) apart from the read path's parse-and-scan machinery
 * (and its own stat-keyed cache), so each cache and each failure mode has one home. Human-
 * facing formatting lives in event-format.ts; the windowed reader in event-window.ts. */

/** Parse one line of the event log into a HarnessEvent, or null when it is torn or corrupt
 * (a crash mid-append leaves a partial final line without its newline). The single home of
 * the skip-without-failing policy every consumer of events.jsonl applies — readEvents here,
 * report.ts's window scan, and `tumwater logs -f`'s follow branch all parse through it instead
 * of repeating the try/catch per reader. A valid-JSON scalar, `null`, or array is not an event
 * object either: the log is one JSON object per line, so anything else is corrupt (or foreign)
 * and reads as no data — the same object check readJsonFile applies to the harness's state
 * files. Without it, `readEvents` pushes the truthy non-object into the feed and `formatEvent`
 * renders it as an `Invalid Date undefined` line. */
export function parseEventLine(line: string): HarnessEvent | null {
  const parsed = parseJsonObject(line);
  return parsed ? (parsed as HarnessEvent) : null;
}

/** The local calendar-day key ("YYYY-MM-DD") of an event's `ts`, or null when it carries no
 * numeric timestamp. The one day-bucketing rule the windowed reader (event-window.ts) and the
 * usage/failure reports all apply, so they agree on what counts as one day. */
export function eventDayKey(ev: HarnessEvent): string | null {
  return typeof ev.ts === "number" ? dayKey(ev.ts) : null;
}

/** The loop id an event is filed under, or "?" when absent or empty — the guard the usage
 * report and the failure digest both apply when grouping by role. */
export function eventRole(ev: HarnessEvent): string {
  return typeof ev.loop === "string" && ev.loop !== "" ? ev.loop : "?";
}

/** The usage numbers an event records (`tick_end`'s own run, `landed`'s landing slot):
 * `tokens` and `costUsd` arrive `unknown` through the event's index signature, so they are
 * coerced to numbers here, with an absent, non-numeric, or non-finite value reading as 0 —
 * the one convention every usage consumer applies (the event feed's usage fragment,
 * `tumwater history`'s rows and --json, the usage report's fold), so the field rule —
 * including what a corrupt value contributes — lives beside the consumers, not re-spelled
 * per consumer. */
export function eventUsage(ev: HarnessEvent): { tokens: number; costUsd: number } {
  const tokens = typeof ev.tokens === "number" && Number.isFinite(ev.tokens) ? ev.tokens : 0;
  const costUsd =
    typeof ev.costUsd === "number" && Number.isFinite(ev.costUsd) ? ev.costUsd : 0;
  return { tokens, costUsd };
}

/** Pair the tick_start events of `events` by tick, keyed `${loop}#${tick}` → start epoch ms —
 * the one home of that pairing and its key format, shared by `tumwater history`'s rows
 * (history-data.ts) and the failure digest's time-and-spend fold (failure-data.ts), so the two
 * consumers cannot drift into different notions of a tick's span. A tick_end whose start is
 * not in `events` (log rotation cut it, or the tick was skipped before any start logged) has
 * no entry; callers decide what an unpaired end costs. Lives in the read module, not in a ui
 * module, so core collectors can share it without a core→ui import. */
export function tickStartMap(events: HarnessEvent[]): Map<string, number> {
  const starts = new Map<string, number>();
  for (const e of events) {
    if (e.type === "tick_start") starts.set(`${e.loop}#${e.tick}`, e.ts);
  }
  return starts;
}

/** The start→end span of the `tick_end` event `ev` against `starts` (tickStartMap's pairing):
 * the `${loop}#${tick}` lookup and the clamp to non-negative, in one place beside the map
 * they index, so the key format and the span rule are spelled once. null when the start is
 * missing (rotation cut it); callers decide what an unpaired end costs — the failure digest
 * prices it as 0, history renders it as "—". */
export function tickSpanMs(ev: HarnessEvent, starts: Map<string, number>): number | null {
  const startTs = starts.get(`${ev.loop}#${ev.tick}`);
  return startTs === undefined ? null : Math.max(0, ev.ts - startTs);
}

/** Read the last `limit` events (best-effort; skips malformed lines).
 * A limit that is not a positive number reads as an empty window — `[]` — matching
 * readTranscriptTail's zero-boundary semantics (the raw `lines.slice(-limit)` below would not: `slice(-0)` is
 * `slice(0)`, which returns the whole scanned window, and a negative limit makes `slice`
 * positive-started, returning the window minus its first `-limit` lines).
 * Observers poll this every second and only ever need the tail, so for logs past the small-file
 * threshold we read just enough bytes from the end of the file to cover `limit` lines instead of
 * rescanning the whole log: per-poll I/O is bounded by what `limit` lines occupy, not by how far
 * the log has grown (the backwards chunk scan lives in tail.readTailText). The parsed tail is
 * also stat-keyed cached (stat-cache.cachedByStat, like the other per-poll readers): the log is
 * append-only, so an unchanged stat means unchanged tail bytes, and a steady-state poll costs
 * one stat instead of open + read + `limit` JSON.parse calls. Rotation swaps the inode and every
 * append changes size, so both invalidate through the same freshness check. */
export function readEvents(root: string, limit = 200): HarnessEvent[] {
  // A non-positive guard (`limit <= 0`) passes NaN — every comparison with NaN is false —
  // and slice(-NaN) is slice(0), the whole scanned window; the sibling readTranscriptTail
  // and readTranscript guards are `limit > 0` positives-checks for exactly this reason.
  if (!(limit > 0)) return []; // NaN, 0, negatives: none — and the guard must precede the scan and the slice.
  const file = eventsLogPath(root);
  return (
    cachedByStat(
      tailCache,
      `${file}\u0000${limit}`, // Per (file, limit): observers ask for different tail sizes.
      file,
      () => scanEventTail(file, limit), // A missing/unreadable log scans to [] — cached like an empty one.
      (events) => events.map((e) => ({ ...e })), // A copy: callers may treat the result as their own.
    ) ?? []
  );
}

/** Parsed tails keyed by file + limit (a future reader of a second window size from the same
 * log must not collide with the first). Bounded inside cachedByStat so many short-lived roots
 * in tests cannot grow it unbounded. */
const tailCache = new Map<string, StatKeyedValue<HarnessEvent[]>>();

/** The backwards tail scan readEvents caches: read just enough bytes from the end to cover
 * `limit` lines, parse them, keep the newest `limit` complete ones. Also reports the byte end
 * the scan covered through (tail.readTailTextWithEnd — the last complete line's boundary) for
 * callers that seed a follow from the same read. */
function scanEventTailWithEnd(file: string, limit: number): { events: HarnessEvent[]; coveredEnd: number } {
  let newlines = 0;
  const { text, coveredEnd } = readTailTextWithEnd(file, (chunk) => {
    for (let i = 0; i < chunk.length; i++) if (chunk[i] === 10) newlines++;
    // limit+1 newlines guarantees `limit` complete lines after the first one
    // (the partial leading line, if any, is unparseable and skipped below).
    return newlines >= limit + 1;
  });

  let lines = text.split("\n").filter(Boolean);
  // A torn trailing line (no final \n — a write in flight, or between a crash and the next
  // event) would occupy one of the `limit` slots below and fail to parse: hold it back until
  // its newline lands, the same policy as readCompleteLines.
  if (lines.length > 0 && !text.endsWith("\n")) lines.pop();
  const tail = lines.slice(-limit);
  const events: HarnessEvent[] = [];
  for (const line of tail) {
    const ev = parseEventLine(line);
    if (ev) events.push(ev);
  }
  return { events, coveredEnd };
}

/** The cached scan's uncached twin, for one-shot callers that also need the covered byte end:
 * `tumwater logs -f` seeds its follow from the read that produced the printed window, so an
 * event appended between that read and the follow's start is delivered by the follow's first
 * poll instead of falling into the both-neither gap a fresh stat seed leaves. It skips the
 * stat-keyed cache because the cache carries only the parsed events — the covered end is not
 * part of the cached value — and this runs once per command invocation, not per poll. */
export function readEventsTailWithEnd(root: string, limit: number): { events: HarnessEvent[]; coveredEnd: number } {
  if (!(limit > 0)) return { events: [], coveredEnd: 0 }; // Same non-positive guard as readEvents.
  return scanEventTailWithEnd(eventsLogPath(root), limit);
}

/** The cached tail scan readEvents builds on: identical result, end dropped. */
function scanEventTail(file: string, limit: number): HarnessEvent[] {
  return scanEventTailWithEnd(file, limit).events;
}
