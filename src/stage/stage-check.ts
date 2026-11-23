/** The merge gate's checks that still refuse a change, plus staging-only heuristics for what a
 * reviewer tends to reject, run BEFORE a changed run commits.
 *
 * Since part 3m/3 the gate refuses only a brief-block edit, a protected edit and a leaked
 * credential — the findings a later commit cannot repair. This module runs those same checks
 * over the run's uncommitted edits while the authoring session can still be continued for one
 * fix-up turn (a finding that reaches merge costs a queue slot, a verification, and a rejection
 * that discards the work — 13 phantom-fix rejections between 2026-09-23 and 2026-10-02 priced
 * that turn). The gate no longer refuses a false fix claim or a broken backlog structure —
 * both are repairable by a later commit and reported by the main watch on main's tip — so
 * those findings never spend the run's fix-up turn here.
 *
 * The git-level checks described next live across stage-path-checks.ts (`gitLevelFindings`),
 * stage-name-checks.ts and stage-prose-checks.ts, which this module appends.
 *
 * Part 2/2 appends git-level, language-neutral findings (PLANS.md "Pre-queue self-check, part
 * 2/2") for path drift, the organize role's main rejection cause: references left behind by a
 * rename or delete, added lines naming paths that do not exist in the resulting tree, and text
 * files whose final newline the change removed. These stage the change (`git add -A`) to read
 * the index with git only, then restore the index to HEAD before returning: staging is a read
 * aid for the checks, not a change to the run's state. A git hiccup yields no finding rather
 * than failing the run. Unlike the gate's checks this module runs (which the gate also runs at
 * merge time), the gate does not run these: they are heuristics for what a reviewer tends to
 * reject, so neither path check looks inside record
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
 * lines). It also reports any word doubled back to back in comment or doc prose (case-sensitive,
 * not after `-`, `.` or `/`, "that that" and "had had" excepted). Like the path checks, the gate
 * does not run it.
 *
 * An eighth check, `duplicatedCommentFindings`, reads the same `-U0` diff for a comment block of
 * at least three lines that the change left twice in one file, with one copy wholly in added
 * lines: a move that duplicated its prose beside the original. The gate does not run it either.
 *
 * The backlog-record findings named below (`planDependencyFinding`,
 * `finishedDuplicateFindings`, `strayPlaceholderFinding`) live in stage-backlog-checks.ts, which
 * also holds the claim-move findings run-stage.ts uses.
 *
 * `planDependencyFinding` is staging-only: it is not part of the review gate or the main watch's
 * diff rules, because `tumwater doctor`'s plan-dependency warning is the backstop for
 * anything that gets past the fix-up turn.
 * Like `planDependencyFinding`, `finishedDuplicateFindings` runs only at staging. The gate does
 * not run it, because the sweep that creates the second copy runs after it.
 * `strayPlaceholderFinding` is staging-only too. It flags a `_None yet._` line the change left in a
 * PLANS.md, BUGS.md or QUESTIONS.md section that still holds entries. `acceptanceGrepFindings`
 * runs only at staging and runs the strict "matches nothing" greps of the plan entries the change
 * finished. The gate does not run it. */

import { changedFiles } from "../git/git-diff.js";
import { conflictMarkerReason } from "../merge/merge-git.js";
import { protectedEditReason } from "../review/protected-edits.js";
import { secretLeakReason } from "../review/secret-leaks.js";
import { changeBaseRev, fileContentAt } from "../git/git.js";
import { readDirTextOrEmpty } from "../files/files.js";
import {
  FINISHED_ARCHIVES,
  finishedArchiveOf,
  parseEntryDetails,
} from "../backlog/backlog-md.js";
import { FINISHED_PLAN_RE, isRetiredTitle } from "../backlog/backlog.js";
import type { PendingPlanChange } from "../backlog/backlog-pending.js";
import { acceptanceGrepFindings } from "./acceptance-greps.js";
import {
  PLACEHOLDER_FILES,
  duplicatePlanFinding,
  finishedDuplicateFindings,
  finishedKey,
  planDependencyFinding,
  retireEvidenceFinding,
  strayPlaceholderFinding,
  ungroundedRefusalFinding,
  refiledFixedBugFinding,
} from "./stage-backlog-checks.js";
import { gitLevelFindings } from "./stage-path-checks.js";
import { malformedNeedsReviewFinding } from "../backlog/backlog-structure.js";

