import test from "node:test";
import fs from "node:fs";
import assert from "node:assert/strict";
import { collectBudget } from "../src/status/status-budget.js";
import { snapshot } from "../src/status/status-data.js";
import { readOrchestratorInfo, writeOrchestratorInfo } from "../src/team/orchestrator-info.js";
import { initProject } from "../src/init/init.js";
import { makeRepo, tmpdir, writeConfig } from "./fixtures/repo-fixtures.js";
import { opencodeModelsPath } from "../src/paths.js";
import { loadConfig } from "../src/config/config.js";
import { spentRunnerState } from "./fixtures/runner-fixtures.js";
import { saveRunnerState } from "../src/runner/runner-state.js";
import { writeAccount } from "../src/agent/subscription-account.js";
import { writeClaudeAccount } from "../src/agent/claude/claude-account.js";
import { LOCAL_FREE_MODELS_JSON, writeModelsFile, writeOpencodeCache } from "./fixtures/models-fixtures.js";

// The budget collector folds the spend/billing block from the shared reads (config, rows,
// roles, running, info, models path) and one pinned now; this is the small per-domain test
// for status-budget.ts (the bulk is covered through snapshot() in status-data-budget.test.ts).
test("collectBudget aggregates the daily spend and drives the pause sets", async () => {
  const repo = makeRepo();
  await initProject(repo, "budget collector");
  writeConfig(repo, { maxDailyCostUsd: 10 });
  const cfg = loadConfig(repo);
  const modelsFile = writeModelsFile(tmpdir("status-budget-"), LOCAL_FREE_MODELS_JSON);
  const now = new Date(2026, 9, 1, 12, 0, 0).getTime();
  saveRunnerState(repo, spentRunnerState("clean", 1.25, now));
  const snap = snapshot(repo, modelsFile, now);
  const got = collectBudget(
    repo,
    cfg,
    snap.roles,
    snap.roles.map((l) => l.role),
    false,
    readOrchestratorInfo(repo),
    modelsFile,
    now,
  );
  assert.equal(got.budget.spentUsd, 1.25);
  assert.equal(got.budget.capUsd, 10);
  assert.deepEqual(got.capPaused, [], "spend is under every per-role cap");
  assert.deepEqual(got.budgetPausedRoles, [], "no tier resolved to pause under an open gate");
});

test("collectBudget prices an opencode-free team free (part 6b/7)", async () => {
  // The status badge's free-ness read (budget.free) judges opencode seams by the cached
  // models-dev catalog that collectBudget reads and threads into teamModelsFree: an
  // all-opencode-free team (every tier routed to the catalog-free gateway model) reads free.
  const repo = makeRepo();
  await initProject(repo, "status opencode free");
  writeOpencodeCache(repo);
  writeConfig(repo, { backend: "opencode", model: "deepseek-v4.1-flash-free" });
  const cfg = loadConfig(repo);
  const modelsFile = writeModelsFile(tmpdir("status-opencode-"), LOCAL_FREE_MODELS_JSON);
  const now = new Date(2026, 9, 1, 12, 0, 0).getTime();
  const snap = snapshot(repo, modelsFile, now);
  const got = collectBudget(
    repo,
    cfg,
    snap.roles,
    snap.roles.map((l) => l.role),
    false,
    readOrchestratorInfo(repo),
    modelsFile,
    now,
  );
  assert.equal(got.budget.free, true, "every tier on a catalog-free opencode model");
});

test("a foreign entry in the opencode catalog cache leaves collectBudget standing, read as not free", async () => {
  const repo = makeRepo();
  await initProject(repo, "status opencode foreign");
  writeOpencodeCache(repo);
  fs.writeFileSync(
    opencodeModelsPath(repo),
    JSON.stringify({ fetchedAt: Date.now(), models: { "opencode/deepseek-v4.1-flash-free": null } }),
  );
  writeConfig(repo, { backend: "opencode", model: "deepseek-v4.1-flash-free" });
  const cfg = loadConfig(repo);
  const modelsFile = writeModelsFile(tmpdir("status-opencode-"), LOCAL_FREE_MODELS_JSON);
  const now = new Date(2026, 9, 1, 12, 0, 0).getTime();
  const snap = snapshot(repo, modelsFile, now);
  const got = collectBudget(
    repo,
    cfg,
    snap.roles,
    snap.roles.map((l) => l.role),
    false,
    readOrchestratorInfo(repo),
    modelsFile,
    now,
  );
  assert.equal(got.budget.free, false, "a dropped entry is an unknown model, not free");
});

