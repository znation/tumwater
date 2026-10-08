import fs from "node:fs";
import path from "node:path";
import { GIT_TIMEOUT_MS, git, gitTry } from "./git-run.js";
import { branchExists, resolveGitDir } from "./git.js";
import { pruneOldDirectory, removeTree } from "../files/files.js";
import { KILL_GRACE_MS } from "../process/process-group.js";
import { branchName, worktreePath } from "../paths.js";

/** Persistent-worktree lifecycle for the harness: role worktrees (one per loop, reset to main
 * on every fresh tick) and the detached mirror worktree redeploy.ts verifies and compiles.
 * The generic git plumbing these build on lives in git/git.ts; this module owns creating,
 * self-healing, resetting, and abort-syncing those worktrees. */

/** True when `dir` exists and is still a usable git worktree — its .git pointer file present
 * and resolvable via rev-parse. The shared usability probe of both ensure* functions below;
 * a directory that fails it (pointer lost, or admin-side registration under <root>/.git/
 * worktrees/ pruned by outside git maintenance) is rebuilt from scratch instead of failing
 * every tick. Also exported for read-only viewers that must classify a worktree as absent
 * rather than fail (change/change-data.ts's collectRoleChange), so the probe's exact
 * conditions live in one place. */
export async function isUsableWorktree(dir: string): Promise<boolean> {
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

/** Age past which a stale `dist/` build dir inside a worktree is pruned (see pruneOldDirectory).
 * `git clean -fd` leaves gitignored dirs like `dist/` (this repo's tsconfig outDir) behind, so
 * they are reaped by age. */
const BUILD_PRUNE_DAYS = 7;

/** The gitignored build dir inside a worktree, reaped by age under it — never the worktree root
 * itself, which every ensureDetachedWorktree/resetWorktreeToMain caller uses right after. */
function pruneStaleBuildDir(wt: string): void {
  pruneOldDirectory(path.join(wt, "dist"), BUILD_PRUNE_DAYS);
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
    if (await branchExists(root, branch)) {
      await git(root, "worktree", "add", wt, branch);
    } else {
      await git(root, "worktree", "add", "-b", branch, wt, mainBranch);
    }
    return wt;
  });
}

/** Remove the worktree checkout at `dir` and its git registration, self-healing every dead-
 * registration shape: the registration's `locked` file (ensureWorktree's setup race) shields
 * it from prune, so it is cleared before `git worktree remove --force`; a remove that fails or
 * leaves a leftover directory (directory gone, or the admin dir pruned by outside maintenance —
 * the same states isUsableWorktree classifies) falls back to `worktree prune` and a directory
 * removal, pruned once more so a registration pointing at the now-missing directory unregisters.
 * Shared by removeWorktree (role checkouts) and worktree-pool.ts's shrunken-slot cleanup, so
 * both classes of checkout heal identically. */
export async function removeWorktreeDir(root: string, dir: string): Promise<void> {
  const gitdir = isUsableWorktreeSyncPath(dir) ? resolveGitDir(dir) : undefined;
  if (gitdir !== undefined) {
    try {
      fs.rmSync(path.join(gitdir, "locked"), { force: true });
    } catch {
      // An unreadable registration dir: remove --force or the prune below still runs.
    }
  }
  const removed = (await gitTry(root, "worktree", "remove", "--force", dir)) !== null;
  if (!removed || fs.existsSync(dir)) {
    await gitTry(root, "worktree", "prune");
    if (fs.existsSync(dir)) {
      removeTree(dir);
      // Prune once more: the registration may have survived the first prune (its directory was
      // still present, e.g. a corrupt .git pointer) and only a missing directory unregisters it.
      await gitTry(root, "worktree", "prune");
    }
  }
}

/** Remove a role's persistent worktree and its git registration, through the shared checkout
 * remover (removeWorktreeDir). */
export async function removeWorktree(root: string, role: string): Promise<void> {
  await removeWorktreeDir(root, worktreePath(root, role));
}

/** Cheap file-existence shape probe for removeWorktreeDir: resolveGitDir needs the `.git` pointer,
 * and probing it for a directory that does not exist would only produce a caught throw — the
 * existence check keeps the common absent case allocation-free. Not a usability check; that
 * is isUsableWorktree's spawn-backed probe. */
function isUsableWorktreeSyncPath(dir: string): boolean {
  return fs.existsSync(path.join(dir, ".git"));
}

/** Ensure a detached worktree at `dir` checked out at `ref` (a branch name or sha), creating or
 * repairing it like ensureWorktree does for role worktrees, then hard-reset and cleaned so it
 * holds exactly `ref`'s tree. A stale index.lock left by a killed git is cleared first, or the
 * checkout/reset below would fail on it forever. Used by redeploy.ts as the pristine copy of main it verifies and
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
  await hardResetWorktree(dir, ref, true);
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

/** Age past which a git `index.lock` left in a worktree is treated as a dead git's wreckage
 * rather than a live writer's claim. Every git the harness itself starts is bounded by
 * GIT_TIMEOUT_MS plus the KILL_GRACE_MS escalation, after which the whole process group is
 * confirmed dead — so an index.lock older than that cannot belong to a live git of ours. */
const STALE_GIT_LOCK_MS = GIT_TIMEOUT_MS + KILL_GRACE_MS;

/** Remove a stale `index.lock` from `wt`'s gitdir. A git killed mid-write — our own group
 * deadline's SIGKILL after a SIGTERM it could not handle, a crashed harness, an operator kill —
 * leaves index.lock behind, and every later `git reset --hard` then fails "Unable to create
 * '…/index.lock': File exists" with no self-heal, wedging the loop on every tick. A *fresh*
 * lock is left alone: it may belong to a git still running, so this clears wreckage, never a
 * live writer. */
function clearStaleIndexLock(wt: string): void {
  const gitdir = resolveGitDir(wt);
  if (gitdir === undefined) return;
  const lock = path.join(gitdir, "index.lock");
  try {
    if (Date.now() - fs.statSync(lock).mtimeMs >= STALE_GIT_LOCK_MS) fs.rmSync(lock, { force: true });
  } catch {
    // No lock file (the common case), or an unreadable gitdir: nothing to clear.
  }
}

/** Hard-reset a worktree to `ref`, self-healing the two wedges a killed git leaves behind: a
 * stale index.lock is cleared first (or the reset fails "Unable to create '…/index.lock'"
 * forever), and an interrupted merge or rebase is aborted (or the tick wedges on "you are
 * already rebasing"). With `detach`, the worktree is checked out detached at `ref` first —
 * ensureDetachedWorktree's repair path for a worktree left on a branch; resetWorktreeToMain
 * leaves its branch checked out. Untracked files are dropped (ignored files survive; the stale
 * `dist/` build dir is reaped by age). */
async function hardResetWorktree(wt: string, ref: string, detach = false): Promise<void> {
  clearStaleIndexLock(wt);
  await abortSync(wt);
  if (detach) await git(wt, "checkout", "--detach", ref);
  await git(wt, "reset", "--hard", ref);
  await git(wt, "clean", "-fd");
  pruneStaleBuildDir(wt);
}

/** Hard-reset a worktree's branch to main — the fresh-tick reset. */
export async function resetWorktreeToMain(wt: string, mainBranch: string): Promise<void> {
  await hardResetWorktree(wt, mainBranch);
}
