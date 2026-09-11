import fs from "node:fs";
import type { HarnessEvent } from "./types.js";
import { eventsLogPath } from "./paths.js";
import {
  ensureParentDir,
  forEachTailChunk,
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

/** Append a newline when `file`'s last byte is not one — terminating a torn trailing line so
 * the next append starts on its own line instead of gluing onto the fragment. No-op for a
 * missing, empty, or already-terminated file; never throws (a vanished file just means there
 * is nothing to terminate). Runs after rotateIfLarge: rotation moves any torn tail into the
 * unread `.1` archive and starts an empty file that needs no termination. */
function terminateTornTail(file: string): void {
  const st = statOrNull(file);
  if (!st || st.size === 0) return; // No log yet.
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return; // Vanished between stat and open — nothing to terminate.
  }
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

/** Read the last `limit` events (best-effort; skips malformed lines).
 * Observers poll this every second and only ever need the tail, so for logs past the small-file
 * threshold we read just enough bytes from the end of the file to cover `limit` lines instead of
 * rescanning the whole log: per-poll I/O is bounded by what `limit` lines occupy, not by how far
 * the log has grown (the backwards chunk scan lives in files.forEachTailChunk). */
export function readEvents(root: string, limit = 200): HarnessEvent[] {
  const file = eventsLogPath(root);
  const parts: Buffer[] = [];
  let newlines = 0;
  forEachTailChunk(file, (chunk) => {
    parts.unshift(chunk);
    for (let i = 0; i < chunk.length; i++) if (chunk[i] === 10) newlines++;
    // limit+1 newlines guarantees `limit` complete lines after the first one
    // (the partial leading line, if any, is unparseable and skipped below).
    return newlines >= limit + 1;
  });
  const text = Buffer.concat(parts).toString("utf8");

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
