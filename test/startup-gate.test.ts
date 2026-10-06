import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { findOnPath } from "../src/files.js";
import { initProject } from "../src/init.js";
import { GIT_MISSING_MESSAGE } from "../src/git-run.js";
import {
  DETACHED_HEAD_MESSAGE,
  NOT_A_REPO_MESSAGE,
  NOT_INITIALIZED_MESSAGE,
  NO_COMMITS_MESSAGE,
} from "../src/readiness.js";
import { repoNotReady, runStartupCheck, runStartupProblem } from "../src/gates/startup-gate.js";
import { gitInit, makeRepo, sh, tmpdir } from "./repo-fixtures.js";
import { fakePi } from "./fake-pi.js";
import { pathReplace } from "./fake-commands.js";

// `tumwater run`'s startup gate (src/gates/startup-gate.ts) in-process: the one answer cmdRun fails
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

test("each unmet repo precondition names its own fix: not a repo, no commits, no git", async () => {
  // A plain directory is the first thing a fresh `tumwater run` lands in: the verdict is the
  // repo one, and the git probe behind it must not be what the operator reads.
  assert.equal(await repoNotReady(tmpdir()), NOT_A_REPO_MESSAGE);

  // An unborn HEAD fails on the missing config first and on the missing commits only once
  // tumwater.json exists — the checks' order is the operator's reading order.
  const unborn = tmpdir();
  gitInit(unborn);
  assert.equal(await repoNotReady(unborn), NOT_INITIALIZED_MESSAGE);
  fs.writeFileSync(path.join(unborn, "tumwater.json"), "{}\n");
  assert.equal(await repoNotReady(unborn), NO_COMMITS_MESSAGE);

  // With git absent from PATH entirely the verdict is the missing binary: the failed probe
  // must not be misread as "not a git repository", which would point at the wrong fix — the
  // exact confusion the binary check exists to prevent (the comment on it in startup-gate.ts).
  const restorePath = pathReplace("");
  try {
    assert.equal(await repoNotReady(unborn), GIT_MISSING_MESSAGE);
  } finally {
    restorePath();
  }
});

test("a bare agentBin name that is nowhere on PATH fails the gate with the resolution message", async () => {
  // The other half of the agent check: the pinned test above misses with a path-shaped bin
  // (the accessSync arm); a bare name that resolves nowhere must take the PATH arm and still
  // name where the value came from, so the operator knows which setting to fix.
  const repo = makeRepo();
  await initProject(repo, "startup gate bare pi");
  const restore = fakePi("exit 0");
  const piEnv = process.env.TUMWATER_PI_BIN;
  try {
    assert.ok(findOnPath("pi"), "fakePi is on PATH so the gate's default check passes");
    process.env.TUMWATER_PI_BIN = "definitely-not-on-path-xyz";
    assert.match(
      String(await runStartupProblem(repo, null)),
      /resolved "definitely-not-on-path-xyz" from TUMWATER_PI_BIN is not an executable/,
    );
  } finally {
    if (piEnv === undefined) delete process.env.TUMWATER_PI_BIN;
    else process.env.TUMWATER_PI_BIN = piEnv;
    restore();
  }
});

test("a named branch in a repo with no local branches reports an empty branch list", async () => {
  // The empty-list half of resolveMainBranch's verdict: commits can exist with no branch
  // holding any (everything detached), and then the only honest error lists no alternatives.
  const repo = makeRepo();
  await initProject(repo, "startup gate branchless");
  const restore = fakePi("exit 0");
  try {
    sh(repo, "git", "checkout", "-q", "--detach");
    sh(repo, "git", "branch", "-d", "main");
    assert.equal(
      await runStartupProblem(repo, "ghost"),
      "branch ghost does not exist (branches: none)",
    );
  } finally {
    restore();
  }
});
