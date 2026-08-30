import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  applyTickOutcome,
  freshLoopState,
  loadLoopState,
  nextBackoffSeconds,
  orchestratorAlive,
  readOrchestratorInfo,
  saveLoopState,
  zeroCounters,
} from "../src/state.js";
import type { LoopState, TumwaterConfig } from "../src/types.js";
import { orchestratorStatePath, statePath } from "../src/paths.js";
import { defaultConfig } from "../src/config.js";
import { tmpdir } from "./util.js";

/** Every field a fresh state has must hold its default value (extra junk keys are allowed). */
function assertFreshFields(s: LoopState, role: string): void {
  const fresh = freshLoopState(role);
  for (const key of Object.keys(fresh)) {
    assert.equal(
      s[key as keyof LoopState],
      fresh[key as keyof LoopState],
      `field ${key} should keep its default`,
    );
  }
}

test("loadLoopState returns fresh defaults when no file exists", () => {
  const dir = tmpdir();
  assert.deepEqual(loadLoopState(dir, "clean"), freshLoopState("clean"));
});

test("saveLoopState creates the state dir and round-trips without leaving a temp file", () => {
  const dir = tmpdir();
  const s = freshLoopState("feature");
  s.ticks = 7;
  s.generatedTokens = 123456;
  s.lastResult = "changed";
  saveLoopState(dir, s); // .tumwater/ does not exist yet
  assert.ok(fs.existsSync(statePath(dir, "feature")));
  const stateDir = path.dirname(statePath(dir, "feature"));
  assert.deepEqual(fs.readdirSync(stateDir), ["feature.json"], "no .tmp leftovers");
  assert.deepEqual(loadLoopState(dir, "feature"), s);
});

test("loadLoopState fills fields missing from an older or partial file", () => {
  const dir = tmpdir();
  const file = statePath(dir, "clean");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // A state file written before generatedTokens/lastMainHead existed.
  fs.writeFileSync(file, JSON.stringify({ role: "clean", ticks: 3, commits: 1 }));
  const s = loadLoopState(dir, "clean");
  assert.equal(s.ticks, 3);
  assert.equal(s.commits, 1);
  // loop.ts adds to these every tick; undefined would turn them into NaN.
  assert.equal(s.generatedTokens, 0);
  assert.equal(s.peakContextTokens, 0);
  assert.equal(s.backoffSeconds, 0);
  assert.equal(s.lastMainHead, "");
  assert.ok(Number.isFinite(s.nextRunAt));
});

test("loadLoopState recovers from torn or non-object JSON", () => {
  const dir = tmpdir();
  const file = statePath(dir, "dry");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const junk of ['{"ticks": 2', '"just a string"', "[1, 2]", "null"]) {
    fs.writeFileSync(file, junk);
    assertFreshFields(loadLoopState(dir, "dry"), "dry"); // must not throw or lose defaults
  }
});

test("zeroCounters zeroes the accumulated counters and preserves everything else", () => {
  const s = freshLoopState("feature");
  s.ticks = 12;
  s.commits = 5;
  s.generatedTokens = 987654;
  s.totalCostUsd = 3.14;
  s.peakContextTokens = 131072; // last tick's peak — must be cleared too
  s.nextRunAt = 1_700_000_000_000;
  s.backoffSeconds = 30;
  s.lastMainHead = "abc123";
  s.lastResult = "changed";
  s.lastSummary = "did a thing";
  s.lastTickStartedAt = 1;
  s.lastTickEndedAt = 2;

  const z = zeroCounters(s);
  assert.equal(z.ticks, 0);
  assert.equal(z.commits, 0);
  assert.equal(z.generatedTokens, 0);
  assert.equal(z.totalCostUsd, 0);
  // Per-tick semantics: peak ctx holds the last completed tick's peak, so a fresh
  // observation window clears it — sleeping loops would otherwise keep showing their old
  // value until they next tick.
  assert.equal(z.peakContextTokens, 0);
  // Scheduling, wake tracking, and last-result fields are untouched.
  assert.equal(z.nextRunAt, s.nextRunAt);
  assert.equal(z.backoffSeconds, 30);
  assert.equal(z.lastMainHead, "abc123");
  assert.equal(z.lastResult, "changed");
  assert.equal(z.lastSummary, "did a thing");
  // Pure: the input is unchanged and the result is a new object.
  assert.equal(s.ticks, 12);
  assert.notEqual(z, s);
});

test("nextBackoffSeconds caps an initial above max and treats non-positive current as first", () => {
  const config = defaultConfig();
  config.idleBackoff = { initialSeconds: 100, factor: 2, maxSeconds: 30 };
  assert.equal(nextBackoffSeconds(0, config), 30); // min(initial, max)
  assert.equal(nextBackoffSeconds(-5, config), 30); // current <= 0 → initial (capped)
  assert.equal(nextBackoffSeconds(29, config), 30); // growth still capped at max
});

// --- Post-tick outcome recording + next-run scheduling (extracted from LoopRunner.tick) ---

/** A config with a small idle backoff so the assertions below stay readable. */
function testConfig(): TumwaterConfig {
  const cfg = defaultConfig(); // minTickIntervalSeconds: 20
  cfg.idleBackoff = { initialSeconds: 30, factor: 2, maxSeconds: 3600 };
  return cfg;
}

