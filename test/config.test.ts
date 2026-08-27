import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  configForRole,
  defaultConfig,
  loadConfig,
  loadConfigSafe,
  saveConfig,
  validateConfig,
} from "../src/config.js";
import { allRoleIds } from "../src/roles.js";
import { tmpdir } from "./util.js";

test("defaultConfig enables every role including director", () => {
  const config = defaultConfig();
  for (const id of allRoleIds()) {
    assert.equal(config.roles[id]?.enabled, true, `role ${id} should default enabled`);
  }
  assert.ok(config.maxConcurrent >= 1);
  assert.ok(config.idleBackoff.maxSeconds >= config.idleBackoff.initialSeconds);
});

test("loadConfig without a file returns defaults", () => {
  const dir = tmpdir();
  assert.deepEqual(loadConfig(dir), defaultConfig());
});

test("loadConfig merges partial files over defaults", () => {
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, "tumwater.json"),
    JSON.stringify({
      model: "sonnet",
      idleBackoff: { maxSeconds: 60 },
      roles: { clean: { enabled: false }, perf: { enabled: true } },
    }),
  );
  const config = loadConfig(dir);
  assert.equal(config.model, "sonnet");
  assert.equal(config.idleBackoff.maxSeconds, 60);
  assert.equal(config.idleBackoff.factor, defaultConfig().idleBackoff.factor);
  assert.equal(config.roles.clean?.enabled, false);
  assert.equal(config.roles.improve?.enabled, true);
  assert.equal(config.roles.perf?.enabled, true);
});

test("saveConfig round-trips", () => {
  const dir = tmpdir();
  const config = defaultConfig();
  config.provider = "anthropic";
  saveConfig(dir, config);
  assert.deepEqual(loadConfig(dir), config);
});

test("configForRole applies role overrides over top-level pi settings", () => {
  const config = defaultConfig();
  config.provider = "top-provider";
  config.model = "top-model";
  config.roles.feature = { enabled: true, model: "strong-model", thinking: "high" };
  const feature = configForRole(config, "feature");
  assert.equal(feature.provider, "top-provider");
  assert.equal(feature.model, "strong-model");
  assert.equal(feature.thinking, "high");
  const clean = configForRole(config, "clean");
  assert.equal(clean.model, "top-model");
  assert.equal(clean.thinking, undefined);
  assert.deepEqual(configForRole(config, "nonexistent"), config);
});

