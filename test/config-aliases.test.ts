import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { readJson } from "./helpers/json-read.js";
import { canonicalConfigKey, normalizeConfigKeys } from "../src/config/config-aliases.js";
import { loadConfig, loadConfigSafe } from "../src/config/config.js";
import { setConfigKey } from "../src/config/config-write.js";
import { checkConfigKeyNames, checkInit } from "../src/doctor/doctor-checks.js";

function writeConfig(dir: string, body: unknown): string {
  const file = path.join(dir, "tumwater.json");
  fs.writeFileSync(file, JSON.stringify(body));
  return file;
}

test("normalizeConfigKeys moves old names without mutating the input", () => {
  const input = { landBatchMax: 5, other: 1 };
  const out = normalizeConfigKeys(input);
  assert.deepEqual(out.raw, { mergeBatchMax: 5, other: 1 });
  assert.deepEqual(out.renamed, ["landBatchMax → mergeBatchMax"]);
  assert.deepEqual(input, { landBatchMax: 5, other: 1 });
  assert.deepEqual(normalizeConfigKeys(7), { raw: 7, renamed: [], problems: [] });
});

test("normalizeConfigKeys names a pair set both ways", () => {
  const out = normalizeConfigKeys({ maintenancePerWorkLanding: 1, maintenancePerWorkMerge: 2 });
  assert.equal(out.problems.length, 1);
  assert.match(out.problems[0] ?? "", /maintenancePerWorkLanding and maintenancePerWorkMerge are both set — keep maintenancePerWorkMerge/);
});

test("canonicalConfigKey maps old spellings and passes others through", () => {
  assert.equal(canonicalConfigKey("landBatchMax"), "mergeBatchMax");
  assert.equal(canonicalConfigKey("landBatchMax.x"), "mergeBatchMax.x");
  assert.equal(canonicalConfigKey("roles.qa.enabled"), "roles.qa.enabled");
  assert.equal(canonicalConfigKey("logMaxBytes"), "logMaxBytes");
});

test("an old-key file loads, config set migrates it, and both-set is refused", () => {
  const dir = tmpdir();
  const file = writeConfig(dir, { landBatchMax: 5 });
  assert.equal(loadConfig(dir).mergeBatchMax, 5);
  assert.equal(checkConfigKeyNames(dir).level, "warn");
  assert.match(checkConfigKeyNames(dir).detail, /landBatchMax → mergeBatchMax/);
  const r = setConfigKey(dir, "landBatchMax", "4");
  assert.ok(r.ok, JSON.stringify(r));
  const written = readJson(file) as Record<string, unknown>;
  assert.equal(written.mergeBatchMax, 4);
  assert.ok(!("landBatchMax" in written));
  assert.equal(checkConfigKeyNames(dir).level, "ok");

  writeConfig(dir, { maintenancePerWorkLanding: 1, maintenancePerWorkMerge: 2 });
  const { error } = loadConfigSafe(dir);
  assert.match(error ?? "", /maintenancePerWorkLanding.*maintenancePerWorkMerge.*keep maintenancePerWorkMerge/);
  const init = checkInit(dir);
  assert.equal(init.level, "fail");
  assert.match(init.detail, /keep maintenancePerWorkMerge/);
});
