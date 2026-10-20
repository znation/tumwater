import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { teamWorkspaceMessage } from "../src/gates/readiness.js";
import { cli } from "./helpers/cli-harness.js";
import { sh, teamWorkspace } from "./fixtures/repo-fixtures.js";

test("an ungated command run in a team workspace names the owning team root", async () => {
  const { root, slot } = teamWorkspace();
  for (const args of [["report"], ["report", "--failures"], ["backlog"], ["questions"], ["role", "feature"], ["bug", "--list"], ["plan", "--show", "1"]]) {
    const r = await cli(slot, ...args);
    assert.equal(r.code, 1, args.join(" "));
    assert.ok(r.stderr.includes(teamWorkspaceMessage(root)), args.join(" "));
  }
});

test("`role <id> --model` in a team workspace refuses and writes nothing", async () => {
  const { root, slot } = teamWorkspace();
  const r = await cli(slot, "role", "feature", "--model", "strong");
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes(teamWorkspaceMessage(root)));
  assert.equal(fs.existsSync(path.join(slot, "tumwater.json")), false);
  assert.equal(fs.existsSync(path.join(slot, ".tumwater")), false);
  assert.equal(sh(slot, "git", "status", "--porcelain"), "");
});

test("the argument gate still runs first in a workspace", async () => {
  const { root, slot } = teamWorkspace();
  const r = await cli(slot, "report", "--days", "abc");
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes("--days"));
  assert.ok(!r.stderr.includes(teamWorkspaceMessage(root)));
});

test("`completion bash` still works in a workspace", async () => {
  const { slot } = teamWorkspace();
  assert.equal((await cli(slot, "completion", "bash")).code, 0);
});
