import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  conflictedFiles,
  continueRebase,
  hasConflictMarkers,
  rebaseOntoMain,
  rebaseOntoMainLeaveConflicts,
} from "../src/landing/landing-git.js";
import { assertClean, commitIn, initializedWorktree, sh } from "./repo-fixtures.js";

// Behavioral coverage for the landing flow's git plumbing (landing-git.ts). The export pin in
// landing-merge.test.ts only checks that these helpers exist; these tests drive real rebases,
// conflicts, and continuations — the mechanics a half-broken helper would silently break.

/** A repo whose main and worktree branch both edited the same file — the next rebase onto
 * main must stop mid-conflict. */
async function conflictingSetup(): Promise<{ root: string; wt: string }> {
  const { root, wt } = await initializedWorktree();
  // Both sides edit seed.txt, which exists in the fork-point commit — a content conflict
  // (UU), not an add/add conflict (AA), so the assertions name the classic spelling.
  fs.writeFileSync(path.join(root, "seed.txt"), "main line\n");
  commitIn(root, "main edit");
  fs.writeFileSync(path.join(wt, "seed.txt"), "branch line\n");
  commitIn(wt, "branch edit");
  return { root, wt };
}

/** No merge or rebase left in progress and the worktree back on its committed branch state. */
function assertWorktreeSettled(wt: string): void {
  assertClean(wt, "worktree clean, no rebase in progress");
}

test("conflictedFiles is empty on a clean worktree", async () => {
  const { wt } = await initializedWorktree();
  assert.deepEqual(await conflictedFiles(wt), []);
});

test("conflictedFiles lists the unmerged path during a conflicted rebase", async () => {
  const { wt } = await conflictingSetup();
  assert.equal(await rebaseOntoMainLeaveConflicts(wt, "main"), "conflict");
  assert.deepEqual(await conflictedFiles(wt), ["seed.txt"]);
  // The worktree really is mid-rebase: the conflicted file shows as unmerged (UU).
  assert.match(sh(wt, "git", "status", "--porcelain"), /UU seed\.txt/);
});

test("conflictedFiles decodes the C-quoted name of a non-ASCII conflicted file", async () => {
  // core.quotePath is on by default: `git diff --name-only --diff-filter=U` renders the
  // conflicted name as `"h\303\251llo.md"`. Undecoded, hasConflictMarkers could never read
  // the file and continueRebase would commit the markers to main (the bug the decode exists
  // for) — so the decoded, on-disk form is the contract.
  const { root, wt } = await initializedWorktree();
  fs.writeFileSync(path.join(root, "héllo.md"), "main line\n");
  commitIn(root, "main edit");
  fs.writeFileSync(path.join(wt, "héllo.md"), "branch line\n");
  commitIn(wt, "branch edit");
  assert.equal(await rebaseOntoMainLeaveConflicts(wt, "main"), "conflict");
  assert.deepEqual(await conflictedFiles(wt), ["héllo.md"]);
  assert.equal(hasConflictMarkers(wt, await conflictedFiles(wt)), true);
});

test("rebaseOntoMainLeaveConflicts returns clean when main has not moved", async () => {
  const { wt } = await initializedWorktree();
  fs.writeFileSync(path.join(wt, "hello.txt"), "hi\n");
  commitIn(wt, "branch work");
  assert.equal(await rebaseOntoMainLeaveConflicts(wt, "main"), "clean");
  assertWorktreeSettled(wt);
});

test("rebaseOntoMainLeaveConflicts returns failed and cleans up when the rebase cannot start", async () => {
  // An unstaged edit to a tracked file makes `git rebase` refuse before any conflict exists:
  // conflictedFiles is empty, so the state is "other" → abort and report "failed".
  const { wt } = await initializedWorktree();
  fs.writeFileSync(path.join(wt, "seed.txt"), "dirty\n");
  assert.equal(await rebaseOntoMainLeaveConflicts(wt, "main"), "failed");
  // The abort cleaned up the rebase state, not the working tree: the edit that blocked it
  // is still there, but no rebase is in progress and no path is unmerged.
  assert.equal(sh(wt, "git", "status").includes("rebase in progress"), false);
  assert.deepEqual(await conflictedFiles(wt), []);
});

test("rebaseOntoMain returns false on a conflict and aborts, leaving the worktree settled", async () => {
  const { wt } = await conflictingSetup();
  const before = sh(wt, "git", "rev-parse", "HEAD");
  assert.equal(await rebaseOntoMain(wt, "main"), false);
  assertWorktreeSettled(wt);
  assert.equal(sh(wt, "git", "rev-parse", "HEAD"), before, "the branch is back at its original tip");
});

test("continueRebase finishes the rebase with the resolution and returns the new HEAD", async () => {
  const { wt } = await conflictingSetup();
  assert.equal(await rebaseOntoMainLeaveConflicts(wt, "main"), "conflict");
  fs.writeFileSync(path.join(wt, "seed.txt"), "merged line\n");
  const head = await continueRebase(wt);
  assert.equal(head, sh(wt, "git", "rev-parse", "HEAD"));
  assert.equal(fs.readFileSync(path.join(wt, "seed.txt"), "utf8"), "merged line\n");
  assertWorktreeSettled(wt);
  // The rebase kept history linear: the resolved commit now sits on top of main's tip.
  assert.equal(sh(wt, "git", "rev-parse", "HEAD~1"), sh(wt, "git", "rev-parse", "main"));
});

test("continueRebase finishes cleanly when the resolution leaves no unique content", async () => {
  // Taking main's side makes the branch's patch empty: git skips the commit and finishes the
  // rebase — continueRebase must return the HEAD without error, not throw.
  const { wt } = await conflictingSetup();
  assert.equal(await rebaseOntoMainLeaveConflicts(wt, "main"), "conflict");
  fs.writeFileSync(path.join(wt, "seed.txt"), "main line\n");
  const head = await continueRebase(wt);
  assert.equal(head, sh(wt, "git", "rev-parse", "HEAD"));
  assertWorktreeSettled(wt);
});

test("hasConflictMarkers sees start/end markers but not a bare ======= separator", async () => {
  // Only `<<<<<<<`/`>>>>>>>` at a line start count: a bare `=======` is legitimate content
  // (a markdown setext underline), and flagging it would reject clean resolutions forever.
  const { wt } = await initializedWorktree();
  fs.writeFileSync(path.join(wt, "marked.txt"), "a\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\nb\n");
  assert.equal(hasConflictMarkers(wt, ["marked.txt"]), true);
  fs.writeFileSync(path.join(wt, "marked.txt"), "title\n=======\nbody\n");
  assert.equal(hasConflictMarkers(wt, ["marked.txt"]), false);
  // A path not on disk counts as resolved (the resolver chose the deletion).
  assert.equal(hasConflictMarkers(wt, ["gone.txt"]), false);
  assert.equal(hasConflictMarkers(wt, []), false);
});
