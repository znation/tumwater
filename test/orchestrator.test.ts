import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  fairOrder,
  isEligible,
  orchestratorAlive,
  readOrchestratorInfo,
  runOrchestrator,
} from "../src/orchestrator.js";
import { ROLES } from "../src/roles.js";
import { LoopRunner } from "../src/loop.js";
import { defaultConfig, loadConfig } from "../src/config.js";
import { initProject } from "../src/init.js";
import { readEvents } from "../src/events.js";
import { loadLoopState, nextBackoffSeconds } from "../src/state.js";
import { orchestratorStatePath } from "../src/paths.js";
import { assistantLine, fakePi, makeRepo, tmpdir } from "./util.js";

function runner(role: string): LoopRunner {
  return new LoopRunner(makeRepo(), role, defaultConfig(), "main");
}

test("a fresh loop is eligible at startup", () => {
  const r = runner("clean");
  assert.equal(isEligible(r, Date.now(), "abc", 0).run, true);
});

test("a running or recently-finished loop is not eligible", () => {
  const r = runner("clean");
  r.state.running = true;
  assert.equal(isEligible(r, Date.now(), "abc", 0).run, false);
  r.state.running = false;
  r.state.lastTickEndedAt = Date.now();
  r.state.nextRunAt = 0;
  assert.equal(isEligible(r, Date.now(), "abc", 0).run, false);
});

test("a sleeping loop wakes when main moves, respecting the min gap", () => {
  const r = runner("clean");
  const now = Date.now();
  const gap = r.config.minTickIntervalSeconds * 1000;
  r.state.ticks = 1;
  r.state.lastTickEndedAt = now - gap - 1000;
  r.state.nextRunAt = now + 60_000;
  r.state.lastMainHead = "old";
  assert.equal(isEligible(r, now, "old", 0).run, false);
  const woken = isEligible(r, now, "new", 0);
  assert.equal(woken.run, true);
  assert.equal(woken.reason, "main moved");
  // But not if it just finished a tick.
  r.state.lastTickEndedAt = now - 1000;
  assert.equal(isEligible(r, now, "new", 0).run, false);
});

test("the director only runs when the inbox has work", () => {
  const r = runner("director");
  assert.equal(isEligible(r, Date.now(), "abc", 0).run, false);
  const eligible = isEligible(r, Date.now(), "abc", 2);
  assert.equal(eligible.run, true);
  assert.equal(eligible.reason, "inbox");
});

test("the director ignores the min gap and backoff: queued prompts run back to back", () => {
  const r = runner("director");
  const now = Date.now();
  r.state.lastTickEndedAt = now - 1000; // Just finished — a role loop would be gated.
  r.state.nextRunAt = now + 3600_000; // Even a (stale) backoff must not block prompts.
  assert.equal(isEligible(r, now, "abc", 1).run, true);
  assert.equal(isEligible(r, now, "abc", 0).run, false);
});

test("fairOrder puts the director first even when it ticked most recently", () => {
  const director = runner("director");
  director.state.lastTickEndedAt = 9999;
  const feature = runner("feature");
  feature.state.lastTickEndedAt = 1;
  const fresh = runner("clean");
  assert.deepEqual(
    fairOrder([feature, fresh, director]).map((r) => r.role),
    ["director", "clean", "feature"],
  );
});

test("role catalog puts shipping work before hygiene", () => {
  const ids = ROLES.map((r) => r.id);
  assert.deepEqual(ids.slice(0, 4), ["feature", "bugfix", "plan", "readme"]);
  for (const hygiene of ["organize", "coverage", "clean", "dry"]) {
    assert.ok(ids.indexOf(hygiene) > ids.indexOf("readme"), `${hygiene} should rank below readme`);
  }
});

