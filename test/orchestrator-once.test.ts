/** Unit-tier coverage for the once round's exit contract (src/orchestrator/orchestrator.ts's
 * once-mode
 * return). The gating `npm test` never runs the e2e tier, so the shape `run --once`'s summary
 * reads — the restart flag, the per-role settle-reasons map, and the per-role ticks-run map —
 * was pinned only by orchestrator-once.e2e.test.ts. This file pins the idle-team round
 * itself in the declared check: it must exit on its own (a once round that hangs is the bug
 * `--once` exists to avoid), never report a restart, and count exactly one tick per role.
 * The pause-settle and prompt-wake slices below extend the same contract to a round opened
 * against a paused role and to a round where a queued prompt, not the clock, makes a role due;
 * the backoff and idle slices pin settleSkipped's remaining verdicts — a role in error backoff
 * (its nextRunAt is a backoff deadline the once clock override honors) and the director facing
 * an empty inbox, the one role whose idle round-answer is ordinary rather than a fault. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { freshRunnerState, loadRunnerState, saveRunnerState } from "../src/runner/runner-state.js";
import { ensureDetachedWorktree } from "../src/git/worktree.js";
import { slotForDir, writeSlotsState } from "../src/git/slots-state.js";
import { slotWorktreePath } from "../src/paths.js";
import { pauseRole } from "../src/team/team-state.js";
import { queuedRolePromptCount } from "../src/inbox/inbox.js";
import { submitRolePrompt } from "../src/inbox/inbox-submit.js";
import { makeFastRepo, onceRound } from "./fixtures/orchestrator-fixtures.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";
import { withIdlePi } from "./fakes/fake-pi.js";

test("once: an idle team exits on its own, ticks each role exactly once, and returns the once-mode shape", async () => {
  const repo = await makeFastRepo("once exit contract test", ["clean", "dedupe"]);
  await withIdlePi(async () => {
    const exit = await onceRound(repo);
    assert.equal(exit.restart, false, "a once round never reports a restart");
    assert.ok(exit.settled instanceof Map, "once mode returns the settle-reasons map, not the bare daemon shape");
    assert.ok(exit.ticksRun instanceof Map, "once mode returns the per-role ticks-run map");
    assert.equal(exit.ticksRun?.get("clean"), 1, "clean ticked once in the round");
    assert.equal(exit.ticksRun?.get("dedupe"), 1, "dedupe ticked once in the round");
    assert.equal(loadRunnerState(repo, "clean").runs, 1, "clean's persisted state agrees with the round's count");
    assert.equal(loadRunnerState(repo, "dedupe").runs, 1, "dedupe's persisted state agrees with the round's count");
  });
});

test("once: startup removes a legacy _land-<role> checkout left by a pre-pool build", async () => {
  const repo = await makeFastRepo("once legacy merger cleanup", ["clean"]);
  const legacy = path.join(repo, ".tumwater", "worktrees", "_land-feature");
  await ensureDetachedWorktree(repo, legacy, "main");
  assert.ok(fs.existsSync(legacy), "the legacy checkout is seeded");
  await withIdlePi(async () => {
    await onceRound(repo);
    assert.equal(fs.existsSync(legacy), false, "startup removed the legacy merger checkout");
  });
});

test("once: startup retires a legacy role worktree now that ticks lease pooled slots", async () => {
  const repo = await makeFastRepo("once legacy role worktree cleanup", ["clean"]);
  const legacy = path.join(repo, ".tumwater", "worktrees", "clean");
  await ensureDetachedWorktree(repo, legacy, "main");
  assert.ok(fs.existsSync(legacy), "the legacy role checkout is seeded");
  await withIdlePi(async () => {
    await onceRound(repo);
    assert.equal(fs.existsSync(legacy), false, "startup retired the legacy role checkout");
  });
});

test("once: a scoped --role run leaves another role's pending resume alone", async () => {
  // Regression: the migration must see every CONFIGURED runner id (`runnerIds`), not the run's
  // `--once --role` filter. Passing the filter retired `dedupe`'s resumable legacy checkout and
  // unpinned `feature`'s canonical slot, losing both resumes on the next full-team start.
  const repo = await makeFastRepo("once scoped migration test", ["clean", "dedupe", "feature"]);
  const legacy = path.join(repo, ".tumwater", "worktrees", "dedupe");
  await ensureDetachedWorktree(repo, legacy, "main");
  saveRunnerState(repo, { ...freshRunnerState("dedupe"), resumePending: true });
  const featureSlot = slotWorktreePath(repo, 1);
  writeSlotsState(repo, {
    slots: [{ dir: featureSlot, lease: null, pinnedFor: "feature", lastRole: null, lastReleasedAt: 1 }],
  });
  await withIdlePi(async () => {
    await onceRound(repo, "clean");
    assert.ok(fs.existsSync(legacy), "a scoped run retired another role's legacy checkout");
    assert.equal(slotForDir(repo, legacy)?.pinnedFor, "dedupe", "the legacy dir lost its pin");
    assert.equal(
      slotForDir(repo, featureSlot)?.pinnedFor,
      "feature",
      "a scoped run cleared another role's pin",
    );
  });
});

test("once: a per-role-paused role settles as paused and runs no tick", async () => {
  const repo = await makeFastRepo("once paused settle test", ["clean"]);
  pauseRole(repo, "clean");
  await withIdlePi(async () => {
    const exit = await onceRound(repo);
    assert.equal(exit.restart, false);
    assert.equal(exit.settled?.get("clean"), "paused", "the pause is the role's round answer, not silence");
    assert.equal(exit.ticksRun?.get("clean"), 0, "the paused role ran no tick");
    assert.equal(loadRunnerState(repo, "clean").runs, 0, "nothing ticked past the fresh state");
    assert.deepEqual(eventsOfType(repo, "run_start"), [], "no tick started behind the pause");
  });
});

test("once: a role in error backoff settles as backoff and runs no tick", async () => {
  const repo = await makeFastRepo("once backoff settle test", ["clean"]);
  // A raised backoffSeconds makes nextRunAt a backoff deadline: the once clock override
  // (isEligible's `backoffSeconds === 0` bypass) does not apply, so the role is not due and
  // no poll of the round changes that — the round's answer is the skip reason, not silence.
  saveRunnerState(repo, {
    ...freshRunnerState("clean"),
    runs: 1,
    lastResult: "no_change" as const,
    backoffSeconds: 30,
    nextRunAt: Date.now() + 60_000,
  });
  await withIdlePi(async () => {
    const exit = await onceRound(repo);
    assert.equal(exit.restart, false);
    assert.equal(exit.settled?.get("clean"), "backoff", "the backoff is the role's round answer");
    assert.equal(exit.ticksRun?.get("clean"), 0, "the backing-off role ran no tick");
    assert.equal(loadRunnerState(repo, "clean").runs, 1, "nothing ticked past the seeded history");
    assert.deepEqual(eventsOfType(repo, "run_start"), [], "no tick started behind the backoff");
  });
});

test("once: the director with an empty inbox settles as idle and runs no tick", async () => {
  const repo = await makeFastRepo("once director idle test", ["director"]);
  await withIdlePi(async () => {
    const exit = await onceRound(repo);
    assert.equal(exit.restart, false);
    assert.equal(
      exit.settled?.get("director"),
      "idle",
      "an empty inbox is the director's round answer — the one role whose idleness is ordinary",
    );
    assert.equal(exit.ticksRun?.get("director"), 0, "the director ran no tick with nothing queued");
    assert.equal(loadRunnerState(repo, "director").runs, 0, "nothing ticked past the fresh state");
    assert.deepEqual(eventsOfType(repo, "run_start"), [], "no tick started for the idle director");
  });
});

test("once: a queued per-role prompt makes its role due on its own and logs the wake", async () => {
  const repo = await makeFastRepo("once inbox wake test", ["clean"]);
  submitRolePrompt(repo, "clean", "a queued demand");
  await withIdlePi(async () => {
    const exit = await onceRound(repo);
    assert.equal(exit.restart, false);
    assert.equal(exit.ticksRun?.get("clean"), 1, "the queued prompt makes the role due without the clock");
    assert.equal(loadRunnerState(repo, "clean").runs, 1, "the tick really ran");
    assert.equal(queuedRolePromptCount(repo, "clean"), 0, "the tick consumed the queued prompt");
    const wake = eventsOfType(repo, "wake").find((e) => e.source === "clean");
    assert.ok(wake, "the demand is announced with a wake event, not a silent start");
    assert.equal(wake?.reason, "inbox");
  });
});
