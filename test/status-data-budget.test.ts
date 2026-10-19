// The budget facet of the status-data suite: snapshot()'s spend, cap, cap-hit projection,
// per-role cap and tier pauses, free-team reading, and the cost-n/a fallback model. Split by
// facet from one status-data test file; the core contract and poll cache live in
// status-data.test.ts.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { snapshot } from "../src/status/status-data.js";
import { initProject } from "../src/init/init.js";
import { makeRepo, tmpdir } from "./fixtures/repo-fixtures.js";
import { spentLoopState } from "./fixtures/runner-fixtures.js";
import { ensureParentDir } from "../src/files/files.js";
import { loadConfig, saveConfig } from "../src/config/config.js";
import { LOCAL_FREE_MODELS_JSON, MODELS_JSON, writeModelsFile } from "./fixtures/models-fixtures.js";
import { freshLoopState, saveLoopState } from "../src/runner/runner-state.js";
import { writeOrchestratorMarker } from "./fixtures/log-fixtures.js";
import { projectCapHit } from "../src/budget/budget.js";
import { renderStatus } from "../src/ui/status-render.js";
import { orchestratorStatePath } from "../src/paths.js";
import { writeJsonFile } from "../src/files/json-files.js";

test("snapshot carries the daily cost budget aggregated from persisted loop state", async () => {
  const repo = makeRepo();
  await initProject(repo, "budget snapshot test"); // seeds tumwater.json with maxDailyCostUsd: 50

  // The whole budget block is pinned to one instant — local noon today — through snapshot's
  // clock seam: the spend's day stamp, the burn-rate projection, and the expected values all
  // derive from the same `now`, so the assertions cannot race the snapshot's Date.now()
  // (elapsed-since-midnight enters the projection's rate, and noon is late enough in the day
  // that this $2-vs-$50 burn always projects past midnight — capHitAt null, deterministically).
  const now = new Date();
  now.setHours(12, 0, 0, 0);

  // Two loops spent in today's window; a third carries yesterday's spend (stale stamp) that
  // must not count toward today — the badge is a daily figure.
  const clean = spentLoopState("clean", 1.25, now.getTime());
  saveLoopState(repo, clean);
  const organize = spentLoopState("organize", 0.75, now.getTime());
  saveLoopState(repo, organize);
  const dry = freshLoopState("dedupe");
  dry.dayStamp = "2000-01-01"; // not today's stamp → $0 today
  dry.dayCostUsd = 9;
  saveLoopState(repo, dry);

  let snap = snapshot(repo, undefined, now.getTime());
  // No provider/model is configured (pi's own default), so the team cannot be verified as
  // free — the dollar badge stays.
  assert.deepEqual(snap.budget, { spentUsd: 2, capUsd: 50, capHitAt: null, free: false, backend: "pi", fallback: null, tiers: null });

  // Disabling the cap (0) keeps the budget object — spend is still reported and the badge
  // is the affordance for setting a cap again; only its display changes (`· no cap`).
  const cfg = loadConfig(repo);
  cfg.maxDailyCostUsd = 0;
  saveConfig(repo, cfg);
  snap = snapshot(repo, undefined, now.getTime());
  assert.deepEqual(snap.budget, { spentUsd: 2, capUsd: 0, capHitAt: null, free: false, backend: "pi", fallback: null, tiers: null });
});

test("snapshot carries the cap-hit projection for the same spend the badge renders", async () => {
  const repo = makeRepo();
  await initProject(repo, "cap hit snapshot test"); // seeds tumwater.json with maxDailyCostUsd: 50

  // Spend recorded and snapshot read through the SAME pinned instant: $30 spent by local noon
  // is a burn the projection extrapolates to the cap at 20:00 the same day — the expected
  // value comes from projectCapHit at that one instant, so the two computations cannot race
  // each other's clocks (the review objection against comparing T1 and T2 Date.now() reads).
  const now = new Date(2026, 9, 1, 12, 0, 0).getTime(); // Oct 1, noon local
  const clean = spentLoopState("clean", 30, now);
  saveLoopState(repo, clean);

  const snap = snapshot(repo, undefined, now);
  const expected = projectCapHit({ spentUsd: 30, capUsd: 50 }, now);
  assert.equal(expected, new Date(2026, 9, 1, 20, 0, 0).getTime(), "hand-checked: $30 by noon hits $50 at 20:00");
  assert.equal(snap.budget.capHitAt, expected);
  assert.equal(snap.budget.spentUsd, 30);

  // No spend, no forecast — the field stays null and the JSON payload carries the null.
  const idle = freshLoopState("clean");
  saveLoopState(repo, idle);
  assert.equal(snapshot(repo, undefined, now).budget.capHitAt, null);
});

