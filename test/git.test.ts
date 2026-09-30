import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { unquotePorcelainPath } from "../src/git-diff.js";
import {
  aheadOfMain,
  commitAll,
  commitMessage,
  commitPathsAndDiscardRest,
  currentBranch,
  deleteRef,
  hasCommits,
  headOf,
  isDirty,
  isGitRepo,
  isMergedInto,
  branchesPhrase,
  listBranches,
  patchId,
  readBranchHead,
  refSha,
  repoToplevel,
  branchExists,
  runGit,
  setRef,
  subjectsBetween,
  targetBranch,
} from "../src/git.js";
import {
  abortSync,
  ensureDetachedWorktree,
  ensureWorktree,
  resetWorktreeToMain,
} from "../src/worktree.js";
// The landing-flow git helpers live in landing-git.ts — moved there from landing-merge.ts (which
// got them from git.ts in the bugfix that completed the half-finished organize tick 78 move)
// once the lander and the batch lander started calling them directly.
import {
  conflictedFiles,
  continueRebase,
  ffMainTo,
  hasConflictMarkers,
  rebaseOntoMain,
  rebaseOntoMainLeaveConflicts,
} from "../src/landing-git.js";
import { branchName, mirrorWorktreePath } from "../src/paths.js";
import { pathPrepend, pathReplace, writeScript } from "./fake-commands.js";
import { loggingGit, mainSha, makeRepo, seedCommit, seedConflict, sh, tmpdir } from "./repo-fixtures.js";

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

test("currentBranch reads the HEAD file: symref, detached HEAD, and linked-worktree root", async () => {
  const repo = makeRepo();
  assert.equal(await currentBranch(repo), "main");
  // Detached HEAD stores a bare sha — null, exactly what `git symbolic-ref` reports.
  sh(repo, "git", "checkout", "--detach", "HEAD");
  assert.equal(await currentBranch(repo), null);
  // A linked worktree's root has a `gitdir:` pointer .git — the branch resolves through it.
  const wt = await ensureWorktree(repo, "clean", "main");
  assert.equal(await currentBranch(wt), branchName("clean"));
});

