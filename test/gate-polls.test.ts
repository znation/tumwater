/** pollFleetGates (src/gate-polls.ts): the wiring between the error-streak circuit breaker's
 * trips and the pause gates' edge-triggered event bookkeeping. The breaker pauses through the
 * same per-role marker the operator's `pause --role` writes, so without coordination the NEXT
 * poll's pause gate sees the marker change and logs a generic role_paused on top of the
 * breaker's own role_streak_paused — one pause, two events, the second mislabeled. */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { defaultConfig } from "../src/config.js";
import { LoopRunner } from "../src/loop.js";
import { newFleetGateStates, pollFleetGates } from "../src/gate-polls.js";
import { readEvents } from "../src/event-read.js";
import { tmpdir } from "./repo-fixtures.js";

test("pollFleetGates: a breaker trip logs role_streak_paused once — no duplicate role_paused on the next poll", () => {
  const root = tmpdir("gate-polls-");
  const config = defaultConfig();
  const runner = new LoopRunner(root, "docs", config, "main");
  runner.state.consecutiveErrors = 10;
  runner.state.lastError = "boom";

  const states = newFleetGateStates(config);
  const ctx = {
    root,
    runners: [runner],
    liveConfig: config,
    // No fallback pair in the default config: the models catalog is never read.
    modelsPath: path.join(root, "models.json"),
    now: Date.now(),
    info: { pid: process.pid, startedAt: 0, roles: ["docs"] },
    infoFile: path.join(root, "orchestrator.json"),
  };

  // Poll 1: the breaker trips — the scheduler's paused-roles view must block the role on
  // this very poll, and the breaker's own event is the announcement.
  const first = pollFleetGates(states, ctx);
  assert.ok(first.pausedRoles.has("docs"), "the fresh trip must fold into this poll's paused view");

  // Poll 2: the pause stands. The breaker logs nothing more, and the pause gates must not
  // re-log the same pause as a generic role_paused (whose contract names an operator action).
  const second = pollFleetGates(states, ctx);
  assert.ok(second.pausedRoles.has("docs"), "the marker keeps blocking on the next poll");

  const events = readEvents(root, 100);
  assert.equal(
    events.filter((e) => e.type === "role_streak_paused").length,
    1,
    "exactly one breaker event for one trip",
  );
  assert.equal(
    events.filter((e) => e.type === "role_paused").length,
    0,
    "the breaker's pause must not surface again as an operator pause",
  );
});
