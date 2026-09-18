/** Second half of orchestrator.test.ts — split so node --test runs the two halves in parallel
 * processes: top-level tests within one file run sequentially, while each test FILE gets its
 * own process (and its own PATH, which fakePi's global PATH swap requires). The halves are
 * balanced by measured per-test duration (~24 s each at 2026-09-09); keep them roughly equal
 * when moving tests between the files. */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { runOrchestrator } from "../src/orchestrator.js";
import { landQueuedEntry } from "../src/landing-slot.js";
import { LoopRunner } from "../src/loop.js";
import { defaultConfig, loadConfig, saveConfig } from "../src/config.js";
import { initProject } from "../src/init.js";
import { enqueuePrompt } from "../src/inbox.js";
import { logEvent, readEvents } from "../src/events.js";
import { freshLoopState, loadLoopState, readOrchestratorInfo, saveLoopState, clearBackoff } from "../src/state.js";
import { todayStamp } from "../src/budget.js";
import { abortRequestPath, branchName, landQueueDir, landingRefName, landingStatePath, pausedPath, resetRequestPath, wakeRequestPath, worktreePath } from "../src/paths.js";
import { enqueueLanding, headLanding, queueDepth } from "../src/land-queue.js";
import { refSha, setRef } from "../src/git.js";
import { checkMainBaseline } from "../src/main-baseline.js";
import { statusPayload } from "../src/ui/status-payload.js";
import { type RedeployDeps, Redeployer } from "../src/redeploy.js";
import {
  assistantLine,
  fastConfig,
  fakePi,
  landWork,
  makeRepo,
  recordingFakePi,
  sh,
  startLiveOrchestrator,
  tmpdir,
  waitFor,
} from "./util.js";

const FAST_POLL_MS = 100;

function seedCounters(repo: string, ...roles: string[]): void {
  for (const role of roles) {
    const s = freshLoopState(role);
    s.ticks = 7;
    s.generatedTokens = 424_242;
    saveLoopState(repo, s);
  }
}

test("a multi-role reset request zeroes every listed runner and logs one harness-level event", async () => {
  const repo = makeRepo();
  await initProject(repo, "multi role reset test");
  saveConfig(repo, fastConfig(["clean", "dry"]));
  seedCounters(repo, "clean", "dry");
  const restore = fakePi(`printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`);
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    // What `tumwater reset-counters` without --role writes: a marker naming every role.
    const markerFile = resetRequestPath(repo);
    fs.mkdirSync(path.dirname(markerFile), { recursive: true });
    fs.writeFileSync(markerFile, JSON.stringify({ at: Date.now(), roles: ["clean", "dry"] }));

    await waitFor(() => !fs.existsSync(markerFile), "the marker to be consumed");
    for (const role of ["clean", "dry"]) {
      // A post-reset tick may have started in the same poll; without in-memory zeroing this
      // would read >= 8.
      assert.ok(
        loadLoopState(repo, role).ticks <= 1,
        `${role} counters start from zero after consumption (got ${loadLoopState(repo, role).ticks})`,
      );
    }
    // Several roles → ONE harness-level event listing them, not one per role.
    const resets = readEvents(repo).filter((e) => e.type === "counters_reset");
    assert.equal(resets.length, 1);
    assert.equal(resets[0]?.loop, "harness");
    assert.deepEqual([...(resets[0]!.roles as string[])].sort(), ["clean", "dry"]);
  } finally {
    restore();
    await orch.stop();
  }
});

test("a corrupt reset marker resets every runner and is still consumed", async () => {
  const repo = makeRepo();
  await initProject(repo, "corrupt reset marker test");
  saveConfig(repo, fastConfig(["clean", "dry"]));
  seedCounters(repo, "clean", "dry");
  const restore = fakePi(`printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`);
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    // Garbage where the marker should be: JSON.parse throws → requested stays null → every
    // runner resets (a documented superset — skipping it would let the next tick's save
    // resurrect the pre-reset values).
    const markerFile = resetRequestPath(repo);
    fs.mkdirSync(path.dirname(markerFile), { recursive: true });
    fs.writeFileSync(markerFile, "{not json");

    await waitFor(() => !fs.existsSync(markerFile), "the corrupt marker to be consumed");
    for (const role of ["clean", "dry"]) {
      assert.ok(
        loadLoopState(repo, role).ticks <= 1,
        `${role} counters start from zero after a corrupt marker (got ${loadLoopState(repo, role).ticks})`,
      );
    }
    const resets = readEvents(repo).filter((e) => e.type === "counters_reset");
    assert.equal(resets.length, 1);
    assert.equal(resets[0]?.loop, "harness", "a superset reset is filed harness-level with the roles list");
    assert.deepEqual([...(resets[0]!.roles as string[])].sort(), ["clean", "dry"]);
  } finally {
    restore();
    await orch.stop();
  }
});

test("a wake request makes a backed-off loop due within one poll and logs it under the role", async () => {
  const repo = makeRepo();
  await initProject(repo, "wake request test");
  saveConfig(repo, fastConfig(["clean"]));
  // Deep backoff: the loop is two hours out and has ticked before, so the woken run reads as
  // "scheduled", not "startup". lastTickEndedAt is long past, so no min-gap gate applies.
  const seeded = freshLoopState("clean");
  seeded.ticks = 3;
  seeded.backoffSeconds = 7680;
  seeded.nextRunAt = Date.now() + 2 * 3600 * 1000;
  seeded.lastTickEndedAt = Date.now() - 3600 * 1000;
  saveLoopState(repo, seeded);
  const restore = fakePi(`printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`);
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    // The backed-off loop must stay asleep on its own (nextRunAt two hours out).
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(loadLoopState(repo, "clean").ticks, 3, "the backed-off loop stays asleep");

    // Reproduce what `tumwater wake --role clean` does from the CLI side: clear the state
    // file and drop the marker. (The CLI path itself is covered in test/cli.test.ts.)
    saveLoopState(repo, clearBackoff(loadLoopState(repo, "clean"), Date.now()));
    const markerFile = wakeRequestPath(repo);
    fs.mkdirSync(path.dirname(markerFile), { recursive: true });
    fs.writeFileSync(markerFile, JSON.stringify({ at: Date.now(), roles: ["clean"] }));

    // The fleet consumes the marker within a poll cycle and the loop ticks — its
    // in-memory schedule was the gate, so the file zeroing alone cannot explain the tick.
    await waitFor(() => loadLoopState(repo, "clean").ticks >= 4, "the woken loop to tick");
    await waitFor(() => !loadLoopState(repo, "clean").running, "the woken tick to finish");

    // The wake is visible as exactly one plain event filed under the role, not a warning.
    const wakes = readEvents(repo).filter((e) => e.type === "wake");
    assert.equal(wakes.length, 1);
    assert.equal(wakes[0]?.loop, "clean");
    assert.equal(wakes[0]?.reason, "operator");
  } finally {
    restore();
    await orch.stop();
  }
});

test("a corrupt wake marker wakes every runner and is still consumed", async () => {
  const repo = makeRepo();
  await initProject(repo, "corrupt wake marker test");
  saveConfig(repo, fastConfig(["clean", "dry"]));
  for (const role of ["clean", "dry"]) {
    const s = freshLoopState(role);
    s.ticks = 3;
    s.backoffSeconds = 7680;
    s.nextRunAt = Date.now() + 2 * 3600 * 1000;
    s.lastTickEndedAt = Date.now() - 3600 * 1000;
    saveLoopState(repo, s);
  }
  const restore = fakePi(`printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`);
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    // What the CLI side of `tumwater wake` already did: both state files cleared. Then
    // garbage where the marker should be: the parse fails → every runner wakes (a
    // documented superset — skipping it would leave the pre-wake in-memory schedule in place).
    for (const role of ["clean", "dry"]) {
      saveLoopState(repo, clearBackoff(loadLoopState(repo, role), Date.now()));
    }
    const markerFile = wakeRequestPath(repo);
    fs.mkdirSync(path.dirname(markerFile), { recursive: true });
    fs.writeFileSync(markerFile, "{not json");

    await waitFor(() => !fs.existsSync(markerFile), "the corrupt marker to be consumed");
    for (const role of ["clean", "dry"]) {
      await waitFor(() => loadLoopState(repo, role).ticks >= 4, `${role} to tick after the wake`);
    }
    const wakes = readEvents(repo).filter((e) => e.type === "wake");
    assert.equal(wakes.length, 2, "one wake event per woken role");
    assert.deepEqual(
      wakes.map((e) => e.loop).sort(),
      ["clean", "dry"],
    );
    for (const e of wakes) assert.equal(e.reason, "operator");
  } finally {
    restore();
    await orch.stop();
  }
});

