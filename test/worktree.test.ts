import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { aheadOfMain, commitAll, currentBranch, headOf, resolveGitDir } from "../src/git/git.js";
import {
  abortSync,
  ensureDetachedWorktree,
  ensureWorktree,
  resetWorktreeToMain,
} from "../src/git/worktree.js";
import { rebaseOntoMain, rebaseOntoMainLeaveConflicts } from "../src/landing/landing-git.js";
import { branchName, mirrorWorktreePath } from "../src/paths.js";
import { assertClean, loggingGit, mainSha, makeRepo, seedConflict, sh, tmpdir } from "./repo-fixtures.js";

// The worktree helpers (src/git/worktree.ts): role worktrees, the mirror's detached checkout,
// reset-to-main, and abortSync's interrupted-merge/rebase cleanup. The mirror test moved here
// from test/redeployer.test.ts, where it was filed with the redeployer instead of beside the
// module it tests; the ensureWorktree/resetWorktreeToMain/abortSync cluster moved here from
// test/git.test.ts, which had filed worktree.ts's tests under git.ts's name. The rebase calls
// some tests make come from landing-git.ts — they are fixtures that leave conflicting state,
// not the subjects under test.

test("ensureDetachedWorktree pins the mirror at a ref and re-points an existing one", async () => {
  const root = makeRepo();
  const first = sh(root, "git", "rev-parse", "HEAD");
  const dir = mirrorWorktreePath(root);
  assert.equal(await ensureDetachedWorktree(root, dir, first), dir);
  assert.equal(sh(dir, "git", "rev-parse", "HEAD"), first);
  fs.writeFileSync(path.join(root, "seed.txt"), "moved\n");
  sh(root, "git", "commit", "-q", "-am", "move main");
  const second = sh(root, "git", "rev-parse", "HEAD");
  fs.writeFileSync(path.join(dir, "stray.txt"), "stray"); // dirt in the mirror is discarded
  await ensureDetachedWorktree(root, dir, second);
  assert.equal(sh(dir, "git", "rev-parse", "HEAD"), second);
  assert.equal(fs.existsSync(path.join(dir, "stray.txt")), false);
  assert.equal(fs.readFileSync(path.join(dir, "seed.txt"), "utf8"), "moved\n");
});

