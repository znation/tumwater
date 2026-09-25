import fs from "node:fs";
import path from "node:path";
import { git, gitTry, resolveGitDir } from "./git.js";
import { removeTree } from "./files.js";
import { branchName, worktreePath } from "./paths.js";

/** Persistent-worktree lifecycle for the harness: role worktrees (one per loop, reset to main
 * on every fresh tick) and the detached mirror worktree redeploy.ts verifies and compiles.
 * The generic git plumbing these build on lives in git.ts; this module owns creating,
 * self-healing, resetting, and abort-syncing those worktrees. */

/** True when `dir` exists and is still a usable git worktree — its .git pointer file present
 * and resolvable via rev-parse. The shared usability probe of both ensure* functions below;
 * a directory that fails it (pointer lost, or admin-side registration under <root>/.git/
 * worktrees/ pruned by outside git maintenance) is rebuilt from scratch instead of failing
 * every tick. */
async function isUsableWorktree(dir: string): Promise<boolean> {
  return fs.existsSync(dir) && (await gitTry(dir, "rev-parse", "--git-dir")) !== null;
}

/** Clear the way for `worktree add` at `dir`: prune stale registrations first (a registration
 * whose directory was deleted still blocks the add), then remove a leftover unusable directory
 * and prune again so no registration points at it. The removed content is harness scratch only
 * — role worktrees are reset to main on every fresh tick, and branch commits survive in
 * refs/heads either way. Call only inside serializeSetup: a prune deletes any registration
 * another `worktree add` is still creating. */
async function clearStaleWorktree(root: string, dir: string): Promise<void> {
  await gitTry(root, "worktree", "prune");
  if (fs.existsSync(dir)) {
    removeTree(dir);
    await gitTry(root, "worktree", "prune"); // drop any registration left pointing at it
  }
}

/** The tail of each repository's queue of worktree setups (serializeSetup). */
const setupQueues = new Map<string, Promise<unknown>>();

/** Run `setup` — a clear-and-add of one worktree — after every earlier setup for the same
 * repository has finished. `git worktree add` creates the new registration's directory under
 * .git/worktrees a moment before it writes the `locked` file that shields it from prune, and a
 * `git worktree prune` landing in between deletes the registration: the add then dies with
 * "could not open '.git/worktrees/<name>/locked' for writing". The landing pipeline vets its
 * changes concurrently, each vet ensuring its own lander worktree, so two vets' clear-and-add
 * steps did interleave — and the loser's vet ended in a terminal "error" that dropped its queue
 * entry. Serializing the harness's own setups per repository closes that; the usable-worktree
 * fast path never takes the queue. */
async function serializeSetup<T>(root: string, setup: () => Promise<T>): Promise<T> {
  const key = path.resolve(root);
  const run = (setupQueues.get(key) ?? Promise.resolve()).then(setup);
  const tail = run.catch(() => undefined);
  setupQueues.set(key, tail);
  try {
    return await run;
  } finally {
    if (setupQueues.get(key) === tail) setupQueues.delete(key);
  }
}

/** Ensure a persistent worktree + branch exists for a role. Returns the worktree path.
 * Self-heals when the directory exists but is no longer a usable worktree: it removes and
 * re-adds the directory instead of failing every tick (see clearStaleWorktree). */
export async function ensureWorktree(root: string, role: string, mainBranch: string): Promise<string> {
  const wt = worktreePath(root, role);
  const branch = branchName(role);
  if (await isUsableWorktree(wt)) return wt;
  return serializeSetup(root, async () => {
    if (await isUsableWorktree(wt)) return wt; // a setup queued ahead of this one made it
    await clearStaleWorktree(root, wt);
    const branchExists = (await gitTry(root, "rev-parse", "--verify", `refs/heads/${branch}`)) !== null;
    if (branchExists) {
      await git(root, "worktree", "add", wt, branch);
    } else {
      await git(root, "worktree", "add", "-b", branch, wt, mainBranch);
    }
    return wt;
  });
}

/** Ensure a detached worktree at `dir` checked out at `ref` (a branch name or sha), creating or
 * repairing it like ensureWorktree does for role worktrees, then hard-reset and cleaned so it
 * holds exactly `ref`'s tree. Used by redeploy.ts as the pristine copy of main it verifies and
 * compiles — the primary checkout may be dirty or on another branch, a role worktree is never
 * pristine while its loop works. */
export async function ensureDetachedWorktree(root: string, dir: string, ref: string): Promise<string> {
  if (!(await isUsableWorktree(dir))) {
    const created = await serializeSetup(root, async () => {
      if (await isUsableWorktree(dir)) return false; // a setup queued ahead of this one made it
      await clearStaleWorktree(root, dir);
      await git(root, "worktree", "add", "--detach", dir, ref);
      return true;
    });
    if (created) return dir;
  }
  await abortSync(dir);
  await git(dir, "checkout", "--detach", ref);
  await git(dir, "reset", "--hard", ref);
  await git(dir, "clean", "-fd");
  return dir;
}

/** True when no merge and no rebase is in progress in `wt`, checked from the state files
 * git itself leaves behind — MERGE_HEAD for a merge, rebase-merge/ or rebase-apply/ for a
 * rebase — instead of spawning two aborts that can only fail. Returns false ("run the
 * aborts anyway") whenever either is running OR the gitdir cannot be resolved from files:
 * false is always safe, it just means "do exactly what the old spawn-based check did".
 * Synchronous and microsecond-scale: this exists because abortSync runs on every fresh tick
 * and the common case used to cost two ~10ms subprocess spawns that were guaranteed no-ops. */
function syncStateClear(wt: string): boolean {
  const gitdir = resolveGitDir(wt);
  if (gitdir === undefined) return false; // Not a repo we can inspect — fall back to the spawns.
  try {
    if (!fs.statSync(gitdir).isDirectory()) return false; // Pointer target gone: uncertain.
  } catch {
    return false;
  }
  try {
    fs.statSync(path.join(gitdir, "MERGE_HEAD"));
    return false;
  } catch {
    // No merge in progress — rebase state next.
  }
  for (const dir of ["rebase-merge", "rebase-apply"]) {
    try {
      if (fs.statSync(path.join(gitdir, dir)).isDirectory()) return false;
    } catch {
      // This backend's rebase state is absent.
    }
  }
  return true;
}

/** Abort any in-progress merge or rebase (no-op when neither is running). The common case —
 * nothing in progress — returns after a microsecond-scale file check instead of spawning
 * two aborts that can only fail. */
export async function abortSync(wt: string): Promise<void> {
  if (syncStateClear(wt)) return;
  await gitTry(wt, "merge", "--abort");
  await gitTry(wt, "rebase", "--abort");
}

/** Hard-reset a worktree's branch to main and drop untracked files (ignored files survive).
 * An interrupted merge or rebase is aborted first — otherwise the next tick would wedge on
 * "you are already rebasing" / "merge in progress". */
export async function resetWorktreeToMain(wt: string, mainBranch: string): Promise<void> {
  await abortSync(wt);
  await git(wt, "reset", "--hard", mainBranch);
  await git(wt, "clean", "-fd");
}
