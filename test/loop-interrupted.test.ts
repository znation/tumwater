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
import { piLogPath, rejectedRefName, sessionDir } from "../src/paths.js";
import { recordSession } from "../src/agent/session-ledger.js";
import { setRef } from "../src/git/git.js";
import { queuedLandings } from "../src/landing/landing-queue.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";
import { makeLoopRunner, roleWt } from "./fixtures/loop-fixtures.js";
import { landHead } from "./fixtures/orchestrator-fixtures.js";
import { initializedRepo, mainSha, pinOffMain, tmpdir } from "./fixtures/repo-fixtures.js";
import { fakePi, logFlagsTo, logPromptsTo, readPromptRuns } from "./fakes/fake-pi.js";
import { waitForFile, waitForLogLines, watchdogClock } from "./helpers/wait.js";
import { APPROVE_PI, assistantLine, thinkingOnlyLine } from "./fixtures/pi-events.js";

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

// plans/agent-backends.md "Sessions": when the newest author session in the dir belongs to
// another agent, pi's --continue would reach a session that is not this tick's. The tick must
// run a FRESH session over the same unreset worktree, and the bridge must point it at the
// interrupted edits so a fresh context does not silently overwrite or abandon them.
test("a cross-agent handoff runs fresh and keeps the interrupted worktree edits", async () => {
  const repo = await initializedRepo();
  const argsFile = path.join(tmpdir(), "argv.log");
  // First run: leaves a half-done edit, then hangs until the shutdown abort kills it.
  let restore = fakePi(`echo partial > partial.txt\nexec sleep 30`);
  try {
    const controller = new AbortController();
    const runner = makeLoopRunner(repo, "improve", defaultConfig(), "main", controller.signal);
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

    // The aborted run wrote its own pi session and ledger line; append a NEWER author line for
    // another agent. The newest author session is now not this tick's to --continue.
    const dir = sessionDir(repo, "improve");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "interrupted.jsonl"), "{}\n");
    recordSession(dir, {
      agent: "claude",
      id: "c",
      kind: "author",
      name: "n",
      cwd: roleWt(repo, "improve"),
      at: Date.now(),
    });

    // The handoff runs a fresh session and finishes the task; it must not --continue, and its
    // prompt must carry the handoff bridge.
    restore = fakePi(
      [
        APPROVE_PI,
        logPromptsTo(argsFile),
        `printf '%s\n' '${assistantLine("done\nSUMMARY: finish the partial work")}'`,
      ].join("\n"),
    );
    const resumed = makeLoopRunner(repo, "improve");
    assert.equal(resumed.state.resumePending, true, "the flag survives the restart");
    const outcome = await resumed.tick();
    assert.equal(outcome.result, "queued");
    assert.equal(await landHead(repo, resumed, defaultConfig(), "improve"), "changed");
    const run = readPromptRuns(argsFile).join("\n");
    assert.ok(!run.includes("--continue"), "the handoff starts a fresh session");
    assert.match(
      run,
      /uncommitted edits are in your worktree/,
      "the bridge points the fresh run at the kept edits",
    );
    assert.ok(fs.existsSync(path.join(repo, "partial.txt")), "the kept edit landed on main");
    assert.equal(resumed.state.resumePending, false, "the flag is consumed");
  } finally {
    restore();
  }
});

