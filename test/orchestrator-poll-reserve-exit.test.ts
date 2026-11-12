/** Tests for the per-poll priority-headroom + once-exit step (src/orchestrator/orchestrator-poll.ts
 * `pollReserveAndExit`). The once-exit reads the live merge pins only while a once round is
 * active: in a daemon round (`once.active` false) the exit is never reachable, so counting the
 * pins — a `git for-each-ref` spawn per poll — would be spent to be discarded. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pollReserveAndExit } from "../src/orchestrator/orchestrator-poll.js";
import { newPollState } from "../src/orchestrator/orchestrator-poll.js";
import type { PollContext } from "../src/orchestrator/orchestrator-poll.js";
import { OnceRound } from "../src/scheduling/once-round.js";
import { Semaphore } from "../src/concurrency/semaphore.js";
import { defaultConfig } from "../src/config/config.js";
import { mergeRefName } from "../src/paths.js";
import { makeRepo, sh, loggingGit, tmpdir, headSha } from "./fixtures/repo-fixtures.js";

function ctx(root: string, active: boolean): PollContext {
  return {
    root,
    mainBranch: "main",
    onceMode: active,
    runners: [],
    once: new OnceRound([], active),
    roleInFlight: new Set(),
    directorInFlight: new Set(),
    merges: { merge: null, postReview: null },
    semaphore: new Semaphore(1),
    emit: () => {},
  } as unknown as PollContext;
}

/** The two `readMergePins`-reachable subprocesses a no-roles-named read spawns: the ref
 * listing (a `for-each-ref` under the merge prefix) and, per resolved pin, a `cat-file -e`.
 * The pin's `git log` rides along but is not the signal under test. */
function spawnCount(logFile: string): { list: number; catFile: number } {
  const lines = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trimEnd().split("\n") : [];
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
