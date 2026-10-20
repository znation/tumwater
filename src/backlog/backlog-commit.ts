import { loadConfigSafe } from "../config/config.js";
import { withPrimaryWorktreeLockAsync } from "../concurrency/lock.js";
import { currentBranch, targetBranch } from "../git/git.js";
import { commitAuthorArgs, committerIdentArgs, gitTry } from "../git/git-run.js";

/** Commit one operator-written backlog file on main, so the entry reaches the worktrees that
 * branch from main and the primary checkout stays clean for the next fast-forward. Runs under
 * the primary-worktree lock `ffMainTo`'s working-tree arm takes, so the commit and a
 * fast-forward cannot interleave. Returns false, writing nothing, when the primary is not on
 * the base branch (the ref-push arm: the working tree is not main's) or when git fails; it
 * never throws, and the entry stays written either way. `--only` with a pathspec commits just
 * that file's working-tree content and leaves other staged or dirty paths alone. */
export async function commitOperatorBacklogEdit(root: string, file: string, subject: string): Promise<boolean> {
  try {
    // Yield first: a synchronous caller (the TUI key handler) may write again right after this
    // call, and that write takes the same lock synchronously — a lock already held across our
    // awaits would block its event loop until the lock times out.
    await new Promise<void>((resolve) => setImmediate(resolve));
    return await withPrimaryWorktreeLockAsync(root, async () => {
      const primary = await currentBranch(root);
      if (primary === null) return false;
      if (targetBranch(loadConfigSafe(root).config?.baseBranch, primary) !== primary) return false;
      return (await gitTry(root, ...(await committerIdentArgs(root)), "commit", ...commitAuthorArgs(), "--only", "-m", subject, "--", file)) !== null;
    });
  } catch {
    return false;
  }
}
