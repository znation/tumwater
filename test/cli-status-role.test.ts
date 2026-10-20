import test from "node:test";
import assert from "node:assert/strict";
import { initProject } from "../src/init/init.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { cli } from "./helpers/cli-harness.js";

// `tumwater status --role`: the role list is validated before anything renders.
test("status --role rejects an unknown or empty role id", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli status role");
  const unknown = await cli(repo, "status", "--role", "nosuch");
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /nosuch/);
  const empty = await cli(repo, "status", "--role", "");
  assert.equal(empty.code, 1);
  assert.match(empty.stderr, /--role/);
  const ok = await cli(repo, "status", "--role", "clean", "--json");
  assert.equal(ok.code, 0);
});
