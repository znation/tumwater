/** The orchestrator e2e tier (orchestrator-2/3.e2e.test.ts are the balanced slices, renamed
 * here from the old orchestrator-4/5 numbering: orchestrator-resize.e2e.test.ts holds the live
 * maxConcurrent resize and orchestrator-permits.e2e.test.ts the shared-permit and
 * tier-ordering cases): these tests start a live orchestrator and wait on real timers, so
 * their fixed wall-clock budgets are not reliable on a loaded machine — they run via
 * `npm run test:e2e` (and CI), not in the unfiltered `npm test` run the harness's merge gate
 * executes (BUGS.md 2026-09-21). The files run in parallel processes; this one holds
 * scheduling basics, deferral, session pruning, live config edits, reset requests and the
 * branch watch. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { backdate } from "./helpers/backdate.js";
import { runTimedRoleRun, sleepInterruptible } from "../src/run/run-timing.js";
import { DEFER_MAX_MS } from "../src/scheduling/scheduling.js";
import { defaultConfig, loadConfig, saveConfig } from "../src/config/config.js";
import { initProject } from "../src/init/init.js";
import { enqueuePrompt } from "../src/inbox/inbox.js";
import { submitRolePrompt } from "../src/inbox/inbox-submit.js";
import { readEvents } from "../src/events/event-read.js";
import { freshRunnerState, saveRunnerState, zeroCounters } from "../src/runner/runner-state.js";
import { loadRunnerState } from "../src/runner/runner-state-load.js";
import { nextBackoffSeconds } from "../src/scheduling/backoff.js";
import { orchestratorAlive, readOrchestratorInfo } from "../src/team/orchestrator-info.js";
import { resetRequestPath, worktreePath } from "../src/paths.js";
import { eventTypes, eventsOfType, writeMarker } from "./fixtures/log-fixtures.js";
import {
  FAST_POLL_MS,
  awaitSettledRun,
  fastConfig,
  makeFastRepo,
  runRepoOrchestrator,
  startIdleOrchestrator,
  startLiveOrchestrator,
  stopOrchestrator,
} from "./fixtures/orchestrator-fixtures.js";
import { setRef } from "../src/git/git.js";
import { mergeRefName } from "../src/paths.js";
import { headSha, mergeWork, pinOffMain, makeRepo, seedOpenBug, sh, tmpdir, twoPlansDoc, writeMalformedJson } from "./fixtures/repo-fixtures.js";
import { fakePi, fakePiIdle, readRunLines, recordingFakePi } from "./fakes/fake-pi.js";
import { sleep, waitFor } from "./helpers/wait.js";
import { assistantLine } from "./fixtures/pi-events.js";

test("runTimedRoleRun measures the run, not its semaphore queue wait", async () => {
  // BUGS.md 2026-09-18: the restart drain's p75 sample spans `run_start`..`run_end`, so the
  // clock must start after the maxConcurrent permit is granted — a run parked in the queue
  // must not have that wait counted as its run time (which would overstate how long an
  // in-flight run still has and hold the drain open longer than needed). The fake clock
  // advances 500ms inside acquire and 30ms inside run; the sample must read 30, not 530.
  let t = 1000;
  const now = () => t;
  const duration = await runTimedRoleRun(
    new AbortController().signal,
    async () => {
      t += 500; // parked waiting for a permit
    },
    () => {},
    async () => {
      t += 30; // the run's actual duration
      return { result: "changed" };
    },
    now,
  );
  assert.equal(duration, 30);

  // A cut-off run yields no sample: its short length must not drag the p75 down.
  const aborted = await runTimedRoleRun(
    new AbortController().signal,
    async () => {},
    () => {},
    async () => {
      t += 5;
      return { result: "aborted" };
    },
    now,
  );
  assert.equal(aborted, null);

  // A run the harness never starts (already stopping) also yields no sample.
  const stopping = new AbortController();
  stopping.abort();
  let ran = false;
  const never = await runTimedRoleRun(
    stopping.signal,
    async () => {},
    () => {},
    async () => {
      ran = true;
      return { result: "changed" };
    },
    now,
  );
  assert.equal(never, null);
  assert.equal(ran, false, "the timed run does not start once the signal is aborted");

  // The permit is always released, even when the run throws.
  let released = false;
  await assert.rejects(
    runTimedRoleRun(
      new AbortController().signal,
      async () => {},
      () => {
        released = true;
      },
      async () => {
        throw new Error("run blew up");
      },
      now,
    ),
  );
  assert.equal(released, true);
});

test("sleepInterruptible waits out its delay, wakes early on abort, and returns at once when already aborted", async () => {
  // No abort: it resolves after roughly the requested delay (it is a sleep, not a no-op).
  const started = Date.now();
  await sleepInterruptible(20, new AbortController().signal);
  assert.ok(Date.now() - started >= 10, "a signal that never aborts still waits out the sleep");

  // An abort DURING the sleep resolves promptly, so shutdown is not held for a full poll cycle.
  const during = new AbortController();
  const t0 = Date.now();
  const pending = sleepInterruptible(2000, during.signal);
  during.abort();
  await pending;
  assert.ok(Date.now() - t0 < 1000, "an in-flight abort wakes the sleep");

  // An ALREADY-aborted signal must resolve immediately: addEventListener alone would never
  // fire (the event came and went before the listener existed), so a pre-aborted poll would
  // otherwise block shutdown for the whole interval.
  const pre = new AbortController();
  pre.abort();
  const t1 = Date.now();
  await sleepInterruptible(2000, pre.signal);
  assert.ok(Date.now() - t1 < 1000, "a pre-aborted signal returns without sleeping");
});

test("backoff grows by the factor and caps at max", () => {
  const config = defaultConfig();
  config.idleBackoff = { initialSeconds: 10, factor: 3, maxSeconds: 50 };
  let backoff = 0;
  const seen: number[] = [];
  for (let i = 0; i < 4; i++) {
    backoff = nextBackoffSeconds(backoff, config.idleBackoff);
    seen.push(backoff);
  }
  assert.deepEqual(seen, [10, 30, 50, 50]);
});

// --- Orchestrator lifecycle (run/shutdown) ---

test("runOrchestrator runs enabled roles and cleans up on shutdown", async () => {
  const repo = makeRepo();
  await initProject(repo, "orchestrator lifecycle test");
  const config = loadConfig(repo);
  for (const id of Object.keys(config.roles)) {
    if (!["clean", "dedupe"].includes(id)) config.roles[id]!.enabled = false;
  }
  const restore = fakePiIdle();
  const controller = new AbortController();
  try {
    const done = runRepoOrchestrator(repo, {
      config,
      signal: controller.signal,
      // A two-minute poll: a shutdown that waited out the sleep would take that long, so the
      // shutdown bound below can be generous enough that no host load reaches it, while a
      // regression still frees the test file within minutes.
      pollMs: 120_000,
    });
    // The info file is written before the first poll; wait for it.
    await waitFor(() => readOrchestratorInfo(repo) !== null, "the orchestrator info file");
    const info = readOrchestratorInfo(repo);
    assert.ok(info, "orchestrator state file exists while running");
    assert.equal(info.pid, process.pid);
    assert.deepEqual([...info.roles].sort(), ["clean", "dedupe"]);
    assert.ok(orchestratorAlive(repo), "a live orchestrator reports alive");

    // Wait for both startup runs to actually finish (not a fixed sleep): the post-shutdown
    // state and event assertions then observe completed runs, never an abort mid-run.
    await waitFor(
      () =>
        ["clean", "dedupe"].every((role) => {
          const s = loadRunnerState(repo, role);
          return s.runs >= 1 && !s.running;
        }),
      "both startup runs to finish",
    );
    // Shutdown must not wait out the current poll sleep: abort wakes the loop immediately. The
    // bound is a race, not a ceiling on a measurement: 60 s is far beyond a woken shutdown even
    // on a saturated host (2066 ms broke the original 2 s limit, BUGS.md 2026-09-18) and half
    // the poll sleep a non-waking shutdown would wait out — which then fails here, not at the
    // test timeout.
    const tAbort = Date.now();
    controller.abort();
    let bound: NodeJS.Timeout | undefined;
    const woke = await Promise.race([
      done.then(() => true),
      new Promise<boolean>((resolve) => (bound = setTimeout(() => resolve(false), 60_000))),
    ]);
    clearTimeout(bound);
    assert.ok(woke, `shutdown still running ${Date.now() - tAbort}ms after abort — it is waiting out the poll sleep`);

    // Shutdown removed the state file and logged both lifecycle events.
    assert.equal(readOrchestratorInfo(repo), null, "state file removed on shutdown");
    const types = eventTypes(repo);
    assert.ok(types.includes("orchestrator_start"));
    assert.ok(types.includes("orchestrator_stop"));
    assert.equal(eventsOfType(repo, "orchestrator_stop")[0]?.cause, "signal", "the caller abort is a signal stop");
    // Both enabled roles got their startup run.
    for (const role of ["clean", "dedupe"])
      assert.ok(loadRunnerState(repo, role).runs >= 1, `${role} should have run`);
  } finally {
    restore();
    controller.abort();
  }
});

test("runOrchestrator starts one runner per runner id and an unclaimed extra instance stays idle", async () => {
  const repo = await makeFastRepo("instances runner test", ["feature"]);
  const config = loadConfig(repo);
  config.roles.feature = { ...(config.roles.feature ?? { enabled: true }), instances: 3 };
  saveConfig(repo, config);
  // Three instances hold six runner ids (two per instance, so a runner waiting on its change in
  // the merge pipeline does not use up an instance — fast-merge Lever 1). Two eligible plans:
  // feature and feature-2 take one each (part 4/7's claims); feature-3 to feature-6 have no free
  // entry and never run.
  fs.writeFileSync(path.join(repo, "PLANS.md"), twoPlansDoc());
  const restore = fakePiIdle();
  const controller = new AbortController();
  const ids = ["feature", "feature-2", "feature-3", "feature-4", "feature-5", "feature-6"];
  try {
    const done = runRepoOrchestrator(repo, { config, signal: controller.signal, pollMs: FAST_POLL_MS });
    await waitFor(() => readOrchestratorInfo(repo)?.roles.includes("feature-6") === true, "all six runners registered");
    assert.deepEqual([...readOrchestratorInfo(repo)!.roles].sort(), ids);
    await waitFor(
      () => loadRunnerState(repo, "feature").runs >= 1 && loadRunnerState(repo, "feature-2").runs >= 1,
      "the two claimed instances run",
    );
    for (const id of ids.slice(2))
      assert.equal(loadRunnerState(repo, id).runs, 0, `${id}, with no claim, does not run`);
    // Runs lease pooled slots: no per-role worktree is created for the instance.
    assert.equal(fs.existsSync(worktreePath(repo, "feature-2")), false, "no feature-2 role worktree");
    controller.abort();
    await done;
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
      runRepoOrchestrator(repo, { config, signal: controller.signal }),
      // The message names the problem AND the fix, so an operator who disabled every role is
      // told exactly which edit unblocks startup.
      /no roles enabled in tumwater\.json — enable at least one role/,
    );
  } finally {
    controller.abort();
  }
});

// --- Early wakes are observable: a role that runs ahead of its schedule logs why ---

test("a main move and a queued prompt each log exactly one wake event with their reason", async () => {
  const repo = makeRepo();
  await initProject(repo, "wake event test");
  // clean gets a long backoff after its startup run so nothing but an early wake can
  // schedule it again; the director idles until the inbox has work.
  const config = fastConfig(["clean", "director"]);
  config.idleBackoff = { initialSeconds: 60, factor: 1, maxSeconds: 60 };
  saveConfig(repo, config);
  const { restore, orch } = startIdleOrchestrator(repo);
  try {
    // Wait for clean's startup run to finish (its state save records the current main
    // head): from then on it sleeps ~60s, so only a main move can schedule it again.
    await awaitSettledRun(repo, "clean", 1, "the startup run to finish");

    // The world changed: advance main with a real commit. The next poll must wake clean
    // early and log why — the TUI/GUI/logs surface this as `woke (main moved)`.
    fs.writeFileSync(path.join(repo, "world.txt"), "changed\n");
    sh(repo, "git", "add", "-A");
    sh(repo, "git", "commit", "-m", "advance main");

    await waitFor(
      () => readEvents(repo).some((e) => e.type === "wake" && e.reason === "main moved"),
      "a wake event for the main move",
    );
    // The wake actually ran a run, not just logged one.
    await awaitSettledRun(repo, "clean", 2, "the woken run to finish");

    // A queued prompt wakes the idle director the same way (reason: inbox).
    enqueuePrompt(repo, "wake me up");
    await waitFor(
      () => readEvents(repo).some((e) => e.type === "wake" && e.reason === "inbox"),
      "a wake event for the queued prompt",
    );
    await awaitSettledRun(repo, "director", 1, "the director's woken run to finish");

    // Exactly one wake per cause: the running-flag reservation must prevent a re-wake on
    // every poll while the prompt is pending or the run is in flight.
    const wakes = eventsOfType(repo, "wake");
    assert.deepEqual(
      wakes.map((w) => [w.source, w.reason]),
      [
        ["clean", "main moved"],
        ["director", "inbox"],
      ],
    );
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

test("a director holding a kept merge pin wakes on its own clock (reason: leftover), re-queues it, and runs no pi", async () => {
  const repo = await makeFastRepo("director leftover", ["director"]);
  const sha = pinOffMain(repo, (d) => fs.writeFileSync(path.join(d, "kept.txt"), "kept\n"), "kept director change");
  await setRef(repo, mergeRefName("director"), sha);
  const argsFile = path.join(tmpdir(), "pi-args.txt");
  const restore = recordingFakePi(argsFile);
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await waitFor(
      () => readEvents(repo).some((e) => e.type === "wake" && e.source === "director" && e.reason === "leftover"),
      "a leftover wake for the director",
    );
    await waitFor(
      () => eventsOfType(repo, "merge_queued").some((e) => e.source === "director" && e.commit === sha),
      "the director's pin re-queued",
    );
    assert.equal(eventsOfType(repo, "prompt_taken").length, 0, "no prompt was taken");
    assert.equal(fs.existsSync(argsFile), false, "the fake pi was never invoked");
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

test("a director with neither a prompt nor a kept pin never runs", async () => {
  const repo = await makeFastRepo("director idle control", ["director"]);
  const { restore, orch } = startIdleOrchestrator(repo);
  try {
    await sleep(FAST_POLL_MS * 8);
    assert.equal(readEvents(repo).some((e) => e.source === "director" && e.type === "wake"), false);
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

test("a no_change maintenance role defers due runs until work merges on main", async () => {
  // organize runs fast (no min gap, 1s backoff) and declares nothing-to-do every run — so
  // after its startup run it keeps coming due with lastResult no_change: only deferral can
  // keep it quiet while non-work commits merge.
  const repo = await makeFastRepo("deferral test", ["organize"]);
  const argsFile = path.join(tmpdir(), "pi-args.txt");
  const restore = recordingFakePi(argsFile);
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await awaitSettledRun(repo, "organize", 1, "the startup run to finish");

    // A non-work merge (a readme commit) moves main but must not wake the deferred role.
    fs.writeFileSync(path.join(repo, "readme-note.txt"), "x\n");
    sh(repo, "git", "add", "-A");
    sh(repo, "git", "commit", "-m", "tumwater(readme): x");

    // Several poll cycles pass with the interval long since due — still exactly one run.
    await sleep(1000);
    assert.equal(fs.readFileSync(argsFile, "utf8").trim().split("\n").length, 1);
    assert.equal(loadRunnerState(repo, "organize").runs, 1);

    // Work merges: the deferred run starts within one poll and finishes. (This is also the
    // verdict-cache flip case: the earlier false verdict over this range must not be cached.)
    fs.writeFileSync(path.join(repo, "feature-note.txt"), "y\n");
    sh(repo, "git", "add", "-A");
    sh(repo, "git", "commit", "-m", "tumwater(feature): y");
    await awaitSettledRun(repo, "organize", 2, "the woken run to finish");

    // Exactly one deferral episode so far: one event on the transition in, none while merely
    // not-due and none on exit. (The woken run's own no_change outcome starts a fresh
    // episode only after its 1s backoff — outside this assertion window.)
    const deferred = eventsOfType(repo, "run_deferred");
    assert.deepEqual(deferred.map((d) => d.source), ["organize"]);
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

test("a queued prompt ends a deferral episode, so the next deferral is announced again", async () => {
  // The episode bookkeeping behind run_deferred is edge-triggered: the event fires on the
  // transition into a deferral episode, not on every deferred poll. An inbox run (a queued
  // per-role prompt) must end the episode as it takes over — otherwise the flag survives the
  // prompt's run and the NEXT deferral transition is swallowed: the operator sees one
  // run_deferred forever, even though the role keeps deferring between its prompt-driven
  // runs. With the default idle backoff the not-due window after each run already ends the
  // episode, so this test zeroes it: after a no_change run the role is due again on the very
  // next poll, and the inbox run's own episode reset is the only boundary left between two
  // due-deferred stretches. Episode 1 defers, a queued prompt runs the role, episode 2 must
  // log its own event.
  const repo = await makeFastRepo("deferral episode reset test", ["organize"]);
  const cfg = loadConfig(repo);
  cfg.idleBackoff = { initialSeconds: 0, factor: 1, maxSeconds: 0 };
  saveConfig(repo, cfg);
  const restore = recordingFakePi(path.join(tmpdir(), "pi-args-episode.txt"));
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await awaitSettledRun(repo, "organize", 1, "the startup run to finish");

    // Episode 1: due again immediately after the startup run, the no_change role defers —
    // announced once.
    await waitFor(() => eventsOfType(repo, "run_deferred").length === 1, "the first deferral event");

    // The queued prompt pulls the role in on its own due-ness (reason inbox, outside the
    // deferral block) and the run runs to completion.
    submitRolePrompt(repo, "organize", "check the deferral episode reset");
    await awaitSettledRun(repo, "organize", 2, "the prompt-driven run to finish");

    // Episode 2: due again on the next poll, still no_change, still no work merged — and
    // deferring a second time is announced again because the inbox run ended the first
    // episode.
    await waitFor(() => eventsOfType(repo, "run_deferred").length === 2, "the second deferral event");
    const deferred = eventsOfType(repo, "run_deferred").filter((d) => d.source === "organize");
    assert.equal(deferred.length, 2, "both episodes announced, the second not swallowed");
    // And the second episode still defers: no third run while it holds.
    await sleep(500);
    assert.equal(loadRunnerState(repo, "organize").runs, 2, "the second episode defers, it does not run");
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

test("an open bug backlog defers due maintenance runs even when work merges, until it drains", async () => {
  // organize runs fast (no min gap, 1s backoff) and declares nothing-to-do every run — so
  // after its startup run it keeps coming due with lastResult no_change.
  const repo = await makeFastRepo("backlog-aware deferral test", ["organize"]);
  const argsFile = path.join(tmpdir(), "pi-args.txt");
  const restore = recordingFakePi(argsFile);
  // Open the backlog: one entry under BUGS.md `## Open` (the section-anchored pattern hits
  // only that placeholder — `## Fixed` keeps its own).
  seedOpenBug(repo);
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "seed the backlog");
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await awaitSettledRun(repo, "organize", 1, "the startup run to finish");

    // Work merges while the backlog is open: the due maintenance run must stay deferred —
    // before the fix this poll started a new run (workMergedSinceLast broke deferral).
    fs.writeFileSync(path.join(repo, "feature-note.txt"), "y\n");
    sh(repo, "git", "add", "-A");
    sh(repo, "git", "commit", "-m", "tumwater(feature): y");
    await sleep(1000);
    assert.equal(fs.readFileSync(argsFile, "utf8").trim().split("\n").length, 1);
    assert.equal(loadRunnerState(repo, "organize").runs, 1);

    // The bugfix role fixes the last open bug: its merge drains BUGS.md `## Open` (and
    // counts as work) — the deferred run starts within one poll of either conjunct flipping.
    fs.writeFileSync(
      path.join(repo, "BUGS.md"),
      fs.readFileSync(path.join(repo, "BUGS.md"), "utf8").replace("### An open bug\n", ""),
    );
    sh(repo, "git", "add", "-A");
    sh(repo, "git", "commit", "-m", "tumwater(bugfix): fix the open bug");
    await awaitSettledRun(repo, "organize", 2, "the woken run to finish");

    // One deferral episode: one event on the transition in, none while merely not-due and
    // none on exit.
    const deferred = eventsOfType(repo, "run_deferred");
    assert.deepEqual(deferred.map((d) => d.source), ["organize"]);
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

test("a maintenance role deferred past DEFER_MAX_MS runs anyway, despite an open backlog", async () => {
  const repo = await makeFastRepo("deferral cap test", ["organize"]);
  // Open the backlog: the deferral predicate's backlog term holds permanently, which before
  // the cap froze `lastResult` at no_change and silenced the role forever.
  seedOpenBug(repo);
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "seed the backlog");

  // Seed the role exactly as a long-deferred no_change run looks on disk: its scheduled time
  // is already past the cap. The fix must let it run; the pre-fix predicate deferred it forever.
  const state = freshRunnerState("organize");
  state.runs = 1;
  state.lastResult = "no_change";
  state.lastMainHead = headSha(repo);
  state.lastRunEndedAt = Date.now() - 60_000;
  state.nextRunAt = Date.now() - DEFER_MAX_MS - 60_000;
  saveRunnerState(repo, state);

  const argsFile = path.join(tmpdir(), "pi-args.txt");
  const restore = recordingFakePi(argsFile);
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await awaitSettledRun(repo, "organize", 2, "the cap-forced run to finish");
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

// --- Session retention at startup ---

/** Seed a pi session file under .tumwater/sessions/<role>/ backdated `days` days old. */
function seedOldSession(repo: string, role: string, days: number): string {
  const dir = path.join(repo, ".tumwater", "sessions", role);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `old-${Date.now()}.jsonl`);
  fs.writeFileSync(file, '{"type":"message_start"}\n');
  backdate(file, days * 24 * 3600 * 1000);
  return file;
}

