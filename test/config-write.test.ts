// Tests for src/config/config-write.ts's key-editing engine (setConfigKey, parseConfigKey) and
// the module-wide invariants every write path shares (the file's own roles section, one pi
// spelling, cross-process locking). The budget setter is in test/config-budget.test.ts, the
// config request in test/config-request.test.ts, and unsetConfigKey in
// test/config-unset-key.test.ts. Tests for src/config/config.ts itself live in
// test/config.test.ts and for src/config/config-validation.ts in test/config-validation.test.ts.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readJson } from "./helpers/json-read.js";
import { fileURLToPath } from "node:url";
import { spawnReadyChild, stopChild } from "./helpers/child-process.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { setConfigKey, unsetConfigKey, setDailyBudgetUsd } from "../src/config/config-write.js";
import { parseConfigKey } from "../src/config/config-keys.js";
import { helpTopic } from "../src/cli/help.js";
import { defaultConfig, loadConfig, saveConfig } from "../src/config/config.js";

// setConfigKey — `tumwater config set`'s engine: one top-level key, the value JSON-parsed
// when parseable and the literal string otherwise, the whole merged candidate validated
// before any write.
test("setConfigKey parses JSON values, keeps literal strings, and preserves other keys", () => {
  const dir = tmpdir();
  const base = defaultConfig();
  base.maxConcurrent = 3;
  saveConfig(dir, base);

  // A JSON-parseable value keeps its parsed type: numbers stay numbers, quoted text strings.
  let r = setConfigKey(dir, "minRunIntervalSeconds", "45");
  assert.deepEqual(r, { ok: true, value: 45, oldValue: defaultConfig().minRunIntervalSeconds });
  let raw = readJson(path.join(dir, "tumwater.json")) as Record<string, unknown>;
  assert.equal(raw.minRunIntervalSeconds, 45, "config set minRunIntervalSeconds=45 persists the parsed number 45");
  assert.equal(raw.maxConcurrent, 3, "other keys preserved");

  r = setConfigKey(dir, "model", '"gpt-5"');
  assert.ok(r.ok && r.value === "gpt-5");

  // A non-JSON value lands as the literal string — `set model gpt-5` needs no quotes.
  r = setConfigKey(dir, "model", "gpt-5");
  assert.ok(r.ok && r.value === "gpt-5" && r.oldValue === "gpt-5");
  raw = readJson(path.join(dir, "tumwater.json")) as Record<string, unknown>;
  assert.equal(raw.model, "gpt-5", "config set model gpt-5 (unquoted) persists the literal string gpt-5");
});

// The `tumwater help config` example lists settable top-level keys (BUGS.md 2026-10-11): it
// named the legacy `fallbackModel`, which `config set` refuses to add to a fresh config, so
// the usage text pointed a first-time user at a key the command then rejected. The example's
// keys are read from the help text itself and run through the writer, so help cannot name a
// legacy-only key the writer refuses absent a prior value again.
test("the config help example names no key the writer refuses as legacy-only", () => {
  const dir = tmpdir();
  saveConfig(dir, defaultConfig());

  const stanza = helpTopic("config")!;
  const match = /top-level key — ([\s\S]*?), among others/.exec(stanza);
  assert.ok(match, "the config help still describes its settable-key example");
  const keys = match![1]!.split(",").map((s) => /^\s*([A-Za-z][A-Za-z0-9]*)/.exec(s)![1]!);
  assert.ok(keys.includes("fallback"), "the example names the current fallback key");
  assert.ok(!keys.includes("fallbackModel"), "the example drops the legacy-only fallbackModel");
  for (const key of keys) {
    const r = setConfigKey(dir, key, "{}");
    if (!r.ok) assert.doesNotMatch(r.error, /writer never adds legacy/, `help example key ${key} is refused as legacy`);
  }
});

