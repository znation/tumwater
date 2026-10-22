import path from "node:path";
import { readTextOrNull } from "../files/files.js";
import { gitTry, gitTryStarted } from "../git/git-run.js";
import { resetWorktreeToMain } from "../git/worktree.js";
import { resolveBacklogInsertConflicts } from "../merge/backlog-conflicts.js";
import { conflictedFiles } from "../merge/merge-git.js";
import { shortSha } from "../text/format.js";

/** What applying a hand-back diff with markers left in place did: whether the diff is now in
 * the worktree, and which paths still carry conflict markers. `applied` is true for a clean
 * apply (empty `conflicted`) and for a conflicted one whose markers are left as ordinary
 * uncommitted edits; false only when the diff could not be applied at all. */
interface ApplyWithConflictsResult {
  applied: boolean;
  conflicted: string[];
}

/** The persistence count at which one repeated objection makes a rejection final
 * (plans/revise-rejected.md; the repeat-finality policy in BUGS.md 2026-10-14): each numbered
 * reason records how many consecutive revisions it has survived — a new (untagged) objection is
 * 0, a `(prior N)` restatement is 1 plus the prior round's count for that objection — and when
 * any reason reaches this count it was raised and then survived two revisions, so the change has
 * stopped converging and the rejection is final. A converging chain keeps revising while each
 * round's objections differ. */
export const REVISION_FINAL_ON_REPEAT = 2;

/** The hard backstop on one change's revision chain (plans/revise-rejected.md; BUGS.md
 * 2026-10-14): at this many total rejections the rejection is final even when the objections
 * never repeat, so a non-converging author cannot revise forever. Replaces the old fixed
 * `REVISION_LIMIT = 2`, which ended a converging chain at its third rejection whenever each
 * round raised a new objection. */
export const REVISION_BACKSTOP = 6;

/** What pickSettlingBacklog did: the whole range is in the worktree with no markers (`clean`),
 * it stopped on conflicts the backlog settler could not settle (`conflicted`, those files still
 * unmerged in the index and carrying markers, the sequencer state already quit), or git failed
 * for another reason (`failed`: a missing object, an empty range, a pick already in progress).
 * A pick git could not start, or a conflict listing git failed to produce, throws instead: a
 * `failed` pick drops the hand-back and deletes its ref, and neither says the diff is gone. */
type PickOutcome = { status: "clean" } | { status: "conflicted"; files: string[] } | { status: "failed" };

/** The picks a stopped `cherry-pick` sequence still owes after the one it stopped on, oldest
 * first — read from the sequencer's todo, whose first line is the stopped pick. null when the
 * todo cannot be read, so the caller never settles a stop it cannot finish. */
async function picksAfterStop(wt: string): Promise<string[] | null> {
  const todo = await gitTry(wt, "rev-parse", "--git-path", "sequencer/todo");
  const text = todo === null ? null : readTextOrNull(path.resolve(wt, todo));
  if (text === null) return null;
  const picks = text.split("\n").flatMap((line) => /^(?:p|pick)\s+(\S+)/.exec(line)?.[1] ?? []);
  return picks.slice(1);
}

/** Cherry-pick `<base>..<sha>` onto `wt` as uncommitted edits, settling backlog conflicts
 * without a model run on the way. A rejected or handed-back diff that prepends to PLANS-DONE.md
 * or BUGS-FIXED.md conflicts with every entry main archived since, the same insert-only shape the
 * merge's first pass settles (resolveBacklogInsertConflicts); left alone, its author got markers
 * in a 1.9 MB file (feature-5, 2026-10-19). On a stop whose conflicted files all settle, the
 * sequencer is quit (`--continue` refuses in `--no-commit` mode) and the picks it still owed are
 * replayed the same way onto the settled index. */
async function pickSettlingBacklog(wt: string, base: string, sha: string): Promise<PickOutcome> {
  let picks = [`${base}..${sha}`];
  for (;;) {
    // diff3 carries the base section of every conflict, which the backlog settler reads; the
    // markers an author is handed keep it too.
    const picked = await gitTryStarted(wt, "-c", "merge.conflictStyle=diff3", "cherry-pick", "--no-commit", ...picks);
    if (picked !== null) return { status: "clean" };
    // conflictedFiles, not a raw diff: it decodes git's C-quoted names, so a non-ASCII
    // conflicted path is the on-disk name the prompt and hasConflictMarkers can use.
    const conflicted = await conflictedFiles(wt);
    if (conflicted.length === 0) return { status: "failed" };
    const rest = await picksAfterStop(wt);
    // A settler that fails part-way (a failed `git add`) leaves every file to the author.
    const remaining =
      rest === null ? conflicted : await resolveBacklogInsertConflicts(wt, conflicted).catch(() => conflicted);
    await gitTry(wt, "cherry-pick", "--quit");
    if (remaining.length > 0) return { status: "conflicted", files: remaining };
    if (rest === null || rest.length === 0) return { status: "clean" };
    picks = rest;
  }
}

