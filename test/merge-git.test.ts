import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { errnoError, patchFsMethod } from "./helpers/fs-faults.js";
import { spawnLockHolder, stopChild } from "./helpers/child-process.js";
import {
  conflictedFileHunks,
  conflictedFiles,
  conflictMarkerReason,
  continueRebase,
  ffMainTo,
  ffMainToOrWhy,
  hasConflictMarkers,
  mainCommitsTouching,
  overwriteBlockedReason,
  primaryCheckoutBlockers,
  overwriteBlockers,
  rebaseOntoMain,
  rebaseOntoMainLeaveConflicts,
} from "../src/merge/merge-git.js";
import { primaryWorktreeLockPath } from "../src/paths.js";
import { assertWorktreeSettled, commitIn, headSha, initializedWorktree, sh } from "./fixtures/repo-fixtures.js";
import { UNSTARTABLE_GIT_ARG, withUnreadableIndex } from "./helpers/git-faults.js";
import { gitCouldNotStart } from "../src/git/git-run.js";

// Behavioral coverage for the merge flow's git plumbing (merge-git.ts). The export pin in
// merge-to-main.test.ts only checks that these helpers exist; these tests drive real rebases,
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

test("conflictedFiles throws when git cannot read the index, rather than reporting no conflicts", async () => {
  // Read as "no conflicts", the resolver's caller went straight to continueRebase, which stages
  // every marker, and a revision's stopped pick went down the path that deletes its ref.
  const { wt } = await conflictingSetup();
  assert.equal(await rebaseOntoMainLeaveConflicts(wt, "main"), "conflict");
  await withUnreadableIndex(wt, () =>
    assert.rejects(conflictedFiles(wt), /git diff --name-only --diff-filter=U failed/),
  );
  assert.deepEqual(await conflictedFiles(wt), ["seed.txt"]);
});

test("a rebase git could not start throws, rather than reading as a conflict or a failed rebase", async () => {
  const { wt } = await initializedWorktree();
  fs.writeFileSync(path.join(wt, "hello.txt"), "hi\n");
  commitIn(wt, "branch work");
  const before = headSha(wt);
  // The rebase's own spawn fails; the conflict listing after it would run and find nothing.
  await assert.rejects(rebaseOntoMain(wt, UNSTARTABLE_GIT_ARG), (err) => gitCouldNotStart(err));
  await assert.rejects(rebaseOntoMainLeaveConflicts(wt, UNSTARTABLE_GIT_ARG), (err) => gitCouldNotStart(err));
  assertWorktreeSettled(wt);
  assert.equal(headSha(wt), before);
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
  const before = headSha(wt);
  assert.equal(await rebaseOntoMain(wt, "main"), false);
  assertWorktreeSettled(wt);
  assert.equal(headSha(wt), before, "the branch is back at its original tip");
});

test("continueRebase finishes the rebase with the resolution and returns the new HEAD", async () => {
  const { wt } = await conflictingSetup();
  assert.equal(await rebaseOntoMainLeaveConflicts(wt, "main"), "conflict");
  fs.writeFileSync(path.join(wt, "seed.txt"), "merged line\n");
  const head = await continueRebase(wt);
  assert.equal(head, headSha(wt));
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
  assert.equal(head, headSha(wt));
  assertWorktreeSettled(wt);
});

test("mainCommitsTouching lists only main commits touching the given files, newest first", async () => {
  const { root, wt } = await initializedWorktree();
  const fork = headSha(wt);
  fs.writeFileSync(path.join(root, "touched.txt"), "one\n");
  commitIn(root, "main touch one");
  fs.writeFileSync(path.join(root, "other.txt"), "other\n");
  commitIn(root, "main other");
  fs.writeFileSync(path.join(root, "touched.txt"), "two\n");
  commitIn(root, "main touch two");
  const { commits, omitted } = await mainCommitsTouching(wt, fork, "main", ["touched.txt"]);
  assert.deepEqual(
    commits.map((c) => c.subject),
    ["main touch two", "main touch one"],
    "only the commits that touched the conflicted file, newest first",
  );
  assert.ok(commits.every((c) => c.sha.length > 0), "each entry carries its short sha");
  assert.equal(omitted, 0);
});

