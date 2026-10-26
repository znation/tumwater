import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "../src/config/config.js";
import type { TumwaterConfig } from "../src/config/config-schema.js";
import { OnceRound } from "../src/scheduling/once-round.js";
import { sortEntriesByKey } from "../src/collections.js";
import type { RoleRunner } from "../src/runner/runner.js";
import { makeRoleRunner } from "./fixtures/runner-fixtures.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";

function configWithRole(role: string, enabled: boolean): TumwaterConfig {
  const config = defaultConfig();
  config.roles[role] = { enabled };
  return config;
}

test("a role is unsettled at snapshot and settled once its run count advances", () => {
  const repo = makeRepo();
  const runner = makeRoleRunner(repo, "improve");
  const round = new OnceRound([runner], true);
  assert.equal(round.isSettled(runner), false);
  runner.state.runs++;
  assert.equal(round.isSettled(runner), true);
});

test("settle records the reason and settles the role without a run", () => {
  const repo = makeRepo();
  const runner = makeRoleRunner(repo, "improve");
  const round = new OnceRound([runner], true);
  round.settle("improve", "deferred");
  assert.equal(round.isSettled(runner), true);
  assert.deepEqual([...round.reasons], [["improve", "deferred"]]);
});

test("settleSkipped classifies disabled, backoff, and idle roles", () => {
  const repo = makeRepo();
  const disabled = makeRoleRunner(repo, "improve", configWithRole("improve", false));
  const backing = makeRoleRunner(repo, "qa");
  backing.state.backoffSeconds = 30;
  const idle = makeRoleRunner(repo, "clean");
  const round = new OnceRound([disabled, backing, idle], true);
  round.settleSkipped(disabled);
  round.settleSkipped(backing);
  round.settleSkipped(idle);
  assert.deepEqual(
    sortEntriesByKey([...round.reasons]),
    [
      ["clean", "idle"],
      ["improve", "disabled"],
      ["qa", "backoff"],
    ],
  );
});

test("settleSkipped reports a pending resume as pending work, not idle or backoff", () => {
  const repo = makeRepo();
  // A cut-off run resumes deliberately one interval out: resumePending with a future
  // nextRunAt and backoffSeconds left wherever the previous outcome put it — zero after a
  // productive run (the cutOff arm only schedules the interval, src/run/run-apply.ts). The old
  // classification read this state as "idle — nothing was due", which is false: the role's
  // half-finished work is the reason it is not running.
  const waiting = makeRoleRunner(repo, "improve");
  waiting.state.resumePending = true;
  waiting.state.nextRunAt = Date.now() + 30 * 60_000;
  waiting.state.backoffSeconds = 0;
  // Same wait after an error streak: the resume wait is still the role's truth, not the
  // stale ladder it inherited.
  const afterError = makeRoleRunner(repo, "clean");
  afterError.state.resumePending = true;
  afterError.state.nextRunAt = Date.now() + 30 * 60_000;
  afterError.state.backoffSeconds = 120;
  const round = new OnceRound([waiting, afterError], true);
  round.settleSkipped(waiting);
  round.settleSkipped(afterError);
  assert.deepEqual(
    sortEntriesByKey([...round.reasons]),
    [
      ["clean", "resume pending"],
      ["improve", "resume pending"],
    ],
  );
});

test("a runner appended mid-round is snapshotted at first sight, not settled by its history", () => {
  const repo = makeRepo();
  const first = makeRoleRunner(repo, "improve");
  // The orchestrator's runners array is shared with the live config reload: a role enabled
  // mid-round joins it here, carrying persisted runs from earlier rounds (BUGS.md 2026-09-25:
  // before first-sight snapshotting the missing entry read as 0, so 5 > 0 counted the role as
  // already settled and the round exited without ever running it).
  const runners: RoleRunner[] = [first];
  const round = new OnceRound(runners, true);
  const late = makeRoleRunner(repo, "clean");
  late.state.runs = 5; // history, not this round
  runners.push(late);
  assert.equal(round.isSettled(late), false);
  const quiet = { roleRuns: 0, directorRuns: 0, merges: 0, queuedMerges: 0 };
  assert.equal(round.exitReady(quiet), false); // the late role holds the round open
  late.state.runs++; // its one run this round
  assert.equal(round.isSettled(late), true);
  assert.equal(round.runsDone(late), 1); // exactly the round's run, not the history
  first.state.runs++;
  assert.equal(round.exitReady(quiet), false); // first quiet poll
  assert.equal(round.exitReady(quiet), true);
});

test("exitReady fires only on the second consecutive quiet poll of an active round", () => {
  const repo = makeRepo();
  const runner = makeRoleRunner(repo, "improve");
  const round = new OnceRound([runner], true);
  runner.state.runs++; // ran its one run
  const quiet = { roleRuns: 0, directorRuns: 0, merges: 0, queuedMerges: 0 };
  assert.equal(round.exitReady(quiet), false); // first quiet poll: hold
  assert.equal(round.exitReady(quiet), true); // second: fire
});

test("exitReady stays false while work is in flight and resets the quiet streak", () => {
  const repo = makeRepo();
  const runner = makeRoleRunner(repo, "improve");
  const round = new OnceRound([runner], true);
  runner.state.runs++;
  assert.equal(round.exitReady({ roleRuns: 1, directorRuns: 0, merges: 0, queuedMerges: 0 }), false);
  assert.equal(round.exitReady({ roleRuns: 0, directorRuns: 1, merges: 0, queuedMerges: 0 }), false);
  assert.equal(round.exitReady({ roleRuns: 0, directorRuns: 0, merges: 1, queuedMerges: 0 }), false);
  assert.equal(round.exitReady({ roleRuns: 0, directorRuns: 0, merges: 0, queuedMerges: 2 }), false);
  // One quiet poll after the in-flight work is not enough: the streak restarted.
  assert.equal(round.exitReady({ roleRuns: 0, directorRuns: 0, merges: 0, queuedMerges: 0 }), false);
  assert.equal(round.exitReady({ roleRuns: 0, directorRuns: 0, merges: 0, queuedMerges: 0 }), true);
});

test("exitReady is inert in an inactive round even when everything is quiet", () => {
  const repo = makeRepo();
  const runner = makeRoleRunner(repo, "improve");
  runner.state.runs++; // ran its one run
  const round = new OnceRound([runner], false);
  const quiet = { roleRuns: 0, directorRuns: 0, merges: 0, queuedMerges: 0 };
  assert.equal(round.exitReady(quiet), false);
  assert.equal(round.exitReady(quiet), false);
});

test("exitReady stays false until every runner is settled", () => {
  const repo = makeRepo();
  const ran = makeRoleRunner(repo, "improve");
  const idle = makeRoleRunner(repo, "clean");
  const round = new OnceRound([ran, idle], true);
  ran.state.runs++; // ran its one run
  const quiet = { roleRuns: 0, directorRuns: 0, merges: 0, queuedMerges: 0 };
  assert.equal(round.exitReady(quiet), false); // clean has not settled yet
  round.settleSkipped(idle);
  assert.equal(round.exitReady(quiet), false); // first quiet poll
  assert.equal(round.exitReady(quiet), true);
});
