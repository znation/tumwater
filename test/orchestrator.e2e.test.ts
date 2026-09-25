/** The orchestrator e2e tier (orchestrator-2…5.e2e.test.ts are the other slices): these tests
 * start a live orchestrator and wait on real timers, so their fixed wall-clock budgets are
 * not reliable on a loaded machine — they run via `npm run test:e2e` (and CI), not in the
 * unfiltered `npm test` run the harness's landing gate executes (BUGS.md 2026-09-21). The
 * slices run in parallel processes; this one holds scheduling basics, deferral, session
 * pruning, live config edits, reset requests and the branch watch, orchestrator-4 the live
 * maxConcurrent resize (the tier's single longest test), orchestrator-5 the shared-permit and
 * tier-ordering cases. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runOrchestrator, runTimedRoleTick, sleepInterruptible } from "../src/orchestrator.js";
import { DEFER_MAX_MS } from "../src/scheduling.js";
import { defaultConfig, loadConfig, saveConfig } from "../src/config.js";
import { initProject } from "../src/init.js";
import { enqueuePrompt } from "../src/inbox.js";
import { readEvents } from "../src/events.js";
import {
  freshLoopState,
  loadLoopState,
  nextBackoffSeconds,
  saveLoopState,
  zeroCounters,
} from "../src/state.js";
import { orchestratorAlive, readOrchestratorInfo } from "../src/fleet-state.js";
import { resetRequestPath } from "../src/paths.js";
import {
  assistantLine,
  fakePi,
  FAST_POLL_MS,
  fastConfig,
  landWork,
  makeRepo,
  recordingFakePi,
  sh,
  startLiveOrchestrator,
  tmpdir,
  waitFor,
} from "./util.js";

test("runTimedRoleTick measures the tick, not its semaphore queue wait", async () => {
  // BUGS.md 2026-09-18: the restart drain's p75 sample spans `tick_start`..`tick_end`, so the
  // clock must start after the maxConcurrent permit is granted — a tick parked in the queue
  // must not have that wait counted as its run time (which would overstate how long an
  // in-flight tick still has and hold the drain open longer than needed). The fake clock
  // advances 500ms inside acquire and 30ms inside tick; the sample must read 30, not 530.
  let t = 1000;
  const now = () => t;
  const duration = await runTimedRoleTick(
    new AbortController().signal,
    async () => {
      t += 500; // parked waiting for a permit
    },
    () => {},
    async () => {
      t += 30; // the tick's actual run
      return { result: "changed" };
    },
    now,
  );
  assert.equal(duration, 30);

  // A cut-off tick yields no sample: its short length must not drag the p75 down.
  const aborted = await runTimedRoleTick(
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

  // A tick the harness never starts (already stopping) also yields no sample.
  const stopping = new AbortController();
  stopping.abort();
  let ran = false;
  const never = await runTimedRoleTick(
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
  assert.equal(ran, false, "the tick does not run once the signal is aborted");

  // The permit is always released, even when the tick throws.
  let released = false;
  await assert.rejects(
    runTimedRoleTick(
      new AbortController().signal,
      async () => {},
      () => {
        released = true;
      },
      async () => {
        throw new Error("tick blew up");
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
    const done = runOrchestrator({
      root: repo,
      config,
      mainBranch: "main",
      signal: controller.signal,
      pollMs: 5000, // Long poll so the shutdown-ceiling assertion below is unambiguous under load.
    });
    // The info file is written before the first poll; wait for it.
    const deadline = Date.now() + 5000;
    while (!readOrchestratorInfo(repo) && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 25));
    const info = readOrchestratorInfo(repo);
    assert.ok(info, "orchestrator state file exists while running");
    assert.equal(info.pid, process.pid);
    assert.deepEqual([...info.roles].sort(), ["clean", "dry"]);
    assert.ok(orchestratorAlive(repo), "a live orchestrator reports alive");

    // Wait for both startup ticks to actually finish (not a fixed sleep): the post-shutdown
    // state and event assertions then observe completed runs, never an abort mid-tick.
    await waitFor(
      () =>
        ["clean", "dry"].every((role) => {
          const s = loadLoopState(repo, role);
          return s.ticks >= 1 && !s.running;
        }),
      "both startup ticks to finish",
    );
    // Shutdown must not wait out the current poll sleep: abort wakes the loop immediately, so
    // this resolves in milliseconds. The 5s poll makes the ceiling unambiguous even under full-
    // suite load — a woken shutdown stays far below 2s (observed worst ~1s), while old,
    // non-interruptible behavior would wait out up to the whole 5s sleep and blow it often.
    const tAbort = Date.now();
    controller.abort();
    await done;
    // 3.5s, not 2s: the poll sleep is 5s, so anything comfortably under it still proves the
    // abort WOKE the sleep rather than being waited out — which is the invariant — while
    // surviving the scheduling jitter that made this fail at 2066ms (BUGS.md 2026-09-18).
    assert.ok(
      Date.now() - tAbort < 3500,
      `shutdown took ${Date.now() - tAbort}ms — it waited out the poll sleep instead of waking on abort`,
    );

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
      // The message names the problem AND the fix, so an operator who disabled every role is
      // told exactly which edit unblocks startup.
      /no roles enabled in tumwater\.json — enable at least one role/,
    );
  } finally {
    controller.abort();
  }
});

// --- Early wakes are observable: a loop that runs ahead of its schedule logs why ---

test("a main move and a queued prompt each log exactly one wake event with their reason", async () => {
  const repo = makeRepo();
  await initProject(repo, "wake event test");
  // clean gets a long backoff after its startup tick so nothing but an early wake can
  // schedule it again; the director idles until the inbox has work.
  const config = fastConfig(["clean", "director"]);
  config.idleBackoff = { initialSeconds: 60, factor: 1, maxSeconds: 60 };
  saveConfig(repo, config);
  const restore = fakePi(`printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`);
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    // Wait for clean's startup tick to finish (its state save records the current main
    // head): from then on it sleeps ~60s, so only a main move can schedule it again.
    await waitFor(
      () => loadLoopState(repo, "clean").ticks >= 1 && !loadLoopState(repo, "clean").running,
      "the startup tick to finish",
    );

    // The world changed: advance main with a real commit. The next poll must wake clean
    // early and log why — the TUI/GUI/logs surface this as `woke (main moved)`.
    fs.writeFileSync(path.join(repo, "world.txt"), "changed\n");
    sh(repo, "git", "add", "-A");
    sh(repo, "git", "commit", "-m", "advance main");

    await waitFor(
      () => readEvents(repo).some((e) => e.type === "wake" && e.reason === "main moved"),
      "a wake event for the main move",
    );
    // The wake actually ran a tick, not just logged one.
    await waitFor(
      () => loadLoopState(repo, "clean").ticks >= 2 && !loadLoopState(repo, "clean").running,
      "the woken tick to finish",
    );

    // A queued prompt wakes the idle director the same way (reason: inbox).
    enqueuePrompt(repo, "wake me up");
    await waitFor(
      () => readEvents(repo).some((e) => e.type === "wake" && e.reason === "inbox"),
      "a wake event for the queued prompt",
    );
    await waitFor(
      () => loadLoopState(repo, "director").ticks >= 1 && !loadLoopState(repo, "director").running,
      "the director's woken tick to finish",
    );

    // Exactly one wake per cause: the running-flag reservation must prevent a re-wake on
    // every poll while the prompt is pending or the tick is in flight.
    const wakes = readEvents(repo).filter((e) => e.type === "wake");
    assert.deepEqual(
      wakes.map((w) => [w.loop, w.reason]),
      [
        ["clean", "main moved"],
        ["director", "inbox"],
      ],
    );
  } finally {
    restore();
    await orch.stop();
  }
});

test("a no_change maintenance role defers due ticks until work lands on main", async () => {
  const repo = makeRepo();
  await initProject(repo, "deferral test");
  // organize ticks fast (no min gap, 1s backoff) and declares nothing-to-do every run — so
  // after its startup tick it keeps coming due with lastResult no_change: only deferral can
  // keep it quiet while non-work commits land.
  saveConfig(repo, fastConfig(["organize"]));
  const argsFile = path.join(tmpdir(), "pi-args.txt");
  const restore = recordingFakePi(argsFile);
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await waitFor(
      () => loadLoopState(repo, "organize").ticks >= 1 && !loadLoopState(repo, "organize").running,
      "the startup tick to finish",
    );

    // A non-work landing (a readme commit) moves main but must not wake the deferred role.
    fs.writeFileSync(path.join(repo, "readme-note.txt"), "x\n");
    sh(repo, "git", "add", "-A");
    sh(repo, "git", "commit", "-m", "tumwater(readme): x");

    // Several poll cycles pass with the interval long since due — still exactly one run.
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(fs.readFileSync(argsFile, "utf8").trim().split("\n").length, 1);
    assert.equal(loadLoopState(repo, "organize").ticks, 1);

    // Work lands: the deferred tick starts within one poll and finishes. (This is also the
    // verdict-cache flip case: the earlier false verdict over this range must not be cached.)
    fs.writeFileSync(path.join(repo, "feature-note.txt"), "y\n");
    sh(repo, "git", "add", "-A");
    sh(repo, "git", "commit", "-m", "tumwater(feature): y");
    await waitFor(
      () => loadLoopState(repo, "organize").ticks >= 2 && !loadLoopState(repo, "organize").running,
      "the woken tick to finish",
    );

    // Exactly one deferral episode so far: one event on the transition in, none while merely
    // not-due and none on exit. (The woken tick's own no_change outcome starts a fresh
    // episode only after its 1s backoff — outside this assertion window.)
    const deferred = readEvents(repo).filter((e) => e.type === "tick_deferred");
    assert.deepEqual(deferred.map((d) => d.loop), ["organize"]);
  } finally {
    restore();
    await orch.stop();
  }
});

test("an open bug backlog defers due maintenance ticks even when work lands, until it drains", async () => {
  const repo = makeRepo();
  await initProject(repo, "backlog-aware deferral test");
  // organize ticks fast (no min gap, 1s backoff) and declares nothing-to-do every run — so
  // after its startup tick it keeps coming due with lastResult no_change.
  saveConfig(repo, fastConfig(["organize"]));
  const argsFile = path.join(tmpdir(), "pi-args.txt");
  const restore = recordingFakePi(argsFile);
  // Open the backlog: one entry under BUGS.md `## Open` (the section-anchored pattern hits
  // only that placeholder — `## Fixed` keeps its own).
  fs.writeFileSync(
    path.join(repo, "BUGS.md"),
    fs.readFileSync(path.join(repo, "BUGS.md"), "utf8").replace("## Open\n\n_None yet._", "## Open\n\n### An open bug\n"),
  );
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "seed the backlog");
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await waitFor(
      () => loadLoopState(repo, "organize").ticks >= 1 && !loadLoopState(repo, "organize").running,
      "the startup tick to finish",
    );

    // Work lands while the backlog is open: the due maintenance tick must stay deferred —
    // before the fix this poll started a new run (workLandedSinceLast broke deferral).
    fs.writeFileSync(path.join(repo, "feature-note.txt"), "y\n");
    sh(repo, "git", "add", "-A");
    sh(repo, "git", "commit", "-m", "tumwater(feature): y");
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(fs.readFileSync(argsFile, "utf8").trim().split("\n").length, 1);
    assert.equal(loadLoopState(repo, "organize").ticks, 1);

    // The bugfix role fixes the last open bug: its landing drains BUGS.md `## Open` (and
    // counts as work) — the deferred tick starts within one poll of either conjunct flipping.
    fs.writeFileSync(
      path.join(repo, "BUGS.md"),
      fs.readFileSync(path.join(repo, "BUGS.md"), "utf8").replace("### An open bug\n", ""),
    );
    sh(repo, "git", "add", "-A");
    sh(repo, "git", "commit", "-m", "tumwater(bugfix): fix the open bug");
    await waitFor(
      () => loadLoopState(repo, "organize").ticks >= 2 && !loadLoopState(repo, "organize").running,
      "the woken tick to finish",
    );

    // One deferral episode: one event on the transition in, none while merely not-due and
    // none on exit.
    const deferred = readEvents(repo).filter((e) => e.type === "tick_deferred");
    assert.deepEqual(deferred.map((d) => d.loop), ["organize"]);
  } finally {
    restore();
    await orch.stop();
  }
});

test("a maintenance role deferred past DEFER_MAX_MS ticks anyway, despite an open backlog", async () => {
  const repo = makeRepo();
  await initProject(repo, "deferral cap test");
  saveConfig(repo, fastConfig(["organize"]));
  // Open the backlog: the deferral predicate's backlog term holds permanently, which before
  // the cap froze `lastResult` at no_change and silenced the role forever.
  fs.writeFileSync(
    path.join(repo, "BUGS.md"),
    fs.readFileSync(path.join(repo, "BUGS.md"), "utf8").replace("## Open\n\n_None yet._", "## Open\n\n### An open bug\n"),
  );
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "seed the backlog");

  // Seed the loop exactly as a long-deferred no_change tick looks on disk: its scheduled time
  // is already past the cap. The fix must let it run; the pre-fix predicate deferred it forever.
  const state = freshLoopState("organize");
  state.ticks = 1;
  state.lastResult = "no_change";
  state.lastMainHead = sh(repo, "git", "rev-parse", "HEAD");
  state.lastTickEndedAt = Date.now() - 60_000;
  state.nextRunAt = Date.now() - DEFER_MAX_MS - 60_000;
  saveLoopState(repo, state);

  const argsFile = path.join(tmpdir(), "pi-args.txt");
  const restore = recordingFakePi(argsFile);
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await waitFor(
      () => loadLoopState(repo, "organize").ticks >= 2 && !loadLoopState(repo, "organize").running,
      "the cap-forced tick to run",
    );
  } finally {
    restore();
    await orch.stop();
  }
});

// --- Session retention at startup ---

/** Seed a pi session file under .tumwater/sessions/<role>/ backdated `days` days old. */
function seedOldSession(repo: string, role: string, days: number): string {
  const dir = path.join(repo, ".tumwater", "sessions", role);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `old-${Date.now()}.jsonl`);
  fs.writeFileSync(file, '{"type":"message_start"}\n');
  const t = (Date.now() - days * 24 * 3600 * 1000) / 1000;
  fs.utimesSync(file, t, t);
  return file;
}

