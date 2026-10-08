// The status-data suite: snapshot() — what the status collector reads from disk and the
// derived fleet fields it publishes to both dashboards. Split out of the former
// status.test.ts, which had grown into the tests of five modules; the display model's tests
// live in status-model.test.ts, the rendered table's in status-render.test.ts, the payload
// contract's in status-payload.test.ts, and the `status` CLI's in cli.test.ts.

import { spawnSync } from "node:child_process";
import { readJson } from "./helpers/json-read.js";
import { backdate } from "./helpers/backdate.js";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { snapshot } from "../src/status/status-data.js";
import { queueFileStamp } from "../src/files/file-queue.js";
import { quietHoursStatus } from "../src/scheduling/quiet-hours.js";
import { statusPayload } from "../src/ui/status-payload.js";
import { quietBadge } from "../src/ui/badges.js";
import { initProject } from "../src/init/init.js";
import { mainSha, makeRepo, tmpdir, writeConfig } from "./fixtures/repo-fixtures.js";
import { ensureParentDir } from "../src/files/files.js";
import { loadConfig, saveConfig } from "../src/config/config.js";
import { MODELS_JSON } from "./models-fixtures.js";
import { allRoleIds } from "../src/roles/roles.js";
import { freshLoopState, saveLoopState } from "../src/loop/loop-state.js";
import { withCountedReads } from "./helpers/fs-faults.js";
import { writeEvents, writeOrchestratorMarker } from "./log-fixtures.js";
import { projectCapHit, recordDailyCost } from "../src/budget/budget.js";
import { renderStatus } from "../src/ui/status-render.js";
import { landQueueDir, landingStatePath, orchestratorStatePath, pausedPath } from "../src/paths.js";
import { writeJsonFile } from "../src/files/json-files.js";
import { dequeuePrompt, enqueueRolePrompt, queuedRolePrompts } from "../src/inbox/inbox.js";
import { submitPrompt } from "../src/inbox/inbox-submit.js";
import { enqueueLanding, queuedLandingFiles } from "../src/landing/landing-queue.js";
import { pauseFleet, pauseRole, resumeFleet } from "../src/fleet/fleet-state.js";

// Quiet hours 2/2 (plans: "Quiet hours … part 2/2, observability"): the snapshot carries the
// configured window and the in-window flag — present only while the value parses to a real
// window, so a schedule the gate is not holding is never advertised — and the payload ships
// the same fields with the header badge preformatted.
test("snapshot carries the quiet-hours window when configured and nothing when not", async () => {
  const repo = makeRepo();
  await initProject(repo, "test project");

  const unset = snapshot(repo);
  assert.equal(unset.quietHours, undefined);
  assert.equal(unset.inQuietHours, false);

  writeConfig(repo, { quietHours: "23:00-07:00" });
  const set = snapshot(repo);
  assert.equal(set.quietHours, "23:00-07:00");
  // The flag is the gate's own predicate (inQuietHours), evaluated for the poll's clock.
  assert.equal(set.inQuietHours, quietHoursStatus("23:00-07:00", new Date()).inWindow);
  // The payload's badge is the snapshot's fields through quietBadge — agreeing with the
  // header whatever the wall clock reads (this suite can run inside or outside the window).
  assert.equal(
    (statusPayload(repo) as { quietBadge: string }).quietBadge,
    quietBadge(set.quietHours, set.inQuietHours),
  );

  // A malformed value degrades with the whole config — status/status-polls.ts's configForStatus
  // serves the last-known-good one, so the badge never flashes off on a single broken write.
  writeConfig(repo, { quietHours: "23:00" });
  const broken = snapshot(repo);
  assert.equal(broken.quietHours, "23:00-07:00", "a broken config serves the last-known-good window");

  // From a cold start (no last-known-good), a broken config means the defaults: nothing.
  const cold = makeRepo();
  await initProject(cold, "test project");
  writeConfig(cold, { quietHours: "23:00" });
  const fromDefaults = snapshot(cold);
  assert.equal(fromDefaults.quietHours, undefined);
  assert.equal(fromDefaults.inQuietHours, false);
});

test("snapshot survives a broken tumwater.json and recovers when it is fixed", async () => {
  const repo = makeRepo();
  await initProject(repo, "test project");
  // Baseline: every catalog role enabled by default.
  assert.equal(snapshot(repo).loops.length, allRoleIds().length);

  // A valid config that disables one role becomes the last known-good one.
  const cfg = loadConfig(repo);
  cfg.roles.dry!.enabled = false;
  saveConfig(repo, cfg);
  let snap = snapshot(repo);
  assert.ok(!snap.loops.some((l) => l.role === "dry"));

  // The file breaks mid-edit (invalid JSON): observers must not throw.
  fs.writeFileSync(path.join(repo, "tumwater.json"), "{ still editing");
  snap = snapshot(repo);
  // The last known-good role set is kept: dry stays hidden and nothing crashes.
  assert.ok(!snap.loops.some((l) => l.role === "dry"));

  // A validation error (valid JSON, invalid value) is equally survivable.
  writeConfig(repo, { maxConcurrent: "six" });
  assert.ok(snapshot(repo).loops.length > 0);

  // Repair with a different valid config: the fresh load takes effect again.
  cfg.roles.dry!.enabled = true;
  cfg.roles.clean!.enabled = false;
  saveConfig(repo, cfg);
  snap = snapshot(repo);
  assert.ok(snap.loops.some((l) => l.role === "dry"));
  assert.ok(!snap.loops.some((l) => l.role === "clean"));
});

