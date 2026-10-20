import fs from "node:fs";
import path from "node:path";
import { committerIdentArgs, git, gitTry, runGit } from "../git/git-run.js";
import { readTextOrNull, writeBytesAtomic } from "../files/files.js";
import { currentBranch, gitLines, headOf } from "../git/git.js";
import { treeDiffFiles, unquotePorcelainPath } from "../git/git-diff.js";
import { CONFIG_BASENAME, configPath } from "../paths.js";
import { withPrimaryWorktreeLockAsync } from "../concurrency/lock.js";
import { errorFirstLine, errorMessage, joinWithMore } from "../text/text.js";

/** Git plumbing for the merge flow: rebasing a worktree branch onto main, inspecting and
 * finishing a conflicted rebase, and fast-forwarding main — the mechanics, with no merge policy
 * of their own. Merge policy (lock → rebase → verify → ff, conflict resolution, batch ff)
 * lives in merge-to-main.ts on top of these. Moved here from merge-to-main.ts: the cluster started
 * as merge-to-main.ts-only helpers (organize run 78, moving them out of git/git.ts), but the
 * merger and the batch merger grew to call them directly, leaving merge-to-main.ts exporting
 * generic rebase/ff plumbing that had nothing to do with merging. */

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
 * Rebase — not merge — keeps main's history linear: each run merges as its own commit on top
 * of whatever main holds. */
async function attemptRebase(
  wt: string,
  mainBranch: string,
): Promise<"rebased" | "conflict" | "other"> {
  try {
    // The -c ident is needed for the rewritten committer identity. diff3 carries the base
    // section of every conflict, which the deterministic backlog resolver reads
    // (plans/parallel-work-instances.md, part 3/7); rebaseOntoMain aborts on conflict, so the
    // marker style only matters to its leave-conflicts sibling.
    await runGit(wt, [...(await committerIdentArgs(wt)), "-c", "merge.conflictStyle=diff3", "rebase", mainBranch]);
    return "rebased";
  } catch {
    return (await conflictedFiles(wt)).length > 0 ? "conflict" : "other";
  }
}

/** Rebase the worktree branch onto main (main may have advanced during the run).
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

/** A conflict block's start or end marker line: seven `<` or `>`, then a space or the line's end.
 * The one marker definition hasConflictMarkers and conflictHunkRanges share, so the ranges a
 * conflict prompt names are exactly the blocks the marker check later rejects. */
const MARKER_EDGE = /^(<{7}|>{7})( |$)/m;

/** True if any of the given files still contains a git conflict marker.
 * A deleted file counts as resolved (the resolver chose the deletion). */
export function hasConflictMarkers(wt: string, files: string[]): boolean {
  // Only start/end markers are checked: every real conflict block carries them, while a bare
  // `=======` line is legitimate content (a markdown setext or RST underline of exactly seven
  // characters), and flagging it would reject clean resolutions forever. A resolver that
  // leaves only a separator line behind is treated as resolved; its stray line is content the
  // project's own tests can catch.
  return files.some((f) => {
    const text = readTextOrNull(path.join(wt, f));
    return text !== null && MARKER_EDGE.test(text);
  });
}

/** How many conflict hunks a conflict prompt lists per file: every hunk of a typical backlog or
 * code conflict, and a bound on a file pasted over wholesale. */
export const MAX_LISTED_HUNKS = 10;

/** A conflicted file as the conflict prompts list it: its repo-relative path, the 1-based
 * inclusive line ranges of its first MAX_LISTED_HUNKS conflict hunks, and how many more hunks
 * the cap left out. */
export interface ConflictedFile {
  path: string;
  hunks: Array<{ start: number; end: number }>;
  more: number;
}

/** The 1-based inclusive line ranges of the conflict hunks in `text`, each from a start marker
 * line through the next end marker line. Markers are matched by line prefix alone, so a hunk
 * inside a markdown code fence counts too: git writes its markers wherever the conflict falls.
 * A second start marker inside an open hunk stays part of it, and an unterminated hunk runs to
 * the last line. */
export function conflictHunkRanges(text: string): Array<{ start: number; end: number }> {
  const lines = text.split("\n");
  const ranges: Array<{ start: number; end: number }> = [];
  let start: number | undefined;
  lines.forEach((line, i) => {
    if (!MARKER_EDGE.test(line)) return;
    if (line.startsWith("<")) start ??= i + 1;
    else if (start !== undefined) {
      ranges.push({ start, end: i + 1 });
      start = undefined;
    }
  });
  const lastLine = text.endsWith("\n") ? lines.length - 1 : lines.length;
  if (start !== undefined) ranges.push({ start, end: lastLine });
  return ranges;
}

