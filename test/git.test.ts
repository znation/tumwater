import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { aheadOfMainDiff, aheadOfMainFiles, changedFiles, unquotePorcelainPath } from "../src/git-diff.js";
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
  listBranches,
  patchId,
  readBranchHead,
  refSha,
  repoToplevel,
  branchExists,
  runGit,
  setRef,
  subjectsBetween,
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
import { mainSha, makeRepo, seedCommit, sh, tmpdir } from "./repo-fixtures.js";

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
  seedCommit(repo, "seed.txt", "main version\n", "main seed edit");
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
  seedCommit(repo, "seed.txt", "main version\n", "main seed edit");
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
  seedCommit(repo, "seed.txt", "main version\n", "main seed edit");

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

  fs.writeFileSync(path.join(wt, "seed.txt"), "branch version\n");
  await commitAll(wt, "branch seed edit");
  seedCommit(repo, "seed.txt", "main version\n", "main seed edit");

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
  seedCommit(repo, "seed.txt", "main version\n", "main seed edit");
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

  fs.writeFileSync(path.join(wt, "h\u00e9llo.ts"), "branch version\n");
  await commitAll(wt, "branch edit");
  seedCommit(repo, "h\u00e9llo.ts", "main version\n", "main edit");

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

  fs.writeFileSync(path.join(wt, name), "branch version\n");
  await commitAll(wt, "branch edit");
  seedCommit(repo, name, "main version\n", "main edit");

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

// --- changedFiles + commitPathsAndDiscardRest: the refusal path's git helpers (loop.ts) ---
// A refusing run may leave files with special characters in their names; changedFiles must
// hand back decoded paths that loop.ts can classify (.md filter) and feed straight back to
// `git add`, so these tests round-trip through real `git status --porcelain` output.

test("changedFiles is empty on a clean worktree", async () => {
  const repo = makeRepo();
  assert.deepEqual(await changedFiles(repo), []);
});

test("changedFiles lists modified, untracked, and deleted files by repo-relative path", async () => {
  const repo = makeRepo();
  seedCommit(repo, "gone.txt", "bye\n", "second");

  fs.rmSync(path.join(repo, "gone.txt")); // tracked, deleted
  fs.writeFileSync(path.join(repo, "seed.txt"), "edited\n"); // tracked, modified
  fs.mkdirSync(path.join(repo, "sub"));
  fs.writeFileSync(path.join(repo, "sub", "deep.md"), "nested\n"); // untracked, nested

  const files = await changedFiles(repo);
  // Porcelain v1 collapses an untracked directory into a single `?? sub/` entry — the
  // decoded form is still usable as-is by callers that feed paths back to git (`git add sub/`).
  assert.deepEqual(files.sort(), ["gone.txt", "seed.txt", "sub/"]);
});

test("changedFiles decodes C-quoted porcelain paths (quote, tab, newline, backslash, non-ASCII)", async () => {
  const repo = makeRepo();
  // Each name forces a different escape in git's C-quoting under core.quotePath.
  const names = [
    'qu"ote.md', // \"
    "tab\there.txt", // \t
    "new\nline.txt", // \n
    "back\\slash.txt", // \\\\
    "h\u00e9llo.md", // non-ASCII bytes → octal escapes
  ];
  for (const n of names) fs.writeFileSync(path.join(repo, n), "x\n");

  const files = await changedFiles(repo);
  assert.deepEqual(files.sort(), [...names].sort());
});

// Carriage return is a control character too: git C-quotes it as \r, and the decoded form
// must be the real on-disk path — changedFiles feeds it straight back to `git add` (the
// refusal path's commitPathsAndDiscardRest), so a misdecode stages nothing. The sibling
// escapes (\n, \t, \\, \", octal) are pinned by the test above; \r was not.
test("changedFiles decodes C-quoted carriage returns in filenames", async () => {
  const repo = makeRepo();
  const name = "car\rreturn.txt";
  fs.writeFileSync(path.join(repo, name), "x\n");

  const files = await changedFiles(repo);
  assert.deepEqual(files, [name]);
  // The decoded path is the real file on disk — not git's C-quoted form.
  assert.ok(fs.existsSync(path.join(repo, files[0] ?? "")));
});

// A staged rename is one `R  <from> -> <to>` line in plain porcelain, but changedFiles must
// report the path that exists on disk. Reading the whole field as one path returned the
// non-existent `old.md -> "h\303\251llo.md"`, which the refusal path's `.md` filter and
// `git add` could not use. The parse now reads git's -z format: destination first, origin in
// the following NUL-terminated record (which must be skipped, not read as a status line).
test("changedFiles reports a staged rename by its destination path, not the `from -> to` field", async () => {
  const repo = makeRepo();
  seedCommit(repo, "old.md", "note\n", "add note");
  sh(repo, "git", "mv", "old.md", "h\u00e9llo.md");

  const files = await changedFiles(repo);
  assert.deepEqual(files, ["h\u00e9llo.md"]);
  assert.ok(fs.existsSync(path.join(repo, files[0] ?? "")), "the reported path is on disk");
});

