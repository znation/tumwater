/** The worktree-use registry (src/git/worktree-use.ts, plans/disk-floor.md part 2/4): the
 * in-process in-use count, the durable last-used record, and the claim/release handshake that
 * keeps a `useWorktree` from starting in a half-cleaned tree. Candidate ordering built on the
 * registry is pinned in test/team-reclaim.test.ts. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnLockHolder, stopChild } from "./helpers/child-process.js";

import {
  beginWorktreeUse,
  claimForReclaim,
  isReclaimInProgress,
  isWorktreeInUse,
  readWorktreeUse,
  releaseReclaim,
  useWorktree,
} from "../src/git/worktree-use.js";
import { worktreeUsePath, worktreesDir } from "../src/paths.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

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

// The cross-process read-modify-write race: the orchestrator records a use release in-process while
// `tumwater reclaim` runs as a separate CLI process that seeds the same worktree-use registry.
// Without the lock, the later whole-file write drops the other's field. The child holds the
// worktree-use lock, snapshots the registry, waits to see whether the parent's release arrives (an
// unlocked writer's does; a locked one's waits for the lock), then writes its own stale snapshot.
// The fix serializes the parent's read→write, so both records survive.
test("a concurrent worktree-use write cannot drop another process's update", async () => {
  const root = tmpdir("wt-use-race-");
  const dir = useDir("wt-use-race-wt-");
  const stateDir = path.join(root, ".tumwater", "state");
  const lock = path.join(stateDir, "worktree-use.lock");
  const ready = path.join(root, "child-ready");
  const registryFile = path.join(stateDir, "worktree-use.json");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(registryFile, "{}");
  const holder = spawnLockHolder({
    lock,
    ready,
    withLock: "withSyncLock",
    before: `const snapshot = JSON.parse(fs.readFileSync(${JSON.stringify(registryFile)}, "utf8"));`,
    until: `JSON.parse(fs.readFileSync(${JSON.stringify(registryFile)}, "utf8")).feature?.lastUsedAt !== undefined`,
    after: `snapshot.other = { lastUsedAt: 1 };
       fs.writeFileSync(${JSON.stringify(registryFile)}, JSON.stringify(snapshot));`,
    missingMessage: "the holder child never took the worktree-use lock",
  });
  try {
    await holder.ready;
    releaseReclaim(root, dir, 1_700_000_000_000);
    await holder.exited;
    const registry = readWorktreeUse(root);
    assert.equal(typeof registry["feature"]?.lastUsedAt, "number", "the parent's release survives");
    assert.equal(typeof registry["other"]?.lastUsedAt, "number", "the child's seeding survives");
  } finally {
    await stopChild(holder);
  }
});

test("a failed registry write on a release warns instead of failing the operation", async () => {
  const root = tmpdir("wt-use-write-fail-");
  const dir = useDir("wt-use-write-fail-wt-");
  // Occupy the durable registry's path with a non-empty directory so writeJsonAtomic's
  // tmp+rename fails (EISDIR). The registry only orders reclaim, so both release paths must
  // warn and let the work they wrapped stand instead of turning it into a failure.
  fs.mkdirSync(worktreeUsePath(root), { recursive: true });
  fs.writeFileSync(path.join(worktreeUsePath(root), "occupied"), "x");
  const value = await useWorktree(root, dir, () => "ok");
  assert.equal(value, "ok");
  assert.equal(isWorktreeInUse(dir), false, "the release still decrements the in-use count");
  assert.equal(claimForReclaim(dir), true);
  releaseReclaim(root, dir, 1_700_000_000_000); // must not throw despite the unwritable registry
  assert.equal(isReclaimInProgress(dir), false);
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