/** Seed a full-tool-output file under .tumwater/log/tool-output/ (what the bundled pi
 * extension writes for oversized tool results) backdated `days` days old. */
function seedOldToolOutput(repo: string, days: number): string {
  const dir = path.join(repo, ".tumwater", "log", "tool-output");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `call-old-${Date.now()}.log`);
  fs.writeFileSync(file, "tool output\n");
  const t = (Date.now() - days * 24 * 3600 * 1000) / 1000;
  fs.utimesSync(file, t, t);
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
  const restore = fakePi(`printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`);
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    // Pruning (or its skip) runs synchronously at startup; wait for the orchestrator to be up
    // plus a few fast poll cycles so the assertion is not racing the startup code.
    await waitFor(() => readOrchestratorInfo(repo) !== null, "orchestrator state file");
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(fs.existsSync(session), "a 30-day-old session survives when retention is 0");
    assert.equal(pruneWarnings(repo), 0, "no prune warning when pruning is disabled");
  } finally {
    restore();
    await orch.stop();
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
  const restore = fakePi(`printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`);
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await waitFor(() => !fs.existsSync(session), "the old session to be pruned");
    assert.ok(!fs.existsSync(toolOutput), "the old full-tool-output file is pruned too");
    assert.equal(pruneWarnings(repo), 1, "one prune warning for the deleted files");
  } finally {
    restore();
    await orch.stop();
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
  const restore = fakePi(`printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`);
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await waitFor(() => readOrchestratorInfo(repo) !== null, "orchestrator state file");
    // Startup pruning runs synchronously before the first poll; a few fast poll cycles keep the
    // survival assertion from racing startup.
    await new Promise((r) => setTimeout(r, 400));
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
      () => readEvents(repo).filter((e) => e.type === "retention_changed").length >= 2,
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
      () => readEvents(repo).filter((e) => e.type === "retention_changed").length >= 3,
      "the third retention_changed event",
    );
    // The on-change path already ran when the third event was logged; a few fast poll cycles
    // keep the survival assertion from racing any later poll (none can prune: the daily gate is
    // not due).
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(fs.existsSync(ancient), "retention 0 disables pruning — the ancient file survives");

    // Exactly one change event per distinct edit (three total); unchanged polls log nothing.
    const changes = readEvents(repo).filter((e) => e.type === "retention_changed");
    assert.equal(changes.length, 3);
    assert.deepEqual(
      changes.map((c) => [c.loop, c.from, c.to]),
      [
        ["harness", 30, 1],
        ["harness", 1, 30],
        ["harness", 30, 0],
      ],
    );
  } finally {
    restore();
    await orch.stop();
  }
});

