/** pollStreakGate (src/streak-gate.ts): the error-streak circuit breaker's trip rule and ack
 * bookkeeping. Exercises the real pause marker — pauseRole/resumeRole write exactly what the
 * CLI and the breaker both write — so the contract under test is producer-and-consumer
 * together, not a mock of either side. */

import test from "node:test";
import assert from "node:assert/strict";

import { newStreakGateState, pollStreakGate } from "../src/streak-gate.js";
import {
  applyLandingOutcome,
  applyTickOutcome,
  ERROR_STREAK_BREAKER,
} from "../src/tick-apply.js";
import { freshLoopState } from "../src/loop-state.js";
import { defaultConfig } from "../src/config/config.js";
import { pauseRole, resumeRole, pausedRoles } from "../src/fleet-state.js";
import { readEvents } from "../src/event-read.js";
import { tmpdir } from "./repo-fixtures.js";

function runner(role: string, consecutiveErrors: number, lastError?: string) {
  return { role, state: { consecutiveErrors, lastError } };
}

function streakEvents(root: string) {
  return readEvents(root, 100).filter((e) => e.type === "role_streak_paused");
}

test("pollStreakGate: streak at the breaker trips — marker written, one event with role, streak, lastError", () => {
  const root = tmpdir("streak-gate-");
  const state = newStreakGateState();
  const tripped = pollStreakGate(
    root,
    state,
    [runner("docs", 10, "backend unreachable")],
    new Set(),
  );
  assert.deepEqual(tripped, ["docs"]);
  assert.deepEqual(pausedRoles(root), ["docs"], "the per-role pause marker must hold the role");
  const events = streakEvents(root);
  assert.equal(events.length, 1);
  const event = events[0]!;
  assert.equal(event.role, "docs");
  assert.equal(event.streak, 10);
  assert.equal(event.lastError, "backend unreachable");
});

test("pollStreakGate: repeated polls while paused log nothing more, even as the streak would climb", () => {
  const root = tmpdir("streak-gate-");
  const state = newStreakGateState();
  pollStreakGate(root, state, [runner("docs", 10, "boom")], new Set());
  // The role is now in the marker: further polls ack instead of tripping, whatever the
  // (frozen) streak reads.
  for (const streak of [10, 11, 25]) {
    const tripped = pollStreakGate(
      root,
      state,
      [runner("docs", streak, "boom")],
      new Set(pausedRoles(root)),
    );
    assert.deepEqual(tripped, [], `streak ${streak} must not re-trip a paused role`);
  }
  assert.equal(streakEvents(root).length, 1);
  assert.deepEqual(pausedRoles(root), ["docs"], "the marker is not rewritten");
});

test("pollStreakGate: streak of 9 does not trip; reset to 0 then a fresh climb to 10 trips", () => {
  const root = tmpdir("streak-gate-");
  const state = newStreakGateState();
  assert.deepEqual(pollStreakGate(root, state, [runner("docs", 9, "boom")], new Set()), []);
  assert.deepEqual(pausedRoles(root), []);
  // A successful tick resets the streak to 0 and clears any ack with it.
  pollStreakGate(root, state, [runner("docs", 0)], new Set());
  assert.deepEqual(pollStreakGate(root, state, [runner("docs", 10, "boom again")], new Set()), [
    "docs",
  ]);
  assert.equal(streakEvents(root).length, 1);
});

test("pollStreakGate: after a trip at S, a resume does not re-trip until S + 10", () => {
  const root = tmpdir("streak-gate-");
  const state = newStreakGateState();
  pollStreakGate(root, state, [runner("docs", 10, "boom")], new Set());
  resumeRole(root, "docs");
  // The resumed role still carries its old streak: acked at trip time, so no re-trip — and
  // the grace holds whether or not a poll saw the pause in between.
  for (const streak of [10, 15, 19]) {
    assert.deepEqual(
      pollStreakGate(root, state, [runner("docs", streak, "boom")], new Set()),
      [],
      `streak ${streak} is inside the excused window`,
    );
  }
  assert.deepEqual(pollStreakGate(root, state, [runner("docs", 20, "boom")], new Set()), ["docs"]);
  assert.equal(streakEvents(root).length, 2, "the fresh trip logs its own event");
});

