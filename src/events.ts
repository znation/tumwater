import fs from "node:fs";
import path from "node:path";
import type { HarnessEvent } from "./types.js";
import { eventsLogPath } from "./paths.js";
import { rotateIfLarge } from "./files.js";

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

/** Read the last `limit` events (best-effort; skips malformed lines). */
export function readEvents(root: string, limit = 200): HarnessEvent[] {
  const file = eventsLogPath(root);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
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

/** Human one-liner for an event, shared by `logs`, `run` output, and the TUI. */
export function formatEvent(e: HarnessEvent): string {
  const time = new Date(e.ts).toLocaleTimeString();
  const loop = String(e.loop).padEnd(9);
  switch (e.type) {
    case "tick_start":
      return `${time} ${loop} tick #${e.tick} started`;
    case "tick_end": {
      const extra =
        e.result === "changed"
          ? ` — ${e.summary}`
          : e.result === "error"
            ? ` — ${e.error}`
            : "";
      return `${time} ${loop} tick #${e.tick} ${e.result}${extra}`;
    }
    case "merged":
      return `${time} ${loop} merged ${String(e.commit).slice(0, 8)} to main — ${e.summary}`;
    case "wake":
      return `${time} ${loop} woke (${e.reason})`;
    case "orchestrator_start":
      return `${time} ${loop} orchestrator started (pid ${e.pid})`;
    case "orchestrator_stop":
      return `${time} ${loop} orchestrator stopped`;
    case "prompt_enqueued":
      return `${time} ${loop} user prompt queued: ${String(e.preview)}`;
    case "warning":
      return `${time} ${loop} warning: ${e.message}`;
    default:
      return `${time} ${loop} ${e.type}`;
  }
}
