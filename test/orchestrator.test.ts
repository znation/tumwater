import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { dueForPrune, fairOrder, isEligible, runOrchestrator } from "../src/orchestrator.js";
import { ROLES } from "../src/roles.js";
import { LoopRunner } from "../src/loop.js";
import { defaultConfig, loadConfig, saveConfig } from "../src/config.js";
import type { TumwaterConfig } from "../src/types.js";
import { initProject } from "../src/init.js";
import { enqueuePrompt } from "../src/inbox.js";
import { logEvent, readEvents } from "../src/events.js";
import {
  freshLoopState,
  loadLoopState,
  nextBackoffSeconds,
  orchestratorAlive,
  readOrchestratorInfo,
  saveLoopState,
  todayStamp,
  zeroCounters,
} from "../src/state.js";
import { abortRequestPath, pausedPath, resetRequestPath, worktreePath } from "../src/paths.js";
import { type RedeployDeps, Redeployer } from "../src/redeploy.js";
import { assistantLine, fakePi, makeRepo, sh, tmpdir } from "./util.js";

/** Fast poll interval for live-orchestrator tests whose assertions don't depend on the real
 * 2s cadence: multi-cycle behavior (config reloads, marker consumption, wake events) resolves
 * in ~100ms instead of seconds. Tests that verify timing margins against the real cadence —
 * shutdown latency vs POLL_MS, and maxConcurrent's hold < poll boundary — keep the default.
 * Safe because idle ticks back off 1s (fastConfig), so no assertion relies on a >=2s gap
 * between polls to prevent back-to-back ticks. */
const FAST_POLL_MS = 100;

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

test("isEligible gates on the role's own interval, not the global knob", () => {
  const now = Date.now();

  // Large per-role override over a small global: the loop stays ineligible inside its own
  // (long) window even though nextRunAt has passed AND main moved. If isEligible read
  // config.minTickIntervalSeconds directly (20s), it would have woken here — sinceLast is
  // 21s, past the global gap.
  const slow = defaultConfig();
  slow.minTickIntervalSeconds = 20;
  slow.roles.steward!.minTickIntervalSeconds = 3600;
  const r1 = new LoopRunner(makeRepo(), "steward", slow, "main");
  r1.state.ticks = 1;
  r1.state.lastTickEndedAt = now - 21_000; // past the global gap, deep inside the role's own
  r1.state.nextRunAt = now - 1000; // its schedule has passed too
  r1.state.lastMainHead = "old";
  assert.equal(
    isEligible(r1, now, "new", 0).run,
    false,
    "the per-role gap must gate main-moved wakes",
  );

  // The inverse: a small override over a large global wakes at the shorter value. If
  // isEligible read config.minTickIntervalSeconds directly (3600s), it would still be
  // asleep here — sinceLast is only 21s.
  const fast = defaultConfig();
  fast.minTickIntervalSeconds = 3600;
  fast.roles.qa!.minTickIntervalSeconds = 20;
  const r2 = new LoopRunner(makeRepo(), "qa", fast, "main");
  r2.state.ticks = 1;
  r2.state.lastTickEndedAt = now - 21_000; // past the role's own gap, deep inside the global
  r2.state.nextRunAt = now + 60_000; // schedule NOT passed — only a main-moved wake can run it
  r2.state.lastMainHead = "old";
  const woken = isEligible(r2, now, "new", 0);
  assert.equal(woken.run, true, "the shorter per-role gap must allow the wake");
  assert.equal(woken.reason, "main moved");
});

test("an interrupted tick resumes promptly on restart despite the min gap", () => {
  const r = runner("clean");
  const now = Date.now();
  // Aborted (or crashed) moments ago — far inside the role's min gap, which would otherwise
  // hold its half-finished work for a full interval (e.g. the steward's ~6 h).
  r.state.ticks = 5;
  r.state.lastTickEndedAt = now - 1000;
  r.state.nextRunAt = now - 1000; // aborted ticks schedule at "now"
  r.state.resumePending = true;
  const eligible = isEligible(r, now, "abc", 0);
  assert.equal(eligible.run, true, "the min gap must not hold an interrupted tick");
  assert.equal(eligible.reason, "resume");
});

