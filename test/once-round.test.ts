import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "../src/config.js";
import type { TumwaterConfig } from "../src/config-schema.js";
import { OnceRound } from "../src/once-round.js";
import { makeLoopRunner, makeRepo } from "./util.js";

function configWithRole(role: string, enabled: boolean): TumwaterConfig {
  const config = defaultConfig();
  config.roles[role] = { enabled };
  return config;
}

test("a role is unsettled at snapshot and settled once its tick count advances", () => {
  const repo = makeRepo();
  const runner = makeLoopRunner(repo, "improve");
  const round = new OnceRound([runner], true);
  assert.equal(round.isSettled(runner), false);
  runner.state.ticks++;
  assert.equal(round.isSettled(runner), true);
});

test("settle records the reason and settles the role without a tick", () => {
  const repo = makeRepo();
  const runner = makeLoopRunner(repo, "improve");
  const round = new OnceRound([runner], true);
  round.settle("improve", "deferred");
  assert.equal(round.isSettled(runner), true);
  assert.deepEqual([...round.reasons], [["improve", "deferred"]]);
});

test("settleSkipped classifies disabled, backoff, and idle roles", () => {
  const repo = makeRepo();
  const disabled = makeLoopRunner(repo, "improve", configWithRole("improve", false));
  const backing = makeLoopRunner(repo, "qa");
  backing.state.backoffSeconds = 30;
  const idle = makeLoopRunner(repo, "clean");
  const round = new OnceRound([disabled, backing, idle], true);
  round.settleSkipped(disabled);
  round.settleSkipped(backing);
  round.settleSkipped(idle);
  assert.deepEqual(
    [...round.reasons].sort(([a], [b]) => a.localeCompare(b)),
    [
      ["clean", "idle"],
      ["improve", "disabled"],
      ["qa", "backoff"],
    ],
  );
});

test("exitReady fires only on the second consecutive quiet poll of an active round", () => {
  const repo = makeRepo();
  const runner = makeLoopRunner(repo, "improve");
  const round = new OnceRound([runner], true);
  runner.state.ticks++; // ran its one tick
  const quiet = { roleTicks: 0, directorTicks: 0, landings: 0, queuedLandings: 0 };
  assert.equal(round.exitReady(quiet), false); // first quiet poll: hold
  assert.equal(round.exitReady(quiet), true); // second: fire
});

test("exitReady stays false while work is in flight and resets the quiet streak", () => {
  const repo = makeRepo();
  const runner = makeLoopRunner(repo, "improve");
  const round = new OnceRound([runner], true);
  runner.state.ticks++;
  assert.equal(round.exitReady({ roleTicks: 1, directorTicks: 0, landings: 0, queuedLandings: 0 }), false);
  assert.equal(round.exitReady({ roleTicks: 0, directorTicks: 1, landings: 0, queuedLandings: 0 }), false);
  assert.equal(round.exitReady({ roleTicks: 0, directorTicks: 0, landings: 1, queuedLandings: 0 }), false);
  assert.equal(round.exitReady({ roleTicks: 0, directorTicks: 0, landings: 0, queuedLandings: 2 }), false);
  // One quiet poll after the in-flight work is not enough: the streak restarted.
  assert.equal(round.exitReady({ roleTicks: 0, directorTicks: 0, landings: 0, queuedLandings: 0 }), false);
  assert.equal(round.exitReady({ roleTicks: 0, directorTicks: 0, landings: 0, queuedLandings: 0 }), true);
});

test("exitReady is inert in an inactive round even when everything is quiet", () => {
  const repo = makeRepo();
  const runner = makeLoopRunner(repo, "improve");
  runner.state.ticks++; // ran its one tick
  const round = new OnceRound([runner], false);
  const quiet = { roleTicks: 0, directorTicks: 0, landings: 0, queuedLandings: 0 };
  assert.equal(round.exitReady(quiet), false);
  assert.equal(round.exitReady(quiet), false);
});

test("exitReady stays false until every runner is settled", () => {
  const repo = makeRepo();
  const ran = makeLoopRunner(repo, "improve");
  const idle = makeLoopRunner(repo, "clean");
  const round = new OnceRound([ran, idle], true);
  ran.state.ticks++; // ran its one tick
  const quiet = { roleTicks: 0, directorTicks: 0, landings: 0, queuedLandings: 0 };
  assert.equal(round.exitReady(quiet), false); // clean has not settled yet
  round.settleSkipped(idle);
  assert.equal(round.exitReady(quiet), false); // first quiet poll
  assert.equal(round.exitReady(quiet), true);
});