test("setConfigKey rejects an unknown key and a type-invalid value, leaving the file untouched", () => {
  const dir = tmpdir();
  saveConfig(dir, defaultConfig());
  const file = path.join(dir, "tumwater.json");
  const before = fs.readFileSync(file, "utf8");

  // An unknown key: the error names the valid keys (the same list checkKnownKeys enforces)
  // and points a typo at its real spelling, like the unknown-command error does.
  let r = setConfigKey(dir, "modle", "x");
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.error, /unknown config key "modle" \(valid top-level keys: .+\)/);
    assert.match(r.error, /— did you mean `model`\?/);
  }

  // A type-invalid value fails with validateConfig's own message.
  r = setConfigKey(dir, "minRunIntervalSeconds", '"45"');
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /minRunIntervalSeconds must be a number of 0 or more/);

  // Both failures left tumwater.json byte-identical.
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("setConfigKey writes and clears quietHours; a malformed window fails untouched", () => {
  const dir = tmpdir();
  saveConfig(dir, defaultConfig());
  const file = path.join(dir, "tumwater.json");

  // A valid window persists as the literal string (no JSON quotes needed).
  let r = setConfigKey(dir, "quietHours", "23:00-07:00");
  assert.ok(r.ok && r.value === "23:00-07:00");
  let raw = readJson(file) as Record<string, unknown>;
  assert.equal(raw.quietHours, "23:00-07:00", "a valid quietHours persists as the literal string");

  // An empty string is the documented off.
  r = setConfigKey(dir, "quietHours", "");
  assert.ok(r.ok && r.value === "");
  raw = readJson(file) as Record<string, unknown>;
  assert.equal(raw.quietHours, "", "an empty quietHours persists as the documented off value");

  // A malformed window fails with checkQuietHours's own actionable message, and the file is
  // byte-identical — the per-key validator screens it before writeConfigMutation runs.
  const before = fs.readFileSync(file, "utf8");
  r = setConfigKey(dir, "quietHours", "25:00-07:00");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /quietHours times must be 24-hour/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

// Dotted per-role keys (parseConfigKey via setConfigKey): `<map>.<role>` and
// `roles.<id>.<field>` MERGE one entry into the existing map/section, so steering one role
// never requires re-typing the others; bare keys keep their whole-value semantics.
test("setConfigKey merges one dotted map entry, preserving the other roles' entries", () => {
  const dir = tmpdir();
  const base = defaultConfig();
  base.maxDailyCostUsdPerRole = { qa: 2 };
  base.quietHoursPerRole = { qa: "23:00-07:00" };
  saveConfig(dir, base);
  const file = path.join(dir, "tumwater.json");

  // A dotted dollar-cap entry merges: qa's value stays byte-identical in the file.
  const before = fs.readFileSync(file, "utf8");
  let r = setConfigKey(dir, "maxDailyCostUsdPerRole.feature", "1.5");
  assert.ok(r.ok && r.value === 1.5 && r.oldValue === undefined, JSON.stringify(r));
  const raw = readJson(file) as Record<string, unknown>;
  assert.deepEqual(raw.maxDailyCostUsdPerRole, { qa: 2, feature: 1.5 }, "merge, not replace");
  assert.ok(before.includes('"qa": 2') && fs.readFileSync(file, "utf8").includes('"qa": 2'), "qa's entry survives verbatim");

  // A second write to the same dotted key reports the previous value.
  r = setConfigKey(dir, "maxDailyCostUsdPerRole.feature", "3");
  assert.ok(r.ok && r.value === 3 && r.oldValue === 1.5, JSON.stringify(r));

  // quietHoursPerRole.<role> merges too, and an invalid window fails untouched.
  r = setConfigKey(dir, "quietHoursPerRole.clean", "01:00-06:00");
  assert.ok(r.ok && r.value === "01:00-06:00");
  assert.deepEqual(
    (readJson(file) as Record<string, unknown>).quietHoursPerRole,
    { qa: "23:00-07:00", clean: "01:00-06:00" },
  );
  const untouched = fs.readFileSync(file, "utf8");
  r = setConfigKey(dir, "quietHoursPerRole.clean", "25:00-07:00");
  assert.equal(r.ok, false);
  // The error names the key the operator set, not the fleet-wide `quietHours`.
  if (!r.ok) assert.match(r.error, /quietHoursPerRole\.clean times must be 24-hour/);
  assert.equal(fs.readFileSync(file, "utf8"), untouched, "a rejected dotted value changes nothing");

  // A non-numeric dollar cap fails with checkDailyBudgetUsd's message, before the write —
  // named for the dotted key set, not the fleet-wide `maxDailyCostUsd`.
  r = setConfigKey(dir, "maxDailyCostUsdPerRole.feature", '"lots"');
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /maxDailyCostUsdPerRole\.feature must be a number of 0 or more/);
  assert.equal(fs.readFileSync(file, "utf8"), untouched);
});

test("maxConcurrentPerProvider.<provider> merges and round-trips through set and unset", () => {
  const dir = tmpdir();
  const base = defaultConfig();
  base.maxConcurrentPerProvider = { omlx: 3 };
  saveConfig(dir, base);
  const file = path.join(dir, "tumwater.json");

  // A dotted provider-cap entry merges; a value that is not a positive integer fails naming
  // the dotted key, and the file stays byte-identical.
  let r = setConfigKey(dir, "maxConcurrentPerProvider.claude", "6");
  assert.ok(r.ok && r.value === 6 && r.oldValue === undefined, JSON.stringify(r));
  assert.deepEqual((readJson(file) as Record<string, unknown>).maxConcurrentPerProvider, { omlx: 3, claude: 6 });
  const untouched = fs.readFileSync(file, "utf8");
  r = setConfigKey(dir, "maxConcurrentPerProvider.claude", "0");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /maxConcurrentPerProvider\.claude must be an integer of at least 1/);
  assert.equal(fs.readFileSync(file, "utf8"), untouched, "a rejected dotted value changes nothing");

  // Unset removes one entry, preserving its siblings; the map drops when it empties.
  const u1 = unsetConfigKey(dir, "maxConcurrentPerProvider.claude");
  assert.ok(u1.ok && u1.oldValue === 6, JSON.stringify(u1));
  assert.deepEqual((readJson(file) as Record<string, unknown>).maxConcurrentPerProvider, { omlx: 3 });
  const u = unsetConfigKey(dir, "maxConcurrentPerProvider.omlx");
  assert.ok(u.ok);
  if (u.ok) assert.equal(u.oldValue, 3);
  const raw = readJson(file) as Record<string, unknown>;
  assert.ok(!("maxConcurrentPerProvider" in raw), "the map is dropped when it empties");
});

