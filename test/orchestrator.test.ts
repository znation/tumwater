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
    // Shutdown must not wait out the current poll sleep (POLL_MS = 2s): abort wakes the loop
    // immediately, so this resolves in milliseconds. A second is a generous ceiling that old,
    // non-interruptible behavior would blow roughly half the time.
    const tAbort = Date.now();
    controller.abort();
    await done;
    assert.ok(
      Date.now() - tAbort < 1000,
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

/** Seed non-zero counters for the given roles before runners load their state. */
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
    // role had that same window and must not have used it.
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

    // The in-flight tick finishes and lands its change to main…
    await waitFor(
      () => loadLoopState(repo, "clean").ticks >= 1 && !loadLoopState(repo, "clean").running,
      "the in-flight tick to finish",
    );
    const s = loadLoopState(repo, "clean");
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
    // Still running: ticks keep coming after the failure was recorded.
    const before = readEvents(repo).filter((e) => e.type === "tick_start").length;
    await waitFor(() => readEvents(repo).filter((e) => e.type === "tick_start").length > before, "ticks resume after the hold lifts");
    assert.deepEqual(swaps, []);
  } finally {
    controller.abort();
    await done.catch(() => undefined);
    restore();
  }
});
