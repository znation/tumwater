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
  teamWorkspaceMessage,
  NO_COMMITS_MESSAGE,
} from "../src/gates/readiness.js";
import { newOpencodeCatalogRefresh, OPENCODE_CATALOG_RETRY_MS, opencodeProviders, repoNotReady, runStartupCheck, runStartupProblem, unregisteredBackendInUse, type OpenCodeSeedOptions } from "../src/gates/startup-gate.js";
import { registerAgentBackend, type AgentBackend } from "../src/agent/agent-backend.js";
import { gitInit, makeRepo, sh, teamWorkspace, tmpdir } from "./fixtures/repo-fixtures.js";
import { fakePi, withPi } from "./fakes/fake-pi.js";
import { setEnv } from "./helpers/env.js";
import { pathReplace, writeScript } from "./fakes/fake-commands.js";
import { readClaudeAccount } from "../src/agent/claude/claude-account.js";
import { defaultConfig, loadConfig } from "../src/config/config.js";
import { claudeAccountPath, opencodeModelsPath } from "../src/paths.js";
import { warningMessages } from "./fixtures/log-fixtures.js";
import { failRenameSyncOn } from "./helpers/fs-faults.js";
import { writeOpencodeCache } from "./fixtures/models-fixtures.js";
import { readOpencodeCache, type CatalogFetch } from "../src/agent/opencode/opencode-catalog.js";
import { readJson } from "./helpers/json-read.js";

// `tumwater start`'s startup gate (src/gates/startup-gate.ts) in-process: the one answer cmdStart
// fails fast on, the self-redeploy refuses a swap on, and the supervisor names a dead generation
// with (BUGS.md 2026-09-23). test/cli.test.ts pins the same failures through the CLI.

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

test("each unmet precondition is the gate's verdict, in cmdStart's order", async () => {
  const repo = makeRepo();
  await initProject(repo, "startup gate problems");
  const config = path.join(repo, "tumwater.json");
  const saved = fs.readFileSync(config, "utf8");
  const restore = fakePi("exit 0");
  const restorePiBin = setEnv("TUMWATER_PI_BIN", process.env.TUMWATER_PI_BIN); // snapshot only
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
    setEnv("TUMWATER_PI_BIN", "/no/such/pi");
    assert.match(String(await runStartupProblem(repo, null)), /\/no\/such\/pi.*TUMWATER_PI_BIN/);
    restorePiBin();
    // A branch it cannot target: a named one that does not exist, or a detached checkout.
    assert.equal(await runStartupProblem(repo, "ghost"), "branch ghost does not exist (branches: main)");
    sh(repo, "git", "checkout", "-q", "--detach");
    assert.equal(await runStartupProblem(repo, null), DETACHED_HEAD_MESSAGE);
    assert.equal(await runStartupProblem(repo, "main"), null, "an explicit branch does not need the checkout");
  } finally {
    restorePiBin();
    restore();
  }
});

test("each unmet repo precondition names its own fix: not a repo, no commits, no git", async () => {
  // A plain directory is the first thing a fresh `tumwater start` ends up in: the verdict is the
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
  const restorePiBin = setEnv("TUMWATER_PI_BIN", "definitely-not-on-path-xyz");
  try {
    assert.ok(findOnPath("pi"), "fakePi is on PATH so the gate's default check passes");
    assert.match(
      String(await runStartupProblem(repo, null)),
      /resolved "definitely-not-on-path-xyz" from TUMWATER_PI_BIN is not an executable/,
    );
  } finally {
    restorePiBin();
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
    const cfg = readJson(file) as Record<string, unknown>;
    cfg.backends = { claude: { bin: "/no/such/claude" } };
    cfg.review = { backend: "claude", model: "claude-opus-5-5" };
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
    const cfg = readJson(file) as Record<string, unknown>;
    cfg.backends = { claude: { bin: path.join(claudeBin, "claude") } };
    cfg.fallback = [{ backend: "claude", model: "claude-sonnet-5-5" }];
    cfg.roles = { feature: { enabled: true } };
    fs.writeFileSync(file, JSON.stringify(cfg));
    const check = await runStartupCheck(repo, null);
    assert.ok(!("problem" in check), JSON.stringify(check));
    const account = readClaudeAccount(repo);
    assert.ok(account !== null, "no hand-written account file: the gate wrote it");
    assert.equal(account.billing, "subscription", "the gate seeded the fallback's subscription billing");
  });
});