test("roles can be enabled and disabled mid-run without a restart", async () => {
  const repo = makeRepo();
  await initProject(repo, "role toggling test");
  saveConfig(repo, fastConfig(["clean", "dry"]));
  const argsFile = path.join(tmpdir(), "argv.log");
  const restore = recordingFakePi(argsFile);
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    const finished = (role: string) => {
      const s = loadLoopState(repo, role);
      return s.ticks >= 1 && !s.running;
    };
    const messages = () => readEvents(repo).map((e) => (e.message as string | undefined) ?? "");
    await waitFor(() => finished("clean") && finished("dry"), "startup ticks to finish");
    // Baseline while both roles are still enabled and idle: clean's next tick after the
    // disable is what proves the rest of the fleet keeps ticking.
    const cleanTicks = loadLoopState(repo, "clean").ticks;

    // Disabling a role stops its next tick; the rest of the fleet keeps ticking.
    saveConfig(repo, fastConfig(["clean"]));
    // Wait until the disable is processed AND no in-flight dry tick remains. From that point
    // on dry can never start another tick (isEligible hard-gates disabled roles), so its
    // captured count is final for the whole disabled window — no fixed sleep needed.
    await waitFor(
      () =>
        messages().some((m) => m.includes("role dry disabled — stopping ticks")) &&
        !loadLoopState(repo, "dry").running,
      "the disable to be processed with no in-flight tick",
    );
    const dryTicks = loadLoopState(repo, "dry").ticks;
    // The enabled role's next tick proves the fleet is still alive and ticking — the disabled
    // role had that same window and must not have used it. clean is deferrable (need-based
    // prioritization), so a work landing supplies its wake; the re-enabled dry below wakes on
    // the same commit.
    landWork(repo);
    await waitFor(() => loadLoopState(repo, "clean").ticks > cleanTicks, "an enabled role to tick again");
    assert.equal(loadLoopState(repo, "dry").ticks, dryTicks, "disabled role stops ticking");
    assert.ok(messages().some((m) => m.includes("role dry disabled — stopping ticks")), "disable transition logged");

    // Enabling a role that was not running at startup starts it (new runner).
    saveConfig(repo, fastConfig(["clean", "feature"]));
    await waitFor(() => finished("feature"), "newly enabled role to tick");
    assert.ok(messages().some((m) => m.includes("role feature enabled — starting ticks")), "enable transition logged");
    assert.equal(loadLoopState(repo, "dry").ticks, dryTicks, "still-disabled role stays stopped");

    // Re-enabling a previously running loop resumes it within one poll cycle.
    saveConfig(repo, fastConfig(["clean", "dry", "feature"]));
    await waitFor(() => loadLoopState(repo, "dry").ticks > dryTicks, "re-enabled role to tick again");
    assert.ok(messages().some((m) => m.includes("role dry enabled — starting ticks")), "re-enable transition logged");
  } finally {
    restore();
    await orch.stop();
  }
});

// --- User-defined loops (plans/user-defined-loops.md, PLANS.md "User-defined loops 1/3") ---

test("custom loops can be added, removed, and reordered mid-run without a restart", async () => {
  const repo = makeRepo();
  await initProject(repo, "custom loop e2e test");
  saveConfig(repo, fastConfig(["clean"]));
  const restore = fakePi(`printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`);
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    const finished = (role: string) => {
      const s = loadLoopState(repo, role);
      return s.ticks >= 1 && !s.running;
    };
    const messages = () => readEvents(repo).map((e) => (e.message as string | undefined) ?? "");
    const loopOrder = () =>
      (statusPayload(repo) as { loops: Array<{ role: string }> }).loops.map((l) => l.role);
    await waitFor(() => finished("clean"), "the startup tick to finish");

    // Adding a custom entry starts its runner within one poll cycle — the live-reload
    // machinery already handles any enabled id, so no orchestrator change is needed.
    let cfg = fastConfig(["clean"]);
    cfg.customLoops.push({ name: "docs-auditor", task: "Keep the docs current." });
    saveConfig(repo, cfg);
    await waitFor(() => finished("docs-auditor"), "the new custom loop to tick");
    assert.ok(
      readEvents(repo).some((e) => e.type === "tick_start" && e.loop === "docs-auditor"),
      "ticks under its own name",
    );
    // Owns its persistent worktree and branch like a built-in.
    assert.ok(fs.existsSync(worktreePath(repo, "docs-auditor")), "its worktree");
    const branches = sh(repo, "git", "branch", "--list").split("\n");
    assert.ok(branches.some((b) => b.includes(branchName("docs-auditor"))), "its branch");

    // A main move wakes it — customs are never deferred by need-based prioritization.
    landWork(repo);
    await waitFor(() => loadLoopState(repo, "docs-auditor").ticks >= 2, "a second tick after a main move");

    // Removing the entry logs one warning and stops its ticks.
    saveConfig(repo, fastConfig(["clean"]));
    await waitFor(
      () =>
        messages().some((m) => m.includes("role docs-auditor disabled — stopping ticks")) &&
        !loadLoopState(repo, "docs-auditor").running,
      "the removal to be processed with no in-flight tick",
    );
    const removedTicks = loadLoopState(repo, "docs-auditor").ticks;
    // The enabled role's next tick proves the fleet is alive and main moved — a still-enabled
    // custom would have used that same wake (it never defers), so its count must not move.
    landWork(repo);
    await waitFor(() => loadLoopState(repo, "clean").ticks > 1, "an enabled role to tick again");
    assert.equal(loadLoopState(repo, "docs-auditor").ticks, removedTicks, "removed loop stops ticking");

    // Re-adding the same name revives its persisted state — counters survive, like re-enabling a built-in.
    cfg = fastConfig(["clean"]);
    cfg.customLoops.push({ name: "docs-auditor", task: "Keep the docs current." });
    saveConfig(repo, cfg);
    await waitFor(
      () => loadLoopState(repo, "docs-auditor").ticks > removedTicks && !loadLoopState(repo, "docs-auditor").running,
      "the re-added loop to tick again",
    );
    assert.equal(loadLoopState(repo, "docs-auditor").ticks, removedTicks + 1, "counters survived the removal");
    assert.ok(
      messages().some((m) => m.includes("role docs-auditor enabled — starting ticks")),
      "re-add transition logged",
    );

    // Reordering two entries reorders the status table without touching built-in order.
    cfg = fastConfig(["clean"]);
    cfg.customLoops.push({ name: "docs-auditor", task: "Keep the docs current." });
    cfg.customLoops.push({ name: "perf-hunter", task: "Hunt perf wins." });
    saveConfig(repo, cfg);
    await waitFor(() => finished("perf-hunter"), "the second custom loop to tick");
    assert.deepEqual(loopOrder().slice(-2), ["docs-auditor", "perf-hunter"], "customs after built-ins in array order");

    cfg = fastConfig(["clean"]);
    cfg.customLoops.push({ name: "perf-hunter", task: "Hunt perf wins." });
    cfg.customLoops.push({ name: "docs-auditor", task: "Keep the docs current." });
    saveConfig(repo, cfg);
    await waitFor(
      () => {
        const order = loopOrder();
        return order.indexOf("perf-hunter") !== -1 && order.indexOf("perf-hunter") < order.indexOf("docs-auditor");
      },
      "the reorder to show in the status table",
    );
    const order = loopOrder();
    assert.deepEqual(order.slice(-2), ["perf-hunter", "docs-auditor"]);
    assert.ok(order.indexOf("clean") < order.indexOf("perf-hunter"), "built-ins keep their place ahead of customs");
  } finally {
    restore();
    await orch.stop();
  }
});

// --- Daily cost budget gate (plans/daily-cost-budget.md) ---

test("a reached daily cap pauses role ticks but not the director; raising the cap resumes", async () => {
  const repo = makeRepo();
  await initProject(repo, "budget gate e2e test");
  // Tiny cap: exactly one fake run's cost. After clean's first tick the fleet has spent
  // $1 >= $0.50, so every later poll reads budget-paused until the cap is raised live.
  const config = fastConfig(["clean", "director"]);
  config.maxDailyCostUsd = 0.5;
  saveConfig(repo, config);
  const restore = fakePi(`printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO", { cost: 1 })}'`);
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    // clean's startup tick lands the first spend; the transition is logged exactly once,
    // harness-level, with the spend and cap that triggered it.
    await waitFor(
      () => loadLoopState(repo, "clean").ticks >= 1 && !loadLoopState(repo, "clean").running,
      "the startup tick to finish",
    );
    await waitFor(() => readEvents(repo).some((e) => e.type === "budget_paused"), "a budget_paused event");
    const paused = readEvents(repo).filter((e) => e.type === "budget_paused");
    assert.equal(paused.length, 1, "one transition event per pause");
    assert.equal(paused[0]?.loop, "harness");
    assert.equal(paused[0]?.capUsd, 0.5);
    // The spend is the fake run's cost folded into clean's daily window — not just its
    // lifetime totalCostUsd (which would also read $1 here, but from a different field).
    assert.equal(paused[0]?.spentUsd, 1);

    // The paused role starts no new ticks even though its schedule says to run: wait well
    // past nextRunAt plus several (fast) poll cycles — an ungated loop would have ticked by then.
    const scheduled = loadLoopState(repo, "clean").nextRunAt;
    await waitFor(() => Date.now() >= scheduled + 1500, "the schedule to pass while paused");
    assert.equal(loadLoopState(repo, "clean").ticks, 1, "a budget-paused role starts no new ticks");

    // The director is exempt: a queued human prompt still runs while the fleet is paused.
    enqueuePrompt(repo, "steer me while the fleet is paused");
    await waitFor(
      () => loadLoopState(repo, "director").ticks >= 1 && !loadLoopState(repo, "director").running,
      "the director to tick while budget-paused",
    );
    assert.equal(loadLoopState(repo, "clean").ticks, 1, "still paused after the director's run");

    // Raising the cap live resumes within a poll cycle: one transition event, then the role
    // ticks again. The director's spend counts toward the fleet total ($2 now), so this also
    // proves resume is about the cap, not a reset of the daily window.
    const raised = fastConfig(["clean", "director"]);
    raised.maxDailyCostUsd = 100;
    saveConfig(repo, raised);
    await waitFor(() => readEvents(repo).some((e) => e.type === "budget_resumed"), "a budget_resumed event");
    const resumed = readEvents(repo).filter((e) => e.type === "budget_resumed");
    assert.equal(resumed.length, 1, "one transition event per resume");
    assert.equal(resumed[0]?.loop, "harness");
    assert.equal(resumed[0]?.capUsd, 100);
    // clean is deferrable and no work has landed since its first tick — a work commit supplies
    // the wake for the post-resume tick.
    landWork(repo);
    await waitFor(
      () => loadLoopState(repo, "clean").ticks >= 2 && !loadLoopState(repo, "clean").running,
      "the paused role to tick again after the cap raise",
    );

    // Exactly one of each transition for the whole run — no per-poll event spam.
    assert.equal(readEvents(repo).filter((e) => e.type === "budget_paused").length, 1);
    assert.equal(readEvents(repo).filter((e) => e.type === "budget_resumed").length, 1);
  } finally {
    restore();
    await orch.stop();
  }
});

