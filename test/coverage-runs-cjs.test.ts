/** docs/code-metrics/coverage-runs.cjs — the multi-run average behind run.sh's coverage-runs.txt.
 * It had no test (grep for its name across test/ found only run.sh), yet it is what the docs report:
 * it joins metrics.json (category per file, executable-line flags), blame.json (line author), every
 * coverage-ts-<k>.json (coverage.cjs output) and every coverage-run-<k>.txt (node's table and the
 * test tally), attributes each executable line/branch/function to its author, averages over the runs
 * whose suite passed, and reports the per-run line envelope and the files whose coverage flips.
 *
 * It is a CommonJS argv script outside dist/, so the tests build a data dir under temp and run it as
 * a subprocess — the .cjs specifier never enters tsc. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "./fixtures/repo-fixtures.js";

const RUNS = fileURLToPath(new URL("../../docs/code-metrics/coverage-runs.cjs", import.meta.url));

// The paths the fixtures attribute coverage to. They name real files in the tree for realism; the
// script only indexes its synthetic metrics/blame/coverage maps by these keys and never opens them.
const A_TS = "src/cli.ts";
const B_TS = "src/ui/badges.ts";

function runRuns(data: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [RUNS, data], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Build a data dir with metrics.json, blame.json, one coverage-ts-<k>.json per run, and the run's
 * own output; run 3's tally marks its suite failed so every average excludes it. */
function seedData(): string {
  const data = tmpdir("covruns-");
  fs.writeFileSync(path.join(data, "metrics.json"), JSON.stringify({
    files: [
      { file: A_TS, cat: "src", cls: { 1: "c", 2: "c", 3: "n", 4: "c" } },
      { file: B_TS, cat: "src/ui", cls: { 1: "c", 2: "c" } },
    ],
  }));
  fs.writeFileSync(path.join(data, "blame.json"), JSON.stringify({
    files: {
      [A_TS]: { cls: { 1: "tumwater", 2: "claude-3", 3: "tumwater", 4: "human" } },
      [B_TS]: { cls: { 1: "claude-3", 2: "tumwater" } },
    },
  }));
  // Two passing runs whose covers differ on two executable lines — a.ts:2 (Claude) and b.ts:1
  // (Claude) flip — plus a third run whose suite failed: it is parsed and listed but kept out of
  // every average. a.ts:4 stays covered in both runs and is marked human, so it exercises the
  // script's exclusion of human-authored lines without ever landing in the flip bucket.
  fs.writeFileSync(path.join(data, "coverage-ts-1.json"), JSON.stringify({
    [A_TS]: { lines: [[1, 1], [2, 0], [3, 1], [4, 1]], branches: [[1, 1], [2, 1], [2, 0]], funcs: [[1, 1], [2, 0]] },
    [B_TS]: { lines: [[1, 1], [2, 1]], branches: [[1, 1]], funcs: [[1, 1]] },
  }));
  fs.writeFileSync(path.join(data, "coverage-ts-2.json"), JSON.stringify({
    [A_TS]: { lines: [[1, 1], [2, 1], [3, 1], [4, 1]], branches: [[1, 1], [2, 1], [2, 1]], funcs: [[1, 1], [2, 1]] },
    [B_TS]: { lines: [[1, 0], [2, 1]], branches: [[1, 0]], funcs: [[1, 0]] },
  }));
  fs.writeFileSync(path.join(data, "coverage-ts-3.json"), JSON.stringify({
    [A_TS]: { lines: [[1, 0]], branches: [], funcs: [] },
  }));
  for (const [k, table, total, fail] of [[1, "80.00 | 70.00 | 60.00", 10, 0], [2, "90.00 | 80.00 | 70.00", 12, 0], [3, "50.00 | 50.00 | 50.00", 5, 1]]) {
    fs.writeFileSync(path.join(data, `coverage-run-${k}.txt`),
      `all files | ${table}\nℹ tests ${total}\nℹ pass ${total}\nℹ fail ${fail}\nℹ skipped 0\n`);
  }
  return data;
}

