import test from "node:test";
import assert from "node:assert/strict";
import { collectBudget } from "../src/status/status-budget.js";
import { snapshot } from "../src/status/status-data.js";
import { readOrchestratorInfo, writeOrchestratorInfo } from "../src/team/orchestrator-info.js";
import { initProject } from "../src/init/init.js";
import { makeRepo, tmpdir, writeConfig } from "./fixtures/repo-fixtures.js";
import { loadConfig } from "../src/config/config.js";
import { spentRunnerState } from "./fixtures/runner-fixtures.js";
import { saveRunnerState } from "../src/runner/runner-state.js";
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
