/** Second slice of the orchestrator e2e suite (orchestrator.e2e.test.ts is the first,
 * orchestrator-3.e2e.test.ts the third) — split so node --test runs the slices in parallel
 * processes: top-level tests within one file run sequentially, while each test FILE gets its
 * own process (and its own PATH, which fakePi's global PATH swap requires). The slices are
 * balanced by measured per-test duration (~17 s each at 2026-09-20); keep them roughly equal
 * when moving tests between the files. The operator/per-role pause topics live in their own
 * topic-named file, orchestrator-pause.e2e.test.ts (extracted 2026-09-30), as do the daily
 * cost budget gate and fallback-model topics, orchestrator-budget.e2e.test.ts (extracted
 * 2026-09-30). */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { defaultConfig, loadConfig, saveConfig } from "../src/config/config.js";
import { initProject } from "../src/init/init.js";
import { submitRolePrompt } from "../src/inbox/inbox-submit.js";
import { readEvents } from "../src/events/event-read.js";
import { freshRunnerState, loadRunnerState, saveRunnerState } from "../src/runner/runner-state.js";
import { clearBackoff } from "../src/scheduling/backoff.js";
import { branchName, resetRequestPath, wakeRequestPath } from "../src/paths.js";
import { statusPayload } from "../src/ui/status-payload.js";
import { eventsOfType, writeMarker } from "./fixtures/log-fixtures.js";
import { roleWt, seedCounters } from "./fixtures/runner-fixtures.js";
import { fastConfig, makeFastRepo, startIdleOrchestrator, startLiveOrchestrator, stopOrchestrator } from "./fixtures/orchestrator-fixtures.js";
import { mergeWork, makeRepo, seedOpenBug, sh, tmpdir } from "./fixtures/repo-fixtures.js";
import { fakePi, readRunLines, recordingFakePi } from "./fakes/fake-pi.js";
import { sleep, waitFor } from "./helpers/wait.js";
import { assistantLine } from "./fixtures/pi-events.js";
import { ensureParentDir } from "../src/files/files.js";

const FAST_POLL_MS = 100;

