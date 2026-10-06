/** roleCapPaused and pollRoleCapGate (src/gates/role-cap-gates.ts): the per-role daily cost cap's
 * stateless verdict and its edge-triggered event bookkeeping (PLANS.md 2026-09-30, part 1/2). */

import test from "node:test";
import assert from "node:assert/strict";

import { dailyCost, recordDailyCost } from "../src/budget.js";
import { freshLoopState, type LoopState } from "../src/loop-state.js";
import { DIRECTOR_ROLE } from "../src/roles.js";
import {
  newRoleCapGateState,
  pollRoleCapGate,
  roleCapPaused,
} from "../src/gates/role-cap-gates.js";
import { readEvents } from "../src/events/event-read.js";
import { tmpdir } from "./repo-fixtures.js";

const DAY = 24 * 60 * 60 * 1000;

function overCapState(role: string, usd: number): LoopState {
  const s = freshLoopState(role);
  recordDailyCost(s, usd);
  return s;
}

test("roleCapPaused: the verdict boundaries", () => {
  const now = Date.now();
  const at = overCapState("docs", 0.5);
  assert.equal(roleCapPaused(at, 0.5, now), true, "at-cap pauses (>= cap)");
  assert.equal(roleCapPaused(at, 0.51, now), false, "below cap does not pause");
  const off = freshLoopState("docs");
  assert.equal(roleCapPaused(off, 0, now), false, "a cap of 0 disables the gate");
  assert.equal(roleCapPaused(off, undefined, now), false, "no cap means uncapped");
  // A stale stamp reads as $0 today — yesterday's spend never pauses today.
  const stale = overCapState("docs", 10);
  stale.dayStamp = undefined;
  assert.equal(dailyCost(stale, now), 0);
  assert.equal(roleCapPaused(stale, 0.01, now), false, "stale spend is not today's spend");
});

test("pollRoleCapGate: one crossing logs exactly one role_cap_paused with the figures", () => {
  const root = tmpdir("role-cap-");
  const state = newRoleCapGateState();
  const runners = [{ role: "docs", state: overCapState("docs", 0.5) }];

  const paused = pollRoleCapGate(root, state, runners, { docs: 0.5 }, Date.now());
  assert.deepEqual([...paused], ["docs"], "the crossing role is in this poll's set");

  const events = readEvents(root, 100).filter((e) => e.type === "role_cap_paused");
  assert.equal(events.length, 1);
  assert.equal(events[0]!.loop, "harness");
  assert.equal(events[0]!.role, "docs");
  assert.equal(events[0]!.spentUsd, 0.5);
  assert.equal(events[0]!.capUsd, 0.5);

  // Repeated over-cap polls log nothing more: the event is edge-triggered.
  pollRoleCapGate(root, state, runners, { docs: 0.5 }, Date.now());
  pollRoleCapGate(root, state, runners, { docs: 0.5 }, Date.now());
  assert.equal(
    readEvents(root, 100).filter((e) => e.type === "role_cap_paused").length,
    1,
    "one event per crossing",
  );
});

test("pollRoleCapGate: midnight lifts (role_cap_resumed) and a later crossing re-logs", () => {
  const root = tmpdir("role-cap-midnight-");
  const state = newRoleCapGateState();
  const s = overCapState("docs", 0.5);
  const runners = [{ role: "docs", state: s }];
  const caps = { docs: 0.5 };

  const day1 = Date.now();
  pollRoleCapGate(root, state, runners, caps, day1);

  // Next local day: the stale stamp reads as $0, so the verdict lifts by itself.
  const day2 = day1 + DAY;
  const lifted = pollRoleCapGate(root, state, runners, caps, day2);
  assert.equal(lifted.size, 0, "a new local day lifts the pause");
  assert.equal(
    readEvents(root, 100).filter((e) => e.type === "role_cap_resumed").length,
    1,
    "one resume event on the exit",
  );

  // A fresh crossing on the new day re-logs.
  recordDailyCost(s, 1, day2);
  const again = pollRoleCapGate(root, state, runners, caps, day2);
  assert.deepEqual([...again], ["docs"]);
  const paused = readEvents(root, 100).filter((e) => e.type === "role_cap_paused");
  assert.equal(paused.length, 2, "the new crossing logs its own event");
  assert.equal(paused[1]!.spentUsd, 1);
});

