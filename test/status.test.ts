import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, saveConfig } from "../src/config.js";
import { allRoleIds } from "../src/roles.js";
import { snapshot } from "../src/status.js";
import { loopPhase, renderStatus } from "../src/status-render.js";
import { freshLoopState, saveLoopState } from "../src/state.js";
import { initProject } from "../src/init.js";
import { makeRepo } from "./util.js";

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

test("snapshot survives a broken tumwater.json and recovers when it is fixed", async () => {
  const repo = makeRepo();
  await initProject(repo, "test project");
  // Baseline: every catalog role enabled by default.
  assert.equal(snapshot(repo).loops.length, allRoleIds().length);

  // A valid config that disables one role becomes the last known-good one.
  const cfg = loadConfig(repo);
  cfg.roles.dry!.enabled = false;
  saveConfig(repo, cfg);
  let snap = snapshot(repo);
  assert.ok(!snap.loops.some((l) => l.role === "dry"));

  // The file breaks mid-edit (invalid JSON): observers must not throw.
  fs.writeFileSync(path.join(repo, "tumwater.json"), "{ still editing");
  snap = snapshot(repo);
  // The last known-good role set is kept: dry stays hidden and nothing crashes.
  assert.ok(!snap.loops.some((l) => l.role === "dry"));

  // A validation error (valid JSON, invalid value) is equally survivable.
  fs.writeFileSync(path.join(repo, "tumwater.json"), JSON.stringify({ maxConcurrent: "six" }));
  assert.ok(snapshot(repo).loops.length > 0);

  // Repair with a different valid config: the fresh load takes effect again.
  cfg.roles.dry!.enabled = true;
  cfg.roles.clean!.enabled = false;
  saveConfig(repo, cfg);
  snap = snapshot(repo);
  assert.ok(snap.loops.some((l) => l.role === "dry"));
  assert.ok(!snap.loops.some((l) => l.role === "clean"));
});

test("snapshot serves unchanged loop state from the stat-keyed cache without re-reading", async () => {
  const repo = makeRepo();
  await initProject(repo, "test project");
  const state = freshLoopState("clean");
  state.ticks = 3;
  saveLoopState(repo, state);
  assert.equal(snapshot(repo).loops.find((l) => l.role === "clean")!.ticks, 3); // populates the cache

  let cleanReads = 0;
  const originalReadFileSync = fs.readFileSync.bind(fs);
  try {
    (fs as unknown as { readFileSync: unknown }).readFileSync = (...args: unknown[]) => {
      if (typeof args[0] === "string" && args[0].endsWith(`${path.sep}state${path.sep}clean.json`))
        cleanReads += 1;
      return (originalReadFileSync as (...a: unknown[]) => string)(...args);
    };
    const snap = snapshot(repo);
    assert.equal(snap.loops.find((l) => l.role === "clean")!.ticks, 3); // unchanged — served from cache
    assert.equal(cleanReads, 0); // no re-read of the state file at all
    // Each poll still gets its own objects: mutating one snapshot must not poison later ones.
    snap.loops.find((l) => l.role === "clean")!.ticks = 99;
    assert.equal(snapshot(repo).loops.find((l) => l.role === "clean")!.ticks, 3);
  } finally {
    (fs as unknown as { readFileSync: unknown }).readFileSync = originalReadFileSync;
  }

  // A same-size edit is picked up via mtime, not just size: ticks 3 → 4 keeps the file's byte
  // length identical, so utimes forces a distinct mtime regardless of filesystem timestamp
  // granularity (two fast writes could otherwise share one on coarse-grained filesystems).
  const bumped = freshLoopState("clean");
  bumped.ticks = 4;
  saveLoopState(repo, bumped);
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(repo, ".tumwater", "state", "clean.json"), t, t);
  assert.equal(snapshot(repo).loops.find((l) => l.role === "clean")!.ticks, 4);
});

test("loopPhase describes each loop state", () => {
  const s = freshLoopState("clean");
  assert.equal(loopPhase(s, false), "stopped");
  assert.equal(loopPhase(s, true), "queued");
  s.running = true;
  assert.equal(loopPhase(s, true), "working");
  s.running = false;
  s.nextRunAt = Date.now() + 90_000;
  // Sleeping is a present state: the label shows the remaining duration ("for …"),
  // not a future start ("in …"). 90s buckets to "2m" in humanSeconds.
  assert.match(loopPhase(s, true), /^sleeping \(for 2m\)$/);
  const d = freshLoopState("director");
  assert.equal(loopPhase(d, true), "waiting for prompts");
});
