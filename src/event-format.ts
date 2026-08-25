import type { HarnessEvent } from "./types.js";

/** Human one-liner for an event, shared by `logs`, `run` output, the TUI activity pane, and the
 * GUI event feed. Presentation only: depends on the event shape (types.ts), not on events.ts's
 * log I/O — so display surfaces never import formatting from the logging module. */
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