// AC3's two startup/wake clauses (plans/daily-cost-budget.md): the gate also blocks a fleet
// that is ALREADY at cap when the orchestrator starts, and it holds main-moved wakes while
// paused — both are "no tick starts" guarantees, so they assert absence across several polls.

test("startup with spend already at the cap starts no role ticks", async () => {
  const repo = makeRepo();
  await initProject(repo, "budget startup test");
  // Tiny cap: the pre-seeded window ($1) already reaches it before any tick runs.
  const config = fastConfig(["clean"]);
  config.maxDailyCostUsd = 1;
  saveConfig(repo, config);
  // A fleet that spent its budget on an earlier run of the harness today: seed clean's daily
  // window at the cap so the gate is closed from the very first poll.
  const s = freshLoopState("clean");
  s.dayStamp = todayStamp();
  s.dayCostUsd = 1;
  saveLoopState(repo, s);
  const restore = fakePi(`printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO", { cost: 1 })}'`);
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    // The loop is schedule-eligible (fresh state, nextRunAt 0) — an ungated fleet would have
    // ticked within the first poll. Several (fast) poll cycles pass with no role tick starting.
    await waitFor(() => readOrchestratorInfo(repo) !== null, "orchestrator state file");
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(loadLoopState(repo, "clean").ticks, 0, "a fleet at cap starts no role ticks");
    // The pause is announced exactly once, with the spend and cap that closed the gate.
    const paused = readEvents(repo).filter((e) => e.type === "budget_paused");
    assert.equal(paused.length, 1);
    assert.equal(paused[0]?.capUsd, 1);
    assert.equal(paused[0]?.spentUsd, 1);
  } finally {
    restore();
    await orch.stop();
  }
});

test("a main-moved wake while budget-paused stays blocked", async () => {
  const repo = makeRepo();
  await initProject(repo, "budget main-move test");
  // Tiny cap: clean's startup tick spends $1 >= $0.50 and pauses the fleet.
  const config = fastConfig(["clean"]);
  config.maxDailyCostUsd = 0.5;
  saveConfig(repo, config);
  const restore = fakePi(`printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO", { cost: 1 })}'`);
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await waitFor(
      () => loadLoopState(repo, "clean").ticks >= 1 && !loadLoopState(repo, "clean").running,
      "the startup tick to finish",
    );
    await waitFor(() => readEvents(repo).some((e) => e.type === "budget_paused"), "a budget_paused event");

    // The world changed: advance main. An ungated fleet would wake clean early ("main moved")…
    fs.writeFileSync(path.join(repo, "world.txt"), "changed\n");
    sh(repo, "git", "add", "-A");
    sh(repo, "git", "commit", "-m", "advance main while paused");

    // …but the gate skips role runners before eligibility is even evaluated: several (fast)
    // poll cycles pass with no tick and no wake event.
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(loadLoopState(repo, "clean").ticks, 1, "a main move cannot wake a budget-paused fleet");
    assert.ok(!readEvents(repo).some((e) => e.type === "wake"), "no wake logged for the blocked main move");
  } finally {
    restore();
    await orch.stop();
  }
});

// --- The cost n/a fallback model (plans/fallback-model.md): the budget gate's third state.
// Where the fleet used to stop at its cap, a configured free model takes over instead. ---

/** pi's model definitions as the fallback tests need them: one priced provider (what the
 * fleet spends its budget on) and one zero-cost provider (what it falls back to). */
function writeFallbackModels(): string {
  const file = path.join(tmpdir(), "models.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      providers: {
        paid: { models: [{ id: "big-paid", cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }] },
        local: { models: [{ id: "local-free", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] },
      },
    }),
  );
  return file;
}

test("a reached cap switches role loops to the free fallback model instead of stopping them", async () => {
  const repo = makeRepo();
  await initProject(repo, "budget fallback e2e test");
  // Tiny cap: exactly one fake run's cost, so clean's startup tick closes the gate.
  const config = fastConfig(["clean", "director"]);
  config.maxDailyCostUsd = 0.5;
  config.provider = "paid";
  config.model = "big-paid";
  config.fallbackModel = { provider: "local", model: "local-free" };
  // A role pinned to its own paid model: the switch must drop that override too, or the cap
  // would keep being exceeded by exactly the loop that opted out of the default model.
  config.roles.clean = { enabled: true, model: "also-paid" };
  saveConfig(repo, config);
  const argsFile = path.join(tmpdir(), "argv.log");
  const restore = recordingFakePi(argsFile, { cost: 1 });
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS, writeFallbackModels());
  const runs = (): string[] => {
    try {
      return fs.readFileSync(argsFile, "utf8").split("\n").filter((l) => l.startsWith("run:"));
    } catch {
      return [];
    }
  };
  try {
    // The startup tick runs on the budgeted pair — including clean's own paid override — and
    // spends $1 >= $0.50.
    await waitFor(() => runs().length >= 1, "the startup tick's pi run");
    assert.match(runs()[0] ?? "", /model=also-paid provider=paid/, "the budgeted model does the paid work");

    // One transition event naming the pair that took over: the operator must be able to tell
    // this from a pause.
    await waitFor(() => readEvents(repo).some((e) => e.type === "budget_fallback"), "a budget_fallback event");
    const fallback = readEvents(repo).filter((e) => e.type === "budget_fallback");
    assert.equal(fallback.length, 1, "one transition event per switch");
    assert.equal(fallback[0]?.loop, "harness");
    assert.equal(fallback[0]?.capUsd, 0.5);
    assert.equal(fallback[0]?.spentUsd, 1);
    assert.equal(fallback[0]?.provider, "local");
    assert.equal(fallback[0]?.model, "local-free");
    assert.ok(!readEvents(repo).some((e) => e.type === "budget_paused"), "the fleet degraded, it did not stop");

    // And the fleet keeps working: clean's next tick runs on the free pair, with its paid
    // role override dropped. (clean is deferrable and did nothing last tick, so work supplies
    // the wake — the same as every other budget test.)
    landWork(repo);
    await waitFor(
      () => loadLoopState(repo, "clean").ticks >= 2 && !loadLoopState(repo, "clean").running,
      "a role tick after the cap was reached",
    );
    assert.match(
      runs().find((l) => l.includes("session=tumwater-clean-2")) ?? "",
      /model=local-free provider=local/,
      "the role loop keeps ticking, on the cost n/a fallback",
    );

    // The director is outside the gate in both directions: an explicit human prompt outranks
    // the autonomous-spend cap, so it keeps the budgeted model.
    enqueuePrompt(repo, "steer me after the budget is spent");
    await waitFor(
      () => loadLoopState(repo, "director").ticks >= 1 && !loadLoopState(repo, "director").running,
      "the director to tick after the switch",
    );
    assert.match(
      runs().find((l) => l.includes("session=tumwater-director-1")) ?? "",
      /model=big-paid provider=paid/,
      "the director keeps the budgeted model",
    );

    // Raising the cap live switches back within a poll — resume is stateless, exactly as it
    // is for the pause.
    const raised = { ...config, maxDailyCostUsd: 100 };
    saveConfig(repo, raised);
    await waitFor(() => readEvents(repo).some((e) => e.type === "budget_resumed"), "a budget_resumed event");
    landWork(repo);
    await waitFor(
      () => runs().some((l) => l.includes("session=tumwater-clean-3")),
      "a role tick after the cap was raised",
    );
    assert.match(
      runs().find((l) => l.includes("session=tumwater-clean-3")) ?? "",
      /model=also-paid provider=paid/,
      "back on the budgeted model, role override restored",
    );
  } finally {
    restore();
    await orch.stop();
  }
});

