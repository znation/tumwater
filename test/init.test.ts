import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initProject } from "../src/init.js";
import { readInitialPrompt } from "../src/readme.js";
import { loadConfig } from "../src/config.js";
import { makeRepo, sh, tmpdir } from "./util.js";

test("initProject creates and commits the harness files", async () => {
  const repo = makeRepo();
  const result = await initProject(repo, "Build a todo CLI.");
  assert.deepEqual(
    [...result.created].sort(),
    [".gitignore", "BUGS.md", "PLANS.md", "README.md", "tumwater.json"],
  );
  assert.ok(result.committed);
  assert.equal(sh(repo, "git", "status", "--porcelain"), "");
  assert.equal(readInitialPrompt(repo), "Build a todo CLI.");
  assert.match(fs.readFileSync(path.join(repo, ".gitignore"), "utf8"), /^\.tumwater\/$/m);
  assert.ok(loadConfig(repo).roles.director?.enabled);
});

test("initProject works on a repo with no commits", async () => {
  const dir = tmpdir();
  sh(dir, "git", "init", "-b", "main");
  const result = await initProject(dir, "Fresh start.");
  assert.ok(result.committed);
  assert.equal(sh(dir, "git", "log", "--oneline").split("\n").length, 1);
});

test("initProject never clobbers existing files and is idempotent", async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "README.md"), "# mine\n");
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "own readme");
  const first = await initProject(repo, "prompt");
  assert.ok(!first.created.includes("README.md"));
  assert.equal(fs.readFileSync(path.join(repo, "README.md"), "utf8"), "# mine\n");
  const second = await initProject(repo, "prompt");
  assert.deepEqual(second.created, []);
  assert.ok(!second.committed);
});

test("initProject rejects non-repos and empty prompts", async () => {
  await assert.rejects(() => initProject(tmpdir(), "x"), /not a git repository/);
  await assert.rejects(() => initProject(makeRepo(), "   "), /initial prompt is required/);
});

test("initProject leaves user's unrelated dirty files uncommitted", async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "wip.txt"), "wip\n");
  await initProject(repo, "prompt");
  assert.match(sh(repo, "git", "status", "--porcelain"), /wip\.txt/);
});