test("ensureDetachedWorktree clears a stale index.lock left by a killed git", async () => {
  const repo = makeRepo();
  const head = sh(repo, "git", "rev-parse", "HEAD");
  const dir = mirrorWorktreePath(repo);
  await ensureDetachedWorktree(repo, dir, head);
  const lock = path.join(resolveGitDir(dir)!, "index.lock");
  fs.writeFileSync(lock, "");
  const agedSec = (Date.now() - 20 * 60 * 1000) / 1000; // older than the git-timeout bound
  fs.utimesSync(lock, agedSec, agedSec);

  await ensureDetachedWorktree(repo, dir, head);
  assert.equal(fs.existsSync(lock), false, "the stale lock is gone");
  assert.equal(sh(dir, "git", "rev-parse", "HEAD"), head, "the re-point completed");
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

// Concurrent setups in one repository: `git worktree add` creates its registration directory
// a moment before it writes the `locked` file that shields it from prune, so another setup's
// `worktree prune` landing in between deleted it and the add died — the landing pipeline's
// concurrent vets hit exactly that ("could not open '.git/worktrees/_land-alpha/locked' for
// writing") and dropped a queued change as an error. The harness serializes its own setups
// per repository; a burst like this one must register every worktree.
test("concurrent worktree setups in one repository all succeed (prune/add race)", async () => {
  const repo = makeRepo();
  const head = sh(repo, "git", "rev-parse", "HEAD");
  for (let round = 0; round < 2; round++) {
    await Promise.all([
      ...[0, 1, 2, 3, 4, 5].map((i) =>
        ensureDetachedWorktree(repo, path.join(repo, ".tumwater", "worktrees", `_land-${round}-${i}`), head),
      ),
      ...[0, 1, 2].map((i) => ensureWorktree(repo, `role-${round}-${i}`, "main")),
    ]);
  }
  assert.equal(sh(repo, "git", "worktree", "list").split("\n").length, 1 + 2 * 9, "every setup registered its worktree");
});

// The age reaper takes the gitignored `dist/` build dir inside a worktree, never the worktree
// root: the root is handed straight back to callers (and resetWorktreeToMain's caller keeps
// working in it), so reaping it by its own mtime — stale after a reused mirror sits untouched —
// deleted the very directory the function was about to return.
test("worktree reaping prunes an aged dist/ build dir and never the worktree root", async () => {
  const agedMs = (Date.now() - 8 * 24 * 3600 * 1000) / 1000;
  const age = (p: string) => fs.utimesSync(p, agedMs, agedMs);
  const touchDist = (dir: string) => {
    fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(dir, "dist", "old.js"), "stale\n");
  };

  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, ".gitignore"), "dist\n");
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-q", "-m", "ignore dist");
  const head = sh(repo, "git", "rev-parse", "HEAD");
  const dir = mirrorWorktreePath(repo);
  await ensureDetachedWorktree(repo, dir, head);
  touchDist(dir); // clean -fd leaves a gitignored dist/ behind, exactly the stale shape
  age(dir);
  age(path.join(dir, "dist"));
  await ensureDetachedWorktree(repo, dir, head);
  assert.ok(fs.existsSync(dir), "the worktree root survives its own aged mtime");
  assert.equal(fs.existsSync(path.join(dir, "dist")), false, "the aged dist/ build dir is reaped");
  assert.equal(sh(dir, "git", "rev-parse", "HEAD"), head, "the surviving worktree still holds the ref");

  // A young dist/ is live build output, not dead weight: it stays.
  const wt = await ensureWorktree(repo, "dry", "main");
  touchDist(wt);
  await resetWorktreeToMain(wt, "main");
  assert.ok(fs.existsSync(path.join(wt, "dist", "old.js")), "a young dist/ survives the reset");
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

// A git killed mid-write (the group deadline's SIGKILL, a crashed harness, an operator kill)
// leaves index.lock behind; every later `git reset --hard` then fails "Unable to create
// '…/index.lock': File exists" forever, wedging the loop. resetWorktreeToMain clears that
// wreckage before it resets — but must leave a *fresh* lock alone, since it may belong to a git
// still running.
test("resetWorktreeToMain clears a stale index.lock left by a killed git", async () => {
  const repo = makeRepo();
  const wt = await ensureWorktree(repo, "dry", "main");
  const gitdir = resolveGitDir(wt);
  assert.ok(gitdir, "the worktree's gitdir resolves");
  const lock = path.join(gitdir!, "index.lock");
  fs.writeFileSync(lock, "");
  const agedSec = (Date.now() - 20 * 60 * 1000) / 1000; // older than the git-timeout bound
  fs.utimesSync(lock, agedSec, agedSec);

  await resetWorktreeToMain(wt, "main");
  assert.equal(fs.existsSync(lock), false, "the stale lock is gone");
  assert.equal(await aheadOfMain(wt, "main"), 0, "the reset completed");
});

test("resetWorktreeToMain leaves a fresh index.lock alone and fails loudly", async () => {
  const repo = makeRepo();
  const wt = await ensureWorktree(repo, "dry", "main");
  const lock = path.join(resolveGitDir(wt)!, "index.lock");
  fs.writeFileSync(lock, ""); // a young lock may belong to a live git: never deleted

  await assert.rejects(
    () => resetWorktreeToMain(wt, "main"),
    /index\.lock/,
    "a live-looking lock still fails the reset rather than being silently removed",
  );
  assert.equal(fs.existsSync(lock), true, "the fresh lock survives");
});

test("resetWorktreeToMain clears an interrupted rebase", async () => {
  const repo = makeRepo();
  const wt = await ensureWorktree(repo, "dry", "main");
  seedConflict(repo, wt);
  // Start a conflicting rebase and leave it in progress (a killed tick mid-resolution).
  assert.equal(await rebaseOntoMainLeaveConflicts(wt, "main"), "conflict");
  await resetWorktreeToMain(wt, "main");
  assert.equal(await aheadOfMain(wt, "main"), 0);
  // The next sync works: no "you are already rebasing" wedge.
  fs.writeFileSync(path.join(wt, "seed.txt"), "fresh version\n");
  await commitAll(wt, "fresh work");
  assert.ok(await rebaseOntoMain(wt, "main"));
});

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
  seedConflict(repo, wt);
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

test("concurrent ensureWorktree calls serialize: the queued call adopts the worktree the first made", async () => {
  // Both callers probe a worktree that does not exist yet, so both enter serializeSetup;
  // the second queues behind the first and must find the worktree usable by its turn —
  // the queued-ahead branch the landing pipeline's concurrent vets once fell through
  // (two clear-and-add steps interleaving, the loser's vet a terminal error). Without
  // the serialization the two `worktree add` calls race and one of them fails.
  const repo = makeRepo();
  const first = ensureWorktree(repo, "clean", "main");
  const second = ensureWorktree(repo, "clean", "main");
  const [a, b] = await Promise.all([first, second]);
  assert.equal(b, a, "both callers get the same worktree path");
  assert.equal(await currentBranch(a), branchName("clean"), "the worktree is on its role branch");
  assert.ok(fs.existsSync(path.join(a, "seed.txt")), "the worktree holds main's tree");
  // Exactly one registration exists for the role: a lost race would leave a duplicate
  // (or a registration whose directory was pruned) behind.
  const list = sh(repo, "git", "worktree", "list", "--porcelain");
  const forRole = list.split("\n").filter((l) => l.startsWith("worktree ")).filter((l) => l.endsWith("/worktrees/clean"));
  assert.equal(forRole.length, 1, `exactly one registration for the role:\n${list}`);
});

test("concurrent ensureDetachedWorktree calls serialize and both resolve to the detached checkout", async () => {
  // The mirror's two first callers race the same way the role worktrees' do; the queued
  // one reports "not created by me" (false) and still falls through to the shared
  // checkout/reset tail, so both end on the exact ref with a clean tree.
  const repo = makeRepo();
  const head = mainSha(repo);
  const dir = mirrorWorktreePath(repo);
  const first = ensureDetachedWorktree(repo, dir, head);
  const second = ensureDetachedWorktree(repo, dir, head);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(b, a, "both callers get the same checkout");
  assert.equal(sh(a, "git", "rev-parse", "HEAD"), head, "checked out at the requested ref");
  assert.equal(await currentBranch(a), null, "the checkout is detached");
  assertClean(a, "the checkout is clean");
});

test("abortSync survives a worktree pointer whose target is not a directory", async () => {
  // A .git pointer file naming an existing-but-not-a-directory target leaves the
  // file-based merge/rebase state check uncertain: abortSync must fall back to running
  // the real aborts (which fail harmlessly here) instead of throwing — a corrupted
  // worktree must not break the tick that tries to clean it.
  const dir = tmpdir("stray-gitdir-");
  fs.writeFileSync(path.join(dir, ".git"), `gitdir: ${path.join(dir, "stray-file")}\n`);
  fs.writeFileSync(path.join(dir, "stray-file"), "a file, not a gitdir\n");
  await abortSync(dir); // must resolve, not throw
  assert.equal(
    fs.readFileSync(path.join(dir, "stray-file"), "utf8"),
    "a file, not a gitdir\n",
    "the fallback aborts touched nothing",
  );
});