test("pollStreakGate: an operator-paused failing role is acked while paused and does not re-trip on resume", () => {
  const root = tmpdir("streak-gate-");
  const state = newStreakGateState();
  pauseRole(root, "docs"); // the operator paused it mid-failure, streak already deep
  const paused = new Set(pausedRoles(root));
  pollStreakGate(root, state, [runner("docs", 12, "boom")], paused);
  assert.equal(streakEvents(root).length, 0, "an operator pause is not the breaker's to log");
  resumeRole(root, "docs");
  // The pre-pause streak is excused: the role must fail ten MORE times to trip.
  for (const streak of [12, 18, 21]) {
    assert.deepEqual(pollStreakGate(root, state, [runner("docs", streak, "boom")], new Set()), []);
  }
  assert.deepEqual(pollStreakGate(root, state, [runner("docs", 22, "boom")], new Set()), ["docs"]);
});

test("pollStreakGate: a restart mid-pause re-acks silently; a resume before the restart re-trips once", () => {
  const root = tmpdir("streak-gate-");
  // The breaker paused the role, then the harness restarted: fresh state, standing marker.
  pauseRole(root, "docs");
  const fresh = newStreakGateState();
  const paused = new Set(pausedRoles(root));
  for (const _ of [1, 2, 3]) {
    assert.deepEqual(pollStreakGate(root, fresh, [runner("docs", 14, "boom")], paused), []);
  }
  assert.equal(streakEvents(root).length, 0, "the first poll re-acks, nothing logs");

  // The operator resumed before the restart, and the streak is still live: one trip, one event.
  resumeRole(root, "docs");
  const resumed = newStreakGateState();
  assert.deepEqual(pollStreakGate(root, resumed, [runner("docs", 14, "boom")], new Set()), [
    "docs",
  ]);
  assert.equal(streakEvents(root).length, 1);
  assert.deepEqual(pollStreakGate(root, resumed, [runner("docs", 15, "boom")], new Set(pausedRoles(root))), []);
  assert.equal(streakEvents(root).length, 1, "the re-trip logs exactly once");
});

test("pollStreakGate: the director trips like any role", () => {
  const root = tmpdir("streak-gate-");
  const state = newStreakGateState();
  assert.deepEqual(pollStreakGate(root, state, [runner("director", 10, "boom")], new Set()), [
    "director",
  ]);
  assert.deepEqual(pausedRoles(root), ["director"]);
  assert.equal(streakEvents(root).length, 1);
});

test("pollStreakGate: a rejection-fed streak trips the breaker through the real accumulation path", () => {
  // BUGS.md 2026-09-30: review rejections accumulate in the same consecutiveErrors field the
  // gate polls — the authoring tick ends `queued` (preserving the streak) and the landing's
  // rejected branch increments it — so ERROR_STREAK_BREAKER rejections must pause the role,
  // with the rejection's own text as the recorded lastError. This drives the real
  // queued→rejected flow, not a hand-set streak, so the gate cannot pass while the
  // accumulation point leaks.
  const root = tmpdir("streak-gate-reject-");
  const cfg = defaultConfig();
  const s = freshLoopState("coverage");
  const change = { sha: "a".repeat(40), summary: "address the objections" };
  for (let i = 1; i < ERROR_STREAK_BREAKER; i++) {
    applyTickOutcome(s, cfg, "coverage", { result: "queued", commit: change.sha });
    applyLandingOutcome(s, "rejected", change);
    assert.equal(s.consecutiveErrors, i, `rejection ${i} feeds the streak the gate reads`);
  }
  const state = newStreakGateState();
  const observation = { role: "coverage", state: s };
  assert.deepEqual(
    pollStreakGate(root, state, [observation], new Set()),
    [],
    "ERROR_STREAK_BREAKER - 1 rejections leave the role running",
  );
  // The tenth rejection crosses the bar: the gate pauses the role and names the rejection.
  applyTickOutcome(s, cfg, "coverage", { result: "queued", commit: change.sha });
  applyLandingOutcome(s, "rejected", change);
  assert.equal(s.consecutiveErrors, ERROR_STREAK_BREAKER);
  assert.deepEqual(pollStreakGate(root, state, [observation], new Set()), ["coverage"]);
  assert.deepEqual(pausedRoles(root), ["coverage"]);
  const events = streakEvents(root);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.role, "coverage");
  assert.equal(events[0]!.streak, ERROR_STREAK_BREAKER);
  assert.match(events[0]!.lastError as string, /^review rejected:/);
});