test("fairOrder alternates loops: least-recently-ticked first, catalog order for fresh ties", () => {
  const recent = runner("feature");
  recent.state.lastTickEndedAt = 2000;
  const stale = runner("dry");
  stale.state.lastTickEndedAt = 1000;
  const freshA = runner("bugfix");
  const freshB = runner("clean");
  const ordered = fairOrder([recent, freshA, stale, freshB]);
  assert.deepEqual(
    ordered.map((r) => r.role),
    ["bugfix", "clean", "dry", "feature"],
  );
});

test("backoff grows by the factor and caps at max", () => {
  const config = defaultConfig();
  config.idleBackoff = { initialSeconds: 10, factor: 3, maxSeconds: 50 };
  let backoff = 0;
  const seen: number[] = [];
  for (let i = 0; i < 4; i++) {
    backoff = nextBackoffSeconds(backoff, config);
    seen.push(backoff);
  }
  assert.deepEqual(seen, [10, 30, 50, 50]);
});

// --- Orchestrator lifecycle (info file, alive check, run/shutdown) ---

test("readOrchestratorInfo and orchestratorAlive handle missing, valid, dead-pid, and corrupt state", () => {
  const dir = tmpdir();
  assert.equal(readOrchestratorInfo(dir), null);
  assert.equal(orchestratorAlive(dir), false);

  const file = orchestratorStatePath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Our own pid is alive; a huge one is not.
  for (const [pid, alive] of [
    [process.pid, true],
    [999_999_999, false],
  ] as const) {
    fs.writeFileSync(file, JSON.stringify({ pid, startedAt: Date.now(), roles: ["clean"] }));
    assert.equal(readOrchestratorInfo(dir)?.pid, pid);
    assert.equal(orchestratorAlive(dir), alive);
  }

  // A torn write must not crash observers (TUI/GUI poll this every second).
  fs.writeFileSync(file, "{ not json");
  assert.equal(readOrchestratorInfo(dir), null);
  assert.equal(orchestratorAlive(dir), false);
});

test("runOrchestrator ticks enabled roles and cleans up on shutdown", async () => {
  const repo = makeRepo();
  await initProject(repo, "orchestrator lifecycle test");
  const config = loadConfig(repo);
  for (const id of Object.keys(config.roles)) {
    if (!["clean", "dry"].includes(id)) config.roles[id]!.enabled = false;
  }
  const restore = fakePi(`printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`);
  const controller = new AbortController();
  try {
    const done = runOrchestrator({ root: repo, config, mainBranch: "main", signal: controller.signal });
    // The info file is written before the first poll; wait for it.
    const deadline = Date.now() + 5000;
    while (!readOrchestratorInfo(repo) && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 25));
    const info = readOrchestratorInfo(repo);
    assert.ok(info, "orchestrator state file exists while running");
    assert.equal(info.pid, process.pid);
    assert.deepEqual([...info.roles].sort(), ["clean", "dry"]);
    assert.ok(orchestratorAlive(repo), "a live orchestrator reports alive");

    setTimeout(() => controller.abort(), 1200);
    await done;

    // Shutdown removed the state file and logged both lifecycle events.
    assert.equal(readOrchestratorInfo(repo), null, "state file removed on shutdown");
    const types = readEvents(repo).map((e) => e.type);
    assert.ok(types.includes("orchestrator_start"));
    assert.ok(types.includes("orchestrator_stop"));
    // Both enabled roles got their startup tick.
    for (const role of ["clean", "dry"])
      assert.ok(loadLoopState(repo, role).ticks >= 1, `${role} should have ticked`);
  } finally {
    restore();
    controller.abort();
  }
});

test("runOrchestrator refuses to start with no roles enabled", async () => {
  const repo = makeRepo();
  await initProject(repo, "no roles test");
  const config = loadConfig(repo);
  for (const id of Object.keys(config.roles)) config.roles[id]!.enabled = false;
  const controller = new AbortController();
  try {
    await assert.rejects(
      runOrchestrator({ root: repo, config, mainBranch: "main", signal: controller.signal }),
      /no roles enabled/,
    );
  } finally {
    controller.abort();
  }
});