test("a cut-off resume still waits out its interval even with the min-gap bypass", () => {
  const r = runner("clean");
  const now = Date.now();
  r.state.ticks = 5;
  r.state.lastTickEndedAt = now - 1000; // inside the min gap
  r.state.nextRunAt = now + 60_000; // cut-off ticks schedule one interval out
  r.state.resumePending = true;
  assert.equal(isEligible(r, now, "abc", 0).run, false);
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
    assert.ok(
      Date.now() - tAbort < 2000,
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
      /no roles enabled/,
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
  const restore = fakePi(`printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`);
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    await waitFor(() => !fs.existsSync(session), "the old session to be pruned");
    assert.equal(pruneWarnings(repo), 1, "one prune warning for the deleted file");
  } finally {
    restore();
    await orch.stop();
  }
});

// --- Live session retention (PLANS.md: Live sessionRetentionDays) ---

test("dueForPrune: the once-per-day gate with fake timestamps", () => {
  const day = 24 * 3600 * 1000;
  // Due when a full day has passed since the last prune.
  assert.equal(dueForPrune(1_000, 1_000 + day, 7), true);
  // Not due within a day — one millisecond short is still inside the window.
  assert.equal(dueForPrune(1_000, 1_000 + day - 1, 7), false);
  // Never due at retention 0, whether or not a prune has run before.
  assert.equal(dueForPrune(null, Number.MAX_SAFE_INTEGER, 0), false);
  assert.equal(dueForPrune(1_000, 1_000 + day * 2, 0), false);
  // Never pruned (null) → immediately due when retention is positive.
  assert.equal(dueForPrune(null, 1_000, 7), true);
});

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

