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

/** The repo's local branch names — what an error message lists when a named branch does not
 * exist, so the fix is visible in the failure itself. Empty when the repo has no branches. */
export async function listBranches(root: string): Promise<string[]> {
  const out = await gitTry(root, "for-each-ref", "--format=%(refname:short)", "refs/heads");
  return out ? out.split("\n").filter(Boolean) : [];
}

/** The branch `dir`'s checkout has, read from its HEAD file without spawning git: undefined
 * (not null) when the files cannot answer and the `git symbolic-ref` fallback should decide.
 * A `.git` directory (primary checkout) or a `gitdir: <path>` pointer file (a linked worktree —
 * the harness itself can run from one, as its own role worktrees do) both resolve. The HEAD
 * line must be `ref: refs/heads/<branch>`; a bare sha means detached HEAD — the same null the
 * spawn produces, since symbolic-ref fails on it — and anything else is unusual (undefined). */
function currentBranchFromHeadFile(dir: string): string | null | undefined {
  let gitdir: string;
  try {
    const dotGit = path.join(dir, ".git");
    if (fs.statSync(dotGit).isDirectory()) {
      gitdir = dotGit; // Primary checkout.
    } else {
      // Linked worktree: `.git` is a one-line pointer file (`gitdir: <path>`).
      const line = fs.readFileSync(dotGit, "utf8").trim();
      if (!line.startsWith("gitdir:")) return undefined;
      const target = line.slice("gitdir:".length).trim();
      if (!target) return undefined; // Malformed pointer: uncertain.
      gitdir = path.resolve(dir, target);
    }
  } catch {
    return undefined; // No repo here (or .git unreadable) — let the spawn decide.
  }
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

/** Decode a path from `git status --porcelain` output. Git C-quotes paths containing special
 * characters (control characters, quotes, non-ASCII under core.quotePath) and escapes them —
 * the decoded form is what callers pass back to git as a real path. Unquoted paths pass through.
 * Control characters git short-escapes (its `sq_lookup` table) all must be decoded: `\n`, `\t`,
 * `\r`, and the less common `\a` (BEL), `\b` (BS), `\f` (FF), `\v` (VT) — every other control
 * byte arrives as an octal escape.
 * Non-ASCII arrives one octal escape per UTF-8 byte, so the escapes are first collected into
 * a latin1 byte string and only then reassembled as UTF-8 (decoding each escape to a character
 * on its own yields mojibake — `héllo.md` would come back as `hÃ©llo.md`). Used by
 * conflictedFiles in merge.ts; changedFiles reads git's NUL-terminated `-z` format, which
 * emits paths verbatim (no quoting), so it has no encoded path to decode. */
export function unquotePorcelainPath(p: string): string {
  if (!p.startsWith('"')) return p;
  const end = p.lastIndexOf('"');
  if (end < 1) return p; // Malformed — keep as-is rather than drop the entry.
  let bytes = "";
  for (let i = 1; i < end; i++) {
    const c = p.charAt(i);
    if (c !== "\\") {
      bytes += c; // Raw characters in a quoted path are always safe ASCII.
      continue;
    }
    i++;
    const e = p.charAt(i);
    switch (e) {
      case "n":
        bytes += "\n";
        break;
      case "t":
        bytes += "\t";
        break;
      case "r":
        bytes += "\r";
        break;
      case "a":
        bytes += "\x07";
        break;
      case "b":
        bytes += "\x08";
        break;
      case "f":
        bytes += "\x0c";
        break;
      case "v":
        bytes += "\x0b";
        break;
      case "\\":
        bytes += "\\";
        break;
      case '"':
        bytes += '"';
        break;
      default:
        // Octal escape \NNN (the remaining control characters); anything else is kept literally.
        if (e >= "0" && e <= "7") {
          const chunk = p.slice(i, i + 3);
          if (/^[0-7]{3}$/.test(chunk)) {
            bytes += String.fromCharCode(parseInt(chunk, 8));
            i += 2;
          } else {
            bytes += e;
          }
        } else {
          bytes += e;
        }
    }
  }
  return Buffer.from(bytes, "latin1").toString("utf8");
}

/** Repo-relative paths of every change in the worktree — modified, untracked, and deleted,
 * parsed from `git status --porcelain -z` (paths only). The refusal path uses this to classify
 * what a refusing run left behind: markdown notes may land, everything else is discarded.
 *
 * The `-z` format is what git recommends for machine parsing: records are NUL-terminated and
 * paths are emitted verbatim, never C-quoted, so a path with whitespace, a quote, a control
 * byte, or non-ASCII survives byte-for-byte without the decode `unquotePorcelainPath` would
 * need. It also settles rename/copy entries, which the line format renders as
 * `XY <from> -> "<to>"`: a path containing ` -> ` made that ambiguous, and decoding the whole
 * `from -> to` field produced one path that exists nowhere (e.g. `old.txt -> new.txt`). With
 * `-z` a rename/copy is two records — `XY <to>\0<from>\0`, destination first — so this reads
 * the destination (the path that exists now) and skips the extra origin record. */
export async function changedFiles(wt: string): Promise<string[]> {
  const out = await gitTry(wt, "status", "--porcelain", "-z");
  if (!out) return [];
  const files: string[] = [];
  const records = out.split("\0");
  for (let i = 0; i < records.length; i++) {
    // Porcelain v1 records are `XY <path>` — two status chars, a space, then the verbatim path.
    const record = records[i];
    if (record === undefined || record.length < 4) continue;
    const p = record.slice(3);
    if (p) files.push(p);
    // A rename/copy is followed by one extra record holding the origin path (no status
    // prefix); consume it so its raw text is never mistaken for a status line.
    if (record[0] === "R" || record[0] === "C") i++;
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
  return out.split("\n").filter(Boolean);
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

/** Repo-relative paths changed between the branch's fork point from main and its HEAD —
 * everything a merge of this branch would land (the three-dot range diffs against the
 * merge-base, so commits main gained during the tick are not included). */
export async function aheadOfMainFiles(wt: string, mainBranch: string): Promise<string[]> {
  const out = await gitTry(wt, "diff", "--name-only", `${mainBranch}...HEAD`);
  return out ? out.split("\n").filter(Boolean) : [];
}

/** Split a unified diff into one section per file, each starting at its own
 * `diff --git ` header line. Only real headers match: added lines start with "+" and context
 * lines with a space, so file content can never fake a boundary at column 0. Each section is
 * byte-identical to what `git diff <range> -- <file>` prints for that file — the per-file
 * spawn exists only for callers that need one file without fetching the rest. */
function splitDiffByFile(diff: string): string[] {
  const sections: string[] = [];
  let cur: string[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ") && cur.length > 0) {
      sections.push(cur.join("\n"));
      cur = [];
    }
    cur.push(line);
  }
  if (cur.length > 0) sections.push(cur.join("\n"));
  return sections;
}

/** The combined ahead-of-main diff — everything a merge of this branch would land. Capped:
 * over `maxBytes`, the result is a truncation note plus `--stat` and the largest files' full
 * diffs (an oversized diff is itself reviewable information, and the reviewer can read any
 * file in the worktree directly). The per-file sections are split out of the one full diff
 * already fetched — spawning a diff per file would re-diff the entire range once per file for
 * text we already hold in memory (measured ~0.5 s of redundant git work on a 530 KB / 39-file
 * tick). Section byte length ranks files at least as well as numstat's added+deleted: it is
 * exactly what the reviewer will see, and a binary file's short "Binary files differ" stub
 * naturally ranks below any real text change. */
export async function aheadOfMainDiff(
  wt: string,
  mainBranch: string,
  maxBytes = 200_000,
): Promise<string> {
  const range = `${mainBranch}...HEAD`;
  const full = (await gitTry(wt, "diff", range)) ?? "";
  if (full.length <= maxBytes) return full;
  // Over the cap: rank files by change size and include the largest while budget allows.
  const ranked = splitDiffByFile(full).sort((a, b) => b.length - a.length);
  let out =
    `[diff truncated: the full ahead-of-main diff is ${full.length} bytes; ` +
    `showing --stat plus the largest files]\n\n` + ((await gitTry(wt, "diff", "--stat", range)) ?? "") + "\n";
  for (const d of ranked) {
    // Account for the surrounding newlines in the budget check so the output never exceeds
    // maxBytes even when a section lands exactly on the boundary.
    if (out.length + d.length + 2 > maxBytes) break;
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
