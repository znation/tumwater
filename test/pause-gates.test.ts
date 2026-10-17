/** pollPauseGates (src/gates/pause-gates.ts): the edge-triggered event logging and gate reads the
 *  orchestrator's poll loop depends on. Exercises the real markers — pauseTeam/resumeTeam and
 *  pauseRole/resumeRole write exactly what the CLI writes, so the contract under test is
 *  producer-and-consumer together, not a mock of either side. */

import test from "node:test";
import assert from "node:assert/strict";

import { newPauseGateState, pollPauseGates } from "../src/gates/pause-gates.js";
import { pauseTeam, resumeTeam, pauseRole, resumeRole } from "../src/team/team-state.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { eventTypes } from "./fixtures/log-fixtures.js";

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

  // Still paused: the edge trigger must not re-log on the ~2s poll cadence.
  assert.equal(pollPauseGates(root, state).userPaused, true);
  assert.deepEqual(eventTypes(root, "team_paused", "team_resumed"), ["team_paused"]);

  resumeTeam(root);
  assert.equal(pollPauseGates(root, state).userPaused, false);
  assert.deepEqual(eventTypes(root, "team_paused", "team_resumed"), ["team_paused", "team_resumed"]);

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

test("pollPauseGates: per-role pause/resume logs role events per crossing", () => {
  const root = tmpdir("pause-gates-");
  const state = newPauseGateState();

  pauseRole(root, "tests");
  const gates = pollPauseGates(root, state);
  assert.equal(gates.userPaused, false);
  assert.deepEqual(gates.pausedRoles, new Set(["tests"]));
  assert.deepEqual(eventTypes(root, "role_paused", "role_resumed"), ["role_paused"]);

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
