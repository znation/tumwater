import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { commitAll } from "../src/git/git.js";
import { ensureWorktree } from "../src/git/worktree.js";
import { continueRebase, rebaseOntoMainLeaveConflicts } from "../src/merge/merge-git.js";
import { setEnv } from "./helpers/env.js";
import { makeRepo, seedCommit, sh } from "./fixtures/repo-fixtures.js";

/** `%an <%ae>|%cn <%ce>` — the commit's stored author then committer, pipe-separated so the
 * whole identity pair asserts on one line. `--no-mailmap` reads the stored identity instead of
 * applying any ambient mailmap rewrite, so the assertion pins what the commit actually carries
 * whatever git config the test process inherited. */
function identLine(dir: string): string {
  return sh(dir, "git", "--no-pager", "log", "--no-mailmap", "-1", "--format=%an <%ae>|%cn <%ce>");
}

test("harness commits author as tumwater and commit as the ambient identity", async () => {
  const repo = makeRepo(); // fixture identity: test <test@example.com>
  fs.writeFileSync(path.join(repo, "new.txt"), "hi\n");
  await commitAll(repo, "tumwater(improve): add new.txt");
  assert.equal(identLine(repo), "tumwater <tumwater@localhost>|test <test@example.com>");
});

test("harness commits fall back to tumwater for the committer too when no identity is configured", async () => {
  const repo = makeRepo();
  // Drop the fixture's local identity entirely…
  sh(repo, "git", "config", "--remove-section", "user");
  // …and hide any global/system identity so git finds none at all.
  const restoreGlobal = setEnv("GIT_CONFIG_GLOBAL", "/nonexistent-tumwater-global");
  const restoreSystem = setEnv("GIT_CONFIG_SYSTEM", "/nonexistent-tumwater-system");
  try {
    fs.writeFileSync(path.join(repo, "new.txt"), "hi\n");
    await commitAll(repo, "tumwater(improve): add new.txt");
    // No ambient identity means both sides read tumwater — ticks still work with no config.
    assert.equal(identLine(repo), "tumwater <tumwater@localhost>|tumwater <tumwater@localhost>");
  } finally {
    restoreGlobal();
    restoreSystem();
  }
});

test("rebase and continueRebase re-stamp the committer and keep the tumwater author", async () => {
  const repo = makeRepo();
  const wt = await ensureWorktree(repo, "clean", "main");

  fs.writeFileSync(path.join(wt, "branch.txt"), "b\n");
  await commitAll(wt, "tumwater(improve): branch work");
  // Advance main so the rebase actually rewrites the branch's commit.
  seedCommit(repo, "main.txt", "m\n", "main advance");
  assert.equal(await rebaseOntoMainLeaveConflicts(wt, "main"), "clean");
  // The replayed commit keeps the tumwater author and gains the ambient committer.
  assert.equal(identLine(wt), "tumwater <tumwater@localhost>|test <test@example.com>");

  // continueRebase (a conflicted rebase concluded by hand) re-stamps the same way.
  const wt2 = await ensureWorktree(repo, "branch2", "main");
  // The branch side carries the tumwater author; the main side (plain fixture commit) does not.
  fs.writeFileSync(path.join(wt2, "seed.txt"), "branch version\n");
  await commitAll(wt2, "tumwater(improve): branch seed edit");
  seedCommit(repo, "seed.txt", "main version\n", "main seed edit");
  assert.equal(await rebaseOntoMainLeaveConflicts(wt2, "main"), "conflict");
  fs.writeFileSync(path.join(wt2, "seed.txt"), "combined version\n");
  await continueRebase(wt2);
  assert.equal(identLine(wt2), "tumwater <tumwater@localhost>|test <test@example.com>");
});
