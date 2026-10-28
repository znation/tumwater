// --- retire and the merge ref: an unmerged pin blocks, a legacy-named pin is cleaned up ---
// test/operator-retire.test.ts pins the merged-pin case that must not block; these two cover
// the merge-ref paths that guard work or clean up state: an unmerged pin with the branch
// sitting at main, and a pin under the legacy name.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { branchName, legacyLandingRefName, mergeRefName, worktreePath } from "../src/paths.js";
import { collectRetire, retireRole } from "../src/operator/operator-retire.js";
import { mergeRefExists } from "./fixtures/orchestrator-fixtures.js";
import { initializedWorktree, mainSha, sh } from "./fixtures/repo-fixtures.js";
import { branchHead, refSha, setRef } from "../src/git/git.js";
import { disableRole } from "./helpers/disable-role.js";

test("retire refuses a merge ref pinning an unmerged commit while the branch sits at main", async () => {
  const { root } = await initializedWorktree();
  disableRole(root, "improve");
  const tree = sh(root, "git", "rev-parse", "HEAD^{tree}").trim();
  const commit = sh(root, "git", "commit-tree", tree, "-p", "HEAD", "-m", "unmerged").trim();
  await setRef(root, mergeRefName("improve"), commit);

  assert.equal(await branchHead(root, branchName("improve")), mainSha(root), "the pin is the only unmerged work");
  assert.equal((await collectRetire(root, "improve")).aheadOfMain, 1);
  await assert.rejects(retireRole(root, "improve", {}), /unmerged commit/);
  assert.equal(mergeRefExists(root, "improve"), true, "merge ref kept");
  assert.notEqual(await branchHead(root, branchName("improve")), null, "branch kept");
  assert.ok(fs.existsSync(worktreePath(root, "improve")), "worktree kept");
});

test("retire reports and deletes a legacy-named merge ref that is the role's only pin", async () => {
  const { root } = await initializedWorktree();
  disableRole(root, "improve");
  await setRef(root, legacyLandingRefName("improve"), mainSha(root));

  assert.equal((await collectRetire(root, "improve")).mergeRefPresent, true);
  const result = await retireRole(root, "improve", {});
  assert.ok(result.removed.includes("mergeRef"), `removed: ${result.removed.join(",")}`);
  assert.equal(await refSha(root, legacyLandingRefName("improve")), null);
});