test("snapshot prefers the running orchestrator's published budget over the persisted sum", async () => {
  const repo = makeRepo();
  await initProject(repo, "published budget test"); // seeds tumwater.json with maxDailyCostUsd: 50

  // One loop with $1 persisted. The scheduler's own gate figure is $60 — the in-flight charge
  // its live runner states carry, which no runner-state save has landed yet (BUGS.md 2026-09-30:
  // the gate charges run-by-run, the files persist at the saves).
  const clean = spentLoopState("clean", 1);
  saveLoopState(repo, clean);

  // Not running: no published figure exists (the exit removes the info file), so the
  // persisted sum is the only figure there is — a stopped team's files are final.
  let snap = snapshot(repo);
  assert.equal(snap.budget.spentUsd, 1);
  assert.equal(snap.budget.capUsd, 50);

  // A running orchestrator publishing $60: the snapshot shows the scheduler's number, and the
  // rendered table keeps its total row equal to the header badge (both read the same budget
  // block) while the per-loop cell still reads its persisted copy — the lag the publish
  // exists to expose, visible instead of misleading.
  writeOrchestratorMarker(repo, ["clean"], { budget: { spentUsd: 60, capUsd: 50 } });
  snap = snapshot(repo);
  assert.equal(snap.budget.spentUsd, 60);
  assert.equal(snap.budget.capUsd, 50);
  const text = renderStatus(repo, snap);
  assert.match(text, /· budget: \$60\.00\/\$50 today/); // the header badge
  assert.match(text, /\$1\.00/); // the per-loop today cell: the persisted copy
  // The total row agrees with the badge, not with the per-loop cells above it.
  const totalRow = text.split("\n").find((l) => l.trimStart().startsWith("total")) ?? "";
  assert.match(totalRow, /\$60\.00/);
  assert.doesNotMatch(totalRow, /\$1\.00/);

  // The publish rides the liveness check: a stale marker beside a dead pid must not speak
  // for the team.
  writeOrchestratorMarker(repo, ["clean"], { pid: 2_000_000_000, budget: { spentUsd: 60, capUsd: 50 } }); // beyond any pid space
  assert.equal(snapshot(repo).running, false, "a dead pid is not a running orchestrator");
  assert.equal(snapshot(repo).budget.spentUsd, 1);
});

// The free-team case (BUGS.md: budget badge on local LLM teams): when every model the
// team could use resolves to an unpriced or zero-cost entry in pi's models.json, spend can
// never accumulate against the cap and the badge data carries `free` so both dashboards read n/a.
// The per-role cap's observer side (PLANS.md, part 2/2): the snapshot lists the roles the
// gate actually holds — roleCapPaused against the last-known-good config's caps, the director
// exempt like the scheduler's gate.
test("snapshot lists the roles held by their own per-role cap in capPaused", async () => {
  const repo = makeRepo();
  await initProject(repo, "waiting: daily cap spent snapshot test");
  const cfg = loadConfig(repo);
  cfg.maxDailyCostUsdPerRole = { clean: 1, dedupe: 5, director: 1 };
  saveConfig(repo, cfg);

  // clean is exactly at its cap (held); dry carries only yesterday's spend (a stale stamp
  // reads $0 today — the hold is a daily figure); the director is exempt like the gate.
  const clean = spentLoopState("clean", 1);
  saveLoopState(repo, clean);
  const dry = freshLoopState("dedupe");
  dry.dayStamp = "2000-01-01";
  dry.dayCostUsd = 99;
  saveLoopState(repo, dry);
  const director = spentLoopState("director", 1);
  saveLoopState(repo, director);

  let snap = snapshot(repo);
  assert.deepEqual(snap.capPaused, ["clean"]);

  // A role with no cap entry is never held, however much it spent.
  const organize = spentLoopState("organize", 99);
  saveLoopState(repo, organize);
  snap = snapshot(repo);
  assert.deepEqual(snap.capPaused, ["clean"]);

  // No per-role caps configured at all: the field stays present and empty — the
  // pausedRoles shape, so consumers never test for the key.
  cfg.maxDailyCostUsdPerRole = {};
  saveConfig(repo, cfg);
  snap = snapshot(repo);
  assert.deepEqual(snap.capPaused, []);
});

