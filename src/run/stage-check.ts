/** The merge gate's deterministic checks, run BEFORE a changed run commits.
 *
 * The gate runs `backlogStructureReason` and `falseFixReason` at merge time, by which point
 * the author's session is over: a finding costs a queue slot, a verification, and a rejection that
 * discards the work (13 phantom-fix rejections between 2026-09-23 and 2026-10-02). Both checks
 * read the worktree and the change's merge-base, so the same questions can be asked at staging
 * time, while the authoring session can still be continued for one fix-up turn. This module
 * runs them over the run's uncommitted edits; the gate still has the final say.
 *
 * Scope mirrors the gate exactly: `backlogStructureReason` runs on every changed run, while
 * `falseFixReason` runs only for an exempt (doc-only) diff — the condition under which the gate
 * consults it.
 *
 * The git-level checks described next live in stage-path-checks.ts (`gitLevelFindings`), which
 * this module appends.
 *
 * Part 2/2 appends git-level, language-neutral findings (PLANS.md "Pre-queue self-check, part
 * 2/2") for path drift, the organize role's main rejection cause: references left behind by a
 * rename or delete, added lines naming paths that do not exist in the resulting tree, and text
 * files whose final newline the change removed. These stage the change (`git add -A`) to read
 * the index with git only, then restore the index to HEAD before returning: staging is a read
 * aid for the checks, not a change to the run's state. A git hiccup yields no finding rather
 * than failing the run. Unlike the backlog checks above, the gate does not run these: they are
 * heuristics for what a reviewer tends to reject, so neither path check looks inside record
 * prose (isRecordProse), where an old or not-yet-created path is correct as written.
 *
 * A fourth check, `staleNameFindings`, reports a compound identifier the change removed from a
 * JS/TS file that a comment or doc still names (the compiler catches code, not prose). It
 * exempts a name the change re-declares (a move), a name another file still declares, an
 * occurrence inside a string literal (legacy-name tables and serialized keys keep old names on
 * purpose), a line marked `retired-name-ok`, and record prose, where history names old things.
 * A fifth, `detachedDocFindings`, reads the same `-U0` diff for a JSDoc block the change
 * separated from its declaration: code inserted between the two, or a declaration deleted
 * while its doc stayed. A sixth, `movedSourceFindings`, reads that diff for a file that still
 * exists but lost lines found verbatim in another file, and lists the lines that still name the
 * old file's path (outside record prose), which may describe code that now lives elsewhere.
 *
 * A seventh check, `garbledWordingFindings`, reports added lines (outside record prose) that carry
 * the broken participles and doubled "run" wording a word-swap rename leaves (has/have/had … ran,
 * a hyphen before ran, "run" repeated back to back or followed by "running", a possessive run
 * followed by "run", "run" joined to "run" by and/or, including a phrase split across two added
 * lines). Like the path checks, the gate does not
 * run it.
 *
 * The backlog-record findings named below (`planDependencyFinding`, `waitingNoteFinding`,
 * `finishedDuplicateFindings`, `strayPlaceholderFinding`) live in stage-backlog-checks.ts, which
 * also holds the claim-move findings run-stage.ts uses.
 *
 * `planDependencyFinding` is staging-only: it is not part of the review gate or the in-lock
 * merge re-check, because `tumwater doctor`'s plan-dependency warning is the backstop for
 * anything that gets past the fix-up turn. `waitingNoteFinding` is staging-only and bugfix-only
 * for the same reason: it nudges a bugfix run that left a Progress note without the hold.
 * Like `planDependencyFinding`, `finishedDuplicateFindings` runs only at staging. The gate does
 * not run it, because the sweep that creates the second copy runs after it.
 * `strayPlaceholderFinding` is staging-only too. It flags a `_None yet._` line the change left in a
 * PLANS.md, BUGS.md or QUESTIONS.md section that still holds entries. `acceptanceGrepFindings`
 * runs only at staging and runs the strict "matches nothing" greps of the plan entries the change
 * finished. The gate does not run it. */

import path from "node:path";
import { changedFiles } from "../git/git-diff.js";
import { conflictMarkerReason } from "../merge/merge-git.js";
import { isExemptDiff } from "../review/exemptions.js";
import { backlogStructureReason } from "../backlog/backlog-structure.js";
import { protectedEditReason } from "../review/protected-edits.js";
import { secretLeakReason } from "../review/secret-leaks.js";
import { falseFixReason } from "../verdict/fix-claim.js";
import { changeBaseRev, fileContentAt } from "../git/git.js";
import { readTextOrNull } from "../files/files.js";
import {
  FINISHED_ARCHIVES,
  finishedArchiveOf,
  parseEntryDetails,
} from "../backlog/backlog-md.js";
import { DONE_DATE_RE } from "../backlog/backlog.js";
import { baseRoleOf } from "../roles/runner-ids.js";
import { acceptanceGrepFindings } from "./acceptance-greps.js";
import {
  PLACEHOLDER_FILES,
  finishedDuplicateFindings,
  finishedKey,
  planDependencyFinding,
  strayPlaceholderFinding,
  waitingNoteFinding,
} from "./stage-backlog-checks.js";
import { gitLevelFindings } from "./stage-path-checks.js";

