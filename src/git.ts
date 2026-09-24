import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

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
    /** The failure's cause text: git's stderr when it printed any, otherwise the underlying
     * spawn error's message — a binary that cannot be started prints no stderr at all. */
    public stderr: string,
    /** git's exit code (a number) — or a spawn errno like "ENOENT" (a string) when the
     * binary itself could not be started, which is what execFile puts in `err.code` then. */
    public code: number | string | undefined,
  ) {
    super(
      `git ${args.join(" ")} failed${code !== undefined ? ` (${code})` : ""}${stderr ? `: ${stderr}` : ""}`,
    );
  }
}

/** The one error every entry point that shells out to git reports when the binary itself is
 * missing from PATH. Without a preflight check, `isGitRepo`'s failed probe reads as "not a
 * git repository (run `git init` first)" — pointing at the wrong fix for a machine with no
 * git installed. Shared by cli.ts and init.ts so their messages cannot drift. */
export const GIT_MISSING_MESSAGE =
  "git not found on PATH — install git first, or add its bin directory to your PATH";

/** Run git in `cwd`, throwing GitError on a nonzero exit or when the binary cannot be
 * started at all (the error then names the spawn failure, since git prints no stderr). */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  return runGit(cwd, args);
}

/** Like git(), with extra environment variables (e.g. GIT_EDITOR for rebase --continue, which
 * the landing flow in merge.ts needs so `rebase --continue` can never block on a commit-message
 * prompt; and the harness ident for rewritten committer identity). */
