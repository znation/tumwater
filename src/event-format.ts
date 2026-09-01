import { shortSha } from "./text.js";
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
      // The payload that explains the outcome: summary for changed/refused/rejected/
      // review_error ticks, error (lastError) for error and merge-failed ones. Showing it
      // for every result that carries one keeps the event feed self-explanatory — a bare
      // "tick #N refused" would force operators to open the transcript for the reason.
      const extra = e.summary ? ` — ${e.summary}` : e.error ? ` — ${e.error}` : "";
      return `${time} ${loop} tick #${e.tick} ${e.result}${extra}`;
    }
    case "merged":
      return `${time} ${loop} merged ${shortSha(e.commit)} to main — ${e.summary}`;
    case "question_posted":
      // Routine operation (a loop asked the user something), not a warning.
      return `${time} ${loop} question posted: ${e.question}`;
    case "wake":
      return `${time} ${loop} woke (${e.reason})`;
    case "orchestrator_start":
      return `${time} ${loop} orchestrator started (pid ${e.pid})`;
    case "orchestrator_stop":
      return `${time} ${loop} orchestrator stopped`;
    case "prompt_enqueued":
      return `${time} ${loop} user prompt queued: ${String(e.preview)}`;
    case "counters_reset": {
      // One role → the event is filed under that loop; several → one harness-level event
      // listing them.
      const scope = Array.isArray(e.roles) && e.roles.length > 0 ? ` for ${e.roles.join(", ")}` : "";
      return `${time} ${loop} counters reset${scope} (ticks, commits, tokens, cost)`;
    }
    case "review_start":
      return `${time} ${loop} reviewing ${shortSha(e.head)} before merge`;
    case "review_verdict":
      return `${time} ${loop} review approved ${shortSha(e.head)}${e.reason ? ` — ${e.reason}` : ""}`;
    case "review_rejected": {
      const reasons = Array.isArray(e.reasons) ? (e.reasons as string[]) : [];
      return `${time} ${loop} review rejected ${shortSha(e.head)} — ${reasons[0] ?? "no reasons given"}`;
    }
    case "review_failed":
      return `${time} ${loop} review failed for ${shortSha(e.head)}: ${e.message} (commit kept for re-review)`;
    case "budget_paused": {
      // Routine state change, like counters_reset — no warning prefix.
      const spent = Number(e.spentUsd ?? 0).toFixed(2);
      const cap = Number(e.capUsd ?? 0).toFixed(2);
      return `${time} ${loop} budget paused — $${spent} of $${cap} daily cost reached`;
    }
    case "budget_resumed": {
      const spent = Number(e.spentUsd ?? 0).toFixed(2);
      const cap = Number(e.capUsd ?? 0).toFixed(2);
      return `${time} ${loop} budget resumed ($${spent} of $${cap} today)`;
    }
    case "max_concurrent_changed": {
      // Routine state change, like counters_reset — no warning prefix.
      return `${time} ${loop} maxConcurrent changed: ${e.from} → ${e.to}`;
    }
    case "resume":
      return `${time} ${loop} resuming the tick a shutdown interrupted (same pi session and worktree)`;
    case "warning":
      return `${time} ${loop} warning: ${e.message}`;
    default:
      return `${time} ${loop} ${e.type}`;
  }
}
