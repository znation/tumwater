import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ensureDetachedWorktree } from "../src/worktree.js";
import { mirrorWorktreePath } from "../src/paths.js";
import { makeRepo, sh } from "./repo-fixtures.js";

// The mirror-worktree helper (src/worktree.ts): pin a detached worktree at a ref and re-point an
// existing one, discarding dirt. Moved here from test/redeploy.test.ts, where it was filed with
// the redeployer instead of beside the module it tests.

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
