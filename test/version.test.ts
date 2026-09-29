import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packageVersion } from "../src/version.js";

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
  fs.writeFileSync(file, "{ not json");
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