test("an unwritable claude account file does not fail the startup gate", async () => {
  // runStartupCheck never throws: a failed seed write leaves the file for the first claude run.
  const repo = makeRepo();
  await initProject(repo, "startup gate claude unwritable account");
  const claudeBin = tmpdir("startup-claude-bin-");
  writeScript(path.join(claudeBin, "claude"), 'echo \'{"loggedIn":true,"subscriptionType":"team"}\'');
  await withPi("exit 0", async () => {
    const file = path.join(repo, "tumwater.json");
    const cfg = readJson(file) as Record<string, unknown>;
    cfg.backends = { claude: { bin: path.join(claudeBin, "claude") } };
    cfg.fallback = [{ backend: "claude", model: "claude-sonnet-5-5" }];
    cfg.roles = { feature: { enabled: true } };
    fs.writeFileSync(file, JSON.stringify(cfg));
    fs.mkdirSync(claudeAccountPath(repo), { recursive: true });
    const check = await runStartupCheck(repo, null);
    assert.ok(!("problem" in check), JSON.stringify(check));
    assert.equal(readClaudeAccount(repo), null);
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

// The no-registered-adapter guard (part 2/7): a backend an enabled seam routes to that this
// build has no registered adapter for must refuse startup, naming the backend — a run would
// otherwise fall through to pi with a model id pi cannot serve. The registry is read through
// src/agent/run-agent.ts (startup-gate.ts imports it), which registers the built-in pi,
// claude and opencode adapters; a fake under `opencode` stands in for a future adapter.
// (Part 5/7 registered opencode, so the no-adapter guard now has no reachable trigger; this
// test verifies opencode's new registered behavior instead — a missing configured binary
// fails naming it, deterministically regardless of whether `opencode` is on this PATH.)

test("an opencode seam with a missing configured binary fails startup, naming the backend", async () => {
  const repo = makeRepo();
  await initProject(repo, "startup gate opencode missing");
  const missingBin = path.join(repo, "no-opencode");
  await withPi("exit 0", async () => {
    const file = path.join(repo, "tumwater.json");
    const cfg = readJson(file) as Record<string, unknown>;
    cfg.backends = { opencode: { bin: missingBin } };
    cfg.backend = "opencode"; cfg.model = "deepseek-v4.1-flash-free";
    fs.writeFileSync(file, JSON.stringify(cfg));
    assert.match(
      (await runStartupProblem(repo, null)) ?? "",
      /opencode not found — resolved .*no-opencode.* backends\.opencode\.bin/,
    );
  });
});

// The no-registered-adapter guard itself (part 2/7): a backend an enabled seam routes to that
// this build has no registered adapter for must be named. The registry registers pi, claude and
// opencode; config validation also admits `codex` (part 4/9) — a reserved id whose adapter lands
// in part 7/9 — so `backend: "codex"` is the one reachable no-adapter trigger through a real
// config file. Exercise both the reachable id and a genuinely unknown id.
test("unregisteredBackendInUse names a seam routed to a backend with no registered adapter", async () => {
  const repo = makeRepo();
  await initProject(repo, "startup gate unregistered backend");
  const file = path.join(repo, "tumwater.json");
  const cfg = readJson(file) as Record<string, unknown>;
  cfg.backend = "futuristic";
  assert.equal(unregisteredBackendInUse(cfg as never), "futuristic");
  // codex is a valid config id with no adapter yet (part 4/9), so a config that routes a seam
  // to it must be caught naming codex until part 7/9 registers the adapter.
  cfg.backend = "codex";
  assert.equal(unregisteredBackendInUse(cfg as never), "codex");
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
    const cfg = readJson(file) as Record<string, unknown>;
    cfg.backends = { opencode: { bin: path.join(opencodeBin, "opencode") } };
    cfg.backend = "opencode"; cfg.model = "deepseek-v4.1-flash-free";
    fs.writeFileSync(file, JSON.stringify(cfg));
    // The seed runs for an opencode boot, but this test is about the gate, not the catalog: a
    // throwing fake fetch keeps the run offline (a failed seed never blocks startup).
    const check = await runStartupCheck(repo, null, {
      fetch: async () => {
        throw new Error("offline test: no catalog fetch");
      },
    } satisfies OpenCodeSeedOptions);
    assert.ok(!("problem" in check), JSON.stringify(check));
    assert.ok(check.config.roles, "the loaded config");
  });
});

test("opencodeProviders names every models.dev provider the config routes through OpenCode (part 6b/7)", async () => {
  const repo = makeRepo();
  await initProject(repo, "startup gate opencode providers");
  const file = path.join(repo, "tumwater.json");
  const cfg = readJson(file) as Record<string, unknown>;
  // A bare gateway id (no provider) and a provider route on the strong tier; the gateway is
  // always kept by the parse, so only the provider route adds a name.
    cfg.backend = "opencode";
  cfg.model = { default: "deepseek-v4.1-flash-free", strong: { backend: "opencode", model: "anthropic/claude-haiku-5-5" } };
  fs.writeFileSync(file, JSON.stringify(cfg));
  assert.deepEqual(opencodeProviders(loadConfig(repo)), ["anthropic"]);
});

test("the startup gate seeds the catalog cache for an opencode boot, fetching on a missing cache", async () => {
  const repo = makeRepo();
  await initProject(repo, "startup gate opencode seed");
  const opencodeBin = tmpdir("startup-opencode-seed-");
  writeScript(path.join(opencodeBin, "opencode"), "exit 0");
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
    const cfg = readJson(file) as Record<string, unknown>;
    cfg.backends = { opencode: { bin: path.join(opencodeBin, "opencode") } };
    cfg.backend = "opencode"; cfg.model = "deepseek-v4.1-flash-free";
    fs.writeFileSync(file, JSON.stringify(cfg));
    // No cache on disk yet: the seed must fetch (via the injected fake, offline) and persist
    // the parsed catalog. Without the seed, no cache would ever be written.
    const body = {
      opencode: { models: { "deepseek-v4.1-flash-free": { cost: { input: 0, output: 0 }, limit: { context: 200000 } } } },
    };
    let calls = 0;
    const fetch: CatalogFetch = async () => {
      calls++;
      return body;
    };
    const check = await runStartupCheck(repo, null, { fetch, now: () => 1_000 } satisfies OpenCodeSeedOptions);
    assert.ok(!("problem" in check), JSON.stringify(check));
    // The seed fetched once and persisted a fresh cache with the parsed free model.
    assert.equal(calls, 1, "the seed fetched the catalog");
    const cache = readOpencodeCache(repo);
    assert.equal(cache.fetchedAt, 1_000, "the seed persisted the fetched cache");
    assert.equal(cache.models["opencode/deepseek-v4.1-flash-free"]?.free, true);
    // A second startup reuses that now-fresh cache: the seed never refetches over the network.
    const again = await runStartupCheck(repo, null, { fetch, now: () => 2_000 } satisfies OpenCodeSeedOptions);
    assert.ok(!("problem" in again), JSON.stringify(again));
    assert.equal(calls, 1, "a fresh cache is reused, not refetched");
  });
});

