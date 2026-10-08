/** Pressure reclaim of gitignored build outputs (src/fleet/reclaim.ts, plans/disk-floor.md
 * part 2/4): candidate selection and ordering, the guard that keeps a clean off a
 * non-worktree, what a clean removes, the statfs-threshold stop, and the one `disk_reclaim`
 * event. The in-use handshake lives in test/worktree-use.test.ts. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  ReclaimController,
  inspectReclaimCandidates,
  isLinkedWorktree,
  reclaimCandidates,
  reclaimPass,
  reclaimWorktree,
} from "../src/fleet/reclaim.js";
import { beginWorktreeUse } from "../src/git/worktree-use.js";
import { readEvents } from "../src/events/event-read.js";
import { writeJsonAtomic } from "../src/files/json-files.js";
import { loadLoopState, saveLoopState } from "../src/loop/loop-state.js";
import { worktreeUsePath, worktreesDir } from "../src/paths.js";
import { makeRepo, sh, tmpdir, worktreeAt } from "./repo-fixtures.js";

/** Give a linked worktree a tracked modified file, an untracked file, an ignored `build/`
 * dir, an ignored `.log`, and a nested repository — the shape part 2/4's acceptance criterion
 * describes. Returns the paths whose survival the caller asserts. */
function seedWorktree(wt: string): { tracked: string; untracked: string; nested: string } {
  fs.writeFileSync(path.join(wt, ".gitignore"), "build/\n*.log\n");
  fs.writeFileSync(path.join(wt, "tracked.txt"), "one\n");
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-m", "seed ignore rules");
  const tracked = path.join(wt, "tracked.txt");
  fs.writeFileSync(tracked, "two\n"); // modified tracked file
  const untracked = path.join(wt, "new.txt");
  fs.writeFileSync(untracked, "new\n");
  fs.mkdirSync(path.join(wt, "build"));
  fs.writeFileSync(path.join(wt, "build", "out.bin"), "artifact\n");
  fs.writeFileSync(path.join(wt, "debug.log"), "log\n");
  const nested = path.join(wt, "nested");
  fs.mkdirSync(nested);
  sh(nested, "git", "init", "-b", "main");
  fs.writeFileSync(path.join(nested, "inner.txt"), "inner\n");
  return { tracked, untracked, nested };
}

function typesAt(root: string): string[] {
  return readEvents(root, 100).map((e) => e.type);
}

test("reclaimWorktree removes only gitignored files, keeping edits and nested repos", async () => {
  const root = makeRepo();
  const wt = worktreeAt(root, "feature");
  const { tracked, untracked, nested } = seedWorktree(wt);

  assert.equal(await isLinkedWorktree(wt), true);
  assert.equal(await reclaimWorktree(root, wt), true);

  assert.equal(fs.readFileSync(tracked, "utf8"), "two\n", "modified tracked file survives");
  assert.equal(fs.existsSync(untracked), true, "untracked file survives");
  assert.equal(fs.existsSync(nested), true, "nested repository survives");
  assert.equal(fs.existsSync(path.join(wt, "build")), false, "ignored build dir is removed");
  assert.equal(fs.existsSync(path.join(wt, "debug.log")), false, "ignored log is removed");
});

test("reclaimWorktree throws and deletes nothing outside worktreesDir", async () => {
  const root = makeRepo();
  const outside = tmpdir("reclaim-outside-");
  fs.writeFileSync(path.join(outside, "keep.txt"), "keep\n");
  await assert.rejects(() => reclaimWorktree(root, outside), /outside/);
  assert.equal(fs.existsSync(path.join(outside, "keep.txt")), true);
});

test("reclaimWorktree throws for a plain repo inside worktreesDir (not a linked worktree)", async () => {
  // The guard's failure branch: a git-dir equal to its common-dir means this is a primary
  // checkout, and `clean -X` there would delete the fleet's own state.
  const root = makeRepo();
  const plain = path.join(worktreesDir(root), "plain");
  makeRepo(plain);
  fs.writeFileSync(path.join(plain, "keep.txt"), "keep\n");
  assert.equal(await isLinkedWorktree(plain), false);
  await assert.rejects(() => reclaimWorktree(root, plain), /not a linked worktree/);
  assert.equal(fs.existsSync(path.join(plain, "keep.txt")), true, "nothing was deleted");
});

