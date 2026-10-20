/** Two reclaim rules test/reclaim.test.ts leaves unpinned: the freed-space figure a pass
 * reports (clamped at zero) and the in-use refusal inside reclaimWorktree itself. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { reclaimPass, reclaimWorktree } from "../src/team/reclaim.js";
import { beginWorktreeUse } from "../src/git/worktree-use.js";
import { BYTES_PER_GB } from "../src/gates/disk-gate.js";
import { readEvents } from "../src/events/event-read.js";
import { makeRepo, sh, worktreeAt } from "./fixtures/repo-fixtures.js";

const B = BYTES_PER_GB;

/** Commit an ignore rule for `build/` in `wt`, then create an ignored `build/out.bin`. */
function seedBuild(wt: string): void {
  fs.writeFileSync(path.join(wt, ".gitignore"), "build/\n");
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-m", "ignore build");
  fs.mkdirSync(path.join(wt, "build"));
  fs.writeFileSync(path.join(wt, "build", "out.bin"), "x\n");
}

/** One pressure pass over one seeded worktree; the sampler returns `samples` in order and then
 * holds the last value (before the loop, once per candidate, once after the loop). */
async function passWith(samples: number[]) {
  const root = makeRepo();
  const dir = worktreeAt(root, "feature");
  seedBuild(dir);
  let i = 0;
  const result = await reclaimPass(root, "pressure", {
    reclaimGB: 40,
    sample: () => samples[Math.min(i++, samples.length - 1)]!,
    candidates: [{ dir, name: "feature", lastUsedAt: 0, resumePending: false }],
  });
  const event = readEvents(root, 100).find((e) => e.type === "disk_reclaim")!;
  return { result, event };
}

test("reclaimPass reports freed space as after minus before, clamped at zero when another writer consumed it", async () => {
  const rising = await passWith([5 * B, 5 * B, 7 * B]);
  assert.ok(rising.result);
  assert.equal(rising.result.freedGB, 2);
  assert.equal(rising.result.freeGB, 7);
  assert.equal(rising.event.freedGB, 2);
  assert.equal(rising.event.freeGB, 7);

  const falling = await passWith([5 * B, 5 * B, 3 * B]);
  assert.ok(falling.result);
  assert.equal(falling.result.freedGB, 0);
  assert.equal(falling.result.freeGB, 3);
  assert.equal(falling.event.freedGB, 0);
});

test("reclaimWorktree refuses a worktree in use, deleting nothing, and cleans it once the use ends", async () => {
  const root = makeRepo();
  const wt = worktreeAt(root, "feature");
  seedBuild(wt);
  const artifact = path.join(wt, "build", "out.bin");

  const release = await beginWorktreeUse(root, wt);
  assert.equal(await reclaimWorktree(root, wt), false);
  assert.equal(fs.existsSync(artifact), true, "an in-use worktree keeps its ignored files");

  release();
  assert.equal(await reclaimWorktree(root, wt), true, "the refusal left no claim behind");
  assert.equal(fs.existsSync(path.join(wt, "build")), false);
});
