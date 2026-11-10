import type { HarnessEvent } from "./events.js";
import { eventRun } from "./event-read.js";
import { eventTypeLabel } from "./event-labels.js";
import { plural, rolesPhrase } from "../text/phrases.js";
import { textOr } from "../text/text.js";
import { finiteNumber } from "../files/json-object.js";
import { usagePhrase, outcomeText, deferredReasonText } from "./event-format-fragments.js";

export function runEventMessage(e: HarnessEvent): string {
  switch (e.type) {
    case "run_start":
      return runStartMessage(e);
    case "run_end":
      return runEndMessage(e);
    case "run_deferred":
      // Routine state change (need-based prioritization), like counters_reset — no warning
      // prefix. One per deferral episode; the run's own events cover the episode's end.
      return `deferred — ${deferredReasonText(e)}`;
    case "run_aborted":
      // Routine state change (the user stopped one role's run), like counters_reset — no
      // warning prefix. The resulting run_end line carries the user_aborted outcome.
      return `run stopped by you`;
    case "resume":
      return resumeEventMessage(e);
    case "wake":
      return `woke (${textOr(e.reason)})`;
    case "counters_reset":
      return countersResetMessage(e);
    case "claim":
      return claimEventMessage(e);
    case "permit_reserve":
      // Priority headroom (part 7/7): a reserve appearing or vanishing is the scheduler working
      // as designed; it names the permits withheld for the work tier so an operator can see why
      // maintenance concurrency dipped.
      return `${plural(finiteNumber(e.reserve, 0), "permit")} reserved for work roles that have work to take`;
    default: return textOr(e.type);
  }
}

/** The `run_start` line: the run number, plus the model only when the event names one. */
function runStartMessage(e: HarnessEvent): string {
  return `run #${eventRun(e)} started${e.model !== undefined ? ` on ${textOr(e.model)}` : ""}`;
}

/** The `run_end` line: the outcome, its explaining payload, and the per-run usage. */
function runEndMessage(e: HarnessEvent): string {
  // The payload that explains the outcome: summary for changed/refused/rejected/
  // review_error runs, error (lastError) for error and merge-failed ones. Showing it
  // for every result that carries one keeps the event feed self-explanatory — a bare
  // "run #N refused" would force operators to open the transcript for the reason.
  const extra = e.summary ? ` — ${textOr(e.summary)}` : e.error ? ` — ${textOr(e.error)}` : "";
  // Per-run usage: where the day's spend went.
  return `run #${eventRun(e)} ${eventTypeLabel(outcomeText(e))}${extra}${usagePhrase(e)}`;
}

/** The `resume` line: the real cause of the restart, plus the restored-edits suffix. */
function resumeEventMessage(e: HarnessEvent): string {
  // Two causes share the resume machinery; the line names the real one so an operator
  // reading the feed can tell a restart from a role fighting the context ceiling, and a
  // cross-agent handoff from either — the handoff keeps the worktree but starts fresh. A
  // run that got a salvaged patch back (src/git/slot-salvage.ts) names the patch.
  const restored = e.restored === undefined ? "" : ` — uncommitted edits restored from ${textOr(e.restored)}`;
  return (
    (e.cause === "cut-off"
      ? "resuming the run cut off at the context ceiling (compacted pi session, same workspace)"
      : e.cause === "handoff"
        ? "handing the interrupted run off to a fresh session on another agent (same workspace, uncommitted edits kept)"
        : e.cause === "image-reroute"
          ? "handing the blind-read run off to a fresh session on an image-capable model (same workspace, uncommitted edits kept)"
          : e.cause === "salvaged"
            ? "handing the work an earlier run left unsaved to a fresh session"
            : e.cause === "model-check"
              ? "resuming the run stopped while its model did not answer, on a model that passes its model check (same workspace)"
              : "resuming the run a shutdown interrupted (same agent session and workspace)") + restored
  );
}

/** The `counters_reset` line: names the affected roles when several are. */
function countersResetMessage(e: HarnessEvent): string {
  // One role → the event is filed under that role; several → one harness-level event
  // listing them.
  const roles = rolesPhrase(e.roles, "");
  const scope = roles ? ` for ${roles}` : "";
  return `counters reset${scope} (runs, merges, tokens, cost)`;
}

/** The `claim` line: the parallel-work-instance assignment or release. */
function claimEventMessage(e: HarnessEvent): string {
  // Parallel work instances (plans/parallel-work-instances.md "Observability", part 6/7):
  // the assignment/release is the harness working as designed, so no warning prefix.
  return e.action === "released"
    ? `released "${textOr(e.title)}" (${textOr(e.reason, "?")})`
    : `assigned "${textOr(e.title)}"`;
}