test("an unreadable HEAD file falls back to the spawn instead of throwing", async () => {
  const repo = makeRepo();
  // With the HEAD file gone the fast-path reader cannot answer, so the spawn decides:
  // `git symbolic-ref` fails on the HEAD-less repo and the caller gets the same null the
  // detached case reports — the every-poll branch watch must see "cannot tell", never a
  // thrown read error.
  const head = path.join(repo, ".git", "HEAD");
  const saved = fs.readFileSync(head, "utf8");
  fs.rmSync(head);
  assert.equal(await currentBranch(repo), null);
  fs.writeFileSync(head, saved);
  assert.equal(await currentBranch(repo), "main", "a restored HEAD answers from the file again");

  // The same through a linked worktree: the gitdir its .git pointer names has no HEAD, so
  // the read fails inside the pointed-at directory and the spawn decides there too.
  const wt = await ensureWorktree(repo, "clean", "main");
  const pointer = fs.readFileSync(path.join(wt, ".git"), "utf8").trim();
  const gitdir = path.resolve(wt, pointer.slice("gitdir:".length).trim());
  const wtHead = path.join(gitdir, "HEAD");
  const wtSaved = fs.readFileSync(wtHead, "utf8");
  fs.rmSync(wtHead);
  assert.equal(await currentBranch(wt), null);
  fs.writeFileSync(wtHead, wtSaved);
  assert.equal(await currentBranch(wt), branchName("clean"));
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

test("commitAll stages everything and ffMainTo lands it while root is on main", async () => {
  const repo = makeRepo();
  const wt = await ensureWorktree(repo, "improve", "main");
  fs.writeFileSync(path.join(wt, "new.txt"), "hi\n");
  assert.ok(await isDirty(wt));
  const commit = await commitAll(wt, "tumwater(improve): add new.txt");
  assert.ok(!(await isDirty(wt)));
  assert.equal(await aheadOfMain(wt, "main"), 1);

  assert.ok(await rebaseOntoMain(wt, "main"));
  assert.ok(await ffMainTo(repo, branchName("improve"), "main"));
  assert.equal(await headOf(repo, "main"), commit);
  // The primary checkout's working tree got the file too.
  assert.ok(fs.existsSync(path.join(repo, "new.txt")));
});

test("ffMainTo works via ref push when root is on another branch", async () => {
  const repo = makeRepo();
  sh(repo, "git", "checkout", "-b", "scratch");
  const wt = await ensureWorktree(repo, "improve", "main");
  fs.writeFileSync(path.join(wt, "other.txt"), "x\n");
  const commit = await commitAll(wt, "tumwater(improve): add other.txt");
  assert.ok(await ffMainTo(repo, branchName("improve"), "main"));
  assert.equal(await headOf(repo, "main"), commit);
});

// The landing-ref helpers (merge queue 2/5): refs/tumwater/landing/<role> pins a committed sha
// across the role branch's reset-to-main. setRef/deleteRef/refSha are the pin mechanics;
// isMergedInto tells recovery apart a stale pin from real work.
test("setRef creates and moves a ref; refSha reads it back", async () => {
  const repo = makeRepo();
  sh(repo, "git", "commit", "--allow-empty", "-m", "one");
  const first = sh(repo, "git", "rev-parse", "HEAD").trim();

  assert.equal(await refSha(repo, "refs/tumwater/landing/improve"), null, "absent before creation");
  await setRef(repo, "refs/tumwater/landing/improve", first);
  assert.equal(await refSha(repo, "refs/tumwater/landing/improve"), first);

  sh(repo, "git", "commit", "--allow-empty", "-m", "two");
  const second = sh(repo, "git", "rev-parse", "HEAD").trim();
  await setRef(repo, "refs/tumwater/landing/improve", second);
  assert.equal(await refSha(repo, "refs/tumwater/landing/improve"), second, "re-pinning moves the ref");
});

test("deleteRef removes a ref and is idempotent on an absent one", async () => {
  const repo = makeRepo();
  const sha = sh(repo, "git", "rev-parse", "HEAD").trim();
  await setRef(repo, "refs/tumwater/landing/improve", sha);

  await deleteRef(repo, "refs/tumwater/landing/improve");
  assert.equal(await refSha(repo, "refs/tumwater/landing/improve"), null);
  await assert.doesNotReject(() => deleteRef(repo, "refs/tumwater/landing/improve"));
});

test("isMergedInto is true for ancestors and equality, false otherwise", async () => {
  const repo = makeRepo();
  const base = sh(repo, "git", "rev-parse", "HEAD").trim();
  sh(repo, "git", "commit", "--allow-empty", "-m", "one");
  const one = sh(repo, "git", "rev-parse", "HEAD").trim();

  assert.ok(await isMergedInto(repo, base, "main"), "an ancestor counts as contained");
  assert.ok(await isMergedInto(repo, one, "main"), "the tip itself counts (equality)");

  // A commit on a side branch that main does not hold.
  sh(repo, "git", "checkout", "-b", "side");
  sh(repo, "git", "commit", "--allow-empty", "-m", "side work");
  const side = sh(repo, "git", "rev-parse", "HEAD").trim();
  assert.ok(!(await isMergedInto(repo, side, "main")), "unlanded work is not contained");
});

test("rebaseOntoMain resolves divergence and aborts cleanly on conflict", async () => {
  const repo = makeRepo();
  const wt = await ensureWorktree(repo, "clean", "main");

  // Non-conflicting divergence rebases.
  seedCommit(repo, "main-only.txt", "m\n", "main advance");
  fs.writeFileSync(path.join(wt, "branch-only.txt"), "b\n");
  await commitAll(wt, "branch work");
  assert.ok(await rebaseOntoMain(wt, "main"));
  assert.ok(await ffMainTo(repo, branchName("clean"), "main"));

  // Conflicting divergence aborts and leaves the worktree usable.
  seedConflict(repo, wt);
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
  seedConflict(repo, wt);
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

  seedConflict(repo, wt);

  assert.equal(await rebaseOntoMainLeaveConflicts(wt, "main"), "conflict");
  fs.writeFileSync(path.join(wt, "seed.txt"), "combined version\n");
  const head = await continueRebase(wt);
  // The branch now sits on top of main with the resolution as its own commit.
  assert.equal(await aheadOfMain(wt, "main"), 1);
  assert.ok(fs.existsSync(path.join(repo, "seed.txt")));
  assert.match(sh(wt, "git", "log", "-1", "--format=%s"), /branch seed edit/);
  // The rebased commit is a plain (non-merge) commit.
  assert.equal(sh(wt, "git", "log", "-1", "--format=%P").split(" ").length, 1);
  assert.ok(await ffMainTo(repo, branchName("clean"), "main"));
  assert.equal(await headOf(repo, "main"), head);
});

test("continueRebase skips a resolution that leaves no unique content", async () => {
  const repo = makeRepo();
  const wt = await ensureWorktree(repo, "clean", "main");

  seedConflict(repo, wt);

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

// A non-ASCII conflicted filename arrives C-quoted from `git diff --name-only` (core.quotePath
// is on by default). Undecoded it does not exist on disk, so hasConflictMarkers could never
// read the file — an unresolved conflict in such a file passed the marker check and
// continueRebase committed its markers to main.
test("conflictedFiles decodes C-quoted paths for non-ASCII filenames", async () => {
  const repo = makeRepo();
  seedCommit(repo, "h\u00e9llo.ts", "base\n", "seed non-ascii file");
  const wt = await ensureWorktree(repo, "clean", "main");

  seedConflict(repo, wt, "h\u00e9llo.ts", "main edit", "branch edit");

  assert.equal(await rebaseOntoMainLeaveConflicts(wt, "main"), "conflict");
  const files = await conflictedFiles(wt);
  // The decoded name is the real path on disk — not git's C-quoted form.
  assert.deepEqual(files, ["h\u00e9llo.ts"]);
  assert.ok(fs.existsSync(path.join(wt, files[0] ?? "")));
  // And the marker check can actually read it: an unresolved conflict is detected.
  assert.ok(hasConflictMarkers(wt, files));
  await resetWorktreeToMain(wt, "main");
});

// git C-quotes a path with a quote, tab, newline, carriage return, or backslash and escapes
// each as \", \t, \n, \r, \\ — the escapes a real filename is most likely to need, and the
// ones an operator notices when conflictedFiles hands a mangled path back to the conflict
// resolver. The BEL/BS/FF/VT test above covers the rare control bytes; this one drives the
// common escapes through git's own output rather than hand-built strings.
test("conflictedFiles decodes C-quoted quote/tab/newline/CR/backslash filenames", async () => {
  const name = 'we"ird\tna\nnd\r\\me.md';
  const repo = makeRepo();
  seedCommit(repo, name, "base\n", "seed special-char file");
  const wt = await ensureWorktree(repo, "clean", "main");

  seedConflict(repo, wt, name, "main edit", "branch edit");

  assert.equal(await rebaseOntoMainLeaveConflicts(wt, "main"), "conflict");
  const files = await conflictedFiles(wt);
  // Every escape decodes back to the byte in the real filename, so the path exists on disk.
  assert.deepEqual(files, [name]);
  assert.ok(fs.existsSync(path.join(wt, files[0] ?? "")));
  assert.ok(hasConflictMarkers(wt, files), "the marker check can read the decoded path");
  await resetWorktreeToMain(wt, "main");

  // The mapping itself, spelled out so a regression names the exact escape it broke.
  assert.equal(unquotePorcelainPath('"a\\nb"'), "a\nb");
  assert.equal(unquotePorcelainPath('"a\\tb"'), "a\tb");
  assert.equal(unquotePorcelainPath('"a\\rb"'), "a\rb");
  assert.equal(unquotePorcelainPath('"a\\\\b"'), "a\\b");
  assert.equal(unquotePorcelainPath('"a\\"b"'), 'a"b');
});

test("readBranchHead matches git rev-parse across loose and packed refs", () => {
  const repo = makeRepo();
  // Fresh init keeps the branch as a loose ref.
  let head = mainSha(repo);
  assert.equal(readBranchHead(repo, "main"), head);

  // pack-refs moves main into packed-refs and deletes the loose file.
  sh(repo, "git", "pack-refs", "--all");
  assert.ok(!fs.existsSync(path.join(repo, ".git", "refs", "heads", "main")));
  assert.equal(readBranchHead(repo, "main"), head);

  // A new commit re-loosens the ref while packed-refs keeps the stale entry — loose wins.
  seedCommit(repo, "b.txt", "b\n", "second");
  head = mainSha(repo);
  assert.equal(readBranchHead(repo, "nope"), null); // unknown branch: null, not the stale sha
  assert.equal(readBranchHead(repo, "main"), head);
});

// --- commitPathsAndDiscardRest: the refusal path's commit (loop.ts) ---
// A refusing run's files arrive already decoded by changedFiles (test/git-diff.test.ts);
// these tests pin the staging half: commit only the classified paths, discard the rest.

test("commitPathsAndDiscardRest returns null without side effects when nothing is stageable", async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "note.md"), "n\n"); // untracked, not in the pathspec

  assert.equal(await commitPathsAndDiscardRest(repo, "m", []), null);
  assert.equal(await commitPathsAndDiscardRest(repo, "m", ["missing.md"]), null);
  // The early return must not discard anything: the caller decides what to do with the rest.
  assert.ok(fs.existsSync(path.join(repo, "note.md")), "untracked work survives a null result");
  assert.equal(await headOf(repo, "HEAD"), await headOf(repo, "main"), "no commit was made");
});

test("commitPathsAndDiscardRest returns null when the paths hold no changes", async () => {
  const repo = makeRepo();
  // seed.txt is tracked and untouched: `git add` succeeds but stages nothing.
  assert.equal(await commitPathsAndDiscardRest(repo, "m", ["seed.txt"]), null);
});

test("commitPathsAndDiscardRest commits only the given paths and discards every other change", async () => {
  const repo = makeRepo();
  seedCommit(repo, "notes.md", "old\n", "second");

  // A refusing run's leftovers: the objection note (md), a half-done code edit, and junk.
  fs.writeFileSync(path.join(repo, "notes.md"), "objection\n");
  fs.writeFileSync(path.join(repo, "seed.txt"), "tampered\n");
  fs.writeFileSync(path.join(repo, "junk.txt"), "half-done\n");

  const head = await commitPathsAndDiscardRest(repo, "tumwater(coverage): refuse — test", ["notes.md"]);
  assert.ok(head && /^[0-9a-f]{40}$/.test(head));
  assert.equal(await headOf(repo, "HEAD"), head);
  assert.match(sh(repo, "git", "log", "-1", "--format=%s"), /refuse — test/);

  // The note landed with its new content...
  assert.equal(fs.readFileSync(path.join(repo, "notes.md"), "utf8"), "objection\n");
  // ...and everything else was discarded: tracked edit reverted, untracked junk cleaned.
  assert.equal(fs.readFileSync(path.join(repo, "seed.txt"), "utf8"), "seed\n");
  assert.ok(!fs.existsSync(path.join(repo, "junk.txt")));
  assert.ok(!(await isDirty(repo)), "worktree is clean after the discard");
  // The test runs in a checkout that IS on main, so the note commit becomes main's new tip.
  assert.equal(await headOf(repo, "main"), head);
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

// --- runGit's error contract: a GitError must always say why when there is a why to say ---
// These messages surface verbatim as a loop's lastError on the dashboards (loop.ts records
// errorMessage(err) for any tick failure), so an unexplained "failed (ENOENT): " tail is what
// an operator actually reads.

test("runGit names the spawn failure when git cannot be started (empty stderr)", async () => {
  const repo = makeRepo();
  // A PATH holding no git: execFile then fails with code "ENOENT" and an EMPTY stderr —
  // pre-fix, `e.stderr ?? String(err)` kept the empty string and the message ended in ": ".
  const restorePath = pathReplace(tmpdir("no-git-"));
  try {
    await assert.rejects(
      runGit(repo, ["status"]),
      (err: unknown) =>
        err instanceof Error &&
        err.message === `git status failed (ENOENT): spawn git ENOENT`,
    );
  } finally {
    restorePath();
  }
});

test("runGit reports a silent nonzero exit by its code alone, with no dangling colon", async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "seed.txt"), "edited\n"); // unstaged change → diff --quiet exits 1 silently
  await assert.rejects(
    runGit(repo, ["diff", "--quiet"]),
    (err: unknown) => err instanceof Error && err.message === `git diff --quiet failed (1)`,
  );
});

