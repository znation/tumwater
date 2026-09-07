import { compactTokens, shortSha, usd } from "./text.js";
import type { HarnessEvent } from "./types.js";

/** The `$<spent> of $<cap>` fragment both budget transition events share: the fields arrive
 * loosely typed on HarnessEvent, so each is coerced and rendered through the shared cents-
 * pinned money format (usd) in one place. */
function budgetPhrase(e: HarnessEvent): string {
  return `${usd(Number(e.spentUsd ?? 0))} of ${usd(Number(e.capUsd ?? 0))}`;
}

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
      // Per-tick usage (PLANS.md, per-tick-usage plan): where the day's spend went. The
      // fields arrive loosely typed on HarnessEvent and are omitted when zero or absent,
      // so skipped ticks and zero-usage error ticks render byte-identical to a pre-feature
      // line — no trailing separator. "·" is the separator the budget badge already uses.
      const tokens = Number(e.tokens ?? 0);
      const costUsd = Number(e.costUsd ?? 0);
      const usage =
        (tokens > 0 ? ` · ${compactTokens(tokens)} tok` : "") +
        (costUsd > 0 ? ` · ${usd(costUsd)}` : "");
      return `${time} ${loop} tick #${e.tick} ${e.result}${extra}${usage}`;
    }
    case "merged":
      return `${time} ${loop} merged ${shortSha(e.commit)} to main — ${e.summary}`;
    case "question_posted":
      // Routine operation (a loop asked the user something), not a warning.
      return `${time} ${loop} question posted: ${e.question}`;
    case "wake":
      return `${time} ${loop} woke (${e.reason})`;
    case "orchestrator_start":
      return `${time} ${loop} orchestrator started (pid ${e.pid}${e.build ? `, build ${shortSha(e.build)}` : ""})`;
    case "orchestrator_stop":
      return `${time} ${loop} orchestrator stopped`;
    case "prompt_enqueued":
      return `${time} ${loop} user prompt queued: ${String(e.preview)}`;
    case "prompt_cancelled":
      // Routine operation (the user removed a queued prompt), not a warning.
      return `${time} ${loop} user prompt cancelled: ${String(e.preview)}`;
    case "counters_reset": {
      // One role → the event is filed under that loop; several → one harness-level event
      // listing them.
      const scope = Array.isArray(e.roles) && e.roles.length > 0 ? ` for ${e.roles.join(", ")}` : "";
      return `${time} ${loop} counters reset${scope} (ticks, commits, tokens, cost)`;
    }
    case "tick_aborted":
      // Routine state change (the user stopped one loop's tick), like counters_reset — no
      // warning prefix. The resulting tick_end line carries the user_aborted outcome.
      return `${time} ${loop} tick aborted by user`;
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
    case "budget_paused":
      // Routine state change, like counters_reset — no warning prefix.
      return `${time} ${loop} budget paused — ${budgetPhrase(e)} daily cost reached`;
    case "budget_resumed":
      return `${time} ${loop} budget resumed (${budgetPhrase(e)} today)`;
    case "fleet_paused":
      // Routine state change, like counters_reset — no warning prefix.
      return `${time} ${loop} fleet paused — role loops stop starting new ticks (director keeps running)`;
    case "fleet_resumed":
      return `${time} ${loop} fleet resumed — role loops tick again`;
    case "max_concurrent_changed": {
      // Routine state change, like counters_reset — no warning prefix.
      return `${time} ${loop} maxConcurrent changed: ${e.from} → ${e.to}`;
    }
    case "retention_changed": {
      // Routine state change, like its maxConcurrent sibling — no warning prefix.
      return `${time} ${loop} sessionRetentionDays changed: ${e.from} → ${e.to}`;
    }
    case "build_stale":
      // Self-hosting fleets only (src/redeploy.ts): the code main describes is not the code
      // running. Not a warning prefix — a stale build is a state, and auto-restart resolves it.
      return `${time} ${loop} build ${shortSha(e.build)} is stale — main ${shortSha(e.head)} is ${e.aheadCommits} commit(s) ahead in src/`;
    case "restart_pending":
      return `${time} ${loop} restart pending — main ${shortSha(e.head)} is green; compiling and draining in-flight ticks (no new ticks start)`;
    case "restart":
      return `${time} ${loop} restarting onto build ${shortSha(e.to)} (drained ${Math.round(Number(e.drainedMs ?? 0) / 60_000)}m${
        Number(e.abortedTicks ?? 0) > 0 ? `, ${e.abortedTicks} tick(s) will resume on the new build` : ""
      })`;
    case "resume":
      // Two causes share the resume machinery; the line names the real one so an operator
      // reading the feed can tell a restart from a loop fighting the context ceiling.
      return e.cause === "cut-off"
        ? `${time} ${loop} resuming the run cut off at the context ceiling (compacted pi session, same worktree)`
        : `${time} ${loop} resuming the tick a shutdown interrupted (same pi session and worktree)`;
    case "warning":
      return `${time} ${loop} warning: ${e.message}`;
    default:
      return `${time} ${loop} ${e.type}`;
  }
}