test("setConfigKey merges one roles.<id>.<field> entry; bad fields and role ids fail", () => {
  const dir = tmpdir();
  const base = defaultConfig();
  base.roles.qa!.model = "m-qa";
  base.roles.qa!.instructions = "test things";
  saveConfig(dir, base);
  const file = path.join(dir, "tumwater.json");

  // The field write merges: the entry's other fields survive.
  let r = setConfigKey(dir, "roles.qa.model", "m-new");
  assert.ok(r.ok && r.value === "m-new" && r.oldValue === "m-qa", JSON.stringify(r));
  const roles = (readJson(file) as { roles: Record<string, Record<string, unknown>> }).roles;
  assert.equal(roles.qa!.model, "m-new");
  assert.equal(roles.qa!.instructions, "test things", "the entry's other fields preserved");

  // The per-role instances field (parallel work instances 5a/7) writes and loads like any
  // other entry.
  r = setConfigKey(dir, "roles.feature.instances", "3");
  assert.ok(r.ok && r.value === 3, JSON.stringify(r));
  const feat = (readJson(file) as { roles: Record<string, Record<string, unknown>> }).roles.feature!;
  assert.equal(feat.instances, 3);
  assert.equal(loadConfig(dir).roles.feature!.instances, 3, "the written count survives load");

  // A field outside ROLE_ENTRY_KEYS fails with the nearest-key suggestion, file untouched.
  const before = fs.readFileSync(file, "utf8");
  r = setConfigKey(dir, "roles.qa.colour", "x");
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.error, /unknown role field "colour" for roles\.qa/);
    assert.match(r.error, /did you mean `model`|did you mean `provider`|valid fields:/);
  }

  // A typo'd role id is left for validateConfig's known-roles message.
  r = setConfigKey(dir, "roles.qqq.model", "x");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /roles\.qqq|unknown role/i);
  assert.equal(fs.readFileSync(file, "utf8"), before, "both failures left the file byte-identical");

  // A type-invalid field value fails with validateConfig's own message.
  r = setConfigKey(dir, "roles.qa.minRunIntervalSeconds", '"fast"');
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /minRunIntervalSeconds must be a number of 0 or more/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