/** The exclusive start of the range to re-apply for `sha`: the merge-base with main, except that a
 * commit already on main (a reverted change, plans/fast-merge.md part 4c) has merge-base `sha`
 * itself and an empty range, so its own parent is the base and the range is that one commit. null
 * (the caller drops the hand-back) only on git's own answer, never because git could not start. */
async function pickBase(wt: string, mainBranch: string, sha: string): Promise<string | null> {
  const base = await gitTryStarted(wt, "merge-base", mainBranch, sha);
  if (base === null) return null;
  const full = await gitTryStarted(wt, "rev-parse", sha);
  if (full?.trim() !== base.trim()) return base;
  // A commit main merely fast-forwarded onto keeps the empty range; only one main reverted is
  // handed back to be re-applied.
  const reverts =
    (await gitTryStarted(wt, "log", mainBranch, "--format=%s", "--fixed-strings", `--grep=Revert ${shortSha(sha)}`)) ?? "";
  if (!reverts.split("\n").some((subject) => subject.endsWith(`Revert ${shortSha(sha)}`))) return base;
  return gitTryStarted(wt, "rev-parse", `${sha}^`);
}

/** Re-apply a rejected change `sha` onto current main as uncommitted edits in `wt`
 * (plans/revise-rejected.md): the author's next run starts from the rejected diff instead of
 * re-deriving it. `git cherry-pick --no-commit <merge-base>..<sha>` leaves the edits in the
 * worktree without committing; a conflict confined to the backlog's insert-only shape is settled
 * on the way (pickSettlingBacklog). On any other git failure — most often a conflict with what
 * main merged since the rejection, but also a missing object — the cherry-pick is aborted and
 * the worktree reset to main, and false is returned so the caller falls back to a plain
 * rejection note. A git that could not start, or a stopped pick whose conflicts git cannot list,
 * throws instead, keeping the revision and its ref for the next run. */
export async function applyRevision(wt: string, mainBranch: string, sha: string): Promise<boolean> {
  const base = await pickBase(wt, mainBranch, sha);
  if (base === null) {
    await resetWorktreeToMain(wt, mainBranch);
    return false;
  }
  if ((await pickSettlingBacklog(wt, base, sha)).status !== "clean") {
    await gitTry(wt, "cherry-pick", "--abort");
    await resetWorktreeToMain(wt, mainBranch);
    return false;
  }
  return true;
}

/** Re-apply a handed-back change's diff onto current main with the conflict markers left in
 * place as ordinary uncommitted edits, so its author can resolve them (PLANS.md "Robust
 * conflict landing, part 2/2"). Like applyRevision it cherry-picks
 * `<merge-base>..<sha> --no-commit` onto the worktree's current main, settling backlog
 * insert-only conflicts on the way (pickSettlingBacklog), so only files that settler cannot
 * settle keep markers. A conflicted pick is NOT aborted: its sequencer state is quit, a mixed
 * `git reset` drops the index's unmerged entries so the marker-bearing files are plain
 * working-tree edits the run can commit normally, and `{ applied: true, conflicted }` is
 * returned. A failure with no unmerged paths (a missing object, a bad revision) aborts, resets
 * to main, and returns `{ applied: false }` so the caller falls back to a fresh start. A git
 * that could not start, or a stopped pick whose conflicts git cannot list, throws instead, so the
 * run errors with the hand-back and its ref kept for the next. */
export async function applyWithConflicts(
  wt: string,
  mainBranch: string,
  sha: string,
): Promise<ApplyWithConflictsResult> {
  const base = await pickBase(wt, mainBranch, sha);
  if (base === null) {
    await resetWorktreeToMain(wt, mainBranch);
    return { applied: false, conflicted: [] };
  }
  const picked = await pickSettlingBacklog(wt, base, sha);
  if (picked.status === "conflicted") {
    // Keep the marker-bearing files, drop only the index's unmerged stage entries: a mixed
    // reset leaves the working tree untouched, so the markers are uncommitted edits the run
    // stages and commits like any other author work.
    await gitTry(wt, "reset");
    return { applied: true, conflicted: picked.files };
  }
  if (picked.status === "failed") {
    await gitTry(wt, "cherry-pick", "--abort");
    await resetWorktreeToMain(wt, mainBranch);
    return { applied: false, conflicted: [] };
  }
  return { applied: true, conflicted: [] };
}
