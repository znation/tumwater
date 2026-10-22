import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathPrepend, writeScript } from "../fakes/fake-commands.js";
import { sh, tmpdir } from "../fixtures/repo-fixtures.js";

/** Git failures, for tests that pin how a caller reads one. Two kinds matter
 * (src/git/git-run.ts's gitCouldNotStart): git ran and failed (an unreadable index, a missing
 * object), or git never started (a spawn errno, as every call reported during 2026-10-21's
 * full process table). Each is a real failure of the real binary, reaching the code under test
 * exactly as runGit reports it, except gitFailingOn's shim, kept for the one read a real fault
 * cannot single out. */

/** An argument longer than the OS's ARG_MAX (1 MiB on macOS, 128 KiB per argument on Linux): a git
 * call carrying it fails to spawn with E2BIG, a spawn errno like that wedge's EAGAIN, so
 * gitCouldNotStart is true. Any other call in the same directory still runs. */
export const UNSTARTABLE_GIT_ARG = "x".repeat(2_000_000);

/** Run `fn` with `dir`'s index unreadable (mode 0), restoring it afterwards: every git call
 * that reads the index fails there (`index file open failed`, exit 128), while a tree-to-tree
 * diff, which reads no index, still answers. */
export async function withUnreadableIndex<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const index = path.resolve(dir, sh(dir, "git", "rev-parse", "--git-path", "index"));
  fs.chmodSync(index, 0);
  try {
    return await fn();
  } finally {
    fs.chmodSync(index, 0o644);
  }
}

/** Delete the loose object `rev` names in `dir`'s repository. Dropping a commit's subtree makes
 * every read that descends into it fail (`unable to read tree`), a diff of that commit
 * included, while commit walks (`rev-list`, `log`) and `git status` still answer. */
export function dropLooseObject(dir: string, rev: string): void {
  const sha = sh(dir, "git", "rev-parse", rev);
  const objects = path.resolve(dir, sh(dir, "git", "rev-parse", "--git-common-dir"), "objects");
  fs.rmSync(path.join(objects, sha.slice(0, 2), sha.slice(2)));
}

/** Install a `git` shim at the front of PATH that fails as git's own fatal error does (a
 * `fatal:` line, exit 128) for every call whose arguments start with `argsPrefix`, and runs the
 * real git for every other call. Only for a read no real fault can single out, because the call
 * before it reads the same objects (aheadOfMainDiff's `--stat` after its full diff). Returns a
 * restore function, like loggingGit. */
export function gitFailingOn(argsPrefix: string): () => void {
  const dir = tmpdir("failing-git-");
  const real = execFileSync("which", ["git"], { encoding: "utf8" }).trim().split("\n")[0];
  writeScript(
    path.join(dir, "git"),
    `case "$*" in ${JSON.stringify(argsPrefix)}*) echo "fatal: injected" >&2; exit 128;; esac\nexec "${real}" "$@"`,
  );
  return pathPrepend(dir);
}