test("reclaimCandidates seeds unknown worktrees as used and excludes them from the pass", () => {
  // plans/disk-floor.md: a worktree the registry has never seen counts as used at first sight,
  // so an upgrade under pressure does not sweep every warm build at once.
  const root = makeRepo();
  worktreeAt(root, "feature");
  worktreeAt(root, "bugfix");
  assert.deepEqual(reclaimCandidates(root).map((c) => c.name), []);
  const registry = JSON.parse(fs.readFileSync(worktreeUsePath(root), "utf8")) as Record<
    string,
    { lastUsedAt: number }
  >;
  assert.equal(typeof registry["feature"]?.lastUsedAt, "number");
  assert.equal(typeof registry["bugfix"]?.lastUsedAt, "number");
  // Now that they are seen, the next pass may reclaim them.
  assert.deepEqual(reclaimCandidates(root).map((c) => c.name).sort(), ["bugfix", "feature"]);
});

test("reclaimCandidates orders least-recently-used first, resume-pending last, and skips reserved and in-use", async () => {
  const root = makeRepo();
  const feature = worktreeAt(root, "feature");
  worktreeAt(root, "bugfix");
  worktreeAt(root, "cleanup");
  fs.mkdirSync(path.join(worktreesDir(root), "_main"));
  fs.mkdirSync(path.join(worktreesDir(root), "_build"));
  writeJsonAtomic(worktreeUsePath(root), {
    feature: { lastUsedAt: 300 },
    bugfix: { lastUsedAt: 100 },
    cleanup: { lastUsedAt: 200 },
  });
  // cleanup is oldest but has a pending resume, so it must be cleaned after the others.
  const state = loadLoopState(root, "cleanup");
  saveLoopState(root, { ...state, resumePending: true });
  assert.deepEqual(
    reclaimCandidates(root).map((c) => c.name),
    ["bugfix", "feature", "cleanup"],
  );
  // An in-use worktree drops out of the candidate list entirely.
  const release = await beginWorktreeUse(root, feature);
  assert.deepEqual(reclaimCandidates(root).map((c) => c.name), ["bugfix", "cleanup"]);
  release();
});

test("reclaimPass cleans least-recently-used first and stops once the sampler reaches diskReclaimGB", async () => {
  const root = makeRepo();
  const first = worktreeAt(root, "feature");
  const second = worktreeAt(root, "bugfix");
  seedWorktree(first);
  seedWorktree(second);
  const candidates = [
    { dir: first, name: "feature", lastUsedAt: 0, resumePending: false },
    { dir: second, name: "bugfix", lastUsedAt: 1, resumePending: false },
  ];
  // before=5, first candidate still low, second candidate already back at the floor: stop.
  const samples = [5_000_000_000, 5_000_000_000, 45_000_000_000, 45_000_000_000];
  let i = 0;
  const result = await reclaimPass(root, "pressure", {
    reclaimGB: 40,
    sample: () => samples[Math.min(i++, samples.length - 1)]!,
    candidates,
  });
  assert.ok(result);
  assert.deepEqual(result.worktrees, ["feature"]);
  assert.equal(fs.existsSync(path.join(first, "build")), false, "first candidate cleaned");
  assert.equal(fs.existsSync(path.join(second, "build")), true, "second candidate untouched");
  assert.deepEqual(typesAt(root).filter((t) => t === "disk_reclaim"), ["disk_reclaim"]);
  const event = readEvents(root, 100).find((e) => e.type === "disk_reclaim")!;
  assert.equal(event.mode, "pressure");
  assert.deepEqual(event.worktrees, ["feature"]);
});

test("reclaimPass returns null and logs nothing when there is nothing to clean", async () => {
  const root = makeRepo();
  const result = await reclaimPass(root, "pressure", { reclaimGB: 40, candidates: [] });
  assert.equal(result, null);
  assert.deepEqual(typesAt(root), []);
});

test("reclaimWorktree reports false when a worktree has nothing ignored to clean", async () => {
  const root = makeRepo();
  const wt = worktreeAt(root, "feature");
  // A fresh worktree has no ignored files, so `git clean -fdX` removes nothing: not a reclaim.
  assert.equal(await reclaimWorktree(root, wt), false);
  assert.deepEqual(typesAt(root).filter((t) => t === "disk_reclaim"), []);
});