// The per-backend subscription window blocks (part 3a/9): one entry per subscription backend
// the enabled seams route to, ordered most-constrained-first, each with backend/label/windows/
// primary/heldUntil — the shared model the 3b–3e display parts consume.
test("collectBudget carries one subscription-window block per subscription backend in use (part 3a/9)", async () => {
  const repo = makeRepo();
  await initProject(repo, "status multi-backend windows");
  // All default roles route to claude; the feature role rides the test-only `sub` backend.
  writeConfig(repo, { backend: "claude", model: "claude-sonnet-5-5" });
  const cfg = loadConfig(repo);
  cfg.roles.feature = { enabled: true, backend: "sub", model: "sub-astra" };
  const modelsFile = writeModelsFile(tmpdir("status-multibackend-"), LOCAL_FREE_MODELS_JSON);
  const now = new Date(2026, 9, 1, 12, 0, 0).getTime();
  const resetsAt = now + 3_600_000;
  // sub's rejected window is the tighter constraint; claude's is only a warning.
  writeAccount(repo, "sub", {
    billing: "subscription",
    observedAt: now,
    windows: { five_hour: { status: "rejected", resetsAt, utilization: 1, observedAt: now } },
  });
  writeClaudeAccount(repo, {
    billing: "subscription",
    observedAt: now,
    windows: { five_hour: { status: "allowed_warning", resetsAt, utilization: 0.64, observedAt: now } },
  });
  const snap = snapshot(repo, modelsFile, now);
  const got = collectBudget(
    repo,
    cfg,
    snap.roles,
    snap.roles.map((l) => l.role),
    false,
    readOrchestratorInfo(repo),
    modelsFile,
    now,
  );
  assert.equal(got.subscriptionWindows.length, 2, "one block per subscription backend in use");
  assert.deepEqual(
    got.subscriptionWindows.map((b) => b.backend),
    ["sub", "claude"],
    "blocks order most-constrained-first, primary tie broken by backend",
  );
  const sub = got.subscriptionWindows[0]!;
  assert.equal(sub.label, "Sub", "the block labels the backend by its display name");
  assert.equal(sub.primary.status, "rejected");
  assert.equal(sub.heldUntil, resetsAt, "a rejected window reports the future hold");
  const claude = got.subscriptionWindows[1]!;
  assert.equal(claude.backend, "claude");
  assert.equal(claude.label, "Claude");
  assert.equal(claude.primary.utilization, 0.64);
  assert.equal(claude.heldUntil, null);
});

test("snapshot carries the orchestrator's chain block only while it is alive", async () => {
  const repo = makeRepo();
  await initProject(repo, "chain block");
  const modelsFile = writeModelsFile(tmpdir("status-chain-"), LOCAL_FREE_MODELS_JSON);
  const chain = { default: { pair: "local/small", step: 2, of: 2, reason: "window" as const } };
  writeOrchestratorInfo(repo, { pid: process.pid, startedAt: Date.now(), roles: ["feature"], chain });
  assert.deepEqual(snapshot(repo, modelsFile).chain, chain);
  writeOrchestratorInfo(repo, { pid: process.pid, startedAt: Date.now(), roles: ["feature"] });
  assert.equal("chain" in snapshot(repo, modelsFile), false, "no chain published, none shown");
  writeOrchestratorInfo(repo, { pid: 2 ** 22 + 7, startedAt: Date.now(), roles: ["feature"], chain });
  assert.equal(snapshot(repo, modelsFile).chain, undefined, "a dead orchestrator's chain is stale");
});