// --- Live-reload tumwater.json while running ---

test("mid-run tumwater.json edits steer the fleet; a broken file keeps last-known-good", async () => {
  const repo = makeRepo();
  await initProject(repo, "live reload test");
  // bugfix (a work-tier role) on purpose: it is never deferred by need-based prioritization,
  // so this config-reload pin stays decoupled from scheduling timing — deferral itself is
  // pinned in its own test below.
  saveConfig(repo, fastConfig(["bugfix"], "good-model"));
  const argsFile = path.join(tmpdir(), "argv.log");
  fs.rmSync(argsFile, { force: true }); // A previous run's lines must not leak into this one.
  const restore = recordingFakePi(argsFile);
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    // Assert on what pi actually saw (its recorded argv), not on tick counts: a tick can be
    // scheduled before our file write lands, so only the argv evidence pins a run to a config.
    // The file is created by pi's first run; until then there are no runs.
    const runs = (): string[] => {
      try {
        // recordingFakePi writes one `run model=… provider=…` line per pi invocation.
        return fs.readFileSync(argsFile, "utf8").split("\n").filter((l) => l.startsWith("run:"));
      } catch {
        return [];
      }
    };
    await waitFor(
      () => runs().length >= 1 && runs()[0]?.includes("model=good-model") === true,
      "first pi run",
    );

    // A mid-run edit applies within a poll cycle — no restart.
    saveConfig(repo, fastConfig(["bugfix"], "reloaded-model"));
    await waitFor(() => runs().at(-1)?.includes("model=reloaded-model") === true, "pi run with the edited model");

    // A broken file keeps the last-known-good config and warns exactly once.
    fs.writeFileSync(path.join(repo, "tumwater.json"), "{ not json");
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
    restore();
    await orch.stop();
  }
});

