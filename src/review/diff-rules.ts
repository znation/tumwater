/** The deterministic diff rules the review gate and the main watch share, each run in its own
 * `scope` and order — the one call site both the gate (review.ts) and the main watch
 * (main-watch.ts) use, so a finding reads the same on a changed tree and on main's tip.
 * `baseRev` is a commit or branch name the async
 * rules resolve with changeBaseRev (merge-base of HEAD and it), so the watch passes a commit
 * while the gate passes the main branch. The final `scope` argument picks which set runs and in
 * what order: `"watch"` runs all five — conflictMarkerReason, then protectedEditReason, then
 * secretLeakReason, then — only for an exempt (md-only) diff — falseFixReason, then
 * backlogStructureReason for every diff — while `"gate"` (the pre-merge gate) runs only the
 * three a later commit cannot repair: briefEditReason, protectedEditReason, then
 * secretLeakReason. A conflict marker, a false fix claim and a broken backlog structure can all
 * be repaired by a later commit, so they stop refusing a diff pre-merge and the main watch
 * reports them on main's tip instead. Both scopes short-circuit on their first finding exactly
 * as the original gate did: a later rule never runs once an earlier one already rejects.
 * Returns a one-reason array when a rule fires (the reason the gate rejects on and the watch
 * reports) and `[]` when nothing is wrong. An empty `role` (the watch cannot name the tip's
 * merging role) is no basis for calling a PRINCIPLES.md edit unauthorized, so the
 * role-dependent half of the protected-edit rule is skipped — but its role-independent half,
 * the brief-block rule (briefEditReason), still runs, so a brief edit on an unattributed head
 * is still reported; the gate always passes a known role, so its rejections are unchanged.
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
  scope: "gate" | "watch",
): Promise<string[]> {
  // The gate scope rejects only the three findings a later commit cannot repair (a brief-block
  // edit, a protected edit, a leaked credential); the watch scope runs the full set, because a
  // conflict marker, a false fix claim and a broken backlog structure are all repairable and so
  // bare waiting for the main watch to report them on main's tip.
  if (scope === "watch") {
    const marker = conflictMarkerReason(wt, files);
    if (marker !== undefined) return [marker];
  }
  // The brief-block rule is role-independent — its edit is forbidden for every role alike — so it
  // runs even when the watch cannot name the tip's merging role (role === ""). Only the
  // PRINCIPLES.md half of protectedEditReason needs a known role to condemn an edit.
  const briefReason = await briefEditReason(wt, baseRev, files);
  if (briefReason !== undefined) return [briefReason];
  const protectedReason = role === "" ? undefined : await protectedEditReason(wt, baseRev, files, role);
  if (protectedReason !== undefined) return [protectedReason];
  const secretReason = await secretLeakReason(wt, baseRev, files);
  if (secretReason !== undefined) return [secretReason];
  if (scope === "watch" && exempt) {
    const falseFix = await falseFixReason(wt, baseRev, files);
    if (falseFix) return [falseFix];
  }
  if (scope === "watch") {
    const structure = await backlogStructureReason(wt, baseRev, files);
    if (structure) return [structure];
  }
  return [];
}