test("runGit keeps git's stderr on a noisy nonzero exit (format unchanged)", async () => {
  const repo = makeRepo();
  await assert.rejects(
    runGit(repo, ["rev-parse", "--verify", "no-such-ref"]),
    (err: unknown) =>
      err instanceof Error && /^git rev-parse --verify no-such-ref failed \(128\): fatal: /.test(err.message),
  );
});

test("subjectsBetween lists main's subjects since a head, newest first; null for an unknown base", async () => {
  const repo = makeRepo(); // one seed commit on main
  const base = await headOf(repo, "main");
  seedCommit(repo, "a.txt", "1\n", "tumwater(feature): a");
  seedCommit(repo, "b.txt", "2\n", "tumwater(readme): b");
  seedCommit(repo, "c.txt", "3\n", "human commit c");
  assert.deepEqual(await subjectsBetween(repo, base, "main"), [
    "human commit c",
    "tumwater(readme): b",
    "tumwater(feature): a",
  ]);
  // Nothing landed since the tip → empty, not null.
  const tip = await headOf(repo, "main");
  assert.deepEqual(await subjectsBetween(repo, tip, "main"), []);
  // An unresolvable base yields null so callers fall back conservatively.
  assert.equal(
    await subjectsBetween(repo, "0000000000000000000000000000000000000000", "main"),
    null,
  );
});