test("applyTickOutcome records the outcome and schedules a changed tick at the role's minimum interval", () => {
  const s = freshLoopState("feature");
  s.running = true;
  s.phase = "review"; // set around the gate's run — must not linger after the tick
  s.commits = 4;
  const cfg = testConfig();
  const before = Date.now();
  applyTickOutcome(s, cfg, "feature", { result: "changed", summary: "did it" });
  assert.equal(s.running, false);
  assert.equal(s.phase, undefined);
  assert.equal(s.lastResult, "changed");
  assert.equal(s.lastSummary, "did it");
  const endedAt = s.lastTickEndedAt;
  assert.ok(endedAt !== undefined && endedAt >= before && endedAt <= Date.now(), "lastTickEndedAt stamped");
  assert.equal(s.commits, 5);
  assert.equal(s.backoffSeconds, 0);
  assert.ok(
    s.nextRunAt >= before + 20_000 && s.nextRunAt <= Date.now() + 20_000,
    "waits at least the minimum interval",
  );
});

test("applyTickOutcome: rejected and skipped ticks wait the minimum interval without counting a commit", () => {
  for (const result of ["rejected", "skipped"] as const) {
    const s = freshLoopState(result === "rejected" ? "feature" : "director");
    s.commits = 2;
    applyTickOutcome(s, testConfig(), s.role, { result });
    assert.equal(s.lastResult, result);
    assert.equal(s.commits, 2, `${result} lands nothing on main`);
    assert.equal(s.backoffSeconds, 0);
    assert.ok(
      s.nextRunAt >= Date.now() - 1_000 && s.nextRunAt <= Date.now() + 21_000,
      `next run is due after the minimum interval (${result})`,
    );
  }
});

test("applyTickOutcome: an aborted tick resumes promptly — role via resumePending, director via re-queue", () => {
  const s = freshLoopState("feature");
  s.phase = "review"; // interruption hit mid-review: the next launch must recover + re-review
  applyTickOutcome(s, testConfig(), "feature", { result: "aborted" });
  assert.equal(s.resumePending, true);
  assert.equal(s.phase, "review", "kept so recovery re-reviews instead of resuming the author session");
  assert.ok(Math.abs(s.nextRunAt - Date.now()) < 5_000, "due immediately on restart");

  const d = freshLoopState("director");
  applyTickOutcome(d, testConfig(), "director", { result: "aborted" });
  assert.equal(d.resumePending, undefined, "the director reruns its re-queued prompt fresh");
});

test("applyTickOutcome: cut-off ticks resume the compacted session until the streak limit, then back off", () => {
  const cfg = testConfig();
  // Under the limit (3): each consecutive cut-off resumes promptly and grows the streak.
  for (let streak = 0; streak < 3; streak++) {
    const s = freshLoopState("feature");
    s.cutOffStreak = streak;
    applyTickOutcome(s, cfg, "feature", { result: "no_change", cutOff: true });
    assert.equal(s.resumePending, true, `cut-off ${streak + 1} resumes`);
    assert.equal(s.cutOffStreak, streak + 1);
    assert.equal(s.backoffSeconds, 0, "a cut-off is not idleness");
    assert.ok(s.nextRunAt <= Date.now() + 21_000);
  }
  // At the limit: give up on the task — normal backoff, no resume; the streak is NOT reset
  // (only a non-cut-off tick clears it), so the next cut-off also backs off.
  const s = freshLoopState("feature");
  s.cutOffStreak = 3;
  applyTickOutcome(s, cfg, "feature", { result: "no_change", cutOff: true });
  assert.equal(s.resumePending, undefined);
  assert.equal(s.backoffSeconds, 30); // initial backoff
  assert.equal(s.cutOffStreak, 3);
});

test("applyTickOutcome: other outcomes grow the idle backoff and clear the cut-off streak", () => {
  const cfg = testConfig();
  const s = freshLoopState("feature");
  s.backoffSeconds = 30;
  s.cutOffStreak = 2; // a prior cut-off — this tick finished normally, so it resets
  applyTickOutcome(s, cfg, "feature", { result: "error" });
  assert.equal(s.lastResult, "error");
  assert.equal(s.backoffSeconds, 60); // 30 × factor 2
  assert.ok(
    s.nextRunAt >= Date.now() - 1_000 && s.nextRunAt <= Date.now() + 61_000,
    "due after the grown backoff",
  );
  assert.equal(s.cutOffStreak, 0);

  // A summary-less outcome keeps the previous lastSummary (stale beats wiped).
  const s2 = freshLoopState("feature");
  s2.lastSummary = "previous";
  applyTickOutcome(s2, cfg, "feature", { result: "no_change" });
  assert.equal(s2.lastSummary, "previous");
});

// --- Orchestrator info file: the readers live here so observers don't depend on the scheduler ---

test("readOrchestratorInfo and orchestratorAlive handle missing, valid, dead-pid, and corrupt state", () => {
  const dir = tmpdir();
  assert.equal(readOrchestratorInfo(dir), null);
  assert.equal(orchestratorAlive(dir), false);

  const file = orchestratorStatePath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Our own pid is alive; a huge one is not.
  for (const [pid, alive] of [
    [process.pid, true],
    [999_999_999, false],
  ] as const) {
    fs.writeFileSync(file, JSON.stringify({ pid, startedAt: Date.now(), roles: ["clean"] }));
    assert.equal(readOrchestratorInfo(dir)?.pid, pid);
    assert.equal(orchestratorAlive(dir), alive);
  }

  // A torn write must not crash observers (TUI/GUI poll this every second).
  fs.writeFileSync(file, "{ not json");
  assert.equal(readOrchestratorInfo(dir), null);
  assert.equal(orchestratorAlive(dir), false);
});
