/** The loop e2e suite's interrupted-tick slice — ticks that end without a normal commit:
 * cut-offs at the context ceiling (and their resume-streak limit), aborted runs, the resumes
 * that continue their sessions, and quiet-killed hangs. Extracted from loop.test.ts
 * (2026-09-30) so the topic has a name instead of a row in a grab-bag. The suite's slices run
 * one test FILE per process (each file gets its own process and PATH, which fakePi's global
 * PATH swap requires — see loop.test.ts's header), so this file runs in parallel with the
 * others. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { defaultConfig } from "../src/config/config.js";
import { dequeuePrompt, enqueuePrompt, inboxSize } from "../src/inbox/inbox.js";
import { piLogPath, sessionDir } from "../src/paths.js";
import { eventsOfType } from "./log-fixtures.js";
import { makeLoopRunner, roleWt } from "./loop-fixtures.js";
import { landHead } from "./orchestrator-fixtures.js";
import { initializedRepo, mainSha, tmpdir } from "./fixtures/repo-fixtures.js";
import { fakePi, logFlagsTo } from "./fakes/fake-pi.js";
import { waitForFile, waitForLogLines, watchdogClock } from "./helpers/wait.js";
import { APPROVE_PI, assistantLine, thinkingOnlyLine } from "./pi-events.js";

test("a tick cut off at the context ceiling warns, skips backoff, and resumes", async () => {
  const repo = await initializedRepo();
  // Replays the observed incident: mid-run text, then a thinking-only final message
  // (generation truncated by an output clamp but reported as a normal stop), then pi
  // compacting the session at end of run. No changes, no sentinel.
  const restore = fakePi(
    `printf '%s\n' '${assistantLine("Now git.ts:")}'\n` +
      `printf '%s\n' '${thinkingOnlyLine("git.ts looks clean. Next", { output: 16 })}'\n` +
      `printf '%s\n' '${JSON.stringify({ type: "compaction_start", reason: "threshold" })}'`,
  );
  try {
    const runner = makeLoopRunner(repo, "clean");
    assert.equal((await runner.tick()).result, "no_change");
    const [warning] = eventsOfType(repo, "warning");
    assert.ok(warning, "expected exactly one warning");
    assert.match(String(warning.message), /cut off at the context ceiling/);
    assert.match(String(warning.message), /auto-compacted/);
    assert.doesNotMatch(String(warning.message), /no assistant text/);
    // The work survives in the compacted session: resume it promptly, no idle backoff.
    assert.equal(runner.state.resumePending, true, "the next tick resumes the compacted session");
    assert.equal(runner.state.backoffSeconds, 0, "a cut-off is not idleness");
    assert.equal(runner.state.cutOffStreak, 1);
  } finally {
    restore();
  }
});

test("cut-off resumes stop after the streak limit and fall back to backoff", async () => {
  const repo = await initializedRepo();
  // Every run gets cut off; a session file exists so resumes are actually attempted.
  const argsFile = path.join(tmpdir(), "argv.log");
  const restore = fakePi(
    [logFlagsTo(argsFile), `printf '%s\n' '${thinkingOnlyLine("cut off again", { output: 16 })}'`].join(
      "\n",
    ),
  );
  try {
    fs.mkdirSync(sessionDir(repo, "perf"), { recursive: true });
    fs.writeFileSync(path.join(sessionDir(repo, "perf"), "s.jsonl"), "{}\n");
    const runner = makeLoopRunner(repo, "perf");
    for (let i = 1; i <= 3; i++) {
      assert.equal((await runner.tick()).result, "no_change");
      assert.equal(runner.state.resumePending, true, `cut-off ${i} still resumes`);
      assert.equal(runner.state.cutOffStreak, i);
      assert.equal(runner.state.backoffSeconds, 0);
    }
    // Fourth consecutive cut-off: the task is not converging — give up and back off.
    assert.equal((await runner.tick()).result, "no_change");
    assert.equal(runner.state.resumePending, false, "past the limit the loop stops resuming");
    assert.ok(runner.state.backoffSeconds > 0, "and backs off normally");
    const runs = fs.readFileSync(argsFile, "utf8").trim().split("\n");
    assert.ok(!runs[0]?.includes("--continue"), "first tick was fresh");
    for (const later of runs.slice(1)) assert.ok(later.includes("--continue"), "resumes continued the session");
  } finally {
    restore();
  }
});

test("a cut-off director tick re-queues the user prompt instead of resuming", async () => {
  const repo = await initializedRepo();
  const restore = fakePi(`printf '%s\n' '${thinkingOnlyLine("was routing the request", { output: 16 })}'`);
  try {
    enqueuePrompt(repo, "add a widget");
    const runner = makeLoopRunner(repo, "director");
    assert.equal((await runner.tick()).result, "no_change");
    assert.equal(inboxSize(repo), 1, "the truncated prompt was not fulfilled: back in the inbox");
    assert.equal(dequeuePrompt(repo), "add a widget");
    assert.ok(!runner.state.resumePending, "the director reruns the prompt fresh");
  } finally {
    restore();
  }
});

test("an aborted tick lands nothing, does not back off, and marks itself resumable", async () => {
  const repo = await initializedRepo();
  // Writes a half-done change, then hangs until killed. `exec` so SIGTERM reaches sleep.
  const restore = fakePi(`echo partial > partial.txt\nexec sleep 30`);
  try {
    const controller = new AbortController();
    const runner = makeLoopRunner(repo, "improve", defaultConfig(), "main", controller.signal);
    const before = mainSha(repo);
    setTimeout(() => controller.abort(), 300);
    const outcome = await runner.tick();
    assert.equal(outcome.result, "aborted");
    assert.equal(mainSha(repo), before, "nothing lands on main");
    assert.ok(!fs.existsSync(path.join(repo, "partial.txt")));
    assert.equal(runner.state.backoffSeconds, 0);
    assert.ok(runner.state.nextRunAt <= Date.now(), "resumes promptly on restart");
    assert.equal(runner.state.resumePending, true, "the next tick will resume this one");
  } finally {
    restore();
  }
});

test("a resumed tick continues the interrupted session and keeps the worktree edits", async () => {
  const repo = await initializedRepo();
  const argsFile = path.join(tmpdir(), "argv.log");
  // First run: leaves a half-done edit, then hangs until the shutdown abort kills it.
  let restore = fakePi(`echo partial > partial.txt\nexec sleep 30`);
  try {
    const controller = new AbortController();
    const runner = makeLoopRunner(repo, "improve", defaultConfig(), "main", controller.signal);
    // Abort only once the half-done edit has landed: a fixed timer can fire before the
    // fake pi even starts under parallel load, leaving no edits for the resume to keep.
    const tick = runner.tick();
    try {
      await waitForFile(path.join(roleWt(repo, "improve"), "partial.txt"));
    } catch (err) {
      controller.abort(); // don't leave the hung fake pi running after a wait timeout
      throw err;
    }
    controller.abort();
    assert.equal((await tick).result, "aborted");
    restore();

    // The aborted run's pi session is on disk (the fake pi writes none, so seed one).
    fs.mkdirSync(sessionDir(repo, "improve"), { recursive: true });
    fs.writeFileSync(path.join(sessionDir(repo, "improve"), "interrupted.jsonl"), "{}\n");

    // Next launch: a new runner (state comes from disk) resumes and finishes the task.
    restore = fakePi(
      [
        // The resumed tick's commit goes through the review gate before merging.
        APPROVE_PI,
        logFlagsTo(argsFile),
        `printf '%s\n' '${assistantLine("done\nSUMMARY: finish the partial work")}'`,
      ].join("\n"),
    );
    const resumed = makeLoopRunner(repo, "improve");
    assert.equal(resumed.state.resumePending, true, "the flag survives the restart");
    const outcome = await resumed.tick();
    assert.equal(outcome.result, "queued");
    assert.equal(await landHead(repo, resumed, defaultConfig(), "improve"), "changed");
    const run = fs.readFileSync(argsFile, "utf8").trim();
    assert.ok(run.includes("--continue"), "the resume continues the interrupted session");
    assert.ok(!run.includes(" -n"), "no fresh session is started");
    assert.ok(fs.existsSync(path.join(repo, "partial.txt")), "the interrupted edits landed on main");
    assert.equal(resumed.state.resumePending, false, "the flag is consumed");
    assert.equal(eventsOfType(repo, "resume").length, 1);
  } finally {
    restore();
  }
});

// BUGS.md 2026-09-12 (fixed 2026-09-13): a hung tool call used to land as a timeout error
// whose next-tick reset discarded the run's work. The kill must now preserve session + edits,
// resume them promptly, and name the real cause in the bridge so the session does not re-run
// the hung command unchanged.
test("a quiet-killed tick keeps its edits and resumes promptly instead of discarding", async (t) => {
  const repo = await initializedRepo();
  const config = defaultConfig();
  // The shim sleeps 30 so the watchdog owns the kill, and the kill waits (on logical time,
  // watchdogClock) until the shell has written kept.txt and spoken — at a real-time 2s window
  // it could fire first under concurrent suites, and the test measured scheduling rather
  // than the kill's non-destructiveness (BUGS.md).
  config.quietTimeoutSeconds = 5;
  const clock = watchdogClock(t);
  const argsFile = path.join(tmpdir(), "argv.log");
  let restore = fakePi(
    [
      `echo work > kept.txt`, // half-done edit the kill must not destroy
      `printf '%s\n' '${JSON.stringify({ type: "tool_execution_start", toolName: "bash" })}'`,
      `exec sleep 30`,
    ].join("\n"),
  );
  try {
    const runner = makeLoopRunner(repo, "improve", config);
    const tick = runner.tick();
    // Wait for the half-done edit to land: a fixed timer can fire before the fake pi even
    // starts under parallel load. The watchdog kills the run itself — no abort controller.
    await waitForFile(path.join(roleWt(repo, "improve"), "kept.txt"));
    await waitForLogLines(piLogPath(repo, "improve"), "tool_execution_start");
    clock.advance(20_000);
    assert.equal((await tick).result, "quiet_killed");
    assert.ok(
      fs.existsSync(path.join(roleWt(repo, "improve"), "kept.txt")),
      "the edits survive the kill",
    );
    assert.equal(runner.state.resumePending, true, "the next tick resumes this one");
    assert.ok(runner.state.nextRunAt <= Date.now(), "the resume is scheduled promptly, not backed off");
    // Real time again for the resume: if its bridge regressed, the fake pi below stalls and the
    // watchdog's real 5 s window ends the run, instead of a hang on a clock nobody advances.
    clock.release();

    // The killed run's pi session is on disk (the fake pi writes none, so seed one).
    fs.mkdirSync(sessionDir(repo, "improve"), { recursive: true });
    fs.writeFileSync(path.join(sessionDir(repo, "improve"), "interrupted.jsonl"), "{}\n");

    // Next launch resumes the session and finishes the task; the bridge names the hang
    // watchdog. If it did not (regression), the fake pi stalls again and the assertions fail.
    restore = fakePi(
      [
        APPROVE_PI,
        logFlagsTo(argsFile),
        `for a in "$@"; do case "$a" in *"hang watchdog"*) printf '%s\n' '${assistantLine("done\nSUMMARY: finish the partial work")}'; exit 0;; esac; done`,
        `exec sleep 30`,
      ].join("\n"),
    );
    const resumed = makeLoopRunner(repo, "improve", config);
    assert.equal(resumed.state.resumePending, true, "the flag survives the restart");
    const outcome = await resumed.tick();
    assert.equal(outcome.result, "queued");
    assert.equal(await landHead(repo, resumed, config, "improve"), "changed");
    const run = fs.readFileSync(argsFile, "utf8").trim();
    assert.ok(run.includes("--continue"), "the resume continues the interrupted session");
    assert.ok(fs.existsSync(path.join(repo, "kept.txt")), "the kept edits landed on main");
    assert.equal(resumed.state.resumePending, false, "the flag is consumed");
  } finally {
    restore();
  }
});