test("snapshot serves unchanged loop state from the stat-keyed cache without re-reading", async () => {
  const repo = makeRepo();
  await initProject(repo, "test project");
  const state = freshLoopState("clean");
  state.ticks = 3;
  saveLoopState(repo, state);
  assert.equal(snapshot(repo).loops.find((l) => l.role === "clean")!.ticks, 3); // populates the cache

  withCountedReads(
    (reads) => {
      const snap = snapshot(repo);
      assert.equal(snap.loops.find((l) => l.role === "clean")!.ticks, 3); // unchanged — served from cache
      assert.equal(reads(), 0); // no re-read of the state file at all
      // Each poll still gets its own objects: mutating one snapshot must not poison later ones.
      snap.loops.find((l) => l.role === "clean")!.ticks = 99;
      assert.equal(snapshot(repo).loops.find((l) => l.role === "clean")!.ticks, 3);
    },
    (file) => typeof file === "string" && file.endsWith(`${path.sep}state${path.sep}clean.json`),
  );

  // A same-size edit is picked up via mtime, not just size: ticks 3 → 4 keeps the file's byte
  // length identical, so utimes forces a distinct mtime regardless of filesystem timestamp
  // granularity (two fast writes could otherwise share one on coarse-grained filesystems).
  const bumped = freshLoopState("clean");
  bumped.ticks = 4;
  saveLoopState(repo, bumped);
  backdate(path.join(repo, ".tumwater", "state", "clean.json"), -5000);
  assert.equal(snapshot(repo).loops.find((l) => l.role === "clean")!.ticks, 4);
});

test("snapshot reads the orchestrator info file once per poll", async () => {
  const repo = makeRepo();
  await initProject(repo, "test project");
  // A live orchestrator's info file: both consumers (the pid column and the running flag)
  // have data to work with.
  writeOrchestratorMarker(repo, ["feature"]);
  assert.equal(snapshot(repo).running, true); // first read

  const reads = withCountedReads(
    () => {
      const snap = snapshot(repo);
      assert.equal(snap.pid, process.pid); // the info was read and used for the pid…
      assert.equal(snap.running, true); // …and for the liveness check from that same read
    },
    (file) =>
      typeof file === "string" && file.endsWith(`${path.sep}state${path.sep}orchestrator.json`),
  );
  assert.equal(reads, 1); // one read serves both — not two
});

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
  const clean = freshLoopState("clean");
  recordDailyCost(clean, 1.25, now.getTime());
  saveLoopState(repo, clean);
  const organize = freshLoopState("organize");
  recordDailyCost(organize, 0.75, now.getTime());
  saveLoopState(repo, organize);
  const dry = freshLoopState("dry");
  dry.dayStamp = "2000-01-01"; // not today's stamp → $0 today
  dry.dayCostUsd = 9;
  saveLoopState(repo, dry);

  let snap = snapshot(repo, undefined, now.getTime());
  // No provider/model is configured (pi's own default), so the fleet cannot be verified as
  // free — the dollar badge stays.
  assert.deepEqual(snap.budget, { spentUsd: 2, capUsd: 50, capHitAt: null, free: false, fallback: null, tiers: null });

  // Disabling the cap (0) keeps the budget object — spend is still reported and the badge
  // is the affordance for setting a cap again; only its display changes (`· no cap`).
  const cfg = loadConfig(repo);
  cfg.maxDailyCostUsd = 0;
  saveConfig(repo, cfg);
  snap = snapshot(repo, undefined, now.getTime());
  assert.deepEqual(snap.budget, { spentUsd: 2, capUsd: 0, capHitAt: null, free: false, fallback: null, tiers: null });
});

test("snapshot carries the cap-hit projection for the same spend the badge renders", async () => {
  const repo = makeRepo();
  await initProject(repo, "cap hit snapshot test"); // seeds tumwater.json with maxDailyCostUsd: 50

  // Spend recorded and snapshot read through the SAME pinned instant: $30 spent by local noon
  // is a burn the projection extrapolates to the cap at 20:00 the same day — the expected
  // value comes from projectCapHit at that one instant, so the two computations cannot race
  // each other's clocks (the review objection against comparing T1 and T2 Date.now() reads).
  const now = new Date(2026, 9, 1, 12, 0, 0).getTime(); // Oct 1, noon local
  const clean = freshLoopState("clean");
  recordDailyCost(clean, 30, now);
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
  // its live runner states carry, which no loop-state save has landed yet (BUGS.md 2026-09-30:
  // the gate charges run-by-run, the files persist at the saves).
  const clean = freshLoopState("clean");
  recordDailyCost(clean, 1);
  saveLoopState(repo, clean);

  // Not running: no published figure exists (the exit removes the info file), so the
  // persisted sum is the only figure there is — a stopped fleet's files are final.
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
  // for the fleet.
  writeOrchestratorMarker(repo, ["clean"], { pid: 2_000_000_000, budget: { spentUsd: 60, capUsd: 50 } }); // beyond any pid space
  assert.equal(snapshot(repo).running, false, "a dead pid is not a running orchestrator");
  assert.equal(snapshot(repo).budget.spentUsd, 1);
});

