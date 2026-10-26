/** The daily cost budget gate's e2e tier slice (extracted from orchestrator-2.e2e.test.ts):
 * the cap pausing role runs while the director keeps going, a pre-spent cap starting no role
 * runs, the fallback free model that takes over instead of stopping the team, and the
 * fallback's refusal/demotion behavior (plans/daily-cost-budget.md, plans/fallback-model.md).
 * Like the other topic-named orchestrator files (orchestrator-resize, orchestrator-permits,
 * orchestrator-pause), this file holds one coherent topic; the tier's balanced slices are
 * orchestrator-2/3.e2e.test.ts. Each test file gets its own process — and its own PATH, which
 * fakePi's global PATH swap requires. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { saveConfig } from "../src/config/config.js";
import type { TumwaterConfig } from "../src/config/config-schema.js";
import { snapshot } from "../src/status/status-data.js";
import { initProject } from "../src/init/init.js";
import { enqueuePrompt } from "../src/inbox/inbox.js";
import { readEvents } from "../src/events/event-read.js";
import { freshRunnerState, saveRunnerState } from "../src/runner/runner-state.js";
import { loadRunnerState } from "../src/runner/runner-state-load.js";
import { readOrchestratorInfo } from "../src/team/orchestrator-info.js";
import { todayStamp } from "../src/budget/budget.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";
import { awaitSettledRun, fastConfig, runRepoOrchestrator, startLiveOrchestrator, stopOrchestrator } from "./fixtures/orchestrator-fixtures.js";
import { mergeWork, makeRepo, sh, tmpdir } from "./fixtures/repo-fixtures.js";
import { fakeClaudeReplay } from "./fakes/fake-claude.js";
import { writeClaudeAccount } from "../src/agent/claude/claude-account.js";
import { fakePi, fakePiIdle, logFlagsTo, readRunLines, recordingFakePi, TOUCH_SESSION } from "./fakes/fake-pi.js";
import { sleep, waitFor } from "./helpers/wait.js";
import { assistantLine } from "./fixtures/pi-events.js";

const FAST_POLL_MS = 100;

// --- Daily cost budget gate (plans/daily-cost-budget.md) ---

test("a reached daily cap pauses role runs but not the director; raising the cap resumes", async () => {
  const repo = makeRepo();
  await initProject(repo, "budget gate e2e test");
  // Tiny cap: exactly one fake run's cost. After clean's first run the team has spent
  // $1 >= $0.50, so every later poll reads budget-paused until the cap is raised live.
  const config = fastConfig(["clean", "director"]);
  config.maxDailyCostUsd = 0.5;
  saveConfig(repo, config);
  const restore = fakePiIdle({ cost: 1 });
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    // clean's startup run records the first spend; the transition is logged exactly once,
    // harness-level, with the spend and cap that triggered it.
    await awaitSettledRun(repo, "clean", 1, "the startup run to finish");
    await waitFor(() => readEvents(repo).some((e) => e.type === "budget_paused"), "a budget_paused event");
    const paused = eventsOfType(repo, "budget_paused");
    assert.equal(paused.length, 1, "one transition event per pause");
    assert.equal(paused[0]?.source, "tumwater");
    assert.equal(paused[0]?.capUsd, 0.5);
    // The spend is the fake run's cost folded into clean's daily window — not just its
    // lifetime totalCostUsd (which would also read $1 here, but from a different field).
    assert.equal(paused[0]?.spentUsd, 1);

    // The same figures are published in the orchestrator info file for the dashboards
    // (BUGS.md 2026-09-30): the gate's own pair, summed over the live runner states, which
    // the persisted runner-state file can lag while a run is in flight.
    assert.deepEqual(readOrchestratorInfo(repo)?.budget, { spentUsd: 1, capUsd: 0.5 });

    // The paused role starts no new runs even though its schedule says to run: wait well
    // past nextRunAt plus several (fast) poll cycles — an ungated role would have run by then.
    const scheduled = loadRunnerState(repo, "clean").nextRunAt;
    await waitFor(() => Date.now() >= scheduled + 1500, "the schedule to pass while paused");
    assert.equal(loadRunnerState(repo, "clean").runs, 1, "a budget-paused role starts no new runs");

    // The director is exempt: a queued human prompt still runs while the team is paused.
    enqueuePrompt(repo, "steer me while the team is paused");
    await awaitSettledRun(repo, "director", 1, "the director to run while budget-paused");
    assert.equal(loadRunnerState(repo, "clean").runs, 1, "still paused after the director's run");

    // Raising the cap live resumes within a poll cycle: one transition event, then the role
    // runs again. The director's spend counts toward the team total ($2 now), so this also
    // proves resume is about the cap, not a reset of the daily window.
    const raised = fastConfig(["clean", "director"]);
    raised.maxDailyCostUsd = 100;
    saveConfig(repo, raised);
    await waitFor(() => readEvents(repo).some((e) => e.type === "budget_resumed"), "a budget_resumed event");
    const resumed = eventsOfType(repo, "budget_resumed");
    assert.equal(resumed.length, 1, "one transition event per resume");
    assert.equal(resumed[0]?.source, "tumwater");
    assert.equal(resumed[0]?.capUsd, 100);
    // clean is deferrable and no work has merged since its first run — a work commit supplies
    // the wake for the post-resume run.
    mergeWork(repo);
    await awaitSettledRun(repo, "clean", 2, "the paused role to run again after the cap raise");

    // Exactly one of each transition for the whole run — no per-poll event spam.
    assert.equal(eventsOfType(repo, "budget_paused").length, 1);
    assert.equal(eventsOfType(repo, "budget_resumed").length, 1);
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

// AC3's two startup/wake clauses (plans/daily-cost-budget.md): the gate also blocks a team
// that is ALREADY at cap when the orchestrator starts, and it holds main-moved wakes while
// paused — both are "no run starts" guarantees, so they assert absence across several polls.

test("startup with spend already at the cap starts no role runs", async () => {
  const repo = makeRepo();
  await initProject(repo, "budget startup test");
  // Tiny cap: the pre-seeded window ($1) already reaches it before any run runs.
  const config = fastConfig(["clean"]);
  config.maxDailyCostUsd = 1;
  saveConfig(repo, config);
  // A team that spent its budget on an earlier run of the harness today: seed clean's daily
  // window at the cap so the gate is closed from the very first poll.
  const s = freshRunnerState("clean");
  s.dayStamp = todayStamp();
  s.dayCostUsd = 1;
  saveRunnerState(repo, s);
  const restore = fakePiIdle({ cost: 1 });
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    // The role is schedule-eligible (fresh state, nextRunAt 0) — an ungated team would have
    // ran within the first poll. Several (fast) poll cycles pass with no role run starting.
    await waitFor(() => readOrchestratorInfo(repo) !== null, "orchestrator state file");
    await sleep(600);
    assert.equal(loadRunnerState(repo, "clean").runs, 0, "a team at cap starts no role runs");
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
  // Tiny cap: clean's startup run spends $1 >= $0.50 and pauses the team.
  const config = fastConfig(["clean"]);
  config.maxDailyCostUsd = 0.5;
  saveConfig(repo, config);
  const restore = fakePiIdle({ cost: 1 });
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await awaitSettledRun(repo, "clean", 1, "the startup run to finish");
    await waitFor(() => readEvents(repo).some((e) => e.type === "budget_paused"), "a budget_paused event");

    // The world changed: advance main. An ungated team would wake clean early ("main moved")…
    fs.writeFileSync(path.join(repo, "world.txt"), "changed\n");
    sh(repo, "git", "add", "-A");
    sh(repo, "git", "commit", "-m", "advance main while paused");

    // …but the gate skips role runners before eligibility is even evaluated: several (fast)
    // poll cycles pass with no run and no wake event.
    await sleep(600);
    assert.equal(loadRunnerState(repo, "clean").runs, 1, "a main move cannot wake a budget-paused team");
    assert.ok(!readEvents(repo).some((e) => e.type === "wake"), "no wake logged for the blocked main move");
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

// --- The cost n/a fallback model (plans/fallback-model.md): the budget gate's third state.
// Where the team used to stop at its cap, a configured free model takes over instead. ---

/** pi's model definitions as the fallback tests need them: one priced provider (what the
 * team spends its budget on) and one zero-cost provider (what it falls back to). */
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

