import test from "node:test";
import assert from "node:assert/strict";
import { initProject } from "../src/init/init.js";
import { defaultConfig } from "../src/config/config.js";
import { gitOnlyBinDir, makeRepo, tmpdir, writeConfig } from "./repo-fixtures.js";
import { cliWithEnv } from "./cli-harness.js";

// run/status/init's startup-preflight child-process tests: each fails fast with a clear
// message when a required binary (pi, git) is missing or unusable. Spawned via the CLI so
// node --test can run them in parallel processes; the shared spawn helpers live in
// cli-harness.ts.
test("run fails fast with a clear message when pi is missing from PATH", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run validation");

  // A PATH that has git (so the repo checks pass) but no pi: without the startup check,
  // the orchestrator would start and every tick of every loop would die with
  // "failed to spawn pi: spawn pi ENOENT".
  const binDir = gitOnlyBinDir();

  const r = await cliWithEnv(repo, { PATH: binDir }, ["run"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /pi not found on PATH/);
});

// plans/portability.md §5/7 criteria 2 and 4: the env override works without editing any
// file, and a failure names the resolved value, its source, and the install hint — a wrong
// agentBin must not read as "pi is not installed".
test("run fails fast naming the resolved agentBin and its source when it is not an executable", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli run agentBin fail");
  const binDir = gitOnlyBinDir();

  // TUMWATER_PI_BIN overrides for one invocation — including overriding the default into a
  // failure whose text names the variable, not the ambient PATH.
  const r = await cliWithEnv(repo, { PATH: binDir, TUMWATER_PI_BIN: "/no/such/pi-override" }, ["run"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /\/no\/such\/pi-override/);
  assert.match(r.stderr, /TUMWATER_PI_BIN/);
  assert.match(r.stderr, /install it/);
  assert.doesNotMatch(r.stderr, /pi not found on PATH/);

  // A configured agentBin fails with the same shape, naming tumwater.json's key.
  const cfg = defaultConfig();
  cfg.agentBin = "/also/missing/pi";
  writeConfig(repo, cfg);
  const r2 = await cliWithEnv(repo, { PATH: binDir }, ["run"]);
  assert.equal(r2.code, 1);
  assert.match(r2.stderr, /\/also\/missing\/pi/);
  assert.match(r2.stderr, /agentBin in tumwater\.json/);
});

test("status and init fail fast with a clear message when git is missing from PATH", async () => {
  // Without git on PATH, every repo probe used to report "not a git repository (run `git
  // init` first)" — pointing at the wrong fix for a machine that has no git installed.
  const binDir = tmpdir(); // empty: no git (the CLI child runs via an absolute node path)

  let r = await cliWithEnv(tmpdir(), { PATH: binDir }, ["status"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /git not found on PATH/);
  assert.ok(!r.stderr.includes("not a git repository"), "no misleading repo error");

  // init has its own gate (it does not go through requireReadyRepo).
  r = await cliWithEnv(makeRepo(), { PATH: binDir }, ["init", "Build a thing."]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /git not found on PATH/);
});
