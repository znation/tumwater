/** The worktree-use registry (src/git/worktree-use.ts, plans/disk-floor.md part 2/4): the
 * in-process in-use count, the durable last-used record, and the claim/release handshake that
 * keeps a `useWorktree` from starting in a half-cleaned tree. Candidate ordering built on the
 * registry is pinned in test/reclaim.test.ts. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnReadyChild, stopChild } from "./helpers/child-process.js";
import { fileURLToPath } from "node:url";

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

// The cross-process read-modify-write race: the orchestrator records a use release in-process
// while `tumwater reclaim` runs as a separate CLI process that seeds the same worktree-use
// registry. Without the lock, the later whole-file write drops the other's field. The child
// holds the worktree-use lock, snapshots the registry, waits to see whether the parent's
// release lands (an unlocked writer's does; a locked one's waits for the lock), then writes its
// own stale snapshot. The fix serializes the parent's read→write, so both records survive.
test("a concurrent worktree-use write cannot drop another process's update", async () => {
  const root = tmpdir("wt-use-race-");
  const dir = useDir("wt-use-race-wt-");
  const stateDir = path.join(root, ".tumwater", "state");
  const lock = path.join(stateDir, "worktree-use.lock");
  const ready = path.join(root, "child-ready");
  const registryFile = path.join(stateDir, "worktree-use.json");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(registryFile, "{}");
  const lockModule = fileURLToPath(new URL("../src/concurrency/lock.js", import.meta.url));
  const holder = spawnReadyChild(
    `const fs = require("node:fs");
     import(${JSON.stringify(lockModule)}).then(({ withSyncLock }) => withSyncLock(${JSON.stringify(lock)}, () => {
       const snapshot = JSON.parse(fs.readFileSync(${JSON.stringify(registryFile)}, "utf8"));
       fs.writeFileSync(${JSON.stringify(ready)}, "1");
       const parentSet = () => { try { return JSON.parse(fs.readFileSync(${JSON.stringify(registryFile)}, "utf8")).feature?.lastUsedAt !== undefined; } catch { return false; } };
       const deadline = Date.now() + 1500;
       while (Date.now() < deadline && !parentSet()) {
         Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
       }
       snapshot.other = { lastUsedAt: 1 };
       fs.writeFileSync(${JSON.stringify(registryFile)}, JSON.stringify(snapshot));
     }));`,
    () => fs.existsSync(ready),
    "the holder child never took the worktree-use lock",
  );
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
