import { loadConfigSafe } from "../config/config.js";
import { withPrimaryWorktreeLockAsync } from "../concurrency/lock.js";
import { currentBranch, targetBranch } from "../git/git.js";
import { commitAuthorArgs, committerIdentArgs, gitTry } from "../git/git-run.js";

/** Commit one operator-written backlog file on main, so the entry reaches the worktrees that
 * branch from main and the primary checkout stays clean for the next fast-forward. Runs under
 * the primary-worktree lock `ffMainTo`'s working-tree arm takes, so the commit and a
 * fast-forward cannot interleave. Returns false when the commit did not land — the primary is
 * not on the base branch (the ref-push arm: the working tree is not main's), or git failed —
 * and in that case restores the file to its committed state so the primary checkout does not
 * stay dirty and block every merge touching it with "the merge would overwrite files in the
 * primary checkout". It never throws. `--only` with a pathspec commits just that file's
 * working-tree content and leaves other staged or dirty paths alone. */
export async function commitOperatorBacklogEdit(root: string, file: string, subject: string): Promise<boolean> {
  try {
    // Yield first: a synchronous caller (the TUI key handler) may write again right after this
    // call, and that write takes the same lock synchronously — a lock already held across our
    // awaits would block its event loop until the lock times out.
    await new Promise<void>((resolve) => setImmediate(resolve));
    return await withPrimaryWorktreeLockAsync(root, async () => {
      const primary = await currentBranch(root);
      let committed =
        primary !== null &&
        targetBranch(loadConfigSafe(root).config?.baseBranch, primary) === primary &&
        (await gitTry(root, ...(await committerIdentArgs(root)), "commit", ...commitAuthorArgs(), "--only", "-m", subject, "--", file)) !== null;
      if (!committed) {
        // The write landed in the working tree but could not be committed to the base branch:
        // roll the file back to its committed state (HEAD) so the primary checkout stays clean
        // for the next fast-forward instead of refusing every merge that touches it. Only this
        // file is touched; other staged or dirty paths are left alone.
        await gitTry(root, "checkout", "HEAD", "--", file);
      }
      return committed;
    });
  } catch {
    return false;
  }
}