/** Where finished plans are archived (plans/backlog-archive.md). */
const PLANS_ARCHIVE = finishedArchiveOf("PLANS.md").archive;
/** Where finished bugs are archived. */
const BUGS_ARCHIVE = finishedArchiveOf("BUGS.md").archive;

/** The change's base reads for ONE stage check, made by `stageBaseFor`: `rev` is the change's
 * merge-base with `mainBranch`, `at` is `file` as it stands at that revision, and `headOf` is
 * `file` in the worktree. Both are memoized for the check, and `rev` is resolved lazily and at
 * most once, because the findings below compare the same handful of backlog files against the
 * same base: measured on this repo with a clean change over PLANS.md and BUGS.md, the check
 * resolved the merge-base 7 times and re-read the same base revisions 6 extra times — two of
 * them the 9.6 MB PLANS-DONE.md — costing 12 of the 27 git spawns it runs. The worktree side is
 * memoized for the same reason: a clean change read PLANS.md and PLANS-DONE.md from disk twice
 * each. The cache lives and dies inside one `stageCheckFindings` call, so no read can go stale:
 * the checks never write these files, and a re-read at a later point in the same pass could only
 * disagree with an earlier one. */
interface StageBase {
  /** The change's merge-base with `mainBranch` — one spawn, shared by every base read. */
  rev(): Promise<string>;
  /** `file` at `rev`, or undefined when the merge-base or the read fails — the guard every
   * base read in this pass needs, so it lives on the read rather than at each call site. */
  at(file: string): Promise<string | undefined>;
  /** `file` as the worktree holds it. */
  headOf(file: string): string;
  /** `file`'s worktree text and its text at `rev`, fetched in one call: every ordering finding
   * that compares a backlog file's head to its base reads both the same way, so the pair is
   * read together rather than re-stated at each call site. */
  both(file: string): Promise<{ head: string; base: string | undefined }>;
}

/** The `StageBase` for `wt`'s change against `mainBranch`. */
function stageBaseFor(wt: string, mainBranch: string): StageBase {
  let revRead: Promise<string> | null = null;
  const rev = (): Promise<string> => {
    if (revRead === null) revRead = changeBaseRev(wt, mainBranch);
    return revRead;
  };
  const atCache = new Map<string, Promise<string>>();
  const at = (file: string): Promise<string | undefined> => {
    let read = atCache.get(file);
    if (read === undefined) {
      read = rev().then((r) => fileContentAt(wt, r, file));
      atCache.set(file, read);
    }
    return read.catch(() => undefined);
  };
  const headCache = new Map<string, string>();
  const headOf = (file: string): string => {
    let text = headCache.get(file);
    if (text === undefined) {
      text = readDirTextOrEmpty(wt, file);
      headCache.set(file, text);
    }
    return text;
  };
  return {
    rev,
    at,
    headOf,
    both: async (file) => ({ head: headOf(file), base: await at(file) }),
  };
}

/** Append the reason `check` resolves to, if any, to `findings`; a check that rejects adds
 * nothing, as staging never fails on a best-effort check. */
const pushReason = async (findings: string[], check: Promise<string | undefined>): Promise<void> => {
  const reason = await check.catch(() => undefined);
  if (reason) findings.push(reason);
};

/** The PLANS.md record findings: a requires clause naming a part the archive lacks, an
 * ungrounded refusal that cites another part, a duplicate `## Planned` entry the change adds
 * against main's planned set plus every unmerged change (part 5/6), and a newly retired plan
 * whose Retired note's evidence does not check out. */