/** Each of `files` (repo-relative, under `wt`) with its conflict hunks' line ranges, for the
 * conflict prompts to name, so whoever resolves them reads the hunks instead of opening the file
 * from line 1. Over 2026-10-17..19 the merge's conflict resolvers spent 2.0M chars reading the
 * conflicted PLANS.md from its top, 16-47K chars a read because its lines are long. Any text
 * file counts, backlog or code; a deleted, unreadable or binary (NUL-bearing) file lists none. */
export function conflictedFileHunks(wt: string, files: readonly string[]): ConflictedFile[] {
  return files.map((f) => {
    // Deleted or unreadable reads as empty: no ranges to name.
    const text = readTextOrNull(path.join(wt, f)) ?? "";
    const all = text.includes("\0") ? [] : conflictHunkRanges(text);
    return { path: f, hunks: all.slice(0, MAX_LISTED_HUNKS), more: Math.max(0, all.length - MAX_LISTED_HUNKS) };
  });
}

/** The reason naming every changed file that still carries a conflict marker, or undefined when
 * none do — the one home of the wording, shared by the stage check's pre-queue finding
 * (stage-check.ts) and the review gate's hard rejection (review.ts), so the two surfaces cannot
 * name the same leftover marker differently. Committing or merge one would put raw `<<<<<<<`
 * lines on main (PLANS.md "Robust conflict landing, part 2/2"). Builds on hasConflictMarkers
 * above, the shared definition of what a marker is. */
export function conflictMarkerReason(wt: string, files: string[]): string | undefined {
  const marked = files.filter((f) => hasConflictMarkers(wt, [f]));
  return marked.length > 0 ? `conflict markers remain in: ${marked.join(", ")}` : undefined;
}

/** Conclude an in-progress rebase with everything in the worktree as the resolution.
 * GIT_EDITOR=true so `rebase --continue` can never block on a commit-message prompt. A
 * resolution that leaves no unique content (the branch's change was fully superseded by
 * main) is skipped automatically by git, finishing the rebase cleanly. Throws when the
 * rebase stops again — e.g. on a second conflict from a later commit the resolution run
 * added; the caller aborts and reports merge_conflict. */
export async function continueRebase(wt: string): Promise<string> {
  await git(wt, "add", "-A");
  await runGit(wt, [...(await committerIdentArgs(wt)), "rebase", "--continue"], { GIT_EDITOR: "true" });
  return headOf(wt, "HEAD");
}

/** The live config's bytes, when the merge about to fast-forward `ref` would delete it
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
 * idempotent. Called only after a successful merge: a refused merge leaves the file untouched.
 * Written through writeBytesAtomic (tmp+rename), like every other tumwater.json writer, so a
 * crash mid-write cannot leave the live config torn for the ~2 s config poll or the next
 * generation's startup load. */
export function restoreConfigBytes(root: string, saved: Buffer | null): void {
  if (!saved) return;
  const cfg = configPath(root);
  if (fs.existsSync(cfg)) return;
  writeBytesAtomic(cfg, saved);
}

/** Fast-forward main to `ref`, without touching any remote. Callers pass the worktree's
 * post-rebase HEAD — a bare sha, which both arms accept (`merge --ff-only <sha>` and
 * `push . <sha>:<main>`). Uses a working-tree merge when the primary checkout is on main (so its
 * files update), otherwise a local ref push. Returns true on success. The working-tree arm
 * preserves the live config across a merge that untracks it (plans/portability.md §4b/7):
 * without the write-back, the commit that removes the tracked config would delete the team's
 * running config out from under it and the next config poll would fall back to defaults. */
export async function ffMainToOrWhy(
  root: string,
  ref: string,
  mainBranch: string,
): Promise<string | null> {
  const primaryBranch = await currentBranch(root);
  if (primaryBranch === mainBranch) {
    // The working-tree arm rewrites the same tracked files the CLI backlog writers read and
    // rewrite, so it shares their primary-worktree lock (paths.ts): without it a `tumwater bug`
    // that read before this merge can rename its stale whole-file write over the merged change.
    // The ref-push arm below touches no working tree and needs no lock; the save/merge/restore
    // stays one short section, never held across a build re-check.
    return withPrimaryWorktreeLockAsync(root, async () => {
      const saved = await configBytesToPreserve(root, ref);
      try {
        await git(root, "merge", "--ff-only", ref);
      } catch (err) {
        return ffFailureReason(root, ref, mainBranch, err);
      }
      restoreConfigBytes(root, saved);
      return null;
    });
  }
  try {
    await git(root, "push", ".", `${ref}:${mainBranch}`);
    return null;
  } catch (err) {
    return ffFailureReason(root, ref, mainBranch, err);
  }
}