// A whole-config write must not re-expand the file's own `roles` section to the catalog:
// `roles` merges per-entry at load, so a partial section is the operator's bytes, not a
// disable verb. Regression: `config set roles '{"feature":{}}'` followed by any other
// `config set` silently rewrote tumwater.json's roles to every built-in (BUGS.md 2026-10-11).
test("a whole-config write preserves the file's own roles section", () => {
  const dir = tmpdir();
  const file = path.join(dir, "tumwater.json");
  // The operator narrowed the section: only feature, with just the one field.
  fs.writeFileSync(file, JSON.stringify({ roles: { feature: { enabled: true }, qa: { enabled: false } } }));

  // An unrelated top-level set leaves the section byte-for-byte as written.
  assert.ok(setConfigKey(dir, "maxConcurrent", "4").ok);
  let raw = readJson(file) as Record<string, unknown>;
  assert.deepEqual(
    raw.roles,
    { feature: { enabled: true }, qa: { enabled: false } },
    "the file's roles section survives an unrelated set",
  );
  assert.equal(raw.maxConcurrent, 4);
  // Omission still does not disable qa: the catalog merges per entry at load (the documented
  // behavior the confirmation and README now name), so the file edit is not a disable verb.
  assert.equal(loadConfig(dir).roles.qa?.enabled, false, "the file's explicit disable applies");
  assert.equal(loadConfig(dir).roles.bugfix?.enabled, true, "a role absent from the file keeps its default");

  // `config set roles` replaces the file's section, and the next unrelated set keeps that
  // replacement instead of re-expanding it.
  assert.ok(setConfigKey(dir, "roles", '{"feature":{"enabled":true}}').ok);
  assert.ok(setConfigKey(dir, "maxConcurrent", "5").ok);
  raw = readJson(file) as Record<string, unknown>;
  assert.deepEqual(raw.roles, { feature: { enabled: true } }, "the replaced section is durable");
  assert.equal(raw.maxConcurrent, 5);

  // An unrelated unset is a whole-config write too.
  assert.ok(unsetConfigKey(dir, "maxConcurrent").ok);
  raw = readJson(file) as Record<string, unknown>;
  assert.deepEqual(raw.roles, { feature: { enabled: true } }, "an unrelated unset leaves roles written");

  // The budget setter behind both dashboards is the same whole-config write.
  assert.ok(setDailyBudgetUsd(dir, 12).ok);
  raw = readJson(file) as Record<string, unknown>;
  assert.deepEqual(raw.roles, { feature: { enabled: true } }, "the budget set leaves roles written");
});

test("a whole-config write does not add a roles section the file never had", () => {
  const dir = tmpdir();
  const file = path.join(dir, "tumwater.json");
  fs.writeFileSync(file, JSON.stringify({ maxConcurrent: 3 }));
  assert.ok(setConfigKey(dir, "maxConcurrent", "4").ok);
  const raw = readJson(file) as Record<string, unknown>;
  assert.ok(!("roles" in raw), "an unrelated set does not write the catalog into the file");
  assert.equal(loadConfig(dir).roles.feature?.enabled, true, "the loaded config still merges the catalog");
});

// The same guarantee must hold for the DOTTED write branches (map, tier, agent, role): they
// build their candidate on the merged config too, so before the fix each re-expanded the
// file's partial roles section to the whole catalog.
test("dotted writes preserve the file's own roles section", () => {
  const dir = tmpdir();
  const file = path.join(dir, "tumwater.json");
  const narrowed = { feature: { enabled: true }, qa: { enabled: false } };
  fs.writeFileSync(file, JSON.stringify({ roles: narrowed }));

  // A dotted per-role map entry, a model tier, and an agent field each leave roles written.
  for (const [key, value] of [
    ["maxDailyCostUsdPerRole.clean", "1.5"],
    ["model.small", "m-small"],
    ["backends.pi.bin", "/bin/pi"],
  ] as const) {
    const r = setConfigKey(dir, key, value);
    assert.ok(r.ok, `${key}: ${JSON.stringify(r)}`);
    assert.deepEqual(
      (readJson(file) as Record<string, unknown>).roles,
      { feature: { enabled: true }, qa: { enabled: false } },
      `${key} leaves the file's roles section as written`,
    );
  }

  // A dotted roles field merges into the FILE's own section: qa gains the field, feature stays,
  // and no built-in role the file never held is added.
  assert.ok(setConfigKey(dir, "roles.qa.model", "m-qa").ok);
  const merged = { feature: { enabled: true }, qa: { enabled: false, model: "m-qa" } };
  assert.deepEqual(
    (readJson(file) as Record<string, unknown>).roles,
    merged,
    "a roles field merges into the file's own entries",
  );

  // A dotted unset preserves the same section.
  assert.ok(unsetConfigKey(dir, "maxDailyCostUsdPerRole.clean").ok);
  assert.deepEqual(
    (readJson(file) as Record<string, unknown>).roles,
    merged,
    "a dotted unset leaves roles written",
  );
});

