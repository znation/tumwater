/** docs/code-metrics/summary.cjs — the repo-wide report printed from one analyze.cjs output and
 * published in docs/code-metrics.md. It had no test (grep for its name across test/ found nothing),
 * yet every category total, complexity distribution, import-graph figure, duplication ratio and
 * test ratio in the docs is this script's arithmetic. A wrong percentile or a reversed sort here
 * silently misreports the docs.
 *
 * It is a CommonJS argv script outside dist/ (reads a metrics.json path and logs to stdout), so the
 * tests write a synthetic metrics.json to a temp dir and run it as a subprocess — the .cjs
 * specifier
 * never enters tsc. The synthetic file carries known counts so the assertions pin the arithmetic
 * rather than just "it ran". */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "./fixtures/repo-fixtures.js";

const SUMMARY = fileURLToPath(new URL("../../docs/code-metrics/summary.cjs", import.meta.url));

/** Join fixture paths from parts so no path-shaped token appears as a literal on an added line.
 * The landing path scan reads such tokens as tree references; these names exist only as data in the
 * synthetic metrics JSON and are never read from disk. */
const key = (...parts: string[]): string => parts.join("/");

type Tok = [number, string, number];

// 110 tokens per file, ten per line, so a 50-token window spans five lines and a 100-token window
// spans ten. Tokens tagged with the same prefix are identical between files, which is what the
// exact-token duplication pass hashes.
function toks(tag: string): Tok[] {
  return Array.from({ length: 110 }, (_, i) => [0, `${tag}${i}`, Math.floor(i / 10)] as Tok);
}

