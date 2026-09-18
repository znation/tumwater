import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, saveConfig } from "../src/config.js";
import { dequeuePrompt, submitPrompt } from "../src/inbox.js";
import { allRoleIds } from "../src/roles.js";
import { snapshot } from "../src/ui/status.js";
import { loopPhase, renderStatus } from "../src/ui/status-render.js";
import { enqueueLanding } from "../src/land-queue.js";
import { freshLoopState, saveLoopState } from "../src/state.js";
import { recordDailyCost } from "../src/budget.js";
import { initProject } from "../src/init.js";
import { landingStatePath, landQueueDir } from "../src/paths.js";
import { writeJsonFile } from "../src/json-files.js";
import { makeRepo, tmpdir } from "./util.js";

test("snapshot and renderStatus cover all enabled loops", async () => {
  const repo = makeRepo();
  await initProject(repo, "test project");
  const state = freshLoopState("clean");
  state.ticks = 3;
  state.commits = 2;
  state.lastResult = "changed";
  state.lastSummary = "tidy something";
  saveLoopState(repo, state);

  const snap = snapshot(repo);
  assert.equal(snap.running, false);
  assert.ok(snap.loops.some((l) => l.role === "clean" && l.ticks === 3));
  const text = renderStatus(repo, snap);
  assert.match(text, /not running/);
  assert.match(text, /tidy something/);
  for (const role of ["organize", "coverage", "clean", "dry", "feature", "bugfix", "plan", "readme", "improve", "director"]) {
    assert.match(text, new RegExp(role));
  }
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
  fs.writeFileSync(path.join(repo, "tumwater.json"), JSON.stringify({ maxConcurrent: "six" }));
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

  let cleanReads = 0;
  const originalReadFileSync = fs.readFileSync.bind(fs);
  try {
    (fs as unknown as { readFileSync: unknown }).readFileSync = (...args: unknown[]) => {
      if (typeof args[0] === "string" && args[0].endsWith(`${path.sep}state${path.sep}clean.json`))
        cleanReads += 1;
      return (originalReadFileSync as (...a: unknown[]) => string)(...args);
    };
    const snap = snapshot(repo);
    assert.equal(snap.loops.find((l) => l.role === "clean")!.ticks, 3); // unchanged — served from cache
    assert.equal(cleanReads, 0); // no re-read of the state file at all
    // Each poll still gets its own objects: mutating one snapshot must not poison later ones.
    snap.loops.find((l) => l.role === "clean")!.ticks = 99;
    assert.equal(snapshot(repo).loops.find((l) => l.role === "clean")!.ticks, 3);
  } finally {
    (fs as unknown as { readFileSync: unknown }).readFileSync = originalReadFileSync;
  }

  // A same-size edit is picked up via mtime, not just size: ticks 3 → 4 keeps the file's byte
  // length identical, so utimes forces a distinct mtime regardless of filesystem timestamp
  // granularity (two fast writes could otherwise share one on coarse-grained filesystems).
  const bumped = freshLoopState("clean");
  bumped.ticks = 4;
  saveLoopState(repo, bumped);
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(repo, ".tumwater", "state", "clean.json"), t, t);
  assert.equal(snapshot(repo).loops.find((l) => l.role === "clean")!.ticks, 4);
});

test("snapshot reads the orchestrator info file once per poll", async () => {
  const repo = makeRepo();
  await initProject(repo, "test project");
  // A live orchestrator's info file: both consumers (the pid column and the running flag)
  // have data to work with.
  fs.mkdirSync(path.join(repo, ".tumwater", "state"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, ".tumwater", "state", "orchestrator.json"),
    JSON.stringify({ pid: process.pid, startedAt: Date.now(), roles: ["feature"] }),
  );
  assert.equal(snapshot(repo).running, true); // first read

  let reads = 0;
  const originalReadFileSync = fs.readFileSync.bind(fs);
  try {
    (fs as unknown as { readFileSync: unknown }).readFileSync = (...args: unknown[]) => {
      if (typeof args[0] === "string" && args[0].endsWith(`${path.sep}state${path.sep}orchestrator.json`))
        reads += 1;
      return (originalReadFileSync as (...a: unknown[]) => string)(...args);
    };
    const snap = snapshot(repo);
    assert.equal(snap.pid, process.pid); // the info was read and used for the pid…
    assert.equal(snap.running, true); // …and for the liveness check from that same read
    assert.equal(reads, 1); // one read serves both — not two
  } finally {
    (fs as unknown as { readFileSync: unknown }).readFileSync = originalReadFileSync;
  }
});

