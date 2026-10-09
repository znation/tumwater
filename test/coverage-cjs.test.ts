/** docs/code-metrics/coverage.cjs — the source-map pass behind docs/code-metrics.md's per-TS-line
 * coverage. It had no test (grep for its name across test/ found only comments in coverage-table.ts
 * describing the ported merge semantics; nothing drove the script itself), yet run.sh feeds it every
 * raw V8 dump and its output is what the code-metrics docs report. The parts unique to this script
 * are the source-map decode (decodeMappings + the generated→TS line mapping) and the cross-process
 * "innermost range in ANY process" merge: the fixture runs two processes whose covered function
 * bodies are complementary (so the union matches neither process alone) and keeps a nested block
 * hot-outer/zero-inner in both (so an outermost-range regression would flip a zero line to one).
 *
 * It is a CommonJS script read from argv, outside dist/, so the tests build a tiny checkout/mapdist/
 * v8-dir triple in temp dirs and run it as a subprocess — the .cjs specifier never enters tsc. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "./fixtures/repo-fixtures.js";

const COVERAGE = fileURLToPath(new URL("../../docs/code-metrics/coverage.cjs", import.meta.url));

/** The script keys its result by the compiled path with the extension swapped to .ts. Built by
 * join so no literal src/<x>.ts token lands in this file: stageCheckFindings reads test fixtures
 * as tree paths and flags such a token as missing (BUGS.md, open). */
const tsKey = (...parts: string[]): string => parts.join("/");

