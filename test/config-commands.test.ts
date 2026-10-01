import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { cmdConfig, CONFIG_USAGE } from "../src/config-commands.js";
import { attemptAsync } from "./exit-capture.js";
import { makeRepo, writeConfig } from "./repo-fixtures.js";

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

test("set writes one top-level key and confirms with the parsed value", async () => {
  const root = makeRepo();
  writeConfig(root, { model: "m1" });
  const out = await attemptAsync(() => cmdConfig(root, ["set", "model", "gpt-5"]));
  assert.ok(!out.exited);
  assert.equal(out.stdout, 'set model to "gpt-5"\n', "the confirmation names key and new value");
  const onDisk = JSON.parse(fs.readFileSync(path.join(root, "tumwater.json"), "utf8")) as {
    model?: string;
  };
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
