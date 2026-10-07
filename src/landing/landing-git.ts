import fs from "node:fs";
import path from "node:path";
import { COMMIT_IDENT, git, gitTry, runGit } from "../git/git-run.js";
import { currentBranch, gitLines, headOf } from "../git/git.js";
import { unquotePorcelainPath } from "../git/git-diff.js";
import { CONFIG_BASENAME, configPath } from "../paths.js";

/** Git plumbing for the landing flow: rebasing a worktree branch onto main, inspecting and
 * finishing a conflicted rebase, and fast-forwarding main — the mechanics, with no landing policy
 * of their own. Landing policy (lock → rebase → verify → ff, conflict resolution, batch ff) lives
 * in landing-merge.ts on top of these. Moved here from landing-merge.ts: the cluster started as
 * landing-merge.ts-only helpers (organize tick 78, moving them out of git/git.ts), but the lander
 * and the batch lander grew to call them directly, leaving landing-merge.ts exporting generic
 * rebase/ff plumbing that had nothing to do with merging. */

/** Paths currently in conflict (unmerged) in the worktree. C-quoted names are decoded to
 * real paths — a non-ASCII conflicted file arrives as `"h\303\251llo.ts"` (core.quotePath is on
 * by default), and undecoded it does not exist on disk: hasConflictMarkers could never read
 * it, so an unresolved conflict in such a file passed the marker check and continueRebase
 * committed its markers to main. */
export async function conflictedFiles(wt: string): Promise<string[]> {
  const out = await gitTry(wt, "diff", "--name-only", "--diff-filter=U");
  return gitLines(out).map(unquotePorcelainPath);
}

/** One commit on main that touched a conflicted file, as the conflict resolver's context. */
interface MainCommitIntent {
  sha: string;
  subject: string;
  body: string;
}

/** How many main commits the resolver prompt lists, and how many body lines it keeps per
 * commit: enough to explain a deliberate removal without filling the window. */
const MAX_INTENT_COMMITS = 15;
const MAX_INTENT_BODY_LINES = 20;

function capIntentBody(body: string): string {
  const lines = body.split("\n");
  if (lines.length <= MAX_INTENT_BODY_LINES) return body;
  const kept = lines.slice(0, MAX_INTENT_BODY_LINES).join("\n");
  return `${kept}\n… (${lines.length - MAX_INTENT_BODY_LINES} more lines)`;
}

/** The commits on `mainBranch` since `since` (the change's merge-base with main) that touched
 * any of `files`, newest first. resolveConflict threads this into the resolver prompt so pi
 * reads what main deliberately changed instead of guessing from the markers. The list is
 * capped at MAX_INTENT_COMMITS and each body at MAX_INTENT_BODY_LINES; `omitted` counts the
 * commits the cap dropped so the prompt can say so. An empty result is the normal case of a
 * fork point with no later main commits touching the files. */
export async function mainCommitsTouching(
  wt: string,
  since: string,
  mainBranch: string,
  files: string[],
): Promise<{ commits: MainCommitIntent[]; omitted: number }> {
  if (files.length === 0) return { commits: [], omitted: 0 };
  const out = await gitTry(
    wt,
    "log",
    "--format=%h%x1f%s%x1f%b%x1e",
    `${since}..${mainBranch}`,
    "--",
    ...files,
  );
  const parsed = (out ?? "")
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha = "", subject = "", ...rest] = record.split("\x1f");
      return { sha, subject, body: capIntentBody(rest.join("\x1f").trim()) };
    });
  return {
    commits: parsed.slice(0, MAX_INTENT_COMMITS),
    omitted: Math.max(0, parsed.length - MAX_INTENT_COMMITS),
  };
}

/** Attempt to rebase the worktree branch onto main and classify the outcome WITHOUT
 * cleaning up: "rebased" (including already up to date), "conflict" (the rebase stopped on
 * unmerged paths, which remain in the worktree for a resolver), or "other" (any other
 * failure). Shared by the two rebase wrappers below, which differ only in cleanup policy.
 * Rebase — not merge — keeps main's history linear: each tick lands as its own commit on top
 * of whatever main holds. */
async function attemptRebase(
  wt: string,
  mainBranch: string,
): Promise<"rebased" | "conflict" | "other"> {
  try {
    // The -c ident is needed for the rewritten committer identity.
    await runGit(wt, [...COMMIT_IDENT, "rebase", mainBranch]);
    return "rebased";
  } catch {
    return (await conflictedFiles(wt)).length > 0 ? "conflict" : "other";
  }
}

/** Rebase the worktree branch onto main (main may have advanced during the tick).
 * Returns false and aborts the rebase on conflict. */
export async function rebaseOntoMain(wt: string, mainBranch: string): Promise<boolean> {
  const state = await attemptRebase(wt, mainBranch);
  if (state !== "rebased") await gitTry(wt, "rebase", "--abort");
  return state === "rebased";
}