test("parseConfigKey rejects dotted shapes outside the per-role maps and roles entries", () => {
  // A bare key stays top-level; the dotted forms parse; anything else is an error naming
  // the supported dotted shapes.
  assert.deepEqual(parseConfigKey("model"), { kind: "top", key: "model" });
  assert.deepEqual(parseConfigKey("maxDailyCostUsdPerRole.feature"), {
    kind: "map",
    map: "maxDailyCostUsdPerRole",
    role: "feature",
  });
  assert.deepEqual(parseConfigKey("quietHoursPerRole.qa"), { kind: "map", map: "quietHoursPerRole", role: "qa" });
  assert.deepEqual(parseConfigKey("roles.qa.model"), { kind: "role", id: "qa", field: "model" });
  for (const key of ["review.enabled", "roles.qa", "roles.", "maxDailyCostUsdPerRole.", "roles.qa.model.x"]) {
    const parsed = parseConfigKey(key);
    assert.equal(parsed.kind, "error", key);
    if (parsed.kind === "error") assert.match(parsed.error, /dotted keys/);
  }
  // A typo'd head gets the shared did-you-mean; a valid head with a wrong shape does not
  // (the typo there is the shape, so suggesting the head back would mislead).
  const mapTypo = parseConfigKey("maxDailyCostUsdPerRoll.feature");
  assert.equal(mapTypo.kind, "error");
  if (mapTypo.kind === "error") assert.match(mapTypo.error, /— did you mean `maxDailyCostUsdPerRole`\?/);
  const headTypo = parseConfigKey("modle.small");
  assert.equal(headTypo.kind, "error");
  if (headTypo.kind === "error") assert.match(headTypo.error, /— did you mean `model`\?/);
  const wrongShape = parseConfigKey("roles.qa");
  assert.equal(wrongShape.kind, "error");
  if (wrongShape.kind === "error") assert.doesNotMatch(wrongShape.error, /did you mean/);
});

// Model tiers part 8/8 — `model.<tier>` merges one entry of the tier map, the way
// `roles.<id>.<field>` merges one role entry. A string `model` is shorthand for
// `{ default: <string> }`, so the first dotted set promotes it without losing the string.
test("setConfigKey merges model.<tier> into the model map, promoting a string model", () => {
  const dir = tmpdir();
  const base = defaultConfig();
  base.model = "old-model";
  saveConfig(dir, base);

  let r = setConfigKey(dir, "model.strong", "strong-model");
  assert.ok(r.ok);
  let raw = readJson(path.join(dir, "tumwater.json")) as { model: Record<string, string> };
  assert.deepEqual(raw.model, { default: "old-model", strong: "strong-model" });

  // A second tier merges without re-typing the entries already present.
  r = setConfigKey(dir, "model.small", "small-model");
  assert.ok(r.ok);
  raw = readJson(path.join(dir, "tumwater.json")) as { model: Record<string, string> };
  assert.deepEqual(raw.model, { default: "old-model", strong: "strong-model", small: "small-model" });

  // Re-setting one tier replaces only that entry.
  r = setConfigKey(dir, "model.strong", "strong-2");
  assert.ok(r.ok);
  raw = readJson(path.join(dir, "tumwater.json")) as { model: Record<string, string> };
  assert.deepEqual(raw.model, { default: "old-model", strong: "strong-2", small: "small-model" });
});

test("setConfigKey rejects an unknown tier and a non-string tier model, leaving the file untouched", () => {
  const dir = tmpdir();
  saveConfig(dir, defaultConfig());
  const file = path.join(dir, "tumwater.json");
  const before = fs.readFileSync(file, "utf8");

  const unknown = setConfigKey(dir, "model.turbo", "x");
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.match(unknown.error, /unknown model tier "turbo"/);

  const notString = setConfigKey(dir, "model.strong", '""');
  assert.equal(notString.ok, false);
  if (!notString.ok) assert.match(notString.error, /model\.strong must be a model selector string/);

  assert.equal(fs.readFileSync(file, "utf8"), before, "rejected tier sets change nothing");
});

