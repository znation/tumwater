/** Unit coverage for LoopRunner's operator-command methods — resetCounters() (the engine of
 * `tumwater reset-counters`) and wake() (of `tumwater wake`). Both are plain state mutations
 * with no pi involvement, so they need no fake shim and live in their own small file rather
 * than the duration-balanced loop halves. Their invariants are anything but trivial: both
 * must mutate the EXISTING state object in place (a tick in flight holds the same reference,
 * and a swap here wedges the loop until restart — the bug orchestrator.e2e.test.ts records),
 * zero/persist exactly their own fields, and leave the result visible on disk. */

import test from "node:test";
import assert from "node:assert/strict";
import { LoopRunner } from "../src/loop.js";
import { initProject } from "../src/init.js";
import { defaultConfig } from "../src/config.js";
import { loadLoopState, saveLoopState } from "../src/state.js";
import { makeRepo } from "./util.js";

async function runnerInRepo(role = "clean"): Promise<LoopRunner> {
  const repo = makeRepo();
  await initProject(repo, "A test project.");
  return new LoopRunner(repo, role, defaultConfig(), "main");
}

test("resetCounters zeroes the observation counters, preserves scheduling and wake fields, and persists both", async () => {
  const runner = await runnerInRepo();
  const s = runner.state;
  s.ticks = 5;
  s.commits = 2;
  s.generatedTokens = 1234;
  s.peakContextTokens = 900;
  s.totalCostUsd = 0.25;
  // Scheduling, wake tracking, and last-result bookkeeping must survive the reset — only the
  // observation window (counters + peak) is being reopened.
  s.nextRunAt = 1234567890;
  s.backoffSeconds = 300;
  s.lastMainHead = "deadbeef";
  s.lastResult = "no_change";
  s.running = true;

  runner.resetCounters();

  assert.equal(s.ticks, 0);
  assert.equal(s.commits, 0);
  assert.equal(s.generatedTokens, 0);
  assert.equal(s.peakContextTokens, 0, "the stale peak must not outlive the window");
  assert.equal(s.totalCostUsd, 0);
  assert.equal(s.nextRunAt, 1234567890, "the reset must not reschedule the loop");
  assert.equal(s.backoffSeconds, 300);
  assert.equal(s.lastMainHead, "deadbeef");
  assert.equal(s.lastResult, "no_change");
  assert.equal(s.running, true, "an in-flight tick's running flag must survive");

  const disk = loadLoopState(runner.root, runner.role);
  assert.equal(disk.ticks, 0, "the zeroed counters are persisted, not just in-memory");
  assert.equal(disk.nextRunAt, 1234567890, "the preserved scheduling fields are persisted too");
});

test("resetCounters mutates the existing state object, so an in-flight tick's end-of-tick save stays authoritative", async () => {
  const runner = await runnerInRepo();
  // The reference a mid-tick bookkeeping save would hold.
  const inflight = runner.state;
  runner.state.ticks = 7;

  runner.resetCounters();

  assert.equal(runner.state, inflight, "the state object must not be replaced");

  // Now the in-flight tick ends and saves ITS bookkeeping over the same object: the counter
  // it wrote and its own schedule must both reach disk, and the pre-reset values must not
  // resurrect (the documented wedged-loop failure mode).
  inflight.ticks = 8;
  inflight.nextRunAt = 42;
  saveLoopState(runner.root, inflight);
  const disk = loadLoopState(runner.root, runner.role);
  assert.equal(disk.ticks, 8);
  assert.equal(disk.nextRunAt, 42);
});

test("wake clears backoff in memory and on disk, and only the backoff", async () => {
  const runner = await runnerInRepo();
  const s = runner.state;
  s.ticks = 3;
  s.backoffSeconds = 600;
  const before = Date.now();
  s.nextRunAt = before + 600_000;

  runner.wake();

  assert.equal(s.backoffSeconds, 0);
  assert.ok(
    s.nextRunAt >= before && s.nextRunAt <= Date.now(),
    "nextRunAt moves to the wake time so eligibility reads due-now",
  );
  assert.equal(s.ticks, 3, "wake clears the schedule, never the counters");

  // The orchestrator reads eligibility from the IN-MEMORY state, but the next save comes
  // from the same object — the cleared backoff must already be on disk.
  const disk = loadLoopState(runner.root, runner.role);
  assert.equal(disk.backoffSeconds, 0);
  assert.equal(disk.nextRunAt, s.nextRunAt);

  // In place, like resetCounters: the in-flight tick's reference sees the wake.
  assert.equal(runner.state.nextRunAt, disk.nextRunAt);
});
