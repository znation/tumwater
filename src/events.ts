import fs from "node:fs";
import path from "node:path";
import type { HarnessEvent } from "./types.js";
import { eventsLogPath } from "./paths.js";

/** Append one event to the project's events.jsonl. */
export function logEvent(root: string, event: Omit<HarnessEvent, "ts"> & { ts?: number }): HarnessEvent {
  const full: HarnessEvent = { ts: Date.now(), ...event } as HarnessEvent;
  const file = eventsLogPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(full) + "\n");
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