/** Why a fast-forward to `ref` failed: main having moved off `ref`'s base (a commit that did not
 * take the merge lock) is named with its new head and subject; a dirty primary checkout is
 * reported with the files it would overwrite; any other cause reports git's first error line. */
async function ffFailureReason(
  root: string,
  ref: string,
  mainBranch: string,
  err: unknown,
): Promise<string> {
  if ((await gitTry(root, "merge-base", "--is-ancestor", mainBranch, ref)) === null) {
    const now = await gitTry(root, "log", "-1", "--format=%h %s", mainBranch);
    return `main moved outside the merge lock (now ${now?.trim() ?? mainBranch})`;
  }
  const blockers = overwriteBlockers(errorMessage(err));
  if (blockers.uncommitted.length > 0 || blockers.untracked.length > 0) {
    return `fast-forward failed: ${overwriteBlockedReason(blockers)}`;
  }
  return `fast-forward failed: ${errorFirstLine(err)}`;
}

interface OverwriteBlockers {
  uncommitted: string[];
  untracked: string[];
}

/** The files git lists under its two "would be overwritten by merge:" headers. */
export function overwriteBlockers(gitError: string): OverwriteBlockers {
  const out: OverwriteBlockers = { uncommitted: [], untracked: [] };
  let group: string[] | null = null;
  for (const line of gitError.split("\n")) {
    if (line.includes("Your local changes to the following files would be overwritten by merge:")) {
      group = out.uncommitted;
    } else if (line.includes("untracked working tree files would be overwritten by merge:")) {
      group = out.untracked;
    } else if (group && line.startsWith("\t")) {
      group.push(line.trim());
    } else {
      group = null;
    }
  }
  return out;
}

const MAX_BLOCKERS_LISTED = 5;

/** Why a dirty primary checkout blocks a merge: up to 5 files per group. Callers prefix it with
 * their own stage (`fast-forward failed: `, or none from the pre-flight). */
export function overwriteBlockedReason(blockers: OverwriteBlockers): string {
  const list = (names: string[]): string => joinWithMore(names, MAX_BLOCKERS_LISTED);
  const groups: string[] = [];
  if (blockers.uncommitted.length > 0) groups.push(`uncommitted: ${list(blockers.uncommitted)}`);
  if (blockers.untracked.length > 0) groups.push(`untracked: ${list(blockers.untracked)}`);
  const where = `the primary checkout (${groups.join("; ")})`;
  return `the merge would overwrite files in ${where} — commit, stash or remove them there`;
}

/** The primary checkout's dirty paths a merge to `tip` would overwrite, read before any check
 * runs: null when the checkout is not on main (the ref push touches no working tree), when
 * nothing the merge changes is dirty, or when a git read fails — the fast-forward still decides. */
export async function primaryCheckoutBlockers(
  root: string,
  mainBranch: string,
  tip: string,
): Promise<OverwriteBlockers | null> {
  if ((await currentBranch(root)) !== mainBranch) return null;
  const changed = await treeDiffFiles(root, mainBranch, tip);
  const status = await gitTry(
    root, "--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all",
  );
  if (changed === null || status === null) return null;
  const untrackedSet = new Set<string>();
  const dirtySet = new Set<string>();
  const records = status.split("\0");
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!;
    if (rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    const file = rec.slice(3);
    if (xy === "??") {
      untrackedSet.add(file);
      continue;
    }
    dirtySet.add(file);
    if (xy.startsWith("R") || xy.startsWith("C")) {
      const source = records[++i];
      if (source) dirtySet.add(source);
    }
  }
  const out: OverwriteBlockers = {
    uncommitted: changed.filter((f) => dirtySet.has(f)),
    untracked: changed.filter((f) => untrackedSet.has(f)),
  };
  return out.uncommitted.length > 0 || out.untracked.length > 0 ? out : null;
}

/** Boolean form of ffMainToOrWhy for callers that need no reason. */
export async function ffMainTo(root: string, ref: string, mainBranch: string): Promise<boolean> {
  return (await ffMainToOrWhy(root, ref, mainBranch)) === null;
}