// --- patchId (land-queue speed 2a: approvals keyed by the diff, not the sha) ---

/** A repo whose `side` branch edits line 6 of a ten-line file on top of main, checked out on
 * `side`. Returns the side head. */
function patchFixture(): { repo: string; side: string } {
  const repo = makeRepo();
  const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
  seedCommit(repo, "a.txt", lines.join("\n") + "\n", "ten lines");
  sh(repo, "git", "checkout", "-q", "-b", "side");
  fs.writeFileSync(path.join(repo, "a.txt"), lines.map((l, i) => (i === 5 ? "changed" : l)).join("\n") + "\n");
  sh(repo, "git", "commit", "-am", "side change");
  return { repo, side: sh(repo, "git", "rev-parse", "HEAD") };
}

/** Advance main by one commit that rewrites a.txt with `edit`, then return to `side`. */
function advanceMain(repo: string, edit: (text: string) => string): void {
  sh(repo, "git", "checkout", "-q", "main");
  const file = path.join(repo, "a.txt");
  fs.writeFileSync(file, edit(fs.readFileSync(file, "utf8")));
  sh(repo, "git", "commit", "-am", "main moves");
  sh(repo, "git", "checkout", "-q", "side");
}

test("patchId is the same for one diff at two shas: a clean rebase onto a moved main keeps it", async () => {
  const { repo, side } = patchFixture();
  const before = await patchId(repo, "main", side);
  assert.match(before ?? "", /^[0-9a-f]{40,64}$/);
  // Main grows above the hunk, outside its context: every line number shifts, the patch does not.
  advanceMain(repo, (t) => "new top 1\nnew top 2\n" + t);
  // The old head, against the moved main, still reads its own change (the merge-base range).
  assert.equal(await patchId(repo, "main", side), before);
  sh(repo, "git", "rebase", "-q", "main");
  const rebased = sh(repo, "git", "rev-parse", "HEAD");
  assert.notEqual(rebased, side, "the rebase rewrote the sha");
  assert.equal(await patchId(repo, "main", rebased), before, "same diff, same patch-id");
});

