import test from "node:test";
import assert from "node:assert/strict";
import { readSlotsState } from "../src/git/slots-state.js";
import { collectRoleRows } from "../src/status/status-roles.js";
import { initProject } from "../src/init/init.js";
import { makeRepo, tmpdir, writeConfig } from "./fixtures/repo-fixtures.js";
import { loadConfig } from "../src/config/config.js";
import { LOCAL_FREE_MODELS_JSON, writeModelsFile } from "./fixtures/models-fixtures.js";
import { freshRunnerState, saveRunnerState } from "../src/runner/runner-state.js";

// The roles collector builds the per-role rows from the shared reads (config, slots) and the
// pinned now; this is the small per-domain test for status-roles.ts (the bulk of the row
// behavior is covered through snapshot() in status-data-models.test.ts).
test("collectRoleRows builds one row per role id with the custom flag", async () => {
  const repo = makeRepo();
  await initProject(repo, "roles collector");
  writeConfig(repo, {});
  const cfg = loadConfig(repo);
  const modelsFile = writeModelsFile(tmpdir("status-roles-"), LOCAL_FREE_MODELS_JSON);
  const rows = collectRoleRows(repo, cfg, Date.now(), readSlotsState(repo).slots, modelsFile, new Set());
  assert.ok(rows.length >= 3, "one row per enabled role");
  assert.ok(rows.every((r) => !r.custom), "built-in roles are not custom");
  assert.ok(rows.some((r) => r.role === "feature"));
  // No leases or pins in a fresh project: no slot on any row.
  assert.ok(rows.every((r) => r.slot === undefined));
});

// BUGS.md 2026-10-23: a surplus runner (an index above `instances`) was hidden the moment it
// was neither running, queued, holding a claim, nor owing work — so a breaker-paused or
// error-streak runner showed no row and no alert, and the operator could not see or resume it
// from the dashboards. The fixed collector keeps a surplus runner's row while the pause marker
// stops it or its error streak is at the warning threshold.
test("collectRoleRows keeps a surplus runner's row while paused or on an error streak", async () => {
  const repo = makeRepo();
  await initProject(repo, "roles collector surplus");
  writeConfig(repo, {
    roles: {
      feature: { enabled: true, instances: 2 },
      bugfix: { enabled: true, instances: 2 },
    },
  });
  const cfg = loadConfig(repo);
  const modelsFile = writeModelsFile(tmpdir("status-roles-surplus-"), LOCAL_FREE_MODELS_JSON);
  const slots = readSlotsState(repo).slots;
  const empty = new Set<string>();
  // feature-3 sits above the configured 2 instances, with a clean state file.
  saveRunnerState(repo, freshRunnerState("feature-3"));
  let rows = collectRoleRows(repo, cfg, Date.now(), slots, modelsFile, empty);
  assert.ok(
    !rows.some((r) => r.role === "feature-3"),
    "an idle surplus runner with no streak still gets no row",
  );
  // The pause marker alone keeps the row (no streak needed): resume it from the dashboard.
  rows = collectRoleRows(repo, cfg, Date.now(), slots, modelsFile, new Set(["feature-3"]));
  assert.ok(rows.some((r) => r.role === "feature-3"), "a paused surplus runner keeps its row");
  // An error streak at the warning threshold keeps the row even while not paused.
  saveRunnerState(repo, { ...freshRunnerState("feature-3"), consecutiveErrors: 10 });
  rows = collectRoleRows(repo, cfg, Date.now(), slots, modelsFile, empty);
  assert.ok(rows.some((r) => r.role === "feature-3"), "an error-streak surplus runner keeps its row");
  // A quiet-kill streak at the give-up threshold keeps the row too — the other half of
  // onErrorStreak, the exact condition the failing-run alert keys on (status-model.ts).
  saveRunnerState(repo, {
    ...freshRunnerState("feature-3"),
    lastResult: "quiet_killed",
    quietKillStreak: 3,
  });
  rows = collectRoleRows(repo, cfg, Date.now(), slots, modelsFile, empty);
  assert.ok(rows.some((r) => r.role === "feature-3"), "a quiet-kill surplus runner keeps its row");
});

// Part 3c/… — the peak-ctx share denominator: a role whose resolved seam declares a window
// carries it on the row (so the status table and the dashboard drawer can divide a peak by it),
// and a role whose seam cannot name a window carries no key, leaving the row byte-identical.
test("collectRoleRows carries a declared window and omits an unknown one", async () => {
  const windowed = writeModelsFile(
    tmpdir("status-roles-window-"),
    JSON.stringify({
      providers: { local: { models: [{ id: "big", contextWindow: 262144 }] } },
    }),
  );
  const repo = makeRepo();
  await initProject(repo, "roles collector window");
  writeConfig(repo, { provider: "local", model: "big" });
  const cfg = loadConfig(repo);
  const rows = collectRoleRows(repo, cfg, Date.now(), readSlotsState(repo).slots, windowed, new Set());
  assert.equal(rows.find((r) => r.role === "feature")?.contextWindow, 262144);

  // A claude seam has no catalog of windows here — the row must omit the key entirely.
  const repo2 = makeRepo();
  await initProject(repo2, "roles collector windowless");
  writeConfig(repo2, { backend: "claude", model: "claude-sonnet-5-5" });
  const cfg2 = loadConfig(repo2);
  const rows2 = collectRoleRows(repo2, cfg2, Date.now(), readSlotsState(repo2).slots, windowed, new Set());
  const feature = rows2.find((r) => r.role === "feature");
  assert.equal("contextWindow" in feature!, false, "a claude seam row carries no contextWindow");
  assert.equal(feature?.contextWindow, undefined);
});