test("mainCommitsTouching caps the list and the body, reporting what it dropped", async () => {
  const { root, wt } = await initializedWorktree();
  const fork = headSha(wt);
  for (let i = 0; i < 16; i++) {
    fs.writeFileSync(path.join(root, "touched.txt"), `line ${i}\n`);
    commitIn(root, `touch ${i}`);
  }
  // Newest commit: a 25-line body, to check the per-commit body cap too.
  const body = Array.from({ length: 25 }, (_, i) => `body line ${i}`).join("\n");
  fs.writeFileSync(path.join(root, "touched.txt"), "x\n");
  commitIn(root, `first subject\n\n${body}`);
  const { commits, omitted } = await mainCommitsTouching(wt, fork, "main", ["touched.txt"]);
  assert.equal(commits.length, 15, "the list is capped at 15");
  assert.equal(omitted, 2, "the two oldest commits are reported as omitted");
  assert.equal(commits[0]!.subject, "first subject", "newest first");
  const bodyLines = commits[0]!.body.split("\n");
  assert.equal(bodyLines.length, 21, "20 body lines kept plus the truncation note");
  assert.match(bodyLines[20]!, /5 more lines/);
});

test("mainCommitsTouching returns nothing for an empty file list", async () => {
  const { wt } = await initializedWorktree();
  assert.deepEqual(await mainCommitsTouching(wt, "HEAD", "main", []), { commits: [], omitted: 0 });
});