test("a reset request zeroes in-memory counters, survives tick boundaries, and logs an event", async () => {
  const repo = makeRepo();
  await initProject(repo, "reset counters e2e test");
  saveConfig(repo, fastConfig(["clean"]));
  const restore = fakePi(`printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`);
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    // Let a couple of ticks accumulate counters in the runner's memory. clean is deferrable
    // (need-based prioritization), so the second tick needs a work landing to wake it.
    await waitFor(
      () => loadLoopState(repo, "clean").ticks >= 1 && !loadLoopState(repo, "clean").running,
      "the first tick to finish",
    );
    landWork(repo);
    await waitFor(
      () => loadLoopState(repo, "clean").ticks >= 2 && !loadLoopState(repo, "clean").running,
      "two finished ticks",
    );

    // Reproduce what `tumwater reset-counters` does from the CLI side: zero the state file
    // and drop the marker. (The CLI path itself is covered in test/cli.test.ts.)
    saveLoopState(repo, zeroCounters(loadLoopState(repo, "clean")));
    const markerFile = resetRequestPath(repo);
    fs.mkdirSync(path.dirname(markerFile), { recursive: true });
    fs.writeFileSync(markerFile, JSON.stringify({ at: Date.now(), roles: ["clean"] }));

    // The fleet consumes the marker within a poll cycle and re-saves zeroed counters. A
    // post-reset tick may have started in the same poll (its +1 belongs to the new window),
    // so at most 1 is expected — without in-memory zeroing this would read >= 3.
    await waitFor(() => !fs.existsSync(markerFile), "the marker to be consumed");
    assert.ok(
      loadLoopState(repo, "clean").ticks <= 1,
      `counters start from zero after consumption (got ${loadLoopState(repo, "clean").ticks})`,
    );

    // The reset survives tick boundaries: the next completed tick counts from zero — a stale
    // in-memory copy would have saved ticks >= 3 here instead. A work landing wakes the
    // deferred role for that post-reset tick.
    landWork(repo);
    await waitFor(
      () => loadLoopState(repo, "clean").ticks === 1 && !loadLoopState(repo, "clean").running,
      "a post-reset tick to finish",
    );

    // The reset is visible as one plain event (no warning prefix), filed under the role.
    const resets = readEvents(repo).filter((e) => e.type === "counters_reset");
    assert.equal(resets.length, 1);
    assert.equal(resets[0]?.loop, "clean");
  } finally {
    restore();
    await orch.stop();
  }
});

