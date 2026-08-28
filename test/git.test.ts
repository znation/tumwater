import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  abortSync,
  aheadOfMain,
  aheadOfMainDiff,
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
  readBranchHead,
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

/** Delete the worktree's admin-side registration under <repo>/.git/worktrees/ (the one whose
 * gitdir file points at `wt`), simulating outside git maintenance pruning it. */
function pruneAdminRegistration(repo: string, wt: string): void {
  const adminDir = path.join(repo, ".git", "worktrees");
  for (const name of fs.readdirSync(adminDir)) {
    const p = path.join(adminDir, name);
    const gitdirFile = path.join(p, "gitdir");
    if (fs.existsSync(gitdirFile) && fs.readFileSync(gitdirFile, "utf8").includes(wt)) {
      fs.rmSync(p, { recursive: true, force: true });
    }
  }
}

test("ensureWorktree recovers when its admin registration is pruned out from under it", async () => {
  const repo = makeRepo();
  const wt = await ensureWorktree(repo, "clean", "main");
  // Leave unmerged work on the branch so recovery must preserve it.
  fs.writeFileSync(path.join(wt, "branch-only.txt"), "b\n");
  const commit = await commitAll(wt, "branch work");

  pruneAdminRegistration(repo, wt);

  // Previously this wedged every tick with a raw git fatal; now it re-adds the directory.
  const again = await ensureWorktree(repo, "clean", "main");
  assert.equal(again, wt);
  assert.ok(fs.existsSync(path.join(again, "seed.txt")));
  // The branch's unmerged commit survived the re-add.
  assert.equal(await headOf(wt, "HEAD"), commit);
});

