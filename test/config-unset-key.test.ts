// Tests for src/config/config-write.ts's key remover (unsetConfigKey), the inverse of
// setConfigKey; the setter and the shared module invariants live in test/config-write.test.ts.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readJson } from "./helpers/json-read.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { setConfigKey, unsetConfigKey } from "../src/config/config-write.js";
import { defaultConfig, loadConfig, saveConfig } from "../src/config/config.js";

test("unsetConfigKey removes backends.<id> fields and drops the entry/section when they empty", () => {
  const dir = tmpdir();
  const base = defaultConfig();
  base.backends = { claude: { bin: "claude", args: ["--debug"] } };
  saveConfig(dir, base);
  const file = path.join(dir, "tumwater.json");

  let r = unsetConfigKey(dir, "backends.claude.bin");
  assert.ok(r.ok && r.oldValue === "claude", JSON.stringify(r));
  assert.deepEqual((readJson(file) as { backends: unknown }).backends, { claude: { args: ["--debug"] } });
  r = unsetConfigKey(dir, "backends.claude.args");
  assert.ok(r.ok && Array.isArray(r.oldValue), JSON.stringify(r));
  assert.ok(!("backends" in (readJson(file) as Record<string, unknown>)), "the emptied section is dropped");
  // An absent field is a no-op success with the reported value undefined.
  const miss = unsetConfigKey(dir, "backends.pi.bin");
  assert.ok(miss.ok && miss.oldValue === undefined, JSON.stringify(miss));
});

// unsetConfigKey — the inverse of setConfigKey: delete one top-level key or one dotted
// map/tier/role entry, dropping the containing key/section when it empties, and treating a
// key that does not hold the named entry as a no-op success.
test("unsetConfigKey removes a top-level key and an emptied dotted section, reverting to defaults", () => {
  const dir = tmpdir();
  const base = defaultConfig();
  base.quietHours = "23:00-07:00";
  base.maxDailyCostUsdPerRole = { qa: 2, feature: 1.5 };
  saveConfig(dir, base);
  const file = path.join(dir, "tumwater.json");

  // A bare top-level key is deleted outright and reports the removed value.
  let r = unsetConfigKey(dir, "quietHours");
  assert.ok(r.ok && r.oldValue === "23:00-07:00", JSON.stringify(r));
  let raw = readJson(file) as Record<string, unknown>;
  assert.ok(!("quietHours" in raw), "the top-level key is gone from the file");
  assert.equal(loadConfig(dir).quietHours, undefined, "the default (unset) window applies again");

  // Dotted map entry removal preserves the map's other entries; the section vanishes only
  // when the removed entry was the last one.
  r = unsetConfigKey(dir, "maxDailyCostUsdPerRole.feature");
  assert.ok(r.ok && r.oldValue === 1.5, JSON.stringify(r));
  raw = readJson(file) as Record<string, unknown>;
  assert.deepEqual(raw.maxDailyCostUsdPerRole, { qa: 2 }, "qa's entry survives");
  r = unsetConfigKey(dir, "maxDailyCostUsdPerRole.qa");
  assert.ok(r.ok && r.oldValue === 2, JSON.stringify(r));
  raw = readJson(file) as Record<string, unknown>;
  assert.ok(!("maxDailyCostUsdPerRole" in raw), "the emptied map is dropped, not left as {}");
});

test("unsetConfigKey removes one model tier, leaves a string model it cannot address, and drops an emptied model map", () => {
  const dir = tmpdir();
  const file = path.join(dir, "tumwater.json");
  // A minimal raw file — no defaults expanded, no trailing newline — so a no-op that
  // re-serialized the merged config would show up as a byte diff.
  fs.writeFileSync(file, JSON.stringify({ model: "old-model" }));

  // A single-selector string model resolves to { default }; unsetting another tier is a no-op
  // that leaves the string untouched.
  const before = fs.readFileSync(file, "utf8");
  let r = unsetConfigKey(dir, "model.strong");
  assert.ok(r.ok && r.oldValue === undefined, JSON.stringify(r));
  assert.equal((readJson(file) as { model: unknown }).model, "old-model", "the string model survives the no-op");
  assert.equal(fs.readFileSync(file, "utf8"), before, "an absent tier leaves the file byte-identical, not rewritten expanded");

  // Promote the string to a map by setting two tiers, then remove one, preserving the rest.
  assert.ok(setConfigKey(dir, "model.strong", "s").ok);
  assert.ok(setConfigKey(dir, "model.small", "m").ok);
  r = unsetConfigKey(dir, "model.strong");
  assert.ok(r.ok && r.oldValue === "s", JSON.stringify(r));
  assert.deepEqual((readJson(file) as { model: unknown }).model, { default: "old-model", small: "m" });

  // Removing the remaining tiers empties the map and drops the whole `model` key.
  assert.ok(unsetConfigKey(dir, "model.default").ok);
  r = unsetConfigKey(dir, "model.small");
  assert.ok(r.ok && r.oldValue === "m", JSON.stringify(r));
  assert.ok(!("model" in (readJson(file) as Record<string, unknown>)), "the last tier drops the model key");
});

