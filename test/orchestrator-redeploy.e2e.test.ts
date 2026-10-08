/** The self-redeploy tier's e2e slice (extracted from orchestrator-3.e2e.test.ts): the
 * scheduler's half of the self-hosted-redeploy contract — a stale build drains the fleet and
 * swaps, staleness is published in orchestrator.json, the drain cap aborts the in-flight tick
 * resumably (and counts only the permit holder), a parked tick waits out the restart hold, an
 * in-flight director tick is waited for, a failed compile leaves the old build running, and the
 * restart hand-off aborts landings that outlive their deadline (BUGS.md 2026-09-23). The
 * scripted Redeployer and the run harness live in orchestrator-fixtures.ts (scriptedRedeployer,
 * startRedeployRun); the restart hand-off test that also seeds the land queue stays in
 * orchestrator-3.e2e.test.ts. Like the other topic-named orchestrator files (orchestrator-budget,
 * orchestrator-pause, orchestrator-permits), this file holds one coherent topic; the tier's
 * balanced slices are orchestrator-2/3.e2e.test.ts. Each test file gets its own process — and
 * its own PATH, which fakePi's global PATH swap requires. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, saveConfig } from "../src/config/config.js";
import { initProject } from "../src/init/init.js";
import { enqueuePrompt } from "../src/inbox/inbox.js";
import { readEvents } from "../src/events/event-read.js";
import { loadLoopState } from "../src/loop/loop-state.js";
import { readOrchestratorInfo } from "../src/fleet/orchestrator-info.js";
import { worktreePath } from "../src/paths.js";
import { fastConfig, makeFastRepo, scriptedRedeployer, startRedeployRun } from "./orchestrator-fixtures.js";
import { roleWt } from "./loop-fixtures.js";
import { eventsOfType } from "./log-fixtures.js";
import { ownerAliveSh } from "./victim-fixture.js";
import { landWork, makeRepo, sh, tmpdir } from "./repo-fixtures.js";
import { fakePi, fakePiIdle } from "./fakes/fake-pi.js";
import { waitFor } from "./helpers/wait.js";
import { assistantLine } from "./pi-events.js";
test("a stale self-hosted build drains the fleet, swaps, and returns restart", async () => {
  const repo = await makeFastRepo("self-redeploy test", ["clean"]);
  const restore = fakePiIdle();
  const { redeployer, swaps } = scriptedRedeployer(repo);
  // A prompt for the director sits in the inbox: while a restart is pending nothing new starts
  // — director included — so it must still be queued when the process hands over.
  enqueuePrompt(repo, "hello director");
  const { run, stop } = startRedeployRun(repo, redeployer, { timeoutMs: 15_000 });
  try {
    const exit = await run;
    assert.deepEqual(exit, { restart: true });
    const head = sh(repo, "git", "rev-parse", "HEAD");
    assert.deepEqual(swaps, [head], "the compiled head was swapped into dist");
    const types = readEvents(repo).map((e) => e.type);
    assert.ok(types.indexOf("build_stale") < types.indexOf("restart_pending"), "stale, then pending");
    assert.ok(types.indexOf("restart_pending") < types.indexOf("restart"), "pending, then restart");
    assert.ok(types.indexOf("restart") < types.indexOf("orchestrator_stop"), "the stop follows the restart");
    assert.equal(fs.readdirSync(path.join(repo, ".tumwater/inbox")).length, 1, "the held director prompt survives for the next generation");
    assert.equal(readOrchestratorInfo(repo), null, "the info file is removed like any other stop");
  } finally {
    await stop();
    restore();
  }
});

test("the orchestrator publishes the build's staleness in orchestrator.json while it runs", async () => {
  const repo = await makeFastRepo("build status test", ["clean"]);
  const cfg = loadConfig(repo);
  cfg.autoRestart = false; // observe only: no drain, no restart
  saveConfig(repo, cfg);
  const restore = fakePiIdle();
  const { redeployer } = scriptedRedeployer(repo);
  const { stop } = startRedeployRun(repo, redeployer);
  try {
    await waitFor(() => readOrchestratorInfo(repo)?.build?.stale === true, "stale build published");
    const info = readOrchestratorInfo(repo)!;
    assert.equal(info.build?.sha, "0".repeat(40));
    assert.equal(info.build?.aheadCommits, 4);
    assert.equal(eventsOfType(repo, "restart_pending").length, 0, "autoRestart off: never drains");
    const start = readEvents(repo).find((e) => e.type === "orchestrator_start")!;
    assert.equal(start.build, "0".repeat(40), "the start event names the build");
  } finally {
    await stop();
    restore();
  }
});

test("a drain past its cap aborts the in-flight tick resumably and still restarts", async () => {
  const repo = await makeFastRepo("drain cap test", ["clean"]);
  // The tick never finishes on its own: only the drain cap (or a stop) can end it.
  const partial = () => path.join(roleWt(repo, "clean"), "partial.txt");
  const restore = fakePi(`echo partial > partial.txt\nexec sleep 30`);
  // Staleness is re-evaluated only when main moves (a per-head verdict), so: let the first tick
  // start against a fresh build, then move main — the recomputation finds the build stale with
  // that tick in flight, which is exactly the situation the drain cap exists for.
  const { redeployer, swaps } = scriptedRedeployer(repo, { drainMaxMs: 500, stale: () => fs.existsSync(partial()) });
  const { run, stop } = startRedeployRun(repo, redeployer, { timeoutMs: 15_000 });
  try {
    await waitFor(() => fs.existsSync(partial()), "the tick to start");
    sh(repo, "git", "commit", "-q", "--allow-empty", "-m", "main moves under a running tick");
    const exit = await run;
    assert.deepEqual(exit, { restart: true });
    assert.equal(swaps.length, 1);
    const ends = eventsOfType(repo, "tick_end");
    assert.equal(ends.length, 1);
    assert.equal(ends[0]!.result, "aborted", "the drain cap aborted the tick like a shutdown would");
    assert.equal(loadLoopState(repo, "clean").resumePending, true, "…so it resumes on the new build");
    const restart = readEvents(repo).find((e) => e.type === "restart")!;
    assert.equal(restart.abortedTicks, 1);
  } finally {
    await stop();
    restore();
  }
});

/** Two maintenance roles under maxConcurrent 1, both due on the first poll: one tick takes the
 * only permit, the other parks in the semaphore queue — the shape of every mid-drain start in
 * BUGS.md's restart-drain entry (2026-09-23). `started()` lists the roles whose fake pi ran. */