// Git's C-quoting has short escapes for four more control characters than \n/\t/\r — BEL
// (\a), backspace (\b), form feed (\f), and vertical tab (\v), all emitted by `git status
// --porcelain` for a filename containing the byte. They must decode to the control byte, not
// to the bare letter (the old default branch turned `\a` into "a", so the path no longer
// matched the file on disk).
test("changedFiles decodes C-quoted BEL/backspace/form-feed/vertical-tab filenames", async () => {
  const repo = makeRepo();
  const names = ["bell\x07here.md", "back\x08space.txt", "form\x0cfeed.txt", "vert\x0btab.txt"];
  for (const n of names) fs.writeFileSync(path.join(repo, n), "x\n");

  const files = await changedFiles(repo);
  assert.deepEqual(files.sort(), [...names].sort());
  for (const f of files) assert.ok(fs.existsSync(path.join(repo, f)), f);

  // The escape mapping itself, independent of git's output formatting.
  assert.equal(unquotePorcelainPath('"a\\ab"'), "a\x07b");
  assert.equal(unquotePorcelainPath('"a\\bb"'), "a\x08b");
  assert.equal(unquotePorcelainPath('"a\\fb"'), "a\x0cb");
  assert.equal(unquotePorcelainPath('"a\\vb"'), "a\x0bb");
});

// Defensive branches unquotePorcelainPath keeps for input git would never emit: a missing
// closing quote and unrecognized escapes must degrade to "keep as-is", not drop or mangle
// the entry — changedFiles/conflictedFiles feed whatever comes back straight back to git.
test("unquotePorcelainPath keeps malformed and unrecognized escapes as-is", () => {
  assert.equal(unquotePorcelainPath('"no closing quote'), '"no closing quote'); // end < 1
  assert.equal(unquotePorcelainPath('"a\\xb"'), "axb"); // \x: not an escape, kept literally
  assert.equal(unquotePorcelainPath('"a\\8b"'), "a8b"); // 8 is not an octal digit
  assert.equal(unquotePorcelainPath('"a\\1"'), "a1"); // truncated octal at the end: keep the digit
});

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

test("aheadOfMainDiff over the cap spawns only two git calls, not one per file", async () => {
  const repo = makeRepo();
  const wt = await ensureWorktree(repo, "perf", "main");
  // Several files so the old spawn-per-file behavior would have made many more than two
  // git invocations (full diff + numstat + stat + one per file until the budget ran out).
  for (const [name, lines] of [
    ["one.txt", 400],
    ["two.txt", 300],
    ["three.txt", 200],
  ] as const) fs.writeFileSync(path.join(wt, name), blob(name.toUpperCase().slice(0, 3), lines));
  await commitAll(wt, "several big files");

  const logFile = path.join(tmpdir(), "git-calls.log");
  const restore = loggingGit(logFile);
  try {
    // Cap far below the full diff so the truncation path runs.
    await aheadOfMainDiff(wt, "main", 10_000);
  } finally {
    restore();
  }
  const calls = fs.readFileSync(logFile, "utf8").trim().split("\n");
  // Exactly the full diff and its --stat — no numstat, no per-file re-diffs.
  assert.equal(calls.length, 2, `expected 2 git spawns, got ${calls.length}: ${calls.join(" | ")}`);
  assert.ok(calls.some((c) => c === "diff main...HEAD"), "full diff was fetched");
  assert.ok(calls.some((c) => c === "diff --stat main...HEAD"), "--stat was fetched");
});

/** Install a logging `git` shim at the front of PATH that appends each invocation's args
 * to `logFile` before exec'ing the real git (so behavior stays correct). Returns a restore
 * function. Lets a test assert exactly which subprocesses a code path spawned — the same
 * PATH technique fakePi uses for pi. */
function loggingGit(logFile: string): () => void {
  const dir = tmpdir("fake-git-");
  const real = execFileSync("which", ["git"], { encoding: "utf8" }).trim().split("\n")[0];
  writeScript(path.join(dir, "git"), `echo "$@" >> ${logFile}\nexec "${real}" "$@"`);
  return pathPrepend(dir);
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
  seedCommit(repo, "seed.txt", "main version\n", "main seed edit");
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

// --- aheadOfMainFiles: the file list the review gate and merge path see, and commitMessage:
// the full-message read leftover recovery uses. Neither had any direct test before 2026-09-25.

test("aheadOfMainFiles lists the files the branch's commits change", async () => {
  const repo = makeRepo();
  const wt = await ensureWorktree(repo, "improve", "main");
  fs.writeFileSync(path.join(wt, "new.txt"), "added\n");
  fs.appendFileSync(path.join(wt, "seed.txt"), "more\n");
  await commitAll(wt, "branch change");
  assert.deepEqual((await aheadOfMainFiles(wt, "main")).sort(), ["new.txt", "seed.txt"]);
});

test("aheadOfMainFiles omits files only main gained after the branch forked (three-dot range)", async () => {
  const repo = makeRepo();
  const wt = await ensureWorktree(repo, "improve", "main");
  // Main moves after the worktree's branch was cut (what a long tick spans).
  fs.writeFileSync(path.join(repo, "main-only.txt"), "on main\n");
  await commitAll(repo, "main moves on");
  fs.writeFileSync(path.join(wt, "branch-only.txt"), "on branch\n");
  await commitAll(wt, "branch change");
  assert.deepEqual(await aheadOfMainFiles(wt, "main"), ["branch-only.txt"]);
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

test("commitMessage returns the full message and null for an unknown sha", async () => {
  const repo = makeRepo();
  const wt = await ensureWorktree(repo, "improve", "main");
  fs.writeFileSync(path.join(wt, "x.txt"), "x\n");
  const sha = await commitAll(wt, "subject line\n\nWHY: it matters\n");
  // git's %B drops the commit message's trailing newline when it prints it.
  assert.equal(await commitMessage(wt, sha), "subject line\n\nWHY: it matters");
  assert.equal(await commitMessage(wt, "0123456789abcdef0123456789abcdef01234567"), null);
});
