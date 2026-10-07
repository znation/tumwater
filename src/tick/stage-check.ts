/** The landing gate's deterministic backlog checks, run BEFORE a changed tick commits.
 *
 * The gate runs `backlogStructureReason` and `falseFixReason` at landing time, by which point
 * the author's session is over: a finding costs a queue slot, a vet, and a rejection that
 * discards the work (13 phantom-fix rejections between 2026-09-23 and 2026-10-02). Both checks
 * read the worktree and the change's merge-base, so the same questions can be asked at staging
 * time, while the authoring session can still be continued for one fix-up turn. This module
 * runs them over the tick's uncommitted edits; the gate still has the final say.
 *
 * Scope mirrors the gate exactly: `backlogStructureReason` runs on every changed tick, while
 * `falseFixReason` runs only for an exempt (doc-only) diff — the condition under which the gate
 * consults it. */

import { changedFiles } from "../git/git-diff.js";
import { isExemptDiff } from "../review/exemptions.js";
import { backlogStructureReason } from "../backlog/backlog-structure.js";
import { falseFixReason } from "../verdict/fix-claim.js";

/** The deterministic findings the landing gate would reject this uncommitted change for, or an
 * empty list when it is clean. `files` are the worktree's changed paths (untracked included);
 * `exemptPaths` are the config's review-exemption globs that scope the false-fix check.
 *
 * Never throws: a check that fails yields no finding, so a git hiccup at staging time defers to
 * the gate instead of failing the tick. */
export async function stageCheckFindings(
  wt: string,
  mainBranch: string,
  exemptPaths: string[],
): Promise<string[]> {
  const files = await changedFiles(wt).catch(() => null);
  if (files === null || files.length === 0) return [];
  const findings: string[] = [];
  const structure = await backlogStructureReason(wt, mainBranch, files).catch(() => undefined);
  if (structure) findings.push(structure);
  if (isExemptDiff(files, exemptPaths)) {
    const falseFix = await falseFixReason(wt, mainBranch, files).catch(() => undefined);
    if (falseFix) findings.push(falseFix);
  }
  return findings;
}
