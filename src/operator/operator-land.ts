import path from "node:path";
import { loadConfigSafe } from "../config/config.js";
import { mergeLockDir, MERGE_LOCK_WAIT_MS, worktreesDir } from "../paths.js";
import { withLock } from "../concurrency/lock.js";
import { currentBranch, headOf, isDirty, isMergedInto, targetBranch } from "../git/git.js";
import { committerIdentArgs, git, gitTry, runGit } from "../git/git-run.js";
import { shortSha } from "../text/format.js";
import { conflictedFiles } from "../merge/merge-git.js";
import { ffMainToOrWhy } from "../merge/merge-git.js";
import { resolveBacklogInsertConflicts } from "../merge/merge-backlog-conflicts.js";
import { ensureDetachedWorktree, removeWorktreeDir } from "../git/worktree.js";

/** `tumwater land [<ref>]`: put the operator's own commit(s) on main under the team's merge
 * lock. The operator's intended way to steer the team is editing PLANS.md / BUGS.md from their
 * own agent; those edits have no safe path onto main while a team runs, so this takes the lock a
 * team merge takes and fast-forwards main to the ref. It never runs a model or a check: the
 * operator's commit is trusted, and the hourly full check and the next role gates see it as any
 * other main move.
 *
 * Lock discipline (PLAN.md part 1/5): the WHOLE land runs under `withLock(mergeLockDir)`, so a
 * land waits for an in-flight team merge to release the merge lock before it moves main, and no
 * team merge moves main underneath a land in progress. The working-tree fast-forward inside
 * (ffMainToOrWhy's merge arm) takes the primary-worktree lock itself — that is the one lock that
 * must NOT be held for the whole land, because a second acquire of the same non-reentrant
 * file-lock by this process would block until its own timeout. Holding only the merge lock keeps
 * both guarantees without the self-deadlock. */

interface SteerCommit {
  sha: string;
  subject: string;
}

interface SteerOutcome {
  ok: true;
  beforeSha: string;
  headSha: string;
  replayed: boolean;
  commits: SteerCommit[];
  /** The operator's branch moved to the landed tip, or the sha to reset to by hand. */
  refNote: string;
}

interface SteerPreview {
  ok: true;
  beforeSha: string;
  commits: SteerCommit[];
  paths: string[];
  replay: boolean;
  applies: boolean;
}

interface SteerError {
  ok: false;
  error: string;
}


/** `mainBranch` for the repo, from config's baseBranch else the checkout's branch. */
async function baseBranch(root: string): Promise<string> {
  const primary = await currentBranch(root);
  return targetBranch(loadConfigSafe(root).config?.baseBranch, primary);
}

/** Resolve `ref` to a full commit sha, or the refusal that explains the miss. */
async function resolveRef(root: string, ref: string): Promise<{ full: string } | { error: string }> {
  const full = await gitTry(root, "rev-parse", "--verify", ref + "^{commit}");
  if (full === null) return { error: `no such commit: ${ref}` };
  return { full };
}

/** The commits `ref` would land, oldest first, from `base` — the range the fast-forward or
 * replay applies. `base` comes from steerRange, which resolves the merge-base once. */
async function rangeCommits(root: string, base: string, refSha: string): Promise<SteerCommit[]> {
  const out = await git(root, "log", "--reverse", "--format=%H%x1f%s", `${base}..${refSha}`);
  return out
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [sha = "", subject = ""] = line.split("\x1f");
      return { sha, subject };
    });
}

/** The net files the range changes, for the `--dry-run` report and the `.tumwater/` guard.
 * Takes the same `base` steerRange resolved for rangeCommits. */
async function rangePaths(root: string, base: string, refSha: string): Promise<string[]> {
  const out = await git(root, "diff", "--name-only", "--no-renames", base, refSha);
  return out.split("\n").filter((p) => p.length > 0);
}

/** A refusal when the range would write into tumwater's own state dir, or null. */
async function tumwaterPathRefusal(paths: string[]): Promise<string | null> {
  const hit = paths.find((p) => p === ".tumwater" || p.startsWith(".tumwater/"));
  if (hit === undefined) return null;
  return `the range touches tumwater's own state dir (${hit}); tumwater land refuses to move main through a change to it — commit your backlog edits and land them separately`;
}