// plans/agent-backends.md "Sessions" + plans/revise-rejected.md: a handoff over an interrupted
// revision already holds the applied rejected diff in its kept worktree. Re-cherry-picking it
// collides with those edits, fails, and resets the worktree to main — destroying the revision.
// The handoff must instead carry the round the way a resume does, with no re-apply.
test("a cross-agent handoff over an interrupted revision keeps its edits and carries the round", async () => {
  const repo = await initializedRepo();
  const argsFile = path.join(tmpdir(), "argv.log");
  let restore = fakePi(`echo partial > partial.txt\nexec sleep 30`);
  try {
    const controller = new AbortController();
    const runner = makeLoopRunner(repo, "improve", defaultConfig(), "main", controller.signal);
    const tick = runner.tick();
    try {
      await waitForFile(path.join(roleWt(repo, "improve"), "partial.txt"));
    } catch (err) {
      controller.abort();
      throw err;
    }
    controller.abort();
    assert.equal((await tick).result, "aborted");
    restore();

    // The rejected diff adds the very path the kept edit left untracked, so a re-apply
    // collides and resets the worktree — the exact regression this test pins.
    const sha = pinOffMain(
      repo,
      (d) => fs.writeFileSync(path.join(d, "partial.txt"), "rejected\n"),
      "the rejected work",
    );
    await setRef(repo, rejectedRefName("improve"), sha);
    // The aborted run's session, then a NEWER author line for another agent: the newest author
    // session is not this tick's to --continue, so the tick hands off.
    const dir = sessionDir(repo, "improve");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "interrupted.jsonl"), "{}\n");
    recordSession(dir, {
      agent: "claude",
      id: "c",
      kind: "author",
      name: "n",
      cwd: roleWt(repo, "improve"),
      at: Date.now(),
    });

    restore = fakePi(
      [
        APPROVE_PI,
        logPromptsTo(argsFile),
        `printf '%s\n' '${assistantLine("done\nSUMMARY: finish the interrupted revision")}'`,
      ].join("\n"),
    );
    const resumed = makeLoopRunner(repo, "improve");
    resumed.state.resumePending = true;
    resumed.state.revision = { sha, round: 1, at: Date.now() };
    resumed.state.lastReview = { verdict: "reject", reasons: ["fix it"], head: sha, at: Date.now() };
    assert.equal((await resumed.tick()).result, "queued");
    assert.equal(eventsOfType(repo, "revision").length, 0, "no re-apply runs on a handoff");
    // The handoff is a FRESH session and tick-prompt suppresses the rejected-review note while
    // state.revision is set, so the revision note must ride this tick's prompt.
    const run = readPromptRuns(argsFile).join("\n");
    assert.match(run, /is revision 1 of \d+/, "the fresh handoff is told it is revising the rejected change");
    assert.match(run, /fix it/, "the fresh handoff receives the review objections");
    assert.equal(queuedLandings(repo)[0]?.revisionRound, 1, "the handoff still owns the revision");
    assert.equal(await landHead(repo, resumed, defaultConfig(), "improve"), "changed");
    assert.ok(
      fs.existsSync(path.join(repo, "partial.txt")),
      "the handoff must not reset the interrupted revision's edits",
    );
  } finally {
    restore();
  }
});

// The conflict-hand-back block is guarded by !resuming so a resume does not re-apply a landed
// diff onto its kept worktree; a handoff keeps the worktree too, so it must be guarded the same
// way — re-applying collides with the kept edits, fails, and resets them.
test("a cross-agent handoff does not re-apply a pending conflict hand-back", async () => {
  const repo = await initializedRepo();
  let restore = fakePi(`echo partial > partial.txt\nexec sleep 30`);
  try {
    const controller = new AbortController();
    const runner = makeLoopRunner(repo, "improve", defaultConfig(), "main", controller.signal);
    const tick = runner.tick();
    try {
      await waitForFile(path.join(roleWt(repo, "improve"), "partial.txt"));
    } catch (err) {
      controller.abort();
      throw err;
    }
    controller.abort();
    assert.equal((await tick).result, "aborted");
    restore();

    const sha = pinOffMain(
      repo,
      (d) => fs.writeFileSync(path.join(d, "partial.txt"), "handed back\n"),
      "the handed-back work",
    );
    const dir = sessionDir(repo, "improve");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "interrupted.jsonl"), "{}\n");
    recordSession(dir, {
      agent: "claude",
      id: "c",
      kind: "author",
      name: "n",
      cwd: roleWt(repo, "improve"),
      at: Date.now(),
    });

    restore = fakePi(
      [APPROVE_PI, `printf '%s\n' '${assistantLine("done\nSUMMARY: finish the interrupted work")}'`].join("\n"),
    );
    const resumed = makeLoopRunner(repo, "improve");
    resumed.state.resumePending = true;
    resumed.state.conflictHandback = { sha, at: Date.now(), reason: "landing", applied: false };
    assert.equal((await resumed.tick()).result, "queued");
    assert.equal(
      resumed.state.conflictHandback?.applied,
      false,
      "the pending hand-back is left for a fresh tick",
    );
    assert.equal(
      eventsOfType(repo, "conflict_handback").length,
      0,
      "the handoff does not touch the pending hand-back",
    );
    assert.equal(await landHead(repo, resumed, defaultConfig(), "improve"), "changed");
    assert.ok(
      fs.existsSync(path.join(repo, "partial.txt")),
      "the handoff must not reset the kept edits by re-applying the hand-back",
    );
  } finally {
    restore();
  }
});

