/** The worktree-use registry (src/git/worktree-use.ts, plans/disk-floor.md part 2/4): the
 * in-process in-use count, the durable last-used record, and the claim/release handshake that
 * keeps a `useWorktree` from starting in a half-cleaned tree. Candidate ordering built on the
 * registry is pinned in test/reclaim.test.ts. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  beginWorktreeUse,
  claimForReclaim,
  isReclaimInProgress,
  isWorktreeInUse,
  readWorktreeUse,
  releaseReclaim,
  useWorktree,
} from "../src/git/worktree-use.js";
import { worktreesDir } from "../src/paths.js";
import { tmpdir } from "./repo-fixtures.js";

/** A throwaway worktree-shaped directory, distinct per test so the process-global live map
 * never carries state across tests. */
function useDir(prefix: string): string {
  const dir = path.join(worktreesDir(tmpdir(prefix)), "feature");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test("useWorktree runs fn, releases once, and records lastUsedAt durably", async () => {
  const root = tmpdir("wt-use-record-");
  const dir = useDir("wt-use-record-wt-");
  const release = await beginWorktreeUse(root, dir);
  assert.equal(isWorktreeInUse(dir), true);
  release();
  release(); // idempotent
  assert.equal(isWorktreeInUse(dir), false);
  const registry = readWorktreeUse(root);
  assert.equal(typeof registry["feature"]?.lastUsedAt, "number");

  let ran = false;
  const value = await useWorktree(root, dir, () => {
    ran = true;
    return 7;
  });
  assert.equal(ran, true);
  assert.equal(value, 7);
  assert.equal(isWorktreeInUse(dir), false);
});

test("claimForReclaim refuses while in use and marks the worktree reclaiming", async () => {
  const root = tmpdir("wt-use-claim-");
  const dir = useDir("wt-use-claim-wt-");
  const release = await beginWorktreeUse(root, dir);
  assert.equal(claimForReclaim(dir), false, "in use");
  release();
  assert.equal(claimForReclaim(dir), true);
  assert.equal(isReclaimInProgress(dir), true);
  assert.equal(claimForReclaim(dir), false, "already claimed");
  releaseReclaim(root, dir, 1_700_000_000_000);
  assert.equal(isReclaimInProgress(dir), false);
  const registry = readWorktreeUse(root);
  assert.equal(registry["feature"]?.reclaimedAt, 1_700_000_000_000);
});

test("a use starting during a reclaim waits for the release before running", async () => {
  const root = tmpdir("wt-use-wait-");
  const dir = useDir("wt-use-wait-wt-");
  assert.equal(claimForReclaim(dir), true);
  let ran = false;
  const pending = useWorktree(root, dir, () => {
    ran = true;
    return "done";
  });
  // Let the microtask queue drain: fn must still not run while the reclaim holds the tree.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(ran, false);
  releaseReclaim(root, dir, Date.now());
  assert.equal(await pending, "done");
  assert.equal(ran, true);
  assert.equal(isWorktreeInUse(dir), false);
});
