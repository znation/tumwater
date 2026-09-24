import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, saveConfig } from "../src/config.js";
import { dequeuePrompt, submitPrompt } from "../src/inbox.js";
import { allRoleIds } from "../src/roles.js";
import { snapshot } from "../src/ui/status.js";
import { renderStatus } from "../src/ui/status-render.js";
import { loopPhase, sortLoopsByState } from "../src/ui/status-model.js";
import { enqueueLanding } from "../src/land-queue.js";
import { freshLoopState, saveLoopState } from "../src/state.js";
import { recordDailyCost } from "../src/budget.js";
import { initProject } from "../src/init.js";
import { landingStatePath, landQueueDir, orchestratorStatePath } from "../src/paths.js";
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

  // Free but not serving (BUGS.md 2026-09-20): while the running orchestrator's breaker holds
  // the pair demoted, the scheduler reads the gate as paused — so must the dashboards.
  cfg.fallbackModel = { provider: "local", model: "local-free" };
  saveConfig(repo, cfg);
  const demoted = { pair: "local/local-free", failures: 3, probeAt: Date.now() + 300_000 };
  fs.mkdirSync(path.dirname(orchestratorStatePath(repo)), { recursive: true });
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

// BUGS.md 2026-09-24 — the display must mirror the concurrency cap: a tick parked in the
// semaphore queue holds no permit, so it renders its true state (`awaiting slot`) and stays
// out of the active set an operator counts against maxConcurrent.
test("a parked waiter renders `awaiting slot` and stays out of the active set", () => {
  const s = freshLoopState("clean");
  s.running = true;
  s.parkedSince = Date.now() - 5_000;
  assert.match(loopPhase(s, true), /^awaiting slot 5s$/);
  // Permit granted (the orchestrator clears parkedSince at acquire): the same loop becomes
  // an active, permit-holding working tick again.
  s.parkedSince = undefined;
  assert.equal(loopPhase(s, true), "working");
  // The parked label is not an active phase: sortLoopsByState puts it behind the working and
  // landing rows, so active-row counting never includes a waiter.
  const sorted = sortLoopsByState([
    { role: "clean", phase: "awaiting slot 5s" },
    { role: "feature", phase: "working 5s" },
    { role: "bugfix", phase: "landing 5s" },
  ]);
  assert.deepEqual(sorted.map((r) => r.role), ["bugfix", "feature", "clean"]);
});

test("a rendered fleet shows active rows equal to permit holders: parked waiters read `awaiting slot`", async () => {
  const repo = makeRepo();
  await initProject(repo, "test project");
  // A live-looking orchestrator (this process's pid) so loopPhase renders in-flight states.
  fs.mkdirSync(path.dirname(orchestratorStatePath(repo)), { recursive: true });
  fs.writeFileSync(
    orchestratorStatePath(repo),
    JSON.stringify({ pid: process.pid, startedAt: Date.now(), roles: [] }),
  );
  // One permit-holding tick (running, no parkedSince) and two parked waiters.
  const holder = freshLoopState("feature");
  holder.running = true;
  holder.lastTickStartedAt = Date.now() - 5_000; // renders the elapsed working detail
  saveLoopState(repo, holder);
  for (const role of ["clean", "organize"]) {
    const parked = freshLoopState(role);
    parked.running = true;
    parked.parkedSince = Date.now() - 5_000;
    saveLoopState(repo, parked);
  }
  const text = renderStatus(repo, snapshot(repo));
  // The waiters show their true state, not `working`.
  assert.equal(text.split("\n").filter((l) => l.includes("awaiting slot")).length, 2);
  // Exactly one active working row: the only real permit holder.
  assert.equal(text.split("\n").filter((l) => /\bworking \d/.test(l)).length, 1);
  fs.rmSync(orchestratorStatePath(repo), { force: true });
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

// A batch marker (merge queue 5/5) carries one record per batched change, and the snapshot
// cross-checks each against its still-queued entry: every batched row then reads its OWN
// change's state, and a change whose verdict is final shows nothing (BUGS.md 2026-09-23 —
// the head-only marker kept a rejected head reading `landing` for the whole batch).
test("a batch marker is cross-checked per change and each batched row reads its own change's state", async () => {
  const repo = makeRepo();
  await initProject(repo, "batch marker snapshot");
  const t0 = Date.now() - 20 * 60_000;
  for (const [role, sha] of [["clean", "c1ea000"], ["bugfix", "b0f1000"], ["feature", "fea7000"], ["dry", "d1a0000"]]) {
    enqueueLanding(repo, { role: role!, sha: sha!, tick: 1, summary: `${role} work`, enqueuedAt: Date.now() });
  }
  writeJsonFile(orchestratorStatePath(repo), { pid: process.pid, startedAt: Date.now(), roles: [] });
  const betaStart = Date.now() - 90_000;
  writeJsonFile(landingStatePath(repo), {
    role: "bugfix",
    sha: "b0f1000",
    summary: "bugfix work",
    startedAt: betaStart,
    changes: [
      { role: "clean", sha: "c1ea000", summary: "clean work", status: "done", startedAt: t0 },
      { role: "bugfix", sha: "b0f1000", summary: "bugfix work", status: "landing", startedAt: betaStart },
      { role: "feature", sha: "fea7000", summary: "feature work", status: "waiting" },
      { role: "dry", sha: "d1a0000", summary: "dry work", status: "approved", startedAt: t0 },
      // A record whose entry is gone (dropped mid-batch, or a crash) is finished, whatever
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
  assert.match(text, /^feature +queued in batch/m);
  assert.match(text, /^dry +approved, awaiting batch/m);
  assert.doesNotMatch(text, /^clean +landing/m, "a finished change keeps no live landing label");
  assert.match(text, /^clean +queued/m, "its row reads its own state again");
  assert.doesNotMatch(text, /^plan +landing/m, "a record with no queued entry never displays");

  // Only finished records left with a queued entry: nothing is in flight any more.
  for (const f of fs.readdirSync(landQueueDir(repo))) {
    if (!JSON.parse(fs.readFileSync(path.join(landQueueDir(repo), f), "utf8")).role.startsWith("clean")) {
      fs.rmSync(path.join(landQueueDir(repo), f));
    }
  }
  snap = snapshot(repo);
  assert.equal(snap.landQueue.depth, 1);
  assert.equal(snap.landQueue.inFlight, undefined, "a batch marker whose live records are all done never displays");
  fs.rmSync(orchestratorStatePath(repo));
});