function validationError(raw: unknown): string {
  try {
    validateConfig(raw);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("validateConfig did not throw");
}

test("validateConfig accepts defaults and fully valid overrides", () => {
  assert.doesNotThrow(() => validateConfig(defaultConfig()));
  assert.doesNotThrow(() =>
    validateConfig({
      provider: "lmstudio",
      model: "qwen",
      thinking: "high",
      piArgs: ["--foo"],
      maxConcurrent: 2,
      minTickIntervalSeconds: 0,
      tickTimeoutSeconds: 60,
      logMaxBytes: 1024,
      sessionRetentionDays: 3,
      idleBackoff: { initialSeconds: 5, factor: 1.5, maxSeconds: 60 },
      roles: { feature: { enabled: false, model: "big", instructions: "be careful" } },
    }),
  );
});

test("validateConfig reports every invalid value in one error", () => {
  const msg = validationError({
    maxConcurrent: -3,
    tickTimeoutSeconds: "90m",
    logMaxBytes: 0,
    piArgs: "--verbose",
    idleBackoff: { factor: 0 },
    roles: { clean: { enabled: "false" } },
  });
  assert.match(msg, /^invalid tumwater\.json:/);
  for (const field of [
    "maxConcurrent must be an integer of at least 1 (got -3)",
    'tickTimeoutSeconds must be a number greater than 0 (got "90m")',
    "logMaxBytes must be a number greater than 0 (got 0)",
    'piArgs must be an array of strings (got "--verbose")',
    "idleBackoff.factor must be a number of at least 1 (got 0)",
    'roles.clean.enabled must be true or false (got "false")',
  ]) {
    assert.ok(msg.includes(field), `error message should mention: ${field}`);
  }
});

test("validateConfig rejects non-object top levels and bad containers", () => {
  for (const raw of [null, 42, "hi", [1]]) {
    assert.match(validationError(raw), /tumwater\.json must be a JSON object/);
  }
  assert.match(validationError({ roles: "oops" }), /roles must be an object mapping role ids to settings/);
  assert.match(validationError({ idleBackoff: 5 }), /idleBackoff must be an object/);
  assert.match(validationError({ roles: { clean: "nope" } }), /roles\.clean must be an object/);
});

test("validateConfig rejects unknown keys with the valid ones listed", () => {
  // A misspelled key would otherwise be silently ignored and the default used.
  const top = validationError({ tickTimeoutSecondss: 90 });
  assert.match(top, /unknown key "tickTimeoutSecondss" in tumwater\.json \(valid keys: .*tickTimeoutSeconds.*\)/);

  const backoff = validationError({ idleBackoff: { factorr: 2 } });
  assert.match(backoff, /unknown key "factorr" in idleBackoff \(valid keys: initialSeconds, factor, maxSeconds\)/);

  const roleEntry = validationError({ roles: { feature: { enabed: true } } });
  assert.match(roleEntry, /unknown key "enabed" in roles\.feature \(valid keys: enabled, instructions, provider, model, thinking\)/);
});

test("validateConfig rejects unknown role ids (a typo would spawn a phantom erroring loop)", () => {
  const msg = validationError({ roles: { featuer: { enabled: true } } });
  assert.match(msg, /roles\.featuer is not a known role \(valid ids: .*feature.*\)/);
  // The valid-id list covers the whole catalog, including the director.
  for (const id of allRoleIds()) assert.ok(msg.includes(id), `error should list ${id}`);

  // loadConfig and the live-reload path surface the same actionable message.
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "tumwater.json"), JSON.stringify({ roles: { featuer: {} } }));
  assert.throws(() => loadConfig(dir), /roles\.featuer is not a known role/);
  assert.match(loadConfigSafe(dir).error ?? "", /roles\.featuer is not a known role/);
});

test("loadConfig rejects malformed JSON and invalid values with actionable messages", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "tumwater.json"), "{ not json");
  assert.throws(() => loadConfig(dir), /tumwater\.json is not valid JSON/);

  fs.writeFileSync(path.join(dir, "tumwater.json"), JSON.stringify({ maxConcurrent: 0 }));
  assert.throws(() => loadConfig(dir), /maxConcurrent must be an integer of at least 1 \(got 0\)/);
});

test("loadConfigSafe returns the config when valid and the error message otherwise", () => {
  const dir = tmpdir();
  // No file: defaults, no error.
  assert.deepEqual(loadConfigSafe(dir), { config: defaultConfig() });

  fs.writeFileSync(path.join(dir, "tumwater.json"), JSON.stringify({ model: "sonnet" }));
  const ok = loadConfigSafe(dir);
  assert.equal(ok.error, undefined);
  assert.equal(ok.config?.model, "sonnet");

  // Broken JSON and invalid values surface as messages, never throws.
  fs.writeFileSync(path.join(dir, "tumwater.json"), "{ not json");
  const broken = loadConfigSafe(dir);
  assert.equal(broken.config, undefined);
  assert.match(broken.error ?? "", /not valid JSON/);

  fs.writeFileSync(path.join(dir, "tumwater.json"), JSON.stringify({ maxConcurrent: 0 }));
  assert.match(loadConfigSafe(dir).error ?? "", /maxConcurrent must be an integer of at least 1/);
});

test("saveConfig refuses to persist invalid configs", () => {
  const dir = tmpdir();
  const config = defaultConfig();
  config.maxConcurrent = -1;
  assert.throws(() => saveConfig(dir, config), /maxConcurrent must be an integer of at least 1/);
  assert.ok(!fs.existsSync(path.join(dir, "tumwater.json")), "nothing written on invalid config");
});