/** A refusal when any commit in the range is a merge commit (the range holds more than the
 * operator's linear work), or null. */
async function mergeCommitRefusal(root: string, commits: SteerCommit[]): Promise<string | null> {
  for (const { sha } of commits) {
    const parents = (await runGit(root, ["rev-list", "--parents", "-n", "1", sha])).split(" ").length - 1;
    if (parents > 1) return `${shortSha(sha)} is a merge commit with ${parents} parents; tumwater land fast-forwards a linear range only — rebase it onto main first`;
  }
  return null;
}

/** What a land of `ref` would apply, validated: the resolved ref sha, main's branch and head, and
 * the range's commits and net paths. */
interface SteerRange {
  ok: true;
  refSha: string;
  mainBranch: string;
  mainSha: string;
  commits: SteerCommit[];
  paths: string[];
}

/** The validated range a land of `ref` would apply, or the first refusal that stops it (no such
 * commit, already on main, an empty range, a path in tumwater's own state dir, a merge commit in
 * the range). Both `tumwater land` arms read this before they take the merge lock or write
 * anything, so the live land and its `--dry-run` cannot disagree about what the range holds.
 *
 * The merge-base is resolved once here and passed down, so the range's commits and paths are
 * computed from the same base; computed separately they could straddle a team merge of main. */
async function steerRange(root: string, ref: string): Promise<SteerRange | SteerError> {
  const resolved = await resolveRef(root, ref);
  if ("error" in resolved) return { ok: false, error: resolved.error };
  const refSha = resolved.full;
  const mainBranch = await baseBranch(root);
  const mainSha = await headOf(root, mainBranch);

  if (await isMergedInto(root, refSha, mainBranch))
    return { ok: false, error: `nothing to land: ${shortSha(refSha)} is already on ${mainBranch}` };

  const base = (await gitTry(root, "merge-base", mainBranch, refSha)) ?? mainSha;
  const commits = await rangeCommits(root, base, refSha);
  if (commits.length === 0)
    return { ok: false, error: `nothing to land: ${shortSha(refSha)} adds no commits beyond ${mainBranch}` };

  const paths = await rangePaths(root, base, refSha);
  const stateRefusal = await tumwaterPathRefusal(paths);
  if (stateRefusal !== null) return { ok: false, error: stateRefusal };
  const mergeRefusal = await mergeCommitRefusal(root, commits);
  if (mergeRefusal !== null) return { ok: false, error: mergeRefusal };
  return { ok: true, refSha, mainBranch, mainSha, commits, paths };
}

/** Cherry-pick one commit from `srcRef` into the temp worktree, or null when it stops on a
 * conflict the caller must settle. GIT_EDITOR=true so a commit-message prompt can never block.
 * `merge.conflictStyle=diff3` is what makes the settled-hunk resolver able to read the hunk at
 * all — `resolveInsertOnlyText` parses the `|||||||` base section, which the default two-way
 * style never writes — and it is the same flag the team merge's rebase (merge-git.ts) and the
 * revision cherry-pick (runner-revision.ts) pass for the same reason. Without it the insert-only
 * pass settles nothing and the archive files (PLANS-DONE.md, BUGS-FIXED.md), which the
 * entry-by-entry merge deliberately declines, would refuse every top-of-section insert. */
async function pickIn(wt: string, srcRef: string): Promise<string | null> {
  try {
    await runGit(
      wt,
      [...(await committerIdentArgs(wt)), "-c", "merge.conflictStyle=diff3", "cherry-pick", srcRef],
      { GIT_EDITOR: "true" },
    );
    return await headOf(wt, "HEAD");
  } catch {
    return null; // a conflict (or a stop) the caller resolves and continues
  }
}

/** Stage a cherry-pick resolution and continue it, or null if the continue stops again. */
async function continueIn(wt: string): Promise<string | null> {
  try {
    await git(wt, "add", "-A");
    await runGit(wt, [...(await committerIdentArgs(wt)), "cherry-pick", "--continue"], { GIT_EDITOR: "true" });
    return await headOf(wt, "HEAD");
  } catch {
    return null;
  }
}