test("a fallback pi cannot price at zero is refused and the fleet pauses as before", async () => {
  const repo = makeRepo();
  await initProject(repo, "budget fallback refusal test");
  const config = fastConfig(["clean"]);
  config.maxDailyCostUsd = 0.5;
  config.provider = "paid";
  config.model = "big-paid";
  // Names a model pi's definitions do not list: unverifiable, so it must never engage — a
  // fallback that can spend would defeat the cap it exists to survive.
  config.fallbackModel = { provider: "local", model: "typo-free" };
  saveConfig(repo, config);
  const restore = fakePi(`printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO", { cost: 1 })}'`);
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS, writeFallbackModels());
  try {
    await waitFor(
      () => loadLoopState(repo, "clean").ticks >= 1 && !loadLoopState(repo, "clean").running,
      "the startup tick to finish",
    );
    await waitFor(() => readEvents(repo).some((e) => e.type === "budget_paused"), "a budget_paused event");
    // The event names the refused pair: why the fleet stopped instead of switching is the one
    // thing the operator can act on.
    const paused = readEvents(repo).filter((e) => e.type === "budget_paused");
    assert.equal(paused[0]?.fallbackRejected, "local/typo-free");
    assert.ok(!readEvents(repo).some((e) => e.type === "budget_fallback"));

    // And it really is paused: several poll cycles past its schedule, no second tick.
    landWork(repo);
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(loadLoopState(repo, "clean").ticks, 1, "a refused fallback leaves the fleet paused");
  } finally {
    restore();
    await orch.stop();
  }
});

// --- Operator pause gate (PLANS.md, fleet-pause plan): the budget gate's sibling with a
// human-intent trigger — a persistent marker (`tumwater pause` writes it, `resume` removes
// it) that blocks every NEW role tick for any reason while the director keeps running. The
// CLI side is pinned in test/cli.test.ts; here the marker's effect on a live fleet. ---

test("a pause marker blocks new role ticks for any reason while the director runs; resume unblocks", async () => {
  const repo = makeRepo();
  await initProject(repo, "operator pause e2e test");
  saveConfig(repo, fastConfig(["clean", "director"]));
  const restore = fakePi(`printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`);
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    // Baseline: clean's startup tick lands while unpaused.
    await waitFor(
      () => loadLoopState(repo, "clean").ticks >= 1 && !loadLoopState(repo, "clean").running,
      "the startup tick to finish",
    );

    // The operator pauses the running fleet (what `tumwater pause` does: drop the marker).
    const marker = pausedPath(repo);
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, JSON.stringify({ at: Date.now() }));
    await waitFor(() => readEvents(repo).some((e) => e.type === "fleet_paused"), "a fleet_paused event");

    // The world changed under a paused fleet: advance main. An ungated loop would wake early…
    fs.writeFileSync(path.join(repo, "world.txt"), "changed\n");
    sh(repo, "git", "add", "-A");
    sh(repo, "git", "commit", "-m", "advance main while paused");

    // …but the gate skips role runners before eligibility is even evaluated: several (fast)
    // poll cycles pass with no tick and no wake for clean. The marker itself survives — it
    // is persistent state, not a one-shot request like the abort/reset markers.
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(loadLoopState(repo, "clean").ticks, 1, "a user-paused role starts no new ticks");
    assert.ok(
      !readEvents(repo).some((e) => e.type === "wake" && e.loop === "clean"),
      "no wake logged for the blocked main move",
    );
    assert.ok(fs.existsSync(marker), "the pause marker is persistent state, not consumed");

    // The director is exempt: a queued human prompt still runs while the fleet is paused.
    enqueuePrompt(repo, "steer me while the fleet is paused");
    await waitFor(
      () => loadLoopState(repo, "director").ticks >= 1 && !loadLoopState(repo, "director").running,
      "the director to tick while user-paused",
    );
    assert.equal(loadLoopState(repo, "clean").ticks, 1, "still paused after the director's run");

    // Removing the marker mid-run (what `tumwater resume` does) lifts the pause on the next
    // poll: one transition event, then the blocked role ticks again without a restart.
    fs.rmSync(marker);
    await waitFor(() => readEvents(repo).some((e) => e.type === "fleet_resumed"), "a fleet_resumed event");
    await waitFor(
      () => loadLoopState(repo, "clean").ticks >= 2 && !loadLoopState(repo, "clean").running,
      "the paused role to tick again after resume",
    );

    // Exactly one of each transition for the whole run — no per-poll event spam.
    assert.equal(readEvents(repo).filter((e) => e.type === "fleet_paused").length, 1);
    assert.equal(readEvents(repo).filter((e) => e.type === "fleet_resumed").length, 1);
  } finally {
    restore();
    await orch.stop();
  }
});

// The persistence bullet of the same plan: pausing while stopped, then starting. The marker
// is the only state involved — a fleet that starts already paused stays blocked until resume,
// with no restart and no loop-state or config changes.
test("starting already paused keeps role ticks blocked until resume — no restart needed", async () => {
  const repo = makeRepo();
  await initProject(repo, "operator pause at startup test");
  saveConfig(repo, fastConfig(["clean", "director"]));
  const restore = fakePi(`printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`);

  // The operator paused before starting the fleet (the marker is persistent state): startup
  // itself must not start any role tick.
  const marker = pausedPath(repo);
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({ at: Date.now() }));

  // A queued director prompt runs even on an already-paused fleet — the exemption holds from
  // the first poll, not just mid-run.
  enqueuePrompt(repo, "steer me before the fleet starts");

  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await waitFor(
      () => loadLoopState(repo, "director").ticks >= 1 && !loadLoopState(repo, "director").running,
      "the director to tick while the fleet starts paused",
    );

    // Several fast poll cycles pass with zero role ticks — startup is a wake reason like any
    // other, and the gate sits before eligibility. The marker survives: persistent state.
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(loadLoopState(repo, "clean").ticks, 0, "an already-paused role starts no ticks");
    assert.ok(fs.existsSync(marker), "the marker survives startup — not consumed");

    // Resume without a restart: the blocked role ticks on its next eligibility.
    fs.rmSync(marker);
    await waitFor(
      () => loadLoopState(repo, "clean").ticks >= 1 && !loadLoopState(repo, "clean").running,
      "the paused role to tick after resume",
    );

    // One transition event per direction for the whole run — including the startup read.
    assert.equal(readEvents(repo).filter((e) => e.type === "fleet_paused").length, 1);
    assert.equal(readEvents(repo).filter((e) => e.type === "fleet_resumed").length, 1);
  } finally {
    restore();
    await orch.stop();
  }
});

