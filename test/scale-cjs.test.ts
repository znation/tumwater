/** docs/code-metrics/scale.cjs — the human-effort model (COCOMO and McConnell) and the pace
 * figures published in docs/code-metrics.md. It had no test (grep for "scale.cjs" across test/
 * found nothing), yet its area/author attribution and per-day arithmetic decide every number in
 * the scale section of the docs. A wrong divisor, a dropped author, or a mis-classified category
 * silently misreports the docs.
 *
 * It is a CommonJS argv script outside dist/ (reads a data dir and writes scale.json there), so
 * the tests build a synthetic metrics.json + blame.json + history-tumwater.json triple in a temp
 * dir and run it as a subprocess — the .cjs specifier never enters tsc. The fixture carries known
 * counts, so the assertions pin the arithmetic rather than just "it ran". */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "./fixtures/repo-fixtures.js";

const SCALE = fileURLToPath(new URL("../../docs/code-metrics/scale.cjs", import.meta.url));

function run(data: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [SCALE, data], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** A `cls` string of `n` code lines ("c" is analyze.cjs's code class). */
const code = (n: number): string => "c".repeat(n);

/** `n` identical blame author tags. */
const rep = (author: string, n: number): string[] => Array.from({ length: n }, () => author);

/** Independent reference for the two closed-form models, so a coefficient or exponent drift in
 * scale.cjs fails here rather than only changing the printed docs. */
function approx(actual: number, expected: number, tol = 1e-3): void {
  assert.ok(Math.abs(actual - expected) <= tol, `expected ${expected}, got ${actual}`);
}

test("scale.cjs attributes code lines by area and author, and computes the effort and pace figures", () => {
  const data = tmpdir("scale-cjs-");
  const metrics = {
    files: [
      { file: path.join("src", "a.ts"), cat: "src", lang: "ts", cls: code(700) },
      { file: path.join("src", "ui", "b.ts"), cat: "src/ui", lang: "ts", cls: code(500) },
      { file: path.join("test", "a.test.ts"), cat: "test:spec", lang: "ts", cls: code(600) },
      { file: path.join("scripts", "e.mjs"), cat: "scripts", lang: "js", cls: code(9) }, // neither src nor test:spec: skipped
      { file: "README.md", cat: "docs:prose", lang: "md", cls: "" }, // no area: skipped
    ],
  };
  // Authors: 900 tumwater and 200 claude ("claude-3" maps through the startsWith branch) in prod,
  // and 100 lines of a third author ("alice") that `who` must fold into "human" — counted in the
  // area totals but absent from byAuthor. The ui file is entirely tumwater; the test file is 350
  // claude + 250 tumwater.
  const blame = {
    files: {
      [path.join("src", "a.ts")]: { cls: [...rep("tumwater", 400), ...rep("claude-3", 200), ...rep("alice", 100)] },
      [path.join("src", "ui", "b.ts")]: { cls: rep("tumwater", 500) },
      [path.join("test", "a.test.ts")]: { cls: [...rep("claude-3", 350), ...rep("tumwater", 250)] },
    },
  };
  const history = {
    spanDays: 10,
    first: "2026-09-01",
    last: "2026-09-10",
    linesByArea: { src: { added: 2000 }, test: { added: 800 } },
    tumwater: { activeDays: 8 },
    claude: { activeDays: 5 },
  };
  fs.writeFileSync(path.join(data, "metrics.json"), JSON.stringify(metrics));
  fs.writeFileSync(path.join(data, "blame.json"), JSON.stringify(blame));
  fs.writeFileSync(path.join(data, "history-tumwater.json"), JSON.stringify(history));

  const r = run(data);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(fs.readFileSync(path.join(data, "scale.json"), "utf8"));

  // Area split: src + src/ui are production (1200), test is 600; scripts and docs are dropped.
  assert.deepEqual(out.codeLines, { production: 1200, tests: 600, productionAndTests: 1800 });
  assert.equal(out.spanDays, 10);
  assert.equal(out.first, "2026-09-01");
  assert.equal(out.last, "2026-09-10");

  // The human line counts toward the production total but byAuthor only carries the two model
  // authors, each with calendar-day and active-day pace over its own lines.
  assert.deepEqual(Object.keys(out.pace.byAuthor).sort(), ["claude", "tumwater"]);
  assert.deepEqual(out.pace.byAuthor.tumwater, { codeLines: 1150, perCalendarDay: 115, activeDays: 8, perActiveDay: 143.75 });
  assert.deepEqual(out.pace.byAuthor.claude, { codeLines: 550, perCalendarDay: 55, activeDays: 5, perActiveDay: 110 });
  assert.equal(out.pace.survivingPerCalendarDay.production, 120);
  assert.equal(out.pace.survivingPerCalendarDay.productionAndTests, 180);
  assert.equal(out.pace.addedPerCalendarDay.srcAndTest, 280);

  // COCOMO organic: E = 2.4 × KLOC^1.05, D = 2.5 × E^0.38, staff = E / D.
  approx(out.cocomo.production.effortMonths, 2.906359);
  approx(out.cocomo.production.scheduleMonths, 3.750064);
  approx(out.cocomo.production.staff, 0.775016);
  approx(out.cocomo.productionAndTests.effortMonths, 4.448683);
  approx(out.cocomo.productionAndTests.scheduleMonths, 4.408595);
  approx(out.cocomo.productionAndTests.staff, 1.009094);

  // McConnell 100k rates: staff-years = lines / rate, work-day rate = rate / 250.
  approx(out.mcconnell.production.staffYears.atCocomoAverage, 1200 / 2600);
  assert.deepEqual(out.mcconnell.production.staffYears.range, [0.06, 1.2]);
  approx(out.mcconnell.production.linesPerWorkDay.atCocomoAverage, 2600 / 250);
  assert.deepEqual(out.mcconnell.production.linesPerWorkDay.range, [4, 80]);
  approx(out.mcconnell.productionAndTests.staffYears.atCocomoAverage, 1800 / 2600);
  assert.deepEqual(out.mcconnell.productionAndTests.staffYears.range, [0.09, 1.8]);

  // Equivalent team: surviving lines/day × 365 / rate.
  approx(out.pace.equivalentStaff.atCocomoAverage, (1800 / 10) * 365 / 2600);
  assert.deepEqual(out.pace.equivalentStaff.range, [3.285, 65.7]);

  // The printed summary repeats the same figures.
  assert.match(r.stdout, /span 10\.0 days \(2026-09-01 → 2026-09-10 PDT\)/);
  assert.match(r.stdout, /surviving code lines: production 1,200, tests 600, both 1,800/);
  assert.match(r.stdout, /equivalent team at McConnell's rates: 25 developers at the COCOMO average \(range 3–66\)/);
  assert.match(r.stdout, /  tumwater: 1,150 surviving code lines, 115 per calendar day, 144 per active day \(8 active days\)/);
  assert.match(r.stdout, /  claude: 550 surviving code lines, 55 per calendar day, 110 per active day \(5 active days\)/);
});

test("scale.cjs folds a line whose file has no blame entry into human, keeping it out of byAuthor", () => {
  const data = tmpdir("scale-cjs-noblame-");
  fs.writeFileSync(path.join(data, "metrics.json"), JSON.stringify({
    files: [{ file: path.join("src", "x.ts"), cat: "src", lang: "ts", cls: code(1) }],
  }));
  // blame.json holds no entry for that file, so who(undefined) must take the human fallback.
  fs.writeFileSync(path.join(data, "blame.json"), JSON.stringify({ files: {} }));
  fs.writeFileSync(path.join(data, "history-tumwater.json"), JSON.stringify({
    spanDays: 1, first: "2026-09-01", last: "2026-09-01",
    linesByArea: { src: { added: 0 }, test: { added: 0 } },
  }));

  const r = run(data);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(fs.readFileSync(path.join(data, "scale.json"), "utf8"));
  assert.equal(out.codeLines.production, 1);
  assert.equal(out.codeLines.tests, 0);
  assert.equal(out.pace.byAuthor.tumwater.codeLines, 0);
  assert.equal(out.pace.byAuthor.claude.codeLines, 0);
  assert.ok(Number.isFinite(out.cocomo.production.effortMonths));
});
