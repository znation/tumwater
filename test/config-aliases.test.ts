import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { readJson } from "./helpers/json-read.js";
import { canonicalConfigKey, normalizeConfigKeys } from "../src/config/config-aliases.js";
import { loadConfig, loadConfigSafe } from "../src/config/config.js";
import { setConfigKey, unsetConfigKey } from "../src/config/config-write.js";
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

test("the run timeout and min run interval load from their old spellings, top level and per role", () => {
  const dir = tmpdir();
  writeConfig(dir, { tickTimeoutSeconds: 600, roles: { qa: { minTickIntervalSeconds: 60 } } });
  const cfg = loadConfig(dir);
  assert.equal(cfg.runTimeoutSeconds, 600);
  assert.equal(cfg.roles.qa?.minRunIntervalSeconds, 60);
  const detail = checkConfigKeyNames(dir).detail;
  assert.match(detail, /tickTimeoutSeconds → runTimeoutSeconds/);
  assert.match(detail, /roles\.qa\.minTickIntervalSeconds → roles\.qa\.minRunIntervalSeconds/);
});

test("a role entry setting both interval spellings is refused", () => {
  const dir = tmpdir();
  writeConfig(dir, { roles: { qa: { minTickIntervalSeconds: 60, minRunIntervalSeconds: 30 } } });
  const { error } = loadConfigSafe(dir);
  assert.match(error ?? "", /roles\.qa\.minTickIntervalSeconds and roles\.qa\.minRunIntervalSeconds are both set/);
});

test("config set and unset reach the renamed role and top-level keys", () => {
  const dir = tmpdir();
  const file = writeConfig(dir, { tickTimeoutSeconds: 600, roles: { qa: { minTickIntervalSeconds: 10 } } });
  const r = setConfigKey(dir, "roles.qa.minTickIntervalSeconds", "60");
  assert.ok(r.ok, JSON.stringify(r));
  const written = readJson(file) as { roles: { qa: Record<string, unknown> } };
  assert.equal(written.roles.qa.minRunIntervalSeconds, 60);
  assert.ok(!("minTickIntervalSeconds" in written.roles.qa));
  const u = unsetConfigKey(dir, "tickTimeoutSeconds");
  assert.ok(u.ok, JSON.stringify(u));
  assert.ok(!("tickTimeoutSeconds" in (readJson(file) as object)));
});

test("agent and agents load as backend and backends, and config set writes the new names", () => {
  const dir = tmpdir();
  // legacy spelling, retired in part 5/5
  const file = writeConfig(dir, { agent: "claude", agents: { claude: { args: ["--x"] } } });
  const cfg = loadConfig(dir);
  assert.equal(cfg.backend, "claude");
  assert.deepEqual(cfg.backends?.claude?.args, ["--x"]);
  const detail = checkConfigKeyNames(dir).detail;
  assert.match(detail, /agent → backend/);
  assert.match(detail, /agents → backends/);
  const r = setConfigKey(dir, "agents.pi.bin", "/opt/pi");
  assert.ok(r.ok, JSON.stringify(r));
  const written = readJson(file) as Record<string, unknown>;
  assert.ok(!("agent" in written) && !("agents" in written));
  assert.equal(written.backend, "claude");
  assert.deepEqual((written.backends as Record<string, unknown>).pi, { bin: "/opt/pi" });
  assert.ok(setConfigKey(dir, "maxDailyCostUsd", "5").ok);
  assert.equal(loadConfig(dir).backend, "claude");
});

test("agentBin beside agents.pi.bin is refused naming backends.pi.bin", () => {
  const dir = tmpdir();
  writeConfig(dir, { agentBin: "/a", agents: { pi: { bin: "/b" } } });
  const { error } = loadConfigSafe(dir);
  assert.match(error ?? "", /agentBin and backends\.pi\.bin set the same value/);
});