async function parkedPairRepo(label: string) {
  const repo = makeRepo();
  await initProject(repo, label);
  const cfg = fastConfig(["clean", "dry"]);
  cfg.maxConcurrent = 1;
  saveConfig(repo, cfg);
  const started = () =>
    ["clean", "dry"].filter((r) => fs.existsSync(path.join(roleWt(repo, r), "started.txt")));
  return { repo, started };
}

test("a drain past its cap aborts and counts only the permit holder — the tick parked behind it never starts", async () => {
  const { repo, started } = await parkedPairRepo("parked drain cap test");
  // The permit holder never finishes on its own; the parked role would run the same script.
  const restore = fakePi(`touch started.txt\nexec sleep 30`);
  const { redeployer, swaps } = scriptedRedeployer(repo, { drainMaxMs: 500, stale: () => started().length > 0 });
  const { run, stop } = startRedeployRun(repo, redeployer, { timeoutMs: 15_000 });
  try {
    await waitFor(() => started().length > 0, "the permit holder's tick to start");
    const [holder] = started();
    const parked = holder === "clean" ? "dry" : "clean";
    sh(repo, "git", "commit", "-q", "--allow-empty", "-m", "main moves under a running tick");
    const exit = await run;
    assert.deepEqual(exit, { restart: true });
    assert.equal(swaps.length, 1);
    const events = readEvents(repo);
    assert.deepEqual(
      events.filter((e) => e.type === "tick_start").map((e) => e.loop),
      [holder],
      "the parked waiter got the aborted holder's permit and released it without starting",
    );
    const ends = events.filter((e) => e.type === "tick_end");
    assert.deepEqual(ends.map((e) => [e.loop, e.result]), [[holder, "aborted"]]);
    // abortedTicks is what the restart cut off — the one permit holder — not the reservation
    // parked behind it (the 2026-09-21 restart reported 12 against 3 aborted tick_ends).
    assert.equal(events.find((e) => e.type === "restart")!.abortedTicks, 1);
    assert.deepEqual(started(), [holder], "the parked role's pi never ran");
    assert.equal(loadLoopState(repo, parked).ticks, 0, "no state write for a tick that never started");
  } finally {
    await stop();
    restore();
  }
});

