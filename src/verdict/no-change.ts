import type { PiRunResult } from "../pi/pi-run-result.js";
import { NOTHING_TO_DO } from "./reply-contract.js";
import { truncate } from "../text/text.js";

/** Diagnosis of a pi run that ended without worktree changes: whether the generation was cut
 * off at the context ceiling (real work, unfulfilled) and the diagnostic notes for the warning
 * event logged when no nothing-to-do sentinel appeared anywhere in the reply. Split out of
 * runner.ts so the classification — with its own data model — has a single testable home; the
 * run verdict (run-verdict.ts) logs the warning and re-queues unfulfilled prompts from it. */

interface NoChangeDiagnosis {
  /** True when the run did real work but was truncated before it could declare its outcome:
   * no nothing-to-do sentinel AND a final message with neither text nor tool call (see
   * PiRunResult.finalMessageContentless). Such a run is NOT fulfilled — a director prompt
   * goes back to the inbox, a role resumes its compacted session next run. */
  cutOff: boolean;
  /** True when the run ended on a checkpoint abort: its final message is contentless, it
   * stopped "aborted", and no compaction was ever written (BUGS.md 2026-11-16). Distinguished
   * from a context-ceiling cut-off (also contentless, but a normal stop and a compaction);
   * such a run is NOT a cut-off — it ends as an ordinary no_change rather than resuming a
   * session that was never compacted. */
  checkpointAborted: boolean;
  /** Diagnostic notes for the warning event when no sentinel appeared (empty otherwise): an
   * abnormal stopReason, missing assistant text, a contentless final message (a checkpoint
   * abort, or a ceiling cut-off), and auto-compaction — so a no-sentinel no_change run is
   * diagnosable from its event alone. */
  notes: string[];
}

/** Classify a pi run that finished without worktree changes. A compliant finish always ends
 * with a text block (the sentinel or the SUMMARY/WHY/RISK/VERIFIED block), so a missing
 * sentinel is either non-compliance or truncation — the notes tell which: an abnormal
 * stopReason (e.g. "length"), no assistant text at all, a final message with neither text nor
 * tool call (typically pi clamping max output tokens to the sliver left under the declared
 * context window, with the provider misreporting the truncation as a normal stop), and whether
 * pi auto-compacted the session. */
export function diagnoseNoChange(pi: PiRunResult): NoChangeDiagnosis {
  // A checkpoint abort (BUGS.md 2026-11-16) ends the turn contentless with stopReason
  // "aborted" and writes no compaction (pi 1.5.2's fire-and-forget compact() aborts the turn
  // still running it). Its contentless final is NOT a context-ceiling cut-off: a ceiling
  // cut-off stops normally and pi compacts it. Distinguish the two by the abort plus the
  // missing compaction, and name the real cause.
  const checkpointAborted =
    !pi.nothingToDo && pi.finalMessageContentless && pi.stopReason === "aborted" && !pi.compacted;
  // A checkpoint abort did real work but was never compacted, so resuming it would hand the
  // model a session that was never summarized and claim otherwise — it is not a cut-off and
  // must not arm a resume (BUGS.md 2026-11-16). A ceiling cut-off is.
  const cutOff = !pi.nothingToDo && pi.finalMessageContentless && !checkpointAborted;
  if (pi.nothingToDo) return { cutOff, checkpointAborted, notes: [] }; // Sentinel present — nothing to diagnose.
  const notes: string[] = [];
  if (pi.stopReason && pi.stopReason !== "stop") notes.push(`stopReason=${pi.stopReason}`);
  if (!pi.finalText.trim()) notes.push("no assistant text");
  if (pi.finalMessageContentless)
    notes.push(
      checkpointAborted
        ? "final message had no text or tool call — the run ended on a checkpoint abort, not a context-ceiling cut-off"
        : "final message had no text or tool call — likely cut off at the context ceiling",
    );
  if (pi.compacted) notes.push("pi auto-compacted the session");
  return { cutOff, checkpointAborted, notes };
}

/** Cap on a no-change answer kept as the run's summary, so a verbose reply cannot bloat the
 * dashboard's last-result cell (the same cap commit-message.ts applies to a changed run's
 * SUMMARY). */
const NO_CHANGE_ANSWER_MAX = 100;

/** The prose answer a no-change pi run wrote above its NOTHING_TO_DO sentinel — the director's
 * reply to a question-only prompt, which ends `no_change` with no SUMMARY block (BUGS.md
 * 2026-10-14). Everything before the sentinel line, trimmed; null when the reply carried no
 * text of its own above the sentinel (a bare sentinel, or a cut-off run whose reply never
 * reached one). Only a prompt-driven (director) run treats it as the run's summary — a role's
 * bare nothing-to-do stays summary-less, decided by the verdict, not here. */
export function extractNoChangeAnswer(finalText: string): string | null {
  const idx = finalText.indexOf(NOTHING_TO_DO);
  if (idx < 0) return null;
  const before = finalText.slice(0, idx).trim();
  return before === "" ? null : truncate(before, NO_CHANGE_ANSWER_MAX);
}