test("setConfigKey merges backends.<id>.bin/.args, dropping the legacy alias for pi", () => {
  const dir = tmpdir();
  saveConfig(dir, defaultConfig());
  const file = path.join(dir, "tumwater.json");

  // args writes the array and bin the string, each merging one field of one backend and
  // preserving the others — the same one-entry-merge contract as the per-role maps.
  let r = setConfigKey(dir, "backends.claude.args", '["--debug"]');
  assert.ok(r.ok && Array.isArray(r.value) && r.oldValue === undefined, JSON.stringify(r));
  r = setConfigKey(dir, "backends.claude.bin", "/opt/claude");
  assert.ok(r.ok && r.value === "/opt/claude" && r.oldValue === undefined, JSON.stringify(r));
  assert.ok(setConfigKey(dir, "backends.pi.bin", "/opt/pi").ok);
  assert.deepEqual((readJson(file) as { backends: unknown }).backends, {
    claude: { args: ["--debug"], bin: "/opt/claude" },
    pi: { bin: "/opt/pi" },
  });

  // Re-setting one field reports the previous value and leaves the sibling alone.
  r = setConfigKey(dir, "backends.claude.args", '["--debug"]');
  assert.ok(r.ok && r.oldValue !== undefined, JSON.stringify(r));
  assert.deepEqual((readJson(file) as { backends: Record<string, Record<string, unknown>> }).backends.claude, {
    args: ["--debug"],
    bin: "/opt/claude",
  });

  // A type-invalid value fails validation and leaves the file untouched.
  const before = fs.readFileSync(file, "utf8");
  const bad = setConfigKey(dir, "backends.claude.bin", "42");
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.error, /backends\.claude\.bin must be a string/);
  assert.equal(fs.readFileSync(file, "utf8"), before, "a rejected agent set changes nothing");

  // Legacy alias: a new-form pi set drops piArgs so the file never holds both spellings.
  const legacy = tmpdir();
  const withLegacy = defaultConfig();
  withLegacy.piArgs = ["--old"];
  saveConfig(legacy, withLegacy);
  const legacyFile = path.join(legacy, "tumwater.json");
  assert.ok(setConfigKey(legacy, "backends.pi.args", '["--new"]').ok);
  const rawLegacy = readJson(legacyFile) as Record<string, unknown>;
  assert.ok(!("piArgs" in rawLegacy), "the legacy piArgs key is gone");
  assert.deepEqual((rawLegacy.backends as Record<string, Record<string, unknown>>).pi, { args: ["--new"] });
  assert.doesNotThrow(() => loadConfig(legacy), "the written file passes the alias rule");
});

// The other direction of the one-spelling rule: setting a LEGACY top-level key drops the
// new-form backends.pi field it would collide with in the file, rather than relying on
// collapseAgentAliases (which drops the legacy side, so the value just set would vanish).
test("setConfigKey's legacy top-level pi keys replace the new-form field they collide with", () => {
  const dir = tmpdir();
  const base = defaultConfig();
  base.backends = { pi: { bin: "/opt/pi", args: ["--new"] } };
  saveConfig(dir, base);
  const file = path.join(dir, "tumwater.json");

  // piArgs set drops backends.pi.args but keeps the entry's surviving bin field.
  let r = setConfigKey(dir, "piArgs", '["--legacy"]');
  assert.ok(r.ok && Array.isArray(r.value), JSON.stringify(r));
  assert.deepEqual(r.oldValue, [], "the merged default piArgs is the reported previous value");
  let raw = readJson(file) as Record<string, unknown>;
  assert.deepEqual(raw.piArgs, ["--legacy"]);
  assert.deepEqual((raw.backends as Record<string, Record<string, unknown>>).pi, { bin: "/opt/pi" });
  assert.doesNotThrow(() => loadConfig(dir), "piArgs beside backends.pi.bin passes the alias rule");

  // agentBin set drops the entry's last remaining field, so the emptied pi entry is removed.
  r = setConfigKey(dir, "agentBin", "/legacy/pi");
  assert.ok(r.ok && r.oldValue === undefined, JSON.stringify(r));
  raw = readJson(file) as Record<string, unknown>;
  assert.equal(raw.agentBin, "/legacy/pi");
  assert.ok(!("pi" in ((raw.backends as Record<string, unknown>) ?? {})), "the emptied backends.pi entry is gone");
  assert.doesNotThrow(() => loadConfig(dir), "the legacy-only spelling reloads");
});