test("a fresh on-disk catalog cache is reused without fetching (offline boot)", async () => {
  const repo = makeRepo();
  await initProject(repo, "startup gate opencode reuse");
  const opencodeBin = tmpdir("startup-opencode-reuse-");
  writeScript(path.join(opencodeBin, "opencode"), "exit 0");
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
    const cfg = readJson(file) as Record<string, unknown>;
    cfg.backends = { opencode: { bin: path.join(opencodeBin, "opencode") } };
    cfg.backend = "opencode"; cfg.model = "deepseek-v4.1-flash-free";
    fs.writeFileSync(file, JSON.stringify(cfg));
    writeOpencodeCache(repo); // a fresh cache, so the seed reuses it instead of fetching
    const before = fs.readFileSync(opencodeModelsPath(repo), "utf8");
    const fetch: CatalogFetch = async () => {
      throw new Error("should not fetch");
    };
    const check = await runStartupCheck(repo, null, { fetch, now: () => 1_000 } satisfies OpenCodeSeedOptions);
    assert.ok(!("problem" in check), JSON.stringify(check));
    assert.equal(fs.readFileSync(opencodeModelsPath(repo), "utf8"), before, "a fresh cache is reused, untouched");
  });
});

test("a team workspace without tumwater.json names the owning team root instead of not-initialized", async () => {
  const { root, slot } = teamWorkspace();
  assert.equal(await repoNotReady(slot), teamWorkspaceMessage(root));
  assert.equal(await repoNotReady(makeRepo()), NOT_INITIALIZED_MESSAGE);
});

/** The shared setup of the periodic-refresh tests: an opencode-routed config and a settle. */
function opencodeRefreshSetup() {
  const root = makeRepo();
  const bin = path.join(tmpdir(), "opencode");
  writeScript(bin, "exit 0");
  const config = structuredClone(defaultConfig());
  config.backends = { opencode: { bin } };
  config.review = { ...config.review, enabled: true, backend: "opencode", model: "deepseek-v4.1-flash-free" };
  const warnings: string[] = [];
  const settle = () => new Promise((r) => setImmediate(r));
  return { root, config, warnings, settle };
}

