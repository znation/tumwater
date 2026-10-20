/** pollPauseGates (src/gates/pause-gates.ts): the edge-triggered event logging and gate reads the
 *  orchestrator's poll loop depends on. Exercises the real markers — pauseTeam/resumeTeam and
 *  pauseRole/resumeRole write exactly what the CLI writes, so the contract under test is
 *  producer-and-consumer together, not a mock of either side. */

import test from "node:test";
import assert from "node:assert/strict";

import { newPauseGateState, pollPauseGates } from "../src/gates/pause-gates.js";
import { pauseTeam, resumeTeam, pauseRole, resumeRole } from "../src/team/team-state.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { eventTypes, eventsOfType } from "./fixtures/log-fixtures.js";

test("pollPauseGates: quiet team — no gates, no events", () => {
  const root = tmpdir("pause-gates-");
  const state = newPauseGateState();
  assert.deepEqual(pollPauseGates(root, state), { userPaused: false, pausedRoles: new Set() });
  assert.deepEqual(eventTypes(root, "team_paused", "team_resumed", "role_paused", "role_resumed"), []);
});

test("pollPauseGates: team pause logs team_paused once, resume logs team_resumed once", () => {
  const root = tmpdir("pause-gates-");
  const state = newPauseGateState();

  pauseTeam(root);
  assert.equal(pollPauseGates(root, state).userPaused, true);
  assert.deepEqual(eventTypes(root, "team_paused", "team_resumed"), ["team_paused"]);
  const plain = eventsOfType(root, "team_paused")[0]!;
  assert.ok(!("until" in plain) && !("reason" in plain), "a plain pause logs neither field");

  // Still paused: the edge trigger must not re-log on the ~2s poll cadence.
  assert.equal(pollPauseGates(root, state).userPaused, true);
  assert.deepEqual(eventTypes(root, "team_paused", "team_resumed"), ["team_paused"]);

  resumeTeam(root);
  assert.equal(pollPauseGates(root, state).userPaused, false);
  assert.deepEqual(eventTypes(root, "team_paused", "team_resumed"), ["team_paused", "team_resumed"]);
  assert.ok(!("expired" in eventsOfType(root, "team_resumed")[0]!), "an operator resume carries no expired");

  // Settled again: nothing further.
  pollPauseGates(root, state);
  assert.deepEqual(eventTypes(root, "team_paused", "team_resumed"), ["team_paused", "team_resumed"]);
});

test("pollPauseGates: restart mid-pause logs one event on the first poll", () => {
  const root = tmpdir("pause-gates-");
  pauseTeam(root);
  // Fresh state = a restarted orchestrator: the standing marker gates, and the documented
  // behavior is exactly one team_paused event, not one per poll and not silence.
  const state = newPauseGateState();
  assert.equal(pollPauseGates(root, state).userPaused, true);
  assert.equal(pollPauseGates(root, state).userPaused, true);
  assert.deepEqual(eventTypes(root, "team_paused", "team_resumed"), ["team_paused"]);
});

test("pollPauseGates: role_paused carries the shared deadline of a timed role pause", () => {
  const root = tmpdir("pause-gates-");
  const until = Date.now() + 60_000;
  pauseRole(root, "tests", until);
  pollPauseGates(root, newPauseGateState());
  const events = eventsOfType(root, "role_paused");
  assert.equal(events.length, 1);
  assert.equal(events[0]!.role, "tests");
  assert.equal(events[0]!.until, until);
});

test("pollPauseGates: per-role pause/resume logs role events per crossing", () => {
  const root = tmpdir("pause-gates-");
  const state = newPauseGateState();

  pauseRole(root, "tests");
  const gates = pollPauseGates(root, state);
  assert.equal(gates.userPaused, false);
  assert.deepEqual(gates.pausedRoles, new Set(["tests"]));
  assert.deepEqual(eventTypes(root, "role_paused", "role_resumed"), ["role_paused"]);
  assert.ok(!("until" in eventsOfType(root, "role_paused")[0]!), "a standing role pause carries no until");

  // Same set again: no duplicate event.
  pollPauseGates(root, state);
  assert.deepEqual(eventTypes(root, "role_paused", "role_resumed"), ["role_paused"]);

  // A second role joins: only the new role's pause is the crossing.
  pauseRole(root, "docs");
  assert.deepEqual(pollPauseGates(root, state).pausedRoles, new Set(["tests", "docs"]));
  assert.deepEqual(eventTypes(root, "role_paused", "role_resumed"), ["role_paused", "role_paused"]);

  // One role resumes: one role_resumed, the other still gated.
  resumeRole(root, "tests");
  assert.deepEqual(pollPauseGates(root, state).pausedRoles, new Set(["docs"]));
  assert.deepEqual(eventTypes(root, "role_paused", "role_resumed"), ["role_paused", "role_paused", "role_resumed"]);

  // Both resume: the set drains to empty.
  resumeRole(root, "docs");
  assert.deepEqual(pollPauseGates(root, state).pausedRoles, new Set());
  assert.deepEqual(eventTypes(root, "role_paused", "role_resumed"), ["role_paused", "role_paused", "role_resumed", "role_resumed"]);
});

