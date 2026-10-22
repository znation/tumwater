/** Handing a role's salvaged work back (src/git/slot-salvage.ts, restoreSalvagedWork): the newest
 * patch waiting for the role is restored into a fresh checkout as unstaged edits and moves out of
 * the waiting area, and a patch that no longer applies is kept with a warning while the checkout
 * stays clean. The salvage side, run by the pool's lease, is pinned in
 * test/worktree-pool.test.ts. */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { restoreSalvagedWork, salvageSlotLeftovers } from "../src/git/slot-salvage.js";
import { salvageDir, salvagePendingDir } from "../src/paths.js";
import { warningMessages } from "./fixtures/log-fixtures.js";
import { commitIn, makeRepo, sh, worktreeAt } from "./fixtures/repo-fixtures.js";

/** A repo with a tracked `notes.md` and `old.md`, and a worktree the tests salvage from and
 * restore into. */
function fixture(): { root: string; wt: string } {
  const root = makeRepo();
  writeFileSync(join(root, "notes.md"), "v1\n");
  writeFileSync(join(root, "old.md"), "to be deleted\n");
  commitIn(root, "notes");
  return { root, wt: worktreeAt(root, "slot") };
}

/** Leave feature's unfinished edits in `wt` (a modified, a deleted and a new file), save them as
 * the pool's lease would for feature's next run, and reset `wt` as that lease does. */
async function salvageForFeature(root: string, wt: string, now: Date): Promise<string> {
  writeFileSync(join(wt, "notes.md"), "v2, half done\n");
  rmSync(join(wt, "old.md"));
  writeFileSync(join(wt, "added.md"), "new work\n");
  const patch = await salvageSlotLeftovers(root, wt, { leftBy: "feature", recoverFor: "feature", forRole: "docs" }, now);
  assert.ok(patch !== null);
  sh(wt, "git", "reset", "-q", "--hard");
  sh(wt, "git", "clean", "-fdq");
  return patch;
}

test("restoreSalvagedWork restores the newest waiting patch as unstaged edits and moves it out", async () => {
  const { root, wt } = fixture();
  const older = await salvageForFeature(root, wt, new Date(2026, 9, 21, 14, 0, 0));
  const newest = await salvageForFeature(root, wt, new Date(2026, 9, 21, 15, 0, 0));
  assert.ok(older.startsWith(salvagePendingDir(root, "feature")));

  const restored = await restoreSalvagedWork(root, "feature", wt);
  assert.equal(restored, join(salvageDir(root), newest.split("/").pop()!));
  assert.equal(readFileSync(join(wt, "notes.md"), "utf8"), "v2, half done\n");
  assert.equal(existsSync(join(wt, "old.md")), false);
  assert.equal(readFileSync(join(wt, "added.md"), "utf8"), "new work\n");
  // Unstaged, as an interrupted run's kept worktree: the edits show in `git diff`, the new file
  // as untracked, and nothing is in the index.
  assert.equal(sh(wt, "git", "diff", "--cached", "--name-only"), "");
  assert.equal(sh(wt, "git", "status", "--porcelain"), " M notes.md\n D old.md\n?? added.md");
  // Nothing waits any more: the older patch was superseded and kept beside the restored one.
  assert.deepEqual(readdirSync(salvagePendingDir(root, "feature")), []);
  assert.equal(readdirSync(salvageDir(root)).filter((f) => f.endsWith(".patch")).length, 2);
  assert.equal(await restoreSalvagedWork(root, "feature", wt), null, "a restored patch is not restored twice");
});

test("restoreSalvagedWork finds nothing for a role with no waiting patch", async () => {
  const { root, wt } = fixture();
  await salvageForFeature(root, wt, new Date());
  assert.equal(await restoreSalvagedWork(root, "docs", wt), null);
  assert.equal(sh(wt, "git", "status", "--porcelain"), "");
  assert.equal(readdirSync(salvagePendingDir(root, "feature")).length, 1, "feature's patch still waits");
});

test("a patch that no longer applies is kept with a warning and the checkout is left clean", async () => {
  const { root, wt } = fixture();
  await salvageForFeature(root, wt, new Date());
  // The branch moved on: the same lines now read differently, so neither an exact apply nor a
  // three-way merge can place the edits.
  writeFileSync(join(wt, "notes.md"), "v3, rewritten since\n");
  rmSync(join(wt, "old.md"));
  commitIn(wt, "rewrite notes");

  assert.equal(await restoreSalvagedWork(root, "feature", wt), null);
  assert.equal(sh(wt, "git", "status", "--porcelain"), "", "a failed restore leaves no half-applied edits");
  assert.deepEqual(readdirSync(salvagePendingDir(root, "feature")), [], "the patch does not wait to fail again");
  const kept = readdirSync(salvageDir(root)).filter((f) => f.endsWith(".patch"));
  assert.equal(kept.length, 1);
  assert.match(
    warningMessages(root).join("\n"),
    new RegExp(`could not restore the uncommitted work an earlier run left unfinished from \\.tumwater/salvage/${kept[0]}`),
  );
});