test("a tick parked through a restart hold does not start when the permit frees, and ticks once the hold lifts", async () => {
  const { repo, started } = await parkedPairRepo("parked hold test");
  // The permit holder's pi blocks until the test releases it, so the permit changes hands
  // strictly INSIDE the hold — no timing race on how long the holder runs.
  const go = path.join(tmpdir(), "go");
  const restore = fakePi(
    `touch started.txt\nwhile [ ! -f '${go}' ] && ${ownerAliveSh()}; do sleep 0.05; done\nprintf '%s\\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
  );
  const holderEnded = () => readEvents(repo).some((e) => e.type === "tick_end");
  const { redeployer, swaps } = scriptedRedeployer(repo, {
    stale: () => started().length > 0,
    // The green check outlasts the holder's tick, then comes back red: the hold lifts without a
    // restart, so the parked role's reservation must have been handed back for it to tick again.
    mainGreen: async () => {
      await waitFor(holderEnded, "the holder's tick to end", 20_000);
      return false;
    },
  });
  const { stop } = startRedeployRun(repo, redeployer);
  try {
    await waitFor(() => started().length > 0, "the permit holder's tick to start");
    const [holder] = started();
    const parked = holder === "clean" ? "dry" : "clean";
    sh(repo, "git", "commit", "-q", "--allow-empty", "-m", "main moves under a running tick");
    await waitFor(() => readOrchestratorInfo(repo)?.build?.restartPending === true, "the restart hold");
    fs.writeFileSync(go, "");
    const isRed = (e: ReturnType<typeof readEvents>[number]) => e.type === "warning" && /is red/.test(String(e.message));
    await waitFor(() => readEvents(repo).some(isRed), "the red verdict that lifts the hold", 20_000);
    await waitFor(
      () => readEvents(repo).some((e) => e.type === "tick_start" && e.loop === parked),
      "the parked role to tick once the hold lifts",
      20_000,
    );
    const events = readEvents(repo);
    const red = events.findIndex(isRed);
    const holderEnd = events.findIndex((e) => e.type === "tick_end" && e.loop === holder);
    const parkedStart = events.findIndex((e) => e.type === "tick_start" && e.loop === parked);
    assert.ok(holderEnd >= 0 && red > holderEnd, "the holder freed its permit while the hold was still on");
    assert.ok(parkedStart > red, "the parked tick did not start inside the hold — only after it lifted");
    assert.deepEqual(swaps, []);
  } finally {
    await stop();
    restore();
  }
});

test("an in-flight director tick is waited for, not aborted, when the drain window elapses", async () => {
  // The 2026-09-08 incident end to end: a human prompt outlives the drain cap. Role ticks are
  // aborted resumably at the cap; the director's tick must run to completion — no swap and no
  // abort until it finishes (BUGS.md).
  const repo = await makeFastRepo("director drain test", ["director"]);
  // The prompt's run outlives the window: it marks itself started (so staleness can flip while
  // it is in flight), then sleeps past the cap before answering.
  const marker = path.join(worktreePath(repo, "director"), "started.txt");
  const restore = fakePi(`touch started.txt\nsleep 2\nprintf '%s\\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`);
  const { redeployer, swaps } = scriptedRedeployer(repo, { drainMaxMs: 500, stale: () => fs.existsSync(marker) });
  enqueuePrompt(repo, "a long human prompt");
  const { run, stop } = startRedeployRun(repo, redeployer, { timeoutMs: 15_000 });
  try {
    await waitFor(() => fs.existsSync(marker), "the director tick to start");
    sh(repo, "git", "commit", "-q", "--allow-empty", "-m", "main moves under a running prompt");
    const exit = await run;
    assert.deepEqual(exit, { restart: true });
    assert.equal(swaps.length, 1);
    const ends = eventsOfType(repo, "tick_end");
    assert.equal(ends.length, 1);
    assert.notEqual(ends[0]!.result, "aborted", "the director tick finished on its own — the hold waited it out");
    const restart = readEvents(repo).find((e) => e.type === "restart")!;
    assert.ok(Number(restart.drainedMs) > 500, `the hold ran past the drain window (${String(restart.drainedMs)}ms)`);
    assert.equal(restart.abortedTicks, 0);
  } finally {
    await stop();
    restore();
  }
});

test("a failed compile leaves the fleet running the old build", async () => {
  const repo = await makeFastRepo("compile failure test", ["clean"]);
  const restore = fakePiIdle();
  const { redeployer, swaps } = scriptedRedeployer(repo, { compileOk: false });
  const { stop } = startRedeployRun(repo, redeployer);
  try {
    await waitFor(
      () => readEvents(repo).some((e) => e.type === "warning" && /rebuild of .* failed/.test(String(e.message))),
      "compile-failure warning",
    );
    // Still running: ticks keep coming after the failure was recorded. clean is deferrable
    // (need-based prioritization) and main has not moved since its startup tick — a work
    // landing supplies the wake for the post-failure tick. The in-flight startup tick must
    // finish first: its end-of-tick head refresh would swallow a concurrent landing into
    // lastMainHead, leaving deferral nothing to react to.
    await waitFor(
      () => !loadLoopState(repo, "clean").running && loadLoopState(repo, "clean").lastMainHead !== "",
      "the startup tick to finish",
    );
    landWork(repo);
    const before = eventsOfType(repo, "tick_start").length;
    await waitFor(() => eventsOfType(repo, "tick_start").length > before, "ticks resume after the hold lifts");
    assert.deepEqual(swaps, []);
  } finally {
    await stop();
    restore();
  }
});
