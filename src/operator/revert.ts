import { loadConfigSafe } from "../config/config.js";
import { withPrimaryWorktreeLockAsync } from "../concurrency/lock.js";
import { currentBranch, headOf, isMergedInto, targetBranch } from "../git/git.js";
import { GitError, commitAuthorArgs, committerIdentArgs, gitTry, runGit } from "../git/git-run.js";
import { stampedRole, stampedSubject } from "../git/commit-message.js";
import { shortSha } from "../text/format.js";
import { logEventBestEffort, TUMWATER_SOURCE } from "../events/events.js";
import type { RunDetail } from "../run/run-detail-data.js";
import { runMergedSha } from "../run/run-detail-data.js";

/** `tumwater revert <sha>`: undo one merged change on main, committing the inverse as
 * `tumwater(operator): Revert <short sha>` on the primary checkout. Mirrors
 * `commitOperatorBacklogEdit`'s lock-and-branch discipline (src/backlog/backlog-commit.ts): the
 * inverse commit lands under the primary-worktree lock so it cannot interleave with a
 * fast-forward, and it refuses — writing nothing — when the primary is not on the base branch.
 * Fail-closed: an unknown ref, a ref not on the base branch, or a revert that conflicts writes
 * no commit and leaves the checkout as it was. */

/** The shared git steps of a revert: `git revert --no-commit <sha>` in `wt`, then commit just the
 * inverse as `message`. `wt` must have a clean tracked tree (so `--abort` after a conflict has
 * nothing to discard). Never throws; a conflict or a failed commit aborts the revert and comes
 * back as `{ ok: false, error }` with `wt` as it was. */
export async function revertCommitIn(
  wt: string,
  sha: string,
  message: string,
): Promise<{ ok: true; sha: string } | { ok: false; error: string }> {
  if ((await gitTry(wt, "revert", "--no-commit", sha)) === null) {
    // The tree was clean when the revert started, so --abort restores exactly that state.
    await gitTry(wt, "revert", "--abort");
    return { ok: false, error: `reverting ${shortSha(sha)} conflicted; nothing was committed and the checkout is unchanged` };
  }
  // `--only` with the revert's own staged paths commits just the inverse, so it cannot pick up any
  // unrelated change of another path staged after the clean check. `--no-renames` keeps a rename's
  // two halves as separate path lines: the default name-only collapses a detected rename to its
  // destination, which would commit only half and leave the other half staged with a dirty tree.
  const pathsSpec = ((await gitTry(wt, "diff", "--cached", "--name-only", "--no-renames")) ?? "")
    .split("\n")
    .filter((p) => p.length > 0);
  if ((await gitTry(wt, ...(await committerIdentArgs(wt)), "commit", ...commitAuthorArgs(), "--only", "-m", message, "--", ...pathsSpec)) === null) {
    await gitTry(wt, "revert", "--abort");
    return { ok: false, error: `the revert of ${shortSha(sha)} did not commit; nothing was committed` };
  }
  return { ok: true, sha: await headOf(wt, "HEAD") };
}

/** The read-only refusals shared by a revert and its preview: the primary checkout must be on the
 * base branch, `ref` must resolve to a commit, and that commit must be merged into the branch.
 * The dashboard's `handleRun` also calls it, to decide whether a run's commit is on the base
 * branch. */
export async function resolveRevertTarget(
  root: string,
  ref: string,
): Promise<{ ok: true; full: string; primary: string } | { ok: false; error: string }> {
  const primary = await currentBranch(root);
  const base = targetBranch(loadConfigSafe(root).config?.baseBranch, primary);
  if (primary === null || base !== primary)
    return { ok: false, error: `the primary checkout is not on ${base} — run from a checkout of it` };

  const full = await gitTry(root, "rev-parse", "--verify", ref + "^{commit}");
  if (full === null) return { ok: false, error: `no such commit: ${ref}` };

  if (!(await isMergedInto(root, full, primary)))
    return { ok: false, error: `${shortSha(full)} is not on ${primary}` };
  return { ok: true, full, primary };
}

/** The shared read-only prologue of a revert and its preview, so the two cannot drift: resolve
 * `ref` to a merged single-parent commit (the resolveRevertTarget/parentRefusal refusals), then
 * read its subject. The subject is what the reverted-role follow-up and the event log read, and
 * both callers needed exactly these three steps before diverging into their own work. */
async function resolveRevertSubject(
  root: string,
  ref: string,
): Promise<{ ok: true; full: string; primary: string; subject: string } | { ok: false; error: string }> {
  const target = await resolveRevertTarget(root, ref);
  if (!target.ok) return target;
  const refusal = await parentRefusal(root, target.full);
  if (refusal !== null) return { ok: false, error: refusal };
  const subject = await runGit(root, ["log", "-1", "--format=%s", target.full]);
  return { ok: true, full: target.full, primary: target.primary, subject };
}

/** The refusal for a commit without exactly one parent (a root or a merge), or null. Shared by
 * the revert and its preview: `git revert` of a root deletes the whole tree, of a merge needs
 * `-m`. */
async function parentRefusal(root: string, full: string): Promise<string | null> {
  const parents = (await runGit(root, ["rev-list", "--parents", "-n", "1", full])).split(" ").length - 1;
  if (parents === 1) return null;
  return `${shortSha(full)} has ${parents} parents; tumwater revert undoes a single-parent commit only, so nothing was written`;
}

interface RevertPreview {
  ok: true;
  sha: string;
  subject: string;
  paths: string[];
  head: string;
  primary: string;
  applies: boolean;
  dirty: boolean;
}