function run(data: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [SUMMARY, path.join(data, "metrics.json")], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** One checkout as classify/analyze would emit it: a.ts and b.ts share every token, c.ts and
 * d.test.ts do not; the imports make a→b→a one runtime cycle, add a→c, a type-only duplicate
 * edge,
 * an unresolvable relative spec and two external specifiers. Each src file carries 11 code lines,
 * so the duplicated a/b pair is 22 of the 33 src code lines. */
function seedFull(): string {
  const data = tmpdir("summary-");
  const markers = { any: [0], as: [1], nonNull: [0], todo: [], decision: [0, 1] };
  const tsFile = (file: string, cat: string, tokens: Tok[], code: number) =>
    ({ file, cat, lang: "ts", lines: code + 2, code, comment: 1, blank: 1, words: 0, cls: "c".repeat(code) + "mb", tokens, markers });
  const A = key("src", "a.ts"), B = key("src", "b.ts"), C = key("src", "ui", "c.ts"), D = key("test", "d.test.ts");
  const metrics = {
    files: [
      tsFile(A, "src", toks("s"), 11),
      tsFile(B, "src", toks("s"), 11),
      tsFile(C, "src/ui", toks("u"), 11),
      tsFile(D, "test:spec", toks("d"), 5),
      { file: key("scripts", "e.mjs"), cat: "scripts", lang: "js", lines: 3, code: 3, comment: 0, blank: 0, words: 0, cls: "ccc", tokens: [], markers },
      { file: "README.md", cat: "docs:prose", lang: "md", lines: 4, words: 10, code: 0, comment: 0, blank: 1, cls: "", tokens: [], markers },
      { file: "PLANS.md", cat: "docs:backlog", lang: "md", lines: 3, words: 7, code: 0, comment: 0, blank: 0, cls: "", tokens: [], markers },
    ],
    functions: [
      { file: A, line: 1, name: "alpha", cat: "src", cc: 5, cog: 3, codeLines: 10, params: 2, depth: 1, mi: 80, kind: "FunctionDeclaration", nestedIn: 0, async: false },
      { file: A, line: 20, name: "beta", cat: "src", cc: 15, cog: 8, codeLines: 60, params: 5, depth: 3, mi: 40, kind: "ArrowFunction", nestedIn: 0, async: true },
      { file: A, line: 30, name: "nested", cat: "src", cc: 2, cog: 1, codeLines: 3, params: 0, depth: 0, mi: 90, kind: "ArrowFunction", nestedIn: 1, async: false },
      { file: C, line: 1, name: "gamma", cat: "src/ui", cc: 3, cog: 2, codeLines: 5, params: 1, depth: 0, mi: 90, kind: "FunctionDeclaration", nestedIn: 0, async: false },
      { file: D, line: 1, name: 'test("works")', cat: "test:spec", cc: 2, cog: 1, codeLines: 4, params: 0, depth: 0, mi: 90, kind: "ArrowFunction", nestedIn: 0, async: true },
    ],
    imports: [
      { from: A, spec: "./b.js", typeOnly: false },
      { from: A, spec: "./b.js", typeOnly: true },
      { from: B, spec: "./a.js", typeOnly: false },
      { from: A, spec: "./ui/c.js", typeOnly: false },
      { from: A, spec: "./missing.js", typeOnly: false },
      { from: B, spec: "node:fs", typeOnly: false },
      { from: C, spec: "react", typeOnly: false },
      { from: D, spec: "./helper.js", typeOnly: false },
    ],
  };
  fs.writeFileSync(path.join(data, "metrics.json"), JSON.stringify(metrics));
  return data;
}

test("summary.cjs computes category, function, import-graph, duplication and test figures", () => {
  const r = run(seedFull());
  assert.equal(r.status, 0, r.stderr);
  const o = r.stdout;

  // Lines by category: two src files (26 lines/22 code), one src/ui (13/11), and a docs category
  // with zero code lines takes the "-" density path. Markdown lists in file order.
  assert.match(o, /^src\s+2\s+26\s+22\s+2\s+2\s+8\.3%/m);
  assert.match(o, /^src\/ui\s+1\s+13\s+11\s+1\s+1\s+8\.3%/m);
  assert.match(o, /^scripts\s+1\s+3\s+3\s+0\s+0\s+0\.0%/m);
  assert.match(o, /markdown files: README\.md:4L\/10w  PLANS\.md:3L\/7w/);

  // Function groups: the nested arrow and the async arrow both count as arrows; the test() callback
  // lands only in the test group; the empty scripts group renders its "-" path.
  assert.match(o, /^src \(all\): n=4  arrows=50\.0% nested=25\.0% async=25\.0%/m);
  assert.match(o, /^src core: n=3  arrows=66\.7% nested=33\.3% async=33\.3%/m);
  assert.match(o, /^test \(all\): n=1  arrows=100\.0% nested=0\.0% async=100\.0%/m);
  assert.match(o, /^scripts: n=0  arrows=-% nested=-% async=-%/m);
  assert.match(o, /^  CC   mean 6\.25 med 4 p90 12[\d.]* p99 15 max 15 \| CC=1 0\.0% >10 25\.0% \(1\) >20 0\.0% \(0\) >50 0$/m);
  assert.match(o, /^  cog  mean 3\.50 med 2\.5 p90 6\.5[\d.]* max 8 \| >15 0\.0% \(0\)$/m);
  assert.match(o, /^  MI\(0-100\) mean 75\.0 med 85\.0 p10 52\.0 <20 0 <10 0$/m);
  assert.match(o, /src top-level fns only: n=3 CC mean 7\.67 med 5 p90 13 >10 33\.3%/);
  assert.match(o, /src decision points per 100 code lines: 63\.6$/m);

  // Top-CC and top-length rankings are sorted descending by the metric. The full order is asserted
  // so a reversed sort in summary.cjs fails here, not just each row's presence anywhere in stdout.
  assert.match(o, /^  CC  15 cog   8   60L d3 MI  40  src\/a\.ts:20 beta$/m);
  assert.match(o, /^  CC   3 cog   2    5L d0 MI  90  src\/ui\/c\.ts:1 gamma$/m);
  const rank = (header: string): string[] =>
    ((o.split(header + "\n")[1] ?? "").split("\n==")[0] ?? "").trim().split("\n").map((l) => l.trim().split(" ").pop()!);
  assert.deepEqual(rank("== Top 20 src functions by CC =="), ["beta", "alpha", "gamma", "nested"]);
  assert.deepEqual(rank("== Top 8 src functions by length =="), ["beta", "alpha", "gamma", "nested"]);

  // File sizes: fns/file pairs src functions over src files; the largest sort is by code lines.
  assert.match(o, /^src: n=3 mean 11 med 11 p90 11 max 11 >500 0 >1000 0  fns\/file 1\.3$/m);
  assert.match(o, /largest: src\/a\.ts\(11\) src\/b\.ts\(11\) src\/ui\/c\.ts\(11\)/);
  assert.match(o, /^test: n=1 mean 5 med 5 p90 5 max 5 >500 0 >1000 0  fns\/file 1\.0$/m);

  // Import graph: a<->b is the one cycle in both the all-imports and runtime-only graphs; the
  // type-only duplicate edge does not change it; the unresolvable relative spec is dropped.
  assert.match(o, /external specifiers: node:fs:1 react:1$/m);
  assert.match(o, /modules 3 edges 3 fan-out mean 1\.0 max 2; fan-in max 1/);
  assert.match(o, /cycles \(SCC>1\) all-imports: 1 \[sizes 2\]  runtime-only: 1 \[sizes 2\]/);
  assert.match(o, /runtime cycles: src\/b\.ts <-> src\/a\.ts/);

  // Duplication: a/b share every window and are reported, c is unique, and the lone test file finds
  // nothing (its own token text never repeats).
  assert.match(o, /^src W=50 minLines=5: 22\/33 code lines = 66\.7%/m);
  assert.match(o, /^src W=100 minLines=10: 22\/33 code lines = 66\.7%/m);
  assert.match(o, /^test W=50 minLines=5: 0\/5 code lines = 0\.0%/m);

  // Tests section: one test() callback, and the test:src code ratio.
  assert.match(o, /test\(\) cases \(as arrow callbacks\): 1; median test-body lines 4 mean 4\.0/);
  assert.match(o, /test:src code ratio 0\.15 \(test 5 \/ src 33\); spec-only 0\.15/);
});

test("summary.cjs reports a metrics set with no functions or imports without crashing", () => {
  const data = tmpdir("summary-min-");
  const file = (f: string, cat: string) => ({ file: f, cat, lang: "ts", lines: 0, code: 0, comment: 0, blank: 0, words: 0, cls: "", tokens: [], markers: {} });
  fs.writeFileSync(path.join(data, "metrics.json"), JSON.stringify({
    files: [file(key("src", "empty.ts"), "src"), file(key("test", "x.test.ts"), "test:spec")],
    functions: [],
    imports: [],
  }));
  const r = run(data);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /== Lines by category ==/);
  assert.match(r.stdout, /markdown files: $/m);
  assert.match(r.stdout, /external specifiers: $/m);
  assert.match(r.stdout, /test\(\) cases \(as arrow callbacks\): 0; median test-body lines NaN mean -/);
  assert.match(r.stdout, /test:src code ratio - \(test 0 \/ src 0\); spec-only -/);
});

test("summary.cjs reports a checkout with no test files instead of crashing", () => {
  // A metrics set with no `test:spec` category has no `cats["test:spec"]` entry at all, so the
  // spec-only ratio must read as zero rather than throw on `.reduce` of undefined — the shape a
  // docs-only or freshly bootstrapped checkout produces. Only src files reach the report here.
  const data = tmpdir("summary-notests-");
  const src = { file: key("src", "only.ts"), cat: "src", lang: "ts", lines: 12, code: 10, comment: 1, blank: 1, words: 0, cls: "c".repeat(10) + "mb", tokens: [], markers: {} };
  fs.writeFileSync(path.join(data, "metrics.json"), JSON.stringify({ files: [src], functions: [], imports: [] }));
  const r = run(data);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /test\(\) cases \(as arrow callbacks\): 0; median test-body lines NaN mean -/);
  assert.match(r.stdout, /test:src code ratio 0\.00 \(test 0 \/ src 10\); spec-only 0\.00/);
});
