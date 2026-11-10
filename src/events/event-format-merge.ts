import type { HarnessEvent } from "./events.js";
import { eventTypeLabel } from "./event-labels.js";
import { shortSha } from "../text/format.js";
import { isNonBlankString, joinWithMore, textOr, truncate } from "../text/text.js";
import { finiteNumber, stringList } from "../files/json-object.js";
import { usagePhrase, elapsed, outcomeText } from "./event-format-fragments.js";

function mergeQueuedMessage(e: HarnessEvent): string {
  // Merge queue 3/5: routine state change (the run committed and the merge slot is
  // ahead) — no warning prefix. The merge's own events follow it. A retry-bearing event
  // (a re-queued entry) appends its why-it-is-back suffix; a
  // fresh enqueue's line stays byte-identical.
  const base = `waiting to merge ${shortSha(e.commit)} — ${textOr(e.summary)}`;
  return `${base}${typeof e.retry === "string" && e.retry ? ` (re-queued after ${textOr(e.retry)})` : ""}`;
}
function mergeFailedMessage(e: HarnessEvent): string {
  // The event names its reason itself (writeMergeOutcome); the review/check events still
  // carry the full text. An old event without `reason` renders the bare outcome.
  return `merge of ${shortSha(e.commit)} failed (${eventTypeLabel(outcomeText(e))}${isNonBlankString(e.reason) ? `: ${truncate(e.reason.trim(), 120)}` : ""})${elapsed(e.durationMs)}${isNonBlankString(e.summary) ? ` — ${truncate(e.summary, 80)}` : ""}`;
}
function conflictHandbackMessage(e: HarnessEvent): string {
  // A change whose merges kept conflicting was handed back to its author with the markers
  // in place (PLANS.md "Robust conflict landing, part 2/2"): queued, applied, or failed.
  const files = stringList(e.conflicted);
  const where = files.length > 0 ? `: ${files.join(", ")}` : "";
  const why = e.reason === "revision" ? " (revision)" : "";
  return `conflict hand-back ${textOr(e.action)} ${shortSha(e.sha)}${why}${where}`;
}
function operatorRevertMessage(e: HarnessEvent): string {
  const undid = typeof e.runner === "string" && e.runner !== "" ? `, undid ${e.runner}` : "";
  return `reverted ${shortSha(e.commit)} (by operator) as ${shortSha(e.revert)}${undid}`; // vocabulary-ok: the deliberate-revert writer is the operator role
}
function mainCheckMessage(e: HarnessEvent): string {
  const failing = Array.isArray(e.failingTests) ? e.failingTests.map(String) : [];
  // The commit count renders only when it is a real number over 1 — the corrupt-field rule
  // this file applies to every event number (a hand-edited line's quoted "3" or "0x10" reads
  // as no covered count, not as a coerced parenthetical).
  const coveredN = finiteNumber(e.covered, null);
  const covered = coveredN !== null && coveredN > 1 ? ` (${coveredN} commits)` : "";
  const verdict = e.status === "failed" ? "failed" : "passed";
  const names = failing.length > 0 ? `: ${joinWithMore(failing, 3, "; ")}` : "";
  return `main ${shortSha(e.sha)}${covered} full check ${verdict}${names}`;
}
function mainCulpritMessage(e: HarnessEvent): string {
  const by = typeof e.runner === "string" && e.runner !== "" ? ` (merged by ${e.runner})` : "";
  return `main turned red at ${shortSha(e.commit)}${by}`;
}
export function mergeEventMessage(e: HarnessEvent): string {
  switch (e.type) {
    case "merged":
      return `merged ${shortSha(e.commit)} to main — ${textOr(e.summary)}`;
    case "merge_queued":
      return mergeQueuedMessage(e);
    case "merge_cancelled":
      // Routine operation (the user removed a waiting merge), not a warning — like
      // prompt_cancelled. The merge_cancelled event name carries the payload (commit + summary).
      return `cancelled the merge of ${shortSha(e.commit)} — ${textOr(e.summary)}`;
    case "merge_topped":
      // Routine operation (the user reordered a waiting merge), not a warning — like
      // prompt_topped. The merge_topped event name carries the payload (commit + summary).
      return `moved the merge of ${shortSha(e.commit)} to the front — ${textOr(e.summary)}`;
    case "merge_done":
      // The merge slot finished with the change on main; the usage is the merge's own
      // spend (reviewer + conflict resolution), omitted when zero so review-exempt merges
      // render bare — the same phrase run_end carries for its run.
      return `merge of ${shortSha(e.commit)} done${elapsed(e.durationMs)}${usagePhrase(e)}`;
    case "merge_failed":
      return mergeFailedMessage(e);
    case "conflict_handback":
      return conflictHandbackMessage(e);
    case "operator_revert":
      return operatorRevertMessage(e);
    case "main_check":
      return mainCheckMessage(e);
    case "main_culprit":
      return mainCulpritMessage(e);
    case "main_red_hold":
      // The message already names the SHA, script, and consequence; the problem tone comes
      // from PROBLEM_EVENTS.
      return textOr(e.message);
    default: return textOr(e.type);
  }
}