test("whole-config writes keep one pi spelling: backends.pi.args survives an unrelated set", () => {
  const dir = tmpdir();
  const withNew = defaultConfig();
  withNew.backends = { pi: { args: ["--new"] } };
  // saveConfig itself collapses the default piArgs the merged config always carries.
  saveConfig(dir, withNew);
  const file = path.join(dir, "tumwater.json");
  assert.ok(!("piArgs" in (readJson(file) as Record<string, unknown>)), "saveConfig drops the default piArgs");
  assert.doesNotThrow(() => loadConfig(dir), "the saved file reloads");

  // Any later whole-config write (an unrelated top-level key) re-derives the merged config
  // and must not reintroduce the default piArgs beside backends.pi.args.
  assert.ok(setConfigKey(dir, "maxConcurrent", "4").ok);
  const raw = readJson(file) as Record<string, unknown>;
  assert.ok(!("piArgs" in raw), "the unrelated set did not reintroduce piArgs");
  assert.deepEqual((raw.backends as Record<string, Record<string, unknown>>).pi, { args: ["--new"] });
  assert.doesNotThrow(() => loadConfig(dir), "the config still reloads");
});

test("setConfigKey whole-section backends drops the legacy aliases (the GUI Save path)", () => {
  const dir = tmpdir();
  const legacy = defaultConfig();
  legacy.piArgs = ["--old"];
  saveConfig(dir, legacy);
  const file = path.join(dir, "tumwater.json");
  const r = setConfigKey(dir, "backends", '{"pi":{"bin":"/opt/pi","args":["--new"]}}');
  assert.ok(r.ok, JSON.stringify(r));
  const raw = readJson(file) as Record<string, unknown>;
  assert.ok(!("piArgs" in raw), "the legacy piArgs alias is gone");
  assert.ok(!("agentBin" in raw), "no agentBin alias was written");
  assert.deepEqual((raw.backends as Record<string, Record<string, unknown>>).pi, { bin: "/opt/pi", args: ["--new"] });
  assert.doesNotThrow(() => loadConfig(dir), "the written file passes the alias rule");
});

// The new-form writers emit `model` and `fallback`; the legacy keys stay accepted to FIX an
// existing value but are never introduced into a config that lacks them.
test("setConfigKey never adds legacy provider or fallbackModel to a config that lacks them", () => {
  const dir = tmpdir();
  saveConfig(dir, defaultConfig());
  const file = path.join(dir, "tumwater.json");
  const before = fs.readFileSync(file, "utf8");

  for (const key of ["provider", "fallbackModel"]) {
    const r = setConfigKey(dir, key, "x");
    assert.equal(r.ok, false, key);
    if (!r.ok) assert.match(r.error, /writer never adds legacy/);
  }
  assert.equal(fs.readFileSync(file, "utf8"), before, "a refused legacy add changes nothing");
});

// A broken on-disk config takes the legacy-key closure's load catch: it cannot decide the key
// is "absent", so the refusal comes from writeConfigMutation's own load error rather than the
// misleading "writer never adds legacy" message.
test("setConfigKey reports the load error, not a legacy-add refusal, on a broken config", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "tumwater.json"), "{ still editing");
  for (const key of ["provider", "fallbackModel"]) {
    const r = setConfigKey(dir, key, "x");
    assert.equal(r.ok, false, key);
    if (!r.ok) {
      assert.match(r.error, /not valid JSON/, key);
      assert.doesNotMatch(r.error, /writer never adds legacy/, key);
    }
  }
});

test("setConfigKey updates legacy provider on a config that already has it", () => {
  const dir = tmpdir();
  const base = defaultConfig();
  base.provider = "old-provider";
  saveConfig(dir, base);

  const r = setConfigKey(dir, "provider", "new-provider");
  assert.ok(r.ok);
  const raw = readJson(path.join(dir, "tumwater.json")) as { provider: string };
  assert.equal(raw.provider, "new-provider");
});