// The in-flight bullet of the same plan: a tick already running when the marker drops is not
// killed — it finishes and lands its outcome even though no new one starts.
test("an in-flight tick finishes and lands while the fleet is paused", async () => {
  const repo = makeRepo();
  await initProject(repo, "operator pause in-flight test");
  saveConfig(repo, fastConfig(["clean"]));
  // A slow fake pi that makes a real change: it stays in flight long enough for the marker to
  // drop mid-run. The review gate approves with zero usage so the tick's outcome is clean.
  const restore = fakePi(
    [
      `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
      `sleep 1`,
      `printf '%s\n' '${assistantLine("done\nSUMMARY: add hello file", { tokens: 42, output: 42, cost: 0.05 })}'`,
      `echo hello > hello.txt`,
    ].join("\n"),
  );
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    // Wait for the tick to be in flight (running is persisted before pi starts)…
    await waitFor(
      () => loadLoopState(repo, "clean").running === true,
      "the tick to be in flight",
    );

    // …and pause mid-run. The gate blocks only NEW ticks — it never kills an in-flight one.
    const marker = pausedPath(repo);
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, JSON.stringify({ at: Date.now() }));

    // The in-flight tick finishes (commit + pin + enqueue) and the landing slot drains the
    // entry to main — both despite the pause: a queued landing is committed work awaiting
    // completion, not a new tick, so the pause gate deliberately does not hold it.
    await waitFor(
      () => loadLoopState(repo, "clean").lastResult === "changed",
      "the in-flight landing to finish",
    );
    const s = loadLoopState(repo, "clean");
    assert.equal(s.ticks, 1, "exactly one tick started");
    assert.equal(s.lastResult, "changed", "the outcome lands despite the pause");
    assert.ok(fs.existsSync(path.join(repo, "hello.txt")), "the change merged to main");

    // …and no new tick starts while the marker holds.
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(loadLoopState(repo, "clean").ticks, 1, "no second tick while paused");
  } finally {
    restore();
    await orch.stop();
  }
});

test("a user abort during a landing kills it and discards the pinned ref", async () => {
  const repo = makeRepo();
  await initProject(repo, "abort landing e2e test");
  // A long minimum interval: the aborted role must NOT start a second tick while the test
  // asserts the aftermath (a fresh tick would re-enqueue and re-pin and muddy the asserts).
  const cfg = fastConfig(["clean"]);
  cfg.minTickIntervalSeconds = 300;
  saveConfig(repo, cfg);
  // Author run: make a change and finish. Review run (its prompt contains VERDICT): touch the
  // marker, then hang until the abort kills it — the landing stays in flight for as long as
  // the abort marker sits on disk.
  const marker = path.join(tmpdir(), "clean-reviewing");
  const restore = fakePi(
    [
      `for a in "$@"; do case "$a" in *"VERDICT:"*) touch '${marker}'; exec sleep 30;; esac; done`,
      `printf '%s\n' '${assistantLine("done\nSUMMARY: add hello file")}'`,
      `echo hello > hello.txt`,
    ].join("\n"),
  );
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    // The tick commits + enqueues; the landing slot picks the entry up and starts its
    // reviewer run — by merge queue 3/5 this is where `tumwater abort --role` reaches it.
    await waitFor(
      () => loadLoopState(repo, "clean").lastResult === "queued",
      "the tick to enqueue its landing",
    );
    await waitFor(() => fs.existsSync(marker), "the landing's reviewer run to be in flight");

    // What `tumwater abort --role clean` does from the CLI side: drop the per-role marker.
    const markerFile = abortRequestPath(repo, "clean");
    fs.mkdirSync(path.dirname(markerFile), { recursive: true });
    fs.writeFileSync(markerFile, JSON.stringify({ at: Date.now() }));

    // The fleet consumes the request, aborts the in-flight landing, and the drain discards
    // the pinned ref: a deliberate stop kills the work under review, the landing's
    // counterpart of the pre-3/5 mid-review user abort. (A shutdown abort keeps the ref.)
    await waitFor(
      () => loadLoopState(repo, "clean").lastResult === "aborted",
      "the aborted landing to settle",
    );
    assert.ok(!fs.existsSync(markerFile), "the abort marker was consumed");
    assert.ok(!fs.existsSync(path.join(repo, "hello.txt")), "nothing landed on main");
    assert.equal(queueDepth(repo), 0, "the entry was dropped after the aborted landing");
    let refGone = false;
    try {
      sh(repo, "git", "rev-parse", "--verify", landingRefName("clean"));
    } catch {
      refGone = true; // a missing ref makes rev-parse --verify exit nonzero
    }
    assert.ok(refGone, "the pinned commit was discarded with the deliberate stop");

    // The landing, not the tick, was aborted: one land_failed, no tick_aborted, no second tick.
    const failed = readEvents(repo).filter((e) => e.type === "land_failed");
    assert.equal(failed.length, 1, "the aborted landing logged its failure");
    assert.equal(failed[0]!.result, "aborted");
    assert.equal(readEvents(repo).filter((e) => e.type === "tick_aborted").length, 0);
    assert.equal(loadLoopState(repo, "clean").ticks, 1);
  } finally {
    restore();
    await orch.stop();
  }
});

test("a role with a queued or in-flight landing never starts a new tick (interlock)", async () => {
  const repo = makeRepo();
  await initProject(repo, "interlock e2e test");
  // minTickInterval 0: the role is due on EVERY poll — only the interlock can hold it.
  saveConfig(repo, fastConfig(["clean"]));
  // Author run: first time a change, after that nothing to do. Review run: touch the marker,
  // then hang until the test's abort kills it — the landing stays in flight through the window.
  const hang = path.join(tmpdir(), "interlock-hang");
  const did = path.join(tmpdir(), "interlock-did");
  const restore = fakePi(
    [
      `for a in "$@"; do case "$a" in *"VERDICT:"*) touch '${hang}'; exec sleep 30;; esac; done`,
      `if [ -f '${did}' ]; then printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'; else touch '${did}'; printf '%s\n' '${assistantLine("done\nSUMMARY: add hello file")}'; fi`,
      `echo hello > hello.txt`,
    ].join("\n"),
  );
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    // The tick commits + enqueues; the landing slot picks the entry up and its reviewer hangs.
    await waitFor(
      () => loadLoopState(repo, "clean").lastResult === "queued",
      "the tick to enqueue its landing",
    );
    await waitFor(() => fs.existsSync(hang), "the landing's reviewer run to be in flight");

    // ~10 poll cycles pass with the role due on every one — yet no second tick starts: the
    // entry stays in the queue until the landing settles, and the interlock covers both the
    // queued and the in-flight phases with that one check.
    await new Promise((r) => setTimeout(r, 1_200));
    assert.equal(loadLoopState(repo, "clean").ticks, 1, "no second tick while its own landing is in flight");
    assert.equal(queueDepth(repo), 1, "the entry stays queued until the landing settles");

    // Settle the test: a deliberate stop kills the hung landing and drops its entry.
    const markerFile = abortRequestPath(repo, "clean");
    fs.mkdirSync(path.dirname(markerFile), { recursive: true });
    fs.writeFileSync(markerFile, JSON.stringify({ at: Date.now() }));
    await waitFor(
      () => loadLoopState(repo, "clean").lastResult === "aborted",
      "the aborted landing to settle",
    );
    assert.equal(queueDepth(repo), 0, "the entry drops with the aborted landing");
  } finally {
    restore();
    await orch.stop();
  }
});

test("a queue entry surviving a restart drains through the gate on next start", async () => {
  const repo = makeRepo();
  await initProject(repo, "restart drain e2e test");
  saveConfig(repo, fastConfig(["clean"]));
  // Review run approves; the role's own ticks find nothing to do.
  const restore = fakePi(
    [
      `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
      `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
    ].join("\n"),
  );
  // Seed exactly what a crash between commitAll and the landing's entry drop leaves behind:
  // one commit (a child of main's head, same full tree plus one file) reachable from the
  // role's branch, pinned by the landing ref, with its queue entry. The next start's drain
  // must land it through the gate.
  const gitIn = (args: string[], input: string) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", input }).trim();
  const blob = gitIn(["hash-object", "-w", "--stdin"], "crash survivor\n");
  // The parent's full tree plus the new file — a one-entry mktree would DELETE every other
  // file and the ff-merge would rightly refuse to overwrite the operator's checkout.
  const parentTree = sh(repo, "git", "ls-tree", "HEAD");
  const tree = gitIn(["mktree"], `${parentTree}\n100644 blob ${blob}\tcrash.txt\n`);
  const sha = gitIn(
    ["commit-tree", tree, "-p", sh(repo, "git", "rev-parse", "HEAD"), "-m", "tumwater(feature): crash survivor"],
    "",
  );
  sh(repo, "git", "update-ref", `refs/heads/${branchName("clean")}`, sha);
  sh(repo, "git", "update-ref", landingRefName("clean"), sha);
  enqueueLanding(repo, { role: "clean", sha, tick: 1, summary: "crash survivor", enqueuedAt: Date.now() });
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await waitFor(
      () => queueDepth(repo) === 0 && fs.existsSync(path.join(repo, "crash.txt")),
      "the surviving entry to drain onto main",
    );
    assert.equal(queueDepth(repo), 0, "the entry was consumed");
    assert.equal(
      readEvents(repo).filter((e) => e.type === "landed").length,
      1,
      "the surviving change landed through the gate",
    );
    assert.equal(
      readEvents(repo).filter((e) => e.type === "land_failed").length,
      0,
      "no failed landing",
    );
    assert.equal(loadLoopState(repo, "clean").commits, 1, "the landed change counts as one commit");
    let refGone = false;
    try {
      sh(repo, "git", "rev-parse", "--verify", landingRefName("clean"));
    } catch {
      refGone = true;
    }
    assert.ok(refGone, "the pin is deleted with a successful landing");
  } finally {
    restore();
    await orch.stop();
  }
});

test("an entry whose sha main already holds is dropped at the drain without a landing run", async () => {
  const repo = makeRepo();
  await initProject(repo, "dedup drain e2e test");
  saveConfig(repo, fastConfig(["clean"]));
  // Every reviewer run increments its own counter — a deduped drain must burn none of them.
  const rev = path.join(tmpdir(), "interlock-review-count");
  const did = path.join(tmpdir(), "dedup-did");
  const restore = fakePi(
    [
      `for a in "$@"; do case "$a" in *"VERDICT:"*) n=$(cat '${rev}' 2>/dev/null || echo 0); echo $((n+1)) > '${rev}'; printf '%s\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
      `if [ -f '${did}' ]; then printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'; else touch '${did}'; printf '%s\n' '${assistantLine("done\nSUMMARY: add hello file")}'; fi`,
      `echo hello > hello.txt`,
    ].join("\n"),
  );
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    // One real change lands end to end…
    await waitFor(
      () => loadLoopState(repo, "clean").lastResult === "changed" && fs.existsSync(path.join(repo, "hello.txt")),
      "the change to land on main",
    );
    // …and the crash-between-ff-and-drop residue is simulated: the same sha re-enqueued.
    const sha = sh(repo, "git", "rev-parse", "HEAD");
    enqueueLanding(repo, { role: "clean", sha, tick: 1, summary: "stale duplicate", enqueuedAt: Date.now() });
    await waitFor(() => queueDepth(repo) === 0, "the stale entry to be dropped");
    assert.equal(
      fs.readFileSync(rev, "utf8").trim(),
      "1",
      "exactly one reviewer run: the stale entry was deduped, not re-landed",
    );
    assert.equal(
      readEvents(repo).filter((e) => e.type === "landed").length,
      1,
      "no second landed event",
    );
    assert.equal(
      readEvents(repo).filter((e) => e.type === "land_failed").length,
      0,
      "the dedup drop logs no failure",
    );
  } finally {
    restore();
    await orch.stop();
  }
});