test("an absent-entry unset is a true no-op: the minimal file keeps its exact bytes", () => {
  const dir = tmpdir();
  const file = path.join(dir, "tumwater.json");
  // Minimal raw file: a map with one entry and nothing else, written without the trailing
  // newline writeJsonAtomic adds. Any write at all changes the bytes, so byte-identity here
  // proves the no-op skipped the write rather than reformatting the merged defaults in place.
  fs.writeFileSync(file, JSON.stringify({ maxDailyCostUsdPerRole: { qa: 2 } }));
  const before = fs.readFileSync(file, "utf8");

  const mapMiss = unsetConfigKey(dir, "maxDailyCostUsdPerRole.clean");
  assert.ok(mapMiss.ok && mapMiss.oldValue === undefined, JSON.stringify(mapMiss));
  assert.equal(fs.readFileSync(file, "utf8"), before, "an absent map entry leaves the file byte-identical");

  // A role the file never mentions: the merged config seeds its defaults, but unsetting a
  // field that only the defaults carry is still nothing to remove.
  const roleMiss = unsetConfigKey(dir, "roles.qa.model");
  assert.ok(roleMiss.ok && roleMiss.oldValue === undefined, JSON.stringify(roleMiss));
  assert.equal(fs.readFileSync(file, "utf8"), before, "an absent role field leaves the file byte-identical");

  // Default-carrying top-level keys the file never set (the merged config always has them):
  // unsetting one must skip the write, not reformat the file with every default expanded.
  for (const key of ["maxConcurrent", "quietHours"]) {
    const topMiss = unsetConfigKey(dir, key);
    assert.ok(topMiss.ok && topMiss.oldValue === undefined, `${key}: ${JSON.stringify(topMiss)}`);
    assert.equal(fs.readFileSync(file, "utf8"), before, `${key}: an absent top-level key leaves the file byte-identical`);
  }

  // A role field the file never set but the defaults seed (roles.qa seeds
  // minRunIntervalSeconds 7200): the reported oldValue must be undefined, not the default.
  const seededField = unsetConfigKey(dir, "roles.qa.minRunIntervalSeconds");
  assert.ok(seededField.ok && seededField.oldValue === undefined, JSON.stringify(seededField));
  assert.equal(fs.readFileSync(file, "utf8"), before, "a default-seeded role field leaves the file byte-identical");
});

test("unsetConfigKey removes one role field, preserving siblings, and reverts an overridden default", () => {
  const dir = tmpdir();
  const base = defaultConfig();
  base.roles.qa = {
    enabled: true,
    model: "m-qa",
    instructions: "test things",
    minRunIntervalSeconds: 3600,
  };
  saveConfig(dir, base);
  const file = path.join(dir, "tumwater.json");

  // A field with no default (model) is removed outright; the entry's other fields survive.
  let r = unsetConfigKey(dir, "roles.qa.model");
  assert.ok(r.ok && r.oldValue === "m-qa", JSON.stringify(r));
  const roles = (readJson(file) as { roles: Record<string, Record<string, unknown>> }).roles;
  assert.equal(roles.qa!.instructions, "test things", "the entry's other fields survive");
  assert.ok(!("model" in roles.qa!), "only the named field is removed");

  // Unsetting the already-absent model is a no-op success.
  r = unsetConfigKey(dir, "roles.qa.model");
  assert.ok(r.ok && r.oldValue === undefined, JSON.stringify(r));

  // A field WITH a default reverts to it: the override leaves the file (the entry keeps its
  // seeded `enabled` but never a stale value) and the resolved value is the default again.
  r = unsetConfigKey(dir, "roles.qa.minRunIntervalSeconds");
  assert.ok(r.ok && r.oldValue === 3600, JSON.stringify(r));
  assert.ok(!("minRunIntervalSeconds" in (readJson(file) as { roles: Record<string, Record<string, unknown>> }).roles.qa!));
  assert.equal(loadConfig(dir).roles.qa!.minRunIntervalSeconds, 7200, "the default applies again");
});

test("unsetConfigKey drops a roles entry it empties, keeping the rest of the section", () => {
  const dir = tmpdir();
  saveConfig(dir, defaultConfig());
  const file = path.join(dir, "tumwater.json");
  const roles = (readJson(file) as { roles: Record<string, unknown> }).roles;
  // A default role entry in the file holds only its seeded `enabled`, so unsetting that one
  // field empties the entry: it is dropped rather than left as an empty object.
  assert.deepEqual(roles.clean, { enabled: true }, "clean seeds a single enabled field");
  const r = unsetConfigKey(dir, "roles.clean.enabled");
  assert.ok(r.ok && r.oldValue === true, JSON.stringify(r));
  const after = (readJson(file) as { roles: Record<string, unknown> }).roles;
  assert.ok(!("clean" in after), "the emptied roles entry is removed from the file");
  assert.ok("qa" in after, "the roles section keeps its other entries");
  assert.equal(loadConfig(dir).roles.clean?.enabled, true, "the default applies again");
});

test("unsetConfigKey rejects unknown keys and role fields, and a validation failure leaves the file byte-identical", () => {
  const dir = tmpdir();
  const base = defaultConfig();
  base.customRoles = [{ name: "myloop", task: "do a thing" }];
  base.roles.myloop = { enabled: true };
  saveConfig(dir, base);
  const file = path.join(dir, "tumwater.json");
  const before = fs.readFileSync(file, "utf8");

  const badKey = unsetConfigKey(dir, "modle");
  assert.equal(badKey.ok, false);
  if (!badKey.ok) assert.match(badKey.error, /unknown config key "modle"/);
  const badField = unsetConfigKey(dir, "roles.qa.colour");
  assert.equal(badField.ok, false);
  if (!badField.ok) assert.match(badField.error, /unknown role field "colour" for roles\.qa/);
  assert.equal(fs.readFileSync(file, "utf8"), before, "refused non-writes leave the file byte-identical");

  // Removing customRoles while roles.myloop remains is a candidate validateConfig rejects:
  // nothing is written and the error is surfaced.
  const rejected = unsetConfigKey(dir, "customRoles");
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.match(rejected.error, /roles\.myloop|customRoles/);
  assert.equal(fs.readFileSync(file, "utf8"), before, "a rejected candidate leaves the file byte-identical");
});