/** Replay `commits` (ref's divergent history, oldest first) onto main inside a detached worktree
 * checked out at main's head, cherry-picking each — leaving the operator's own branch untouched.
 * Insert-only backlog conflicts (PLANS.md / BUGS.md / QUESTIONS.md) are settled deterministically
 * and the cherry-pick continued; a conflict in any other file, or a range that will not settle,
 * aborts and refuses, naming the file, with main left exactly as it was. The operator's branch
 * is never touched: the replay builds a throwaway tip off main in the temp checkout. */
async function replayIn(wt: string, commits: SteerCommit[]): Promise<{ ok: true; tip: string } | { ok: false; error: string }> {
  // A range that re-conflicts every pass must not spin the command: each commit gets a small
  // bound of resolve-continue attempts (a real insert-only conflict settles in one), and an
  // exhausted bound aborts with a refusal, leaving main unchanged.
  const MAX_RESOLVE_ATTEMPTS = 8;
  let tip = await headOf(wt, "HEAD");
  for (let i = 0; i < commits.length; i++) {
    let step = await pickIn(wt, commits[i]!.sha);
    let attempts = 0;
    // A conflict stops the pick; settle backlog insert-only hunks and continue until it clears.
    while (step === null && attempts < MAX_RESOLVE_ATTEMPTS) {
      attempts++;
      const files = await conflictedFiles(wt);
      const remaining = await resolveBacklogInsertConflicts(wt, files);
      if (remaining.length > 0) {
        return { ok: false, error: `the replay would conflict in a code file and was refused: ${remaining.join(", ")}` };
      }
      step = await continueIn(wt);
      if (step === null && (await conflictedFiles(wt)).length === 0) {
        // The cherry-pick resolved to no unique content and was skipped by git.
        step = await headOf(wt, "HEAD");
        break;
      }
    }
    if (step === null) {
      return { ok: false, error: `the replay of ${shortSha(commits[i]!.sha)} stopped on a conflict that could not be settled; it was aborted and main was left unchanged` };
    }
    tip = step;
  }
  return { ok: true, tip };
}

/** The temp checkout the replay happens in: a detached worktree under .tumwater/worktrees, never
 * the operator's checkout and never the primary. The leading underscore keeps it clear of role
 * worktrees, matching _merge / _main. The preview gets its OWN path: a `--dry-run` runs outside
 * the merge lock, so sharing one dir with a land in flight would let the preview's ensure/reset
 * wipe a replay mid-cherry-pick (and its cleanup remove the worktree from under it). */
function steerWorktreePath(root: string, preview = false): string {
  return path.join(worktreesDir(root), preview ? "_steer-preview" : "_steer");
}

/** Move the operator's branch to the landed tip ONLY when it is checked out in no worktree — a
 * pure ref move (git branch -f) that touches no working tree. When it is checked out (the common
 * case: the operator ran land from a checkout of it), no branch is moved; the caller reports the
 * sha for the operator to reset to by hand. This is the safe reading of "point the operator's
 * branch at the landed tip only when it is checked out nowhere else": the only action that can
 * never clobber an operator's files is the one that moves a ref not checked out anywhere. */
async function repointBranch(root: string, ref: string, tip: string): Promise<string> {
  const branchSha = await gitTry(root, "rev-parse", "--verify", `refs/heads/${ref}`);
  if (branchSha === null) return `main is now ${shortSha(tip)} — \`${ref}\` is not a local branch, so nothing else was moved`;
  const listed = await git(root, "worktree", "list", "--porcelain");
  const checkouts = listed.split("\n").filter((line) => line === `branch refs/heads/${ref}`).length;
  if (checkouts === 0 && (await gitTry(root, "branch", "-f", ref, tip)) !== null) {
    return `main is now ${shortSha(tip)}; the ${ref} branch was moved to it`;
  }
  return `main is now ${shortSha(tip)} — \`${ref}\` is checked out, so it was left in place; reset it with \`git reset --hard ${shortSha(tip)}\``;
}