test("patchId differs when a rebase changes the patch: new context, or whitespace alone", async () => {
  const { repo, side } = patchFixture();
  const before = await patchId(repo, "main", side);
  // Main edits a line inside the hunk's context: the rebase is clean, the patch is not the same.
  advanceMain(repo, (t) => t.replace("line 4\n", "line four\n"));
  sh(repo, "git", "rebase", "-q", "main");
  assert.notEqual(await patchId(repo, "main", "HEAD"), before);

  // A whitespace-only difference in the added line is a different patch too (`--stable` would
  // strip it and match).
  const other = patchFixture();
  const base = await patchId(other.repo, "main", other.side);
  const file = path.join(other.repo, "a.txt");
  sh(other.repo, "git", "reset", "--hard", "main");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("line 6\n", "changed  \n"));
  sh(other.repo, "git", "commit", "-am", "side change, trailing spaces");
  assert.notEqual(await patchId(other.repo, "main", "HEAD"), base);
});

test("patchId is null, never a throw, when there is nothing to identify or git fails", async () => {
  const { repo, side } = patchFixture();
  assert.equal(await patchId(repo, "main", "main"), null, "an empty diff has no patch");
  assert.equal(await patchId(repo, "main", "0".repeat(40)), null, "an unknown head");
  assert.equal(await patchId(tmpdir(), "main", side), null, "not a repository");

  // `git patch-id` itself failing (a git too old for --verbatim, say): a shim git on PATH
  // passes everything through to the real one except patch-id, which dies.
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const bin = tmpdir();
  writeScript(
    path.join(bin, "git"),
    `if [ "$1" = patch-id ]; then echo 'unknown option' >&2; exit 129; fi\nexec '${realGit}' "$@"`,
  );
  const restore = pathPrepend(bin);
  try {
    assert.equal(await patchId(repo, "main", side), null, "a failed patch-id");
  } finally {
    restore();
  }
});