/** Where finished plans are archived (plans/backlog-archive.md). */
const PLANS_ARCHIVE = finishedArchiveOf("PLANS.md").archive;

/** `file` as it stands at the change's merge-base with `mainBranch`, or undefined when the
 * merge-base or the read fails. */
const baseFileText = (wt: string, mainBranch: string, file: string): Promise<string | undefined> =>
  changeBaseRev(wt, mainBranch).then((rev) => fileContentAt(wt, rev, file)).catch(() => undefined);

/** Append the reason `check` resolves to, if any, to `findings`; a check that rejects adds
 * nothing, as staging never fails on a best-effort check. */
const pushReason = async (findings: string[], check: Promise<string | undefined>): Promise<void> => {
  const reason = await check.catch(() => undefined);
  if (reason) findings.push(reason);
};

/** The findings likely to get this uncommitted change rejected at merge, or an empty list when
 * it is clean: the merge gate's own deterministic checks plus the staging-only heuristics (plan
 * dependencies, the bugfix Waiting note, path drift). Checks the worktree at `wt` against
 * `mainBranch`'s merge-base; `exemptPaths` are the config's review-exemption globs that scope
 * the false-fix check.
 *
 * Never throws: a check that fails yields no finding, so a git hiccup at staging time defers to
 * the gate instead of failing the run. */
export async function stageCheckFindings(
  wt: string,
  mainBranch: string,
  exemptPaths: string[],
  role: string,
): Promise<string[]> {
  const files = await changedFiles(wt).catch(() => null);
  if (files === null || files.length === 0) return [];
  const findings: string[] = [];
  await pushReason(findings, backlogStructureReason(wt, mainBranch, files));
  if (files.includes("PLANS.md")) {
    const head = readTextOrNull(path.join(wt, "PLANS.md")) ?? "";
    const base = await baseFileText(wt, mainBranch, "PLANS.md");
    // Finished plans are archived in PLANS-DONE.md (plans/backlog-archive.md): a requires clause
    // naming a merged part resolves there, on both sides of the comparison alike.
    const archived = parseEntryDetails(readTextOrNull(path.join(wt, PLANS_ARCHIVE)) ?? "", "Done").map((e) => e.title);
    const dependency = base === undefined ? undefined : planDependencyFinding(head, base, archived);
    if (dependency !== undefined) findings.push(dependency);
  }
  const baseRev = FINISHED_ARCHIVES.some((s) => files.includes(s.file) || files.includes(s.archive))
    ? await changeBaseRev(wt, mainBranch).catch(() => undefined)
    : undefined;
  for (const spec of FINISHED_ARCHIVES) {
    if (baseRev === undefined || !(files.includes(spec.file) || files.includes(spec.archive))) continue;
    const duplicates = await (async () => {
      const read = (f: string) => readTextOrNull(path.join(wt, f)) ?? "";
      const at = async (f: string) => (await fileContentAt(wt, baseRev, f)) ?? "";
      return finishedDuplicateFindings(
        spec,
        { head: read(spec.file), base: await at(spec.file) },
        { head: read(spec.archive), base: await at(spec.archive) },
      );
    })().catch(() => []);
    findings.push(...duplicates);
    if (spec.file !== "PLANS.md") continue;
    const greps = await (async () => {
      const finished = async (f: string, section: string) => {
        const keyed = (md: string) =>
          parseEntryDetails(md, section).map((e) => ({ ...e, key: finishedKey(e.title, DONE_DATE_RE) }));
        const seen = new Set(keyed((await fileContentAt(wt, baseRev, f)) ?? "").map((e) => e.key));
        return keyed(readTextOrNull(path.join(wt, f)) ?? "").filter((e) => !seen.has(e.key));
      };
      const entries = [...(await finished(spec.file, spec.section)), ...(await finished(spec.archive, spec.section))];
      return acceptanceGrepFindings(wt, entries);
    })().catch(() => []);
    findings.push(...greps);
  }
  if (baseRoleOf(role) === "bugfix" && files.includes("BUGS.md")) {
    const head = readTextOrNull(path.join(wt, "BUGS.md")) ?? "";
    const base = await baseFileText(wt, mainBranch, "BUGS.md");
    const waiting = base === undefined ? undefined : waitingNoteFinding(head, base);
    if (waiting !== undefined) findings.push(waiting);
  }
  for (const file of PLACEHOLDER_FILES) {
    if (!files.includes(file)) continue;
    const head = readTextOrNull(path.join(wt, file)) ?? "";
    const base = (await baseFileText(wt, mainBranch, file)) ?? "";
    const stray = strayPlaceholderFinding(file, head, base);
    if (stray !== undefined) findings.push(stray);
  }
  await pushReason(findings, protectedEditReason(wt, mainBranch, files, role));
  await pushReason(findings, secretLeakReason(wt, mainBranch, files));
  if (isExemptDiff(files, exemptPaths)) await pushReason(findings, falseFixReason(wt, mainBranch, files));
  findings.push(...(await gitLevelFindings(wt, mainBranch).catch(() => [])));
  const markers = conflictMarkerReason(wt, files);
  if (markers !== undefined) findings.push(markers);
  return findings;
}
