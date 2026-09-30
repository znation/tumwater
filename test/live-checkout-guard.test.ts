import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { writeJsonFile } from "../src/json-files.js";
import { orchestratorStatePath } from "../src/paths.js";
import { tmpdir } from "./repo-fixtures.js";

// scripts/live-checkout-guard.mjs, the first step of `npm test` and `npm run test:e2e`: the
// suite refuses to run in a checkout a live fleet runs from, because its first steps recompile
// and restamp the dist/ that fleet and its dashboards execute (BUGS.md 2026-09-29). The guard
// is plain Node that runs before any compile, so these tests run it as a subprocess and write
// its marker through the harness's own path and writer — the guard cannot drift from where
// runOrchestrator really puts it.

const GUARD = fileURLToPath(new URL("../../scripts/live-checkout-guard.mjs", import.meta.url));

function runGuard(cwd: string): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, [GUARD], { cwd, encoding: "utf8" });
}

test("both suite scripts run the live-checkout guard before anything lints, compiles, or stamps", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    scripts?: Record<string, string>;
  };
  for (const name of ["test", "test:e2e"])
    assert.match(pkg.scripts?.[name] ?? "", /^node scripts\/live-checkout-guard\.mjs && /, `"${name}" starts with the guard`);
});

test("the guard passes silently where no live fleet runs: no marker, a dead pid, or a torn marker", () => {
  const dir = tmpdir();
  const bare = runGuard(dir);
  assert.equal(bare.status, 0, bare.stderr);
  assert.equal(bare.stdout + bare.stderr, "", "a passing guard prints nothing");

  // A marker whose process is gone (a crashed fleet leaves one behind).
  writeJsonFile(orchestratorStatePath(dir), { pid: 999999999, startedAt: 1, roles: [] });
  assert.equal(runGuard(dir).status, 0);

  // A torn marker reads as no fleet, as it does for every observer (readOrchestratorInfo).
  fs.writeFileSync(orchestratorStatePath(dir), '{"pid": 1');
  assert.equal(runGuard(dir).status, 0);
});

test("the guard refuses the checkout a live fleet runs from, naming the pid and where to run instead", () => {
  const dir = tmpdir();
  writeJsonFile(orchestratorStatePath(dir), { pid: process.pid, startedAt: Date.now(), roles: ["bugfix"] });
  const r = runGuard(dir);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, new RegExp(`\\(\`tumwater run\`, pid ${process.pid}\\)`));
  assert.match(r.stderr, /recompile and restamp this checkout's dist\//);
  assert.match(r.stderr, /Run it from a worktree instead: a fleet loop's own is \.tumwater\/worktrees\/<role>/);
});