test("ReclaimController runs one pass per drop, then lets the disk hold engage", async () => {
  const root = makeRepo();
  const wt = worktreeAt(root, "feature");
  seedWorktree(wt);
  // Register the worktree so it is a candidate, not excluded as used-at-first-sight.
  writeJsonAtomic(worktreeUsePath(root), { feature: { lastUsedAt: 1 } });
  const low = 5_000_000_000;
  const controller = new ReclaimController(root, () => low);

  assert.equal(controller.poll(low, 40), true, "a low sample starts a pass and waits for it");
  // The pass is backgrounded; poll returns true until it settles, then false — and starts no
  // second pass for the same drop.
  for (let i = 0; i < 500 && controller.poll(low, 40); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(controller.poll(low, 40), false, "settled while still low: the hold may engage");
  assert.equal(fs.existsSync(path.join(wt, "build")), false, "the pass cleaned the worktree");
  assert.equal(controller.poll(low, 0), false, "0 disables pressure reclaim: never wait");
});

test("reclaimPass idle mode cleans only worktrees unused past the threshold", async () => {
  const root = makeRepo();
  const stale = worktreeAt(root, "feature");
  const recent = worktreeAt(root, "bugfix");
  const pending = worktreeAt(root, "cleanup");
  const already = worktreeAt(root, "docs");
  for (const wt of [stale, recent, pending, already]) seedWorktree(wt);
  const now = Date.now();
  const hour = 3600_000;
  const candidates = [
    { dir: stale, name: "feature", lastUsedAt: now - 25 * hour, resumePending: false },
    { dir: recent, name: "bugfix", lastUsedAt: now - 1 * hour, resumePending: false },
    { dir: pending, name: "cleanup", lastUsedAt: now - 25 * hour, resumePending: true },
    {
      dir: already,
      name: "docs",
      lastUsedAt: now - 25 * hour,
      reclaimedAt: now - 20 * hour,
      resumePending: false,
    },
  ];
  const result = await reclaimPass(root, "idle", { reclaimGB: 0, idleHours: 24, candidates });
  assert.ok(result);
  assert.deepEqual(result.worktrees, ["feature"]);
  assert.equal(fs.existsSync(path.join(stale, "build")), false, "idle worktree cleaned");
  assert.equal(fs.existsSync(path.join(recent, "build")), true, "recently used survives");
  assert.equal(fs.existsSync(path.join(pending, "build")), true, "resume-pending survives");
  assert.equal(fs.existsSync(path.join(already, "build")), true, "already reclaimed survives");
  const event = readEvents(root, 100).find((e) => e.type === "disk_reclaim")!;
  assert.equal(event.mode, "idle");
  assert.deepEqual(event.worktrees, ["feature"]);
});

test("reclaimPass idle mode with idleHours 0 cleans nothing", async () => {
  const root = makeRepo();
  const wt = worktreeAt(root, "feature");
  seedWorktree(wt);
  const candidates = [{ dir: wt, name: "feature", lastUsedAt: 0, resumePending: false }];
  const result = await reclaimPass(root, "idle", { reclaimGB: 0, idleHours: 0, candidates });
  assert.equal(result, null);
  assert.equal(fs.existsSync(path.join(wt, "build")), true);
});

test("inspectReclaimCandidates lists idle age and ignored-path count without cleaning", async () => {
  const root = makeRepo();
  const wt = worktreeAt(root, "feature");
  seedWorktree(wt);
  const now = Date.now();
  const hour = 3600_000;
  writeJsonAtomic(worktreeUsePath(root), { feature: { lastUsedAt: now - 25 * hour } });
  const rows = await inspectReclaimCandidates(root, 24, now);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.name, "feature");
  assert.equal(rows[0]!.paths, 2, "build/ and debug.log would be removed");
  assert.equal(rows[0]!.reclaimable, true);
  assert.ok(rows[0]!.idleHours > 24 && rows[0]!.idleHours < 26);
  assert.equal(fs.existsSync(path.join(wt, "build")), true, "dry run deletes nothing");
});

test("ReclaimController.pollIdle cleans once, throttles the next arm, and honors reclaimedAt", async () => {
  const root = makeRepo();
  const wt = worktreeAt(root, "feature");
  seedWorktree(wt);
  const hour = 3600_000;
  writeJsonAtomic(worktreeUsePath(root), { feature: { lastUsedAt: Date.now() - 25 * hour } });
  const controller = new ReclaimController(root, () => 100_000_000_000);

  controller.pollIdle(24);
  // Wait for the pass to settle, not merely for the build dir to vanish: reclaimPass deletes
  // the outputs before runIdle records lastReclaim, so under a loaded suite the two can be
  // observed out of order.
  for (let i = 0; i < 500 && controller.lastReclaim?.mode !== "idle"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(fs.existsSync(path.join(wt, "build")), false, "idle pass cleaned the worktree");
  assert.equal(controller.lastReclaim?.mode, "idle");

  // Make the candidate eligible again by both rules, then arm immediately: the hourly throttle
  // must stop the second pass.
  fs.mkdirSync(path.join(wt, "build"));
  fs.writeFileSync(path.join(wt, "build", "out.bin"), "again\n");
  writeJsonAtomic(worktreeUsePath(root), { feature: { lastUsedAt: Date.now() - 25 * hour } });
  controller.pollIdle(24);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(fs.existsSync(path.join(wt, "build")), true, "second idle pass is throttled");

  controller.pollIdle(0); // 0 disables idle mode: a no-op, never starts a pass
});