// parseConfigKey's new `model.<tier>` shape (the get/set key), separate from the write path.
test("parseConfigKey names model.<tier> and rejects a bogus tier", () => {
  assert.deepEqual(parseConfigKey("model.strong"), { kind: "tier", map: "model", tier: "strong" });
  assert.deepEqual(parseConfigKey("model.default"), { kind: "tier", map: "model", tier: "default" });
  const bad = parseConfigKey("model.turbo");
  assert.equal(bad.kind, "error");
  if (bad.kind === "error") {
    assert.match(bad.error, /unknown model tier "turbo"/);
    assert.doesNotMatch(bad.error, /did you mean/); // no near miss in the tier list
  }
  // A near miss gets the shared did-you-mean hint every sibling unknown-X site appends.
  const typo = parseConfigKey("model.stong");
  assert.equal(typo.kind, "error");
  if (typo.kind === "error") assert.match(typo.error, /did you mean `strong`/);
  // backends.<id>.<field> names one backend field; a typo'd field names the valid ones.
  assert.deepEqual(parseConfigKey("backends.claude.bin"), { kind: "agent", id: "claude", field: "bin" });
  assert.deepEqual(parseConfigKey("backends.pi.args"), { kind: "agent", id: "pi", field: "args" });
  const badField = parseConfigKey("backends.claude.binary");
  assert.equal(badField.kind, "error");
  if (badField.kind === "error")
    assert.match(badField.error, /unknown backend field "binary" for backends\.claude \(valid fields: bin, args\)/);
});

// The cross-process read-modify-write race (BUGS.md 2026-10-07): `tumwater config set` (CLI),
// a standalone dashboard server, and the running fleet are separate processes. Without a lock,
// two writers each load the same snapshot and the later whole-file write drops the earlier one.
// The child holds the config lock while it snapshots, waits to see whether the parent's write
// lands (an unlocked writer's does; a locked one's waits), then writes its own key from the
// snapshot. The fix serializes the parent's read→write, so both keys survive.
test("a concurrent config write cannot drop another process's update", async () => {
  const dir = tmpdir();
  saveConfig(dir, defaultConfig());
  const stateDir = path.join(dir, ".tumwater", "state");
  const lock = path.join(stateDir, "config.lock");
  const ready = path.join(dir, "child-ready");
  const configFile = path.join(dir, "tumwater.json");
  const lockModule = fileURLToPath(new URL("../src/concurrency/lock.js", import.meta.url));
  const holder = spawnReadyChild(
    `const fs = require("node:fs");
     fs.mkdirSync(${JSON.stringify(stateDir)}, { recursive: true });
     import(${JSON.stringify(lockModule)}).then(({ withSyncLock }) => withSyncLock(${JSON.stringify(lock)}, () => {
       const snapshot = JSON.parse(fs.readFileSync(${JSON.stringify(configFile)}, "utf8"));
       fs.writeFileSync(${JSON.stringify(ready)}, "1");
       const parentSet = () => { try { return JSON.parse(fs.readFileSync(${JSON.stringify(configFile)}, "utf8")).maxDailyCostUsd === 42; } catch { return false; } };
       const deadline = Date.now() + 1500;
       while (Date.now() < deadline && !parentSet()) {
         Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
       }
       snapshot.quietHours = "22:00-06:00";
       fs.writeFileSync(${JSON.stringify(configFile)}, JSON.stringify(snapshot, null, 2) + "\\n");
     }));`,
    () => fs.existsSync(ready),
    "the holder child never took the config lock",
  );
  try {
    await holder.ready;
    const result = setConfigKey(dir, "maxDailyCostUsd", "42");
    assert.ok(result.ok, result.ok ? "" : result.error);
    await holder.exited;
    const cfg = readJson(configFile) as { maxDailyCostUsd?: number; quietHours?: string };
    assert.equal(cfg.maxDailyCostUsd, 42, "the parent's update survives");
    assert.equal(cfg.quietHours, "22:00-06:00", "the child's update survives");
  } finally {
    await stopChild(holder);
  }
});

test("setConfigKey writes maintenancePerWorkMerge and rejects a negative value untouched", () => {
  const dir = tmpdir();
  saveConfig(dir, defaultConfig());
  assert.deepEqual(setConfigKey(dir, "maintenancePerWorkMerge", "3"), {
    ok: true,
    value: 3,
    oldValue: 2,
  });
  assert.equal(loadConfig(dir).maintenancePerWorkMerge, 3);
  const rejected = setConfigKey(dir, "maintenancePerWorkMerge", "-1");
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.match(rejected.error, /maintenancePerWorkMerge must be a number of 0 or more/);
  assert.equal(loadConfig(dir).maintenancePerWorkMerge, 3, "the failed write left the file untouched");
});