test("a reset consumed while a tick is in flight does not wedge the loop", async () => {
  const repo = makeRepo();
  await initProject(repo, "mid-tick reset test");
  saveConfig(repo, fastConfig(["clean"]));
  // A slow fake pi: each tick holds for ~2s — long enough that a marker dropped while the
  // first tick is in flight (observed within a poll or two of start, consumed within one)
  // lands mid-tick. That is the documented use case (resetting a running fleet), where most
  // loops are mid-tick at any moment.
  const restore = fakePi(`sleep 2\nprintf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`);
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await waitFor(() => loadLoopState(repo, "clean").running === true, "a tick to be in flight");

    // Drop the marker while the tick is running (CLI-side file zeroing included).
    saveLoopState(repo, zeroCounters(loadLoopState(repo, "clean")));
    const markerFile = resetRequestPath(repo);
    fs.mkdirSync(path.dirname(markerFile), { recursive: true });
    fs.writeFileSync(markerFile, JSON.stringify({ at: Date.now(), roles: ["clean"] }));

    await waitFor(() => !fs.existsSync(markerFile), "the marker to be consumed");

    // The in-flight tick must still end cleanly: its running flag clears on disk. Before the
    // fix, resetCounters() replaced the state object mid-tick, so the tick's end-of-save
    // wrote back the zeroed copy — which still carried running=true — and the loop was wedged
    // (never eligible again) until a restart.
    await waitFor(
      () => loadLoopState(repo, "clean").running === false,
      "the in-flight tick to finish",
    );

    // Counters stayed zeroed: no resurrection from the pre-reset in-memory copy.
    assert.ok(
      loadLoopState(repo, "clean").ticks <= 1,
      `counters start from zero after a mid-tick reset (got ${loadLoopState(repo, "clean").ticks})`,
    );

    // And the loop keeps ticking: a post-reset tick runs to completion.
    await waitFor(
      () => loadLoopState(repo, "clean").ticks >= 1 && !loadLoopState(repo, "clean").running,
      "a post-reset tick to finish",
    );

    // The reset is still visible as one plain event, filed under the role.
    const resets = readEvents(repo).filter((e) => e.type === "counters_reset");
    assert.equal(resets.length, 1);
    assert.equal(resets[0]?.loop, "clean");
  } finally {
    restore();
    await orch.stop();
  }
});