/** `tumwater land [<ref>]`: fast-forward main to `ref` (or replay `ref`'s commits onto a moved
 * main) under the merge lock. Never throws; every refusal and git failure comes back as
 * `{ ok: false, error }` with main left as it was and the temp worktree removed. */
export async function steerToMain(root: string, ref = "HEAD"): Promise<SteerOutcome | SteerError> {
  const range = await steerRange(root, ref);
  if (!range.ok) return range;
  const { refSha, mainBranch, mainSha, commits } = range;
  // The working-tree fast-forward inside the merge lock rewrites the primary checkout's files,
  // so a dirty primary would have its uncommitted work clobbered: refuse up front, before any
  // lock is taken, with a reason the operator can act on rather than a confusing merge failure.
  if (await isDirty(root))
    return { ok: false, error: `your checkout has uncommitted changes; commit or stash them, then land again (a land fast-forwards main in your checkout, which would lose them)` };

  const beforeSha = await headOf(root, mainBranch);
  // main is an ancestor of ref: a plain fast-forward is the whole job.
  if (await isMergedInto(root, mainSha, refSha)) {
    const ff = await withLock(mergeLockDir(root), async () => ffMainToOrWhy(root, refSha, mainBranch), MERGE_LOCK_WAIT_MS);
    if (ff !== null) return { ok: false, error: `could not fast-forward ${mainBranch} to ${shortSha(refSha)}: ${ff}` };
    return { ok: true, beforeSha, headSha: await headOf(root, mainBranch), replayed: false, commits, refNote: await repointBranch(root, ref, await headOf(root, mainBranch)) };
  }

  // main moved past ref's base: replay ref's commits onto a moved main in a detached temp
  // worktree, then fast-forward main to the replayed tip. The merge lock is held for the whole
  // replay, so no team merge moves main between the replay and the fast-forward.
  const wt = steerWorktreePath(root);
  try {
    return await withLock(mergeLockDir(root), async () => {
      // Check the temp worktree out at main's current head (read under the lock, so it is the
      // main ffMainToOrWhy will move) and replay the range onto it: the tip then descends from
      // main, so the final fast-forward to the tip always succeeds.
      const liveMain = await headOf(root, mainBranch);
      await ensureDetachedWorktree(root, wt, liveMain);
      const replay = await replayIn(wt, commits);
      if (!replay.ok) return { ok: false, error: replay.error };
      const ff = await ffMainToOrWhy(root, replay.tip, mainBranch);
      if (ff !== null) return { ok: false, error: `the replay applied, but fast-forwarding ${mainBranch} to it failed: ${ff}` };
      const headSha = await headOf(root, mainBranch);
      return { ok: true, beforeSha, headSha, replayed: true, commits, refNote: await repointBranch(root, ref, headSha) };
    }, MERGE_LOCK_WAIT_MS);
  } finally {
    await removeWorktreeDir(root, wt);
  }
}

/** `tumwater land [<ref>] --dry-run`: what a land would do, writing nothing. `replay` is false
 * (a plain fast-forward) when main is an ancestor of ref; `applies` then always holds, or else it
 * is decided by attempting the replay in a throwaway temp worktree that is removed before the
 * result is returned, so main's sha and the worktree list are both unchanged when it returns. */
export async function previewSteer(root: string, ref = "HEAD"): Promise<SteerPreview | SteerError> {
  const range = await steerRange(root, ref);
  if (!range.ok) return range;
  const { refSha, mainSha, commits, paths } = range;

  if (await isMergedInto(root, mainSha, refSha))
    return { ok: true, beforeSha: mainSha, commits, paths, replay: false, applies: true };

  // Diverged: decide "would it apply" in a throwaway worktree, removed before returning.
  const wt = steerWorktreePath(root, true);
  let applies = false;
  try {
    await ensureDetachedWorktree(root, wt, mainSha);
    const replay = await replayIn(wt, commits);
    applies = replay.ok;
  } catch {
    applies = false; // a git failure deciding the preview is a "would not apply"
  } finally {
    await removeWorktreeDir(root, wt);
  }
  return { ok: true, beforeSha: mainSha, commits, paths, replay: true, applies };
}


