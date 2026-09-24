/** Second slice of the orchestrator e2e suite (orchestrator.e2e.test.ts is the first,
 * orchestrator-3.e2e.test.ts the third) — split so node --test runs the slices in parallel
 * processes: top-level tests within one file run sequentially, while each test FILE gets its
 * own process (and its own PATH, which fakePi's global PATH swap requires). The slices are
 * balanced by measured per-test duration (~17 s each at 2026-09-20); keep them roughly equal
 * when moving tests between the files. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { defaultConfig, saveConfig } from "../src/config.js";
import { initProject } from "../src/init.js";
import { enqueuePrompt } from "../src/inbox.js";
import { readEvents } from "../src/events.js";
import { freshLoopState, loadLoopState, saveLoopState, clearBackoff } from "../src/state.js";
import { readOrchestratorInfo } from "../src/fleet-state.js";
import { todayStamp } from "../src/budget.js";
import { branchName, pausedPath, resetRequestPath, wakeRequestPath, worktreePath } from "../src/paths.js";
import { statusPayload } from "../src/ui/status-payload.js";
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

test("a live config edit logs one config_changed naming the keys, and an identical rewrite logs none", async () => {
  const repo = makeRepo();
  await initProject(repo, "config change event test");
  saveConfig(repo, fastConfig(["clean"]));
  const restore = fakePi(`printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`);
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    const changeds = () => readEvents(repo).filter((e) => e.type === "config_changed");
    await waitFor(() => loadLoopState(repo, "clean").ticks >= 1, "a startup tick");
    assert.equal(changeds().length, 0, "no config_changed while the file is unchanged");

    // Rewriting the same content (new mtime, same bytes) is not a change.
    saveConfig(repo, fastConfig(["clean"]));
    await new Promise((r) => setTimeout(r, FAST_POLL_MS * 4));
    assert.equal(changeds().length, 0, "an identical rewrite logs nothing");

    // A real edit names exactly the changed keys, once — not once per poll.
    const cfg = fastConfig(["clean"]);
    cfg.provider = "huggingface";
    cfg.thrashTurns = 7;
    saveConfig(repo, cfg);
    await waitFor(() => changeds().length === 1, "exactly one config_changed event");
    assert.deepEqual(changeds()[0]!.keys, ["provider", "thrashTurns"]);
    await new Promise((r) => setTimeout(r, FAST_POLL_MS * 4));
    assert.equal(changeds().length, 1, "no repeat event while the file is unchanged");

    // A maxConcurrent-only edit keeps its own event and stays out of config_changed.
    cfg.maxConcurrent = cfg.maxConcurrent > 2 ? cfg.maxConcurrent - 1 : cfg.maxConcurrent + 1;
    saveConfig(repo, cfg);
    await waitFor(
      () => readEvents(repo).some((e) => e.type === "max_concurrent_changed"),
      "the max concurrent event",
    );
    assert.equal(changeds().length, 1, "maxConcurrent has its own event");

    // A roles.<id> edit is named per role.
    cfg.roles.clean = { ...cfg.roles.clean!, instructions: "be tidy" };
    saveConfig(repo, cfg);
    await waitFor(() => changeds().length === 2, "the roles.<id> event");
    assert.deepEqual(changeds()[1]!.keys, ["roles.clean"]);
  } finally {
    restore();
    await orch.stop();
  }
});

test("a tumwater.json that vanishes mid-run keeps the last-known-good config, warns once, and reloads on return", async () => {
  // BUGS.md 2026-09-23: a landing's fast-forward deleted the live file and the next poll
  // reloaded defaultConfig() — config_changed naming every non-default key, the cap reset to
  // the default, every role enabled — and the fleet ran 8.6 h on it with no word of why.
  const repo = makeRepo();
  await initProject(repo, "config vanish test");
  // bugfix is never need-deferred, so it keeps ticking through the whole incident. The cap is
  // off-default so a reload-as-defaults would log max_concurrent_changed.
  const cfg = fastConfig(["bugfix"], "kept-model");
  cfg.maxConcurrent = defaultConfig().maxConcurrent + 1;
  saveConfig(repo, cfg);
  const argsFile = path.join(tmpdir(), "argv.log");
  const restore = recordingFakePi(argsFile);
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    const runs = (): string[] => {
      try {
        return fs.readFileSync(argsFile, "utf8").split("\n").filter((l) => l.startsWith("run:"));
      } catch {
        return [];
      }
    };
    const ofType = (type: string) => readEvents(repo).filter((e) => e.type === type);
    const warningsWith = (text: string) =>
      ofType("warning").filter((e) => ((e.message as string | undefined) ?? "").includes(text));
    await waitFor(() => runs().length >= 1, "a startup pi run");

    fs.rmSync(path.join(repo, "tumwater.json"));
    await waitFor(() => warningsWith("tumwater.json missing").length === 1, "the missing-file warning");
    const warning = warningsWith("tumwater.json missing")[0]!;
    assert.equal(warning.loop, "harness");
    assert.ok(
      (warning.message as string).includes(path.join(repo, "tumwater.json")),
      `the warning names the missing file: ${warning.message as string}`,
    );
    // The fleet keeps running on the retained config, not on defaults.
    const runsAtVanish = runs().length;
    await waitFor(() => runs().length > runsAtVanish, "a further pi run while the file is missing");
    assert.ok(runs().at(-1)!.includes("model=kept-model"), `retained model: ${runs().at(-1)}`);
    await new Promise((r) => setTimeout(r, FAST_POLL_MS * 4));
    assert.equal(warningsWith("tumwater.json missing").length, 1, "one warning per vanish, not per poll");
    assert.equal(ofType("config_changed").length, 0, "a vanish is not a reconfiguration");
    assert.equal(ofType("max_concurrent_changed").length, 0, "the cap is retained");
    assert.equal(warningsWith("enabled — starting ticks").length, 0, "no default-enabled role starts");

    // The file returning logs one line and reloads normally, diffed against the retained config:
    // config_changed names only what the returned file really changed.
    const back = fastConfig(["bugfix"], "returned-model");
    back.maxConcurrent = cfg.maxConcurrent;
    saveConfig(repo, back);
    await waitFor(() => runs().at(-1)?.includes("model=returned-model") === true, "a pi run on the returned file");
    assert.equal(warningsWith("tumwater.json reappeared").length, 1, "one line when the file returns");
    assert.deepEqual(ofType("config_changed").map((e) => e.keys), [["model"]]);
    assert.equal(ofType("max_concurrent_changed").length, 0);
    assert.equal(warningsWith("tumwater.json missing").length, 1, "no further missing warnings");
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