test("a torn queue-head file is dropped at the drain so the queue drains", async () => {
  // Seeds exactly what a hard crash mid-enqueueLanding leaves behind: a truncated queue
  // file that sorts before a live entry. headLanding reads null for the torn head and
  // nothing else drops it, so before the fix the live entry behind it never landed and
  // its role's interlock (a non-empty landingFor) held the role's ticks forever.
  const repo = makeRepo();
  await initProject(repo, "torn head drain e2e test");
  saveConfig(repo, fastConfig(["clean"]));
  // The review run approves; the role's own ticks never start — the interlock holds from
  // the first poll, because the entry is queued before the orchestrator starts.
  const restore = fakePi(
    [
      `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
      `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
    ].join("\n"),
  );
  // One real commit ahead of main (a child of main's head, full tree plus one file),
  // pinned and queued — the same construction the restart-drain test uses.
  const gitIn = (args: string[], input: string) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", input }).trim();
  const blob = gitIn(["hash-object", "-w", "--stdin"], "torn survivor\n");
  const parentTree = sh(repo, "git", "ls-tree", "HEAD");
  const tree = gitIn(["mktree"], `${parentTree}\n100644 blob ${blob}\ttorn.txt\n`);
  const sha = gitIn(
    ["commit-tree", tree, "-p", sh(repo, "git", "rev-parse", "HEAD"), "-m", "tumwater(feature): torn survivor"],
    "",
  );
  sh(repo, "git", "update-ref", `refs/heads/${branchName("clean")}`, sha);
  sh(repo, "git", "update-ref", landingRefName("clean"), sha);
  enqueueLanding(repo, { role: "clean", sha, tick: 1, summary: "torn survivor", enqueuedAt: Date.now() });
  // The torn file sorts BEFORE the live entry: an interrupted write of the same shape.
  fs.writeFileSync(path.join(landQueueDir(repo), "0000000000-000000-1.json"), '{"role": "clean", "sha": "abc');
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await waitFor(
      () => queueDepth(repo) === 0 && fs.existsSync(path.join(repo, "torn.txt")),
      "the live entry to drain behind the torn head",
    );
    assert.equal(
      readEvents(repo).filter((e) => e.type === "landed").length,
      1,
      "the live change landed through the gate",
    );
    assert.equal(
      readEvents(repo).filter((e) => e.type === "land_failed").length,
      0,
      "no failed landing",
    );
    assert.equal(
      readEvents(repo).filter((e) => e.type === "warning" && /land queue/.test(String(e.message))).length,
      1,
      "one harness warning for the torn head drop",
    );
  } finally {
    restore();
    await orch.stop();
  }
});

test("a landing whose pinned sha no longer exists degrades to an error outcome, not a throw", async () => {
  // The queue entry can outlive its commit: the pin ref is dropped or the dangling commit
  // gc'd while the entry waits (a crash between pin and drop, manual gc). landChange throws
  // on the uncheckable sha — the landQueuedEntry catch-all must turn that into a normal
  // "error" outcome with every bookkeeping step a real failure gets, instead of taking the
  // landing slot down with it.
  const repo = makeRepo();
  const sha = "0".repeat(40); // a commit git cannot check out
  enqueueLanding(repo, { role: "clean", sha, tick: 1, summary: "lost pin", enqueuedAt: Date.now() });
  const { entry, file } = headLanding(repo)!;
  const config = fastConfig(["clean"]);
  const author = new LoopRunner(repo, "clean", config, "main");

  const result = await landQueuedEntry(repo, entry, file, author, config, "main", new AbortController().signal);

  assert.equal(result, "error");
  // The git failure is recorded where the next tick's prompt reads it.
  assert.match(author.state.lastError ?? "", /invalid reference/);
  // The 4/5 in-flight marker is cleared, the entry dropped, and the failure logged —
  // the same tail a landed or rejected entry goes through.
  assert.ok(!fs.existsSync(landingStatePath(repo)), "the landing marker survives the error outcome");
  assert.equal(queueDepth(repo), 0, "the entry is dropped after the error outcome");
  const failed = readEvents(repo).filter((e) => e.type === "land_failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.loop, "clean");
  assert.equal(failed[0]?.result, "error");
  assert.equal(failed[0]?.commit, sha);
  assert.equal(readEvents(repo).filter((e) => e.type === "landed").length, 0);
  // The degraded outcome is persisted on the author's state, like any other tick result.
  assert.equal(loadLoopState(repo, "clean").lastResult, "error");
  assert.equal(loadLoopState(repo, "clean").lastError, author.state.lastError);
});

// --- abort requests (PLANS.md, abort plan): the marker-file plumbing that reaches LoopRunner's
// user-abort branch — consumption, kill, event, and the silent no-op shapes. The loop-level
// semantics themselves are pinned in test/loop.test.ts; the CLI side in test/cli.test.ts. ---

test("an abort request kills an in-flight tick, consumes its marker, and logs one event", async () => {
  const repo = makeRepo();
  await initProject(repo, "abort e2e test");
  // Only clean ticks; a long backoff so the aborted loop stays idle while the no-op cases
  // below are asserted (no second tick can start and muddy the event count).
  const cfg = defaultConfig();
  cfg.minTickIntervalSeconds = 0;
  cfg.idleBackoff = { initialSeconds: 30, factor: 1, maxSeconds: 30 };
  for (const id of Object.keys(cfg.roles)) cfg.roles[id]!.enabled = id === "clean";
  saveConfig(repo, cfg);
  // A slow fake pi: writes a half-done edit then hangs until killed — the tick is in flight
  // for as long as the marker sits on disk.
  const restore = fakePi(`echo partial > partial.txt\nexec sleep 30`);
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await waitFor(
      () => fs.existsSync(path.join(worktreePath(repo, "clean"), "partial.txt")),
      "a tick to be in flight",
    );

    // Reproduce what `tumwater abort --role clean` does from the CLI side: drop the per-role
    // marker. (The CLI path itself is covered in test/cli.test.ts.)
    const markerFile = abortRequestPath(repo, "clean");
    fs.mkdirSync(path.dirname(markerFile), { recursive: true });
    fs.writeFileSync(markerFile, JSON.stringify({ at: Date.now() }));

    // The fleet consumes the request within a poll cycle: kills the run and removes the marker.
    await waitFor(() => !fs.existsSync(markerFile), "the abort marker to be consumed");

    const aborted = () => readEvents(repo).filter((e) => e.type === "tick_aborted");
    assert.equal(aborted().length, 1, "exactly one tick_aborted event");
    assert.equal(aborted()[0]?.loop, "clean", "filed under the role's loop");

    // The killed run ends user_aborted: half-done work discarded (worktree reset to main),
    // backed off instead of resuming promptly.
    await waitFor(() => !loadLoopState(repo, "clean").running, "the aborted tick to finish");
    const s = loadLoopState(repo, "clean");
    assert.equal(s.lastResult, "user_aborted");
    assert.ok(!s.resumePending, "a deliberate stop leaves nothing to resume");
    assert.ok(
      !fs.existsSync(path.join(worktreePath(repo, "clean"), "partial.txt")),
      "half-done work was discarded",
    );
    assert.ok(s.nextRunAt > Date.now() + 29_000, "backed off, not immediate");

    // A request for a loop that is NOT running is a silent no-op: the marker is removed and
    // no event logged — clean itself (now idle in its backoff) …
    fs.writeFileSync(markerFile, JSON.stringify({ at: Date.now() }));
    await waitFor(() => !fs.existsSync(markerFile), "the idle-loop marker to be consumed");
    assert.equal(aborted().length, 1, "no event for an idle loop");

    // … and the same holds for a disabled role, which has no runner at all (the no-runner shape).
    for (const role of ["feature", "bugfix"]) {
      const m = abortRequestPath(repo, role);
      fs.mkdirSync(path.dirname(m), { recursive: true });
      fs.writeFileSync(m, JSON.stringify({ at: Date.now() }));
    }
    await waitFor(
      () => !fs.existsSync(abortRequestPath(repo, "feature")) && !fs.existsSync(abortRequestPath(repo, "bugfix")),
      "the disabled roles' markers to be consumed",
    );
    assert.equal(aborted().length, 1, "no event for a role with no runner");
  } finally {
    restore();
    await orch.stop();
  }
});

// --- Self-redeploy (src/redeploy.ts) wired into the scheduler ---

/** A Redeployer whose effects are scripted: main is always stale and green, the compile succeeds
 * at once, and the swap only records itself — so the orchestrator's half of the contract (hold,
 * drain, abort, exit) is what these tests pin. */
function scriptedRedeployer(
  repo: string,
  opts: { drainMaxMs?: number; compileOk?: boolean; stale?: () => boolean } = {},
) {
  const swaps: string[] = [];
  const deps: RedeployDeps = {
    staleness: async () => ({ stale: opts.stale ? opts.stale() : true, aheadCommits: 4 }),
    mainGreen: async () => true,
    compile: async () => ({ ok: opts.compileOk ?? true, detail: opts.compileOk === false ? "tsc exited 2" : "" }),
    swap: (h) => {
      swaps.push(h);
    },
  };
  // Events go to the repo's log exactly as cmdRun wires them, so the assertions below read the
  // same events.jsonl an operator would.
  const redeployer = new Redeployer(
    { sha: "0".repeat(40), builtAt: 1, root: "/proj" },
    true,
    deps,
    (e) => logEvent(repo, e),
    opts.drainMaxMs,
  );
  return { redeployer, swaps };
}

test("a stale self-hosted build drains the fleet, swaps, and returns restart", async () => {
  const repo = makeRepo();
  await initProject(repo, "self-redeploy test");
  saveConfig(repo, fastConfig(["clean"]));
  const restore = fakePi(`printf '%s\\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`);
  const { redeployer, swaps } = scriptedRedeployer(repo);
  // A prompt for the director sits in the inbox: while a restart is pending nothing new starts
  // — director included — so it must still be queued when the process hands over.
  enqueuePrompt(repo, "hello director");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const exit = await runOrchestrator({
      root: repo,
      config: loadConfig(repo),
      mainBranch: "main",
      signal: controller.signal,
      pollMs: FAST_POLL_MS,
      redeploy: redeployer,
    });
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
    clearTimeout(timeout);
    restore();
  }
});

