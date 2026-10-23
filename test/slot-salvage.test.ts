/** Handing a role's salvaged work back (src/git/slot-salvage.ts, restoreSalvagedWork): the newest
 * patch waiting for the role is restored into a fresh checkout as unstaged edits and moves out of
 * the waiting area, and a patch that no longer applies is kept with a warning while the checkout
 * stays clean. The salvage side, run by the pool's lease, is pinned in
 * test/worktree-pool.test.ts. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { restoreSalvagedWork, salvageSlotLeftovers } from "../src/git/slot-salvage.js";
import { salvageDir, salvagePendingDir } from "../src/paths.js";
import { warningMessages } from "./fixtures/log-fixtures.js";
import { commitIn, makeRepo, sh, worktreeAt } from "./fixtures/repo-fixtures.js";
import { writeFileDeep } from "./helpers/write-file-deep.js";

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
  assert.deepEqual(restored, { patch: join(salvageDir(root), newest.split("/").pop()!), conflicted: [], unplaced: [] });
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

test("a salvage patch whose save dies mid-write leaves no torn .patch behind", async (t) => {
  const { root, wt } = fixture();
  writeFileSync(join(wt, "notes.md"), "v2, half done\n");
  fs.mkdirSync(salvagePendingDir(root, "feature"), { recursive: true });
  // The one writeFileSync salvageSlotLeftovers makes is the patch itself: write a truncated
  // prefix to the given path, then die (throw) as a mid-write kill does. The patch is the only
  // copy of the work after the lease resets the workspace, so it must never come back as a
  // partial .patch that a later restore reads and partially applies.
  const originalWrite = fs.writeFileSync.bind(fs);
  let hitPatchWrite = false;
  t.mock.method(fs, "writeFileSync", ((p: Parameters<typeof fs.writeFileSync>[0], data: string | Uint8Array) => {
    // Only the patch save (and its temp twin) is the fault under test; the warn path's event
    // log write must pass through untouched so the interruption is reported, not swallowed.
    if (/\.patch(\.tmp-\d+)?$/.test(String(p))) {
      hitPatchWrite = true;
      originalWrite(p, String(data).slice(0, 20));
      throw new Error("torn write");
    }
    originalWrite(p, data);
  }) as typeof fs.writeFileSync);
  try {
    const patch = await salvageSlotLeftovers(root, wt, { leftBy: "feature", recoverFor: "feature", forRole: "docs" }, new Date());
    assert.equal(patch, null, "an interrupted save reports failure, never a path to a partial patch");
  } finally {
    t.mock.restoreAll();
  }
  assert.equal(hitPatchWrite, true, "the fault must land on the patch save, not the event log");
  assert.deepEqual(readdirSync(salvagePendingDir(root, "feature")), [], "no torn .patch may be left behind");
});

test("a patch the branch moved under goes back with conflict markers where both sides changed", async () => {
  const { root, wt } = fixture();
  await salvageForFeature(root, wt, new Date());
  // Since the work was saved, the branch rewrote the same line and removed old.md itself.
  writeFileSync(join(wt, "notes.md"), "v3, rewritten since\n");
  rmSync(join(wt, "old.md"));
  commitIn(wt, "rewrite notes");

  const restored = await restoreSalvagedWork(root, "feature", wt);
  assert.deepEqual(restored?.conflicted, ["notes.md"]);
  assert.deepEqual(restored?.unplaced, [], "the deletion the branch already made is not handed back");
  assert.equal(
    readFileSync(join(wt, "notes.md"), "utf8"),
    "<<<<<<< ours\nv3, rewritten since\n=======\nv2, half done\n>>>>>>> theirs\n",
  );
  assert.equal(readFileSync(join(wt, "added.md"), "utf8"), "new work\n", "the clean parts go back too");
  assert.equal(sh(wt, "git", "ls-files", "-u"), "", "no unmerged index entries: the markers are plain edits");
  assert.deepEqual(readdirSync(salvagePendingDir(root, "feature")), [], "handed back, so nothing waits");
  assert.equal(warningMessages(root).some((m) => m.includes("could not restore")), false);
});

test("a saved edit to a file the branch deleted reaches the run as text to apply by hand", async () => {
  const { root, wt } = fixture();
  await salvageForFeature(root, wt, new Date());
  rmSync(join(wt, "notes.md"));
  commitIn(wt, "drop notes");

  const restored = await restoreSalvagedWork(root, "feature", wt);
  assert.deepEqual(restored?.conflicted, []);
  assert.equal(restored?.unplaced.length, 1);
  assert.equal(restored?.unplaced[0]!.path, "notes.md");
  assert.match(restored!.unplaced[0]!.diff, /^\+v2, half done$/m);
  assert.equal(existsSync(join(wt, "notes.md")), false);
  assert.equal(readFileSync(join(wt, "added.md"), "utf8"), "new work\n");
});

test("hunks that still fit go back and the rest come back as git's rejected-hunk text", async () => {
  const { root, wt } = fixture();
  writeFileSync(join(wt, "long.md"), Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  commitIn(wt, "long file");
  // A patch without blob ids (one an older build or a hand-made file might hold): a three-way
  // merge has nothing to merge from, so git places it hunk by hunk.
  writeFileDeep(
    join(salvagePendingDir(root, "feature"), "2026-10-22-000000-_slot-1-feature.patch"),
    [
      "diff --git a/long.md b/long.md",
      "--- a/long.md",
      "+++ b/long.md",
      "@@ -1,3 +1,3 @@",
      " line 1",
      "-line 2",
      "+line two",
      " line 3",
      "@@ -17,3 +17,3 @@",
      " line 17",
      "-line 18 as it was",
      "+line eighteen",
      " line 19",
      "",
    ].join("\n"),
  );

  const restored = await restoreSalvagedWork(root, "feature", wt);
  assert.deepEqual(restored?.conflicted, []);
  assert.equal(restored?.unplaced.length, 1);
  assert.equal(restored?.unplaced[0]!.path, "long.md");
  assert.match(restored!.unplaced[0]!.diff, /^\+line eighteen$/m);
  assert.doesNotMatch(restored!.unplaced[0]!.diff, /line two/, "the hunk that fit is not repeated");
  assert.match(readFileSync(join(wt, "long.md"), "utf8"), /^line two$/m);
  assert.equal(existsSync(join(wt, "long.md.rej")), false, "git's .rej file is never left to be committed");
});

test("a patch that cannot be read stays waiting for the next run, with the checkout left clean", async () => {
  const { root, wt } = fixture();
  const patch = await salvageForFeature(root, wt, new Date());
  chmodSync(patch, 0);
  try {
    assert.equal(await restoreSalvagedWork(root, "feature", wt), null);
  } finally {
    chmodSync(patch, 0o644);
  }
  assert.equal(sh(wt, "git", "status", "--porcelain"), "");
  assert.equal(existsSync(patch), true, "still waiting for the role's next run");
  assert.match(
    warningMessages(root).join("\n"),
    /could not restore the uncommitted work an earlier run left unfinished \(.*\); it stays waiting at \.tumwater\/salvage\/pending\/feature\/\S+ for the next run/,
  );
  assert.deepEqual(await restoreSalvagedWork(root, "feature", wt).then((r) => r?.conflicted), [], "and goes back once readable");
});
