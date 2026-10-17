import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { branchExists, hasCommits, headOf, isGitRepo, refSha, refShaFromFiles, repoToplevel, hasWorktreeRegistrations } from "../src/git/git.js";
import { setEnv } from "./helpers/env.js";
import { commitIn, gitInit, makeRepo, sh, tmpdir } from "./fixtures/repo-fixtures.js";

// The file-based ref reads behind isGitRepo, hasCommits, headOf, refSha and branchExists
// (src/git/git.ts, "Ref reads from files"). The contract is one-sided: a SHA read from files
// must be exactly what `git rev-parse --verify` prints, and anything the files do not settle
// is undefined, so the probe spawns git as it always did.

/** What git itself resolves `ref` to in `dir`, or null when it cannot. */
function gitRevParse(dir: string, ref: string): string | null {
  try {
    return sh(dir, "git", "rev-parse", "--verify", "--quiet", ref) || null;
  } catch {
    return null;
  }
}

/** A repo with history on main, a feature branch, a lightweight and an annotated tag, and a
 * merge-style pin under a custom namespace. */
function richRepo(): string {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, "a.txt"), "a\n");
  commitIn(root, "a");
  sh(root, "git", "branch", "tumwater/feature");
  fs.writeFileSync(path.join(root, "b.txt"), "b\n");
  commitIn(root, "b");
  sh(root, "git", "tag", "v1");
  sh(root, "git", "tag", "-a", "v2", "-m", "annotated");
  sh(root, "git", "update-ref", "refs/tumwater/landing/improve", "HEAD~1");
  return root;
}

const REFS = [
  "HEAD",
  "main",
  "tumwater/feature",
  "refs/heads/main",
  "refs/heads/tumwater/feature",
  "refs/tags/v1",
  "refs/tags/v2",
  "refs/tumwater/landing/improve",
  "v1",
  "no-such-branch",
  "refs/heads/no-such-branch",
];

/** Every ref the files answer for agrees with git, and those listed in `answered` are answered. */
function assertAgrees(dir: string, answered: string[]): void {
  for (const ref of REFS) {
    const fromFiles = refShaFromFiles(dir, ref);
    if (fromFiles !== undefined) assert.equal(fromFiles, gitRevParse(dir, ref), `${ref} in ${dir}`);
  }
  for (const ref of answered) assert.notEqual(refShaFromFiles(dir, ref), undefined, `${ref} is read from files`);
}

test("loose refs: every answer from files is git's, and the common reads need no spawn", () => {
  const root = richRepo();
  assertAgrees(root, ["HEAD", "main", "tumwater/feature", "refs/heads/main", "refs/tumwater/landing/improve"]);
});

test("packed refs answer too, and a loose ref written after packing wins like it does in git", () => {
  const root = richRepo();
  sh(root, "git", "pack-refs", "--all");
  assert.ok(!fs.existsSync(path.join(root, ".git", "refs", "heads", "main")), "main lives in packed-refs now");
  assertAgrees(root, ["HEAD", "main", "refs/tags/v1", "refs/tumwater/landing/improve"]);
  fs.writeFileSync(path.join(root, "c.txt"), "c\n");
  commitIn(root, "c"); // writes a loose refs/heads/main over the packed line
  assert.equal(refShaFromFiles(root, "main"), gitRevParse(root, "main"));
});

test("a linked worktree reads its own HEAD and the shared refs", () => {
  const root = richRepo();
  const wt = path.join(tmpdir(), "wt");
  sh(root, "git", "worktree", "add", "-b", "tumwater/improve", wt, "tumwater/feature");
  assert.equal(refShaFromFiles(wt, "HEAD"), gitRevParse(wt, "HEAD"));
  assert.notEqual(refShaFromFiles(wt, "HEAD"), refShaFromFiles(root, "HEAD"), "per-worktree HEAD, not the primary's");
  assertAgrees(wt, ["HEAD", "main", "tumwater/improve"]);
  sh(wt, "git", "checkout", "--detach", "main");
  assert.equal(refShaFromFiles(wt, "HEAD"), gitRevParse(root, "main"), "a detached HEAD is its SHA");
});

test("a short name git could read as a tag or a top-level ref is left to git", () => {
  const root = richRepo();
  sh(root, "git", "tag", "tumwater/feature", "main"); // same short name as the branch, a different commit
  assert.equal(refShaFromFiles(root, "tumwater/feature"), undefined);
  assert.equal(gitRevParse(root, "tumwater/feature"), gitRevParse(root, "refs/tags/tumwater/feature"), "git picks the tag");
  sh(root, "git", "update-ref", "refs/main", "HEAD~1");
  assert.equal(refShaFromFiles(root, "main"), undefined);
  fs.writeFileSync(path.join(root, ".git", "ORIG_HEAD"), `${gitRevParse(root, "HEAD~2")}\n`);
  assert.equal(refShaFromFiles(root, "ORIG_HEAD"), undefined, "a <gitdir>/<name> file outranks every ref");
});