test("a multi-role reset request zeroes every listed runner and logs one harness-level event", async () => {
  const repo = await makeFastRepo("multi role reset test", ["clean", "dedupe"]);
  seedCounters(repo, "clean", "dedupe");
  const { restore, orch } = startIdleOrchestrator(repo);
  try {
    // What `tumwater reset-counters` without --role writes: a marker naming every role.
    const markerFile = resetRequestPath(repo);
    writeMarker(markerFile, { at: Date.now(), roles: ["clean", "dedupe"] });

    await waitFor(() => !fs.existsSync(markerFile), "the marker to be consumed");
    for (const role of ["clean", "dedupe"]) {
      // A post-reset run may have started in the same poll; without in-memory zeroing this
      // would read >= 8.
      assert.ok(
        loadRunnerState(repo, role).runs <= 1,
        `${role} counters start from zero after consumption (got ${loadRunnerState(repo, role).runs})`,
      );
    }
    // Several roles → ONE harness-level event listing them, not one per role.
    const resets = eventsOfType(repo, "counters_reset");
    assert.equal(resets.length, 1);
    assert.equal(resets[0]?.source, "tumwater");
    assert.deepEqual([...(resets[0]!.roles as string[])].sort(), ["clean", "dedupe"]);
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

test("a corrupt reset marker resets every runner and is still consumed", async () => {
  const repo = await makeFastRepo("corrupt reset marker test", ["clean", "dedupe"]);
  seedCounters(repo, "clean", "dedupe");
  const { restore, orch } = startIdleOrchestrator(repo);
  try {
    // Garbage where the marker should be: JSON.parse throws → requested stays null → every
    // runner resets (a documented superset — skipping it would let the next run's save
    // resurrect the pre-reset values).
    const markerFile = resetRequestPath(repo);
    ensureParentDir(markerFile);
    fs.writeFileSync(markerFile, "{not json");

    await waitFor(() => !fs.existsSync(markerFile), "the corrupt marker to be consumed");
    for (const role of ["clean", "dedupe"]) {
      assert.ok(
        loadRunnerState(repo, role).runs <= 1,
        `${role} counters start from zero after a corrupt marker (got ${loadRunnerState(repo, role).runs})`,
      );
    }
    const resets = eventsOfType(repo, "counters_reset");
    assert.equal(resets.length, 1);
    assert.equal(resets[0]?.source, "tumwater", "a superset reset is filed harness-level with the roles list");
    assert.deepEqual([...(resets[0]!.roles as string[])].sort(), ["clean", "dedupe"]);
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

test("a wake request makes a backed-off role due within one poll and logs it under the role", async () => {
  const repo = await makeFastRepo("wake request test", ["clean"]);
  // Deep backoff: the role is two hours out and has ran before, so the woken run reads as
  // "scheduled", not "startup". lastRunEndedAt is long past, so no min-gap gate applies.
  const seeded = freshRunnerState("clean");
  seeded.runs = 3;
  seeded.backoffSeconds = 7680;
  seeded.nextRunAt = Date.now() + 2 * 3600 * 1000;
  seeded.lastRunEndedAt = Date.now() - 3600 * 1000;
  saveRunnerState(repo, seeded);
  const { restore, orch } = startIdleOrchestrator(repo);
  try {
    // The backed-off role must stay asleep on its own (nextRunAt two hours out).
    await sleep(300);
    assert.equal(loadRunnerState(repo, "clean").runs, 3, "the backed-off role stays asleep");

    // Reproduce what `tumwater wake --role clean` does from the CLI side: clear the state
    // file and drop the marker. (The CLI path itself is covered in test/cli.test.ts.)
    saveRunnerState(repo, clearBackoff(loadRunnerState(repo, "clean"), Date.now()));
    const markerFile = wakeRequestPath(repo);
    writeMarker(markerFile, { at: Date.now(), roles: ["clean"] });

    // The team consumes the marker within a poll cycle and the role runs — its
    // in-memory schedule was the gate, so the file zeroing alone cannot explain the run.
    await waitFor(() => loadRunnerState(repo, "clean").runs >= 4, "the woken role to run");
    await waitFor(() => !loadRunnerState(repo, "clean").running, "the woken run to finish");

    // The wake is visible as exactly one plain event filed under the role, not a warning.
    const wakes = eventsOfType(repo, "wake");
    assert.equal(wakes.length, 1);
    assert.equal(wakes[0]?.source, "clean");
    assert.equal(wakes[0]?.reason, "operator");
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

test("an operator wake brings a slow-clock role in despite a fresh min-gap window", async () => {
  // The other wake shape: not backoff but the role's OWN interval. qa-style slow clocks
  // used to defeat the wake in isEligible — lastRunEndedAt minutes old and nextRunAt
  // hours out left the role asleep for the rest of the interval no matter how many wake
  // markers arrived, so `tumwater wake --role qa` and a queued per-role prompt's auto-wake
  // silently did nothing. The earlier wake test dodged this by seeding lastRunEndedAt an
  // hour in the past; this one seeds the fresh-run shape the operator actually hits.
  const repo = await makeFastRepo("wake vs min gap test", ["clean"]);
  const cfg = loadConfig(repo);
  cfg.roles.clean = { enabled: true, minRunIntervalSeconds: 3600 };
  saveConfig(repo, cfg);
  // Ran moments ago, productive clock hours out, not backing off, main unmoved.
  const seeded = freshRunnerState("clean");
  seeded.runs = 1;
  seeded.lastRunEndedAt = Date.now() - 2000;
  seeded.nextRunAt = Date.now() + 3600 * 1000;
  seeded.lastMainHead = "";
  saveRunnerState(repo, seeded);
  const { restore, orch } = startIdleOrchestrator(repo);
  try {
    // The slow clock alone must keep the role asleep.
    await sleep(300);
    assert.equal(loadRunnerState(repo, "clean").runs, 1, "the fresh-gap role stays asleep");

    // What `tumwater wake --role clean` does from the CLI side (as in the test above).
    saveRunnerState(repo, clearBackoff(loadRunnerState(repo, "clean"), Date.now()));
    const markerFile = wakeRequestPath(repo);
    writeMarker(markerFile, { at: Date.now(), roles: ["clean"] });

    await waitFor(() => loadRunnerState(repo, "clean").runs >= 2, "the woken role to run");
    await waitFor(() => !loadRunnerState(repo, "clean").running, "the woken run to finish");
    // Self-clearing: the woken run's own end re-opens the gap window, so the role must
    // not immediately run again.
    await sleep(300);
    assert.equal(loadRunnerState(repo, "clean").runs, 2, "the gap window re-arms after the woken run");
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

test("a queued per-role prompt pulls a slow-clock role in even when its wake was clobbered", async () => {
  // The mid-run wake race's end state, made deterministic: the enqueue's auto-wake arrived
  // while a run was in flight and that run's end-save overwrote wokenAt and nextRunAt —
  // so only the queue file is left carrying the demand. The old code read the schedule and
  // kept the role asleep for the rest of its interval despite the p:1 marker; now the
  // queued prompt is due on its own existence and the next poll runs it.
  const repo = await makeFastRepo("clobbered wake queue due test", ["clean"]);
  const cfg = loadConfig(repo);
  cfg.roles.clean = { enabled: true, minRunIntervalSeconds: 3600 };
  saveConfig(repo, cfg);
  // The in-flight run just ended: fresh gap, hours-out clock, no wokenAt — the end-save
  // already won. The queued prompt is the only trace of the request.
  const seeded = freshRunnerState("clean");
  seeded.runs = 1;
  seeded.lastRunEndedAt = Date.now() - 2000;
  seeded.nextRunAt = Date.now() + 3600 * 1000;
  seeded.lastMainHead = "";
  saveRunnerState(repo, seeded);
  submitRolePrompt(repo, "clean", "check the queue-due path");
  const { restore, orch } = startIdleOrchestrator(repo);
  try {
    // The run runs within a poll or two — a schedule-gated role would sit for the hour.
    await waitFor(() => loadRunnerState(repo, "clean").runs >= 2, "the queued prompt's run");
    await waitFor(() => !loadRunnerState(repo, "clean").running, "the queue-due run to finish");
    // The wake event names the queue as the cause, like the director's inbox wake.
    const wakes = eventsOfType(repo, "wake").filter((w) => w.source === "clean");
    assert.equal(wakes.length, 1);
    assert.equal(wakes[0]?.reason, "inbox");
    // And the ordinary clock re-arms after the queue-due run: no second run.
    await sleep(300);
    assert.equal(loadRunnerState(repo, "clean").runs, 2, "the gap window re-arms after the run");
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

test("a plain wake consumed mid-run survives the run's end-save", async () => {
  // The bare-wake half of the mid-run race (BUGS.md 2026-09-25): `tumwater wake --role`
  // with an EMPTY queue, consumed while the target's run is still in progress. r.wake() stamps the
  // shared in-memory state, but the run's end-save re-stamps lastRunEndedAt past wokenAt
  // and schedules a fresh gap out — the demand used to vanish and the role slept out its
  // whole hour. restoreMidRunWake re-applies it at the end-save, so the next run follows
  // within a poll, exactly like a wake arriving after the run ended.
  const repo = await makeFastRepo("mid-run wake test", ["feature"]);
  const cfg = loadConfig(repo);
  cfg.roles.feature = { enabled: true, minRunIntervalSeconds: 3600 };
  saveConfig(repo, cfg);
  const seeded = freshRunnerState("feature");
  seeded.lastMainHead = "";
  seeded.nextRunAt = Date.now() - 1000; // due now
  saveRunnerState(repo, seeded);
  // A fake pi run slow enough to leave room for a wake to arrive and be consumed mid-run.
  const restore = fakePi(`sleep 1\nprintf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`);
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await waitFor(() => loadRunnerState(repo, "feature").running === true, "the first run to start");
    // What `tumwater wake --role feature` does from the CLI side, while the run is in flight:
    // the state stamp plus the marker the orchestrator consumes (consumeWakeRequest →
    // r.wake() on the state object the run holds).
    saveRunnerState(repo, clearBackoff(loadRunnerState(repo, "feature"), Date.now()));
    writeMarker(wakeRequestPath(repo), { at: Date.now(), roles: ["feature"] });
    // The demand must actually be consumed mid-run — the wake event fired while running
    // holds — or the test would pass by waking an already-idle role.
    await waitFor(
      () => eventsOfType(repo, "wake").some((w) => w.source === "feature") && loadRunnerState(repo, "feature").running === true,
      "the wake to be consumed mid-run",
    );
    // The run ends, its end-save runs — and the woken role must come straight back.
    await waitFor(() => loadRunnerState(repo, "feature").runs >= 2, "the woken run to follow within polls, not an hour", 10_000);
    await waitFor(() => !loadRunnerState(repo, "feature").running, "the woken run to finish");
    // Then the ordinary clock re-arms: no third run.
    await sleep(300);
    assert.equal(loadRunnerState(repo, "feature").runs, 2, "the gap window re-arms after the woken run");
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

test("a corrupt wake marker wakes every runner and is still consumed", async () => {
  const repo = await makeFastRepo("corrupt wake marker test", ["clean", "dedupe"]);
  for (const role of ["clean", "dedupe"]) {
    const s = freshRunnerState(role);
    s.runs = 3;
    s.backoffSeconds = 7680;
    s.nextRunAt = Date.now() + 2 * 3600 * 1000;
    s.lastRunEndedAt = Date.now() - 3600 * 1000;
    saveRunnerState(repo, s);
  }
  const { restore, orch } = startIdleOrchestrator(repo);
  try {
    // What the CLI side of `tumwater wake` already did: both state files cleared. Then
    // garbage where the marker should be: the parse fails → every runner wakes (a
    // documented superset — skipping it would leave the pre-wake in-memory schedule in place).
    for (const role of ["clean", "dedupe"]) {
      saveRunnerState(repo, clearBackoff(loadRunnerState(repo, role), Date.now()));
    }
    const markerFile = wakeRequestPath(repo);
    ensureParentDir(markerFile);
    fs.writeFileSync(markerFile, "{not json");

    await waitFor(() => !fs.existsSync(markerFile), "the corrupt marker to be consumed");
    for (const role of ["clean", "dedupe"]) {
      await waitFor(() => loadRunnerState(repo, role).runs >= 4, `${role} to run after the wake`);
    }
    const wakes = eventsOfType(repo, "wake");
    assert.equal(wakes.length, 2, "one wake event per woken role");
    assert.deepEqual(
      wakes.map((e) => e.source).sort(),
      ["clean", "dedupe"],
    );
    for (const e of wakes) assert.equal(e.reason, "operator");
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

test("roles can be enabled and disabled mid-run without a restart", async () => {
  const repo = await makeFastRepo("role toggling test", ["clean", "dedupe"]);
  const argsFile = path.join(tmpdir(), "argv.log");
  const restore = recordingFakePi(argsFile);
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    const finished = (role: string) => {
      const s = loadRunnerState(repo, role);
      return s.runs >= 1 && !s.running;
    };
    const messages = () => readEvents(repo).map((e) => (e.message as string | undefined) ?? "");
    await waitFor(() => finished("clean") && finished("dedupe"), "startup runs to finish");
    // Baseline while both roles are still enabled and idle: clean's next run after the
    // disable is what proves the rest of the team keeps running.
    const cleanRuns = loadRunnerState(repo, "clean").runs;

    // Disabling a role stops its next run; the rest of the team keeps running.
    saveConfig(repo, fastConfig(["clean"]));
    // Wait until the disable is processed AND no in-flight dedupe run remains. From that point
    // on dedupe can never start another run (isEligible hard-gates disabled roles), so its
    // captured count is final for the whole disabled window — no fixed sleep needed.
    await waitFor(
      () =>
        messages().some((m) => m.includes("role dedupe disabled — no new runs")) &&
        !loadRunnerState(repo, "dedupe").running,
      "the disable to be processed with no in-flight run",
    );
    const dedupeRuns = loadRunnerState(repo, "dedupe").runs;
    // The enabled role's next run proves the team is still alive and running — the disabled
    // role had that same window and must not have used it. clean is deferrable (need-based
    // prioritization), so a work merge supplies its wake; the re-enabled dedupe below wakes on
    // the same commit.
    mergeWork(repo);
    await waitFor(() => loadRunnerState(repo, "clean").runs > cleanRuns, "an enabled role to run again");
    assert.equal(loadRunnerState(repo, "dedupe").runs, dedupeRuns, "disabled role stops running");
    assert.ok(messages().some((m) => m.includes("role dedupe disabled — no new runs")), "disable transition logged");

    // Enabling a role that was not running at startup starts it (new runner).
    saveConfig(repo, fastConfig(["clean", "feature"]));
    await waitFor(() => finished("feature"), "newly enabled role to run");
    assert.ok(messages().some((m) => m.includes("role feature enabled — starting runs")), "enable transition logged");
    assert.equal(loadRunnerState(repo, "dedupe").runs, dedupeRuns, "still-disabled role stays stopped");

    // Re-enabling a previously running role resumes it within one poll cycle.
    saveConfig(repo, fastConfig(["clean", "dedupe", "feature"]));
    await waitFor(() => loadRunnerState(repo, "dedupe").runs > dedupeRuns, "re-enabled role to run again");
    assert.ok(messages().some((m) => m.includes("role dedupe enabled — starting runs")), "re-enable transition logged");
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

test("a live config edit logs one config_changed naming the keys, and an identical rewrite logs none", async () => {
  const repo = await makeFastRepo("config change event test", ["clean"]);
  const { restore, orch } = startIdleOrchestrator(repo);
  try {
    const changeds = () => eventsOfType(repo, "config_changed");
    await waitFor(() => loadRunnerState(repo, "clean").runs >= 1, "a startup run");
    assert.equal(changeds().length, 0, "no config_changed while the file is unchanged");

    // Rewriting the same content (new mtime, same bytes) is not a change.
    saveConfig(repo, fastConfig(["clean"]));
    await sleep(FAST_POLL_MS * 4);
    assert.equal(changeds().length, 0, "an identical rewrite logs nothing");

    // A real edit names exactly the changed keys, once — not once per poll.
    const cfg = fastConfig(["clean"]);
    cfg.provider = "huggingface";
    cfg.thrashTurns = 7;
    saveConfig(repo, cfg);
    await waitFor(() => changeds().length === 1, "exactly one config_changed event");
    assert.deepEqual(changeds()[0]!.keys, ["provider", "thrashTurns"]);
    await sleep(FAST_POLL_MS * 4);
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
    await stopOrchestrator(orch, restore);
  }
});

test("a tumwater.json that vanishes mid-run keeps the last-known-good config, warns once, and reloads on return", async () => {
  // BUGS.md 2026-09-23: a merge's fast-forward deleted the live file and the next poll
  // reloaded defaultConfig() — config_changed naming every non-default key, the cap reset to
  // the default, every role enabled — and the team ran 8.6 h on it with no word of why.
  const repo = makeRepo();
  await initProject(repo, "config vanish test");
  // bugfix is never need-deferred (with an open bug — with an empty BUGS.md `## Open` it
  // defers like a maintenance role and would starve this test of pi runs), so it keeps running
  // through the whole incident. The cap is off-default so a reload-as-defaults would log
  // max_concurrent_changed.
  const cfg = fastConfig(["bugfix"], "kept-model");
  cfg.maxConcurrent = defaultConfig().maxConcurrent + 1;
  saveConfig(repo, cfg);
  seedOpenBug(repo);
  const argsFile = path.join(tmpdir(), "argv.log");
  const restore = recordingFakePi(argsFile);
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    const runs = (): string[] => readRunLines(argsFile);
    const ofType = (type: string) => readEvents(repo).filter((e) => e.type === type);
    const warningsWith = (text: string) =>
      ofType("warning").filter((e) => ((e.message as string | undefined) ?? "").includes(text));
    await waitFor(() => runs().length >= 1, "a startup pi run");

    fs.rmSync(path.join(repo, "tumwater.json"));
    await waitFor(() => warningsWith("tumwater.json missing").length === 1, "the missing-file warning");
    const warning = warningsWith("tumwater.json missing")[0]!;
    assert.equal(warning.source, "tumwater");
    assert.ok(
      (warning.message as string).includes(path.join(repo, "tumwater.json")),
      `the warning names the missing file: ${warning.message as string}`,
    );
    // The team keeps running on the retained config, not on defaults.
    const runsAtVanish = runs().length;
    await waitFor(() => runs().length > runsAtVanish, "a further pi run while the file is missing");
    assert.ok(runs().at(-1)!.includes("model=kept-model"), `retained model: ${runs().at(-1)}`);
    await sleep(FAST_POLL_MS * 4);
    assert.equal(warningsWith("tumwater.json missing").length, 1, "one warning per vanish, not per poll");
    assert.equal(ofType("config_changed").length, 0, "a vanish is not a reconfiguration");
    assert.equal(ofType("max_concurrent_changed").length, 0, "the cap is retained");
    assert.equal(warningsWith("enabled — starting runs").length, 0, "no default-enabled role starts");

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
    await stopOrchestrator(orch, restore);
  }
});

// --- User-defined roles (plans/user-defined-loops.md) ---

test("custom roles can be added, removed, and reordered mid-run without a restart", async () => {
  const repo = await makeFastRepo("custom role e2e test", ["clean"]);
  const { restore, orch } = startIdleOrchestrator(repo);
  try {
    const finished = (role: string) => {
      const s = loadRunnerState(repo, role);
      return s.runs >= 1 && !s.running;
    };
    const messages = () => readEvents(repo).map((e) => (e.message as string | undefined) ?? "");
    const roleOrder = () =>
      (statusPayload(repo) as { roles: Array<{ role: string }> }).roles.map((l) => l.role);
    await waitFor(() => finished("clean"), "the startup run to finish");

    // Adding a custom entry starts its runner within one poll cycle — the live-reload
    // machinery already handles any enabled id, so no orchestrator change is needed.
    let cfg = fastConfig(["clean"]);
    cfg.customRoles.push({ name: "docs-auditor", task: "Keep the docs current." });
    saveConfig(repo, cfg);
    await waitFor(() => finished("docs-auditor"), "the new custom role to run");
    assert.ok(
      readEvents(repo).some((e) => e.type === "run_start" && e.source === "docs-auditor"),
      "runs under its own name",
    );
    // Owns its persistent worktree and branch like a built-in.
    assert.ok(fs.existsSync(roleWt(repo, "docs-auditor")), "its worktree");
    const branches = sh(repo, "git", "branch", "--list").split("\n");
    assert.ok(branches.some((b) => b.includes(branchName("docs-auditor"))), "its branch");

    // A main move wakes it — customs are never deferred by need-based prioritization.
    mergeWork(repo);
    await waitFor(() => loadRunnerState(repo, "docs-auditor").runs >= 2, "a second run after a main move");

    // Removing the entry logs one warning and stops its runs.
    saveConfig(repo, fastConfig(["clean"]));
    await waitFor(
      () =>
        messages().some((m) => m.includes("role docs-auditor disabled — no new runs")) &&
        !loadRunnerState(repo, "docs-auditor").running,
      "the removal to be processed with no in-flight run",
    );
    const removedRuns = loadRunnerState(repo, "docs-auditor").runs;
    // The enabled role's next run proves the team is alive and main moved — a still-enabled
    // custom would have used that same wake (it never defers), so its count must not move.
    mergeWork(repo);
    await waitFor(() => loadRunnerState(repo, "clean").runs > 1, "an enabled role to run again");
    assert.equal(loadRunnerState(repo, "docs-auditor").runs, removedRuns, "removed role stops running");

    // Re-adding the same name revives its persisted state — counters survive, like re-enabling a
    // built-in.
    cfg = fastConfig(["clean"]);
    cfg.customRoles.push({ name: "docs-auditor", task: "Keep the docs current." });
    saveConfig(repo, cfg);
    await waitFor(
      () => loadRunnerState(repo, "docs-auditor").runs > removedRuns && !loadRunnerState(repo, "docs-auditor").running,
      "the re-added role to run again",
    );
    assert.equal(loadRunnerState(repo, "docs-auditor").runs, removedRuns + 1, "counters survived the removal");
    assert.ok(
      messages().some((m) => m.includes("role docs-auditor enabled — starting runs")),
      "re-add transition logged",
    );

    // Reordering two entries reorders the status table without touching built-in order.
    cfg = fastConfig(["clean"]);
    cfg.customRoles.push({ name: "docs-auditor", task: "Keep the docs current." });
    cfg.customRoles.push({ name: "perf-hunter", task: "Hunt perf wins." });
    saveConfig(repo, cfg);
    await waitFor(() => finished("perf-hunter"), "the second custom role to run");
    assert.deepEqual(roleOrder().slice(-2), ["docs-auditor", "perf-hunter"], "customs after built-ins in array order");

    cfg = fastConfig(["clean"]);
    cfg.customRoles.push({ name: "perf-hunter", task: "Hunt perf wins." });
    cfg.customRoles.push({ name: "docs-auditor", task: "Keep the docs current." });
    saveConfig(repo, cfg);
    await waitFor(
      () => {
        const order = roleOrder();
        return order.includes("perf-hunter") && order.indexOf("perf-hunter") < order.indexOf("docs-auditor");
      },
      "the reorder to show in the status table",
    );
    const order = roleOrder();
    assert.deepEqual(order.slice(-2), ["perf-hunter", "docs-auditor"]);
    assert.ok(order.indexOf("clean") < order.indexOf("perf-hunter"), "built-ins keep their place ahead of customs");
  } finally {
    await stopOrchestrator(orch, restore);
  }
});
