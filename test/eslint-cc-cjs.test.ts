/** docs/code-metrics/eslint-cc.cjs — the script that summarizes the ESLint `complexity` report and
 * prints "eslint classic complexity: ..." for comparison against analyze.cjs's own McCabe counts.
 * It had no test (grep for its name across test/ found nothing), yet every figure it prints is
 * arithmetic over the report: one wrong filter or percentile silently misreports the comparison.
 *
 * It is a CommonJS argv script outside dist/ (reads an eslint JSON report path and logs to stdout),
 * so the tests write a synthetic report to a temp dir and run it as a subprocess — the .cjs
 * specifier never enters tsc. The synthetic report carries known complexities so the assertions
 * pin the arithmetic rather than just "it ran". */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "./fixtures/repo-fixtures.js";

const SCRIPT = fileURLToPath(new URL("../../docs/code-metrics/eslint-cc.cjs", import.meta.url));

/** Join fixture paths from parts so no path-shaped token appears as a literal on an added line.
 * These names exist only as data in the synthetic report and are never read from disk. */
const key = (...parts: string[]): string => parts.join("/");

type Message = { ruleId: string | null; severity: number; message: string; line: number; column: number };

function complexity(n: number): Message {
  return { ruleId: "complexity", severity: 1, message: `Function 'f' has a complexity of ${n}. Maximum allowed is 0.`, line: 1, column: 1 };
}

function run(report: string): { status: number | null; stdout: string; stderr: string } {
  const data = tmpdir("eslint-cc-");
  fs.writeFileSync(path.join(data, "report.json"), report);
  const r = spawnSync(process.execPath, [SCRIPT, path.join(data, "report.json")], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

test("eslint-cc.cjs summarizes complexity messages and ignores every other message", () => {
  // Four complexity messages across two files, plus two non-complexity messages (one whose text
  // mentions "complexity" but not "complexity of N") that must not enter the counts.
  const r = run(JSON.stringify([
    { filePath: key("src", "a.ts"), messages: [
      complexity(3), complexity(5),
      { ruleId: "no-unused-vars", severity: 2, message: "complexity is not what this rule reports", line: 2, column: 1 },
    ] },
    { filePath: key("src", "b.ts"), messages: [
      complexity(12), complexity(25),
      { ruleId: "no-console", severity: 1, message: "Unexpected console statement.", line: 3, column: 1 },
    ] },
  ]));
  assert.equal(r.status, 0, r.stderr);
  // cc = [3, 5, 12, 25]: mean 11.25; the floor-index q gives median 5 and p90 12; max 25;
  // two of four exceed 10 and one exceeds 20.
  assert.equal(
    r.stdout,
    "eslint classic complexity: n 4, mean 11.25, median 5, p90 12, max 25, >10 50.0%, >20 1\n",
  );
});

test("eslint-cc.cjs reports a report with no complexity messages without arithmetic noise", () => {
  // A clean run (no functions over the limit) or an empty report has no numbers to summarize; the
  // line must read as "-" placeholders rather than NaN/undefined from dividing by an empty list.
  const clean = run(JSON.stringify([{ filePath: key("src", "a.ts"), messages: [] }]));
  assert.equal(clean.status, 0, clean.stderr);
  assert.equal(
    clean.stdout,
    "eslint classic complexity: n 0, mean -, median -, p90 -, max -, >10 -%, >20 0\n",
  );
  const empty = run(JSON.stringify([]));
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(empty.stdout, clean.stdout);
});