/** Poll until fn() is true, failing after ms (default 20s). */
async function waitFor(fn: () => boolean, what: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** A fake pi that records each run's --provider/--model flags to argsFile and declares
 * nothing-to-do (so no commit happens). */
function recordingFakePi(argsFile: string): () => void {
  return fakePi(
    [
      `m=""; p=""`,
      `while [ $# -gt 0 ]; do case "$1" in --model) m="$2";; --provider) p="$2";; esac; shift; done`,
      `echo "run: model=$m provider=$p" >> "${argsFile}"`,
      `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
    ].join("\n"),
  );
}

/** A config where only the given roles tick quickly (no min gap, 1s backoff) so several
 * ticks land within a few poll cycles. */
function fastConfig(roles: string[], model?: string): TumwaterConfig {
  const c = defaultConfig();
  if (model) c.model = model;
  c.minTickIntervalSeconds = 0;
  c.idleBackoff = { initialSeconds: 1, factor: 1, maxSeconds: 1 };
  for (const id of Object.keys(c.roles)) c.roles[id]!.enabled = roles.includes(id);
  return c;
}

/** Start a live orchestrator on `repo` with the config currently on disk, for tests that
 * drive it while running. Returns its exit promise plus `stop`, which aborts the run and
 * awaits its exit — swallowing shutdown noise so the test's own failure (if any) stays
 * visible; call `stop` from finally after other cleanup (e.g. restoring a fake pi). */
function startLiveOrchestrator(
  repo: string,
  pollMs?: number,
): { done: Promise<unknown>; stop: () => Promise<void> } {
  const controller = new AbortController();
  const done = runOrchestrator({
    root: repo,
    config: loadConfig(repo),
    mainBranch: "main",
    signal: controller.signal,
    pollMs,
  });
  return {
    done,
    async stop() {
      controller.abort();
      try {
        await done;
      } catch {
        // The test's own failure (if any) takes precedence over shutdown noise.
      }
    },
  };
}

test("mid-run tumwater.json edits steer the fleet; a broken file keeps last-known-good", async () => {
  const repo = makeRepo();
  await initProject(repo, "live reload test");
  saveConfig(repo, fastConfig(["clean"], "good-model"));
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
    saveConfig(repo, fastConfig(["clean"], "reloaded-model"));
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
    saveConfig(repo, fastConfig(["clean"], "fixed-model"));
    await waitFor(() => runs().at(-1)?.includes("model=fixed-model") === true, "pi run with the fixed model");
    assert.equal(warnings().length, 1, "no new warnings once the file is fixed");
  } finally {
    restore();
    await orch.stop();
  }
});

/** A fake pi that records how many runs were in flight when it started (one sample line per
 * run), holds its slot for ~1.5s so overlapping runs are observable, and declares
 * nothing-to-do (so no commit happens). */
function concurrencyRecordingFakePi(runDir: string): () => void {
  const script = [
    `d="${runDir}/runs"`,
    `mkdir -p "$d"`,
    `f=$(mktemp "$d/run.XXXXXX")`,
    `n=0; for x in "$d"/run.*; do n=$((n+1)); done`,
    `printf '%s\\n' "$n" >> "${runDir}/samples.log"`,
    `sleep 1.5`,
    `rm -f "$f"`,
    `printf '%s\\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
  ].join("\n");
  return fakePi(script);
}

function readSamples(runDir: string): number[] {
  try {
    return fs.readFileSync(path.join(runDir, "samples.log"), "utf8").trim().split("\n").map(Number);
  } catch {
    return [];
  }
}

test("a live maxConcurrent edit resizes the cap without a restart", async () => {
  const repo = makeRepo();
  await initProject(repo, "live maxConcurrent test");
  // THREE fast-ticking roles and ONE slot: with three loops competing for one permit, steady
  // state always has at least one tick queued on the semaphore (a two-role fleet settles into
  // a strict alternation where every poll schedules exactly one loop, so there would be no
  // queued tick for the grow to wake). The shim's ~1.5s hold makes overlapping runs visible.
  const base = fastConfig(["clean", "dry", "bugfix"]);
  base.maxConcurrent = 1;
  saveConfig(repo, base);
  const runDir = tmpdir();
  const restore = concurrencyRecordingFakePi(runDir);
  // Keeps the DEFAULT poll interval on purpose: phase 3's "no overlap after shrink" assertion
  // relies on the shim's ~1.5s hold being shorter than one poll, so every cap-2-era run file is
  // gone by the time the shrink event is observed. A fast poll would let an in-flight file cross
  // the boundary and false-fail the test.
  const orch = startLiveOrchestrator(repo);
  try {
    // Phase 1 (cap 1): all three loops tick — but never overlap. Wait until each has run at
    // least once (three samples), then confirm no sample ever exceeded one concurrent run.
    await waitFor(() => readSamples(runDir).length >= 3, "all three roles to have run");
    assert.ok(
      readSamples(runDir).every((n) => n <= 1),
      `peak stays 1 while the second loop waits on its slot (samples: ${readSamples(runDir)})`,
    );

    // Phase 2 (cap 2): a live edit admits the queued work — runs overlap without a restart.
    const grow = fastConfig(["clean", "dry", "bugfix"]);
    grow.maxConcurrent = 2;
    saveConfig(repo, grow);
    await waitFor(
      () => readEvents(repo).some((e) => e.type === "max_concurrent_changed" && e.to === 2),
      "the max_concurrent_changed event",
    );
    await waitFor(() => readSamples(runDir).some((n) => n >= 2), "overlapping runs after the grow");

    // Phase 3 (cap 1 again): shrinking admits no NEW concurrent run until in-flight work
    // finishes. Every sample recorded from the change onward must be <= 1 — a cap that was
    // not applied would let the fast roles overlap again within a few polls.
    const shrink = fastConfig(["clean", "dry", "bugfix"]);
    shrink.maxConcurrent = 1;
    saveConfig(repo, shrink);
    await waitFor(
      () => readEvents(repo).some((e) => e.type === "max_concurrent_changed" && e.to === 1),
      "the shrink event",
    );
    // Samples before this point may overlap (the cap was still 2 when those runs were
    // admitted); every sample from here on must be sequential.
    const fromShrink = readSamples(runDir).length;
    await waitFor(() => readSamples(runDir).length >= fromShrink + 3, "several post-shrink runs");
    assert.ok(
      readSamples(runDir).slice(fromShrink).every((n) => n <= 1),
      `no new concurrent run after the shrink until in-flight work finishes (samples: ${readSamples(runDir)})`,
    );

    // Exactly one change event per distinct value — unchanged polls log nothing.
    const changes = readEvents(repo).filter((e) => e.type === "max_concurrent_changed");
    assert.equal(changes.length, 2);
    assert.deepEqual(
      changes.map((c) => [c.loop, c.from, c.to]),
      [
        ["harness", 1, 2],
        ["harness", 2, 1],
      ],
    );
  } finally {
    restore();
    await orch.stop();
  }
});

// --- Reset counters while running (tumwater reset-counters marker) ---

test("a reset request zeroes in-memory counters, survives tick boundaries, and logs an event", async () => {
  const repo = makeRepo();
  await initProject(repo, "reset counters e2e test");
  saveConfig(repo, fastConfig(["clean"]));
  const restore = fakePi(`printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`);
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  try {
    // Let a couple of ticks accumulate counters in the runner's memory.
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
    // in-memory copy would have saved ticks >= 3 here instead.
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

