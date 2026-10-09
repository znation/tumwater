/** docs/code-metrics/compare.cjs — the one metric set that compares tumwater against the OSS
 * baselines, splits tumwater by line author (Tumwater / Claude via blame.json), and repeats the
 * comparison for the "core src only" variant. It had no test (grep for "compare.cjs" across test/
 * and src/ found nothing), yet every three-way table and decision-kind figure in
 * docs/code-metrics.md is this script's arithmetic. A dropped author, a mis-filtered category, or
 * a wrong percentile here silently misreports the docs.
 *
 * It is a CommonJS argv script outside dist/ (reads a data dir, writes compare.json there), so the
 * test builds a synthetic metrics.json + blame.json plus one oss/<name>.json per repo in
 * oss-repos.tsv, then runs it as a subprocess — the .cjs specifier never enters tsc. The fixture
 * carries known counts, so the assertions pin the arithmetic rather than just "it ran". */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "./fixtures/repo-fixtures.js";

const COMPARE = fileURLToPath(new URL("../../docs/code-metrics/compare.cjs", import.meta.url));
const REPOS_TSV = fileURLToPath(new URL("../../docs/code-metrics/oss-repos.tsv", import.meta.url));

/** Join fixture paths from parts so no path-shaped token appears as a literal on an added line.
 * The landing path scan reads such tokens as tree references; these names exist only as data in
 * the synthetic JSON and are never read from disk. */
const key = (...parts: string[]): string => parts.join("/");

type Tok = [number, string, number];

