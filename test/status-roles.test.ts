import test from "node:test";
import assert from "node:assert/strict";
import { readSlotsState } from "../src/git/slots-state.js";
import { collectRoleRows } from "../src/status/status-roles.js";
import { initProject } from "../src/init/init.js";
import { makeRepo, tmpdir, writeConfig } from "./fixtures/repo-fixtures.js";
import { loadConfig } from "../src/config/config.js";
import { LOCAL_FREE_MODELS_JSON, writeModelsFile } from "./fixtures/models-fixtures.js";

// The roles collector builds the per-loop rows from the shared reads (config, slots) and the
// pinned now; this is the small per-domain test for status-roles.ts (the bulk of the row
// behavior is covered through snapshot() in status-data-models.test.ts).
test("collectRoleRows builds one row per loop id with the custom flag", async () => {
  const repo = makeRepo();
  await initProject(repo, "roles collector");
  writeConfig(repo, {});
  const cfg = loadConfig(repo);
  const modelsFile = writeModelsFile(tmpdir("status-roles-"), LOCAL_FREE_MODELS_JSON);
  const rows = collectRoleRows(repo, cfg, Date.now(), readSlotsState(repo).slots, modelsFile);
  assert.ok(rows.length >= 3, "one row per enabled loop");
  assert.ok(rows.every((r) => !r.custom), "built-in roles are not custom");
  assert.ok(rows.some((r) => r.role === "feature"));
  // No leases or pins in a fresh project: no slot on any row.
  assert.ok(rows.every((r) => r.slot === undefined));
});