// The gate groups instance loop ids under their base role and sums their spend
// (role-cap-gates.ts), so `capPaused` must list every instance whose base group crossed the
// cap, not only the instance whose own spend did — otherwise `feature-2` reads queued while
// the scheduler holds it beside `feature`.
test("snapshot resolves a per-role cap through the base role and its summed instance spend", async () => {
  const repo = makeRepo();
  await initProject(repo, "waiting: daily cap spent instances snapshot test");
  const cfg = loadConfig(repo);
  cfg.roles.feature = { ...(cfg.roles.feature ?? { enabled: true }), instances: 2 };
  cfg.maxDailyCostUsdPerRole = { feature: 1 };
  saveConfig(repo, cfg);

  // Neither instance is over alone ($0.60 each); together they cross the $1 base cap.
  for (const id of ["feature", "feature-2"]) {
    const st = spentLoopState(id, 0.6);
    saveLoopState(repo, st);
  }

  const snap = snapshot(repo);
  assert.deepEqual(snap.capPaused, ["feature", "feature-2"], "the summed base group holds both instances");
});

// The per-tier budget pause (part 5c/8): a role whose model tier resolved to no usable free
// pair while the cap is reached reads `waiting: budget spent`, per role — computed over the same
// resolution the scheduler's gate folds, demotions published by the running orchestrator
// included.
test("snapshot lists the roles whose budget tier resolved to pause in budgetPausedRoles", async () => {
  const repo = makeRepo();
  await initProject(repo, "waiting: budget spent snapshot test");
  const cfg = loadConfig(repo);
  cfg.maxDailyCostUsd = 1;
  cfg.provider = "paid";
  cfg.model = "gpt-x";
  // Only the small tier declares a fallback: default borrows it, strong (never borrows
  // small) pauses — with review off only the strong-tier plan role is held.
  cfg.fallback = { small: "free/qwen-free" };
  delete (cfg as { fallbackModel?: unknown }).fallbackModel;
  cfg.review = { ...cfg.review, enabled: false };
  saveConfig(repo, cfg);

  const clean = spentLoopState("clean", 1);
  saveLoopState(repo, clean);
  const plan = spentLoopState("plan", 0.2);
  saveLoopState(repo, plan);

  const models = path.join(tmpdir("budget-paused-models-"), "models.json");
  fs.mkdirSync(path.dirname(models), { recursive: true });
  fs.writeFileSync(models, MODELS_JSON);

  const snap = snapshot(repo, models);
  assert.ok(snap.budgetPausedRoles.includes("plan"), "the strong-tier role is held");
  assert.ok(!snap.budgetPausedRoles.includes("clean"), "the default-tier role borrows small's pair");
  assert.ok(!snap.budgetPausedRoles.includes("director"), "the director is exempt");

  // Under the cap nobody is held: the hold never stands under an open gate.
  cfg.maxDailyCostUsd = 100;
  saveConfig(repo, cfg);
  assert.deepEqual(snapshot(repo, models).budgetPausedRoles, []);

  // No fallback configured at all with the cap reached: every role's tier resolves to pause.
  cfg.maxDailyCostUsd = 1;
  delete (cfg as { fallback?: unknown }).fallback;
  saveConfig(repo, cfg);
  const snap2 = snapshot(repo, models);
  assert.ok(snap2.budgetPausedRoles.includes("plan"));
  assert.ok(snap2.budgetPausedRoles.includes("clean"));
});

