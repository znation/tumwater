import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { branchName, worktreePath } from "./paths.js";

const execFileAsync = promisify(execFile);

/** Identity used for harness-authored commits so ticks work without global git config. */
export const COMMIT_IDENT = [
  "-c",
  "user.name=tumwater",
  "-c",
  "user.email=tumwater@localhost",
];

class GitError extends Error {
  constructor(
    public args: string[],
    public stderr: string,
    public code: number | undefined,
  ) {
    super(`git ${args.join(" ")} failed (${code}): ${stderr.trim()}`);
  }
}

/** The one error every entry point that shells out to git reports when the binary itself is
 * missing from PATH. Without a preflight check, `isGitRepo`'s failed probe reads as "not a
 * git repository (run `git init` first)" — pointing at the wrong fix for a machine with no
 * git installed. Shared by cli.ts and init.ts so their messages cannot drift. */
export const GIT_MISSING_MESSAGE =
  "git not found on PATH — install git first, or add its bin directory to your PATH";

/** Run git in `cwd`, throwing GitError on nonzero exit. Returns trimmed stdout. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  return runGit(cwd, args);
}

/** Like git(), with extra environment variables (e.g. GIT_EDITOR for rebase --continue). */
async function runGit(
  cwd: string,
  args: string[],
  extraEnv?: NodeJS.ProcessEnv,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
      ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
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
    return await runGit(cwd, args);
  } catch {
    return null;
  }
}

/** A valid object id (SHA-1 or SHA-256). */
function isSha(s: string): boolean {
  return /^[0-9a-f]{40,64}$/.test(s);
}

/** The commit a branch points to, read straight from the ref files without spawning git —
 * the loose ref `<gitdir>/refs/heads/<branch>` first (it wins over packed refs in git too),
 * then an exact line match in `<gitdir>/packed-refs`. Git writes both atomically (temp file
 * + rename), so a read sees either the old or the new value, never a torn one. Returns null
 * when the ref cannot be resolved from files — no repo here, `.git` is a worktree pointer
 * file, the branch does not exist, or content fails validation — so callers can fall back to
 * `git rev-parse`. Synchronous and microsecond-scale: this exists for poll loops that would
 * otherwise pay a ~10ms subprocess spawn per tick just to watch main. */
export function readBranchHead(root: string, branch: string): string | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(path.join(root, ".git"));
  } catch {
    return null; // Not a repo (or .git missing).
  }
  if (!st.isDirectory()) return null; // Worktree pointer file — the spawn fallback knows better.

  try {
    const sha = fs.readFileSync(path.join(root, ".git", "refs", "heads", branch), "utf8").trim();
    if (isSha(sha)) return sha;
  } catch {
    // No loose ref (or unreadable) — packed refs next.
  }

  let packed: string;
  try {
    packed = fs.readFileSync(path.join(root, ".git", "packed-refs"), "utf8");
  } catch {
    return null; // Neither store has it: the branch does not exist (or no repo state).
  }
  const suffix = ` refs/heads/${branch}`;
  for (const line of packed.split("\n")) {
    if (!line.endsWith(suffix)) continue; // Skips comments, peel lines, and other refs.
    const sha = line.slice(0, -suffix.length);
    if (isSha(sha)) return sha;
  }
  return null;
}

export async function isGitRepo(dir: string): Promise<boolean> {
  return (await gitTry(dir, "rev-parse", "--git-dir")) !== null;
}

/** True if the repo has at least one commit. */
export async function hasCommits(root: string): Promise<boolean> {
  return (await gitTry(root, "rev-parse", "--verify", "HEAD")) !== null;
}

