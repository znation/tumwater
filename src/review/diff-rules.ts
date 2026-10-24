/** The review gate's five deterministic diff rules, in the gate's own order and scope — the one
 * call site both the gate (review.ts) and the main watch (main-watch.ts) use, so a finding reads
 * the same on a changed tree and on main's tip. `baseRev` is a commit or branch name the async
 * rules resolve with changeBaseRev (merge-base of HEAD and it), so the watch passes a commit
 * while the gate passes the main branch. Runs conflictMarkerReason, then protectedEditReason,
 * then secretLeakReason, then — only for an exempt (md-only) diff — falseFixReason, then
 * backlogStructureReason for every diff, short-circuiting on the first finding exactly as the
 * original gate did: a later rule never runs once an earlier one already rejects. Returns a
 * one-reason array when a rule fires (the reason the gate rejects on and the watch reports) and
 * `[]` when nothing is wrong. An empty `role` (the watch cannot name the tip's merging role) is
 * no basis for calling a PRINCIPLES.md edit unauthorized, so the role-dependent half of the
 * protected-edit rule is skipped — but its role-independent half, the brief-block rule
 * (briefEditReason), still runs, so a brief edit on an unattributed head is still reported; the
 * gate always passes a known role, so its rejections are unchanged.
 *
 * This module lives apart from review-precheck.ts so the main watch can share the rules without a
 * runtime import cycle: review-precheck.ts imports src/baseline/main-watch.ts
 * (onlyKnownMainFailures), so a main-watch -> review-precheck import edge would make the two
 * modules mutually depend on each other at runtime (docs/code-metrics.md records "no runtime
 * import cycles"). diff-rules.ts's own imports (merge-git, protected-edits, secret-leaks,
 * fix-claim, backlog-structure) import nothing from main-watch or review-precheck, so it is a
 * cycle-free home both consumers can import. */
import { conflictMarkerReason } from "../merge/merge-git.js";
import { briefEditReason, protectedEditReason } from "./protected-edits.js";
import { secretLeakReason } from "./secret-leaks.js";
import { falseFixReason } from "../verdict/fix-claim.js";
import { backlogStructureReason } from "../backlog/backlog-structure.js";

export async function diffRuleReasons(
  wt: string,
  baseRev: string,
  files: string[],
  role: string,
  exempt: boolean,
): Promise<string[]> {
  const marker = conflictMarkerReason(wt, files);
  if (marker !== undefined) return [marker];
  // The brief-block rule is role-independent — its edit is forbidden for every role alike — so it
  // runs even when the watch cannot name the tip's merging role (role === ""). Only the
  // PRINCIPLES.md half of protectedEditReason needs a known role to condemn an edit.
  const briefReason = await briefEditReason(wt, baseRev, files);
  if (briefReason !== undefined) return [briefReason];
  const protectedReason = role === "" ? undefined : await protectedEditReason(wt, baseRev, files, role);
  if (protectedReason !== undefined) return [protectedReason];
  const secretReason = await secretLeakReason(wt, baseRev, files);
  if (secretReason !== undefined) return [secretReason];
  if (exempt) {
    const falseFix = await falseFixReason(wt, baseRev, files);
    if (falseFix) return [falseFix];
  }
  const structure = await backlogStructureReason(wt, baseRev, files);
  if (structure) return [structure];
  return [];
}
