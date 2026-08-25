import fs from "node:fs";
import path from "node:path";
import type { HarnessEvent } from "./types.js";
import { eventsLogPath } from "./paths.js";
import { rotateIfLarge, statOrNull } from "./files.js";

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
 * are allowed via the index signature. */
export interface HarnessEventInput {
  loop: string;
  type: HarnessEvent["type"];
  [key: string]: unknown;
}

/** Append one event to the project's events.jsonl and notify in-process subscribers. */
export function logEvent(root: string, event: HarnessEventInput): HarnessEvent {
  const full = { ts: Date.now(), ...event };
  const file = eventsLogPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  rotateIfLarge(file, EVENTS_MAX_BYTES);
  fs.appendFileSync(file, JSON.stringify(full) + "\n");
  for (const listener of listeners) listener(full);
  return full;
}

/** Files at or under this size are read whole; larger ones get a tail window. */
const TAIL_SCAN_THRESHOLD = 256 * 1024;
/** Chunk size for the backwards tail scan of a large event log. */
const TAIL_CHUNK_BYTES = 64 * 1024;

/** Read the last `limit` events (best-effort; skips malformed lines).
 * Observers poll this every second and only ever need the tail, so past
 * TAIL_SCAN_THRESHOLD we read just enough bytes from the end of the file to cover
 * `limit` lines instead of rescanning the whole log (which grows up to
 * EVENTS_MAX_BYTES between rotations). */
export function readEvents(root: string, limit = 200): HarnessEvent[] {
  const file = eventsLogPath(root);
  const st = statOrNull(file);
  if (!st || st.size === 0) return []; // No log yet.
  let size = st.size;

  let text: string;
  if (size <= TAIL_SCAN_THRESHOLD) {
    text = fs.readFileSync(file, "utf8");
  } else {
    const fd = fs.openSync(file, "r");
    try {
      // fstat on the opened inode stays correct even if rotation renames the file mid-read.
      size = fs.fstatSync(fd).size;
      let end = size;
      const parts: Buffer[] = [];
      let newlines = 0;
      for (;;) {
        const len = Math.min(TAIL_CHUNK_BYTES, end);
        const buf = Buffer.alloc(len);
        const got = fs.readSync(fd, buf, 0, len, end - len);
        if (got === 0) break; // File shrank under us; use what we have.
        parts.unshift(buf.subarray(0, got));
        for (let i = 0; i < got; i++) if (buf[i] === 10) newlines++;
        end -= got;
        // limit+1 newlines guarantees `limit` complete lines after the first one
        // (the partial leading line, if any, is unparseable and skipped below).
        if (newlines >= limit + 1 || end <= 0) break;
      }
      text = Buffer.concat(parts).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  }

  const lines = text.split("\n").filter(Boolean);
  const tail = lines.slice(-limit);
  const events: HarnessEvent[] = [];
  for (const line of tail) {
    try {
      events.push(JSON.parse(line) as HarnessEvent);
    } catch {
      // Skip partial/corrupt lines (e.g. torn writes).
    }
  }
  return events;
}

// Human-facing formatting of events lives in event-format.ts (presentation, shared by the
// display surfaces); this module owns only the log file and its subscribers.