test("the orchestrator publishes the build's staleness in orchestrator.json while it runs", async () => {
  const repo = makeRepo();
  await initProject(repo, "build status test");
  saveConfig(repo, fastConfig(["clean"]));
  const cfg = loadConfig(repo);
  cfg.autoRestart = false; // observe only: no drain, no restart
  saveConfig(repo, cfg);
  const restore = fakePi(`printf '%s\\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`);
  const { redeployer } = scriptedRedeployer(repo);
  const controller = new AbortController();
  const done = runOrchestrator({ root: repo, config: loadConfig(repo), mainBranch: "main", signal: controller.signal, pollMs: FAST_POLL_MS, redeploy: redeployer });
  try {
    await waitFor(() => readOrchestratorInfo(repo)?.build?.stale === true, "stale build published");
    const info = readOrchestratorInfo(repo)!;
    assert.equal(info.build?.sha, "0".repeat(40));
    assert.equal(info.build?.aheadCommits, 4);
    assert.equal(readEvents(repo).filter((e) => e.type === "restart_pending").length, 0, "autoRestart off: never drains");
    const start = readEvents(repo).find((e) => e.type === "orchestrator_start")!;
    assert.equal(start.build, "0".repeat(40), "the start event names the build");
  } finally {
    controller.abort();
    await done.catch(() => undefined);
    restore();
  }
});

test("a drain past its cap aborts the in-flight tick resumably and still restarts", async () => {
  const repo = makeRepo();
  await initProject(repo, "drain cap test");
  saveConfig(repo, fastConfig(["clean"]));
  // The tick never finishes on its own: only the drain cap (or a stop) can end it.
  const partial = path.join(worktreePath(repo, "clean"), "partial.txt");
  const restore = fakePi(`echo partial > partial.txt\nexec sleep 30`);
  // Staleness is re-evaluated only when main moves (a per-head verdict), so: let the first tick
  // start against a fresh build, then move main — the recomputation finds the build stale with
  // that tick in flight, which is exactly the situation the drain cap exists for.
  const { redeployer, swaps } = scriptedRedeployer(repo, { drainMaxMs: 500, stale: () => fs.existsSync(partial) });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const run = runOrchestrator({
      root: repo,
      config: loadConfig(repo),
      mainBranch: "main",
      signal: controller.signal,
      pollMs: FAST_POLL_MS,
      redeploy: redeployer,
    });
    await waitFor(() => fs.existsSync(partial), "the tick to start");
    sh(repo, "git", "commit", "-q", "--allow-empty", "-m", "main moves under a running tick");
    const exit = await run;
    assert.deepEqual(exit, { restart: true });
    assert.equal(swaps.length, 1);
    const ends = readEvents(repo).filter((e) => e.type === "tick_end");
    assert.equal(ends.length, 1);
    assert.equal(ends[0]!.result, "aborted", "the drain cap aborted the tick like a shutdown would");
    assert.equal(loadLoopState(repo, "clean").resumePending, true, "…so it resumes on the new build");
    const restart = readEvents(repo).find((e) => e.type === "restart")!;
    assert.equal(restart.abortedTicks, 1);
  } finally {
    clearTimeout(timeout);
    restore();
  }
});

test("an in-flight director tick is waited for, not aborted, when the drain window elapses", async () => {
  // The 2026-09-08 incident end to end: a human prompt outlives the drain cap. Role ticks are
  // aborted resumably at the cap; the director's tick must run to completion — no swap and no
  // abort until it finishes (BUGS.md).
  const repo = makeRepo();
  await initProject(repo, "director drain test");
  saveConfig(repo, fastConfig(["director"]));
  // The prompt's run outlives the window: it marks itself started (so staleness can flip while
  // it is in flight), then sleeps past the cap before answering.
  const marker = path.join(worktreePath(repo, "director"), "started.txt");
  const restore = fakePi(`touch started.txt\nsleep 2\nprintf '%s\\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`);
  const { redeployer, swaps } = scriptedRedeployer(repo, { drainMaxMs: 500, stale: () => fs.existsSync(marker) });
  enqueuePrompt(repo, "a long human prompt");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const run = runOrchestrator({
      root: repo,
      config: loadConfig(repo),
      mainBranch: "main",
      signal: controller.signal,
      pollMs: FAST_POLL_MS,
      redeploy: redeployer,
    });
    await waitFor(() => fs.existsSync(marker), "the director tick to start");
    sh(repo, "git", "commit", "-q", "--allow-empty", "-m", "main moves under a running prompt");
    const exit = await run;
    assert.deepEqual(exit, { restart: true });
    assert.equal(swaps.length, 1);
    const ends = readEvents(repo).filter((e) => e.type === "tick_end");
    assert.equal(ends.length, 1);
    assert.notEqual(ends[0]!.result, "aborted", "the director tick finished on its own — the hold waited it out");
    const restart = readEvents(repo).find((e) => e.type === "restart")!;
    assert.ok(Number(restart.drainedMs) > 500, `the hold ran past the drain window (${String(restart.drainedMs)}ms)`);
    assert.equal(restart.abortedTicks, 0);
  } finally {
    clearTimeout(timeout);
    restore();
  }
});

test("a failed compile leaves the fleet running the old build", async () => {
  const repo = makeRepo();
  await initProject(repo, "compile failure test");
  saveConfig(repo, fastConfig(["clean"]));
  const restore = fakePi(`printf '%s\\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`);
  const { redeployer, swaps } = scriptedRedeployer(repo, { compileOk: false });
  const controller = new AbortController();
  const done = runOrchestrator({ root: repo, config: loadConfig(repo), mainBranch: "main", signal: controller.signal, pollMs: FAST_POLL_MS, redeploy: redeployer });
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
    const before = readEvents(repo).filter((e) => e.type === "tick_start").length;
    await waitFor(() => readEvents(repo).filter((e) => e.type === "tick_start").length > before, "ticks resume after the hold lifts");
    assert.deepEqual(swaps, []);
  } finally {
    controller.abort();
    await done.catch(() => undefined);
    restore();
  }
});

// ── Merge queue 5/5 — the batch slot ─────────────────────────────────────────────────────

/** Seed the land queue with one pinned single-commit entry per role (queue order = argument
 * order), built the way pinAndReset leaves them: a commit off main under the landing ref.
 * Pre-seeding — instead of letting the roles tick the entries in — makes the drain's batch
 * deterministic: the slot sees BOTH entries on its first poll, before any tick can race it. */
async function seedLandQueue(
  repo: string,
  ...args: string[]
): Promise<void> {
  // An optional leading "2" tag distinguishes a role's second change (the cap test's phase 2
  // re-seeds the same roles on a moved main): same file + same content would be an empty commit.
  let roles = args;
  let tag = "";
  if (args.length > 1 && args[0] === "2") {
    tag = "2";
    roles = args.slice(1);
  }
  // The seed commits must not swallow the live config: initProject's initial commit tracks
  // tumwater.json, and any `reset --hard main` in the seed loop below resurrects the committed
  // copy over a live user edit — the cap test saves a new config between phases and would
  // silently read the old one. Untrack it on main (commit the deletion) and ignore it, the
  // way real projects keep a live config out of the tree; the untrack must land on main
  // BEFORE the loop, since a bare `rm --cached` would be undone by the first reset --hard.
  const gi = path.join(repo, ".gitignore");
  const existing = fs.existsSync(gi) ? fs.readFileSync(gi, "utf8") : "";
  if (!existing.split("\n").includes("tumwater.json")) {
    fs.writeFileSync(gi, existing + "tumwater.json\n");
  }
  try {
    // Commit the .gitignore alongside the untrack: if main tracks the ignore rule, every later
    // checkout/reset round trip keeps it in the worktree, and the live config stays an ignored
    // untracked file instead of being deleted (checkout drops a tracked .gitignore on a branch
    // that lacks it, un-ignoring and then removing the file it guarded).
    sh(repo, "git", "add", ".gitignore");
    sh(repo, "git", "rm", "--cached", "tumwater.json");
    sh(repo, "git", "commit", "-m", "untrack live config");
  } catch {
    // Not tracked — the gitignore line above still keeps future `add -A`s from swallowing it.
  }
  sh(repo, "git", "checkout", "--detach");
  for (const role of roles) {
    // Each pin stands alone on main: the two queued landings are independent changes.
    sh(repo, "git", "reset", "--hard", "main");
    fs.writeFileSync(path.join(repo, `${role}${tag}.txt`), `${role}${tag}\n`);
    sh(repo, "git", "add", "-A");
    sh(repo, "git", "commit", "-m", `${role}${tag} work`);
    const sha = sh(repo, "git", "rev-parse", "HEAD").trim();
    await setRef(repo, landingRefName(role), sha);
    enqueueLanding(repo, { role, sha, tick: 1, summary: `${role}${tag} work`, enqueuedAt: Date.now() });
  }
  sh(repo, "git", "checkout", "main");
}

