import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { findOnPath } from "../src/files/files.js";
import { initProject } from "../src/init/init.js";
import { GIT_MISSING_MESSAGE } from "../src/git/git-run.js";
import {
  DETACHED_HEAD_MESSAGE,
  NOT_A_REPO_MESSAGE,
  NOT_INITIALIZED_MESSAGE,
  NO_COMMITS_MESSAGE,
} from "../src/gates/readiness.js";
import { repoNotReady, runStartupCheck, runStartupProblem } from "../src/gates/startup-gate.js";
import { registerAgentBackend, type AgentBackend } from "../src/agent/agent-backend.js";
import { gitInit, makeRepo, sh, tmpdir } from "./fixtures/repo-fixtures.js";
import { fakePi, withPi } from "./fakes/fake-pi.js";
import { pathReplace, writeScript } from "./fakes/fake-commands.js";
import { readClaudeAccount } from "../src/agent/claude/claude-account.js";

// `tumwater run`'s startup gate (src/gates/startup-gate.ts) in-process: the one answer cmdRun fails
// fast on, the self-redeploy refuses a swap on, and the supervisor names a dead generation with
// (BUGS.md 2026-09-23). test/cli.test.ts pins the same failures through the CLI.

test("a ready repo passes the gate with the config and branch the generation starts on", async () => {
  const repo = makeRepo();
  await initProject(repo, "startup gate ready");
  await withPi("exit 0", async () => {
    const check = await runStartupCheck(repo, null);
    assert.ok(!("problem" in check), JSON.stringify(check));
    assert.equal(check.mainBranch, "main");
    assert.ok(check.config.roles, "the loaded config");
    assert.equal(await runStartupProblem(repo, null), null);
    assert.equal(await repoNotReady(repo), null);
  });
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
  // A plain directory is the first thing a fresh `tumwater run` ends up in: the verdict is the repo
  // one, and the git probe behind it must not be what the operator reads.
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

test("the startup gate checks every enabled seam's agent and names that agent's binary", async () => {
  // A claude-routed review seam must be checked like the pi default: the gate refuses to boot
  // and the message names claude's resolved binary and config key, not pi's.
  const repo = makeRepo();
  await initProject(repo, "startup gate claude seam");
  await withPi("exit 0", async () => {
    const file = path.join(repo, "tumwater.json");
    const cfg = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    cfg.backends = { claude: { bin: "/no/such/claude" } };
    cfg.review = { model: "claude/claude-opus-5-5" };
    fs.writeFileSync(file, JSON.stringify(cfg));
    assert.match(
      String(await runStartupProblem(repo, null)),
      /claude not found — resolved "\/no\/such\/claude" from backends\.claude\.bin in tumwater\.json/,
    );
  });
});

test("a claude seam that exists only as a fallback is checked and its account seeded", async () => {
  // plans/provider-concurrency.md §9 gap 1: before `seamsInUse`, a claude backend that appears
  // only as a fallback got no binary check and never ran seedClaudeAccount, so the account file
  // was absent and the budget gate judged the subscription claude fallback priced at the cap.
  // Now the fallback is one of the seams the gate checks, so `claude auth status` runs once and
  // the subscription answer is written — with no hand-written account file (the budget gate's
  // earlier test wrote it by hand).
  const repo = makeRepo();
  await initProject(repo, "startup gate claude fallback");
  const claudeBin = tmpdir("startup-claude-bin-");
  writeScript(path.join(claudeBin, "claude"), 'echo \'{"loggedIn":true,"subscriptionType":"team"}\'');
  await withPi("exit 0", async () => {
    const file = path.join(repo, "tumwater.json");
    const cfg = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    cfg.backends = { claude: { bin: path.join(claudeBin, "claude") } };
    cfg.fallback = "claude/claude-sonnet-5-5";
    cfg.roles = { feature: { enabled: true } };
    fs.writeFileSync(file, JSON.stringify(cfg));
    const check = await runStartupCheck(repo, null);
    assert.ok(!("problem" in check), JSON.stringify(check));
    const account = readClaudeAccount(repo);
    assert.ok(account !== null, "no hand-written account file: the gate wrote it");
    assert.equal(account.billing, "subscription", "the gate seeded the fallback's subscription billing");
  });
});

test("a named branch in a repo with no local branches reports an empty branch list", async () => {
  // The empty-list half of resolveMainBranch's verdict: commits can exist with no branch
  // holding any (everything detached), and then the only honest error lists no alternatives.
  const repo = makeRepo();
  await initProject(repo, "startup gate branchless");
  await withPi("exit 0", async () => {
    sh(repo, "git", "checkout", "-q", "--detach");
    sh(repo, "git", "branch", "-d", "main");
    assert.equal(
      await runStartupProblem(repo, "ghost"),
      "branch ghost does not exist (branches: none)",
    );
  });
});

// opencode backend (part 2/7): a backend an enabled seam routes to that this build has no
// registered adapter for must refuse startup, naming the backend — a run would otherwise fall
// through to pi with an opencode model id pi cannot serve. The registry is read through
// src/agent/run-agent.ts (startup-gate.ts imports it), which registers the built-in pi and
// claude adapters; a fake under `opencode` stands in for a future adapter.

test("an opencode seam with no registered adapter fails startup, naming the backend", async () => {
  const repo = makeRepo();
  await initProject(repo, "startup gate opencode no adapter");
  await withPi("exit 0", async () => {
    const file = path.join(repo, "tumwater.json");
    const cfg = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    cfg.model = "opencode/deepseek-v4.1-flash-free";
    fs.writeFileSync(file, JSON.stringify(cfg));
    assert.equal(
      await runStartupProblem(repo, null),
      "backend opencode is configured but this build has no adapter for it",
    );
  });
});

test("a registered opencode adapter whose binary exists passes the gate", async () => {
  const repo = makeRepo();
  await initProject(repo, "startup gate opencode registered");
  const opencodeBin = tmpdir("startup-opencode-");
  writeScript(path.join(opencodeBin, "opencode"), "exit 0");
  // Register a fake opencode adapter so the registry knows the backend exists (only the
  // startup gate runs here; the adapter's invocation is never used).
  const fake: AgentBackend = {
    id: "opencode",
    label: "opencode",
    defaultBin: "opencode",
    binEnv: "TUMWATER_OPENCODE_BIN",
    resolveBin: () => ({ bin: path.join(opencodeBin, "opencode"), source: "config" }),
    invocation: () => ({ args: [], env: process.env }),
    translator: () => ({ translate: (line) => [line] }),
    classifyExit: () => ({}),
  };
  registerAgentBackend(fake);
  await withPi("exit 0", async () => {
    const file = path.join(repo, "tumwater.json");
    const cfg = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    cfg.backends = { opencode: { bin: path.join(opencodeBin, "opencode") } };
    cfg.model = "opencode/deepseek-v4.1-flash-free";
    fs.writeFileSync(file, JSON.stringify(cfg));
    const check = await runStartupCheck(repo, null);
    assert.ok(!("problem" in check), JSON.stringify(check));
    assert.ok(check.config.roles, "the loaded config");
  });
});
