import test from "node:test";
import { readJson } from "./json-read.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { belowNodeFloor, nodeFloorProblem, packageEnginesNode, packageVersion } from "../src/version.js";
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
// so it can only be exercised through the compiled entry point: a copy of dist beside a
// package.json the version read cannot supply must exit 1 with version.ts's wording instead
// of a raw stack trace — the exact scenario the guard replaced.

test("the compiled CLI fails `version` with the reason on a broken install", async () => {
  const { execFile } = await import("node:child_process");
  // dist/test's parent's parent is the checkout root, whose dist/ holds the compiled tree.
  const distDir = fileURLToPath(new URL("../../dist", import.meta.url));
  // The file must stay valid JSON — node's ESM resolver reads it to resolve modules beside
  // it — so the broken shapes here are a missing and a non-string version field.
  for (const body of ["{\"name\":\"broken-install\"}", "{\"name\":\"broken-install\",\"version\":42}"]) {
    const dir = tmpdir("tw-ver-cli-");
    await fs.promises.cp(distDir, path.join(dir, "dist"), { recursive: true });
    await fs.promises.writeFile(path.join(dir, "package.json"), body);
    const r = await new Promise<{ code: number; stderr: string }>((resolve) => {
      execFile(
        process.execPath,
        [path.join(dir, "dist", "src", "cli.js"), "version"],
        { cwd: dir, timeout: 20_000 },
        (err, _stdout, stderr) => resolve({ code: err ? Number(err.code ?? 1) : 0, stderr }),
      );
    });
    assert.equal(r.code, 1, `${body}: ${r.stderr}`);
    assert.match(
      r.stderr,
      /package.json carries no version field \(the running harness's install looks broken\)/,
      body,
    );
  }
});