export async function runGit(
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
    // execFile sets a numeric exit code on nonzero exits but a string errno ("ENOENT") when
    // the binary cannot be spawned at all — both reach here, so code is number | string.
    const e = err as { stderr?: string; code?: number | string };
    // git prints no stderr in two cases: a spawn failure (then the underlying message names
    // it — "spawn git ENOENT") and a silent nonzero exit (`git diff --quiet`), where the exit
    // code alone is the story. Fall back to the underlying message only for the first, so a
    // GitError always says why when there is a why to say instead of ending in ": " —
    // `e.stderr ?? …` would not help: on spawn failure stderr is an empty string, and
    // `"" ?? x` keeps the empty string.
    const detail = e.stderr?.trim() || (typeof e.code === "string" && err instanceof Error ? err.message : "");
    throw new GitError(args, detail, e.code);
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

/** Resolve a branch's head without paying for a spawn when the ref files suffice:
 * readBranchHead (microsecond-scale) first, then `git rev-parse` as the fallback that covers
 * what file reads cannot (a worktree-pointer .git, anything unusual). Returns null when
 * neither resolves it. Shared by the orchestrator's per-poll main watch and each tick's
 * end-of-tick head update, so the file-first/spawn-fallback strategy lives in one place. */
export async function branchHead(root: string, branch: string): Promise<string | null> {
  return readBranchHead(root, branch) ?? (await gitTry(root, "rev-parse", branch));
}

/** True when `dir` is inside a git repository — its `rev-parse --git-dir` probe succeeds. */
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

/** Point `ref` at `sha`, creating the ref if needed (git update-ref). The landing pin of
 * plans/merge-queue.md invariant 4 uses this to keep a committed sha reachable across the role
 * branch's reset-to-main. Returns false instead of throwing when git fails — the caller then
 * keeps the commit on its branch (no reset) so leftover recovery can still reach it. */
export async function setRef(root: string, ref: string, sha: string): Promise<boolean> {
  return (await gitTry(root, "update-ref", ref, sha)) !== null;
}

/** Delete `ref`; a no-op when it is already gone (idempotent cleanup on terminal outcomes). */
export async function deleteRef(root: string, ref: string): Promise<void> {
  await gitTry(root, "update-ref", "-d", ref);
}

/** The sha `ref` names, or null when the ref is absent. */
export async function refSha(root: string, ref: string): Promise<string | null> {
  return gitTry(root, "rev-parse", "--verify", ref);
}

/** True when `sha` is already contained in `branch` (git merge-base --is-ancestor; equality
 * counts as contained). The leftover-recovery entry condition uses this to tell a stale pin —
 * landed but not yet un-pinned by a crash between the ff and the ref deletion — from real work. */
export async function isMergedInto(root: string, sha: string, branch: string): Promise<boolean> {
  return (await gitTry(root, "merge-base", "--is-ancestor", sha, branch)) !== null;
}

/** The repository's top-level working directory, or null when `dir` is not inside a git
 * repository (the probe fails). Resolving the root from the cwd's toplevel — never trusting
 * process.cwd() — is what lets every command behave identically from any subdirectory of the
 * repo it targets: .tumwater/ and tumwater.json live at the toplevel, and readBranchHead's
 * file fast path only works when the root actually holds `.git`. */
export async function repoToplevel(dir: string): Promise<string | null> {
  return gitTry(dir, "rev-parse", "--show-toplevel");
}

/** True when the local branch `<branch>` exists in the repo. */
export async function branchExists(root: string, branch: string): Promise<boolean> {
  return (await gitTry(root, "rev-parse", "--verify", `refs/heads/${branch}`)) !== null;
}

/** The non-empty lines of a completed git command's stdout — the shape every
 * porcelain/log/list parser starts from. Null output (a failed run) yields no lines. */
export function gitLines(out: string | null): string[] {
  return out ? out.split("\n").filter(Boolean) : [];
}

/** The repo's local branch names — what an error message lists when a named branch does not
 * exist, so the fix is visible in the failure itself. Empty when the repo has no branches. */
export async function listBranches(root: string): Promise<string[]> {
  return gitLines(await gitTry(root, "for-each-ref", "--format=%(refname:short)", "refs/heads"));
}

/** The git directory backing `dir`'s checkout, resolved from files without spawning git:
 * a `.git` directory (primary checkout) or the target of a `gitdir: <path>` pointer file (a
 * linked worktree — the harness itself can run from one, as its own role worktrees do).
 * undefined when .git is missing, unreadable, or carries a malformed pointer — callers fall
 * back to whatever a spawned git command would decide. */
export function resolveGitDir(dir: string): string | undefined {
  const dotGit = path.join(dir, ".git");
  try {
    if (fs.statSync(dotGit).isDirectory()) return dotGit; // Primary checkout.
    // Linked worktree: `.git` is a one-line pointer file (`gitdir: <path>`).
    const line = fs.readFileSync(dotGit, "utf8").trim();
    if (!line.startsWith("gitdir:")) return undefined;
    const target = line.slice("gitdir:".length).trim();
    if (!target) return undefined; // Malformed pointer: uncertain.
    return path.resolve(dir, target);
  } catch {
    return undefined; // No repo here (or .git unreadable) — let the spawn decide.
  }
}

/** The branch `dir`'s checkout has, read from its HEAD file without spawning git: undefined
 * (not null) when the files cannot answer and the `git symbolic-ref` fallback should decide.
 * A `.git` directory (primary checkout) or a `gitdir: <path>` pointer file (a linked worktree —
 * the harness itself can run from one, as its own role worktrees do) both resolve. The HEAD
 * line must be `ref: refs/heads/<branch>`; a bare sha means detached HEAD — the same null the
 * spawn produces, since symbolic-ref fails on it — and anything else is unusual (undefined). */
function currentBranchFromHeadFile(dir: string): string | null | undefined {
  const gitdir = resolveGitDir(dir);
  if (gitdir === undefined) return undefined; // No repo here (or .git unreadable) — let the spawn decide.
  let head: string;
  try {
    head = fs.readFileSync(path.join(gitdir, "HEAD"), "utf8").trim();
  } catch {
    return undefined; // HEAD unreadable — let the spawn decide.
  }
  const prefix = "ref: refs/heads/";
  if (!head.startsWith(prefix)) return isSha(head) ? null : undefined; // Detached, or unusual.
  const branch = head.slice(prefix.length).trim();
  return branch !== "" ? branch : undefined;
}

/** The branch the primary checkout has, or null when detached. Reads the checkout's HEAD file
 * first (microsecond-scale) and spawns `git symbolic-ref` only when the file cannot resolve
 * the branch — no repo here, a HEAD that is neither a symref nor a plain sha, or a read error.
 * This runs on every orchestrator poll (the branch-divergence watch), which used to cost a
 * ~20ms subprocess spawn per poll just to learn what HEAD has said all along. */
export async function currentBranch(root: string): Promise<string | null> {
  const fromFile = currentBranchFromHeadFile(root);
  return fromFile !== undefined ? fromFile : await gitTry(root, "symbolic-ref", "--short", "HEAD");
}

/** True when the worktree has uncommitted changes of any kind (staged, modified, or
 * untracked) — anything `git status --porcelain` reports. */
export async function isDirty(cwd: string): Promise<boolean> {
  const out = await git(cwd, "status", "--porcelain");
  return out.length > 0;
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

/** Commit subjects landed on `mainBranch` since `sinceHead`, newest first — the range is
 * exclusive of its base, so a head that is an ancestor of main yields exactly what moved past
 * it (empty when nothing has). Null when the range cannot be resolved (unknown head, not a
 * repo), so callers fall back conservatively. */
export async function subjectsBetween(
  root: string,
  sinceHead: string,
  mainBranch: string,
): Promise<string[] | null> {
  const out = await gitTry(root, "log", "--format=%s", `${sinceHead}..${mainBranch}`);
  if (out === null) return null;
  return gitLines(out);
}

/** The full commit message (subject, body, trailer) of `sha`; null when it cannot be read. */
export async function commitMessage(cwd: string, sha: string): Promise<string | null> {
  return gitTry(cwd, "log", "-1", "--format=%B", sha);
}

/** Commits ahead of main on the worktree's branch. */
export async function aheadOfMain(wt: string, mainBranch: string): Promise<number> {
  const out = await git(wt, "rev-list", "--count", `${mainBranch}..HEAD`);
  return parseInt(out, 10);
}

/** The patch-id of the change `head` makes on top of `base`: `git diff` over `base...head` (from
 * their merge-base, the same range aheadOfMainDiff hands the reviewer) piped into
 * `git patch-id`. Two shas carrying the same diff — an approved head and its clean rebase onto
 * a moved main — share it, since patch-id ignores hunk line numbers; a rebase that changed any
 * line of the patch, context included, does not. `--verbatim` over `--stable`: `--stable` also
 * strips whitespace, so a whitespace-only difference would reuse an approval. `--binary` puts
 * binary content in the hash (without it every binary change reads "Binary files differ"), and
 * `--no-ext-diff --no-textconv` keep user diff config out of it. The raw stdout goes to
 * patch-id untrimmed: runGit's trimEnd would drop the last line's trailing whitespace. Null on
 * any failure or an empty diff (a git too old for `--verbatim` included), so a caller treats it
 * as "no match", never an error. */
export async function patchId(wt: string, base: string, head: string): Promise<string | null> {
  try {
    const { stdout: diff } = await execFileAsync(
      "git",
      ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--binary", `${base}...${head}`],
      { cwd: wt, maxBuffer: 32 * 1024 * 1024 },
    );
    if (diff === "") return null;
    const run = execFileAsync("git", ["patch-id", "--verbatim"], { cwd: wt });
    // A patch-id that dies before reading its input must not surface as an unhandled EPIPE.
    run.child.stdin?.on("error", () => {});
    run.child.stdin?.end(diff);
    const { stdout } = await run;
    return stdout.split(" ")[0]?.trim() || null;
  } catch {
    return null;
  }
}

/** Stage and commit everything in the worktree. Returns the new commit hash. */
export async function commitAll(wt: string, message: string): Promise<string> {
  await git(wt, "add", "-A");
  await git(wt, ...COMMIT_IDENT, "commit", "-m", message);
  return headOf(wt, "HEAD");
}
