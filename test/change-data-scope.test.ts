import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { collectTeamChanges, collectRoleChange } from "../src/change/change-data.js";
import { defaultConfig, loadConfig } from "../src/config/config.js";
import { initProject } from "../src/init/init.js";
import { ensureWorktree } from "../src/git/worktree.js";
import { allRoleIds } from "../src/roles/roles.js";
import { commitIn, makeRepo, sh, writeConfig } from "./fixtures/repo-fixtures.js";

// Two rules of the collector behind `tumwater diff` that no other test checks: the team view's
// roster reaches custom roles and parallel instances, and a staged edit below the diff cap
// reaches the uncommitted patch.

test("the team view lists custom roles and parallel instances after the catalog, each with its own change", async () => {
  const repo = makeRepo();
  await initProject(repo, "change-data scope roster");
  const cfg = loadConfig(repo);
  cfg.customRoles = [{ name: "docs-bot", task: "keep docs fresh" }];
  cfg.roles.feature = { ...defaultConfig().roles.feature!, instances: 2 };
  writeConfig(repo, cfg);
  for (const id of ["docs-bot", "feature-2"]) {
    const wt = await ensureWorktree(repo, id, "main");
    fs.writeFileSync(path.join(wt, `${id}.md`), "work\n");
    commitIn(wt, `${id} work`);
  }

  const team = await collectTeamChanges(repo);
  assert.deepEqual(team.roles.map((r) => r.role), [
    ...allRoleIds(),
    "docs-bot",
    "feature-2",
    "feature-3",
    "feature-4",
  ]);
  // instances: 2 keeps up to two runner ids per instance, so feature-3 and feature-4 are listed
  // too.
  for (const id of ["docs-bot", "feature-2"]) {
    const entry = team.roles.find((r) => r.role === id);
    assert.equal(entry?.state, "ready");
    assert.equal(entry?.ahead, 1);
    assert.deepEqual(entry?.commits.map((c) => c.subject), [`${id} work`]);
  }
});

test("a staged and an unstaged edit below the cap both appear in the uncommitted patch", async () => {
  const repo = makeRepo();
  await initProject(repo, "change-data scope staged");
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  fs.writeFileSync(path.join(repo, "b.txt"), "b\n");
  commitIn(repo, "seed a and b");
  const wt = await ensureWorktree(repo, "feature", "main");
  fs.appendFileSync(path.join(wt, "a.txt"), "staged-line\n");
  sh(wt, "git", "add", "a.txt");
  fs.appendFileSync(path.join(wt, "b.txt"), "unstaged-line\n");

  const view = await collectRoleChange(repo, "feature");
  assert.deepEqual([...view.dirtyFiles].sort(), ["a.txt", "b.txt"]);
  assert.ok(view.uncommittedDiff.includes("+staged-line"));
  assert.ok(view.uncommittedDiff.includes("+unstaged-line"));
  assert.ok(!view.uncommittedDiff.startsWith("[uncommitted diff truncated"));
});
