import test from "node:test";
import { readJson } from "./json-read.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { belowNodeFloor, nodeFloorProblem, PACKAGE_JSON, packageEnginesNode, packageVersion } from "../src/version.js";
import { tmpdir, writeMalformedJson } from "./repo-fixtures.js";

// The harness's own version (src/version.ts): `tumwater version` reads package.json beside
// the compiled CLI. The happy path is pinned against the real file so the URL arithmetic
// and the field read stay honest; the failure shapes are pinned against temp files, since a
// working install never trips them and a raw stack trace was exactly what they replaced.

test("packageVersion reads the running harness's own package.json", () => {
  const file = fileURLToPath(new URL("../../package.json", import.meta.url));
  const expected = readJson(file) as { version: string };
  const result = packageVersion(file);
  assert.equal(result.problem, undefined);
  assert.equal(result.version, expected.version);
});

test("packageVersion reports the reason when the file cannot be read", () => {
  const result = packageVersion(path.join(tmpdir("tw-ver-"), "absent.json"));
  assert.equal(result.version, undefined);
  assert.match(result.problem ?? "", /^cannot read package.json \(the running harness's install looks broken\): ENOENT/);
});

test("packageVersion reports malformed JSON instead of throwing", () => {
  const dir = tmpdir("tw-ver-");
  const file = path.join(dir, "package.json");
  writeMalformedJson(file);
  const result = packageVersion(file);
  assert.equal(result.version, undefined);
  assert.match(result.problem ?? "", /^cannot read package.json \(the running harness's install looks broken\): /);
});

test("packageVersion fails a missing, blank, or non-string version field", () => {
  const dir = tmpdir("tw-ver-");
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
  const expected = (readJson(file) as { engines: { node: string } }).engines.node;
  assert.equal(packageEnginesNode(file), expected);
});

test("packageEnginesNode returns null on a missing, malformed, or engines-less file", () => {
  const dir = tmpdir("tw-eng-");
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

// The dispatcher's own startup gate (cli.ts's main, before any command dispatch) runs in a
// process that imported cli.js, so it too is exercised through the compiled entry point: a
// --require preload lowers the child's process.versions.node below the engines floor (the
// property is getter-only, so the shim redefines it), and every command must fail with
// nodeFloorProblem's wording before doing any work — `version` here doubles as the cheapest
// command to name.
test("the compiled CLI refuses a Node below the engines floor, before any command", async () => {
  const { execFile } = await import("node:child_process");
  const distDir = fileURLToPath(new URL("../../dist", import.meta.url));
  const dir = tmpdir("tw-floor-cli-");
  const shim = path.join(dir, "floor-shim.cjs");
  await fs.promises.writeFile(
    shim,
    "Object.defineProperty(process.versions, 'node', { value: '18.20.4', configurable: true });\n",
  );
  const r = await new Promise<{ code: number; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      [path.join(distDir, "src", "cli.js"), "version"],
      { cwd: dir, timeout: 20_000, env: { ...process.env, NODE_OPTIONS: `--require ${shim}` } },
      (err, _stdout, stderr) => resolve({ code: err ? Number(err.code ?? 1) : 0, stderr }),
    );
  });
  assert.equal(r.code, 1);
  assert.equal(
    r.stderr,
    "tumwater: tumwater needs Node >=20.3 (found v18.20.4) — upgrade Node, then run tumwater again\n",
  );
});

// The dispatcher's own fail (cli.ts's version case) runs in a process that imported cli.js,
// so it can only be exercised through the compiled entry point. This runs that entry point
// IN PLACE — the worktree's own dist/src/cli.js — so the suite's coverage table attributes
// the dispatch to src/cli.ts; the copied-dist approach this replaced ran the same dispatch at
// a temp path no coverage pass maps back to src/cli.ts. A --require preload stands in for a
// broken install: it makes the version read see a package.json the harness cannot use, while
// the checkout's real file (which node's ESM resolver reads to resolve modules) stays intact.
test("the compiled CLI fails `version` with the reason on a broken install", async () => {
  const { execFile } = await import("node:child_process");
  const distDir = fileURLToPath(new URL("../../dist", import.meta.url));
  const dir = tmpdir("tw-ver-cli-");
  const shim = path.join(dir, "broken-package.cjs");
  await fs.promises.writeFile(
    shim,
    [
      "const fs = require('node:fs');",
      "const target = process.env.TUMWATER_TEST_PACKAGE_JSON;",
      "const body = process.env.TUMWATER_TEST_PACKAGE_JSON_BODY;",
      "const read = fs.readFileSync;",
      "fs.readFileSync = function (file, ...rest) {",
      "  if (typeof file === 'string' && file === target) {",
      "    if (body === 'throw') throw new Error('ENOENT: no such file or directory, open ' + file);",
      "    return body;",
      "  }",
      "  return read.call(this, file, ...rest);",
      "};",
    ].join("\n"),
  );
  // Three broken shapes the read can throw up: an unreadable file (a hand-copied dist without
  // its root), and a readable file whose version is absent or not a string. All must exit 1
  // with version.ts's wording. The bodies that have to parse stay valid JSON, so node's own
  // resolver reads them without complaint.
  const cases: Array<[string, RegExp]> = [
    ["throw", /cannot read package\.json \(the running harness's install looks broken\)/],
    ['{"name":"broken-install"}', /package\.json carries no version field \(the running harness's install looks broken\)/],
    ['{"name":"broken-install","version":42}', /package\.json carries no version field \(the running harness's install looks broken\)/],
  ];
  for (const [body, expected] of cases) {
    const r = await new Promise<{ code: number; stderr: string }>((resolve) => {
      execFile(
        process.execPath,
        [path.join(distDir, "src", "cli.js"), "version"],
        {
          cwd: dir,
          timeout: 20_000,
          env: {
            ...process.env,
            NODE_OPTIONS: `--require ${shim}`,
            TUMWATER_TEST_PACKAGE_JSON: PACKAGE_JSON,
            TUMWATER_TEST_PACKAGE_JSON_BODY: body,
          },
        },
        (err, _stdout, stderr) => resolve({ code: err ? Number(err.code ?? 1) : 0, stderr }),
      );
    });
    assert.equal(r.code, 1, `${body}: ${r.stderr}`);
    assert.match(r.stderr, expected, body);
  }
});