test("coverage-runs.cjs averages passing runs and keeps failed runs and non-executable lines out", () => {
  const data = seedData();
  const r = runRuns(data);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /3 run\(s\): #1 10\/10 pass, 0 fail; #2 12\/12 pass, 0 fail; #3 5\/5 pass, 1 fail/);
  assert.match(r.stdout, /averaging the 2 passing run\(s\); excluded \(suite failed\): #3/);

  const s = JSON.parse(fs.readFileSync(path.join(data, "coverage-runs.json"), "utf8"));
  assert.equal(s.runs, 2);
  assert.deepEqual(s.excluded, [3]);
  // node's table row: run 1 80/70/60, run 2 90/80/70 → means 85/75/65.
  assert.equal(s.node.lines.mean, 85);
  assert.equal(s.node.branches.mean, 75);
  assert.equal(s.node.functions.mean, 65);

  // core = cat "src", ui = cat "src/ui": the two scopes partition the authors' lines. core's only
  // executable Tumwater line (a.ts:1) is covered in both runs; core.claude's a.ts:2 flips, so its
  // mean is 50.
  assert.equal(s.split.core.tumwater.lines.mean, 100);
  assert.equal(s.split.core.claude.lines.mean, 50);
  assert.equal(s.split.core.claude.lines.min, 0);
  assert.equal(s.split.core.claude.lines.max, 100);
  assert.equal(s.split.ui.claude.lines.mean, 50);
  // a.ts line 3 is flag "n", so it never counts toward any denominator.
  assert.equal(s.split.all.tumwater.lines.mean, 100);
  assert.equal(s.split.all.claude.lines.mean, 50);

  // Envelope: the two Claude lines are each covered in exactly one run; the Tumwater lines in both.
  assert.deepEqual(s.envelope, {
    all: {
      tumwater: { lines: 2, everyRun: 100, anyRun: 100, sometimes: 0, never: 0 },
      claude: { lines: 2, everyRun: 0, anyRun: 100, sometimes: 2, never: 0 },
    },
    core: {
      tumwater: { lines: 1, everyRun: 100, anyRun: 100, sometimes: 0, never: 0 },
      claude: { lines: 1, everyRun: 0, anyRun: 100, sometimes: 1, never: 0 },
    },
    ui: {
      tumwater: { lines: 1, everyRun: 100, anyRun: 100, sometimes: 0, never: 0 },
      claude: { lines: 1, everyRun: 0, anyRun: 100, sometimes: 1, never: 0 },
    },
  });
  // Both files' covered-line counts move between the runs. The one flipping line in each is
  // authored by claude-3; the human-authored a.ts:4 is covered in both runs, so it appears in no
  // flip count.
  assert.deepEqual(s.variableFiles, [
    { file: A_TS, minCovered: 2, maxCovered: 3, flippingLines: { tumwater: 0, claude: 1 } },
    { file: B_TS, minCovered: 1, maxCovered: 2, flippingLines: { tumwater: 0, claude: 1 } },
  ]);
});

test("coverage-runs.cjs exits 1 when no run passed", () => {
  const data = seedData();
  // Re-mark both previously passing runs as failed by rewriting their tallies.
  for (const k of [1, 2]) {
    fs.writeFileSync(path.join(data, `coverage-run-${k}.txt`),
      `all files | 80.00 | 70.00 | 60.00\nℹ tests 5\nℹ pass 4\nℹ fail 1\n`);
  }
  const r = runRuns(data);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no passing run to average/);
  assert.equal(fs.existsSync(path.join(data, "coverage-runs.json")), false);
});

test("coverage-runs.cjs exits 1 when the data dir has no coverage-ts dump", () => {
  const data = tmpdir("covruns-none-");
  fs.writeFileSync(path.join(data, "metrics.json"), JSON.stringify({ files: [] }));
  fs.writeFileSync(path.join(data, "blame.json"), JSON.stringify({ files: {} }));
  const r = runRuns(data);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no coverage-ts-<k>\.json in/);
});