/** The commit a run's merge put on main, or the CLI's refusal: the run did not merge, or merged
 * but the event log no longer names its commit. Shared by `tumwater revert <role> <n>` and the
 * TUI History trail's Ctrl+V so the two cannot drift. */
export function runRevertSha(
  role: string,
  run: number,
  detail: RunDetail,
): { ok: true; sha: string } | { ok: false; error: string } {
  if (detail.result !== "merged")
    return { ok: false, error: `${role} run #${run} did not merge (result: ${detail.result ?? "unknown"}); there is nothing to revert` };
  const sha = runMergedSha(detail);
  if (sha === null)
    return { ok: false, error: `${role} run #${run} merged but the event log no longer names its commit; pass the sha from git log instead` };
  return { ok: true, sha };
}

/** `tumwater revert <sha> --dry-run`: what a revert of `ref` would undo and whether it applies
 * cleanly, from git's object store alone — a `git merge-tree` three-way merge (base = the commit,
 * ours = HEAD, theirs = its parent, the merge `git revert` performs). Takes no lock and never
 * touches the index, the worktree or a ref. Never throws. */
export async function previewRevert(
  root: string,
  ref: string,
): Promise<RevertPreview | { ok: false; error: string }> {
  try {
    const target = await resolveRevertSubject(root, ref);
    if (!target.ok) return target;
    const { full, primary, subject } = target;
    const paths = (await runGit(root, ["diff", "--name-only", "--no-renames", full + "^", full]))
      .split("\n")
      .filter((p) => p.length > 0);
    const head = await headOf(root, "HEAD");
    let applies = true;
    try {
      await runGit(root, ["merge-tree", "--write-tree", "--merge-base=" + full, "HEAD", full + "^"]);
    } catch (err) {
      if (!(err instanceof GitError)) throw err;
      if (err.code !== 1) return { ok: false, error: `could not preview the revert: ${err.message}` };
      applies = false;
    }
    const dirty = (await runGit(root, ["status", "--porcelain", "--untracked-files=no"])) !== "";
    return { ok: true, sha: full, subject, paths, head, primary, applies, dirty };
  } catch {
    return { ok: false, error: "the revert preview did not complete (git failed); nothing was written" };
  }
}

/** The role a revert of a commit with this subject undoes: the stamped role when it is a working
 * role, else null — an unstamped (hand-made) commit, the operator's or the harness's own. */
function revertedRole(subject: string): string | null {
  const role = stampedRole(subject);
  if (role === undefined || role === "operator" || role === "tumwater") return null; // vocabulary-ok: commit stamp strings
  return role;
}

/** What to tell the operator after reverting a commit with this subject: the role that made it may
 * redo the work. Null when no role made it — an unstamped (hand-made) commit, the operator's or
 * the harness's own. */
export function revertFollowUp(subject: string): string | null {
  const role = revertedRole(subject);
  if (role === null) return null;
  return `the ${role} role may redo the work, so cancel or edit its PLANS.md/BUGS.md entry if it should not`;
}

/** Revert one already-merged commit (`ref` resolved to a commit) and commit the inverse on the
 * primary checkout under the primary-worktree lock. Never throws; every refusal and every git
 * failure comes back as `{ ok: false, error }` after restoring the checkout. `head` is captured
 * before the revert so a future caller can compare; the resolved full sha is what the commit
 * message shortens. */
export async function revertMergedCommit(
  root: string,
  ref: string,
): Promise<{ ok: true; headSha: string; beforeSha: string; subject: string } | { ok: false; error: string }> {
  try {
    // Yield first: a synchronous caller (the TUI key handler) may write again right after this
    // call, and that write takes the same lock synchronously — a lock already held across our
    // awaits would block its event loop until the lock times out.
    await new Promise<void>((resolve) => setImmediate(resolve));
    return await withPrimaryWorktreeLockAsync(root, async () => {
      const target = await resolveRevertSubject(root, ref);
      if (!target.ok) return target;
      const { full, subject } = target;
      // `head` is captured before the revert so a future caller can compare before/after.
      const head = await headOf(root, "HEAD");

      // Fail-closed on any staged or unstaged change to a tracked path: we refuse to revert a
      // checkout that has one (untracked files are tolerated — the lock dir we just created is
      // one). This keeps the inverse commit free of unrelated content and, just as important,
      // makes `git revert --abort` below safe to run after a conflict — with nothing dirty in
      // the index or tree there is nothing for its hard reset to discard, so the operand's
      // pre-existing work can never be lost.
      if ((await gitTry(root, "status", "--porcelain", "--untracked-files=no")) !== "")
        return { ok: false, error: "the worktree has staged or unstaged changes; commit or stash them first, nothing was committed" };

      const reverted = await revertCommitIn(root, full, stampedSubject("operator", "Revert " + shortSha(full))); // vocabulary-ok: the tumwater(operator): commit prefix is a machine string
      if (!reverted.ok) return reverted;

      // Log the operator's deliberate revert while the primary lock is held, so the inverse
      // commit and its trail land together. Best-effort: a failed event write must never turn a
      // successful revert into a refusal.
      const role = revertedRole(subject);
      logEventBestEffort(root, {
        source: TUMWATER_SOURCE,
        type: "operator_revert",
        commit: full,
        revert: reverted.sha,
        subject,
        ...(role === null ? {} : { runner: role }),
      });

      return { ok: true, headSha: await headOf(root, "HEAD"), beforeSha: head, subject };
    });
  } catch {
    return { ok: false, error: "the revert did not complete (git failed); nothing was committed" };
  }
}
