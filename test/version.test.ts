import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { belowNodeFloor, nodeFloorProblem, packageEnginesNode, packageVersion } from "../src/version.js";
import { writeMalformedJson } from "./repo-fixtures.js";

// The harness's own version (src/version.ts): `tumwater version` reads package.json beside
// the compiled CLI. The happy path is pinned against the real file so the URL arithmetic
// and the field read stay honest; the failure shapes are pinned against temp files, since a
// working install never trips them and a raw stack trace was exactly what they replaced.

test("packageVersion reads the running harness's own package.json", () => {
  const file = fileURLToPath(new URL("../../package.json", import.meta.url));
  const expected = JSON.parse(fs.readFileSync(file, "utf8")) as { version: string };
  const result = packageVersion(file);
  assert.equal(result.problem, undefined);
  assert.equal(result.version, expected.version);
});

test("packageVersion reports the reason when the file cannot be read", () => {
  const result = packageVersion(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tw-ver-")), "absent.json"));
  assert.equal(result.version, undefined);
  assert.match(result.problem ?? "", /^cannot read package.json \(the running harness's install looks broken\): ENOENT/);
});

test("packageVersion reports malformed JSON instead of throwing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tw-ver-"));
  const file = path.join(dir, "package.json");
  writeMalformedJson(file);
  const result = packageVersion(file);
  assert.equal(result.version, undefined);
  assert.match(result.problem ?? "", /^cannot read package.json \(the running harness's install looks broken\): /);
});

test("packageVersion fails a missing, blank, or non-string version field", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tw-ver-"));
  for (const body of ["null", "[]", "{}", '{"version":42}', '{"version":""}']) {
    const file = path.join(dir, `${body.replace(/\W/g, "_")}.json`);
    fs.writeFileSync(file, body);
    const result = packageVersion(file);
    assert.equal(result.version, undefined, body);
    assert.equal(result.problem, "package.json carries no version field (the running harness's install looks broken)", body);
  }
});

test("packageEnginesNode reads the real package.json's engines spec", () => {
  const file = fileURLToPath(new URL("../../package.json", import.meta.url));
  const expected = (JSON.parse(fs.readFileSync(file, "utf8")) as { engines: { node: string } }).engines.node;
  assert.equal(packageEnginesNode(file), expected);
});

test("packageEnginesNode returns null on a missing, malformed, or engines-less file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tw-eng-"));
  const write = (body: string): string => {
    const file = path.join(dir, `${body.replace(/\W/g, "_")}.json`);
    fs.writeFileSync(file, body);
    return file;
  };
  assert.equal(packageEnginesNode(path.join(dir, "absent.json")), null);
  assert.equal(packageEnginesNode(writeMalformedJson(path.join(dir, "not-json.json"))), null);
  for (const body of ["null", "{}", '{"engines":{}}', '{"engines":{"node":20}}', '{"engines":{"node":""}}']) {
    assert.equal(packageEnginesNode(write(body)), null, body);
  }
});

test("belowNodeFloor compares the version against the engines spec component-wise", () => {
  assert.equal(belowNodeFloor("20.3.0", ">=20.3"), false);
  assert.equal(belowNodeFloor("20.2.9", ">=20.3"), true);
  assert.equal(belowNodeFloor("18.20.4", ">=20.3"), true);
  assert.equal(belowNodeFloor("26.10.0", ">=20.3"), false);
  // A floor without minor/patch reads as .0.0 on the floor side, and a version without
  // minor/patch reads as .0.0 on the version side — "20" against ">=20" satisfies.
  assert.equal(belowNodeFloor("20", ">=20"), false);
  assert.equal(belowNodeFloor("19.9.9", ">=20"), true);
  assert.equal(belowNodeFloor("v20.3.0", ">= v20.3"), false);
  // Unparseable input never blocks: no spec match, no refusal.
  assert.equal(belowNodeFloor("not-a-version", ">=20.3"), false);
  assert.equal(belowNodeFloor("20.3.0", "20.3"), false);
  assert.equal(belowNodeFloor("20.3.0", "<20"), false);
});

test("nodeFloorProblem words the startup refusal with floor, found version, and fix", () => {
  assert.equal(
    nodeFloorProblem("18.20.4", ">=20.3"),
    "tumwater needs Node >=20.3 (found v18.20.4) — upgrade Node, then run tumwater again",
  );
  assert.equal(nodeFloorProblem("26.10.0", ">=20.3"), undefined);
  assert.equal(nodeFloorProblem("not-a-version", ">=20.3"), undefined);
});
