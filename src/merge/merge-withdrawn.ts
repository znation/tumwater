/** Withdrawn work: a queued change whose backlog entry main no longer lists never merges.
 * On 2026-11-01 the operator withdrew "Subtract, part 3b/7" by deleting its PLANS.md entry ten
 * minutes after feature-2 had claimed it. The claim was released, but the interrupted run kept
 * resuming with the plan in its session and its kept worktree, and on 2026-11-02 its change
 * merged (8ed0d3eec), deleting the pre-merge build check the operator had chosen to keep.
 *
 * The scheduling poll drops a withdrawn claim's resume or revision (claims.ts's `withdrawn`
 * release). This module is the backstop at the merge, where every path to main passes: the
 * one-step merge asks it before its gate's rebase, and again inside the merge lock before its own
 * rebase. An entry is withdrawn from a change when the change works on it —
 * its run's recorded claim, or an entry its diff moved out of the role's actionable section
 * since its merge-base with main — and main's tip no longer lists it in that section. Each check
 * runs before the rebase that would move the change's base past the removal, so the base still
 * lists what the change moved. Only the work roles (feature, bugfix) take backlog entries; every
 * other role's changes are never judged here. */

import { actionableEntryRanges } from "../backlog/backlog-index-data.js";
import { entryKey } from "../backlog/backlog-parts.js";
import { roleSection } from "../backlog/backlog-eligibility.js";
import { stripEntryStamp } from "../backlog/backlog-structure.js";
import { warnEventBestEffort } from "../events/events.js";
import { changeBaseRev, deleteRef, fileContentAt } from "../git/git.js";
import { gitTryStarted } from "../git/git-run.js";
import { mergeRefName } from "../paths.js";
import { INSTANCE_ROLES, baseRoleOf } from "../roles/runner-ids.js";
import type { RunnerState } from "../runner/runner-state.js";
import { movedOutEntries } from "../scheduling/claims.js";

/** The backlog entry a queued change's run was assigned (RunnerState.claim without its
 * bookkeeping), recorded on the merge queue entry so the merge can tell what the change
 * implements after the poll has released the claim. */
export type MergeClaim = Pick<NonNullable<RunnerState["claim"]>, "file" | "key" | "title">;

/** One entry a change works on that main no longer lists: its stamp-free key and its heading. */
interface WithdrawnEntry {
  key: string;
  title: string;
}

/** The entries of `role`'s backlog section that commit `rev` works on and `mainBranch`'s tip no
 * longer lists there, read through git in `dir` (the repo or any of its worktrees). A change works
 * on `claim` (when it names the role's own backlog file) and on every entry its diff moved out of
 * the section since its merge-base with `mainBranch`. Empty for a role that takes no backlog
 * entries, and when the section cannot be read on main or at `rev`: an unreadable file never
 * drops work. Throws only when git cannot start. */
export async function withdrawnEntries(
  dir: string,
  mainBranch: string,
  role: string,
  rev: string,
  claim?: MergeClaim,
): Promise<WithdrawnEntry[]> {
  if (!INSTANCE_ROLES.has(baseRoleOf(role))) return [];
  const { file, section } = roleSection(role);
  const mainMd = await gitTryStarted(dir, "show", `${mainBranch}:${file}`);
  const headMd = await gitTryStarted(dir, "show", `${rev}:${file}`);
  if (mainMd === null || headMd === null) return [];
  const listed = new Set(actionableEntryRanges(mainMd, section).map((e) => entryKey(e.title)));
  const baseMd = await fileContentAt(dir, await changeBaseRev(dir, mainBranch, rev), file);
  const worked = new Map<string, string>();
  if (claim?.file === file) worked.set(claim.key, claim.title);
  for (const m of movedOutEntries(baseMd, headMd, section)) worked.set(m.key, m.title);
  return [...worked].filter(([key]) => !listed.has(key)).map(([key, title]) => ({ key, title }));
}

/** The one-line reason a withdrawn change was dropped, naming the first entry (stamp-free) and
 * the section main no longer lists it under. It is the warning and, behind the `withdrawn — `
 * prefix the merge_failed reason strips, the role's lastError, so both say the same thing. */
function withdrawnReason(role: string, entries: readonly WithdrawnEntry[]): string {
  const { file, section } = roleSection(role);
  const more = entries.length > 1 ? ` (and ${entries.length - 1} more)` : "";
  const title = stripEntryStamp(entries[0]!.title);
  return `dropped the change for "${title}"${more} unmerged: ${file} on main no longer lists it under ## ${section}`;
}

/** The reason to drop the pinned change `req` names at commit `rev` as withdrawn, or null to let
 * it go on: withdrawnEntries over its role and recorded claim, worded by withdrawnReason. */
export async function withdrawnPinReason(
  dir: string,
  mainBranch: string,
  req: { role: string; claim?: MergeClaim },
  rev: string,
): Promise<string | null> {
  const entries = await withdrawnEntries(dir, mainBranch, req.role, rev, req.claim);
  return entries.length === 0 ? null : withdrawnReason(req.role, entries);
}

/** Drop a pinned change found withdrawn: delete its merge ref, so neither the pipeline's re-queue
 * nor leftover recovery can bring it back, record the reason as the role's lastError (the
 * merge_failed event's reason) and warn with it. The caller settles the change `withdrawn`. */
export async function dropWithdrawnPin(
  root: string,
  role: string,
  state: Pick<RunnerState, "lastError">,
  reason: string,
): Promise<void> {
  await deleteRef(root, mergeRefName(role));
  state.lastError = `withdrawn — ${reason}`;
  warnEventBestEffort(root, role, reason);
}