test("misses and unusual shapes are never answered from files", () => {
  const root = richRepo();
  const sha = gitRevParse(root, "HEAD")!;
  assert.equal(refShaFromFiles(root, "no-such-branch"), undefined);
  assert.equal(refShaFromFiles(root, "refs/heads/no-such-branch"), undefined);
  assert.equal(refShaFromFiles(root, sha), undefined, "a full object name is git's to read");
  assert.equal(refShaFromFiles(root, "main~1"), undefined);
  assert.equal(refShaFromFiles(root, "refs/heads/../main"), undefined);
  sh(root, "git", "symbolic-ref", "refs/remotes/origin/HEAD", "refs/heads/main");
  assert.equal(refShaFromFiles(root, "refs/remotes/origin/HEAD"), undefined, "a symref other than HEAD");
  sh(root, "git", "update-ref", "refs/bisect/bad", "HEAD");
  assert.equal(refShaFromFiles(root, "refs/bisect/bad"), undefined, "a per-worktree ref");
  const sub = path.join(root, "nested");
  fs.mkdirSync(sub);
  assert.equal(refShaFromFiles(sub, "HEAD"), undefined, "a subdirectory has no .git of its own");
  assert.equal(refShaFromFiles(tmpdir(), "HEAD"), undefined, "not a repository");
});

test("an unborn branch has no HEAD to read, and hasCommits still asks git", async () => {
  const root = tmpdir();
  gitInit(root);
  assert.equal(refShaFromFiles(root, "HEAD"), undefined);
  assert.equal(await hasCommits(root), false);
  assert.equal(await isGitRepo(root), true, "a repository with no commits is still one");
});

test("an environment that redirects git keeps every read with git", (t) => {
  const root = richRepo();
  const other = makeRepo();
  t.after(setEnv("GIT_DIR", path.join(other, ".git")));
  assert.equal(refShaFromFiles(root, "HEAD"), undefined);
});

test("the probes answer from files and agree with git across hits and misses", async () => {
  const root = richRepo();
  const sub = path.join(root, "nested");
  fs.mkdirSync(sub);
  assert.equal(await isGitRepo(root), true);
  assert.equal(await isGitRepo(sub), true, "a subdirectory falls back to git, which walks up");
  assert.equal(await isGitRepo(tmpdir()), false);
  assert.equal(await hasCommits(root), true);
  assert.equal(await headOf(root, "main"), gitRevParse(root, "main"));
  await assert.rejects(() => headOf(root, "no-such-branch"), /no-such-branch/);
  assert.equal(await refSha(root, "refs/tumwater/landing/improve"), gitRevParse(root, "refs/tumwater/landing/improve"));
  assert.equal(await refSha(root, "refs/tumwater/landing/none"), null);
  assert.equal(await branchExists(root, "tumwater/feature"), true);
  assert.equal(await branchExists(root, "no-such-branch"), false);
});

test("repoToplevel answers a checkout root from files exactly as git prints it", async () => {
  const root = richRepo();
  const wt = path.join(tmpdir(), "wt");
  sh(root, "git", "worktree", "add", "-b", "tumwater/top", wt, "main");
  for (const dir of [root, wt]) {
    assert.equal(await repoToplevel(dir), sh(dir, "git", "rev-parse", "--show-toplevel"));
  }
  const sub = path.join(root, "nested");
  fs.mkdirSync(sub);
  assert.equal(await repoToplevel(sub), sh(sub, "git", "rev-parse", "--show-toplevel"), "a subdirectory asks git");
  assert.equal(await repoToplevel(tmpdir()), null);
});

test("repoToplevel leaves a moved work tree to git", async () => {
  const root = richRepo();
  const elsewhere = tmpdir();
  sh(root, "git", "config", "core.worktree", elsewhere);
  assert.equal(await repoToplevel(root), sh(root, "git", "rev-parse", "--show-toplevel"));
});

test("hasWorktreeRegistrations is false only when the files show no linked worktree at all", () => {
  const root = makeRepo();
  assert.equal(hasWorktreeRegistrations(root), false);
  sh(root, "git", "worktree", "add", "-b", "tumwater/reg", path.join(tmpdir(), "wt"), "main");
  assert.equal(hasWorktreeRegistrations(root), true);
  assert.equal(hasWorktreeRegistrations(tmpdir()), undefined, "not a repository: git decides");
});
