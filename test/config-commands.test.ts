import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { cmdConfig, CONFIG_USAGE } from "../src/cli/config-commands.js";
import { attemptAsync } from "./helpers/exit-capture.js";
import { readJson } from "./helpers/json-read.js";
import { makeRepo, writeConfig } from "./fixtures/repo-fixtures.js";

// cmdConfig is the `tumwater config` command's CLI shell around loadConfigSafe and
// setConfigKey. cli.test.ts drives it end-to-end through the CLI child; these tests pin the
// shell's own branches in-process — the ones the child-level runs only skim (the defensive
// usage tail cli.ts's arity gate normally intercepts, the fail paths of get/set, and the
// malformed-config surface both verbs share). cmdConfig spawns nothing, so the in-process
// exit/stream capture is safe for it (exit-capture.ts's scope note).

test("bare config prints the whole resolved config as pretty JSON", async () => {
  const root = makeRepo();
  writeConfig(root, { model: "m1" });
  const out = await attemptAsync(() => cmdConfig(root, []));
  assert.ok(!out.exited, "a valid config never fails the dump");
  const parsed = JSON.parse(out.stdout) as { model?: string };
  assert.equal(parsed.model, "m1", "the dump is the resolved merged config");
  assert.match(out.stdout, /\n  "/, "sayJson's two-space pretty print, for humans");
});

test("get prints one key's resolved value as JSON", async () => {
  const root = makeRepo();
  writeConfig(root, { model: "m1", maxDailyCostUsd: 5 });
  const s = await attemptAsync(() => cmdConfig(root, ["get", "model"]));
  assert.ok(!s.exited);
  assert.equal(s.stdout, '"m1"\n', "a string value prints as its JSON form");
  const n = await attemptAsync(() => cmdConfig(root, ["get", "maxDailyCostUsd"]));
  assert.ok(!n.exited);
  assert.equal(n.stdout, "5\n", "a number value prints as its JSON form");
});

test("get of an absent optional key prints JSON null, not the word undefined", async () => {
  const root = makeRepo();
  const out = await attemptAsync(() => cmdConfig(root, ["get", "fallbackModel"]));
  assert.ok(!out.exited);
  assert.equal(out.stdout, "null\n", "JSON.stringify(undefined) would be unparseable for scripts");
});

test("get of an unknown key fails with the valid-keys message and the suggestion", async () => {
  const root = makeRepo();
  const out = await attemptAsync(() => cmdConfig(root, ["get", "modle"]));
  assert.ok(out.exited && out.code === 1);
  assert.match(out.stderr, /unknown config key "modle"/);
  assert.match(out.stderr, /did you mean `model`/);
  assert.match(out.stderr, /valid top-level keys:/);
  assert.equal(out.stdout, "", "a failed get prints no JSON");
});

test("set of a flag-looking value fails without writing", async () => {
  const root = makeRepo();
  writeConfig(root, { model: "m1" });
  // `config set model --json` — a dropped `--` in front of what was meant to be a command
  // or a flag — must not silently write the literal string "--json" as the model.
  const before = fs.readFileSync(path.join(root, "tumwater.json"), "utf8");
  const out = await attemptAsync(() => cmdConfig(root, ["set", "model", "--json"]));
  assert.ok(out.exited && out.code === 1);
  assert.match(out.stderr, /flag-looking value "--json"/);
  assert.equal(out.stdout, "", "a failed set prints no confirmation");
  assert.equal(
    fs.readFileSync(path.join(root, "tumwater.json"), "utf8"),
    before,
    "the file stays byte-identical",
  );
});

test("set writes one top-level key and confirms with the parsed value", async () => {
  const root = makeRepo();
  writeConfig(root, { model: "m1" });
  const out = await attemptAsync(() => cmdConfig(root, ["set", "model", "gpt-5"]));
  assert.ok(!out.exited);
  assert.equal(out.stdout, 'set model to "gpt-5"\n', "the confirmation names key and new value");
  const onDisk = readJson(path.join(root, "tumwater.json")) as { model?: string };
  assert.equal(onDisk.model, "gpt-5", "the write reached tumwater.json");
});

test("set of a JSON-literal value stores the parsed type", async () => {
  const root = makeRepo();
  writeConfig(root, {});
  const out = await attemptAsync(() => cmdConfig(root, ["set", "maxDailyCostUsd", "20"]));
  assert.ok(!out.exited);
  assert.equal(out.stdout, "set maxDailyCostUsd to 20\n", "JSON-parseable text keeps its type");
});

test("set of a type-invalid value fails and leaves the file byte-identical", async () => {
  const root = makeRepo();
  writeConfig(root, { model: "m1", maxDailyCostUsd: 5 });
  const before = fs.readFileSync(path.join(root, "tumwater.json"), "utf8");
  const out = await attemptAsync(() => cmdConfig(root, ["set", "maxDailyCostUsd", '"20"']));
  assert.ok(out.exited && out.code === 1);
  assert.match(out.stderr, /maxDailyCostUsd/);
  assert.equal(fs.readFileSync(path.join(root, "tumwater.json"), "utf8"), before);
});

test("set of an unknown key fails without writing", async () => {
  const root = makeRepo();
  writeConfig(root, { model: "m1" });
  const before = fs.readFileSync(path.join(root, "tumwater.json"), "utf8");
  const out = await attemptAsync(() => cmdConfig(root, ["set", "modle", "x"]));
  assert.ok(out.exited && out.code === 1);
  assert.match(out.stderr, /unknown config key "modle"/);
  assert.equal(fs.readFileSync(path.join(root, "tumwater.json"), "utf8"), before);
});

test("set of a malformed quietHours fails with the key's own validator message", async () => {
  const root = makeRepo();
  writeConfig(root, {});
  const before = fs.readFileSync(path.join(root, "tumwater.json"), "utf8");
  const out = await attemptAsync(() => cmdConfig(root, ["set", "quietHours", "not-a-window"]));
  assert.ok(out.exited && out.code === 1);
  assert.ok(out.stderr.length > 0, "the per-key validator's actionable message surfaces");
  assert.equal(fs.readFileSync(path.join(root, "tumwater.json"), "utf8"), before);
});

test("a malformed tumwater.json fails the dump with no JSON printed", async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, "tumwater.json"), "{not json");
  const out = await attemptAsync(() => cmdConfig(root, []));
  assert.ok(out.exited && out.code === 1);
  assert.ok(out.stderr.length > 0, "the load error surfaces as a fail() message");
  assert.equal(out.stdout, "");
});