test("snapshot carries the daily cost budget aggregated from persisted loop state", async () => {
  const repo = makeRepo();
  await initProject(repo, "budget snapshot test"); // seeds tumwater.json with maxDailyCostUsd: 50

  // Two loops spent in today's window; a third carries yesterday's spend (stale stamp) that
  // must not count toward today — the badge is a daily figure.
  const clean = freshLoopState("clean");
  recordDailyCost(clean, 1.25);
  saveLoopState(repo, clean);
  const organize = freshLoopState("organize");
  recordDailyCost(organize, 0.75);
  saveLoopState(repo, organize);
  const dry = freshLoopState("dry");
  dry.dayStamp = "2000-01-01"; // not today's stamp → $0 today
  dry.dayCostUsd = 9;
  saveLoopState(repo, dry);

  let snap = snapshot(repo);
  // No provider/model is configured (pi's own default), so the fleet cannot be verified as
  // free — the dollar badge stays.
  assert.deepEqual(snap.budget, { spentUsd: 2, capUsd: 50, free: false, fallback: null });

  // Disabling the cap (0) keeps the budget object — spend is still reported and the badge
  // is the affordance for setting a cap again; only its display changes (`· no cap`).
  const cfg = loadConfig(repo);
  cfg.maxDailyCostUsd = 0;
  saveConfig(repo, cfg);
  snap = snapshot(repo);
  assert.deepEqual(snap.budget, { spentUsd: 2, capUsd: 0, free: false, fallback: null });
});

// The free-fleet case (BUGS.md: budget badge on local LLM fleets): when every model the
// fleet could use resolves to an unpriced or zero-cost entry in pi's models.json, spend can
// never accumulate against the cap and the badge data carries `free` so both dashboards read n/a.
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

test("loopPhase describes each loop state", () => {
  const s = freshLoopState("clean");
  assert.equal(loopPhase(s, false), "stopped");
  assert.equal(loopPhase(s, true), "queued");
  s.running = true;
  assert.equal(loopPhase(s, true), "working");
  s.running = false;
  s.nextRunAt = Date.now() + 90_000;
  // Sleeping is a present state: the label shows the remaining duration ("for …"),
  // not a future start ("in …"). 90s buckets to "2m" in humanSeconds.
  assert.match(loopPhase(s, true), /^sleeping \(for 2m\)$/);
  const d = freshLoopState("director");
  assert.equal(loopPhase(d, true), "waiting for prompts");
});

// Merge queue 4/5 — the snapshot's landQueue: depth from the queue files, and inFlight only
// when the 4/5 marker, a matching queue entry, and a live orchestrator all agree. The
// cross-check is the crash-safety pin: a stale marker alone (any crash ordering) never
// displays, and neither does a dead harness — no cleanup pass needed.
test("snapshot reports the land queue depth and the in-flight landing", async () => {
  const repo = makeRepo();
  await initProject(repo, "land queue snapshot");

  // Idle: depth 0, no inFlight (the field is unconditional, so JSON consumers see one shape).
  let snap = snapshot(repo);
  assert.equal(snap.landQueue.depth, 0);
  assert.equal(snap.landQueue.inFlight, undefined);

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

  // The 4/5 marker plus a live orchestrator plus the matching entry → in flight, with the
  // marker's identity (the dashboard's `landing <elapsed>` label reads startedAt from it).
  const startedAt = Date.now();
  const infoFile = path.join(repo, ".tumwater", "state", "orchestrator.json");
  fs.mkdirSync(path.dirname(infoFile), { recursive: true });
  fs.writeFileSync(
    infoFile,
    JSON.stringify({ pid: process.pid, startedAt: Date.now(), roles: ["clean"] }),
  );
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
  fs.writeFileSync(
    infoFile,
    JSON.stringify({ pid: process.pid, startedAt: Date.now(), roles: ["clean"] }),
  );
  writeJsonFile(landingStatePath(repo), {
    role: "clean",
    sha: "deadbee",
    summary: "stale marker",
    startedAt: Date.now(),
  });
  snap = snapshot(repo);
  assert.equal(snap.running, true);
  assert.equal(snap.landQueue.inFlight, undefined, "a marker with no matching queue entry never displays");

  // The queue drains and the marker is removed (the drain's own bookkeeping): back to idle.
  fs.rmSync(path.join(landQueueDir(repo), fs.readdirSync(landQueueDir(repo))[0]!));
  fs.rmSync(landingStatePath(repo));
  snap = snapshot(repo);
  assert.equal(snap.landQueue.depth, 0);
  assert.equal(snap.landQueue.inFlight, undefined);
});
