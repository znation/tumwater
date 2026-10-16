import fs from "node:fs";
import path from "node:path";
import { COMMIT_IDENT, GIT_TIMEOUT_MS, execGitBounded, git, gitTry } from "./git-run.js";

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
 * neither resolves it. Shared by the orchestrator's per-poll main watch, each tick's
 * end-of-tick head update, the red-main baseline check, and the stack lander, so the
 * file-first/spawn-fallback strategy lives in one place. */
export async function branchHead(root: string, branch: string): Promise<string | null> {
  return readBranchHead(root, branch) ?? (await gitTry(root, "rev-parse", branch));
}

// ── Ref reads from files ───────────────────────────────────────────────────────────────────
// The read-only probes below (isGitRepo, hasCommits, headOf, refSha, branchExists) each used to
// spawn a `git rev-parse`. The harness asks them constantly: a landing alone re-reads HEAD a
// dozen times, and the test suite, which process creation bounds (DEVELOPMENT.md), spawned
// ~8,000 of them a run. Each probe now answers from the repository's files when the files
// settle it POSITIVELY: a resolvable git dir, or a ref whose loose file or packed-refs line
// names a SHA. Everything else spawns git exactly as before: a miss, a symref other than HEAD,
// a name git's DWIM rules could read another way, a reftable repo, an environment that
// redirects git (GIT_DIR and friends), or a repository another user owns, which git itself
// refuses (safe.directory). A hit is the SHA `rev-parse --verify` prints. It resolves the name
// and does not check that the object exists, and neither does this. The one negative answered
// from files is a plain full `refs/…` name with no loose file and no packed-refs line
// (refAbsentFromFiles): in a files-backend repository that is everywhere git looks.

/** Environment variables that make git look somewhere other than the files `dir` holds. While
 * any is set, every probe spawns git. */
const GIT_REDIRECT_ENV = ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_NAMESPACE"] as const;

/** Refs git keeps per worktree (in the worktree's own git dir, not the common one). They are
 * left to git. */
const PER_WORKTREE_REF = /^refs\/(?:bisect|worktree|rewritten)\//;

interface RepoFiles {
  /** This checkout's git dir: `.git` itself, or a linked worktree's `.git/worktrees/<name>`. */
  gitdir: string;
  /** Where the shared refs and objects live: the gitdir itself, or its `commondir` target. */
  commondir: string;
}

/** `dir`'s git dirs when its `.git` resolves from files to a files-backend repository this
 * process's user owns, or undefined when git should decide. */
function repoFiles(dir: string): RepoFiles | undefined {
  if (GIT_REDIRECT_ENV.some((name) => process.env[name])) return undefined;
  const uid = process.getuid?.();
  if (uid === undefined) return undefined;
  const gitdir = resolveGitDir(dir);
  if (gitdir === undefined) return undefined;
  let commondir = gitdir;
  try {
    const pointer = fs.readFileSync(path.join(gitdir, "commondir"), "utf8").trim();
    if (pointer === "") return undefined;
    commondir = path.resolve(gitdir, pointer);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return undefined; // A primary checkout has none.
  }
  try {
    if (fs.statSync(dir).uid !== uid || fs.statSync(gitdir).uid !== uid) return undefined;
    if (!fs.statSync(path.join(commondir, "objects")).isDirectory()) return undefined;
    if (!fs.statSync(path.join(gitdir, "HEAD")).isFile()) return undefined;
  } catch {
    return undefined;
  }
  if (fs.existsSync(path.join(commondir, "reftable"))) return undefined;
  return { gitdir, commondir };
}

/** A full ref name in the plain shape the file layout stores one way only: path-safe
 * characters, no empty, dot-led or `.lock` components. Anything fancier is git's to read. */
function isPlainRefName(ref: string): boolean {
  if (!/^refs\/[A-Za-z0-9._/-]+$/.test(ref)) return false;
  return ref.split("/").every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"));
}

/** The SHA a full ref name holds in `commondir`: its loose file (which wins in git too), else
 * its packed-refs line. null when neither has it, and undefined when the files hold something
 * git would read differently (a symref, unreadable content). */