function sleepPast(deadlineMs: number): void {
  while (Date.now() <= deadlineMs) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

test("pollPauseGates: a timed team pause whose deadline passes logs team_resumed with expired", () => {
  const root = tmpdir("pause-gates-");
  const state = newPauseGateState();
  const until = Date.now() + 250; // roomy: the first poll must land before it
  pauseTeam(root, until);
  assert.equal(pollPauseGates(root, state).userPaused, true);
  sleepPast(until); // the deadline passes between polls
  assert.equal(pollPauseGates(root, state).userPaused, false);
  const resumed = eventsOfType(root, "team_resumed");
  assert.equal(resumed.length, 1);
  assert.equal((resumed[0] as { expired?: unknown }).expired, true);
  pollPauseGates(root, state);
  assert.equal(eventsOfType(root, "team_resumed").length, 1);
});

test("pollPauseGates: an early resume of a timed team pause carries no expired", () => {
  const root = tmpdir("pause-gates-");
  const state = newPauseGateState();
  pauseTeam(root, Date.now() + 60_000);
  pollPauseGates(root, state);
  resumeTeam(root);
  pollPauseGates(root, state);
  const resumed = eventsOfType(root, "team_resumed");
  assert.equal(resumed.length, 1);
  assert.ok(!("expired" in resumed[0]!));
});

test("pollPauseGates: a per-role pause whose shared deadline passes logs role_resumed with expired", () => {
  const root = tmpdir("pause-gates-");
  const state = newPauseGateState();
  const until = Date.now() + 250; // roomy: the first poll must land before it
  pauseRole(root, "tests", until);
  assert.deepEqual(pollPauseGates(root, state).pausedRoles, new Set(["tests"]));
  sleepPast(until); // the deadline passes between polls
  assert.deepEqual(pollPauseGates(root, state).pausedRoles, new Set());
  const resumed = eventsOfType(root, "role_resumed");
  assert.equal(resumed.length, 1);
  assert.equal((resumed[0] as { role?: unknown; expired?: unknown }).role, "tests");
  assert.equal((resumed[0] as { expired?: unknown }).expired, true);
});

test("pollPauseGates: a per-role pause that expires while no poll runs reads as resumed", () => {
  const root = tmpdir("pause-gates-");
  const state = newPauseGateState();

  pauseRole(root, "tests", Date.now() - 1000); // already expired
  assert.deepEqual(pollPauseGates(root, state).pausedRoles, new Set());
  assert.deepEqual(eventTypes(root, "role_paused", "role_resumed"), []);

  // The standing→expired crossing still logs exactly one resume, via the diff against the
  // previous poll's set (not via a marker-removal event the expired write never made).
  pauseRole(root, "tests", Date.now() + 60_000);
  assert.deepEqual(pollPauseGates(root, state).pausedRoles, new Set(["tests"]));
  resumeRole(root, "tests");
  assert.deepEqual(pollPauseGates(root, state).pausedRoles, new Set());
  assert.deepEqual(eventTypes(root, "role_paused", "role_resumed"), ["role_paused", "role_resumed"]);
  assert.ok(!("expired" in eventsOfType(root, "role_resumed")[0]!), "an operator resume carries no expired");
});

test("pollPauseGates: team and per-role gates are independent", () => {
  const root = tmpdir("pause-gates-");
  const state = newPauseGateState();

  pauseRole(root, "tests");
  pauseTeam(root);
  const both = pollPauseGates(root, state);
  assert.equal(both.userPaused, true);
  assert.deepEqual(both.pausedRoles, new Set(["tests"]));

  resumeTeam(root);
  const teamOnly = pollPauseGates(root, state);
  assert.equal(teamOnly.userPaused, false);
  assert.deepEqual(teamOnly.pausedRoles, new Set(["tests"]));
  assert.deepEqual(eventTypes(root, "team_paused", "team_resumed", "role_paused", "role_resumed"), [
    "role_paused",
    "team_paused",
    "team_resumed",
  ]);
});

test("pollPauseGates: team_paused carries the marker's until and reason", () => {
  const root = tmpdir("pause-gates-");
  const until = Date.now() + 3_600_000;
  pauseTeam(root, until, "deploy freeze");
  pollPauseGates(root, newPauseGateState());
  const events = eventsOfType(root, "team_paused");
  assert.equal(events.length, 1);
  assert.equal(events[0]!.reason, "deploy freeze");
  assert.equal(events[0]!.until, until);
});
