import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import { branchName, worktreePath } from "./paths.js";

const execFileAsync = promisify(execFile);

/** Identity used for harness-authored commits so ticks work without global git config. */
const COMMIT_IDENT = [
  "-c",
  "user.name=automaton",
  "-c",
  "user.email=automaton@localhost",
];

export class GitError extends Error {
  constructor(
    public args: string[],
    public stderr: string,
    public code: number | undefined,
  ) {
    super(`git ${args.join(" ")} failed (${code}): ${stderr.trim()}`);
  }
}

/** Run git in `cwd`, throwing GitError on nonzero exit. Returns trimmed stdout. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout.trimEnd();
  } catch (err) {
    const e = err as { stderr?: string; code?: number };
    throw new GitError(args, e.stderr ?? String(err), e.code);
  }
}

/** Run git, returning null instead of throwing on failure. */
export async function gitTry(cwd: string, ...args: string[]): Promise<string | null> {
  try {
    return await git(cwd, ...args);
  } catch {
    return null;
  }
}

export async function isGitRepo(dir: string): Promise<boolean> {
  return (await gitTry(dir, "rev-parse", "--git-dir")) !== null;
}

/** True if the repo has at least one commit. */
export async function hasCommits(root: string): Promise<boolean> {
  return (await gitTry(root, "rev-parse", "--verify", "HEAD")) !== null;
}

export async function headOf(root: string, ref: string): Promise<string> {
  return git(root, "rev-parse", "--verify", ref);
}

/** The branch the primary checkout has, or null when detached. */
export async function currentBranch(root: string): Promise<string | null> {
  const out = await gitTry(root, "symbolic-ref", "--short", "HEAD");
  return out;
}

export async function isDirty(cwd: string): Promise<boolean> {
  const out = await git(cwd, "status", "--porcelain");
  return out.length > 0;
}

/** Ensure a persistent worktree + branch exists for a role. Returns the worktree path. */
export async function ensureWorktree(root: string, role: string, mainBranch: string): Promise<string> {
  const wt = worktreePath(root, role);
  const branch = branchName(role);
  if (fs.existsSync(wt) && (await gitTry(wt, "rev-parse", "--git-dir")) !== null) {
    return wt;
  }
  // A stale registration (dir deleted, worktree still known) blocks `worktree add`.
  await gitTry(root, "worktree", "prune");
  const branchExists = (await gitTry(root, "rev-parse", "--verify", `refs/heads/${branch}`)) !== null;
  if (branchExists) {
    await git(root, "worktree", "add", wt, branch);
  } else {
    await git(root, "worktree", "add", "-b", branch, wt, mainBranch);
  }
  return wt;
}

/** Hard-reset a worktree's branch to main and drop untracked files (ignored files survive). */
export async function resetWorktreeToMain(wt: string, mainBranch: string): Promise<void> {
  await gitTry(wt, "merge", "--abort");
  await git(wt, "reset", "--hard", mainBranch);
  await git(wt, "clean", "-fd");
}

/** Commits ahead of main on the worktree's branch. */
export async function aheadOfMain(wt: string, mainBranch: string): Promise<number> {
  const out = await git(wt, "rev-list", "--count", `${mainBranch}..HEAD`);
  return parseInt(out, 10);
}

/** Stage and commit everything in the worktree. Returns the new commit hash. */
export async function commitAll(wt: string, message: string): Promise<string> {
  await git(wt, "add", "-A");
  await git(wt, ...COMMIT_IDENT, "commit", "-m", message);
  return headOf(wt, "HEAD");
}

/** Merge main into the worktree branch (main may have advanced during the tick).
 * Returns false and aborts the merge on conflict. */
export async function mergeMainIntoBranch(wt: string, mainBranch: string): Promise<boolean> {
  try {
    await git(wt, ...COMMIT_IDENT, "merge", "--no-edit", mainBranch);
    return true;
  } catch {
    await gitTry(wt, "merge", "--abort");
    return false;
  }
}

/** Fast-forward main to the role branch, without touching any remote.
 * Uses a working-tree merge when the primary checkout is on main (so its files update),
 * otherwise a local ref push. Returns true on success. */
export async function ffMergeToMain(root: string, role: string, mainBranch: string): Promise<boolean> {
  const branch = branchName(role);
  const primaryBranch = await currentBranch(root);
  if (primaryBranch === mainBranch) {
    return (await gitTry(root, "merge", "--ff-only", branch)) !== null;
  }
  return (await gitTry(root, "push", ".", `${branch}:${mainBranch}`)) !== null;
}