test("snapshot marks the budget free when every team model is unpriced", async () => {
  const repo = makeRepo();
  await initProject(repo, "free team test");

  // A models.json with one unpriced local model and one paid API model.
  const dir = tmpdir("status-free-");
  fs.mkdirSync(dir, { recursive: true });
  const modelsFile = path.join(dir, "models.json");
  fs.writeFileSync(
    modelsFile,
    JSON.stringify({
      providers: {
        "lm-studio": { models: [{ id: "qwen3.8-27b" }] }, // no cost field — free
        paid: { models: [{ id: "gpt-x", cost: { input: 1, output: 2 } }] },
      },
    }),
  );

  const cfg = loadConfig(repo);
  cfg.provider = "lm-studio"; // every role and the reviewer fall back to this pair
  cfg.model = "qwen3.8-27b";
  saveConfig(repo, cfg);
  let snap = snapshot(repo, modelsFile);
  assert.equal(snap.budget?.free, true, "all-free team reads n/a");

  // One role on a paid model flips it back to the dollar badge.
  cfg.roles.clean!.provider = "paid";
  cfg.roles.clean!.model = "gpt-x";
  saveConfig(repo, cfg);
  snap = snapshot(repo, modelsFile);
  assert.equal(snap.budget?.free, false, "one paid model keeps the dollar figure");
});

// The cost n/a fallback model (plans/fallback-model.md): the snapshot carries it only when the
// budget gate could actually engage it, so the dashboards' three-valued gate matches the
// scheduler's — advertising a fallback the scheduler would refuse would be a lie about what
// happens when the cap is reached.
test("snapshot carries the fallback model only when pi prices it at zero", async () => {
  const repo = makeRepo();
  await initProject(repo, "fallback snapshot test");
  const modelsFile = writeModelsFile(tmpdir("status-fallback-"), LOCAL_FREE_MODELS_JSON);

  const cfg = loadConfig(repo);
  cfg.provider = "paid";
  cfg.model = "gpt-x";
  saveConfig(repo, cfg);
  assert.equal(snapshot(repo, modelsFile).budget.fallback, null, "none configured");

  cfg.fallbackModel = { provider: "local", model: "local-free" };
  saveConfig(repo, cfg);
  assert.deepEqual(
    snapshot(repo, modelsFile).budget.fallback,
    { provider: "local", model: "local-free" },
    "a zero-priced fallback is what the gate would engage",
  );
  // The team itself is still priced: the fallback does not make the budget n/a, it only says
  // what happens when the cap is reached.
  assert.equal(snapshot(repo, modelsFile).budget.free, false);

  cfg.fallbackModel = { provider: "paid", model: "gpt-x" };
  saveConfig(repo, cfg);
  assert.equal(snapshot(repo, modelsFile).budget.fallback, null, "a priced fallback is refused");

  // Free but not serving (BUGS.md 2026-09-20): while the running orchestrator's breaker holds
  // the pair demoted, the scheduler reads the gate as paused — so must the dashboards.
  cfg.fallbackModel = { provider: "local", model: "local-free" };
  saveConfig(repo, cfg);
  const demoted = { pair: "local/local-free", failures: 3, probeAt: Date.now() + 300_000 };
  ensureParentDir(orchestratorStatePath(repo));
  writeJsonFile(orchestratorStatePath(repo), {
    pid: process.pid,
    startedAt: Date.now(),
    roles: ["clean"],
    fallbackDemoted: demoted,
  });
  assert.equal(snapshot(repo, modelsFile).budget.fallback, null, "a demoted fallback is not advertised");
  // A dead orchestrator's leftover file says nothing about what runs now: the price decides.
  // (A child that has exited and been reaped is a pid that is not alive — team-state.test.ts.)
  writeJsonFile(orchestratorStatePath(repo), {
    pid: spawnSync("true").pid,
    startedAt: Date.now(),
    roles: ["clean"],
    fallbackDemoted: demoted,
  });
  assert.deepEqual(snapshot(repo, modelsFile).budget.fallback, { provider: "local", model: "local-free" });
});
