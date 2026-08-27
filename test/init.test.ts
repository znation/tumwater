import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initProject } from "../src/init.js";
import { PROMPT_END, PROMPT_START, readInitialPrompt } from "../src/readme.js";
import { loadConfig } from "../src/config.js";
import { makeRepo, sh, tmpdir } from "./util.js";

test("initProject creates and commits the harness files", async () => {
  const repo = makeRepo();
  const result = await initProject(repo, "Build a todo CLI.");
  assert.deepEqual(
    [...result.created].sort(),
    [".gitignore", "BUGS.md", "PLANS.md", "PRINCIPLES.md", "README.md", "tumwater.json"],
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

test("initProject seeds PRINCIPLES.md with positive starter principles", async () => {
  const repo = makeRepo();
  await initProject(repo, "prompt");
  const seeded = fs.readFileSync(path.join(repo, "PRINCIPLES.md"), "utf8");
  assert.match(seeded, /^# Principles/);
  // The write policy is stated in the file itself: only director/steward edit it.
  assert.match(seeded, /only the director and steward/i);
  // Starter principles are phrased positively ("prefer…", "keep…", "every… ships").
  assert.match(seeded, /Prefer the standard library/);
  assert.match(seeded, /Every behavior change ships with a test/);
});

test("initProject never clobbers an existing PRINCIPLES.md", async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "PRINCIPLES.md"), "# my taste\n- do things well\n");
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "own principles");
  const result = await initProject(repo, "prompt");
  assert.ok(!result.created.includes("PRINCIPLES.md"));
  assert.equal(fs.readFileSync(path.join(repo, "PRINCIPLES.md"), "utf8"), "# my taste\n- do things well\n");
});

test("initProject never clobbers existing files and is idempotent", async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "PLANS.md"), "# mine\n");
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "own plans");
  const first = await initProject(repo, "prompt");
  assert.ok(!first.created.includes("PLANS.md"));
  assert.equal(fs.readFileSync(path.join(repo, "PLANS.md"), "utf8"), "# mine\n");
  const second = await initProject(repo, "prompt");
  assert.deepEqual(second.created, []);
  assert.ok(!second.committed);
});

test("initProject refuses to drop the initial prompt when README has no tumwater markers", async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "README.md"), "# mine\n");
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "own readme");
  await assert.rejects(() => initProject(repo, "prompt"), /tumwater:prompt/);
  // Nothing was created or committed — the user fixes README.md and re-runs.
  for (const f of ["PLANS.md", "BUGS.md", "tumwater.json"]) {
    assert.ok(!fs.existsSync(path.join(repo, f)), `${f} should not exist`);
  }
  assert.equal(sh(repo, "git", "status", "--porcelain"), "");
});

test("initProject accepts an existing README that already carries the prompt", async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "README.md"), `# mine\n${PROMPT_START}\nmy prompt\n${PROMPT_END}\n`);
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "own readme with markers");
  const result = await initProject(repo, "prompt");
  assert.ok(!result.created.includes("README.md"));
  assert.equal(readInitialPrompt(repo), "my prompt");
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
