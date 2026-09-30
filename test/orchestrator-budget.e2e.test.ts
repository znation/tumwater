/** The daily cost budget gate's e2e tier slice (extracted from orchestrator-2.e2e.test.ts):
 * the cap pausing role ticks while the director keeps going, a pre-spent cap starting no role
 * ticks, the fallback free model that takes over instead of stopping the fleet, and the
 * fallback's refusal/demotion behavior (plans/daily-cost-budget.md, plans/fallback-model.md).
 * Like the other topic-named orchestrator files (orchestrator-resize, orchestrator-permits,
 * orchestrator-pause), this file holds one coherent topic; the tier's balanced slices are
 * orchestrator-2/3.e2e.test.ts. Each test file gets its own process — and its own PATH, which
 * fakePi's global PATH swap requires. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, saveConfig } from "../src/config.js";
import { runOrchestrator } from "../src/orchestrator.js";
import { snapshot } from "../src/ui/status.js";
import { initProject } from "../src/init.js";
import { enqueuePrompt } from "../src/inbox.js";
import { readEvents } from "../src/events.js";
import { freshLoopState, loadLoopState, saveLoopState } from "../src/loop-state.js";
import { readOrchestratorInfo } from "../src/fleet-state.js";
import { todayStamp } from "../src/budget.js";
import { eventsOfType } from "./log-fixtures.js";
import { awaitSettledTick, fastConfig, startLiveOrchestrator, stopOrchestrator } from "./orchestrator-fixtures.js";
import { landWork, makeRepo, sh, tmpdir } from "./repo-fixtures.js";
import { fakePi, fakePiIdle, recordingFakePi } from "./fake-pi.js";
import { waitFor } from "./wait.js";
import { assistantLine } from "./pi-events.js";

const FAST_POLL_MS = 100;

// --- Daily cost budget gate (plans/daily-cost-budget.md) ---

test("a reached daily cap pauses role ticks but not the director; raising the cap resumes", async () => {
  const repo = makeRepo();
  await initProject(repo, "budget gate e2e test");
  // Tiny cap: exactly one fake run's cost. After clean's first tick the fleet has spent
  // $1 >= $0.50, so every later poll reads budget-paused until the cap is raised live.
  const config = fastConfig(["clean", "director"]);
  config.maxDailyCostUsd = 0.5;
  saveConfig(repo, config);
  const restore = fakePiIdle({ cost: 1 });
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    // clean's startup tick lands the first spend; the transition is logged exactly once,
    // harness-level, with the spend and cap that triggered it.
    await awaitSettledTick(repo, "clean", 1, "the startup tick to finish");
    await waitFor(() => readEvents(repo).some((e) => e.type === "budget_paused"), "a budget_paused event");
    const paused = eventsOfType(repo, "budget_paused");
    assert.equal(paused.length, 1, "one transition event per pause");
    assert.equal(paused[0]?.loop, "harness");
    assert.equal(paused[0]?.capUsd, 0.5);
    // The spend is the fake run's cost folded into clean's daily window — not just its
    // lifetime totalCostUsd (which would also read $1 here, but from a different field).
    assert.equal(paused[0]?.spentUsd, 1);

    // The same figures are published in the orchestrator info file for the dashboards
    // (BUGS.md 2026-09-30): the gate's own pair, summed over the live runner states, which
    // the persisted loop-state file can lag while a tick is in flight.
    assert.deepEqual(readOrchestratorInfo(repo)?.budget, { spentUsd: 1, capUsd: 0.5 });

    // The paused role starts no new ticks even though its schedule says to run: wait well
    // past nextRunAt plus several (fast) poll cycles — an ungated loop would have ticked by then.
    const scheduled = loadLoopState(repo, "clean").nextRunAt;
    await waitFor(() => Date.now() >= scheduled + 1500, "the schedule to pass while paused");
    assert.equal(loadLoopState(repo, "clean").ticks, 1, "a budget-paused role starts no new ticks");

    // The director is exempt: a queued human prompt still runs while the fleet is paused.
    enqueuePrompt(repo, "steer me while the fleet is paused");
    await awaitSettledTick(repo, "director", 1, "the director to tick while budget-paused");
    assert.equal(loadLoopState(repo, "clean").ticks, 1, "still paused after the director's run");

    // Raising the cap live resumes within a poll cycle: one transition event, then the role
    // ticks again. The director's spend counts toward the fleet total ($2 now), so this also
    // proves resume is about the cap, not a reset of the daily window.
    const raised = fastConfig(["clean", "director"]);
    raised.maxDailyCostUsd = 100;
    saveConfig(repo, raised);
    await waitFor(() => readEvents(repo).some((e) => e.type === "budget_resumed"), "a budget_resumed event");
    const resumed = eventsOfType(repo, "budget_resumed");
    assert.equal(resumed.length, 1, "one transition event per resume");
    assert.equal(resumed[0]?.loop, "harness");
    assert.equal(resumed[0]?.capUsd, 100);
    // clean is deferrable and no work has landed since its first tick — a work commit supplies
    // the wake for the post-resume tick.
    landWork(repo);
    await awaitSettledTick(repo, "clean", 2, "the paused role to tick again after the cap raise");

    // Exactly one of each transition for the whole run — no per-poll event spam.
    assert.equal(eventsOfType(repo, "budget_paused").length, 1);
    assert.equal(eventsOfType(repo, "budget_resumed").length, 1);
  } finally {
    await stopOrchestrator(orch, restore);
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
  const restore = fakePiIdle({ cost: 1 });
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    // The loop is schedule-eligible (fresh state, nextRunAt 0) — an ungated fleet would have
    // ticked within the first poll. Several (fast) poll cycles pass with no role tick starting.
    await waitFor(() => readOrchestratorInfo(repo) !== null, "orchestrator state file");
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(loadLoopState(repo, "clean").ticks, 0, "a fleet at cap starts no role ticks");
    // The pause is announced exactly once, with the spend and cap that closed the gate.
    const paused = eventsOfType(repo, "budget_paused");
    assert.equal(paused.length, 1);
    assert.equal(paused[0]?.capUsd, 1);
    assert.equal(paused[0]?.spentUsd, 1);
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

test("a main-moved wake while budget-paused stays blocked", async () => {
  const repo = makeRepo();
  await initProject(repo, "budget main-move test");
  // Tiny cap: clean's startup tick spends $1 >= $0.50 and pauses the fleet.
  const config = fastConfig(["clean"]);
  config.maxDailyCostUsd = 0.5;
  saveConfig(repo, config);
  const restore = fakePiIdle({ cost: 1 });
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await awaitSettledTick(repo, "clean", 1, "the startup tick to finish");
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
    await stopOrchestrator(orch, restore);
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
    const fallback = eventsOfType(repo, "budget_fallback");
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
    await awaitSettledTick(repo, "clean", 2, "a role tick after the cap was reached");
    assert.match(
      runs().find((l) => l.includes("session=tumwater-clean-2")) ?? "",
      /model=local-free provider=local/,
      "the role loop keeps ticking, on the cost n/a fallback",
    );

    // The director is outside the gate in both directions: an explicit human prompt outranks
    // the autonomous-spend cap, so it keeps the budgeted model.
    enqueuePrompt(repo, "steer me after the budget is spent");
    await awaitSettledTick(repo, "director", 1, "the director to tick after the switch");
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
    await stopOrchestrator(orch, restore);
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
  const restore = fakePiIdle({ cost: 1 });
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS, writeFallbackModels());
  try {
    await awaitSettledTick(repo, "clean", 1, "the startup tick to finish");
    await waitFor(() => readEvents(repo).some((e) => e.type === "budget_paused"), "a budget_paused event");
    // The event names the refused pair: why the fleet stopped instead of switching is the one
    // thing the operator can act on.
    const paused = eventsOfType(repo, "budget_paused");
    assert.equal(paused[0]?.fallbackRejected, "local/typo-free");
    assert.ok(!readEvents(repo).some((e) => e.type === "budget_fallback"));

    // And it really is paused: several poll cycles past its schedule, no second tick.
    landWork(repo);
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(loadLoopState(repo, "clean").ticks, 1, "a refused fallback leaves the fleet paused");
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

// The fallback breaker (BUGS.md 2026-09-20): a free pair is not a usable fallback when its
// backend cannot serve. On 2026-09-19 oMLX, priced at zero and up but pinned at its Metal
// ceiling, failed 33 of 33 fallback ticks for an hour instead of the fleet pausing.
test("a free fallback whose ticks keep failing is demoted to a pause, then probed back once it serves", async () => {
  const repo = makeRepo();
  await initProject(repo, "budget fallback breaker test");
  const config = fastConfig(["clean"]);
  config.maxDailyCostUsd = 0.5;
  config.provider = "paid";
  config.model = "big-paid";
  config.fallbackModel = { provider: "local", model: "local-free" };
  saveConfig(repo, config);
  const dir = tmpdir("fallback-breaker-");
  const healed = path.join(dir, "healed");
  const argsFile = path.join(dir, "argv.log");
  // The 2026-09-19 backend: the free model answers every prompt with the prefill guard's 400
  // until the test "heals" it; the paid model serves normally (and spends the budget).
  const restore = fakePi(
    [
      `m=""; n=""`,
      `while [ $# -gt 0 ]; do case "$1" in --model) m="$2";; -n) n="$2";; esac; shift; done`,
      `echo "run: model=$m session=$n" >> "${argsFile}"`,
      `if [ "$m" = "local-free" ] && [ ! -f "${healed}" ]; then`,
      `  echo 'HTTP 400: oMLX prefill memory guard rejected this prompt (prefill_memory_exceeded)' >&2`,
      `  exit 1`,
      `fi`,
      `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO", { cost: 1 })}'`,
    ].join("\n"),
  );
  const models = writeFallbackModels();
  const controller = new AbortController();
  // Two failures trip it and a 1.5 s cool-down fits the probe in the test; production's policy
  // (3 failures, 5 → 30 min) is pinned in budget.test.ts.
  const done = runOrchestrator({
    root: repo,
    config: loadConfig(repo),
    mainBranch: "main",
    signal: controller.signal,
    pollMs: FAST_POLL_MS,
    modelsPath: models,
    fallbackBreakerPolicy: { failureLimit: 2, cooldownMs: 1500, maxCooldownMs: 1500 },
  });
  const clean = () => loadLoopState(repo, "clean");
  const runFor = (tick: number): string => {
    const log = fs.existsSync(argsFile) ? fs.readFileSync(argsFile, "utf8") : "";
    return log.split("\n").find((l) => l.includes(`session=tumwater-clean-${tick}`)) ?? "";
  };
  try {
    // The startup tick spends $1 of the $0.50 cap on the paid pair: the free fallback takes over.
    await waitFor(() => readEvents(repo).some((e) => e.type === "budget_fallback"), "the switch to the fallback");
    // Two fallback ticks, both rejected. Main-moved wakes supply them: an errored loop backs off
    // 30 s, and a main move wakes it early.
    landWork(repo);
    await waitFor(() => clean().ticks >= 2 && !clean().running, "the first fallback tick");
    assert.equal(clean().lastResult, "error");
    assert.match(runFor(2), /model=local-free/);
    landWork(repo);
    await waitFor(() => readEvents(repo).some((e) => e.type === "budget_paused"), "the demotion to a pause");
    assert.equal(clean().ticks, 3);

    // One transition event naming the demoted pair and the evidence — not a refusal: the price
    // was fine, the backend was not.
    const paused = eventsOfType(repo, "budget_paused");
    assert.equal(paused.length, 1, "one transition event per demotion");
    assert.equal(paused[0]?.fallbackDemoted, "local/local-free");
    assert.equal(paused[0]?.failures, 2);
    assert.equal(paused[0]?.fallbackRejected, undefined);
    // Published for observers, so the dashboards stop advertising the dead fallback.
    assert.equal(readOrchestratorInfo(repo)?.fallbackDemoted?.pair, "local/local-free");
    assert.equal(snapshot(repo, models).budget.fallback, null, "the dashboards read budget paused");

    // Paused means paused: a main move during the cool-down starts no role tick.
    landWork(repo);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(clean().ticks, 3, "no role tick starts while the fallback is demoted");

    // The backend recovers. After the cool-down one probe tick finds out, the breaker closes, and
    // the fleet is back on the fallback — no restart and no config edit needed.
    fs.writeFileSync(healed, "");
    await waitFor(
      () => eventsOfType(repo, "budget_fallback").length >= 2,
      "the probe to restore the fallback",
    );
    assert.equal(clean().ticks, 4, "one probe tick restored it");
    assert.match(runFor(4), /model=local-free/, "the probe runs on the free pair, never the spent one");
    assert.equal(readOrchestratorInfo(repo)?.fallbackDemoted, undefined, "the demotion is withdrawn");
    assert.deepEqual(snapshot(repo, models).budget.fallback, { provider: "local", model: "local-free" });
  } finally {
    restore();
    controller.abort();
    await done.catch(() => {});
  }
});
