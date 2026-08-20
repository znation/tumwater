import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { defaultConfig, loadConfig, saveConfig } from "../src/config.js";
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
    path.join(dir, "automaton.json"),
    JSON.stringify({
      model: "sonnet",
      idleBackoff: { maxSeconds: 60 },
      roles: { clean: { enabled: false }, custom: { enabled: true } },
    }),
  );
  const config = loadConfig(dir);
  assert.equal(config.model, "sonnet");
  assert.equal(config.idleBackoff.maxSeconds, 60);
  assert.equal(config.idleBackoff.factor, defaultConfig().idleBackoff.factor);
  assert.equal(config.roles.clean?.enabled, false);
  assert.equal(config.roles.improve?.enabled, true);
  assert.equal(config.roles.custom?.enabled, true);
});

test("saveConfig round-trips", () => {
  const dir = tmpdir();
  const config = defaultConfig();
  config.provider = "anthropic";
  saveConfig(dir, config);
  assert.deepEqual(loadConfig(dir), config);
});