test("pollRoleCapGate: a cap removal or raise lifts a paused role", () => {
  const root = tmpdir("role-cap-raise-");
  const state = newRoleCapGateState();
  const runners = [{ role: "docs", state: overCapState("docs", 0.5) }];

  pollRoleCapGate(root, state, runners, { docs: 0.5 }, Date.now());
  const raised = pollRoleCapGate(root, state, runners, { docs: 5 }, Date.now());
  assert.equal(raised.size, 0);
  assert.equal(
    readEvents(root, 100).filter((e) => e.type === "role_cap_resumed").length,
    1,
    "a raise lifts exactly like midnight",
  );
  // Removing the key entirely is the same lift.
  pollRoleCapGate(root, state, runners, { docs: 0.5 }, Date.now());
  const removed = pollRoleCapGate(root, state, runners, undefined, Date.now());
  assert.equal(removed.size, 0);
});

test("pollRoleCapGate: a restart with a still-over-cap role logs exactly one event", () => {
  const root = tmpdir("role-cap-restart-");
  const runners = [{ role: "docs", state: overCapState("docs", 0.5) }];

  // First "process": cross, then stop (the in-memory state dies with it).
  const first = newRoleCapGateState();
  pollRoleCapGate(root, first, runners, { docs: 0.5 }, Date.now());

  // The restarted harness: a fresh state re-logs one event — the durable cause, honestly
  // reported — and then stays quiet.
  const second = newRoleCapGateState();
  pollRoleCapGate(root, second, runners, { docs: 0.5 }, Date.now());
  pollRoleCapGate(root, second, runners, { docs: 0.5 }, Date.now());
  const paused = readEvents(root, 100).filter((e) => e.type === "role_cap_paused");
  assert.equal(paused.length, 2, "one event before the restart, one after");
});

test("pollRoleCapGate: the director never enters the set, and the set is exactly the paused roles", () => {
  const root = tmpdir("role-cap-director-");
  const state = newRoleCapGateState();
  const runners = [
    { role: "docs", state: overCapState("docs", 0.5) },
    { role: "tests", state: freshLoopState("tests") },
    { role: DIRECTOR_ROLE, state: overCapState(DIRECTOR_ROLE, 100) },
  ];

  const paused = pollRoleCapGate(root, state, runners, { docs: 0.5, [DIRECTOR_ROLE]: 1 }, Date.now());
  assert.deepEqual([...paused].sort(), ["docs"], "only the over-cap non-director roles");
  assert.equal(
    readEvents(root, 100).filter((e) => e.type === "role_cap_paused" && e.role === DIRECTOR_ROLE)
      .length,
    0,
    "no director event — an explicit human prompt outranks the autonomous-spend cap",
  );
  // A role with no entry in the map is uncapped, never paused.
  assert.ok(!paused.has("tests"));
});

test("pollRoleCapGate: no caps configured logs nothing and returns the empty set", () => {
  const root = tmpdir("role-cap-off-");
  const state = newRoleCapGateState();
  const runners = [{ role: "docs", state: overCapState("docs", 500) }];

  for (const caps of [undefined, {}, { docs: 0 }] as (
    | Record<string, number>
    | undefined
  )[]) {
    const paused = pollRoleCapGate(root, state, runners, caps, Date.now());
    assert.equal(paused.size, 0, `${JSON.stringify(caps)} caps nothing`);
  }
  assert.equal(readEvents(root, 100).length, 0, "a disabled gate is byte-identical to no gate");
});
