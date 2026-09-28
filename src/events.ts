import fs from "node:fs";
import type { HarnessEvent } from "./types.js";
import { eventsLogPath } from "./paths.js";
import { cachedByStat, type StatKeyedValue } from "./stat-cache.js";
import { dayKey } from "./datetime.js";
import { isJsonObject } from "./json-object.js";
import {
  ensureParentDir,
  openForRead,
  readTailText,
  rotateIfLarge,
  statOrNull,
} from "./files.js";

type EventListener = (event: HarnessEvent) => void;
const listeners = new Set<EventListener>();

/** Get notified of every event logged in this process (e.g. to narrate `tumwater run`).
 * Returns an unsubscribe function. */
export function subscribeEvents(listener: EventListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** events.jsonl rotation threshold. Role pi logs use the configurable logMaxBytes; the
 * harness event log is small per event, so a fixed cap keeps logEvent config-free. */
const EVENTS_MAX_BYTES = 16 * 1024 * 1024;

/** An event to log. `logEvent` stamps `ts`; event-specific extra fields (tick, summary, …)
 * are allowed via the index signature. Exported for modules that hand events to an injected
 * logger instead of calling logEvent directly (redeploy.ts). */
export interface HarnessEventInput {
  loop: string;
  type: HarnessEvent["type"];
  [key: string]: unknown;
}

/** Append one event to the project's events.jsonl and notify in-process subscribers.
 * A torn trailing line (a crash or power loss mid-append leaves the last line without its
 * newline) is terminated first: appended raw, the new event would glue onto the fragment and
 * both lines would fail JSON.parse forever — one complete event lost from every consumer
 * (report totals, feeds) until rotation. */
export function logEvent(root: string, event: HarnessEventInput): HarnessEvent {
  const full = { ts: Date.now(), ...event };
  const file = eventsLogPath(root);
  ensureParentDir(file);
  rotateIfLarge(file, EVENTS_MAX_BYTES);
  terminateTornTail(file);
  fs.appendFileSync(file, JSON.stringify(full) + "\n");
  for (const listener of listeners) listener(full);
  return full;
}

/** Log a warning event: the harness's "something is off but the loop continues" signal. The
 * single home of the `{ loop, type: "warning", message }` shape every warn site constructs —
 * without it, each caller restates the event object and a field can drift between them. */
export function warnEvent(root: string, loop: string, message: string): HarnessEvent {
  return logEvent(root, { loop, type: "warning", message });
}

/** Append a newline when `file`'s last byte is not one — terminating a torn trailing line so
 * the next append starts on its own line instead of gluing onto the fragment. No-op for a
 * missing, empty, or already-terminated file; never throws (a vanished file just means there
 * is nothing to terminate). Runs after rotateIfLarge: rotation moves any torn tail into the
 * unread `.1` archive and starts an empty file that needs no termination. */
function terminateTornTail(file: string): void {
  const st = statOrNull(file);
  if (!st || st.size === 0) return; // No log yet.
  const fd = openForRead(file);
  if (fd === null) return; // Vanished between stat and open — nothing to terminate.
  try {
    const size = fs.fstatSync(fd).size; // fstat on the opened inode: correct even if rotation renamed the file mid-check.
    if (size === 0) return;
    const buf = Buffer.alloc(1);
    const got = fs.readSync(fd, buf, 0, 1, size - 1);
    if (got !== 1 || (buf[0] ?? 0) === 10) return; // Already newline-terminated (or vanished).
    fs.appendFileSync(file, "\n");
  } finally {
    fs.closeSync(fd);
  }
}

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
  try {
    const parsed: unknown = JSON.parse(line);
    if (!isJsonObject(parsed)) return null; // Not an event object.
    return parsed as HarnessEvent;
  } catch {
    return null; // Skip partial/corrupt lines (e.g. torn writes).
  }
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

/** Read the last `limit` events (best-effort; skips malformed lines).
 * A limit that is not a positive number reads as an empty window — `[]` — matching
 * readTranscriptTail's zero-boundary semantics (the raw `lines.slice(-limit)` below would not: `slice(-0)` is
 * `slice(0)`, which returns the whole scanned window, and a negative limit makes `slice`
 * positive-started, returning the window minus its first `-limit` lines).
 * Observers poll this every second and only ever need the tail, so for logs past the small-file
 * threshold we read just enough bytes from the end of the file to cover `limit` lines instead of
 * rescanning the whole log: per-poll I/O is bounded by what `limit` lines occupy, not by how far
 * the log has grown (the backwards chunk scan lives in files.readTailText). The parsed tail is
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
 * `limit` lines, parse them, keep the newest `limit` complete ones. */
function scanEventTail(file: string, limit: number): HarnessEvent[] {
  let newlines = 0;
  const text = readTailText(file, (chunk) => {
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
  return events;
}

// Human-facing formatting of events lives in event-format.ts (presentation, shared by the
// display surfaces); this module owns only the log file and its subscribers.