// The merger's half of the primary-worktree race: `tumwater bug` holds the shared lock while it
// reads and rewrites a backlog file, so the working-tree fast-forward must wait for that lock
// rather than merging under it. The child holds the lock and watches for the merge's merged.txt
// (an unlocked ff writes it immediately; a locked one waits for release), then records what it
// saw. The ref-push arm is not exercised here: it touches no working tree and takes no lock.
test("ffMainTo's working-tree arm waits for the primary-worktree lock a backlog writer holds", async () => {
  const { root, wt } = await initializedWorktree();
  fs.writeFileSync(path.join(wt, "merged.txt"), "merged\n");
  commitIn(wt, "merge candidate");
  const ref = headSha(wt);
  const lock = primaryWorktreeLockPath(root);
  const merged = path.join(root, "merged.txt");
  const ready = path.join(root, "child-ready");
  const marker = path.join(root, "child-marker");
  const holder = spawnLockHolder({
    lock,
    ready,
    withLock: "withStateLock",
    until: `fs.existsSync(${JSON.stringify(merged)})`,
    after: `fs.writeFileSync(${JSON.stringify(marker)}, until() ? "seen" : "not-seen");`,
  });
  try {
    await holder.ready;
    assert.equal(await ffMainTo(root, ref, "main"), true);
    await holder.exited;
    assert.equal(
      fs.readFileSync(marker, "utf8"),
      "not-seen",
      "the merge did not merge while a backlog writer held the primary-worktree lock",
    );
    assert.equal(fs.readFileSync(merged, "utf8"), "merged\n", "the merge completed after the lock was released");
  } finally {
    await stopChild(holder);
  }
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

test("hasConflictMarkers and conflictMarkerReason fail closed on a file that cannot be read", async () => {
  const { wt } = await initializedWorktree();
  fs.writeFileSync(path.join(wt, "clean.md"), "no markers\n");
  fs.writeFileSync(path.join(wt, "marked.md"), "a\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> b\n");
  fs.mkdirSync(path.join(wt, "sub"));
  const undo = patchFsMethod("readFileSync", (orig) => (...args) => {
    if (String(args[0]).endsWith("clean.md")) throw errnoError("EMFILE");
    return orig(...args);
  });
  try {
    assert.equal(hasConflictMarkers(wt, ["clean.md"]), true);
    assert.match(conflictMarkerReason(wt, ["clean.md"]) ?? "", /could not be read to check for conflict markers: clean\.md/);
    const both = conflictMarkerReason(wt, ["marked.md", "clean.md"]) ?? "";
    assert.match(both, /conflict markers remain in: marked\.md; could not be read to check for conflict markers: clean\.md/);
  } finally {
    undo();
  }
  // A directory (EISDIR) cannot hold a text marker.
  assert.equal(hasConflictMarkers(wt, ["sub"]), false);
});

test("does not follow a symlink out of the worktree", async () => {
  const { root, wt } = await initializedWorktree();
  // A hostile file outside the worktree holding a start marker: if the gate followed a symlink
  // to it, hasConflictMarkers would report a conflict that the change never wrote.
  const outside = path.join(root, "outside-marker.txt");
  fs.writeFileSync(outside, "a\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> b\n");
  fs.symlinkSync(outside, path.join(wt, "link.txt"));
  assert.equal(hasConflictMarkers(wt, ["link.txt"]), false);
  assert.equal(conflictMarkerReason(wt, ["link.txt"]), undefined);
  const hunks = conflictedFileHunks(wt, ["link.txt"]);
  assert.deepEqual(hunks, [{ path: "link.txt", hunks: [], more: 0 }]);
  // A real regular file's markers are still seen.
  fs.writeFileSync(path.join(wt, "real.txt"), "a\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> b\n");
  assert.equal(hasConflictMarkers(wt, ["real.txt"]), true);
});

test("ffMainToOrWhy names main having moved off the ref's base, with its new head", async () => {
  const { root, wt } = await initializedWorktree();
  fs.writeFileSync(path.join(wt, "branch.txt"), "b\n");
  commitIn(wt, "branch change");
  const ref = headSha(wt);
  fs.writeFileSync(path.join(root, "hand.txt"), "h\n");
  commitIn(root, "hand commit on main");
  const why = await ffMainToOrWhy(root, ref, "main");
  assert.match(why ?? "", /^main moved outside the merge lock \(now [0-9a-f]+ hand commit on main\)$/);
});

test("overwriteBlockers reads both of git's would-be-overwritten lists", () => {
  const err =
    "git merge --ff-only abc failed (1): error: Your local changes to the following files would be overwritten by merge:\n\tf.txt\n\tg.txt\nPlease commit your changes or stash them before you merge.\nerror: The following untracked working tree files would be overwritten by merge:\n\tnew.txt\nPlease move or remove them before you merge.\nAborting";
  assert.deepEqual(overwriteBlockers(err), { uncommitted: ["f.txt", "g.txt"], untracked: ["new.txt"] });
  assert.deepEqual(overwriteBlockers("fatal: not possible"), { uncommitted: [], untracked: [] });
});

test("overwriteBlockedReason lists at most 5 names per group", () => {
  const names = ["a", "b", "c", "d", "e", "f", "g"].map((n) => `${n}.txt`);
  assert.match(
    overwriteBlockedReason({ uncommitted: names, untracked: [] }),
    /\(uncommitted: a\.txt, b\.txt, c\.txt, d\.txt, e\.txt, \+2 more\)/,
  );
});

test("ffMainToOrWhy names the primary checkout's files the fast-forward would overwrite", async () => {
  const { root, wt } = await initializedWorktree();
  fs.writeFileSync(path.join(root, "shared.txt"), "s\n");
  commitIn(root, "add shared");
  sh(wt, "git", "reset", "--hard", "main");
  fs.writeFileSync(path.join(wt, "shared.txt"), "branch\n");
  fs.writeFileSync(path.join(wt, "fresh.txt"), "branch\n");
  commitIn(wt, "branch change");
  fs.writeFileSync(path.join(root, "shared.txt"), "dirty\n");
  fs.writeFileSync(path.join(root, "fresh.txt"), "dirty\n");
  const before = headSha(root);
  assert.equal(
    await ffMainToOrWhy(root, headSha(wt), "main"),
    "fast-forward failed: the merge would overwrite files in the primary checkout (uncommitted: shared.txt; untracked: fresh.txt) — commit, stash or remove them there",
  );
  assert.equal(headSha(root), before);
});

test("ffMainToOrWhy returns null when the fast-forward succeeds", async () => {
  const { root, wt } = await initializedWorktree();
  fs.writeFileSync(path.join(wt, "ok.txt"), "ok\n");
  commitIn(wt, "ok change");
  assert.equal(await ffMainToOrWhy(root, headSha(wt), "main"), null);
});

test("primaryCheckoutBlockers names only the dirty paths the merge changes", async () => {
  const { root, wt } = await initializedWorktree();
  fs.writeFileSync(path.join(root, "shared.txt"), "s\n");
  commitIn(root, "add shared");
  sh(wt, "git", "reset", "--hard", "main");
  fs.writeFileSync(path.join(wt, "shared.txt"), "branch\n");
  fs.writeFileSync(path.join(wt, "fresh.txt"), "branch\n");
  commitIn(wt, "branch change");
  const tip = headSha(wt);
  assert.equal(await primaryCheckoutBlockers(root, "main", tip), null);
  fs.writeFileSync(path.join(root, "shared.txt"), "dirty\n");
  fs.writeFileSync(path.join(root, "fresh.txt"), "dirty\n");
  fs.writeFileSync(path.join(root, "other.txt"), "dirty\n");
  assert.deepEqual(await primaryCheckoutBlockers(root, "main", tip), {
    uncommitted: ["shared.txt"],
    untracked: ["fresh.txt"],
  });
  sh(root, "git", "checkout", "-q", "-b", "side");
  assert.equal(await primaryCheckoutBlockers(root, "main", tip), null);
});

test("primaryCheckoutBlockers names a dirty non-ASCII path the merge changes", async () => {
  const { root, wt } = await initializedWorktree();
  fs.writeFileSync(path.join(wt, "café.txt"), "branch\n");
  commitIn(wt, "branch adds an accented file");
  fs.writeFileSync(path.join(root, "café.txt"), "dirty\n");
  assert.deepEqual(await primaryCheckoutBlockers(root, "main", headSha(wt)), {
    uncommitted: [],
    untracked: ["café.txt"],
  });
});
