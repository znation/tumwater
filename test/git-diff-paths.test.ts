// --- treeDiffFiles / aheadOfMainFiles: path lists the merge path trusts ---
// Real git throughout. Each test pins one guarantee a caller (exemptTreeDelta, the
// overwrite-blocker check) relies on and that a plausible refactor would silently break.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { aheadOfMainFiles, treeDiffFiles } from "../src/git/git-diff.js";
import { commitAll } from "../src/git/git.js";
import { ensureWorktree } from "../src/git/worktree.js";
import { makeRepo, seedCommit, sh } from "./fixtures/repo-fixtures.js";

test("treeDiffFiles is null for an unknown commit and empty for identical trees", async () => {
  const repo = makeRepo();
  assert.equal(await treeDiffFiles(repo, "deadbeef", "HEAD"), null);
  assert.deepEqual(await treeDiffFiles(repo, "HEAD", "HEAD"), []);
});

test("treeDiffFiles lists a moved file under both its old and its new path", async () => {
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo, "src"));
  seedCommit(repo, "src/x.ts", "export const x = 1;\n", "add x");
  fs.mkdirSync(path.join(repo, "docs"));
  sh(repo, "git", "mv", "src/x.ts", "docs/x.md");
  sh(repo, "git", "commit", "-m", "move");
  const files = await treeDiffFiles(repo, "HEAD~1", "HEAD");
  assert.deepEqual(files!.sort(), ["docs/x.md", "src/x.ts"]);
});

test("treeDiffFiles and aheadOfMainFiles decode a non-ASCII name to its real path", async () => {
  const repo = makeRepo();
  const wt = await ensureWorktree(repo, "improve", "main");
  fs.writeFileSync(path.join(wt, "héllo.md"), "hi\n");
  await commitAll(wt, "add");
  assert.deepEqual(await aheadOfMainFiles(wt, "main"), ["héllo.md"]);
  assert.deepEqual(await treeDiffFiles(wt, "main", "HEAD"), ["héllo.md"]);
});
