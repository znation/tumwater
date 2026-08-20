import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { withLock } from "../src/lock.js";
import { renderStatus, snapshot, loopPhase } from "../src/status.js";
import { freshLoopState, saveLoopState } from "../src/state.js";
import { initProject } from "../src/init.js";
import { makeRepo, tmpdir } from "./util.js";

test("withLock serializes critical sections", async () => {
  const lock = path.join(tmpdir(), "x.lock");
  const order: number[] = [];
  await Promise.all([
    withLock(lock, async () => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 100));
      order.push(2);
    }),
    (async () => {
      await new Promise((r) => setTimeout(r, 10));
      await withLock(lock, async () => {
        order.push(3);
      });
    })(),
  ]);
  assert.deepEqual(order, [1, 2, 3]);
  assert.ok(!fs.existsSync(lock), "lock is released");
});

test("withLock releases on exceptions", async () => {
  const lock = path.join(tmpdir(), "x.lock");
  await assert.rejects(
    withLock(lock, async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.ok(!fs.existsSync(lock));
});

test("withLock steals a lock held by a dead pid", async () => {
  const lock = path.join(tmpdir(), "x.lock");
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "pid"), "999999999");
  let ran = false;
  await withLock(
    lock,
    async () => {
      ran = true;
    },
    5000,
  );
  assert.ok(ran);
});

test("snapshot and renderStatus cover all enabled loops", async () => {
  const repo = makeRepo();
  await initProject(repo, "test project");
  const state = freshLoopState("clean");
  state.ticks = 3;
  state.commits = 2;
  state.lastResult = "changed";
  state.lastSummary = "tidy something";
  saveLoopState(repo, state);

  const snap = snapshot(repo);
  assert.equal(snap.running, false);
  assert.ok(snap.loops.some((l) => l.role === "clean" && l.ticks === 3));
  const text = renderStatus(repo, snap);
  assert.match(text, /not running/);
  assert.match(text, /tidy something/);
  for (const role of ["organize", "coverage", "clean", "dry", "feature", "bugfix", "plan", "readme", "improve", "director"]) {
    assert.match(text, new RegExp(role));
  }
});

test("loopPhase describes each loop state", () => {
  const s = freshLoopState("clean");
  assert.equal(loopPhase(s, false), "stopped");
  assert.equal(loopPhase(s, true), "queued");
  s.running = true;
  assert.equal(loopPhase(s, true), "working");
  s.running = false;
  s.nextRunAt = Date.now() + 90_000;
  assert.match(loopPhase(s, true), /^sleeping/);
  const d = freshLoopState("director");
  assert.equal(loopPhase(d, true), "waiting for prompts");
});
