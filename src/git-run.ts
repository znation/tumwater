/** The git execution layer: spawning the binary, the error it reports, and the commit
 * identity the harness authors commits with. The query helpers built on top of it (heads,
 * refs, branches, diffs) live in git.ts and its siblings — this module knows git's argv,
 * not the repository's shape. */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { findOnPath } from "./files.js";
import { execFileAsync } from "./process.js";

/** Identity used for harness-authored commits so ticks work without global git config. */
export const COMMIT_IDENT = [
  "-c",
  "user.name=tumwater",
  "-c",
  "user.email=tumwater@localhost",
];

export class GitError extends Error {
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

/** The git binary the harness spawns, resolved once per process. On macOS the first git on
 * PATH is routinely /usr/bin/git — the xcode-select stub, which re-resolves the developer
 * directory on every exec before running the real binary (the same cost test-runner.ts's
 * suiteEnv already keeps out of the suite). Resolving the real binary once and spawning it
 * by absolute path cuts that per-spawn tax from every harness git call without changing what
 * any command does: the same binary ends up executing the same argv. Any other first git —
 * Linux, Homebrew — spawns by name exactly as before, and a machine with no git at all keeps
 * the "git" name so the spawn still fails ENOENT and GIT_MISSING_MESSAGE still applies.
 * Resolution caches the found absolute path (null = spawn by name); it never re-walks. The
 * deliberate exception is build-check/build-check.ts's toolchain probe, which must keep spawning PATH's
 * stub — its "broken" verdict exists to catch exactly the stub's exit-69-on-invalid-license
 * failure, which the real binary would never surface. */
let resolvedGit: string | null | undefined;

export function resolvedGitBin(): string {
  if (resolvedGit !== undefined) return resolvedGit ?? "git";
  let bin: string | null = null;
  if (process.platform === "darwin" && findOnPath("git") === "/usr/bin/git") {
    const found = spawnSync("xcrun", ["--find", "git"], { encoding: "utf8" });
    const real = found.status === 0 ? found.stdout.trim() : "";
    if (real && path.isAbsolute(real) && real !== "/usr/bin/git" && fs.existsSync(real)) bin = real;
  }
  resolvedGit = bin;
  return bin ?? "git";
}

/** Run git in `cwd`, throwing GitError on a nonzero exit or when the binary cannot be
 * started at all (the error then names the spawn failure, since git prints no stderr). */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  return runGit(cwd, args);
}

/** Like git(), with extra environment variables (e.g. GIT_EDITOR for rebase --continue, which
 * the landing flow in landing-merge.ts needs so `rebase --continue` can never block on a commit-message
 * prompt; and the harness ident for rewritten committer identity). */
export async function runGit(
  cwd: string,
  args: string[],
  extraEnv?: NodeJS.ProcessEnv,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(resolvedGitBin(), args, {
      cwd,
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