function runCoverage(checkout: string, v8dir: string, mapdist: string, out: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [COVERAGE, checkout, v8dir, mapdist, out], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

test("coverage.cjs maps V8 ranges onto TS lines, merging any process and taking the innermost range", () => {
  const srcLines = [
    "let g = 0;",
    "function add(a, b) {",
    "  return a + b;",
    "}",
    "function sub(a, b) {",
    "  return a - b;",
    "}",
    "function nested(a) {",
    "  if (a) {",
    "    return 1;",
    "  }",
    "  return 0;",
    "}",
    "add(1, 2);",
  ];
  const src = srcLines.join("\n") + "\n";
  const checkout = tmpdir("cov-cjs-");
  fs.mkdirSync(path.join(checkout, "dist", "src"), { recursive: true });
  fs.writeFileSync(path.join(checkout, "dist", "src", "foo.js"), src);

  // tsc emits both the JS and its map; the walk enumerates dist files from MAPDIST but reads the
  // canonical JS from CHECKOUT/dist, so MAPDIST needs a placeholder foo.js plus the real map.
  const mapdist = tmpdir("cov-cjs-map-");
  fs.mkdirSync(path.join(mapdist, "src"), { recursive: true });
  fs.writeFileSync(path.join(mapdist, "src", "foo.js"), src);
  // Generated lines 0..13 map to TS lines 10..23: "AAUA" = genCol 0, src 0, origLine +10, col 0;
  // each "AACA" adds one to origLine.
  const mappings = srcLines.map((_, i) => (i === 0 ? "AAUA" : "AACA")).join(";");
  fs.writeFileSync(path.join(mapdist, "src", "foo.js.map"), JSON.stringify({ version: 3, mappings }));

  const closeAfter = (from: number): number => src.indexOf("}", from) + 1;
  const addStart = src.indexOf("function add");
  const addBrace = src.indexOf("{", addStart);
  const addEnd = closeAfter(addBrace);
  const subStart = src.indexOf("function sub");
  const subBrace = src.indexOf("{", subStart);
  const subEnd = closeAfter(subBrace);
  const nestedStart = src.indexOf("function nested");
  const ifBrace = src.indexOf("{", src.indexOf("if (a)"));
  const ifEnd = closeAfter(ifBrace);
  const nestedEnd = closeAfter(ifEnd); // skip the if block's "}" to the function's own.

  // The module root spans the whole file at count 1. add and sub have complementary bodies: add's
  // body ran only in dump a, sub's only in dump b, so the merged result matches neither process
  // alone. nested always ran (root count 1) but its if block never did (count 0 in both), so the
  // line inside the if stays zero only if the innermost range, not the outer function root, wins.
  const dump = (addBodyCount: number, subBodyCount: number): unknown => ({
    result: [
      {
        url: "file://" + fs.realpathSync(checkout) + "/dist/src/foo.js",
        functions: [
          { functionName: "", isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: src.length, count: 1 }] },
          {
            functionName: "add",
            isBlockCoverage: true,
            ranges: [
              { startOffset: addStart, endOffset: addEnd, count: 1 },
              { startOffset: addBrace, endOffset: addEnd, count: addBodyCount },
            ],
          },
          {
            functionName: "sub",
            isBlockCoverage: true,
            ranges: [
              { startOffset: subStart, endOffset: subEnd, count: subBodyCount },
              { startOffset: subBrace, endOffset: subEnd, count: subBodyCount },
            ],
          },
          {
            functionName: "nested",
            isBlockCoverage: true,
            ranges: [
              { startOffset: nestedStart, endOffset: nestedEnd, count: 1 },
              { startOffset: ifBrace, endOffset: ifEnd, count: 0 },
            ],
          },
        ],
      },
    ],
  });
  const v8dir = tmpdir("cov-cjs-dumps-");
  fs.writeFileSync(path.join(v8dir, "a.json"), JSON.stringify(dump(1, 0))); // add's body ran, sub's did not
  fs.writeFileSync(path.join(v8dir, "b.json"), JSON.stringify(dump(0, 1))); // ... and the other way round

  const out = path.join(tmpdir("cov-cjs-out-"), "coverage.json");
  const r = runCoverage(checkout, v8dir, mapdist, out);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /processes 2 src scripts seen 1/);
  assert.match(r.stdout, /mapped TS lines 12\/14 = 85\.71%; branches 6\/7 = 85\.71%; functions 3\/3 = 100\.00%/);
  assert.match(r.stdout, /never-loaded src files: none/);
  // add's body line (TS 12) is covered by dump a and sub's (TS 15) by dump b, so the union covers
  // both. The if body (TS 19) and its closing brace (TS 20) stay at zero: the innermost range is
  // the never-run block, not the covered function root around it. Branch ranges map to the
  // generated line they start on: the module root to TS 10, add's to TS 11, sub's to TS 14,
  // nested's root to TS 17 and its if block to TS 18.
  assert.deepEqual(JSON.parse(fs.readFileSync(out, "utf8")), {
    [tsKey("src", "foo.ts")]: {
      loaded: true,
      lines: [[10, 1], [11, 1], [12, 1], [13, 1], [14, 1], [15, 1], [16, 1], [17, 1], [18, 1], [19, 0], [20, 0], [21, 1], [22, 1], [23, 1]],
      branches: [[10, 1], [11, 1], [11, 1], [14, 1], [14, 1], [17, 1], [18, 0]],
      funcs: [[11, 1], [14, 1], [17, 1]],
    },
  });
});

test("coverage.cjs keeps a module no process loaded at zero", () => {
  const src = "let x = 1;\n";
  const checkout = tmpdir("cov-cjs-un-");
  fs.mkdirSync(path.join(checkout, "dist", "src"), { recursive: true });
  fs.writeFileSync(path.join(checkout, "dist", "src", "bar.js"), src);

  const mapdist = tmpdir("cov-cjs-un-map-");
  fs.mkdirSync(path.join(mapdist, "src"), { recursive: true });
  fs.writeFileSync(path.join(mapdist, "src", "bar.js"), src);
  fs.writeFileSync(path.join(mapdist, "src", "bar.js.map"), JSON.stringify({ version: 3, mappings: "AAEA" })); // → TS line 2

  const v8dir = tmpdir("cov-cjs-un-dumps-"); // empty: no process loaded bar.js
  const out = path.join(tmpdir("cov-cjs-un-out-"), "coverage.json");
  const r = runCoverage(checkout, v8dir, mapdist, out);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /processes 0 src scripts seen 0/);
  assert.match(r.stdout, /never-loaded src files: src\/bar\.ts/);
  // A source-map line still appears, at zero, so an untested module does not vanish from the docs.
  assert.deepEqual(JSON.parse(fs.readFileSync(out, "utf8")), {
    [tsKey("src", "bar.ts")]: { loaded: false, lines: [[2, 0]], branches: [], funcs: [] },
  });
});
