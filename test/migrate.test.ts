import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { configPath, migrateLegacyState, statePath } from "../src/paths.js";
import { branchName } from "../src/paths.js";
import { ensureWorktree } from "../src/git.js";
import { makeRepo, sh } from "./util.js";

test("migrateLegacyState renames the old state dir and config, preserving contents", () => {
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo, ".automaton", "state"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".automaton", "worktrees", "clean"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".automaton", "state", "clean.json"), '{"role":"clean","ticks":7}');
  fs.writeFileSync(path.join(repo, "automaton.json"), '{"maxConcurrent":3}');

  migrateLegacyState(repo);

  assert.ok(!fs.existsSync(path.join(repo, ".automaton")));
  assert.ok(!fs.existsSync(path.join(repo, "automaton.json")));
  assert.match(fs.readFileSync(statePath(repo, "clean"), "utf8"), /"ticks":7/);
  assert.match(fs.readFileSync(configPath(repo), "utf8"), /"maxConcurrent":3/);
  // Old worktrees are dropped (their git metadata points at the old path).
  assert.ok(!fs.existsSync(path.join(repo, ".tumwater", "worktrees", "clean")));

  // Running again is a no-op.
  migrateLegacyState(repo);
  assert.match(fs.readFileSync(configPath(repo), "utf8"), /"maxConcurrent":3/);
});

test("migrateLegacyState never clobbers existing new-name state", () => {
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo, ".tumwater"), { recursive: true });
  fs.writeFileSync(configPath(repo), '{"new":true}');
  fs.mkdirSync(path.join(repo, ".automaton"), { recursive: true });
  fs.writeFileSync(path.join(repo, "automaton.json"), '{"old":true}');
  migrateLegacyState(repo);
  assert.match(fs.readFileSync(configPath(repo), "utf8"), /"new":true/);
  assert.ok(fs.existsSync(path.join(repo, "automaton.json")), "legacy config left untouched");
});

test("ensureWorktree adopts a legacy-named branch instead of orphaning it", async () => {
  const repo = makeRepo();
  sh(repo, "git", "branch", "automaton/clean");
  fs.writeFileSync(path.join(repo, "extra.txt"), "x\n");
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "advance main past the legacy branch");

  const wt = await ensureWorktree(repo, "clean", "main");
  const branches = sh(repo, "git", "branch", "--list");
  assert.ok(branches.includes(branchName("clean")), "new-name branch exists");
  assert.ok(!branches.includes("automaton/clean"), "legacy branch renamed away");
  assert.equal(sh(wt, "git", "rev-parse", "--abbrev-ref", "HEAD"), branchName("clean"));
});
