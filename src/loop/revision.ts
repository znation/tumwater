import { gitTry } from "../git/git-run.js";
import { resetWorktreeToMain } from "../git/worktree.js";

/** The most revision rounds one rejected change gets before its rejection is final
 * (plans/revise-rejected.md): the gate rejected the change, the author re-applies the rejected
 * diff onto current main, fixes the named objections and re-submits. Past this the change is
 * dropped and a plain rejection stands, so a non-converging author cannot revise forever. */
export const REVISION_LIMIT = 2;

/** Re-apply a rejected change `sha` onto current main as uncommitted edits in `wt`
 * (plans/revise-rejected.md): the author's next tick starts from the rejected diff instead of
 * re-deriving it. `git cherry-pick --no-commit <merge-base>..<sha>` leaves the edits in the
 * worktree without committing. On any git failure — most often a conflict with what main landed
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