function storedRef(commondir: string, ref: string): string | null | undefined {
  try {
    const loose = fs.readFileSync(path.join(commondir, ref), "utf8").trim();
    return isSha(loose) ? loose : undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
  }
  let packed: string;
  try {
    packed = fs.readFileSync(path.join(commondir, "packed-refs"), "utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined;
  }
  const suffix = ` ${ref}`;
  for (const line of packed.split("\n")) {
    if (!line.endsWith(suffix)) continue; // Skips the header, peel lines and other refs.
    const sha = line.slice(0, -suffix.length);
    return isSha(sha) ? sha : undefined;
  }
  return null;
}

/** The SHA `git rev-parse --verify <ref>` would print in `dir`, read from files, or undefined
 * when the files do not settle it (see the section comment): the caller then spawns git. `ref`
 * is HEAD (followed when it is a branch symref or a detached SHA), a full `refs/…` name, or a
 * short branch name, taken only when git's DWIM order could not resolve it to anything else
 * first (`<gitdir>/<name>`, `refs/<name>`, `refs/tags/<name>` all absent). */
export function refShaFromFiles(dir: string, ref: string): string | undefined {
  const repo = repoFiles(dir);
  if (repo === undefined) return undefined;
  if (ref === "HEAD") {
    let head: string;
    try {
      head = fs.readFileSync(path.join(repo.gitdir, "HEAD"), "utf8").trim();
    } catch {
      return undefined;
    }
    if (isSha(head)) return head;
    const target = head.startsWith("ref: ") ? head.slice("ref: ".length).trim() : "";
    if (!target.startsWith("refs/heads/") || !isPlainRefName(target)) return undefined;
    return storedRef(repo.commondir, target) ?? undefined;
  }
  if (ref.startsWith("refs/")) {
    if (!isPlainRefName(ref) || PER_WORKTREE_REF.test(ref)) return undefined;
    return storedRef(repo.commondir, ref) ?? undefined;
  }
  // A full object name means the object to git, ahead of any same-named ref.
  if (isSha(ref) || !isPlainRefName(`refs/heads/${ref}`)) return undefined;
  for (const dirOfName of new Set([repo.gitdir, repo.commondir])) {
    if (fs.existsSync(path.join(dirOfName, ref))) return undefined; // `<gitdir>/<name>` outranks every ref.
  }
  for (const outranking of [`refs/${ref}`, `refs/tags/${ref}`]) {
    if (storedRef(repo.commondir, outranking) !== null) return undefined;
  }
  return storedRef(repo.commondir, `refs/heads/${ref}`) ?? undefined;
}

/** False when the files settle that `root`'s repository has no linked-worktree registrations
 * (its `<commondir>/worktrees` admin dir is absent or empty), so `git worktree prune` has
 * nothing to do. True when there are some, and undefined when git should decide. */
export function hasWorktreeRegistrations(root: string): boolean | undefined {
  const repo = repoFiles(root);
  if (repo === undefined) return undefined;
  try {
    return fs.readdirSync(path.join(repo.commondir, "worktrees")).length > 0;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? false : undefined;
  }
}

/** True when the files settle that the full ref name `ref` does NOT exist in `dir`'s repository:
 * a plain shared `refs/…` name with neither a loose file nor a packed-refs line. In a
 * files-backend repository (repoFiles excludes reftable and redirected environments) that is
 * where git itself looks, so the answer is git's. False means "ask git", not "present". */
function refAbsentFromFiles(dir: string, ref: string): boolean {
  if (!isPlainRefName(ref) || PER_WORKTREE_REF.test(ref)) return false;
  const repo = repoFiles(dir);
  return repo !== undefined && storedRef(repo.commondir, ref) === null;
}

/** True when `dir` is inside a git repository — its `rev-parse --git-dir` probe succeeds. A
 * `dir` whose own `.git` resolves (refShaFromFiles's repository checks) answers without a
 * spawn. A subdirectory, or any doubt, asks git. */
export async function isGitRepo(dir: string): Promise<boolean> {
  if (repoFiles(dir) !== undefined) return true;
  return (await gitTry(dir, "rev-parse", "--git-dir")) !== null;
}

/** True if the repo has at least one commit. */
export async function hasCommits(root: string): Promise<boolean> {
  if (refShaFromFiles(root, "HEAD") !== undefined) return true;
  return (await gitTry(root, "rev-parse", "--verify", "HEAD")) !== null;
}

/** The commit that `ref` points to in `cwd`. */
export async function headOf(cwd: string, ref: string): Promise<string> {
  return refShaFromFiles(cwd, ref) ?? git(cwd, "rev-parse", "--verify", ref);
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
  const fromFiles = refShaFromFiles(root, ref);
  if (fromFiles !== undefined) return fromFiles;
  if (refAbsentFromFiles(root, ref)) return null;
  return gitTry(root, "rev-parse", "--verify", ref);
}

/** True when `sha` is already contained in `branch` (git merge-base --is-ancestor; equality counts
 * as contained). The leftover-recovery entry condition uses this to tell a stale pin — landed but
 * not yet un-pinned by a crash between the ff and the ref deletion — from real work. */
export async function isMergedInto(root: string, sha: string, branch: string): Promise<boolean> {
  return (await gitTry(root, "merge-base", "--is-ancestor", sha, branch)) !== null;
}

/** The repository's top-level working directory, or null when `dir` is not inside a git
 * repository (the probe fails). Resolving the root from the cwd's toplevel — never trusting
 * process.cwd() — is what lets every command behave identically from any subdirectory of the
 * repo it targets: .tumwater/ and tumwater.json live at the toplevel, and readBranchHead's
 * file fast path only works when the root actually holds `.git`. */
export async function repoToplevel(dir: string): Promise<string | null> {
  return toplevelFromFiles(dir) ?? gitTry(dir, "rev-parse", "--show-toplevel");
}

/** `dir` itself, canonicalized the way `--show-toplevel` prints it (the native realpath, which
 * also takes the on-disk letter case), when `dir`'s own `.git` resolves (repoFiles) and no
 * config moves the work tree elsewhere (`core.worktree`) or declares the repository bare.
 * undefined otherwise: a subdirectory, or anything unusual, is git's to resolve. */
function toplevelFromFiles(dir: string): string | undefined {
  const repo = repoFiles(dir);
  if (repo === undefined) return undefined;
  for (const config of [path.join(repo.commondir, "config"), path.join(repo.gitdir, "config.worktree")]) {
    let text: string;
    try {
      text = fs.readFileSync(config, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      return undefined;
    }
    // core.worktree, a true core.bare, or an include that could carry either.
    if (/^\s*(?:worktree\s*=|bare\s*=\s*true\b|\[\s*include)/im.test(text)) return undefined;
  }
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return undefined;
  }
}

/** True when the local branch `<branch>` exists in the repo. */
export async function branchExists(root: string, branch: string): Promise<boolean> {
  const ref = `refs/heads/${branch}`;
  if (refShaFromFiles(root, ref) !== undefined) return true;
  if (refAbsentFromFiles(root, ref)) return false;
  return (await gitTry(root, "rev-parse", "--verify", ref)) !== null;
}

/** The revision a worktree's change should be judged against: the merge-base of its HEAD
 * with `mainBranch`, falling back to main's tip when the merge-base fails (no common
 * ancestor, or no commits yet). The one home of the "diff against the merge-base, not
 * main's tip" policy shared by falseFixReason's BUGS.md base read and
 * backlogStructureReason's per-file base reads — both judge a backlog edit against the
 * tree the change builds on, so a stacked batch's earlier landing cannot make an
 * Open→Fixed restoration compare as already done (BUGS.md 2026-09-23). `rev` is the commit
 * whose merge-base with main is wanted; it defaults to the worktree's HEAD, and the rejected
 * change's revision interdiff asks for its own prior commit instead (git-diff.ts). */
export async function changeBaseRev(
  wt: string,
  mainBranch: string,
  rev = "HEAD",
): Promise<string> {
  return (await gitTry(wt, "merge-base", rev, mainBranch)) ?? mainBranch;
}

/** A file's content at a revision, or "" when the run fails (the file did not exist at that
 * revision, or the revision is gone) — the base-side read the backlog gates pair with
 * changeBaseRev, where a missing base file reads as empty. */
export async function fileContentAt(cwd: string, rev: string, file: string): Promise<string> {
  return (await gitTry(cwd, "show", `${rev}:${file}`)) ?? "";
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

/** The phrase a "branch does not exist" failure names: the repo's local branches joined with
 * commas, or "none" when the repo has none. The one wording doctor's repo check and the
 * startup gate's main-branch resolution share, so the fix they surface cannot drift. */
export async function branchesPhrase(root: string): Promise<string> {
  return (await listBranches(root)).join(", ") || "none";
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

/** The branch `dir`'s checkout has, read from its HEAD file without spawning git: undefined (not
 * null) when the files cannot answer and the `git symbolic-ref` fallback should decide. Exported
 * for synchronous poll loops that need the same resolution the async currentBranch gives
 * (src/status/status-polls.ts's mainCheckForPoll cannot await inside its per-second snapshot). A
 * `.git` directory (primary checkout) or a `gitdir: <path>` pointer file (a linked worktree — the
 * harness itself can run from one, as its own role worktrees do) both resolve. The HEAD line must
 * be `ref: refs/heads/<branch>`; a bare sha means detached HEAD — the same null the spawn
 * produces, since symbolic-ref fails on it — and anything else is unusual (undefined). */
export function currentBranchFromHeadFile(dir: string): string | null | undefined {
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
  return fromFile !== undefined ? fromFile : gitTry(root, "symbolic-ref", "--short", "HEAD");
}

/** The branch a read-only surface treats as the fleet's main: a configured `baseBranch` wins (`run
 * --branch` is per-invocation and invisible to a later query), else whatever the primary checkout
 * has checked out, else the literal "main". change/change-data.ts's collectRoleChange (async, via
 * currentBranch) and status-polls's mainCheckForPoll (sync, via currentBranchFromHeadFile — a
 * per-second snapshot cannot await) both render through this one precedence rule, so the dashboard
 * and the status table cannot disagree on what "main" is. doctor's checkRepo and the startup gate
 * restate the same precedence but validate the answer and fail instead of falling back, so they
 * keep their own resolution. */
export function targetBranch(
  configured: string | undefined,
  checkedOut: string | null | undefined,
): string {
  return configured ?? checkedOut ?? "main";
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

/** The number of commits in a `A..B` range: `git rev-list --count <range>` parsed as an
 * integer. The one home of the count idiom, so every surface that measures how far one ref
 * is ahead of another (a branch over main, main over a build) reads identically instead of
 * re-spelling the git call. Throws through `git` on failure; callers that must tolerate an
 * unknown ref use `gitTry` directly (as build-info's buildStaleness does for its sentinel). */
export async function countCommitsInRange(cwd: string, range: string): Promise<number> {
  return Number.parseInt(await git(cwd, "rev-list", "--count", range), 10);
}

/** Commits ahead of main on the worktree's branch. */
export async function aheadOfMain(wt: string, mainBranch: string): Promise<number> {
  return countCommitsInRange(wt, `${mainBranch}..HEAD`);
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
    // Both children run through execGitBounded, so a hung diff or patch-id is SIGTERMed
    // group-wide and SIGKILLed after the grace instead of stalling landing's approval check.
    const { stdout: diff } = await execGitBounded(
      ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--binary", `${base}...${head}`],
      { cwd: wt, timeoutMs: GIT_TIMEOUT_MS },
    );
    if (diff === "") return null;
    const run = execGitBounded(["patch-id", "--verbatim"], { cwd: wt, timeoutMs: GIT_TIMEOUT_MS });
    // A patch-id that dies before reading its input must not surface as an unhandled EPIPE.
    run.child.stdin?.on("error", () => {});
    run.child.stdin?.end(diff);
    const { stdout } = await run;
    return stdout.split(" ")[0]?.trim() || null;
  } catch {
    return null;
  }
}

/** Undo commits the agent made on top of `base` (INV-H1): a soft reset keeps their content as
 * staged edits, so the harness's own commitAll lands it as one commit. Returns how many commits
 * were folded — 0 when HEAD never moved. A count of 0 from rev-list with HEAD moved means the
 * agent amended or reset away from `base`; that still folds, and counts as 1. */
export async function foldCommitsSince(wt: string, base: string): Promise<number> {
  if ((await headOf(wt, "HEAD")) === base) return 0;
  const count = await countCommitsInRange(wt, `${base}..HEAD`);
  await git(wt, "reset", "--soft", base);
  return count > 0 ? count : 1;
}

/** Stage and commit everything in the worktree. Returns the new commit hash. */
export async function commitAll(wt: string, message: string): Promise<string> {
  await git(wt, "add", "-A");
  await git(wt, ...COMMIT_IDENT, "commit", "-m", message);
  return headOf(wt, "HEAD");
}