async function plansFindings(wt: string, mainBranch: string, pending: readonly PendingPlanChange[], base: StageBase): Promise<string[]> {
  const { head, base: baseMd } = await base.both("PLANS.md");
  // Finished plans are archived in PLANS-DONE.md (plans/backlog-archive.md): a requires clause
  // naming a merged part resolves there, on both sides of the comparison alike.
  const archived = parseEntryDetails(base.headOf(PLANS_ARCHIVE), "Done").map((e) => e.title);
  if (baseMd === undefined) return [];
  // The duplicate finding's known set is main's tip at staging, not the merge-base: a plan a
  // sibling merged while this run worked is on main but not in the run's base, and is exactly
  // the 11-03 incident this check exists to catch. What the change itself adds is still judged
  // against the merge-base, so an entry main gained with the same key is a duplicate, not a
  // pre-existing one. The other findings stay merge-base-relative. A failed read falls back to
  // the merge-base.
  const mainPlans = (await fileContentAt(wt, mainBranch, "PLANS.md")) || baseMd;
  // The finished-plan set comes from main's tip for the same reason: the archive move that
  // follows a merge lands in main's PLANS-DONE.md while a plan run works, so the run's own
  // worktree never sees it. A failed read falls back to the worktree's copy, and a missing
  // archive reads as empty.
  const mainArchive = (await fileContentAt(wt, mainBranch, PLANS_ARCHIVE).catch(() => "")) || base.headOf(PLANS_ARCHIVE);
  const findings = [
    planDependencyFinding(head, baseMd, archived),
    ungroundedRefusalFinding("PLANS.md", head, baseMd),
    malformedNeedsReviewFinding("PLANS.md", head, baseMd),
    duplicatePlanFinding(head, baseMd, pending, mainPlans, mainArchive),
    await retireEvidenceFinding(wt, mainBranch, head, baseMd).catch(() => undefined),
  ];
  return findings.filter((f): f is string => f !== undefined);
}

/** The finished-archive findings: duplicates of entries the archive already holds, plus the
 * acceptance greps of the plan entries the change finished (for a PLANS.md change). */
async function archiveFindings(wt: string, files: string[], base: StageBase): Promise<string[]> {
  const baseRev = FINISHED_ARCHIVES.some((s) => files.includes(s.file) || files.includes(s.archive))
    ? await base.rev().catch(() => undefined)
    : undefined;
  const findings: string[] = [];
  for (const spec of FINISHED_ARCHIVES) {
    if (baseRev === undefined || !(files.includes(spec.file) || files.includes(spec.archive))) continue;
    const at = (f: string): Promise<string> => base.at(f).then((t) => t ?? "");
    const duplicates = await (async () => {
      return finishedDuplicateFindings(
        spec,
        { head: base.headOf(spec.file), base: await at(spec.file) },
        { head: base.headOf(spec.archive), base: await at(spec.archive) },
      );
    })().catch(() => []);
    findings.push(...duplicates);
    if (spec.file !== "PLANS.md") continue;
    const greps = await (async () => {
      const finished = async (f: string, section: string) => {
        // FINISHED_PLAN_RE (done or retired with its date) instead of DONE_DATE_RE: a retired
        // copy and a done copy of one heading share a key, so the change that retires a plan
        // whose done copy is already on the other side is not re-read as a new finished entry.
        const keyed = (md: string) =>
          parseEntryDetails(md, section).map((e) => ({ ...e, key: finishedKey(e.title, FINISHED_PLAN_RE) }));
        const seen = new Set(keyed(await at(f)).map((e) => e.key));
        return keyed(base.headOf(f)).filter((e) => !seen.has(e.key));
      };
      const entries = [...(await finished(spec.file, spec.section)), ...(await finished(spec.archive, spec.section))];
      // A retired plan was never built, so its acceptance greps are expected to fail: it is
      // closed without being built, not verified. A done move still runs its greps.
      return acceptanceGrepFindings(wt, entries.filter((e) => !isRetiredTitle(e.title)));
    })().catch(() => []);
    findings.push(...greps);
  }
  return findings;
}