// The free-fleet case (BUGS.md: budget badge on local LLM fleets): when every model the
// fleet could use resolves to an unpriced or zero-cost entry in pi's models.json, spend can
// never accumulate against the cap and the badge data carries `free` so both dashboards read n/a.
// The per-role cap's observer side (PLANS.md, part 2/2): the snapshot lists the roles the
// gate actually holds — roleCapPaused against the last-known-good config's caps, the director
// exempt like the scheduler's gate.
test("snapshot lists the roles held by their own per-role cap in capPaused", async () => {
  const repo = makeRepo();
  await initProject(repo, "cap paused snapshot test");
  const cfg = loadConfig(repo);
  cfg.maxDailyCostUsdPerRole = { clean: 1, dry: 5, director: 1 };
  saveConfig(repo, cfg);

  // clean is exactly at its cap (held); dry carries only yesterday's spend (a stale stamp
  // reads $0 today — the hold is a daily figure); the director is exempt like the gate.
  const clean = freshLoopState("clean");
  recordDailyCost(clean, 1);
  saveLoopState(repo, clean);
  const dry = freshLoopState("dry");
  dry.dayStamp = "2000-01-01";
  dry.dayCostUsd = 99;
  saveLoopState(repo, dry);
  const director = freshLoopState("director");
  recordDailyCost(director, 1);
  saveLoopState(repo, director);

  let snap = snapshot(repo);
  assert.deepEqual(snap.capPaused, ["clean"]);

  // A role with no cap entry is never held, however much it spent.
  const organize = freshLoopState("organize");
  recordDailyCost(organize, 99);
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

// The per-tier budget pause (part 5c/8): a role whose model tier resolved to no usable free
// pair while the cap is reached reads `budget paused`, per role — computed over the same
// resolution the scheduler's gate folds, demotions published by the running orchestrator
// included.
test("snapshot lists the roles whose budget tier resolved to pause in budgetPausedRoles", async () => {
  const repo = makeRepo();
  await initProject(repo, "budget paused snapshot test");
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

  const clean = freshLoopState("clean");
  recordDailyCost(clean, 1);
  saveLoopState(repo, clean);
  const plan = freshLoopState("plan");
  recordDailyCost(plan, 0.2);
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

test("snapshot marks the budget free when every fleet model is unpriced", async () => {
  const repo = makeRepo();
  await initProject(repo, "free fleet test");

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
  assert.equal(snap.budget?.free, true, "all-free fleet reads n/a");

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
  const dir = tmpdir("status-fallback-");
  fs.mkdirSync(dir, { recursive: true });
  const modelsFile = path.join(dir, "models.json");
  fs.writeFileSync(
    modelsFile,
    JSON.stringify({
      providers: {
        local: { models: [{ id: "local-free", cost: { input: 0, output: 0 } }] },
        paid: { models: [{ id: "gpt-x", cost: { input: 1, output: 2 } }] },
      },
    }),
  );

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
  // The fleet itself is still priced: the fallback does not make the budget n/a, it only says
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
  // (A child that has exited and been reaped is a pid that is not alive — fleet-state.test.ts.)
  writeJsonFile(orchestratorStatePath(repo), {
    pid: spawnSync("true").pid,
    startedAt: Date.now(),
    roles: ["clean"],
    fallbackDemoted: demoted,
  });
  assert.deepEqual(snapshot(repo, modelsFile).budget.fallback, { provider: "local", model: "local-free" });
});

test("snapshot carries queued director prompts as truncated previews, fresh per poll", async () => {
  const repo = makeRepo();
  await initProject(repo, "inbox snapshot test");
  assert.deepEqual(snapshot(repo).inboxPrompts, []); // no inbox dir yet

  submitPrompt(repo, "first prompt");
  submitPrompt(repo, "x".repeat(120)); // overlong: must come back as an ≤80-char preview
  let snap = snapshot(repo);
  assert.equal(snap.inbox, 2);
  assert.deepEqual(snap.inboxPrompts[0], "first prompt");
  // The same inbox pass pairs each preview with its queue-file basename (the
  // /api/prompt-cancel address): same order, same length, plain .md basenames only.
  assert.equal(snap.inboxFiles.length, snap.inboxPrompts.length);
  assert.ok(
    snap.inboxFiles.every((f) => f.endsWith(".md") && !f.includes("/") && !f.includes("\\")),
    `plain basenames: ${JSON.stringify(snap.inboxFiles)}`,
  );
  assert.notEqual(snap.inboxFiles[0], snap.inboxFiles[1]);
  // The same inbox pass pairs each preview with its enqueue stamp (the dashboard's Queued
  // tab shows the age from it): same order as inboxPrompts, parsed from the queue filename,
  // and null for a hand-placed name.
  assert.deepEqual(snap.inboxQueuedAt.length, snap.inboxPrompts.length);
  assert.deepEqual(snap.inboxQueuedAt[0], queueFileStamp(snap.inboxFiles[0]!));
  const preview = snap.inboxPrompts[1]!;
  assert.ok(preview.length <= 80 && preview.endsWith("…"), `preview truncated: ${JSON.stringify(preview)}`);

  // Fresh per poll like questions: a prompt enqueued between snapshots appears without a
  // restart, and the director consuming one drops it on the next.
  submitPrompt(repo, "third");
  assert.equal(snapshot(repo).inboxPrompts.length, 3);
  dequeuePrompt(repo);
  snap = snapshot(repo);
  assert.deepEqual(snap.inboxPrompts, [preview, "third"]);
});

// The `custom` flag marks user-defined loops (tumwater.json's customLoops) for the
// dashboards' asterisk. It is computed in snapshot from the same last-known-good config that
// produced the role list — so a transiently broken file keeps marking its customs rather than
// flipping them unmarked mid-poll.
test("snapshot rows carry the custom flag matching the config", async () => {
  const repo = makeRepo();
  await initProject(repo, "custom flag test");
  assert.ok(snapshot(repo).loops.every((l) => l.custom === false), "built-ins unmarked by default");

  const cfg = loadConfig(repo);
  cfg.customLoops.push({ name: "nightly", task: "do the nightly thing" });
  saveConfig(repo, cfg);
  let snap = snapshot(repo);
  assert.ok(snap.loops.some((l) => l.role === "nightly" && l.custom === true), "listed custom is marked");
  assert.ok(
    snap.loops.filter((l) => !l.custom).length >= allRoleIds().length,
    "every built-in stays unmarked",
  );

  // The file breaks mid-edit: the last known-good config keeps marking the custom.
  fs.writeFileSync(path.join(repo, "tumwater.json"), "{ still editing");
  snap = snapshot(repo);
  assert.ok(snap.loops.some((l) => l.role === "nightly" && l.custom === true), "broken file keeps last-known-good customs");
});

// Merge queue 4/5 — the snapshot's landQueue: depth from the queue files, and inFlight only
// when the 4/5 marker, a matching queue entry, and a live orchestrator all agree. The
// cross-check is the crash-safety pin: a stale marker alone (any crash ordering) never
// displays, and neither does a dead harness — no cleanup pass needed.
test("snapshot reports the land queue depth and the in-flight landing", async () => {
  const repo = makeRepo();
  await initProject(repo, "land queue snapshot");

  // Idle: depth 0, no inFlight, no entries (depth is unconditional, so JSON consumers see one
  // shape; the entries ride the same read pass and are absent when there is nothing to render —
  // the roleInboxPrompts discipline the land-queue drawer's plan names).
  let snap = snapshot(repo);
  assert.equal(snap.landQueue.depth, 0);
  assert.equal(snap.landQueue.inFlight, undefined);
  assert.equal(snap.landQueue.entries, undefined);

  // One queued entry (3/5's enqueue) lifts the depth — but a merely queued landing is not
  // in flight, and the queue file alone never names an in-flight record.
  enqueueLanding(repo, {
    role: "clean",
    sha: "abc1234",
    tick: 1,
    summary: "tidy something",
    enqueuedAt: Date.now(),
  });
  snap = snapshot(repo);
  assert.equal(snap.landQueue.depth, 1);
  assert.equal(snap.landQueue.inFlight, undefined, "queued, not landing: no inFlight yet");
  // The queued change is listed in execution order with the fields the drawer paints —
  // role, sha, tick, summary, enqueuedAt — without the entry's optional body/highFriction.
  assert.deepEqual(snap.landQueue.entries, [
    { role: "clean", sha: "abc1234", tick: 1, summary: "tidy something", enqueuedAt: snap.landQueue.entries![0]!.enqueuedAt },
  ]);

  // Two queued entries list oldest first, in the queue's filename order.
  enqueueLanding(repo, { role: "feature", sha: "def5678", tick: 2, summary: "add a thing", enqueuedAt: Date.now() });
  snap = snapshot(repo);
  assert.equal(snap.landQueue.depth, 2);
  assert.deepEqual(snap.landQueue.entries!.map((e) => e.role), ["clean", "feature"]);
  assert.deepEqual(
    snap.landQueue.entries!.map((e) => [e.sha, e.tick, e.summary, typeof e.enqueuedAt]),
    [["abc1234", 1, "tidy something", "number"], ["def5678", 2, "add a thing", "number"]],
  );
  // The entries are shallow copies, not the queue's own objects (the drawer never mutates
  // them, and nothing the queue file held beyond the listed fields leaks into the payload).
  assert.equal("body" in snap.landQueue.entries![0]!, false);
  assert.equal("highFriction" in snap.landQueue.entries![0]!, false);

  // Back to the single queued entry the rest of this test reasons about.
  const featureFile = queuedLandingFiles(repo).find((e) => e.entry.sha === "def5678")!.file;
  fs.rmSync(featureFile);

  // The 4/5 marker plus a live orchestrator plus the matching entry → in flight, with the
  // marker's identity (the dashboard's `landing <elapsed>` label reads startedAt from it).
  const startedAt = Date.now();
  writeOrchestratorMarker(repo, ["clean"]);
  const infoFile = orchestratorStatePath(repo);
  writeJsonFile(landingStatePath(repo), {
    role: "clean",
    sha: "abc1234",
    summary: "tidy something",
    startedAt,
  });
  snap = snapshot(repo);
  assert.equal(snap.running, true);
  assert.deepEqual(snap.landQueue.inFlight, { role: "clean", sha: "abc1234", summary: "tidy something", startedAt });

  // Crash orderings self-heal: a DEAD harness never displays in flight (the depth — queued
  // work that will drain on the next start — stays visible)…
  fs.rmSync(infoFile);
  snap = snapshot(repo);
  assert.equal(snap.running, false);
  assert.equal(snap.landQueue.depth, 1, "queued work is visible even while the fleet is down");
  assert.equal(snap.landQueue.inFlight, undefined, "a dead harness never shows a landing as in flight");

  // …and a marker whose sha no longer has a matching queue entry (a crash between the entry
  // drop and the marker removal) is stale — never displayed, even with a live orchestrator.
  writeOrchestratorMarker(repo, ["clean"]);
  writeJsonFile(landingStatePath(repo), {
    role: "clean",
    sha: "deadbee",
    summary: "stale marker",
    startedAt: Date.now(),
  });
  snap = snapshot(repo);
  assert.equal(snap.running, true);
  assert.equal(snap.landQueue.inFlight, undefined, "a marker with no matching queue entry never displays");

  // The queue drains and the marker is removed (the drain's own bookkeeping): back to idle,
  // with the entries gone too.
  fs.rmSync(path.join(landQueueDir(repo), fs.readdirSync(landQueueDir(repo))[0]!));
  fs.rmSync(landingStatePath(repo));
  snap = snapshot(repo);
  assert.equal(snap.landQueue.depth, 0);
  assert.equal(snap.landQueue.inFlight, undefined);
  assert.equal(snap.landQueue.entries, undefined);
});

// The marker carries one record per change the landing pipeline holds, and the snapshot
// cross-checks each against its still-queued entry: every row then reads its OWN change's
// state, and a change the merge is done with shows nothing (BUGS.md 2026-09-23 — a head-only
// marker kept a rejected head reading `landing` for a whole batch).
test("the marker is cross-checked per change and each row reads its own change's state", async () => {
  const repo = makeRepo();
  await initProject(repo, "batch marker snapshot");
  const t0 = Date.now() - 20 * 60_000;
  for (const [role, sha] of [["clean", "c1ea000"], ["bugfix", "b0f1000"], ["feature", "fea7000"], ["dry", "d1a0000"]]) {
    enqueueLanding(repo, { role: role!, sha: sha!, tick: 1, summary: `${role} work`, enqueuedAt: Date.now() });
  }
  writeOrchestratorMarker(repo, []);
  const betaStart = Date.now() - 90_000;
  writeJsonFile(landingStatePath(repo), {
    role: "bugfix",
    sha: "b0f1000",
    summary: "bugfix work",
    startedAt: betaStart,
    changes: [
      { role: "clean", sha: "c1ea000", summary: "clean work", status: "done", startedAt: t0 },
      { role: "bugfix", sha: "b0f1000", summary: "bugfix work", status: "landing", startedAt: betaStart },
      { role: "feature", sha: "fea7000", summary: "feature work", status: "vetted", startedAt: t0, stage: "merging" },
      { role: "dry", sha: "d1a0000", summary: "dry work", status: "landing", startedAt: t0, stage: "build-check" },
      // A record whose entry is gone (its outcome written, or a crash) is finished, whatever
      // its record last said: the cross-check drops it.
      { role: "plan", sha: "91a0000", summary: "plan work", status: "landing", startedAt: t0 },
    ],
  });
  let snap = snapshot(repo);
  assert.deepEqual(
    snap.landQueue.inFlight?.changes?.map((c) => c.role),
    ["clean", "bugfix", "feature", "dry"],
    "only the records whose entry is still queued survive the cross-check",
  );
  const text = renderStatus(repo, snap);
  assert.match(text, /^bugfix +landing 1m30s/m, "the change under review reads landing with its own elapsed");
  assert.match(text, /^feature +vetted, awaiting merge/m);
  assert.match(text, /^dry +landing 20m\S* · build check/m, "a second vet in flight reads its own elapsed and stage");
  assert.doesNotMatch(text, /^clean +landing/m, "a finished change keeps no live landing label");
  assert.match(text, /^clean +queued/m, "its row reads its own state again");
  assert.doesNotMatch(text, /^plan +landing/m, "a record with no queued entry never displays");

  // Only finished records left with a queued entry: nothing is in flight any more.
  for (const f of fs.readdirSync(landQueueDir(repo))) {
    if (!readJson<{ role: string }>(path.join(landQueueDir(repo), f)).role.startsWith("clean")) {
      fs.rmSync(path.join(landQueueDir(repo), f));
    }
  }
  snap = snapshot(repo);
  assert.equal(snap.landQueue.depth, 1);
  assert.equal(snap.landQueue.inFlight, undefined, "a marker whose live records are all done never displays");
  fs.rmSync(orchestratorStatePath(repo));
});

test("snapshot counts each role's own prompt queue and leaves the director to inbox", async () => {
  const repo = makeRepo();
  await initProject(repo, "roleInbox snapshot test");
  const one = enqueueRolePrompt(repo, "clean", "one");
  const two = enqueueRolePrompt(repo, "dry", "two");
  const three = enqueueRolePrompt(repo, "dry", "three");
  const snap = snapshot(repo);
  assert.equal(snap.roleInbox.clean, 1);
  assert.equal(snap.roleInbox.dry, 2);
  assert.ok(!("director" in snap.roleInbox), "the director's queue is the shared inbox, not roleInbox");
  assert.equal(snap.inbox, 0);
  // And it agrees with the queue files the CLI's --list reads.
  assert.deepEqual(queuedRolePrompts(repo, "dry"), ["two", "three"]);
  // Each queued prompt also carries its queue-file address (the /api/prompt-cancel target)
  // and the enqueue stamp parsed from that filename (null for a hand-placed name — see
  // file-queue.test.ts), execution order; roles with an empty queue are absent, like the
  // director.
  assert.deepEqual(snap.roleInboxPrompts.clean, [
    { file: path.basename(one), preview: "one", queuedAtMs: queueFileStamp(path.basename(one)), notBeforeMs: null },
  ]);
  assert.deepEqual(snap.roleInboxPrompts.dry, [
    { file: path.basename(two), preview: "two", queuedAtMs: queueFileStamp(path.basename(two)), notBeforeMs: null },
    { file: path.basename(three), preview: "three", queuedAtMs: queueFileStamp(path.basename(three)), notBeforeMs: null },
  ]);
  assert.ok(!("director" in snap.roleInboxPrompts), "the director's rows ride inboxFiles, not roleInboxPrompts");
});

// --- pausedUntil: the fleet marker's standing timed-pause deadline (PLANS.md 2026-09-25) ---

test("pausedUntil carries only a standing fleet timed-pause deadline", async () => {
  const repo = tmpdir();
  await initProject(repo, "paused until");
  assert.equal(snapshot(repo).pausedUntil, undefined, "no marker: absent");

  pauseFleet(repo);
  assert.equal(snapshot(repo).pausedUntil, undefined, "an indefinite fleet pause exposes no deadline");
  assert.equal((statusPayload(repo) as { pausedUntil?: number }).pausedUntil, undefined);

  const until = Date.now() + 30 * 60_000;
  pauseFleet(repo, until);
  assert.equal(snapshot(repo).pausedUntil, until);
  assert.equal((statusPayload(repo) as { pausedUntil?: number }).pausedUntil, until);

  // Role-only timed pauses are not fleet pauses: the fleet-scoped field stays absent.
  pauseRole(repo, "clean", until);
  assert.equal(snapshot(repo).pausedUntil, until, "the fleet marker still stands beside a role pause");

  fs.writeFileSync(pausedPath(repo), JSON.stringify({ at: Date.now() - 60_000, until: Date.now() - 30_000 }));
  assert.equal(snapshot(repo).pausedUntil, undefined, "an expired deadline reads as unpaused");
  // JSON.stringify drops the undefined field, so `status --json` carries it only while a
  // timed fleet pause stands.
  assert.ok(!("pausedUntil" in JSON.parse(JSON.stringify(statusPayload(repo)))));
});

// --- pauseReason: the standing fleet pause's operator reason (`pause --reason <text>`) ---

test("pauseReason carries only a standing fleet pause's operator reason", async () => {
  const repo = tmpdir();
  await initProject(repo, "pause reason");
  assert.equal(snapshot(repo).pauseReason, undefined, "no marker: absent");

  pauseFleet(repo);
  assert.equal(snapshot(repo).pauseReason, undefined, "an anonymous pause exposes no reason");
  assert.ok(!("pauseReason" in JSON.parse(JSON.stringify(statusPayload(repo)))), "the payload omits the key entirely");

  // A reason applies only on a fresh pause write: resume the anonymous pause first.
  resumeFleet(repo);
  pauseFleet(repo, undefined, "deploying to prod");
  assert.equal(snapshot(repo).pauseReason, "deploying to prod");
  assert.equal((statusPayload(repo) as { pauseReason?: string }).pauseReason, "deploying to prod");

  // A role-only pause is not a fleet pause: no fleet marker, no fleet reason.
  fs.rmSync(pausedPath(repo));
  pauseRole(repo, "clean");
  assert.equal(snapshot(repo).pauseReason, undefined);

  // An expired marker reads as unpaused — the reason cannot outlive its pause.
  fs.writeFileSync(pausedPath(repo), JSON.stringify({ at: Date.now() - 60_000, until: Date.now() - 30_000, reason: "stale why" }));
  assert.equal(snapshot(repo).pauseReason, undefined, "an expired pause's reason is absent");
});

test("snapshot carries mainCheck from the newest merge-scope build_check event", () => {
  const repo = makeRepo();
  // Absent before any merge-scope check has run (and with no events at all) — the JSON
  // payload omits the key entirely (no null placeholder, matching pausedUntil's idiom).
  assert.equal(snapshot(repo).mainCheck, undefined);
  assert.equal("mainCheck" in (statusPayload(repo) as object), false);

  const base = 1_700_000_000_000;
  // A landing check + the landed event after it: the check ran pre-merge, so the sha it
  // verified is the landing's own (PLANS.md "Retire the README freshness stamp") — the
  // landed event's `commit` field, exactly as writeLandingOutcome logs it. A gate-scope
  // check verifies a role worktree, not main — it never qualifies.
  writeEvents(repo, [
    { ts: base, loop: "lander", type: "build_check", scope: "gate", status: "passed" },
    {
      ts: base + 1000,
      loop: "lander",
      type: "build_check",
      scope: "landing",
      status: "passed",
      counts: { tests: 10, pass: 9, fail: 0, skipped: 1 },
    },
    { ts: base + 2000, loop: "lander", type: "landed", commit: "a".repeat(40) },
  ]);
  const landed = snapshot(repo).mainCheck;
  assert.ok(landed, "mainCheck present after a landing check");
  assert.equal(landed!.sha, "a".repeat(40));
  assert.equal(landed!.status, "passed");
  assert.deepEqual(landed!.counts, { tests: 10, pass: 9, fail: 0, skipped: 1 });
  assert.equal(landed!.at, base + 1000);
  // The JSON payload carries the raw block plus its preformatted badge (GUI parity with the
  // TUI header — the badge is built once in status-model, both surfaces render it).
  const payload = statusPayload(repo) as { mainCheck: unknown; mainCheckBadge: string; mainCounts: string };
  assert.deepEqual(payload.mainCheck, landed);
  assert.match(payload.mainCheckBadge, / · main a{8}: green · 9\/10 \(1 skipped\)/);
  // The sidebar's counts fragment ships preformatted too (badges.ts's mainCountsFragment) —
  // the GUI must not re-derive pass/tests from the raw counts and drift (BUGS.md 2026-09-30).
  assert.equal(payload.mainCounts, "9/10 (1 skipped)");

  // A newer baseline check with no landed event after it: the check ran ON main's tip, so the
  // sha is main's current head. A gate-scope check never displaces a merge-scope one.
  writeEvents(repo, [
    { ts: base, loop: "lander", type: "build_check", scope: "landing", status: "passed" },
    { ts: base + 2000, loop: "lander", type: "landed", commit: "a".repeat(40) },
    { ts: base + 5000, loop: "bugfix", type: "build_check", scope: "baseline", status: "failed" },
  ]);
  const baseline = snapshot(repo).mainCheck;
  assert.ok(baseline, "mainCheck present after a baseline check");
  assert.equal(baseline!.sha, mainSha(repo));
  assert.equal(baseline!.status, "failed");
  assert.equal(baseline!.counts, undefined);

  // A merge-scope check older than the default 200-event tail still badges the header: a
  // burst of quiet ticks logs hundreds of events without moving main, and a tail that ends
  // before the last check would make the badge vanish and reappear as ticks tick by. The
  // tail grows (MAIN_CHECK_SCAN_MAX_EVENTS, src/status/status-data.ts) until the check is inside it —
  // every event after the check is newer, so one window holds the whole derivation.
  const busy = makeRepo();
  writeEvents(busy, [
    { ts: base, loop: "lander", type: "build_check", scope: "landing", status: "passed" },
    { ts: base + 1000, loop: "lander", type: "landed", commit: "b".repeat(40) },
    ...Array.from({ length: 300 }, (_, i) => ({
      ts: base + 2000 + i,
      loop: "feature",
      type: "wake",
      reason: "quiet tick filler",
    })),
  ]);
  const deep = snapshot(busy).mainCheck;
  assert.ok(deep, "mainCheck survives a tail deeper than the default 200");
  assert.equal(deep!.sha, "b".repeat(40));
  assert.equal(deep!.status, "passed");

  // The growth cap holds: past MAIN_CHECK_SCAN_MAX_EVENTS the badge drops (the same graceful
  // loss log rotation imposes) instead of scanning without end on every poll.
  const capped = makeRepo();
  writeEvents(capped, [
    { ts: base, loop: "lander", type: "build_check", scope: "landing", status: "passed" },
    { ts: base + 1000, loop: "lander", type: "landed", commit: "c".repeat(40) },
    ...Array.from({ length: 6_000 }, (_, i) => ({
      ts: base + 2000 + i,
      loop: "feature",
      type: "wake",
      reason: "over-cap filler",
    })),
  ]);
  assert.equal(snapshot(capped).mainCheck, undefined, "past the scan cap the badge drops");
});

test("snapshot loop rows carry the resolved selector always and the seam tier only under a tier map", async () => {
  const repo = makeRepo();
  await initProject(repo, "test project");

  // A single string model: every row carries the resolved selector; the tier tag stays absent.
  writeConfig(repo, { model: "prov-a/model-a" });
  const plain = snapshot(repo);
  assert.equal(plain.loops[0]?.modelTier, undefined);
  assert.equal(plain.loops[0]?.model, "prov-a/model-a");

  // The payload ships the same field per row — the GUI renders it beside the loop name.
  const plainPayload = statusPayload(repo) as { loops: Array<{ role: string; modelTier?: string; model?: string }> };
  assert.equal(plainPayload.loops[0]?.model, "prov-a/model-a");
  assert.equal(plainPayload.loops[0]?.modelTier, undefined);

  // A tier map: each row carries its role's seam tier and that tier's resolved selector.
  writeConfig(repo, { model: { default: "prov-a/model-a", strong: "prov-s/model-s:high" } });
  const mapped = snapshot(repo);
  const plan = mapped.loops.find((l) => l.role === "plan");
  assert.equal(plan?.modelTier, "strong"); // the catalog assigns plan the strong tier
  assert.equal(plan?.model, "prov-s/model-s:high");
  const readme = mapped.loops.find((l) => l.role === "readme");
  assert.equal(readme?.modelTier, "small");
  assert.equal(readme?.model, "prov-a/model-a"); // an undeclared tier inherits default

  // The payload ships the same fields per row — the GUI renders them beside the loop name.
  const payload = statusPayload(repo) as { loops: Array<{ role: string; modelTier?: string; model?: string }> };
  const planRow = payload.loops.find((l) => l.role === "plan");
  assert.equal(planRow?.modelTier, "strong");
  assert.equal(planRow?.model, "prov-s/model-s:high");
});

// Model failure fallback, part 2/2: the snapshot's loop row carries the resolved fallback
// pair, the episode's start, and the tripping reason only while the episode is active (its
// ticks run off-model); a due probe runs the primary, so the field is absent then.
test("snapshot rows carry the active model-fallback episode", async () => {
  const repo = makeRepo();
  await initProject(repo, "model fallback rows");
  writeConfig(repo, { model: "prov-a/model-a", fallbackModel: { provider: "prov-fb", model: "model-fb" } });
  const now = Date.now();
  const state = freshLoopState("feature");
  state.modelFallback = {
    failures: 0,
    since: now - 60_000,
    probeAt: now + 300_000,
    cooldownMs: 300_000,
    reason: "Request timed out.",
  };
  saveLoopState(repo, state);
  const active = snapshot(repo, undefined, now).loops.find((l) => l.role === "feature");
  assert.deepEqual(active?.fallback, {
    provider: "prov-fb",
    model: "model-fb",
    since: now - 60_000,
    reason: "Request timed out.",
  });
  // The payload ships the same field for the dashboard row tag.
  const payload = statusPayload(repo, now) as { loops: Array<{ role: string; fallback?: unknown }> };
  assert.deepEqual(payload.loops.find((l) => l.role === "feature")?.fallback, active?.fallback);

  // Probe due: this tick runs the primary, so the row stops naming the fallback.
  state.modelFallback.probeAt = now - 1;
  saveLoopState(repo, state);
  assert.equal(snapshot(repo, undefined, now).loops.find((l) => l.role === "feature")?.fallback, undefined);

  // No fallback configured: an active episode cannot advertise a pair.
  writeConfig(repo, { model: "prov-a/model-a" });
  state.modelFallback.probeAt = now + 300_000;
  saveLoopState(repo, state);
  assert.equal(snapshot(repo, undefined, now).loops.find((l) => l.role === "feature")?.fallback, undefined);
});

// Part 4/4: the snapshot carries the running orchestrator's published disk state, and only
// while it runs — a stale block beside a dead pid speaks for no fleet.
test("snapshot carries the running orchestrator's published disk state", async () => {
  const repo = makeRepo();
  await initProject(repo, "published disk test");
  const disk = { freeGB: 8.2, holdGB: 10, reclaimGB: 40, held: true };
  writeJsonFile(orchestratorStatePath(repo), { pid: process.pid, startedAt: Date.now(), roles: [], disk });
  assert.deepEqual(snapshot(repo).disk, disk);
  writeJsonFile(orchestratorStatePath(repo), { pid: 2_000_000_000, startedAt: Date.now(), roles: [], disk });
  assert.equal(snapshot(repo).running, false, "a dead pid is not a running orchestrator");
  assert.equal(snapshot(repo).disk, undefined);
});