/** Seed a full-tool-output file under .tumwater/log/tool-output/ (what the bundled pi
 * extension writes for oversized tool results) backdated `days` days old. */
function seedOldToolOutput(repo: string, days: number): string {
  const dir = path.join(repo, ".tumwater", "log", "tool-output");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `call-old-${Date.now()}.log`);
  fs.writeFileSync(file, "tool output\n");
  backdate(file, days * 24 * 3600 * 1000);
  return file;
}

function pruneWarnings(repo: string): number {
  return readEvents(repo).filter(
    (e) => e.type === "warning" && ((e.message as string | undefined) ?? "").includes("pruned"),
  ).length;
}

test("sessionRetentionDays 0 disables pruning: old sessions survive orchestrator startup", async () => {
  const repo = makeRepo();
  await initProject(repo, "retention zero test");
  const config = fastConfig(["clean"]);
  config.sessionRetentionDays = 0;
  saveConfig(repo, config);
  const session = seedOldSession(repo, "clean", 30); // older than any positive retention
  const { restore, orch } = startIdleOrchestrator(repo);
  try {
    // Pruning (or its skip) runs synchronously at startup; wait for the orchestrator to be up
    // plus a few fast poll cycles so the assertion is not racing the startup code.
    await waitFor(() => readOrchestratorInfo(repo) !== null, "orchestrator state file");
    await sleep(400);
    assert.ok(fs.existsSync(session), "a 30-day-old session survives when retention is 0");
    assert.equal(pruneWarnings(repo), 0, "no prune warning when pruning is disabled");
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

test("a positive sessionRetentionDays still prunes old sessions at startup", async () => {
  const repo = makeRepo();
  await initProject(repo, "retention prune test");
  const config = fastConfig(["clean"]);
  config.sessionRetentionDays = 7;
  saveConfig(repo, config);
  const session = seedOldSession(repo, "clean", 30);
  const toolOutput = seedOldToolOutput(repo, 30);
  const { restore, orch } = startIdleOrchestrator(repo);
  try {
    await waitFor(() => !fs.existsSync(session), "the old session to be pruned");
    assert.ok(!fs.existsSync(toolOutput), "the old full-tool-output file is pruned too");
    assert.equal(pruneWarnings(repo), 1, "one prune warning for the deleted files");
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

// --- Live session retention (PLANS.md: Live sessionRetentionDays) ---

test("a live sessionRetentionDays edit re-prunes without a restart", async () => {
  const repo = makeRepo();
  await initProject(repo, "live retention test");
  // Retention 30 at startup: the ~2-day-old session is younger than the window and survives.
  const base = fastConfig(["clean"]);
  base.sessionRetentionDays = 30;
  saveConfig(repo, base);
  const recent = seedOldSession(repo, "clean", 2); // older than the new window of 1, younger than 30
  const { restore, orch } = startIdleOrchestrator(repo);
  try {
    await waitFor(() => readOrchestratorInfo(repo) !== null, "orchestrator state file");
    // Startup pruning runs synchronously before the first poll; a few fast poll cycles keep the
    // survival assertion from racing startup.
    await sleep(400);
    assert.ok(fs.existsSync(recent), "a ~2-day-old session survives startup under retention 30");

    // Phase 1 (edit to 1): a mid-run edit re-prunes immediately — one change event and one
    // prune warning naming the count, no restart.
    const tight = fastConfig(["clean"]);
    tight.sessionRetentionDays = 1;
    saveConfig(repo, tight);
    await waitFor(() => !fs.existsSync(recent), "the ~2-day-old session to be pruned");
    assert.equal(pruneWarnings(repo), 1, "one prune warning for the deleted file");

    // Phase 2 (back to 30): loosening changes the value but prunes nothing — a second change
    // event with no second prune warning.
    const loose = fastConfig(["clean"]);
    loose.sessionRetentionDays = 30;
    saveConfig(repo, loose);
    await waitFor(
      () => eventsOfType(repo, "retention_changed").length >= 2,
      "the second retention_changed event",
    );
    assert.equal(pruneWarnings(repo), 1, "loosening the window prunes nothing");

    // Phase 3 (to 0): plant a ~45-day-old file mid-run — the daily gate is not due (phase 1's
    // prune set lastPruneAt seconds ago), so it sits until the edit. Setting retention to 0
    // skips pruning: 0 disables rather than "delete all", so the ancient file survives.
    const ancient = seedOldSession(repo, "clean", 45);
    const off = fastConfig(["clean"]);
    off.sessionRetentionDays = 0;
    saveConfig(repo, off);
    await waitFor(
      () => eventsOfType(repo, "retention_changed").length >= 3,
      "the third retention_changed event",
    );
    // The on-change path already ran when the third event was logged; a few fast poll cycles
    // keep the survival assertion from racing any later poll (none can prune: the daily gate is
    // not due).
    await sleep(400);
    assert.ok(fs.existsSync(ancient), "retention 0 disables pruning — the ancient file survives");

    // Exactly one change event per distinct edit (three total); unchanged polls log nothing.
    const changes = eventsOfType(repo, "retention_changed");
    assert.equal(changes.length, 3);
    assert.deepEqual(
      changes.map((c) => [c.source, c.from, c.to]),
      [
        ["tumwater", 30, 1],
        ["tumwater", 1, 30],
        ["tumwater", 30, 0],
      ],
    );
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

// --- Live-reload tumwater.json while running ---

test("mid-run tumwater.json edits steer the team; a broken file keeps last-known-good", async () => {
  // bugfix (a work-tier role) on purpose: it is never deferred by need-based prioritization,
  // so this config-reload pin stays decoupled from scheduling timing — deferral itself is
  // pinned in its own test below. The open bug keeps that premise true: with an empty BUGS.md
  // `## Open` bugfix defers like a maintenance role (deferRun), and a deferred run would
  // starve this test of the pi runs it asserts on.
  const repo = await makeFastRepo("live reload test", ["bugfix"], "good-model");
  seedOpenBug(repo);
  const argsFile = path.join(tmpdir(), "argv.log");
  fs.rmSync(argsFile, { force: true }); // A previous run's lines must not leak into this one.
  const restore = recordingFakePi(argsFile);
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    // Assert on what pi actually saw (its recorded argv), not on run counts: a run can be
    // scheduled before our file write lands, so only the argv evidence pins a run to a config.
    // The file is created by pi's first run; until then there are no runs.
    // recordingFakePi writes one `run model=… provider=…` line per pi invocation.
    const runs = (): string[] => readRunLines(argsFile);
    await waitFor(
      () => runs().length >= 1 && runs()[0]?.includes("model=good-model") === true,
      "first pi run",
    );

    // A mid-run edit applies within a poll cycle — no restart.
    saveConfig(repo, fastConfig(["bugfix"], "reloaded-model"));
    await waitFor(() => runs().at(-1)?.includes("model=reloaded-model") === true, "pi run with the edited model");

    // A broken file keeps the last-known-good config and warns exactly once.
    writeMalformedJson(path.join(repo, "tumwater.json"));
    const runsBeforeBreak = runs().length;
    await waitFor(
      () => runs().length > runsBeforeBreak && runs().at(-1)?.includes("model=reloaded-model") === true,
      "a further pi run while the file is broken",
    );
    const warnings = () =>
      readEvents(repo).filter(
        (e) => e.type === "warning" && ((e.message as string | undefined) ?? "").includes("tumwater.json invalid"),
      );
    assert.equal(warnings().length, 1, "one warning for the broken file");

    // Fixing the file recovers: the new value applies and no further warnings appear.
    saveConfig(repo, fastConfig(["bugfix"], "fixed-model"));
    await waitFor(() => runs().at(-1)?.includes("model=fixed-model") === true, "pi run with the fixed model");
    assert.equal(warnings().length, 1, "no new warnings once the file is fixed");
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

test("a reset request zeroes in-memory counters, survives run boundaries, and logs an event", async () => {
  const repo = await makeFastRepo("reset counters e2e test", ["clean"]);
  const { restore, orch } = startIdleOrchestrator(repo);
  try {
    // Let a couple of runs accumulate counters in the runner's memory. clean is deferrable
    // (need-based prioritization), so the second run needs a work merge to wake it.
    await awaitSettledRun(repo, "clean", 1, "the first run to finish");
    mergeWork(repo);
    await awaitSettledRun(repo, "clean", 2, "two finished runs");

    // Reproduce what `tumwater reset-counters` does from the CLI side: zero the state file
    // and drop the marker. (The CLI path itself is covered in test/cli.test.ts.)
    saveRunnerState(repo, zeroCounters(loadRunnerState(repo, "clean")));
    const markerFile = resetRequestPath(repo);
    writeMarker(markerFile, { at: Date.now(), roles: ["clean"] });

    // The team consumes the marker within a poll cycle and re-saves zeroed counters. A
    // post-reset run may have started in the same poll (its +1 belongs to the new window),
    // so at most 1 is expected — without in-memory zeroing this would read >= 3.
    await waitFor(() => !fs.existsSync(markerFile), "the marker to be consumed");
    assert.ok(
      loadRunnerState(repo, "clean").runs <= 1,
      `counters start from zero after consumption (got ${loadRunnerState(repo, "clean").runs})`,
    );

    // The reset survives run boundaries: the next completed run counts from zero — a stale
    // in-memory copy would have saved runs >= 3 here instead. A work merge wakes the
    // deferred role for that post-reset run.
    mergeWork(repo);
    await waitFor(
      () => loadRunnerState(repo, "clean").runs === 1 && !loadRunnerState(repo, "clean").running,
      "a post-reset run to finish",
    );

    // The reset is visible as one plain event (no warning prefix), filed under the role.
    const resets = eventsOfType(repo, "counters_reset");
    assert.equal(resets.length, 1);
    assert.equal(resets[0]?.source, "clean");
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

test("a reset consumed while a run is in flight does not wedge the role", async () => {
  const repo = await makeFastRepo("mid-run reset test", ["clean"]);
  // A slow fake pi: each run holds for ~2s — long enough that a marker dropped while the
  // first run is in flight (observed within a poll or two of start, consumed within one)
  // arrives mid-run. That is the documented use case (resetting a running team), where most
  // roles are mid-run at any moment.
  const restore = fakePi(`sleep 2\nprintf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`);
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await waitFor(() => loadRunnerState(repo, "clean").running === true, "a run to be in flight");

    // Drop the marker while the run is in progress (CLI-side file zeroing included).
    saveRunnerState(repo, zeroCounters(loadRunnerState(repo, "clean")));
    const markerFile = resetRequestPath(repo);
    writeMarker(markerFile, { at: Date.now(), roles: ["clean"] });

    await waitFor(() => !fs.existsSync(markerFile), "the marker to be consumed");

    // The in-flight run must still end cleanly: its running flag clears on disk. Before the
    // fix, resetCounters() replaced the state object mid-run, so the run's end-of-save
    // wrote back the zeroed copy — which still carried running=true — and the role was wedged
    // (never eligible again) until a restart.
    await waitFor(
      () => loadRunnerState(repo, "clean").running === false,
      "the in-flight run to finish",
    );

    // Counters stayed zeroed: no resurrection from the pre-reset in-memory copy.
    assert.ok(
      loadRunnerState(repo, "clean").runs <= 1,
      `counters start from zero after a mid-run reset (got ${loadRunnerState(repo, "clean").runs})`,
    );

    // And the role keeps running: a post-reset run runs to completion.
    await awaitSettledRun(repo, "clean", 1, "a post-reset run to finish");

    // The reset is still visible as one plain event, filed under the role.
    const resets = eventsOfType(repo, "counters_reset");
    assert.equal(resets.length, 1);
    assert.equal(resets[0]?.source, "clean");
  } finally {
    await stopOrchestrator(orch, restore);
  }
});

test("the primary checkout moving branches mid-run logs exactly one warning (portability 2/7)", async () => {
  const repo = await makeFastRepo("branch divergence test", ["clean"]);
  const { restore, orch } = startIdleOrchestrator(repo);
  try {
    // Let one poll pass so the divergence watch is seeded against the startup branch.
    await waitFor(() => loadRunnerState(repo, "clean").runs >= 1, "the startup run to finish");

    // A human checks out something else in the primary checkout mid-run: one warning names
    // the divergence, and the team keeps merging into the branch it resolved at startup.
    sh(repo, "git", "checkout", "-b", "experiment");
    await waitFor(
      () =>
        readEvents(repo).some(
          (e) => e.type === "warning" && String(e.message).includes('your checkout moved to experiment'),
        ),
      "one divergence warning",
    );

    // Edge-triggered: more polls on the foreign branch stay quiet.
    await sleep(FAST_POLL_MS * 5);
    const during = readEvents(repo).filter(
      (e) => e.type === "warning" && String(e.message).includes('your checkout moved'),
    );
    assert.equal(during.length, 1, JSON.stringify(during));

    // Returning to the target branch re-arms the check, so a second episode warns again.
    sh(repo, "git", "checkout", "main");
    await sleep(FAST_POLL_MS * 3);
    sh(repo, "git", "checkout", "experiment");
    await waitFor(
      () =>
        readEvents(repo).filter(
          (e) => e.type === "warning" && String(e.message).includes('your checkout moved'),
        ).length === 2,
      "a second warning after re-arming",
    );
  } finally {
    await stopOrchestrator(orch, restore);
  }
});