// BUGS.md (fixed 2026-10-09): a handoff runs a FRESH session, so an already-applied conflict
// hand-back must be re-explained — the fresh run meets the marker-bearing files in its kept
// worktree with none of the interrupted session's context that carried the note.
test("a cross-agent handoff re-sends an already-applied landing hand-back note", async () => {
  const repo = await initializedRepo();
  const argsFile = path.join(tmpdir(), "argv.log");
  let restore = fakePi(`echo partial > partial.txt\nexec sleep 30`);
  try {
    const controller = new AbortController();
    const runner = makeLoopRunner(repo, "improve", defaultConfig(), "main", controller.signal);
    const tick = runner.tick();
    try {
      await waitForFile(path.join(roleWt(repo, "improve"), "partial.txt"));
    } catch (err) {
      controller.abort();
      throw err;
    }
    controller.abort();
    assert.equal((await tick).result, "aborted");
    restore();

    const sha = pinOffMain(
      repo,
      (d) => fs.writeFileSync(path.join(d, "partial.txt"), "handed back\n"),
      "the handed-back work",
    );
    // The interrupted tick had already applied the hand-back: the markers are in the kept
    // worktree as ordinary edits (applyWithConflicts reset the index).
    fs.writeFileSync(
      path.join(roleWt(repo, "improve"), "partial.txt"),
      "<<<<<<< HEAD\npartial\n=======\nhanded back\n>>>>>>> abc\n",
    );
    const dir = sessionDir(repo, "improve");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "interrupted.jsonl"), "{}\n");
    recordSession(dir, {
      agent: "claude",
      id: "c",
      kind: "author",
      name: "n",
      cwd: roleWt(repo, "improve"),
      at: Date.now(),
    });

    restore = fakePi(
      [
        APPROVE_PI,
        logPromptsTo(argsFile),
        `printf '%s\n' '${assistantLine("done\nSUMMARY: resolve the hand-back")}'`,
      ].join("\n"),
    );
    const resumed = makeLoopRunner(repo, "improve");
    resumed.state.resumePending = true;
    resumed.state.conflictHandback = { sha, at: Date.now(), reason: "landing", applied: true };
    assert.equal((await resumed.tick()).result, "queued");
    const run = readPromptRuns(argsFile).join("\n");
    assert.match(run, /<conflict-handback>/, "the fresh handoff is told about the hand-back");
    assert.match(run, /could not be landed/, "the note names the landing hand-back");
    assert.match(run, /partial\.txt/, "the note names the marker-bearing file");
  } finally {
    restore();
  }
});

// The revision-with-conflicts variant: the interrupted tick applied a revision hand-back, so a
// fresh handoff must carry BOTH the revision note and the conflict-handback note.
test("a cross-agent handoff over an applied revision conflict carries both notes", async () => {
  const repo = await initializedRepo();
  const argsFile = path.join(tmpdir(), "argv.log");
  let restore = fakePi(`echo partial > partial.txt\nexec sleep 30`);
  try {
    const controller = new AbortController();
    const runner = makeLoopRunner(repo, "improve", defaultConfig(), "main", controller.signal);
    const tick = runner.tick();
    try {
      await waitForFile(path.join(roleWt(repo, "improve"), "partial.txt"));
    } catch (err) {
      controller.abort();
      throw err;
    }
    controller.abort();
    assert.equal((await tick).result, "aborted");
    restore();

    const sha = pinOffMain(
      repo,
      (d) => fs.writeFileSync(path.join(d, "partial.txt"), "rejected\n"),
      "the rejected work",
    );
    fs.writeFileSync(
      path.join(roleWt(repo, "improve"), "partial.txt"),
      "<<<<<<< HEAD\npartial\n=======\nrejected\n>>>>>>> abc\n",
    );
    const dir = sessionDir(repo, "improve");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "interrupted.jsonl"), "{}\n");
    recordSession(dir, {
      agent: "claude",
      id: "c",
      kind: "author",
      name: "n",
      cwd: roleWt(repo, "improve"),
      at: Date.now(),
    });

    restore = fakePi(
      [
        APPROVE_PI,
        logPromptsTo(argsFile),
        `printf '%s\n' '${assistantLine("done\nSUMMARY: resolve the revision conflict")}'`,
      ].join("\n"),
    );
    const resumed = makeLoopRunner(repo, "improve");
    resumed.state.resumePending = true;
    resumed.state.revision = { sha, round: 1, at: Date.now() };
    resumed.state.lastReview = { verdict: "reject", reasons: ["fix it"], head: sha, at: Date.now() };
    resumed.state.conflictHandback = {
      sha,
      at: Date.now(),
      reason: "revision",
      round: 1,
      applied: true,
    };
    assert.equal((await resumed.tick()).result, "queued");
    const run = readPromptRuns(argsFile).join("\n");
    assert.match(run, /is revision 1 of \d+/, "the fresh handoff is told it is revising");
    assert.match(run, /<conflict-handback>/, "the fresh handoff is told about the markers too");
    assert.match(run, /no longer applies cleanly/, "the note names the revision hand-back");
    assert.equal(queuedLandings(repo)[0]?.revisionRound, 1, "the handoff still owns the revision");
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