test("a malformed tumwater.json fails get the same way, with no JSON printed", async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, "tumwater.json"), "{not json");
  const out = await attemptAsync(() => cmdConfig(root, ["get", "model"]));
  assert.ok(out.exited && out.code === 1);
  assert.ok(out.stderr.length > 0);
  assert.equal(out.stdout, "");
});

test("the defensive usage tail fails an unrecognized subcommand", async () => {
  const root = makeRepo();
  // cli.ts's arity gate rejects a malformed subcommand before cmdConfig runs; this branch is
  // the tail behind it (CONFIG_USAGE), pinned here so the two sites cannot drift apart.
  const out = await attemptAsync(() => cmdConfig(root, ["frobnicate"]));
  assert.ok(out.exited && out.code === 1);
  assert.match(out.stderr, new RegExp(CONFIG_USAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

// Dotted per-role keys: get indexes the resolved map/role entry (null when absent); set
// merges one entry through setConfigKey's dotted path, preserving the other roles.
test("get resolves a dotted key: map entry, role field, and absent-key null", async () => {
  const root = makeRepo();
  writeConfig(root, {
    maxDailyCostUsdPerRole: { qa: 2, feature: 1.5 },
    roles: { qa: { model: "m-qa" } },
  });
  const f = await attemptAsync(() => cmdConfig(root, ["get", "maxDailyCostUsdPerRole.feature"]));
  assert.ok(!f.exited);
  assert.equal(f.stdout, "1.5\n");
  const m = await attemptAsync(() => cmdConfig(root, ["get", "roles.qa.model"]));
  assert.ok(!m.exited);
  assert.equal(m.stdout, '"m-qa"\n');
  const miss = await attemptAsync(() => cmdConfig(root, ["get", "maxDailyCostUsdPerRole.clean"]));
  assert.ok(!miss.exited);
  assert.equal(miss.stdout, "null\n", "an unset role prints JSON null, like a bare absent key");
});

test("get of a dotted key naming an unknown role or role field fails, not null", async () => {
  const root = makeRepo();
  writeConfig(root, { maxDailyCostUsdPerRole: { qa: 2 }, roles: { qa: { model: "m-qa" } } });
  // A role the catalog does not know can never resolve: null would read as an unset entry.
  const badMapRole = await attemptAsync(() => cmdConfig(root, ["get", "maxDailyCostUsdPerRole.featur"]));
  assert.ok(badMapRole.exited && badMapRole.code === 1);
  assert.match(badMapRole.stderr, /unknown role: featur/);
  assert.match(badMapRole.stderr, /did you mean `feature`/);
  const badRoleEntry = await attemptAsync(() => cmdConfig(root, ["get", "roles.qqq.model"]));
  assert.ok(badRoleEntry.exited && badRoleEntry.code === 1);
  assert.match(badRoleEntry.stderr, /unknown role: qqq/);
  // The role field is refused with the same wording setConfigKey uses, not a silent null.
  const badField = await attemptAsync(() => cmdConfig(root, ["get", "roles.qa.colour"]));
  assert.ok(badField.exited && badField.code === 1);
  assert.match(badField.stderr, /unknown role field "colour" for roles\.qa/);
  assert.match(badField.stderr, /valid fields:/);
  assert.equal(badField.stdout, "", "a failed get prints no JSON");
});

test("get rejects a dotted key outside the supported shapes", async () => {
  const root = makeRepo();
  const out = await attemptAsync(() => cmdConfig(root, ["get", "review.enabled"]));
  assert.ok(out.exited && out.code === 1);
  assert.match(out.stderr, /dotted keys/);
});

test("set of a dotted map key merges without touching the other roles' entries", async () => {
  const root = makeRepo();
  writeConfig(root, { maxDailyCostUsdPerRole: { qa: 2 } });
  assert.ok((readJson(path.join(root, "tumwater.json")) as { maxDailyCostUsdPerRole?: Record<string, number> }).maxDailyCostUsdPerRole?.qa === 2, "fixture holds qa's entry");
  const out = await attemptAsync(() => cmdConfig(root, ["set", "maxDailyCostUsdPerRole.feature", "1.5"]));
  assert.ok(!out.exited);
  assert.equal(out.stdout, "set maxDailyCostUsdPerRole.feature to 1.5\n", "the confirmation names the dotted key");
  const raw = readJson(path.join(root, "tumwater.json")) as Record<string, unknown>;
  assert.deepEqual(raw.maxDailyCostUsdPerRole, { qa: 2, feature: 1.5 }, "merge, not replace");
});

test("set of a dotted role field merges the entry; a bad field fails naming the valid ones", async () => {
  const root = makeRepo();
  writeConfig(root, { roles: { qa: { model: "m-qa", instructions: "test things" } } });
  const out = await attemptAsync(() => cmdConfig(root, ["set", "roles.qa.model", "m-new"]));
  assert.ok(!out.exited);
  const raw = readJson(path.join(root, "tumwater.json")) as { roles: Record<string, Record<string, unknown>> };
  assert.equal(raw.roles.qa!.model, "m-new");
  assert.equal(raw.roles.qa!.instructions, "test things", "the entry's other fields preserved");

  const bad = await attemptAsync(() => cmdConfig(root, ["set", "roles.qa.colour", "x"]));
  assert.ok(bad.exited && bad.code === 1);
  assert.match(bad.stderr, /unknown role field "colour" for roles\.qa/);
  assert.match(bad.stderr, /valid fields:/);
});

// unset — the inverse of set: remove one value and confirm, or fail with the same screens
// get/set run. The verbose shell wording is pinned here so a reviewer sees the exact contract.
test("unset removes a top-level key and confirms the removed value; get then reads null", async () => {
  const root = makeRepo();
  writeConfig(root, { quietHours: "23:00-07:00" });
  const out = await attemptAsync(() => cmdConfig(root, ["unset", "quietHours"]));
  assert.ok(!out.exited);
  assert.equal(out.stdout, 'unset quietHours (was "23:00-07:00")\n');
  assert.ok(
    !("quietHours" in (readJson(path.join(root, "tumwater.json")) as Record<string, unknown>)),
    "the key is gone from the file",
  );
  const get = await attemptAsync(() => cmdConfig(root, ["get", "quietHours"]));
  assert.ok(!get.exited);
  assert.equal(get.stdout, "null\n", "the removed value now reads as JSON null");
});

test("unset removes a dotted role field, preserving the entry's other fields, and a no-op prints no value", async () => {
  const root = makeRepo();
  writeConfig(root, { roles: { qa: { model: "m-qa", instructions: "test things" } } });
  const out = await attemptAsync(() => cmdConfig(root, ["unset", "roles.qa.model"]));
  assert.ok(!out.exited);
  assert.equal(out.stdout, 'unset roles.qa.model (was "m-qa")\n');
  const raw = readJson(path.join(root, "tumwater.json")) as { roles: Record<string, Record<string, unknown>> };
  assert.equal(raw.roles.qa!.instructions, "test things", "the entry's other fields preserved");
  const afterFirstUnset = fs.readFileSync(path.join(root, "tumwater.json"), "utf8");

  const miss = await attemptAsync(() => cmdConfig(root, ["unset", "roles.qa.model"]));
  assert.ok(!miss.exited);
  assert.equal(miss.stdout, "unset roles.qa.model\n", "an absent field is a no-op that names the key only");
  assert.equal(
    fs.readFileSync(path.join(root, "tumwater.json"), "utf8"),
    afterFirstUnset,
    "the no-op left the file byte-identical rather than rewriting it",
  );
});

test("unset of a default-carrying key or a default-seeded role field the file never set is a true no-op", async () => {
  const root = makeRepo();
  // Minimal raw file: no trailing newline, no defaults expanded, so any write at all changes
  // the bytes. maxConcurrent and quietHours live only in the merged defaults; roles.qa seeds
  // minTickIntervalSeconds 7200. None is in the file, so none is anything to remove.
  writeConfig(root, { maxDailyCostUsdPerRole: { qa: 2 } });
  const file = path.join(root, "tumwater.json");
  const before = fs.readFileSync(file, "utf8");

  for (const key of ["maxConcurrent", "quietHours"]) {
    const out = await attemptAsync(() => cmdConfig(root, ["unset", key]));
    assert.ok(!out.exited, `${key}: ${out.stderr}`);
    assert.equal(out.stdout, `unset ${key}\n`, `${key}: an absent top-level key names the key only`);
    assert.equal(fs.readFileSync(file, "utf8"), before, `${key}: the no-op left the file byte-identical`);
  }

  const seeded = await attemptAsync(() => cmdConfig(root, ["unset", "roles.qa.minTickIntervalSeconds"]));
  assert.ok(!seeded.exited, seeded.stderr);
  assert.equal(
    seeded.stdout,
    "unset roles.qa.minTickIntervalSeconds\n",
    "a default the operator never wrote reports no removed value",
  );
  assert.equal(fs.readFileSync(file, "utf8"), before, "the seeded-field no-op left the file byte-identical");
});

test("unset of an unknown key, role, or role field fails with the shared wording and writes nothing", async () => {
  const root = makeRepo();
  writeConfig(root, { roles: { qa: { model: "m-qa" } } });
  const file = path.join(root, "tumwater.json");
  const before = fs.readFileSync(file, "utf8");

  const badKey = await attemptAsync(() => cmdConfig(root, ["unset", "modle"]));
  assert.ok(badKey.exited && badKey.code === 1);
  assert.match(badKey.stderr, /unknown config key "modle"/);

  const badRole = await attemptAsync(() => cmdConfig(root, ["unset", "roles.qqq.model"]));
  assert.ok(badRole.exited && badRole.code === 1);
  assert.match(badRole.stderr, /unknown role: qqq/);

  const badField = await attemptAsync(() => cmdConfig(root, ["unset", "roles.qa.colour"]));
  assert.ok(badField.exited && badField.code === 1);
  assert.match(badField.stderr, /unknown role field "colour" for roles\.qa/);

  assert.equal(fs.readFileSync(file, "utf8"), before, "all three failures left the file byte-identical");
});

test("the defensive tail fails unset with no key using CONFIG_USAGE", async () => {
  const root = makeRepo();
  const out = await attemptAsync(() => cmdConfig(root, ["unset"]));
  assert.ok(out.exited && out.code === 1);
  assert.match(out.stderr, new RegExp(CONFIG_USAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
