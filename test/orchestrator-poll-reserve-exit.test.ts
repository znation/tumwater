/** Tests for the per-poll priority-headroom + once-exit step (src/orchestrator/orchestrator-poll.ts
 * `pollReserveAndExit`). The once-exit reads the live merge pins only while a once round is
 * active: in a daemon round (`once.active` false) the exit is never reachable, so counting the
 * pins — a `git for-each-ref` spawn per poll — would be spent to be discarded. */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pollReserveAndExit } from "../src/orchestrator/orchestrator-poll.js";
import { newPollState } from "../src/orchestrator/orchestrator-poll.js";
import type { PollContext } from "../src/orchestrator/orchestrator-poll.js";
import { OnceRound } from "../src/scheduling/once-round.js";
import { Semaphore } from "../src/concurrency/semaphore.js";
import { readCapture } from "./helpers/read-capture.js";
import { flushImmediate } from "./helpers/wait.js";
import { defaultConfig } from "../src/config/config.js";
import { mergeRefName } from "../src/paths.js";
import { makeRepo, sh, loggingGit, tmpdir, headSha } from "./fixtures/repo-fixtures.js";

function ctx(root: string, active: boolean, semaphore = new Semaphore(1)): PollContext {
  return {
    root,
    mainBranch: "main",
    onceMode: active,
    runners: [],
    once: new OnceRound([], active),
    roleInFlight: new Set(),
    directorInFlight: new Set(),
    merges: { merge: null, postReview: null },
    semaphore,
    emit: () => {},
  } as unknown as PollContext;
}

/** The two `readMergePins`-reachable subprocesses a no-roles-named read spawns: the ref
 * listing (a `for-each-ref` under the merge prefix) and, per resolved pin, a `cat-file -e`.
 * The pin's `git log` rides along but is not the signal under test. */
function spawnCount(logFile: string): { list: number; catFile: number } {
  const lines = readCapture(logFile).trimEnd().split("\n").filter((l) => l !== "");
  let list = 0;
  let catFile = 0;
  for (const line of lines) {
    const args = line.split(/\s+/);
    if (args[0] === "for-each-ref" && args.includes("refs/tumwater/merge/")) list++;
    if (args[0] === "cat-file") catFile++;
  }
  return { list, catFile };
}

test("a daemon poll never spawns to count merge pins (exit unreachable)", async () => {
  const root = makeRepo();
  // One live pin the daemon would otherwise enumerate and read every poll.
  sh(root, "git", "update-ref", mergeRefName("feature"), headSha(root));
  const logFile = path.join(tmpdir(), "git-spawns.log");
  const restorePath = loggingGit(logFile);
  try {
    const c = ctx(root, false);
    const state = newPollState();
    const inputs = { liveConfig: defaultConfig(), mainHead: headSha(root), now: Date.now() };
    assert.equal(await pollReserveAndExit(c, state, inputs), false, "a daemon round never exits");
    const spawns = spawnCount(logFile);
    assert.equal(spawns.list, 0, "no for-each-ref over the merge pins in a daemon poll");
    assert.equal(spawns.catFile, 0, "no cat-file for the pin in a daemon poll");
  } finally {
    restorePath();
  }
});

test("a once poll spawns to count its merge pins (the exit is live)", async () => {
  const root = makeRepo();
  sh(root, "git", "update-ref", mergeRefName("feature"), headSha(root));
  const logFile = path.join(tmpdir(), "git-spawns.log");
  const restorePath = loggingGit(logFile);
  try {
    const c = ctx(root, true);
    const state = newPollState();
    const inputs = { liveConfig: defaultConfig(), mainHead: headSha(root), now: Date.now() };
    // One quiet poll records the idle streak; it must still have counted the pin.
    assert.equal(await pollReserveAndExit(c, state, inputs), false, "one quiet poll is not yet exit-ready");
    const spawns = spawnCount(logFile);
    assert.equal(spawns.list, 1, "a once poll lists the merge pins");
    assert.ok(spawns.catFile >= 1, "a once poll reads the pin's commit");
  } finally {
    restorePath();
  }
});

test("the poll sets the maintenance floor off the live cap: the parked maintenance run takes the next freed permit", async () => {
  // pollReserveAndExit sizes the floor as maintenanceFloorCount(maxConcurrent) — 1 at cap 4. With
  // the cap full of work holders, a parked maintenance waiter must beat a parked work waiter for
  // the first freed permit; without the wiring the floor stays 0 and work wins.
  const root = makeRepo();
  const semaphore = new Semaphore(4);
  const c = ctx(root, false, semaphore);
  const state = newPollState();
  const inputs = { liveConfig: { ...defaultConfig(), maxConcurrent: 4 }, mainHead: headSha(root), now: Date.now() };
  const held: Array<Awaited<ReturnType<Semaphore["acquireLease"]>>> = [];
  for (let i = 0; i < 4; i++) held.push(await semaphore.acquireLease(0)); // work holds the whole cap
  const [h1, h2, h3, h4] = held as [typeof held[0], typeof held[0], typeof held[0], typeof held[0]];
  const order: string[] = [];
  const maint = semaphore.acquireLease(1).then((lease) => {
    order.push("maint");
    return lease;
  });
  await flushImmediate();
  const work = semaphore.acquireLease(0).then((lease) => {
    order.push("work");
    return lease;
  });
  await flushImmediate();
  assert.deepEqual(order, [], "both waiters park while four holders sit at the cap");

  assert.equal(await pollReserveAndExit(c, state, inputs), false, "a daemon round never exits");
  h1.release();
  await flushImmediate();
  assert.deepEqual(order, ["maint"], "the poll's floor gives the freed permit to maintenance");

  (await maint).release();
  await flushImmediate();
  assert.deepEqual(order, ["maint", "work"], "and work takes the next one");
  (await work).release();
  h2.release();
  h3.release();
  h4.release();
  assert.equal(semaphore.snapshot().inUse, 0, "every lease gave its permit back");
});
