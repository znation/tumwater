import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeScript } from "./fakes/fake-commands.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

// scripts/lint-changed.mjs, the gate's lint step. With `--alongside` it runs the gate's test step
// while eslint works and prints eslint's held report after the tests. Each case runs a copy of the
// script beside stub dist/ modules (the changed-file list and lint targets are test/
// affected-tests.ts's job, pinned there) with a fake eslint on PATH, so only the orchestration is
// under test: both run at once, the report comes last, and the exit status is the command's when
// it failed, else eslint's.

const SCRIPT = fileURLToPath(new URL("../../scripts/lint-changed.mjs", import.meta.url));

/** A checkout-shaped temp dir holding the script, its two dist/ imports as stubs (the changed
 * files come from LINT_TEST_CHANGED), and a fake eslint that drops `$LINT_MARK`, prints its argv
 * and exits `$LINT_EXIT`. */
function lintRoot(): { script: string; bin: string; mark: string } {
  const root = tmpdir();
  fs.mkdirSync(path.join(root, "scripts"));
  fs.mkdirSync(path.join(root, "dist", "test"), { recursive: true });
  fs.mkdirSync(path.join(root, "bin"));
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
  fs.copyFileSync(SCRIPT, path.join(root, "scripts", "lint-changed.mjs"));
  fs.writeFileSync(path.join(root, "dist", "test", "affected-tests.js"), "export const gateLintTargets = (files) => files;\n");
  fs.writeFileSync(
    path.join(root, "dist", "test", "test-runner.js"),
    'export const changedSinceBase = () => ({ files: JSON.parse(process.env.LINT_TEST_CHANGED ?? "[]") });\n',
  );
  writeScript(path.join(root, "bin", "eslint"), 'touch "$LINT_MARK"\necho "eslint-report $*"\nexit "${LINT_EXIT:-0}"');
  return { script: path.join(root, "scripts", "lint-changed.mjs"), bin: path.join(root, "bin"), mark: path.join(root, "linted") };
}

/** The test step stand-in: wait (bounded) for eslint's mark, so it passes only when eslint runs
 * while it does, then print and exit `$CMD_EXIT`. */
const COMMAND = [
  "-e",
  "const fs=require('fs');const end=Date.now()+20000;" +
    "(function wait(){if(fs.existsSync(process.env.LINT_MARK)){console.log('tests-output');process.exit(Number(process.env.CMD_EXIT))}" +
    "if(Date.now()>end){console.log('eslint never ran alongside');process.exit(9)}setTimeout(wait,10)})()",
];

function runAlongside(env: Record<string, string>): { status: number | null; stdout: string } {
  const { script, bin, mark } = lintRoot();
  const r = spawnSync(process.execPath, [script, "--alongside", process.execPath, ...COMMAND], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, LINT_MARK: mark, LINT_TEST_CHANGED: '["a.ts"]', CMD_EXIT: "0", ...env },
  });
  return { status: r.status, stdout: r.stdout };
}

test("lint-changed --alongside runs eslint while the command runs and prints its report after the command's output", () => {
  const r = runAlongside({});
  assert.equal(r.status, 0, r.stdout);
  const lines = r.stdout.trim().split("\n");
  assert.deepEqual(lines, ["lint: 1 changed file(s)", "tests-output", "eslint-report --cache --no-warn-ignored a.ts", "lint: clean"]);
});

test("lint-changed --alongside exits with the command's status when it failed, else with eslint's", () => {
  const lintFailed = runAlongside({ LINT_EXIT: "1" });
  assert.equal(lintFailed.status, 1);
  assert.match(lintFailed.stdout, /lint: failed/);
  const both = runAlongside({ LINT_EXIT: "1", CMD_EXIT: "3" });
  assert.equal(both.status, 3, "the test step's own failure wins");
  assert.equal(runAlongside({ CMD_EXIT: "4" }).status, 4);
});

test("lint-changed --alongside with nothing to lint runs just the command", () => {
  const { script, bin, mark } = lintRoot();
  fs.writeFileSync(mark, ""); // the command's wait needs the mark eslint would have dropped
  const r = spawnSync(process.execPath, [script, "--alongside", process.execPath, ...COMMAND], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, LINT_MARK: mark, LINT_TEST_CHANGED: "[]", CMD_EXIT: "5" },
  });
  assert.equal(r.status, 5);
  assert.deepEqual(r.stdout.trim().split("\n"), ["lint: no changed file to lint", "tests-output"]);
});