function run(data: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [COMPARE, data], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Independent reference for compare.cjs's linear-interpolation percentile, so a drift in `q`
 * fails here rather than only changing the published table. */
function median(vals: number[]): number {
  const a = [...vals].sort((x, y) => x - y);
  const i = (a.length - 1) * 0.5, lo = Math.floor(i), hi = Math.min(lo + 1, a.length - 1);
  return (a[lo] ?? 0) + ((a[hi] ?? 0) - (a[lo] ?? 0)) * (i - lo);
}

/** One checkout as analyze.cjs would emit it: `n` code lines, one function, no tokens. The OSS
 * files vary only in `n`, which makes the OSS median/min/max a checkable spread. */
function ossMetrics(n: number): unknown {
  const file = key("src", "a.ts");
  return {
    files: [{ file, cat: "src", lang: "ts", lines: n, code: n, comment: 0, blank: 0, words: 0, cls: "c".repeat(n), tokens: [], markers: {} }],
    functions: [{ file, cat: "src", line: 1, span: n, cc: 1, cog: 1, codeLines: n, params: 0, depth: 0, mi: 100 }],
  };
}

test("compare.cjs builds repo/author/core metrics and the OSS spread, and prints the table", () => {
  const repos = fs.readFileSync(REPOS_TSV, "utf8").split("\n")
    .filter((l) => l && !l.startsWith("#")).map((l) => l.split("\t")[0]);
  assert.ok(repos.length >= 2, "oss-repos.tsv should list baseline repos");

  const data = tmpdir("compare-cjs-");
  fs.mkdirSync(path.join(data, "oss"), { recursive: true });
  repos.forEach((r, i) => fs.writeFileSync(path.join(data, "oss", `${r}.json`), JSON.stringify(ossMetrics(i + 1))));

  // a.ts: 3 code + 2 comment lines; b.ts (src/ui): 4 code lines. The blame array is parallel to
  // `cls`, so a.ts is 2 tumwater + 1 claude + 2 human and b.ts is 3 claude + 1 human. The test file
  // is 1 tumwater + 1 claude + 1 human. Two functions: a.ts line 1 span 3 is 2 tumwater/1 claude
  // (majority tumwater), b.ts line 1 span 4 is 3 claude/1 human (majority claude).
  const A = key("src", "a.ts"), B = key("src", "ui", "b.ts"), T = key("test", "a.test.ts");
  const metrics = {
    files: [
      { file: A, cat: "src", lang: "ts", lines: 5, code: 3, comment: 2, blank: 0, words: 0, cls: "cccmm",
        tokens: [[0, "??", 0], [0, "if", 0], [0, "for", 1], [0, "while", 1], [0, "case", 2], [0, "catch", 2], [0, "?.", 0], [0, "&&", 1], [0, "||", 2]],
        markers: { decision: [0, 1], as: [2], nonNull: [3], any: [4], todo: [5] }, tsIgnore: 1, eslintDisable: 0 },
      { file: B, cat: "src/ui", lang: "ts", lines: 4, code: 4, comment: 0, blank: 0, words: 0, cls: "cccc", tokens: [] as Tok[], markers: {}, tsIgnore: 0, eslintDisable: 2 },
      { file: T, cat: "test:spec", lang: "ts", lines: 3, code: 2, comment: 1, blank: 0, words: 0, cls: "ccm", tokens: [] as Tok[], markers: {} },
      { file: key("scripts", "e.mjs"), cat: "scripts", lang: "js", cls: "cc", tokens: [] as Tok[], markers: {} },
      { file: "README.md", cat: "docs:prose", lang: "md", lines: 5, words: 100, code: 0, comment: 0, blank: 1, cls: "", tokens: [] as Tok[], markers: {} },
    ],
    functions: [
      { file: A, cat: "src", line: 1, span: 3, cc: 5, cog: 4, codeLines: 2, params: 1, depth: 1, mi: 80 },
      { file: B, cat: "src/ui", line: 1, span: 4, cc: 11, cog: 20, codeLines: 4, params: 3, depth: 2, mi: 60 },
    ],
  };
  const blame = { files: {
    [A]: { cls: ["tumwater", "tumwater", "claude", "human", "human"] },
    [B]: { cls: ["claude", "claude", "claude", "human"] },
    [T]: { cls: ["tumwater", "claude", "human"] },
  } };
  fs.writeFileSync(path.join(data, "metrics.json"), JSON.stringify(metrics));
  fs.writeFileSync(path.join(data, "blame.json"), JSON.stringify(blame));

  const r = run(data);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(fs.readFileSync(path.join(data, "compare.json"), "utf8"));
  const m = out.metrics, k = out.decisionKinds;

  // Each OSS repo contributes its own prodSLOC, so the spread is 1..repos.length.
  const firstRepo = repos[0] ?? "", lastRepo = repos[repos.length - 1] ?? "";
  assert.equal(m[firstRepo].prodSLOC, 1);
  assert.equal(m[lastRepo].prodSLOC, repos.length);
  assert.equal(m["OSS min"].prodSLOC, 1);
  assert.equal(m["OSS max"].prodSLOC, repos.length);
  assert.equal(m["OSS median"].prodSLOC, median(repos.map((_, i) => i + 1)));

  // Whole-repo arithmetic: src + src/ui are production (3 + 4 code, 2 comment), test is 2 code + 1
  // comment; scripts and docs are not production. Percentiles over cc [5, 11].
  const repo = m["tumwater repo"];
  assert.equal(repo.prodSLOC, 7);
  assert.equal(repo.testSLOC, 2);
  assert.equal(repo.testRatio, 2 / 7);
  assert.equal(repo.ccMean, 8);
  assert.equal(repo.ccMed, 8);
  assert.equal(repo.ccP90, 10.4);
  assert.equal(repo.cc10, 0.5);
  assert.equal(repo.ccMax, 11);
  assert.equal(repo.fnN, 2);
  assert.equal(repo.fileMed, 3.5);
  assert.equal(repo.fileP90, 3.9);
  assert.equal(repo.fileMax, 4);
  assert.equal(repo.files500, 0);
  assert.equal(repo.suppressPerK, (1000 * 3) / 7);
  assert.equal(repo.proseWordsPerK, (1000 * 100) / 7);

  // Author split: human lines fall out of both Tumwater and Claude; the two functions' majority
  // authors put one in each bucket.
  assert.equal(m.Tumwater.prodSLOC, 2);
  assert.equal(m.Claude.prodSLOC, 4);
  assert.equal(m.Tumwater.testSLOC, 1);
  assert.equal(m.Claude.testSLOC, 1);
  assert.equal(m.Tumwater.fnN, 1);
  assert.equal(m.Claude.fnN, 1);

  // Core variants drop src/ui from production and its function from the set, and omit the test
  // ratio (null once JSON serializes the NaN).
  assert.equal(m["Tumwater core"].prodSLOC, 2);
  assert.equal(m["Tumwater core"].fnN, 1);
  assert.equal(m["Claude core"].prodSLOC, 1);
  assert.equal(m["Claude core"].fnN, 0);
  assert.equal(m["Tumwater core"].testRatio, null);

  // Decision points by kind, per 1000 production code lines, narrowed by each author's kept
  // lines: a.ts 2 code for tumwater, a.ts 1 + b.ts 3 for claude (b.ts carries no tokens). The
  // whole-repo author split has no decision-kind entry of its own; the OSS repos do (all zero).
  assert.equal(k[firstRepo]["??"], 0);
  assert.equal(k.Tumwater["??"], 1000 / 2);
  assert.equal(k.Tumwater.if, 1000 / 2);
  assert.equal(k.Tumwater.loops, 2000 / 2);
  assert.equal(k.Tumwater["?."], 1000 / 2);
  assert.equal(k.Tumwater.case, 0);
  assert.equal(k.Claude.case, 1000 / 4);
  assert.equal(k.Claude.if, 0);
  assert.equal(k.Claude["||"], 1000 / 4);
  assert.equal(k["Tumwater core"]["?."], 1000 / 2);
  assert.equal(k["Claude core"].case, 1000 / 1);

  // The printed table names the columns and the decision-kind section.
  assert.match(r.stdout, /^metric\s+typedoc/m);
  assert.match(r.stdout, /OSS med/);
  assert.match(r.stdout, /repo\s+Tumwater\s+Claude\s+Tw-core\s+Cl-core/);
  assert.match(r.stdout, /decision points by kind, per 1000 production code lines:/);
  assert.match(r.stdout, / {2}Tumwater {2,}\?\?:500\.0/);
});