test("ensureWorktree recovers when the worktree's .git pointer file is lost", async () => {
  const repo = makeRepo();
  const wt = await ensureWorktree(repo, "clean", "main");
  fs.rmSync(path.join(wt, ".git")); // admin-side registration survives this one

  const again = await ensureWorktree(repo, "clean", "main");
  assert.equal(again, wt);
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

test("readBranchHead matches git rev-parse across loose and packed refs", () => {
  const repo = makeRepo();
  // Fresh init keeps the branch as a loose ref.
  let head = sh(repo, "git", "rev-parse", "main");
  assert.equal(readBranchHead(repo, "main"), head);

  // pack-refs moves main into packed-refs and deletes the loose file.
  sh(repo, "git", "pack-refs", "--all");
  assert.ok(!fs.existsSync(path.join(repo, ".git", "refs", "heads", "main")));
  assert.equal(readBranchHead(repo, "main"), head);

  // A new commit re-loosens the ref while packed-refs keeps the stale entry — loose wins.
  fs.writeFileSync(path.join(repo, "b.txt"), "b\n");
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "second");
  head = sh(repo, "git", "rev-parse", "main");
  assert.equal(readBranchHead(repo, "nope"), null); // unknown branch: null, not the stale sha
  assert.equal(readBranchHead(repo, "main"), head);
});

// --- aheadOfMainDiff: the review gate's diff feed, including its truncation path ---

/** A deterministic text blob of `lines` lines, each exactly 40 bytes (tag + index + padding). */
function blob(tag: string, lines: number): string {
  return (
    Array.from({ length: lines }, (_, i) => `${tag}-${i.toString().padStart(6, "0")}-` + "z".repeat(28)).join("\n") + "\n"
  );
}

test("aheadOfMainDiff returns the full diff when under the cap", async () => {
  const repo = makeRepo();
  const wt = await ensureWorktree(repo, "clean", "main");
  fs.writeFileSync(path.join(wt, "small.txt"), blob("SML", 5));
  await commitAll(wt, "small change");

  // Default cap (200KB) is far above this diff: the output must be exactly what git prints.
  const out = await aheadOfMainDiff(wt, "main");
  assert.equal(out, sh(wt, "git", "diff", "main...HEAD"));
  assert.ok(!out.includes("[diff truncated:"), "no truncation note under the cap");
});

test("aheadOfMainDiff is empty when the branch has no commits ahead of main", async () => {
  const repo = makeRepo();
  const wt = await ensureWorktree(repo, "clean", "main");
  assert.equal(await aheadOfMainDiff(wt, "main"), "");
});

test("aheadOfMainDiff over the cap keeps --stat plus the largest files within budget", async () => {
  const repo = makeRepo();
  const wt = await ensureWorktree(repo, "improve", "main");
  // File names are chosen so alphabetical order (aaa < mmm < zzz) is the REVERSE of size
  // order: a regression that ranked by name instead of numstat size would include aaa.txt
  // and drop zzz.txt.
  fs.writeFileSync(path.join(wt, "zzz.txt"), blob("ZZZ", 500)); // ~20KB — largest
  fs.writeFileSync(path.join(wt, "mmm.txt"), blob("MMM", 200)); // ~8KB
  fs.writeFileSync(path.join(wt, "aaa.txt"), blob("AAA", 100)); // ~4KB — smallest
  await commitAll(wt, "big change");

  const cap = 31_000; // full diff is ~33KB: over the cap, but room for zzz + mmm only.
  const out = await aheadOfMainDiff(wt, "main", cap);

  assert.ok(out.startsWith("[diff truncated:"), `truncation note first:\n${out.slice(0, 200)}`);
  assert.match(out, /showing --stat plus the largest files/);
  // The --stat section names every changed file, even ones whose diff was cut.
  for (const f of ["zzz.txt", "mmm.txt", "aaa.txt"])
    assert.ok(out.includes(f), `--stat lists ${f}`);
  // The two largest files' full diffs are in, ranked by size: zzz before mmm...
  const zzz = out.indexOf("ZZZ-");
  const mmm = out.indexOf("MMM-");
  assert.ok(zzz >= 0, "largest file's diff included");
  assert.ok(mmm > zzz, `second-largest after the largest (zzz=${zzz}, mmm=${mmm})`);
  // ...and the budget stops before the smallest.
  assert.ok(!out.includes("AAA-"), "smallest file cut by the budget");
  assert.ok(out.length <= cap, `output stays within the cap (${out.length} <= ${cap})`);
});

test("aheadOfMainDiff handles binary files ('-' numstat) without crashing", async () => {
  const repo = makeRepo();
  const wt = await ensureWorktree(repo, "improve", "main");
  fs.writeFileSync(path.join(wt, "big.txt"), blob("BIG", 100)); // ~4KB — largest text change
  fs.writeFileSync(path.join(wt, "small.txt"), blob("SML", 50)); // ~2KB
  // A binary file's numstat line is "-\t-\tpath": the parser must treat it as size 0 (ranked
  // last), not crash or poison the ranking of text files.
  fs.writeFileSync(path.join(wt, "blob.bin"), Buffer.from(Array.from({ length: 128 }, (_, i) => i)));
  await commitAll(wt, "mixed change");

  const cap = 5_500; // full diff is ~6.5KB: over the cap, room for big.txt only.
  const out = await aheadOfMainDiff(wt, "main", cap);

  assert.ok(out.startsWith("[diff truncated:"), `truncation note first:\n${out.slice(0, 200)}`);
  // The --stat section names the binary file and marks it as a binary change.
  assert.ok(out.includes("blob.bin"), "--stat lists blob.bin");
  assert.match(out, /Bin 0 ->/);
  // The largest text file's diff is still in — the '-' entry did not displace it...
  assert.ok(out.includes("BIG-"), "largest text file's diff included despite the binary entry");
  // ...and the budget stops before the smaller files (the size-0 binary ranks after them).
  assert.ok(!out.includes("SML-"), "budget stops before the smaller files");
  assert.ok(out.length <= cap);
});

/** Install a logging `git` shim at the front of PATH that appends each invocation's args
 * to `logFile` before exec'ing the real git (so behavior stays correct). Returns a restore
 * function. Lets a test assert exactly which subprocesses a code path spawned — the same
 * PATH technique fakePi uses for pi. */
function loggingGit(logFile: string): () => void {
  const dir = tmpdir("fake-git-");
  const bin = path.join(dir, "git");
  const real = execFileSync("which", ["git"], { encoding: "utf8" }).trim().split("\n")[0];
  fs.writeFileSync(bin, `#!/bin/sh\necho "$@" >> ${logFile}\nexec "${real}" "$@"\n`);
  fs.chmodSync(bin, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath}`;
  return () => {
    process.env.PATH = oldPath;
  };
}

test("abortSync spawns no git when nothing is in progress", async () => {
  const repo = makeRepo();
  const wt = await ensureWorktree(repo, "dry", "main");
  const logFile = path.join(tmpdir(), "git-calls.log");
  const restore = loggingGit(logFile);
  try {
    await abortSync(wt); // Clean worktree: the file check must short-circuit both spawns.
  } finally {
    restore();
  }
  assert.ok(!fs.existsSync(logFile), "abortSync spawned git on a clean worktree");
});

test("abortSync still aborts an interrupted rebase when state exists", async () => {
  const repo = makeRepo();
  const wt = await ensureWorktree(repo, "dry", "main");
  // Leave a conflicting rebase in progress (a killed tick mid-resolution), no shim yet.
  fs.writeFileSync(path.join(wt, "seed.txt"), "branch version\n");
  await commitAll(wt, "branch seed edit");
  fs.writeFileSync(path.join(repo, "seed.txt"), "main version\n");
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "main seed edit");
  assert.equal(await rebaseOntoMainLeaveConflicts(wt, "main"), "conflict");

  const logFile = path.join(tmpdir(), "git-calls.log");
  const restore = loggingGit(logFile);
  try {
    await abortSync(wt);
  } finally {
    restore();
  }
  // The old spawn-based behavior is preserved when state exists: both aborts run.
  const calls = fs.readFileSync(logFile, "utf8");
  assert.match(calls, /merge --abort/);
  assert.match(calls, /rebase --abort/);
  // And the rebase was actually aborted: the worktree is back to its pre-rebase content.
  assert.equal(fs.readFileSync(path.join(wt, "seed.txt"), "utf8"), "branch version\n");
});

// A linked worktree's .git is a one-line pointer file. If it is corrupted (truncated write,
// stale path after outside maintenance), the file check cannot tell whether a merge or rebase
// is in progress — abortSync must then fall back to spawning both aborts instead of skipping
// them, or an interrupted tick would wedge on "you are already rebasing" forever.
test("abortSync falls back to spawns when the worktree .git pointer is uncertain", async () => {
  const repo = makeRepo();
  for (const [label, pointer] of [
    ["malformed line", "not a gitdir pointer\n"],
    ["empty target", "gitdir:\n"],
    ["missing target dir", `gitdir: ${path.join(tmpdir(), "gone")}\n`],
  ] as const) {
    const wt = await ensureWorktree(repo, label.replace(/\s+/g, "-"), "main");
    fs.writeFileSync(path.join(wt, ".git"), pointer);
    const logFile = path.join(tmpdir(), "git-calls.log");
    const restore = loggingGit(logFile);
    try {
      await abortSync(wt); // Must not throw: the spawned aborts fail on the broken repo.
    } finally {
      restore();
    }
    const calls = fs.readFileSync(logFile, "utf8");
    assert.match(calls, /merge --abort/, `${label}: merge --abort was skipped`);
    assert.match(calls, /rebase --abort/, `${label}: rebase --abort was skipped`);
  }
});

test("abortSync detects in-progress state from a primary checkout's .git dir", async () => {
  const repo = makeRepo();
  // Leave a conflicting merge in progress on the primary checkout (a killed tick mid-merge).
  sh(repo, "git", "checkout", "-b", "side");
  fs.writeFileSync(path.join(repo, "seed.txt"), "side\n");
  sh(repo, "git", "commit", "-am", "side edit");
  sh(repo, "git", "checkout", "main");
  fs.writeFileSync(path.join(repo, "seed.txt"), "main2\n");
  sh(repo, "git", "commit", "-am", "main edit");
  try {
    sh(repo, "git", "merge", "side"); // Conflicts on seed.txt; the nonzero exit is expected.
  } catch {
    // The conflict is the point: MERGE_HEAD now exists under .git/.
  }
  assert.ok(fs.existsSync(path.join(repo, ".git", "MERGE_HEAD")));

  const logFile = path.join(tmpdir(), "git-calls.log");
  const restore = loggingGit(logFile);
  try {
    await abortSync(repo); // .git is a directory: the file check must see MERGE_HEAD.
  } finally {
    restore();
  }
  const calls = fs.readFileSync(logFile, "utf8");
  assert.match(calls, /merge --abort/);
  assert.match(calls, /rebase --abort/);
  // And the merge was actually aborted: MERGE_HEAD is gone.
  assert.ok(!fs.existsSync(path.join(repo, ".git", "MERGE_HEAD")), "merge was not aborted");
});

test("abortSync falls back to spawns when .git is missing entirely", async () => {
  const dir = tmpdir(); // Not a repo at all: the file check cannot inspect anything.
  const logFile = path.join(tmpdir(), "git-calls.log");
  const restore = loggingGit(logFile);
  try {
    await abortSync(dir); // Must not throw: both spawned aborts fail harmlessly.
  } finally {
    restore();
  }
  const calls = fs.readFileSync(logFile, "utf8");
  assert.match(calls, /merge --abort/);
  assert.match(calls, /rebase --abort/);
});

test("readBranchHead returns null for missing refs, bad content, and non-repos", () => {
  const repo = makeRepo();
  assert.equal(readBranchHead(repo, "nope"), null); // branch does not exist
  assert.equal(readBranchHead(tmpdir(), "main"), null); // no .git at all

  // Malformed loose content with no packed fallback: reject rather than return garbage.
  const loose = path.join(repo, ".git", "refs", "heads", "main");
  fs.writeFileSync(loose, "not-a-sha\n");
  assert.equal(readBranchHead(repo, "main"), null);

  // A worktree-pointer .git file is not a gitdir: the spawn fallback handles those.
  const wt = tmpdir();
  fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(repo, ".git", "worktrees", "x")}\n`);
  assert.equal(readBranchHead(wt, "main"), null);
});
