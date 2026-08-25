import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  aheadOfMain,
  commitAll,
  currentBranch,
  continueRebase,
  ensureWorktree,
  ffMergeToMain,
  hasCommits,
  hasConflictMarkers,
  headOf,
  isDirty,
  isGitRepo,
  rebaseOntoMain,
  rebaseOntoMainLeaveConflicts,
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

  assert.ok(await rebaseOntoMain(wt, "main"));
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

test("rebaseOntoMain resolves divergence and aborts cleanly on conflict", async () => {
  const repo = makeRepo();
  const wt = await ensureWorktree(repo, "clean", "main");

  // Non-conflicting divergence rebases.
  fs.writeFileSync(path.join(repo, "main-only.txt"), "m\n");
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "main advance");
  fs.writeFileSync(path.join(wt, "branch-only.txt"), "b\n");
  await commitAll(wt, "branch work");
  assert.ok(await rebaseOntoMain(wt, "main"));
  assert.ok(await ffMergeToMain(repo, "clean", "main"));

  // Conflicting divergence aborts and leaves the worktree usable.
  fs.writeFileSync(path.join(repo, "seed.txt"), "main version\n");
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "main seed edit");
  fs.writeFileSync(path.join(wt, "seed.txt"), "branch version\n");
  await commitAll(wt, "branch seed edit");
  assert.ok(!(await rebaseOntoMain(wt, "main")));
  assert.ok(!(await isDirty(wt)));
});

test("rebaseOntoMain keeps the branch's commits when main has not advanced", async () => {
  const repo = makeRepo();
  const wt = await ensureWorktree(repo, "improve", "main");
  fs.writeFileSync(path.join(wt, "new.txt"), "hi\n");
  const commit = await commitAll(wt, "branch work");
  assert.ok(await rebaseOntoMain(wt, "main"));
  // No rewrite: the tick's commit hash is preserved (a no-op rebase).
  assert.equal(await headOf(wt, "HEAD"), commit);
});

test("rebaseOntoMainLeaveConflicts leaves markers in place for a resolver", async () => {
  const repo = makeRepo();
  const wt = await ensureWorktree(repo, "clean", "main");

  // Clean divergence reports clean.
  fs.writeFileSync(path.join(wt, "branch-only.txt"), "b\n");
  await commitAll(wt, "branch work");
  assert.equal(await rebaseOntoMainLeaveConflicts(wt, "main"), "clean");

  // Conflicting divergence stops mid-rebase with markers in the worktree.
  fs.writeFileSync(path.join(repo, "seed.txt"), "main version\n");
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "main seed edit");
  fs.writeFileSync(path.join(wt, "seed.txt"), "branch version\n");
  await commitAll(wt, "branch seed edit");
  assert.equal(await rebaseOntoMainLeaveConflicts(wt, "main"), "conflict");
  const conflicted = fs.readFileSync(path.join(wt, "seed.txt"), "utf8");
  assert.match(conflicted, /<<<<<<< /);
  assert.match(conflicted, />>>>>>> /);

  // A rebase that cannot start (dirty worktree) reports failed and leaves no state.
  await resetWorktreeToMain(wt, "main");
  fs.writeFileSync(path.join(wt, "seed.txt"), "uncommitted edit\n");
  assert.equal(await rebaseOntoMainLeaveConflicts(wt, "main"), "failed");
});

test("continueRebase concludes a resolved conflict on top of main", async () => {
  const repo = makeRepo();
  const wt = await ensureWorktree(repo, "clean", "main");

  fs.writeFileSync(path.join(wt, "seed.txt"), "branch version\n");
  await commitAll(wt, "branch seed edit");
  fs.writeFileSync(path.join(repo, "seed.txt"), "main version\n");
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "main seed edit");

  assert.equal(await rebaseOntoMainLeaveConflicts(wt, "main"), "conflict");
  fs.writeFileSync(path.join(wt, "seed.txt"), "combined version\n");
  const head = await continueRebase(wt);
  // The branch now sits on top of main with the resolution as its own commit.
  assert.equal(await aheadOfMain(wt, "main"), 1);
  assert.ok(fs.existsSync(path.join(repo, "seed.txt")));
  assert.match(sh(wt, "git", "log", "-1", "--format=%s"), /branch seed edit/);
  // The rebased commit is a plain (non-merge) commit.
  assert.equal(sh(wt, "git", "log", "-1", "--format=%P").split(" ").length, 1);
  assert.ok(await ffMergeToMain(repo, "clean", "main"));
  assert.equal(await headOf(repo, "main"), head);
});

test("continueRebase skips a resolution that leaves no unique content", async () => {
  const repo = makeRepo();
  const wt = await ensureWorktree(repo, "clean", "main");

  fs.writeFileSync(path.join(wt, "seed.txt"), "branch version\n");
  await commitAll(wt, "branch seed edit");
  fs.writeFileSync(path.join(repo, "seed.txt"), "main version\n");
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "main seed edit");

  assert.equal(await rebaseOntoMainLeaveConflicts(wt, "main"), "conflict");
  // The resolver takes main's side entirely: the replayed commit is now empty and git
  // skips it, finishing the rebase with the branch equal to main.
  fs.writeFileSync(path.join(wt, "seed.txt"), "main version\n");
  await continueRebase(wt);
  assert.equal(await aheadOfMain(wt, "main"), 0);
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

test("resetWorktreeToMain clears an interrupted rebase", async () => {
  const repo = makeRepo();
  const wt = await ensureWorktree(repo, "dry", "main");
  fs.writeFileSync(path.join(wt, "seed.txt"), "branch version\n");
  await commitAll(wt, "branch seed edit");
  fs.writeFileSync(path.join(repo, "seed.txt"), "main version\n");
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "main seed edit");
  // Start a conflicting rebase and leave it in progress (a killed tick mid-resolution).
  assert.equal(await rebaseOntoMainLeaveConflicts(wt, "main"), "conflict");
  await resetWorktreeToMain(wt, "main");
  assert.equal(await aheadOfMain(wt, "main"), 0);
  // The next sync works: no "you are already rebasing" wedge.
  fs.writeFileSync(path.join(wt, "seed.txt"), "fresh version\n");
  await commitAll(wt, "fresh work");
  assert.ok(await rebaseOntoMain(wt, "main"));
});

test("hasConflictMarkers detects leftover conflict blocks", () => {
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, "full.txt"),
    "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> main\n",
  );
  // A partial resolution that keeps only the start marker is still unresolved.
  fs.writeFileSync(path.join(dir, "partial.txt"), "<<<<<<< HEAD\nours\n");
  assert.ok(hasConflictMarkers(dir, ["full.txt", "partial.txt"]));
});

test("hasConflictMarkers does not flag setext/RST underlines of seven equals (regression)", () => {
  const dir = tmpdir();
  // A correctly resolved file that keeps a markdown setext heading whose underline is
  // exactly seven '=' — legitimate content, not a conflict separator.
  fs.writeFileSync(path.join(dir, "docs.md"), "History\n=======\n\nFirst entry.\nSecond entry.\n");
  assert.ok(!hasConflictMarkers(dir, ["docs.md"]));
});

test("hasConflictMarkers treats a deleted file as resolved", () => {
  const dir = tmpdir();
  assert.ok(!hasConflictMarkers(dir, ["gone.txt"]));
});
