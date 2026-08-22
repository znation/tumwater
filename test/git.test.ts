import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  aheadOfMain,
  commitAll,
  currentBranch,
  ensureWorktree,
  ffMergeToMain,
  hasCommits,
  headOf,
  isDirty,
  isGitRepo,
  mergeMainIntoBranch,
  resetWorktreeToMain,
} from "../src/git.js";
import { branchName } from "../src/paths.js";
import { makeRepo, sh, tmpdir } from "./util.js";

test("isGitRepo and hasCommits", async () => {
  const repo = makeRepo();
  assert.ok(await isGitRepo(repo));
  assert.ok(await hasCommits(repo));
  const plain = tmpdir();
  assert.ok(!(await isGitRepo(plain)));
});

test("ensureWorktree creates a persistent branch and reuses it", async () => {
  const repo = makeRepo();
  const wt = await ensureWorktree(repo, "clean", "main");
  assert.ok(fs.existsSync(path.join(wt, "seed.txt")));
  assert.equal(await currentBranch(wt), branchName("clean"));
  const again = await ensureWorktree(repo, "clean", "main");
  assert.equal(again, wt);
});

test("ensureWorktree recovers from a deleted worktree directory", async () => {
  const repo = makeRepo();
  const wt = await ensureWorktree(repo, "clean", "main");
  fs.rmSync(wt, { recursive: true, force: true });
  const again = await ensureWorktree(repo, "clean", "main");
  assert.ok(fs.existsSync(path.join(again, "seed.txt")));
});

test("commitAll stages everything and ffMergeToMain lands it while root is on main", async () => {
  const repo = makeRepo();
  const wt = await ensureWorktree(repo, "improve", "main");
  fs.writeFileSync(path.join(wt, "new.txt"), "hi\n");
  assert.ok(await isDirty(wt));
  const commit = await commitAll(wt, "tumwater(improve): add new.txt");
  assert.ok(!(await isDirty(wt)));
  assert.equal(await aheadOfMain(wt, "main"), 1);

  assert.ok(await mergeMainIntoBranch(wt, "main"));
  assert.ok(await ffMergeToMain(repo, "improve", "main"));
  assert.equal(await headOf(repo, "main"), commit);
  // The primary checkout's working tree got the file too.
  assert.ok(fs.existsSync(path.join(repo, "new.txt")));
});

test("ffMergeToMain works via ref push when root is on another branch", async () => {
  const repo = makeRepo();
  sh(repo, "git", "checkout", "-b", "scratch");
  const wt = await ensureWorktree(repo, "improve", "main");
  fs.writeFileSync(path.join(wt, "other.txt"), "x\n");
  const commit = await commitAll(wt, "tumwater(improve): add other.txt");
  assert.ok(await ffMergeToMain(repo, "improve", "main"));
  assert.equal(await headOf(repo, "main"), commit);
});

test("mergeMainIntoBranch resolves divergence and aborts cleanly on conflict", async () => {
  const repo = makeRepo();
  const wt = await ensureWorktree(repo, "clean", "main");

  // Non-conflicting divergence merges.
  fs.writeFileSync(path.join(repo, "main-only.txt"), "m\n");
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "main advance");
  fs.writeFileSync(path.join(wt, "branch-only.txt"), "b\n");
  await commitAll(wt, "branch work");
  assert.ok(await mergeMainIntoBranch(wt, "main"));
  assert.ok(await ffMergeToMain(repo, "clean", "main"));

  // Conflicting divergence aborts and leaves the worktree usable.
  fs.writeFileSync(path.join(repo, "seed.txt"), "main version\n");
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "main seed edit");
  fs.writeFileSync(path.join(wt, "seed.txt"), "branch version\n");
  await commitAll(wt, "branch seed edit");
  assert.ok(!(await mergeMainIntoBranch(wt, "main")));
  assert.ok(!(await isDirty(wt)));
});

test("resetWorktreeToMain discards commits and untracked files", async () => {
  const repo = makeRepo();
  const wt = await ensureWorktree(repo, "dry", "main");
  fs.writeFileSync(path.join(wt, "junk.txt"), "junk\n");
  await commitAll(wt, "junk");
  fs.writeFileSync(path.join(wt, "untracked.txt"), "u\n");
  await resetWorktreeToMain(wt, "main");
  assert.equal(await aheadOfMain(wt, "main"), 0);
  assert.ok(!fs.existsSync(path.join(wt, "junk.txt")));
  assert.ok(!fs.existsSync(path.join(wt, "untracked.txt")));
});