// --- repoToplevel / branchExists / listBranches (portability 2/7) ---

test("repoToplevel resolves the repo root from any subdirectory, and null outside a repo", async () => {
  const repo = makeRepo();
  const sub = path.join(repo, "src", "deep");
  fs.mkdirSync(sub, { recursive: true });
  // git resolves symlinks (macOS /var → /private/var), so compare real paths.
  assert.equal(await repoToplevel(sub), fs.realpathSync(repo), "a subdirectory resolves to the toplevel");
  assert.equal(await repoToplevel(repo), fs.realpathSync(repo));
  assert.equal(await repoToplevel(tmpdir()), null, "not a repository → null");
});

test("branchExists and listBranches answer from the refs, not the checkout", async () => {
  const repo = makeRepo();
  sh(repo, "git", "branch", "side");
  assert.equal(await branchExists(repo, "main"), true);
  assert.equal(await branchExists(repo, "side"), true);
  assert.equal(await branchExists(repo, "nope"), false);
  assert.deepEqual((await listBranches(repo)).sort(), ["main", "side"]);
  // An empty repo (no commits) still lists nothing without throwing.
  const empty = tmpdir();
  sh(empty, "git", "init", "-b", "main");
  assert.deepEqual(await listBranches(empty), []);
});

test('branchesPhrase is the comma-joined list a failed branch lookup names, "none" when bare', async () => {
  const bare = tmpdir();
  sh(bare, "git", "init", "-b", "main");
  assert.equal(await branchesPhrase(bare), "none", "no branches yet → the literal none");
  const repo = makeRepo();
  sh(repo, "git", "branch", "side");
  assert.equal(await branchesPhrase(repo), "main, side");
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
  assert.equal(sh(a, "git", "status", "--porcelain"), "", "the checkout is clean");
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

test("targetBranch applies the shared read-only precedence: baseBranch, checkout, main", () => {
  assert.equal(targetBranch("trunk", "feature"), "trunk", "a configured baseBranch wins");
  assert.equal(targetBranch(undefined, "feature"), "feature", "else the checked-out branch");
  assert.equal(targetBranch(undefined, null), "main", "detached HEAD degrades to the literal main");
  assert.equal(targetBranch(undefined, undefined), "main", "an unreadable HEAD degrades too");
});

test("commitMessage returns the full message and null for an unknown sha", async () => {
  const repo = makeRepo();
  const wt = await ensureWorktree(repo, "improve", "main");
  fs.writeFileSync(path.join(wt, "x.txt"), "x\n");
  const sha = await commitAll(wt, "subject line\n\nWHY: it matters\n");
  // git's %B drops the commit message's trailing newline when it prints it.
  assert.equal(await commitMessage(wt, sha), "subject line\n\nWHY: it matters");
  assert.equal(await commitMessage(wt, "0123456789abcdef0123456789abcdef01234567"), null);
});
