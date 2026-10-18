// vocabulary: plain
import { loadConfigSafe } from "../config/config.js";
import { withStateLockAsync } from "../concurrency/lock.js";
import { currentBranch, headOf, isMergedInto, targetBranch } from "../git/git.js";
import { COMMIT_IDENT, gitTry } from "../git/git-run.js";
import { stampedSubject } from "../git/commit-message.js";
import { primaryWorktreeLockPath } from "../paths.js";
import { shortSha } from "../text/format.js";

/** `tumwater revert <sha>`: undo one merged change on main, committing the inverse as
 * `tumwater(operator): Revert <short sha>` on the primary checkout. Mirrors
 * `commitOperatorBacklogEdit`'s lock-and-branch discipline (src/backlog/backlog-commit.ts): the
 * inverse commit lands under the primary-worktree lock so it cannot interleave with a
 * fast-forward, and it refuses — writing nothing — when the primary is not on the base branch.
 * Fail-closed: an unknown ref, a ref not on the base branch, or a revert that conflicts writes
 * no commit and leaves the checkout as it was. */

/** Revert one already-merged commit (`ref` resolved to a commit) and commit the inverse on the
 * primary checkout under the primary-worktree lock. Never throws; every refusal and every git
 * failure comes back as `{ ok: false, error }` after restoring the checkout. `head` is captured
 * before the revert so a future caller can compare; the resolved full sha is what the commit
 * message shortens. */
export async function revertMergedCommit(
  root: string,
  ref: string,
): Promise<{ ok: true; headSha: string; beforeSha: string } | { ok: false; error: string }> {
  try {
    // Yield first: a synchronous caller (the TUI key handler) may write again right after this
    // call, and that write takes the same lock synchronously — a lock already held across our
    // awaits would block its event loop until the lock times out.
    await new Promise<void>((resolve) => setImmediate(resolve));
    return await withStateLockAsync(primaryWorktreeLockPath(root), async () => {
      const primary = await currentBranch(root);
      const base = targetBranch(loadConfigSafe(root).config?.baseBranch, primary);
      if (primary === null || base !== primary)
        return { ok: false, error: `the primary checkout is not on ${base} — run from a checkout of it` };

      const full = await gitTry(root, "rev-parse", "--verify", ref + "^{commit}");
      if (full === null) return { ok: false, error: `no such commit: ${ref}` };

      // `head` is captured before the revert so a future caller can compare before/after.
      const head = await headOf(root, "HEAD");
      if (!(await isMergedInto(root, full, primary)))
        return { ok: false, error: `${shortSha(full)} is not on ${primary}` };

      // Fail-closed on any staged or unstaged change to a tracked path: we refuse to revert a
      // checkout that has one (untracked files are tolerated — the lock dir we just created is
      // one). This keeps the inverse commit free of unrelated content and, just as important,
      // makes `git revert --abort` below safe to run after a conflict — with nothing dirty in
      // the index or tree there is nothing for its hard reset to discard, so the operand's
      // pre-existing work can never be lost.
      if ((await gitTry(root, "status", "--porcelain", "--untracked-files=no")) !== "")
        return { ok: false, error: "the worktree has staged or unstaged changes; commit or stash them first, nothing was committed" };

      if ((await gitTry(root, "revert", "--no-commit", full)) === null) {
        // The tree was clean when the revert started, so --abort restores exactly that state.
        await gitTry(root, "revert", "--abort");
        return { ok: false, error: `reverting ${shortSha(full)} conflicted; nothing was committed and the checkout is unchanged` };
      }

      const commitMsg = stampedSubject("operator", "Revert " + shortSha(full)); // vocabulary-ok: the tumwater(operator): commit prefix is a machine string
      // Mirror commitOperatorBacklogEdit: `--only` with the revert's own staged paths commits
      // just the inverse, so it cannot pick up any unrelated change of another path staged
      // after the clean check above. `--no-renames` keeps a rename's two halves as separate
      // path lines: the default name-only collapses a detected rename to its destination, which
      // would commit only half and leave the other half staged with a dirty tree.
      const pathsSpec = ((await gitTry(root, "diff", "--cached", "--name-only", "--no-renames")) ?? "")
        .split("\n")
        .filter((p) => p.length > 0);
      if ((await gitTry(root, ...COMMIT_IDENT, "commit", "--only", "-m", commitMsg, "--", ...pathsSpec)) === null) {
        await gitTry(root, "revert", "--abort");
        return { ok: false, error: `the revert of ${shortSha(full)} did not commit; nothing was committed` };
      }

      return { ok: true, headSha: await headOf(root, "HEAD"), beforeSha: head };
    });
  } catch {
    return { ok: false, error: "the revert did not complete (git failed); nothing was committed" };
  }
}