/** The fallback tests' standard config: fastConfig for the given roles plus the tiny cap and
 * paid-primary/free-fallback pair that writeFallbackModels() defines. One fake run costs $1,
 * so the startup run closes the $0.50 gate. `fallbackModel` overrides the free pair for the
 * refusal case, which names an unlisted model on purpose. */
function fallbackConfig(
  roles: string[],
  fallbackModel: TumwaterConfig["fallbackModel"] = { provider: "local", model: "local-free" },
): TumwaterConfig {
  const config = fastConfig(roles);
  config.maxDailyCostUsd = 0.5;
  config.provider = "paid";
  config.model = "big-paid";
  config.fallbackModel = fallbackModel;
  return config;
}

test("a reached cap switches roles to the free fallback model instead of stopping them", async () => {
  const repo = makeRepo();
  await initProject(repo, "budget fallback e2e test");
  // Tiny cap: exactly one fake run's cost, so clean's startup run closes the gate.
  const config = fallbackConfig(["clean", "director"]);
  // A role pinned to its own paid model: the switch must drop that override too, or the cap
  // would keep being exceeded by exactly the role that opted out of the default model.
  config.roles.clean = { enabled: true, model: "also-paid" };
  saveConfig(repo, config);
  const argsFile = path.join(tmpdir(), "argv.log");
  const restore = recordingFakePi(argsFile, { cost: 1 });
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS, writeFallbackModels());
  const runs = (): string[] => readRunLines(argsFile);
  try {
    // The startup run runs on the budgeted pair — including clean's own paid override — and
    // spends $1 >= $0.50.
    await waitFor(() => runs().length >= 1, "the startup run's pi run");
    assert.match(runs()[0] ?? "", /model=also-paid provider=paid/, "the budgeted model does the paid work");

    // One transition event naming the pair that took over: the operator must be able to tell
    // this from a pause.
    await waitFor(() => readEvents(repo).some((e) => e.type === "budget_fallback"), "a budget_fallback event");
    const fallback = eventsOfType(repo, "budget_fallback");
    assert.equal(fallback.length, 1, "one transition event per switch");
    assert.equal(fallback[0]?.source, "tumwater");
    assert.equal(fallback[0]?.capUsd, 0.5);
    assert.equal(fallback[0]?.spentUsd, 1);
    assert.equal(fallback[0]?.provider, "local");
    assert.equal(fallback[0]?.model, "local-free");
    assert.ok(!readEvents(repo).some((e) => e.type === "budget_paused"), "the team degraded, it did not stop");

    // And the team keeps working: clean's next run runs on the free pair, with its paid
    // role override dropped. (clean is deferrable and did nothing last run, so work supplies
    // the wake — the same as every other budget test.)
    mergeWork(repo);
    await awaitSettledRun(repo, "clean", 2, "a role run after the cap was reached");
    assert.match(
      runs().find((l) => l.includes("session=tumwater-clean-2")) ?? "",
      /model=local-free provider=local/,
      "the role keeps running, on the cost n/a fallback",
    );

    // The director is outside the gate in both directions: an explicit human prompt outranks
    // the autonomous-spend cap, so it keeps the budgeted model.
    enqueuePrompt(repo, "steer me after the budget is spent");
    await awaitSettledRun(repo, "director", 1, "the director to run after the switch");
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
    mergeWork(repo);
    await waitFor(
      () => runs().some((l) => l.includes("session=tumwater-clean-3")),
      "a role run after the cap was raised",
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

test("a fallback pi cannot price at zero is refused and the team pauses as before", async () => {
  const repo = makeRepo();
  await initProject(repo, "budget fallback refusal test");
  // Names a model pi's definitions do not list: unverifiable, so it must never engage — a
  // fallback that can spend would defeat the cap it exists to survive.
  const config = fallbackConfig(["clean"], { provider: "local", model: "typo-free" });
  saveConfig(repo, config);
  const restore = fakePiIdle({ cost: 1 });
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS, writeFallbackModels());
  try {
    await awaitSettledRun(repo, "clean", 1, "the startup run to finish");
    await waitFor(() => readEvents(repo).some((e) => e.type === "budget_paused"), "a budget_paused event");
    // The event names the refused pair: why the team stopped instead of switching is the one
    // thing the operator can act on.
    const paused = eventsOfType(repo, "budget_paused");
    assert.equal(paused[0]?.fallbackRejected, "local/typo-free");
    assert.ok(!readEvents(repo).some((e) => e.type === "budget_fallback"));

    // And it really is paused: several poll cycles past its schedule, no second run.
    mergeWork(repo);
    await sleep(600);
    assert.equal(loadRunnerState(repo, "clean").runs, 1, "a refused fallback leaves the team paused");
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

// The fallback breaker (BUGS.md 2026-09-20): a free pair is not a usable fallback when its
// backend cannot serve. On 2026-09-19 oMLX, priced at zero and up but pinned at its Metal
// ceiling, failed 33 of 33 fallback runs for an hour instead of the team pausing.
test("a free fallback whose runs keep failing is demoted to a pause, then probed back once it serves", async () => {
  const repo = makeRepo();
  await initProject(repo, "budget fallback breaker test");
  const config = fallbackConfig(["clean"]);
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
  const done = runRepoOrchestrator(repo, {
    signal: controller.signal,
    pollMs: FAST_POLL_MS,
    modelsPath: models,
    fallbackBreakerPolicy: { failureLimit: 2, cooldownMs: 1500, maxCooldownMs: 1500 },
  });
  const clean = () => loadRunnerState(repo, "clean");
  const runFor = (runNumber: number): string => {
    const log = fs.existsSync(argsFile) ? fs.readFileSync(argsFile, "utf8") : "";
    return log.split("\n").find((l) => l.includes(`session=tumwater-clean-${runNumber}`)) ?? "";
  };
  try {
    // The startup run spends $1 of the $0.50 cap on the paid pair: the free fallback takes over.
    await waitFor(() => readEvents(repo).some((e) => e.type === "budget_fallback"), "the switch to the fallback");
    // Two fallback runs, both rejected. Main-moved wakes supply them: an errored role backs off
    // 30 s, and a main move wakes it early.
    mergeWork(repo);
    await waitFor(() => clean().runs >= 2 && !clean().running, "the first fallback run");
    assert.equal(clean().lastResult, "error");
    assert.match(runFor(2), /model=local-free/);
    mergeWork(repo);
    await waitFor(() => readEvents(repo).some((e) => e.type === "budget_paused"), "the demotion to a pause");
    assert.equal(clean().runs, 3);

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

    // Paused means paused: a main move during the cool-down starts no role run.
    mergeWork(repo);
    await sleep(400);
    assert.equal(clean().runs, 3, "no role run starts while the fallback is demoted");

    // The backend recovers. After the cool-down one probe run finds out, the breaker closes, and
    // the team is back on the fallback — no restart and no config edit needed.
    fs.writeFileSync(healed, "");
    await waitFor(
      () => eventsOfType(repo, "budget_fallback").length >= 2,
      "the probe to restore the fallback",
    );
    assert.equal(clean().runs, 4, "one probe run restored it");
    assert.match(runFor(4), /model=local-free/, "the probe runs on the free pair, never the spent one");
    assert.equal(readOrchestratorInfo(repo)?.fallbackDemoted, undefined, "the demotion is withdrawn");
    assert.deepEqual(snapshot(repo, models).budget.fallback, { provider: "local", model: "local-free" });
  } finally {
    restore();
    controller.abort();
    await done.catch(() => {});
  }
});

// A usage-window move puts role runs on the fallback pair below the cap; those runs feed the
// breaker too, so a dead window fallback is demoted instead of failing until the window resets.
test("a window move's failing fallback is demoted and its tier held, below the cap", async () => {
  const repo = makeRepo();
  await initProject(repo, "window fallback breaker test");
  const config = fallbackConfig(["clean"]);
  config.maxDailyCostUsd = 1000; // never reached
  // The claude primary is named by `backend`; a `provider` of "claude" now routes to pi.
  delete config.provider;
  config.backend = "claude";
  config.model = "claude-opus-5-5";
  saveConfig(repo, config);
  const now = Date.now();
  writeClaudeAccount(repo, {
    billing: "subscription",
    observedAt: now,
    windows: { five_hour: { status: "rejected", resetsAt: now + 3_600_000, observedAt: now } },
  });
  const dir = tmpdir("window-breaker-");
  const healed = path.join(dir, "healed");
  const argsFile = path.join(dir, "argv.log");
  const fakeClaude = fakeClaudeReplay([]); // startup needs the binary; moved roles never run on it
  const restorePi = fakePi(
    [
      `m=""; n=""`,
      `while [ $# -gt 0 ]; do case "$1" in --model) m="$2";; -n) n="$2";; esac; shift; done`,
      `echo "run: model=$m session=$n" >> "${argsFile}"`,
      `if [ "$m" = "local-free" ] && [ ! -f "${healed}" ]; then`,
      `  echo 'Connection error.' >&2`,
      `  exit 1`,
      `fi`,
      `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO", { cost: 0 })}'`,
    ].join("\n"),
  );
  const models = writeFallbackModels();
  const controller = new AbortController();
  const done = runRepoOrchestrator(repo, {
    signal: controller.signal,
    pollMs: FAST_POLL_MS,
    modelsPath: models,
    fallbackBreakerPolicy: { failureLimit: 2, cooldownMs: 1500, maxCooldownMs: 1500 },
  });
  const clean = () => loadRunnerState(repo, "clean");
  // A demoted lone fallback leaves its tiers on no pair: fallback_switched reads `to: null`.
  const heldEvents = () =>
    eventsOfType(repo, "fallback_switched").filter((e) =>
      Object.values((e as { tiers?: Record<string, { to: string | null }> }).tiers ?? {}).some((t) => t.to === null),
    );
  try {
    await waitFor(() => clean().runs >= 1 && !clean().running, "the first fallback run");
    assert.equal(clean().lastResult, "error");
    mergeWork(repo);
    await waitFor(() => clean().runs >= 2 && !clean().running, "the second fallback run");
    assert.equal(clean().lastResult, "error");
    await waitFor(() => heldEvents().length >= 1, "the demotion of the window fallback");
    assert.equal(readOrchestratorInfo(repo)?.fallbackDemotions?.["local/local-free"]?.failures, 2);
    const runsAtDemotion = clean().runs;
    assert.ok(runsAtDemotion >= 2);

    mergeWork(repo);
    await sleep(400);
    assert.equal(clean().runs, runsAtDemotion, "no role run starts while the fallback is demoted");

    fs.writeFileSync(healed, "");
    await waitFor(
      () => clean().runs > runsAtDemotion && !clean().running && clean().lastResult !== "error",
      "the probe run to serve",
    );
    const log = fs.readFileSync(argsFile, "utf8");
    assert.match(log.split("\n").filter((l) => l.includes("run:")).pop() ?? "", /model=local-free/);
  } finally {
    restorePi();
    fakeClaude.restore();
    controller.abort();
    await done.catch(() => {});
  }
});

// The budget handback (PLANS.md 2026-09-30): new runs are gated live, but a run that started
// on the fallback keeps it until it ends — so a reopen at local midnight would leave the
// team's fresh budget waiting on the slow local model. On the resuming poll the orchestrator
// hands exactly those runs back: one budget_handback event, the run ends resumably, and its
// resume continues the same session on the primary.
test("budget_resumed hands the in-flight fallback runs back to the primary", async () => {
  const repo = makeRepo();
  await initProject(repo, "budget handback e2e test");
  const config = fallbackConfig(["clean"]);
  saveConfig(repo, config);
  const argsFile = path.join(tmpdir(), "handback-e2e-runs.log");
  const flagsFile = path.join(tmpdir(), "handback-e2e-flags.log");
  const marker = path.join(tmpdir(), "handback-e2e-inflight");
  const runs = (): string[] => readRunLines(argsFile);
  // The model/provider/session recorder the recordingFakePi shim writes, as a fragment: each
  // phase needs its own behavior around it, so the shim itself cannot be reused whole. It
  // shifts through the argv, so every other fragment (TOUCH_SESSION, logFlagsTo) must run
  // BEFORE it or it sees no arguments.
  const rec =
    `m=""; p=""; n=""; while [ $# -gt 0 ]; do case "$1" in --model) m="$2";; --provider) p="$2";; -n) n="$2";; esac; shift; done; ` +
    `echo "run: model=$m provider=$p session=$n" >> "${argsFile}"`;
  const idle = `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO", { cost: 1 })}'`;

  // Phase 1: the startup run on the paid pair spends $1 >= $0.50 and trips the gate.
  let restore = fakePi([TOUCH_SESSION, rec, idle].join("\n"));
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS, writeFallbackModels());
  try {
    await awaitSettledRun(repo, "clean", 1, "the startup run");

    // Phase 2: the next run starts on the fallback pair and hangs mid-run — the shape the
    // handback exists for. Installed before the reopen poll so no fallback run can race the
    // swap; the gate is already over cap, so the run runs on the fallback view.
    restore();
    // TOUCH_SESSION and logFlagsTo must run BEFORE rec: the recorder shifts through the
    // argv, so a fragment after it sees no arguments.
    restore();
    restore = fakePi([TOUCH_SESSION, logFlagsTo(flagsFile), rec, `touch "${marker}"`, `exec sleep 30`].join("\n"));
    mergeWork(repo);
    await waitFor(() => fs.existsSync(marker), "the in-flight fallback run to start");
    assert.equal(loadRunnerState(repo, "clean").running, true);
    await waitFor(() => readEvents(repo).some((e) => e.type === "budget_fallback"), "the budget_fallback event");

    // Phase 3: raising the cap reopens the budget. The orchestrator hands the run back:
    // exactly one event naming the role and the pair, and the run ends resumably.
    saveConfig(repo, { ...config, maxDailyCostUsd: 100 });
    await waitFor(() => readEvents(repo).some((e) => e.type === "budget_handback"), "the budget_handback event");
    const hb = eventsOfType(repo, "budget_handback");
    assert.equal(hb.length, 1, "one handback event per reopen");
    assert.deepEqual(hb[0]?.roles, ["clean"]);
    assert.equal(hb[0]?.provider, "local");
    assert.equal(hb[0]?.model, "local-free");
    // The handback is observed instead of polled: the budget_handback event confirms the
    // reopen handed the in-flight run back, and the resume's OWN start marker below (the flags
    // file gaining a line) is the deterministic next-start witness that the run ended resumably
    // — with no fixed sleep or live-run-state wait for a loaded host to blow past. A resumed
    // run uses the primary pair, so the shim must be swapped in BEFORE the resume spawns; the
    // resume only starts after the handback abort completes, so swapping here is safe.
    restore();
    restore = fakePi([logFlagsTo(flagsFile), rec, idle].join("\n"));
    await waitFor(() => {
      try {
        return fs.readFileSync(flagsFile, "utf8").trim().split("\n").length >= 2;
      } catch {
        return false;
      }
    }, "the resume run's run");
    assert.match(
      runs()[2] ?? "",
      /model=big-paid provider=paid/,
      "the resume runs on the primary",
    );
    assert.doesNotMatch(runs()[2] ?? "", /session=tumwater/, "a resumed run starts no new session");
    const flags = fs.readFileSync(flagsFile, "utf8").trim().split("\n");
    assert.equal(flags.length, 2, JSON.stringify(flags));
    assert.match(flags[1] ?? "", /--continue/, "the resume continues the handed-back session");
    await awaitSettledRun(repo, "clean", 3, "the resume run to settle");
  } finally {
    await stopOrchestrator(orch, restore);
  }
});
