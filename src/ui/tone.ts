import { loopRank } from "./status-model.js";

/** The shared COLOR/EVENT-CLASSIFICATION vocabulary of the observer surfaces, split out of
 * status-model.ts (which keeps only the status display model: loop phases, badges, row cells):
 * the tone palette both surfaces color by, a tick result's tone, and what kind of news an
 * event is for the activity feeds. Kept apart from the renderers (status-render.ts,
 * tui-frame.ts) so "what color is this" lives in one place while "how a terminal draws it"
 * stays with the layout. The dashboard draws the same families in its own tones
 * (gui-client-model.ts phaseInfo/resultInfo/eventKind; test/gui-client.test.ts and
 * test/tui-frame.test.ts keep the copies aligned): in-progress work blue, a loop that needs
 * attention red, a held loop yellow, a landed change green, a change on its way to landing
 * cyan; idle states and neutral outcomes stay uncolored. */

/** The colors the observer surfaces share for loop state and tick outcomes, as the terminal's
 * base palette names them — so they follow the user's terminal theme. */
export type Tone = "blue" | "red" | "yellow" | "green" | "cyan" | "magenta" | "dim";

/** A loop phase label's (status-model loopPhase) tone, by its rank: live and pipeline work
 * blue, attention red, paused yellow, idle none. */
export function phaseTone(phase: string): Tone | undefined {
  const rank = loopRank(phase);
  return rank <= 1 ? "blue" : rank === 2 ? "red" : rank === 3 ? "yellow" : undefined;
}

/** A tick result's tone (tick-outcome.ts TickResult): landed green, queued to land cyan, the
 * failures red, the held-back outcomes (refused, rejected, interrupted, stalled) yellow. */
export function resultTone(result: string | undefined | null): Tone | undefined {
  switch (result) {
    case "changed":
      return "green";
    case "queued":
      return "cyan";
    case "error":
    case "merge_conflict":
    case "merge_blocked":
    case "review_error":
    case "main_red":
      return "red";
    case "refused":
    case "rejected":
    case "aborted":
    case "quiet_killed":
      return "yellow";
    default:
      return undefined;
  }
}

/** What kind of news an event is, for the activity feeds: a landing, a problem, a question for
 * the operator, a notice about the fleet, or routine bookkeeping (a tick starting, a passing
 * check). The dashboard's activity card filters on it and both surfaces tone by it; the page's
 * browser copy (gui-client-model.ts eventKind) is pinned to this one by test. */
type EventKind = "landing" | "problem" | "attention" | "info" | "routine";

const PROBLEM_RESULTS = new Set(["refused", "rejected", "review_error", "merge_conflict", "merge_blocked", "error", "aborted", "quiet_killed", "main_red"]);
const ROUTINE_EVENTS = new Set(["tick_start", "wake", "tick_deferred", "review_start", "review_verdict", "land_queued", "landed", "resume", "counters_reset"]);
const PROBLEM_EVENTS = new Set(["land_failed", "review_rejected", "review_failed", "restart_blocked", "restart_refused", "budget_warning", "budget_paused", "role_cap_paused", "supervisor_exit", "warning"]);

/** Which EventKind one event is, checked in precedence order: the two hard-coded news types
 * first (merged, question_posted), then the result-carrying types by their result — a tick_end
 * is routine unless its result is a known failure, and a build_check is routine only when it
 * passed or was skipped — then the named event sets, with anything unrecognized reading as
 * info (an event this file predates is news until it is classified). */
export function eventKind(type: string, result?: string): EventKind {
  if (type === "merged") return "landing";
  if (type === "question_posted") return "attention";
  if (type === "tick_end") return result !== undefined && PROBLEM_RESULTS.has(result) ? "problem" : "routine";
  if (type === "build_check") return result === "passed" || result === "skipped" ? "routine" : "problem";
  if (PROBLEM_EVENTS.has(type)) return "problem";
  if (ROUTINE_EVENTS.has(type)) return "routine";
  return "info";
}
