import type { PiRunResult } from "../pi/pi-run-result.js";
import { NOTHING_TO_DO } from "./reply-contract.js";
import { truncate } from "../text/text.js";

/** Diagnosis of a pi run that ended without worktree changes: whether the generation was cut
 * off at the context ceiling (real work, unfulfilled) and the diagnostic notes for the warning
 * event logged when no nothing-to-do sentinel appeared anywhere in the reply. Split out of
 * runner.ts so the classification — with its own data model — has a single testable home; the
 * tick verdict (run-verdict.ts) logs the warning and re-queues unfulfilled prompts from it. */

interface NoChangeDiagnosis {
  /** True when the run did real work but was truncated before it could declare its outcome:
   * no nothing-to-do sentinel AND a final message with neither text nor tool call (see
   * PiRunResult.finalMessageContentless). Such a tick is NOT fulfilled — a director prompt
   * goes back to the inbox, a role resumes its compacted session next tick. */
  cutOff: boolean;
  /** Diagnostic notes for the warning event when no sentinel appeared (empty otherwise): an
   * abnormal stopReason, missing assistant text, a contentless final message (likely cut off
   * at the context ceiling), and auto-compaction — so a no-sentinel no_change tick is
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
  const cutOff = !pi.nothingToDo && pi.finalMessageContentless;
  if (pi.nothingToDo) return { cutOff, notes: [] }; // Sentinel present — nothing to diagnose.
  const notes: string[] = [];
  if (pi.stopReason && pi.stopReason !== "stop") notes.push(`stopReason=${pi.stopReason}`);
  if (!pi.finalText.trim()) notes.push("no assistant text");
  if (pi.finalMessageContentless)
    notes.push("final message had no text or tool call — likely cut off at the context ceiling");
  if (pi.compacted) notes.push("pi auto-compacted the session");
  return { cutOff, notes };
}

/** Cap on a no-change answer kept as the tick's summary, so a verbose reply cannot bloat the
 * dashboard's last-result cell (the same cap commit-message.ts applies to a changed tick's
 * SUMMARY). */
const NO_CHANGE_ANSWER_MAX = 100;

/** The prose answer a no-change pi run wrote above its NOTHING_TO_DO sentinel — the director's
 * reply to a question-only prompt, which ends `no_change` with no SUMMARY block (BUGS.md
 * 2026-10-14). Everything before the sentinel line, trimmed; null when the reply carried no
 * text of its own above the sentinel (a bare sentinel, or a cut-off run whose reply never
 * reached one). Only a prompt-driven (director) tick treats it as the tick's summary — a role's
 * bare nothing-to-do stays summary-less, decided by the verdict, not here. */
export function extractNoChangeAnswer(finalText: string): string | null {
  const idx = finalText.indexOf(NOTHING_TO_DO);
  if (idx < 0) return null;
  const before = finalText.slice(0, idx).trim();
  return before === "" ? null : truncate(before, NO_CHANGE_ANSWER_MAX);
}
