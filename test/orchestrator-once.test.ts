/** Unit-tier coverage for the once round's exit contract (src/orchestrator.ts's once-mode
 * return). The gating `npm test` never runs the e2e tier, so the shape `run --once`'s summary
 * reads — the restart flag, the per-role settle-reasons map, and the per-role ticks-run map —
 * was pinned only by orchestrator-once.e2e.test.ts. This file pins the idle-fleet round
 * itself in the declared check: it must exit on its own (a once round that hangs is the bug
 * `--once` exists to avoid), never report a restart, and count exactly one tick per role.
 * The pause-settle and prompt-wake slices below extend the same contract to a round opened
 * against a paused loop and to a round where a queued prompt, not the clock, makes a role due;
 * the backoff and idle slices pin settleSkipped's remaining verdicts — a role in error backoff
 * (its nextRunAt is a backoff deadline the once clock override honors) and the director facing
 * an empty inbox, the one role whose idle round-answer is ordinary rather than a fault. */

import test from "node:test";
import assert from "node:assert/strict";
import { freshLoopState, loadLoopState, saveLoopState } from "../src/loop-state.js";
import { pauseRole } from "../src/fleet-state.js";
import { queuedRolePromptCount } from "../src/inbox.js";
import { submitRolePrompt } from "../src/inbox-submit.js";
import { makeFastRepo, onceRound } from "./orchestrator-fixtures.js";
import { eventsOfType } from "./log-fixtures.js";
import { fakePiIdle } from "./fake-pi.js";

test("once: an idle fleet exits on its own, ticks each role exactly once, and returns the once-mode shape", async () => {
  const repo = await makeFastRepo("once exit contract test", ["clean", "dry"]);
  const restore = fakePiIdle();
  try {
    const exit = await onceRound(repo);
    assert.equal(exit.restart, false, "a once round never reports a restart");
    assert.ok(exit.settled instanceof Map, "once mode returns the settle-reasons map, not the bare daemon shape");
    assert.ok(exit.ticksRun instanceof Map, "once mode returns the per-role ticks-run map");
    assert.equal(exit.ticksRun?.get("clean"), 1, "clean ticked once in the round");
    assert.equal(exit.ticksRun?.get("dry"), 1, "dry ticked once in the round");
    assert.equal(loadLoopState(repo, "clean").ticks, 1, "clean's persisted state agrees with the round's count");
    assert.equal(loadLoopState(repo, "dry").ticks, 1, "dry's persisted state agrees with the round's count");
  } finally {
    restore();
  }
});

test("once: a per-role-paused loop settles as paused and runs no tick", async () => {
  const repo = await makeFastRepo("once paused settle test", ["clean"]);
  pauseRole(repo, "clean");
  const restore = fakePiIdle();
  try {
    const exit = await onceRound(repo);
    assert.equal(exit.restart, false);
    assert.equal(exit.settled?.get("clean"), "paused", "the pause is the loop's round answer, not silence");
    assert.equal(exit.ticksRun?.get("clean"), 0, "the paused loop ran no tick");
    assert.equal(loadLoopState(repo, "clean").ticks, 0, "nothing ticked past the fresh state");
    assert.deepEqual(eventsOfType(repo, "tick_start"), [], "no tick started behind the pause");
  } finally {
    restore();
  }
});

test("once: a role in error backoff settles as backoff and runs no tick", async () => {
  const repo = await makeFastRepo("once backoff settle test", ["clean"]);
  // A raised backoffSeconds makes nextRunAt a backoff deadline: the once clock override
  // (isEligible's `backoffSeconds === 0` bypass) does not apply, so the role is not due and
  // no poll of the round changes that — the round's answer is the skip reason, not silence.
  saveLoopState(repo, {
    ...freshLoopState("clean"),
    ticks: 1,
    lastResult: "no_change" as const,
    backoffSeconds: 30,
    nextRunAt: Date.now() + 60_000,
  });
  const restore = fakePiIdle();
  try {
    const exit = await onceRound(repo);
    assert.equal(exit.restart, false);
    assert.equal(exit.settled?.get("clean"), "backoff", "the backoff is the loop's round answer");
    assert.equal(exit.ticksRun?.get("clean"), 0, "the backing-off loop ran no tick");
    assert.equal(loadLoopState(repo, "clean").ticks, 1, "nothing ticked past the seeded history");
    assert.deepEqual(eventsOfType(repo, "tick_start"), [], "no tick started behind the backoff");
  } finally {
    restore();
  }
});

test("once: the director with an empty inbox settles as idle and runs no tick", async () => {
  const repo = await makeFastRepo("once director idle test", ["director"]);
  const restore = fakePiIdle();
  try {
    const exit = await onceRound(repo);
    assert.equal(exit.restart, false);
    assert.equal(
      exit.settled?.get("director"),
      "idle",
      "an empty inbox is the director's round answer — the one role whose idleness is ordinary",
    );
    assert.equal(exit.ticksRun?.get("director"), 0, "the director ran no tick with nothing queued");
    assert.equal(loadLoopState(repo, "director").ticks, 0, "nothing ticked past the fresh state");
    assert.deepEqual(eventsOfType(repo, "tick_start"), [], "no tick started for the idle director");
  } finally {
    restore();
  }
});

test("once: a queued per-role prompt makes its loop due on its own and logs the wake", async () => {
  const repo = await makeFastRepo("once inbox wake test", ["clean"]);
  submitRolePrompt(repo, "clean", "a queued demand");
  const restore = fakePiIdle();
  try {
    const exit = await onceRound(repo);
    assert.equal(exit.restart, false);
    assert.equal(exit.ticksRun?.get("clean"), 1, "the queued prompt makes the loop due without the clock");
    assert.equal(loadLoopState(repo, "clean").ticks, 1, "the tick really ran");
    assert.equal(queuedRolePromptCount(repo, "clean"), 0, "the tick consumed the queued prompt");
    const wake = eventsOfType(repo, "wake").find((e) => e.loop === "clean");
    assert.ok(wake, "the demand is announced with a wake event, not a silent start");
    assert.equal(wake?.reason, "inbox");
  } finally {
    restore();
  }
});