/** Rebase the worktree branch onto main, leaving conflict markers in place for a
 * resolver to work on. "clean" = rebased (or already up to date); "conflict" = the rebase
 * stopped on conflicts and the worktree holds them mid-rebase; "failed" = anything else
 * (aborted and cleaned up). */
export async function rebaseOntoMainLeaveConflicts(
  wt: string,
  mainBranch: string,
): Promise<"clean" | "conflict" | "failed"> {
  const state = await attemptRebase(wt, mainBranch);
  if (state === "other") await gitTry(wt, "rebase", "--abort");
  return state === "rebased" ? "clean" : state === "conflict" ? "conflict" : "failed";
}

/** True if any of the given files still contains a git conflict marker.
 * A deleted file counts as resolved (the resolver chose the deletion). */
export function hasConflictMarkers(wt: string, files: string[]): boolean {
  // Only start/end markers are checked: every real conflict block carries them, while a bare
  // `=======` line is legitimate content (a markdown setext or RST underline of exactly seven
  // characters), and flagging it would reject clean resolutions forever. A resolver that
  // leaves only a separator line behind is treated as resolved; its stray line is content the
  // project's own tests can catch.
  const marker = /^(<{7}|>{7})( |$)/m;
  return files.some((f) => {
    const p = path.join(wt, f);
    try {
      return marker.test(fs.readFileSync(p, "utf8"));
    } catch {
      return false;
    }
  });
}

/** Conclude an in-progress rebase with everything in the worktree as the resolution.
 * GIT_EDITOR=true so `rebase --continue` can never block on a commit-message prompt. A
 * resolution that leaves no unique content (the branch's change was fully superseded by
 * main) is skipped automatically by git, finishing the rebase cleanly. Throws when the
 * rebase stops again — e.g. on a second conflict from an extra commit pi authored during
 * the tick; the caller aborts and reports merge_conflict. */
export async function continueRebase(wt: string): Promise<string> {
  await git(wt, "add", "-A");
  await runGit(wt, [...COMMIT_IDENT, "rebase", "--continue"], { GIT_EDITOR: "true" });
  return headOf(wt, "HEAD");
}

/** The live config's bytes, when the landing about to fast-forward `ref` would delete it
 * (plans/portability.md §4b/7): the config file exists, is tracked in the current index (and
 * HEAD — a staged-or-dirty config makes `git merge --ff-only` refuse below, so the two agree
 * on every merge that can succeed), and is absent from the incoming tree. Anything else —
 * already untracked, already absent, present in `ref` — needs no preserve step. */
export async function configBytesToPreserve(root: string, ref: string): Promise<Buffer | null> {
  const cfg = configPath(root);
  if (!fs.existsSync(cfg)) return null;
  if ((await gitTry(root, "ls-files", "--error-unmatch", CONFIG_BASENAME)) === null) return null;
  if ((await gitTry(root, "cat-file", "-e", `${ref}:${CONFIG_BASENAME}`)) !== null) return null;
  return fs.readFileSync(cfg);
}

/** The preserve step's write-back, restore-only-when-absent: write the saved bytes only when
 * the live config is absent at write-back time. The merge deletes the file mid-window, so a
 * config request applied in that window (3/7's applyConfigRequest runs outside the merge lock)
 * recreates it — the newer bytes win (latest instruction wins), which also makes the step
 * idempotent. Called only after a successful merge: a refused merge leaves the file untouched. */
export function restoreConfigBytes(root: string, saved: Buffer | null): void {
  if (!saved) return;
  const cfg = configPath(root);
  if (fs.existsSync(cfg)) return;
  fs.writeFileSync(cfg, saved);
}

/** Fast-forward main to `ref`, without touching any remote. Callers pass the worktree's
 * post-rebase HEAD — a bare sha, which both arms accept (`merge --ff-only <sha>` and
 * `push . <sha>:<main>`). Uses a working-tree merge when the primary checkout is on main (so its
 * files update), otherwise a local ref push. Returns true on success. The working-tree arm
 * preserves the live config across a landing that untracks it (plans/portability.md §4b/7):
 * without the write-back, the commit that removes the tracked config would delete the fleet's
 * running config out from under it and the next config poll would fall back to defaults. */
export async function ffMainTo(root: string, ref: string, mainBranch: string): Promise<boolean> {
  const primaryBranch = await currentBranch(root);
  if (primaryBranch === mainBranch) {
    const saved = await configBytesToPreserve(root, ref);
    if ((await gitTry(root, "merge", "--ff-only", ref)) === null) return false;
    restoreConfigBytes(root, saved);
    return true;
  }
  return (await gitTry(root, "push", ".", `${ref}:${mainBranch}`)) !== null;
}