/** The commit that `ref` points to in `cwd`. */
export async function headOf(cwd: string, ref: string): Promise<string> {
  return git(cwd, "rev-parse", "--verify", ref);
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

/** Decode a path from `git status --porcelain` output. Git C-quotes paths containing special
 * characters (newlines, tabs, quotes, non-ASCII under core.quotePath) and escapes them — the
 * decoded form is what callers pass back to git as a real path. Unquoted paths pass through. */
function unquotePorcelainPath(p: string): string {
  if (!p.startsWith('"')) return p;
  const end = p.lastIndexOf('"');
  if (end < 1) return p; // Malformed — keep as-is rather than drop the entry.
  let out = "";
  for (let i = 1; i < end; i++) {
    const c = p.charAt(i);
    if (c !== "\\") {
      out += c;
      continue;
    }
    i++;
    const e = p.charAt(i);
    switch (e) {
      case "n":
        out += "\n";
        break;
      case "t":
        out += "\t";
        break;
      case "r":
        out += "\r";
        break;
      case "\\":
        out += "\\";
        break;
      case '"':
        out += '"';
        break;
      default:
        // Octal escape \NNN (control characters); anything else is kept literally.
        if (e >= "0" && e <= "7") {
          const chunk = p.slice(i, i + 3);
          if (/^[0-7]{3}$/.test(chunk)) {
            out += String.fromCharCode(parseInt(chunk, 8));
            i += 2;
          } else {
            out += e;
          }
        } else {
          out += e;
        }
    }
  }
  return out;
}

/** Repo-relative paths of every change in the worktree — modified, untracked, and deleted,
 * parsed from `git status --porcelain` (paths only). The refusal path uses this to classify
 * what a refusing run left behind: markdown notes may land, everything else is discarded. */
export async function changedFiles(wt: string): Promise<string[]> {
  const out = await gitTry(wt, "status", "--porcelain");
  if (!out) return [];
  const files: string[] = [];
  for (const line of out.split("\n")) {
    // Porcelain v1 lines are `XY <path>` — two status chars, a space, then the path.
    if (line.length < 4) continue;
    const p = unquotePorcelainPath(line.slice(3));
    if (p) files.push(p);
  }
  return files;
}

/** Stage ONLY the given repo-relative paths, commit them with `message`, then discard every
 * other change in the worktree — tracked edits via reset --hard HEAD (the committed content is
 * safe at HEAD by the time the reset runs) and untracked files via clean -fd. Returns the new
 * commit hash, or null when nothing was stageable under those paths (the caller then decides
 * what to do with the rest). The refusal path uses this so a refusing run's objection note
 * lands while its half-done code work does not. */
export async function commitPathsAndDiscardRest(
  wt: string,
  message: string,
  paths: string[],
): Promise<string | null> {
  if (paths.length === 0) return null;
  const added = await gitTry(wt, "add", "--", ...paths);
  if (added === null) return null; // Pathspec matched nothing — treat as nothing stageable.
  const staged = await gitTry(wt, "diff", "--cached", "--name-only");
  if (!staged) return null; // Nothing actually changed under those paths.
  await git(wt, ...COMMIT_IDENT, "commit", "-m", message);
  await git(wt, "reset", "--hard", "HEAD");
  await git(wt, "clean", "-fd");
  return headOf(wt, "HEAD");
}

/** Ensure a persistent worktree + branch exists for a role. Returns the worktree path.
 * Self-heals when the directory exists but is no longer a usable worktree (its .git pointer
 * file lost, or its admin-side registration under <root>/.git/worktrees/ pruned by outside
 * git maintenance): it removes and re-adds the directory instead of failing every tick. */
export async function ensureWorktree(root: string, role: string, mainBranch: string): Promise<string> {
  const wt = worktreePath(root, role);
  const branch = branchName(role);
  if (fs.existsSync(wt) && (await gitTry(wt, "rev-parse", "--git-dir")) !== null) {
    return wt;
  }
  // A stale registration (dir deleted, worktree still known) blocks `worktree add`.
  await gitTry(root, "worktree", "prune");
  if (fs.existsSync(wt)) {
    // The directory exists but is not a usable worktree. Left alone, `worktree add` would
    // fail on it every tick forever and wedge the role. It holds only harness scratch — a
    // fresh tick resets it to main anyway — so remove and re-add; the branch's commits
    // survive in refs/heads either way.
    fs.rmSync(wt, { recursive: true, force: true });
    await gitTry(root, "worktree", "prune"); // drop any registration left pointing at it
  }
  const branchExists = (await gitTry(root, "rev-parse", "--verify", `refs/heads/${branch}`)) !== null;
  if (branchExists) {
    await git(root, "worktree", "add", wt, branch);
  } else {
    await git(root, "worktree", "add", "-b", branch, wt, mainBranch);
  }
  return wt;
}

/** True when no merge and no rebase is in progress in `wt`, checked from the state files
 * git itself leaves behind — MERGE_HEAD for a merge, rebase-merge/ or rebase-apply/ for a
 * rebase — instead of spawning two aborts that can only fail. Returns false ("run the
 * aborts anyway") whenever either is running OR the gitdir cannot be resolved from files:
 * false is always safe, it just means "do exactly what the old spawn-based check did".
 * Synchronous and microsecond-scale: this exists because abortSync runs on every fresh tick
 * and the common case used to cost two ~10ms subprocess spawns that were guaranteed no-ops. */
function syncStateClear(wt: string): boolean {
  const dotGit = path.join(wt, ".git");
  let gitdir: string;
  try {
    if (fs.statSync(dotGit).isDirectory()) {
      gitdir = dotGit; // Primary checkout.
    } else {
      // Linked worktree: `.git` is a one-line pointer file (`gitdir: <path>`).
      const line = fs.readFileSync(dotGit, "utf8").trim();
      if (!line.startsWith("gitdir:")) return false;
      const target = line.slice("gitdir:".length).trim();
      if (!target) return false; // Malformed pointer: uncertain.
      gitdir = path.resolve(wt, target);
    }
  } catch {
    return false; // Not a repo we can inspect — fall back to the spawns.
  }
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

/** Commits ahead of main on the worktree's branch. */
export async function aheadOfMain(wt: string, mainBranch: string): Promise<number> {
  const out = await git(wt, "rev-list", "--count", `${mainBranch}..HEAD`);
  return parseInt(out, 10);
}

/** Repo-relative paths changed between the branch's fork point from main and its HEAD —
 * everything a merge of this branch would land (the three-dot range diffs against the
 * merge-base, so commits main gained during the tick are not included). */
export async function aheadOfMainFiles(wt: string, mainBranch: string): Promise<string[]> {
  const out = await gitTry(wt, "diff", "--name-only", `${mainBranch}...HEAD`);
  return out ? out.split("\n").filter(Boolean) : [];
}

/** The combined ahead-of-main diff — everything a merge of this branch would land. Capped:
 * over `maxBytes`, the result is a truncation note plus `--stat` and the largest files' full
 * diffs (an oversized diff is itself reviewable information, and the reviewer can read any
 * file in the worktree directly). */
export async function aheadOfMainDiff(
  wt: string,
  mainBranch: string,
  maxBytes = 200_000,
): Promise<string> {
  const range = `${mainBranch}...HEAD`;
  const full = (await gitTry(wt, "diff", range)) ?? "";
  if (full.length <= maxBytes) return full;
  // Over the cap: rank files by change size and include the largest while budget allows.
  const numstat = (await gitTry(wt, "diff", "--numstat", range)) ?? "";
  const sizes = new Map<string, number>();
  for (const line of numstat.split("\n")) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m?.[1] || !m?.[2] || !m?.[3]) continue;
    // All three capture groups are required by the regex, so they exist when it matched.
    const added = m[1] === "-" ? 0 : parseInt(m[1], 10);
    const deleted = m[2] === "-" ? 0 : parseInt(m[2], 10);
    sizes.set(m[3], added + deleted);
  }
  const files = [...sizes.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
  let out =
    `[diff truncated: the full ahead-of-main diff is ${full.length} bytes; ` +
    `showing --stat plus the largest files]\n\n` + ((await gitTry(wt, "diff", "--stat", range)) ?? "") + "\n";
  for (const f of files) {
    const d = (await gitTry(wt, "diff", range, "--", f)) ?? "";
    if (!d) continue;
    if (out.length + d.length > maxBytes) break;
    out += `\n${d}\n`;
  }
  return out;
}

/** Stage and commit everything in the worktree. Returns the new commit hash. */
export async function commitAll(wt: string, message: string): Promise<string> {
  await git(wt, "add", "-A");
  await git(wt, ...COMMIT_IDENT, "commit", "-m", message);
  return headOf(wt, "HEAD");
}

/** Paths currently in conflict (unmerged) in the worktree. */
export async function conflictedFiles(wt: string): Promise<string[]> {
  const out = await gitTry(wt, "diff", "--name-only", "--diff-filter=U");
  return out ? out.split("\n").filter(Boolean) : [];
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