test("the drain coalesces two queued landings into one batch: one shared check, one fast-forward", async () => {
  const repo = makeRepo();
  await initProject(repo, "batch drain e2e test");
  saveConfig(repo, fastConfig(["clean", "dry"]));
  await seedLandQueue(repo, "clean", "dry");
  // The project's declared check, counting its runs — the batching proof: a coalesced batch
  // runs gate, gate, BATCH (3 runs). Two sequential single landings would run gate, gate,
  // LANDING (the second landing's in-lock re-check after main moved under it).
  const count = path.join(tmpdir(), "batch-checkcount");
  const tool = path.join(repo, "node_modules", ".bin", "buildcheck-tool");
  fs.mkdirSync(path.dirname(tool), { recursive: true });
  fs.writeFileSync(tool, `#!/bin/sh\necho $(( $(cat ${count} 2>/dev/null || echo 0) + 1 )) > ${count}\necho ok\n`);
  fs.chmodSync(tool, 0o755);
  fs.writeFileSync(
    path.join(repo, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { build: "buildcheck-tool" } }),
  );
  // Review runs: approve. Author runs (after the landing frees the roles): nothing to do.
  const restore = fakePi(
    [
      `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
      `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
    ].join("\n"),
  );
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    const seed = sh(repo, "git", "rev-parse", "main");
    await waitFor(
      () =>
        loadLoopState(repo, "clean").lastResult === "changed" && loadLoopState(repo, "dry").lastResult === "changed",
      "both batched changes to land",
      60_000,
    );
    assert.equal(sh(repo, "git", "rev-list", "--count", `${seed}..main`), "2", "both changes are on main");
    assert.equal(queueDepth(repo), 0, "both entries drained");
    assert.equal(await refSha(repo, landingRefName("clean")), null, "clean's ref went");
    assert.equal(await refSha(repo, landingRefName("dry")), null, "dry's ref went");
    const landed = readEvents(repo).filter((e) => e.type === "landed");
    assert.equal(landed.length, 2, "one landed event per change");
    assert.equal(readEvents(repo).filter((e) => e.type === "merged").length, 2);
    const checks = readEvents(repo).filter((e) => e.type === "build_check");
    // The orchestrator also seeds the green baseline (scope "baseline") somewhere in the
    // middle, so assert counts, not positions: the coalescing proof is that there is ONE
    // shared "batch" check and NO per-landing in-lock "landing" re-check — two sequential
    // single landings would have produced one.
    assert.equal(checks.filter((e) => e.scope === "gate").length, 2, "one gate pre-check per change");
    assert.equal(checks.filter((e) => e.scope === "batch").length, 1, "ONE shared batch check over the stacked tree");
    assert.equal(checks.filter((e) => e.scope === "landing").length, 0, "no in-lock per-landing re-check");
    assert.ok(checks.every((e) => e.status === "passed"));
  } finally {
    restore();
    await orch.stop();
  }
});

test("an abort for a NON-HEAD batched role kills the whole batch and discards every pinned ref", async () => {
  const repo = makeRepo();
  await initProject(repo, "batch abort e2e test");
  // A long minimum interval: nothing re-ticks while the test asserts the aftermath.
  const cfg = fastConfig(["clean", "dry"]);
  cfg.minTickIntervalSeconds = 300;
  saveConfig(repo, cfg);
  await seedLandQueue(repo, "clean", "dry");
  // The head's reviewer run touches the marker and then hangs — the batch stays in flight
  // until the abort kills it.
  const marker = path.join(tmpdir(), "batch-reviewing");
  const restore = fakePi(
    `for a in "$@"; do case "$a" in *"VERDICT:"*) touch '${marker}'; exec sleep 30;; esac; done`,
  );
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await waitFor(() => fs.existsSync(marker), "the batch's head reviewer run to be in flight", 60_000);
    // What `tumwater abort --role dry` does from the CLI side: a marker for the SECOND
    // batched role — the one that has never even started its gate. Before 5/5 this request
    // could only match the head's landing; now it matches ANY batched role and kills the
    // whole slot unit.
    const markerFile = abortRequestPath(repo, "dry");
    fs.mkdirSync(path.dirname(markerFile), { recursive: true });
    fs.writeFileSync(markerFile, JSON.stringify({ at: Date.now() }));

    await waitFor(
      () =>
        loadLoopState(repo, "clean").lastResult === "aborted" && loadLoopState(repo, "dry").lastResult === "aborted",
      "the aborted batch to settle",
      60_000,
    );
    assert.ok(!fs.existsSync(markerFile), "the abort marker was consumed");
    assert.ok(!fs.existsSync(path.join(repo, "clean.txt")), "nothing landed on main");
    assert.equal(queueDepth(repo), 0, "both entries were dropped");
    for (const role of ["clean", "dry"]) {
      let gone = false;
      try {
        sh(repo, "git", "rev-parse", "--verify", landingRefName(role));
      } catch {
        gone = true;
      }
      assert.ok(gone, `${role}'s pinned commit was discarded — dry's only goes in the batch's ref-discard loop`);
    }
    const failed = readEvents(repo).filter((e) => e.type === "land_failed");
    assert.equal(failed.length, 2, "one land_failed per batched change");
    assert.ok(failed.every((e) => e.result === "aborted"));
    assert.equal(readEvents(repo).filter((e) => e.type === "tick_aborted").length, 0, "no tick was running");
    assert.equal(loadLoopState(repo, "clean").ticks, 0, "the interlock held: no tick ever started");
    assert.equal(loadLoopState(repo, "dry").ticks, 0);
  } finally {
    restore();
    await orch.stop();
  }
});

test("landBatchMax caps the stack and live-reloads: five queue as 3+2 batches, then singles at cap 1", async () => {
  const repo = makeRepo();
  await initProject(repo, "batch cap e2e test");
  const cfg = fastConfig(["feature", "bugfix", "clean", "dry", "perf"]);
  cfg.minTickIntervalSeconds = 300; // landings never tick; the seeded-queue drive needs no author runs
  saveConfig(repo, cfg);
  await seedLandQueue(repo, "feature", "bugfix", "clean", "dry", "perf");
  const count = path.join(tmpdir(), "cap-checkcount");
  const tool = path.join(repo, "node_modules", ".bin", "buildcheck-tool");
  fs.mkdirSync(path.dirname(tool), { recursive: true });
  fs.writeFileSync(tool, `#!/bin/sh\necho $(( $(cat ${count} 2>/dev/null || echo 0) + 1 )) > ${count}\necho ok\n`);
  fs.chmodSync(tool, 0o755);
  fs.writeFileSync(
    path.join(repo, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { build: "buildcheck-tool" } }),
  );
  const restore = fakePi(
    [
      `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
      `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
    ].join("\n"),
  );
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  const scopeCounts = () => {
    const checks = readEvents(repo).filter((e) => e.type === "build_check");
    return {
      gate: checks.filter((e) => e.scope === "gate").length,
      batch: checks.filter((e) => e.scope === "batch").length,
      landing: checks.filter((e) => e.scope === "landing").length,
      merged: readEvents(repo).filter((e) => e.type === "merged").length,
    };
  };
  try {
    // Phase 1: the default cap 3 lands five queued changes as two batches (3 + 2).
    // Count the landed events, not lastResult: the roles' first ticks (minTick 300 defers
    // only the second) run right after the landing and overwrite lastResult with no_change.
    await waitFor(
      () => readEvents(repo).filter((e) => e.type === "landed").length >= 5 && queueDepth(repo) === 0,
      "all five to land",
      60_000,
    );
    let s = scopeCounts();
    assert.equal(s.batch, 2, "cap 3: one shared check per batch, two batches");
    assert.equal(s.gate, 5, "one gate pre-check per change, in both batches");
    assert.equal(s.landing, 0, "the batch path never re-checks per landing");
    assert.equal(s.merged, 5, "one merged event per change");
    // The acceptance criterion: the batch-landed tip is green-seeded, so a baseline check
    // against the new main is a cache hit, not another script run. (The single path's
    // in-lock check seeds too — but no single has landed yet, and the ticks are deferred, so
    // this hit can only come from the batch's noteGreenBaseline.)
    const runsBefore = Number(fs.readFileSync(count, "utf8"));
    await checkMainBaseline(repo);
    assert.equal(Number(fs.readFileSync(count, "utf8")), runsBefore, "the stacked tip is green-seeded: no re-run");

    // Phase 2: cap 1, LIVE — no restart: the next drain reads the reloaded config and takes
    // the single path, where each landing re-checks in lock (main moved under every pin).
    saveConfig(repo, { ...cfg, landBatchMax: 1 });
    await seedLandQueue(repo, "2", "feature", "bugfix", "clean");
    await waitFor(
      () => readEvents(repo).filter((e) => e.type === "landed").length >= 8 && queueDepth(repo) === 0,
      "the singles to land",
      60_000,
    );
    s = scopeCounts();
    assert.equal(s.batch, 2, "cap 1: the new landings took the single path — no third batch check");
    assert.equal(s.gate, 8, "the singles each gated");
    // The first single's pin sits directly on current main: its rebase is a no-op, its check
    // is skipped, and it ff-lands for free — the cheap path the single flow gives a change
    // whose turn arrived while main was already at its base. Singles 2-3 are behind the moved
    // main: real rebase, re-check in lock.
    assert.equal(s.landing, 2, "each single behind main re-checked in lock");
    assert.equal(s.merged, 8);
  } finally {
    restore();
    await orch.stop();
  }
});
