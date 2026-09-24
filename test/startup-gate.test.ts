import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initProject } from "../src/init.js";
import { DETACHED_HEAD_MESSAGE, NOT_INITIALIZED_MESSAGE } from "../src/readiness.js";
import { repoNotReady, runStartupCheck, runStartupProblem } from "../src/startup-gate.js";
import { fakePi, makeRepo, sh } from "./util.js";

// `tumwater run`'s startup gate (src/startup-gate.ts) in-process: the one answer cmdRun fails
// fast on, the self-redeploy refuses a swap on, and the supervisor names a dead generation with
// (BUGS.md 2026-09-23). test/cli.test.ts pins the same failures through the CLI.

test("a ready repo passes the gate with the config and branch the generation starts on", async () => {
  const repo = makeRepo();
  await initProject(repo, "startup gate ready");
  const restore = fakePi("exit 0");
  try {
    const check = await runStartupCheck(repo, null);
    assert.ok(!("problem" in check), JSON.stringify(check));
    assert.equal(check.mainBranch, "main");
    assert.ok(check.config.roles, "the loaded config");
    assert.equal(await runStartupProblem(repo, null), null);
    assert.equal(await repoNotReady(repo), null);
  } finally {
    restore();
  }
});

test("each unmet precondition is the gate's verdict, in cmdRun's order", async () => {
  const repo = makeRepo();
  await initProject(repo, "startup gate problems");
  const config = path.join(repo, "tumwater.json");
  const saved = fs.readFileSync(config, "utf8");
  const restore = fakePi("exit 0");
  const piEnv = process.env.TUMWATER_PI_BIN;
  try {
    // A vanished config is "not initialized" — startup never reads a missing file as defaults.
    fs.rmSync(config);
    assert.equal(await runStartupProblem(repo, null), NOT_INITIALIZED_MESSAGE);
    assert.equal(await repoNotReady(repo), NOT_INITIALIZED_MESSAGE);
    // A config that does not validate is its own message, not a throw.
    fs.writeFileSync(config, "{ torn");
    assert.match(String(await runStartupProblem(repo, null)), /tumwater\.json/);
    fs.writeFileSync(config, saved);
    // An agent binary that does not resolve names the resolution.
    process.env.TUMWATER_PI_BIN = "/no/such/pi";
    assert.match(String(await runStartupProblem(repo, null)), /\/no\/such\/pi.*TUMWATER_PI_BIN/);
    if (piEnv === undefined) delete process.env.TUMWATER_PI_BIN;
    else process.env.TUMWATER_PI_BIN = piEnv;
    // A branch it cannot target: a named one that does not exist, or a detached checkout.
    assert.equal(await runStartupProblem(repo, "ghost"), "branch ghost does not exist (branches: main)");
    sh(repo, "git", "checkout", "-q", "--detach");
    assert.equal(await runStartupProblem(repo, null), DETACHED_HEAD_MESSAGE);
    assert.equal(await runStartupProblem(repo, "main"), null, "an explicit branch does not need the checkout");
  } finally {
    if (piEnv === undefined) delete process.env.TUMWATER_PI_BIN;
    else process.env.TUMWATER_PI_BIN = piEnv;
    restore();
  }
});
