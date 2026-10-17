import { gitTry } from "../git/git-run.js";
import { resetWorktreeToMain } from "../git/worktree.js";
import { conflictedFiles } from "../merge/merge-git.js";

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

/** Re-apply a rejected change `sha` onto current main as uncommitted edits in `wt`
 * (plans/revise-rejected.md): the author's next tick starts from the rejected diff instead of
 * re-deriving it. `git cherry-pick --no-commit <merge-base>..<sha>` leaves the edits in the
 * worktree without committing. On any git failure — most often a conflict with what main merged
 * since the rejection, but also a missing object — the cherry-pick is aborted and the worktree
 * reset to main, and false is returned so the caller falls back to a plain rejection note. */
export async function applyRevision(wt: string, mainBranch: string, sha: string): Promise<boolean> {
  const base = await gitTry(wt, "merge-base", mainBranch, sha);
  if (base === null) {
    await resetWorktreeToMain(wt, mainBranch);
    return false;
  }
  const picked = await gitTry(wt, "cherry-pick", "--no-commit", `${base}..${sha}`);
  if (picked === null) {
    await gitTry(wt, "cherry-pick", "--abort");
    await resetWorktreeToMain(wt, mainBranch);
    return false;
  }
  return true;
}

/** Re-apply a handed-back change's diff onto current main with the conflict markers left in
 * place as ordinary uncommitted edits, so its author can resolve them (PLANS.md "Robust
 * conflict landing, part 2/2"). Like applyRevision it cherry-picks
 * `<merge-base>..<sha> --no-commit` onto the worktree's current main. A conflicted pick is NOT
 * aborted: the unmerged paths are read off the index, a mixed `git reset` drops the index state
 * so the marker-bearing files are plain working-tree edits the tick can commit normally, and
 * `{ applied: true, conflicted }` is returned. A failure with no unmerged paths (a missing
 * object, a bad revision) aborts, resets to main, and returns `{ applied: false }` so the
 * caller falls back to a fresh start. Never throws for a git-level failure. */
export async function applyWithConflicts(
  wt: string,
  mainBranch: string,
  sha: string,
): Promise<ApplyWithConflictsResult> {
  const base = await gitTry(wt, "merge-base", mainBranch, sha);
  if (base === null) {
    await resetWorktreeToMain(wt, mainBranch);
    return { applied: false, conflicted: [] };
  }
  const picked = await gitTry(wt, "cherry-pick", "--no-commit", `${base}..${sha}`);
  // conflictedFiles, not a raw diff: it decodes git's C-quoted names, so a non-ASCII
  // conflicted path is the on-disk name the prompt and hasConflictMarkers can use.
  const conflicted = await conflictedFiles(wt);
  if (conflicted.length > 0) {
    // Keep the marker-bearing files, drop only the index's unmerged stage entries: a mixed
    // reset leaves the working tree untouched, so the markers are uncommitted edits the tick
    // stages and commits like any other author work.
    await gitTry(wt, "reset");
    return { applied: true, conflicted };
  }
  if (picked === null) {
    await gitTry(wt, "cherry-pick", "--abort");
    await resetWorktreeToMain(wt, mainBranch);
    return { applied: false, conflicted: [] };
  }
  return { applied: true, conflicted: [] };
}