test("newOpencodeCatalogRefresh refetches a missing or stale catalog at most once per retry interval, only while opencode is routed", async () => {
  const { root, config, warnings, settle } = opencodeRefreshSetup();
  let t = 1_000;
  let calls = 0;
  const fetch = (async () => {
    calls++;
    return { opencode: { models: { "deepseek-v4.1-flash-free": { cost: { input: 0, output: 0 } } } } };
  }) as CatalogFetch;
  const r = newOpencodeCatalogRefresh(root, { fetch, now: () => t }, (m) => warnings.push(m));
  r.poll(config);
  await settle();
  assert.equal(calls, 0, "the retry throttle holds the first polls after boot");
  t = 1_000 + OPENCODE_CATALOG_RETRY_MS;
  r.poll(config);
  await settle();
  assert.equal(calls, 1);
  assert.equal(readOpencodeCache(root).fetchedAt, t);
  t += OPENCODE_CATALOG_RETRY_MS;
  r.poll(config);
  await settle();
  assert.equal(calls, 1, "a fresh cache is not refetched");
  t = readOpencodeCache(root).fetchedAt + 24 * 60 * 60 * 1000;
  r.poll(structuredClone(defaultConfig()));
  await settle();
  assert.equal(calls, 1, "opencode is not routed");
  r.poll(config);
  await settle();
  assert.equal(calls, 2);
});

test("a failing periodic catalog refresh warns once per retry interval and never throws out of poll", async () => {
  const { root, config, warnings, settle } = opencodeRefreshSetup();
  const fetch = (async () => {
    throw new Error("offline");
  }) as CatalogFetch;
  let t = 1_000;
  const r = newOpencodeCatalogRefresh(root, { fetch, now: () => t }, (m) => warnings.push(m));
  t = 1_000 + OPENCODE_CATALOG_RETRY_MS;
  assert.doesNotThrow(() => r.poll(config));
  await settle();
  r.poll(config);
  await settle();
  assert.equal(warnings.filter((m) => m.startsWith("open code model catalog fetch failed")).length, 1);
});

test("the startup seed logs a warning when the catalog fetch fails or the cache cannot be saved", async () => {
  const opencodeBin = tmpdir("startup-opencode-warn-");
  writeScript(path.join(opencodeBin, "opencode"), "exit 0");
  registerAgentBackend({
    id: "opencode",
    label: "opencode",
    defaultBin: "opencode",
    binEnv: "TUMWATER_OPENCODE_BIN",
    resolveBin: () => ({ bin: path.join(opencodeBin, "opencode"), source: "config" }),
    invocation: () => ({ args: [], env: process.env }),
    translator: () => ({ translate: (line) => [line] }),
    classifyExit: () => ({}),
  });
  const opencodeRepo = async (name: string): Promise<string> => {
    const repo = makeRepo();
    await initProject(repo, name);
    const file = path.join(repo, "tumwater.json");
    const cfg = readJson(file) as Record<string, unknown>;
    cfg.backends = { opencode: { bin: path.join(opencodeBin, "opencode") } };
    cfg.backend = "opencode";
    cfg.model = "deepseek-v4.1-flash-free";
    fs.writeFileSync(file, JSON.stringify(cfg));
    return repo;
  };
  await withPi("exit 0", async () => {
    const repoA = await opencodeRepo("startup seed warn fetch");
    const failing = await runStartupCheck(repoA, null, {
      fetch: async () => {
        throw new Error("offline");
      },
      now: () => 1_000,
    });
    assert.ok(!("problem" in failing), JSON.stringify(failing));
    const fetchWarning = "open code model catalog fetch failed; keeping the cached copy";
    const countFetch = (): number => warningMessages(repoA).filter((m) => m.includes(fetchWarning)).length;
    assert.equal(countFetch(), 1);
    await runStartupCheck(repoA, null, { fetch: async () => { throw new Error("offline"); }, now: () => 2_000 });
    assert.equal(countFetch(), 1, "the per-root guard keeps a second startup from warning again");

    const repoB = await opencodeRepo("startup seed warn save");
    const body = {
      opencode: { models: { "deepseek-v4.1-flash-free": { cost: { input: 0, output: 0 }, limit: { context: 200000 } } } },
    };
    const restore = failRenameSyncOn(opencodeModelsPath(repoB), "disk full");
    try {
      const saved = await runStartupCheck(repoB, null, { fetch: async () => body, now: () => 1_000 });
      assert.ok(!("problem" in saved), JSON.stringify(saved));
    } finally {
      restore();
    }
    const saveWarnings = warningMessages(repoB).filter((m) => m.startsWith("could not save the open code model catalog: "));
    assert.equal(saveWarnings.length, 1);
    assert.ok(saveWarnings[0]?.includes("disk full"), String(saveWarnings[0]));
  });
});
