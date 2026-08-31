import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  configForRole,
  defaultConfig,
  loadConfig,
  loadConfigSafe,
  reviewConfig,
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

test("defaultConfig gives the slow-clock roles their clocks and no other role one", () => {
  // Regression: feature tick 49 set this via `roles.steward.minTickIntervalSeconds = …`,
  // which does not compile under noUncheckedIndexedAccess — a broken build landed on main.
  const config = defaultConfig();
  assert.equal(configForRole(config, "steward").minTickIntervalSeconds, 21600);
  assert.equal(configForRole(config, "qa").minTickIntervalSeconds, 7200);
  for (const id of allRoleIds()) {
    if (id === "steward" || id === "qa") continue;
    // Every other role falls back to the global interval.
    assert.equal(
      configForRole(config, id).minTickIntervalSeconds,
      config.minTickIntervalSeconds,
      `role ${id} should inherit the global minTickIntervalSeconds`,
    );
  }
});

test("defaultConfig carries the thrash thresholds and validation guards them", () => {
  // AC5 (plans/refusal-and-thrash.md): the friction thresholds default to 40 turns / 60
  // minutes, and invalid values are rejected with actionable errors like every other knob.
  const config = defaultConfig();
  assert.equal(config.thrashTurns, 40);
  assert.equal(config.thrashMinutes, 60);
  assert.doesNotThrow(() => validateConfig(config));

  for (const [key, bad] of [
    ["thrashTurns", -1],
    ["thrashMinutes", -0.5],
    ["thrashTurns", "40"],
    ["thrashMinutes", null],
  ] as const) {
    // The "s" flag lets .* cross the newline between the error header and its bulleted
    // problems; without it the anchor matched only single-line messages.
    assert.match(
      validationError({ [key]: bad }),
      new RegExp(`^invalid tumwater\\.json:.*${key} must be a number of 0 or more \\(got ${JSON.stringify(bad)}\\)`, "s"),
      `${key}: ${bad} should be rejected with an actionable error`,
    );
  }
});

test("defaultConfig carries the daily cost budget cap and validation guards it", () => {
  // AC1 (plans/daily-cost-budget.md): an unattended fleet must not spend unbounded, so the
  // cap defaults to $50/day; 0 disables. Invalid values are rejected with actionable errors
  // like every other knob.
  const config = defaultConfig();
  assert.equal(config.maxDailyCostUsd, 50);
  assert.doesNotThrow(() => validateConfig({ maxDailyCostUsd: 0 }));

  for (const bad of [-1, "50", null]) {
    // The "s" flag lets .* cross the newline between the error header and its bulleted
    // problems; without it the anchor matched only single-line messages.
    assert.match(
      validationError({ maxDailyCostUsd: bad }),
      new RegExp(`^invalid tumwater\\.json:.*maxDailyCostUsd must be a number of 0 or more \\(0 disables\\) \\(got ${JSON.stringify(bad)}\\)`, "s"),
      `maxDailyCostUsd: ${bad} should be rejected with an actionable error`,
    );
  }

  // A typo'd key name would otherwise be silently ignored and the default used — a fleet
  // that meant to cap its spend would then spend unbounded. TOP_LEVEL_KEYS must fail it.
  assert.match(
    validationError({ maxDailyCostUss: 50 }),
    /unknown key "maxDailyCostUss" in tumwater\.json \(valid keys: .*maxDailyCostUsd.*\)/,
  );

  // loadConfig over an existing file lacking the key picks up the default without editing.
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "tumwater.json"), JSON.stringify({ model: "sonnet" }));
  const loaded = loadConfig(dir);
  assert.equal(loaded.model, "sonnet");
  assert.equal(loaded.maxDailyCostUsd, 50);
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

test("loadConfig enables qa with its slow clock when the file omits it", () => {
  // This repo's tumwater.json lists every other role but not qa (or steward): per-role
  // defaults merge in for ids absent from the file, so enabling needs no config edit.
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, "tumwater.json"),
    JSON.stringify({ roles: { feature: { enabled: true } } }),
  );
  const config = loadConfig(dir);
  assert.equal(config.roles.qa?.enabled, true);
  assert.equal(configForRole(config, "qa").minTickIntervalSeconds, 7200);
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

test("reviewConfig applies the review section's overrides over top-level pi settings", () => {
  const config = defaultConfig();
  config.provider = "top-provider";
  config.model = "top-model";
  config.review = { enabled: true, exemptPaths: [], model: "strong-model", thinking: "high" };
  const review = reviewConfig(config);
  assert.equal(review.provider, "top-provider");
  assert.equal(review.model, "strong-model");
  assert.equal(review.thinking, "high");

  // No overrides in the section → top-level values pass through unchanged.
  const plain = reviewConfig(defaultConfig());
  assert.equal(plain.provider, undefined);
  assert.equal(plain.model, undefined);
  assert.equal(plain.thinking, undefined);
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
    roles: { clean: { enabled: "false" }, feature: { minTickIntervalSeconds: -5 } },
  });
  assert.match(msg, /^invalid tumwater\.json:/);
  for (const field of [
    "maxConcurrent must be an integer of at least 1 (got -3)",
    'tickTimeoutSeconds must be a number greater than 0 (got "90m")',
    "logMaxBytes must be a number greater than 0 (got 0)",
    'piArgs must be an array of strings (got "--verbose")',
    "idleBackoff.factor must be a number of at least 1 (got 0)",
    'roles.clean.enabled must be true or false (got "false")',
    // AC3 (plans/steward-role.md): the per-role slow clock is validated like its siblings —
    // a negative interval would schedule ticks in the past and spin the loop.
    "roles.feature.minTickIntervalSeconds must be a number of 0 or more (got -5)",
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
  assert.match(
    roleEntry,
    /unknown key "enabed" in roles\.feature \(valid keys: enabled, instructions, provider, model, thinking, minTickIntervalSeconds\)/,
  );
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