test("the primary checkout moving branches mid-run logs exactly one warning (portability 2/7)", async () => {
  const repo = makeRepo();
  await initProject(repo, "branch divergence test");
  saveConfig(repo, fastConfig(["clean"]));
  const restore = fakePi(`printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`);
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    // Let one poll pass so the divergence watch is seeded against the startup branch.
    await waitFor(() => loadLoopState(repo, "clean").ticks >= 1, "the startup tick to run");

    // A human checks out something else in the primary checkout mid-run: one warning names
    // the divergence, and the fleet keeps merging into the branch it resolved at startup.
    sh(repo, "git", "checkout", "-b", "experiment");
    await waitFor(
      () =>
        readEvents(repo).some(
          (e) => e.type === "warning" && /primary checkout moved to experiment/.test(String(e.message)),
        ),
      "one divergence warning",
    );

    // Edge-triggered: more polls on the foreign branch stay quiet.
    await new Promise((r) => setTimeout(r, FAST_POLL_MS * 5));
    const during = readEvents(repo).filter(
      (e) => e.type === "warning" && /primary checkout moved/.test(String(e.message)),
    );
    assert.equal(during.length, 1, JSON.stringify(during));

    // Returning to the target branch re-arms the check, so a second episode warns again.
    sh(repo, "git", "checkout", "main");
    await new Promise((r) => setTimeout(r, FAST_POLL_MS * 3));
    sh(repo, "git", "checkout", "experiment");
    await waitFor(
      () =>
        readEvents(repo).filter(
          (e) => e.type === "warning" && /primary checkout moved/.test(String(e.message)),
        ).length === 2,
      "a second warning after re-arming",
    );
  } finally {
    restore();
    await orch.stop();
  }
});