/** The BUGS.md record findings: an ungrounded refusal that cites another bug, a malformed
 * `Needs review` hold note the change adds, and a `## Open` copy of a bug a closed record
 * already holds. */
async function bugsFindings(wt: string, mainBranch: string, base: StageBase): Promise<string[]> {
  const { head, base: baseMd } = await base.both("BUGS.md");
  // The closed-bug set is read from main's tip, not the merge-base and not the worktree: the fix
  // that archived the bug lands while the filing run works, so the copy and the archive never
  // meet inside the worktree (the same reason duplicatePlanFinding reads main's PLANS.md). A
  // failed read falls back to the worktree's own copy.
  const read = await fileContentAt(wt, mainBranch, BUGS_ARCHIVE).catch(() => "");
  const archive = read || base.headOf(BUGS_ARCHIVE);
  const findings = [
    baseMd === undefined ? undefined : ungroundedRefusalFinding("BUGS.md", head, baseMd),
    malformedNeedsReviewFinding("BUGS.md", head, baseMd ?? ""),
    refiledFixedBugFinding(head, baseMd ?? "", archive),
  ];
  return findings.filter((f): f is string => f !== undefined);
}

/** The stray-placeholder findings: a `_None yet._` line a changed record still leaves in a
 * section that holds entries. */
async function placeholderFindings(files: string[], base: StageBase): Promise<string[]> {
  const findings: string[] = [];
  for (const file of PLACEHOLDER_FILES) {
    if (!files.includes(file)) continue;
    const { head, base: baseMd } = await base.both(file);
    const stray = strayPlaceholderFinding(file, head, baseMd ?? "");
    if (stray !== undefined) findings.push(stray);
  }
  return findings;
}

/** The findings likely to get this uncommitted change rejected at merge, or an empty list when
 * it is clean: the merge gate's remaining checks over the change plus the staging-only
 * heuristics (plan dependencies, path drift). Checks the worktree at `wt` against
 * `mainBranch`'s merge-base.
 *
 * Never throws: a check that fails yields no finding, so a git hiccup at staging time defers to
 * the gate instead of failing the run.
 *
 * `pending` is the unmerged changes the change's PLANS.md diff is judged against
 * (duplicatePlanFinding, plans/duplicate-plans.md "Decision" 3): the caller passes the pending
 * snapshot with every change whose tip the worktree's HEAD already contains dropped (that
 * change's entries already appear in the head-over-base diff), the plan role's own earlier
 * unmerged plan kept — re-planning it is the case this check exists for. */
export async function stageCheckFindings(
  wt: string,
  mainBranch: string,
  role: string,
  pending: readonly PendingPlanChange[] = [],
): Promise<string[]> {
  const files = await changedFiles(wt).catch(() => null);
  if (files === null || files.length === 0) return [];
  // The one merge-base resolution and the one read of each backlog file this pass shares
  // (StageBase above); every backlog finding takes its base from here.
  const base = stageBaseFor(wt, mainBranch);
  // Resolved once here for the checks outside StageBase; changeBaseRev cannot reject (gitTry
  // catches every failure and falls back to `mainBranch`), so this never throws.
  const baseRev = await base.rev();
  const findings: string[] = [];
  if (files.includes("PLANS.md")) findings.push(...(await plansFindings(wt, mainBranch, pending, base)));
  findings.push(...(await archiveFindings(wt, files, base)));
  if (files.includes("BUGS.md")) findings.push(...(await bugsFindings(wt, mainBranch, base)));
  findings.push(...(await placeholderFindings(files, base)));
  await pushReason(findings, protectedEditReason(wt, mainBranch, files, role, baseRev));
  await pushReason(findings, secretLeakReason(wt, mainBranch, files));
  findings.push(...(await gitLevelFindings(wt, mainBranch, baseRev).catch(() => [])));
  const markers = conflictMarkerReason(wt, files);
  if (markers !== undefined) findings.push(markers);
  return findings;
}
