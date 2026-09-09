import { execFileSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { LoopRunner } from "../src/loop.js";
import { initProject } from "../src/init.js";
import { defaultConfig, validateConfig } from "../src/config.js";
import { dequeuePrompt, enqueuePrompt, inboxSize } from "../src/inbox.js";
import { readEvents } from "../src/events.js";
import { freshLoopState, loadLoopState, saveLoopState } from "../src/state.js";
import { sessionDir, worktreePath } from "../src/paths.js";
import { assistantLine, errorLine, fakePi, makeRepo, sh, thinkingOnlyLine, tmpdir } from "./util.js";

async function initializedRepo(): Promise<string> {
  const repo = makeRepo();
  await initProject(repo, "A test project.");
  return repo;
}

/** Poll until `file` exists (bounded), so a test can act only after the fake pi run has
 * done its work — a fixed sleep races process startup when the suite runs in parallel. */
async function waitForFile(file: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!fs.existsSync(file)) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Poll until `branch` is at least one commit ahead of main (bounded). Times an abort to
 * land AFTER the author run's commit and BEFORE/IN the review gate's run — a fixed sleep
 * would race the commit under parallel load. The branch does not exist until ensureWorktree
 * creates it, so a missing revision reads as "not ahead yet", not a poll failure. */
async function waitForAhead(repo: string, branch: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    let count = 0;
    try {
      count = Number(sh(repo, "git", "rev-list", "--count", `main..${branch}`));
    } catch {
      // Branch not created yet — keep polling.
    }
    if (count >= 1) return;
    if (Date.now() - start > timeoutMs)
      throw new Error(`timed out waiting for ${branch} to get ahead of main`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("a tick that changes files commits and merges to main", async () => {
  const repo = await initializedRepo();
  const restore = fakePi(
    [
      // The review gate (enabled by default) runs after the commit: approve with zero usage so
      // the tick's token assertions below see only the author run.
      `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
      `printf '%s\n' '${assistantLine("done\nSUMMARY: add hello file", { tokens: 42, output: 42, cost: 0.05 })}'`,
      `echo hello > hello.txt`,
    ].join("\n"),
  );
  try {
    const runner = new LoopRunner(repo, "improve", defaultConfig(), "main");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "changed");
    assert.equal(outcome.summary, "add hello file");
    assert.ok(fs.existsSync(path.join(repo, "hello.txt")));
    assert.match(sh(repo, "git", "log", "-1", "--format=%s"), /tumwater\(improve\): add hello file/);
    assert.equal(runner.state.commits, 1);
    assert.equal(runner.state.backoffSeconds, 0);
    assert.equal(runner.state.generatedTokens, 42);
    assert.equal(runner.state.peakContextTokens, 42);
  } finally {
    restore();
  }
});

test("a changed tick schedules its next run at the role's own interval, not the global", async () => {
  // AC3 chain (plans/steward-role.md): applyTickOutcome's branches and configForRole's
  // resolution are unit-covered; this pins the link between them — that tick() resolves
  // the per-role override once at the top and hands it to the scheduler. A role with a
  // slow clock (3600 s) over the fast global (20 s) must land its next run ~1 h out, not
  // 20 s: a read of config.minTickIntervalSeconds directly would have scheduled it in seconds.
  const repo = await initializedRepo();
  const restore = fakePi(
    [
      `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
      `printf '%s\n' '${assistantLine("done\nSUMMARY: add hello file", { tokens: 42, output: 42, cost: 0.05 })}'`,
      `echo hello > hello.txt`,
    ].join("\n"),
  );
  try {
    const config = defaultConfig();
    assert.equal(config.minTickIntervalSeconds, 20, "the global stays fast");
    config.roles.improve = { enabled: true, minTickIntervalSeconds: 3600 };
    const runner = new LoopRunner(repo, "improve", config, "main");
    assert.equal((await runner.tick()).result, "changed");
    // The persisted state — what a restarted process would read — schedules ~1 h out.
    const s = loadLoopState(repo, "improve");
    const ended = s.lastTickEndedAt;
    assert.ok(ended !== undefined, "the tick recorded its end time");
    const gapMs = s.nextRunAt - ended;
    assert.ok(
      Math.abs(gapMs - 3_600_000) < 10_000,
      `next run is ~1 h after the tick ended, got ${gapMs} ms`,
    );
  } finally {
    restore();
  }
});

test("gen / peak ctx are per-tick windows: a second tick does not accumulate on the first", async () => {
  const repo = await initializedRepo();
  // The fake pi counts its invocations in a file OUTSIDE the worktree (so it never dirties
  // the tree) and reports different usage per call, giving two ticks known distinct totals.
  const counter = path.join(tmpdir(), "pi-calls");
  fs.writeFileSync(counter, "0");
  const line1 = assistantLine("first tick\nSUMMARY: first", { tokens: 42, output: 42, cost: 0.05 });
  const line2 = assistantLine("second tick\nSUMMARY: second", { tokens: 7, output: 7, cost: 0.01 });
  const restore = fakePi(
    `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done\n` +
      `n=$(cat '${counter}'); n=$((n+1)); echo $n > '${counter}'\n` +
      `[ "$n" -eq 1 ] && { printf '%s\n' '${line1}'; echo one > t.txt; } || { printf '%s\n' '${line2}'; echo two >> t.txt; }`,
  );
  try {
    const runner = new LoopRunner(repo, "improve", defaultConfig(), "main");
    assert.equal((await runner.tick()).result, "changed");
    // After the first completed tick the state file holds that tick's usage only.
    assert.equal(runner.state.generatedTokens, 42);
    assert.equal(runner.state.peakContextTokens, 42);
    assert.equal(loadLoopState(repo, "improve").generatedTokens, 42);

    assert.equal((await runner.tick()).result, "changed");
    // The second tick's totals REPLACE the first — not summed onto it (the old cumulative
    // bug showed 49 here). Peak ctx is a per-tick window too: 7, not max(42, 7).
    assert.equal(runner.state.generatedTokens, 7);
    assert.equal(runner.state.peakContextTokens, 7);
    const onDisk = loadLoopState(repo, "improve");
    assert.equal(onDisk.generatedTokens, 7);
    assert.equal(onDisk.peakContextTokens, 7);
    // Lifetime counters are untouched by the per-tick reset.
    assert.equal(runner.state.ticks, 2);
    assert.equal(runner.state.commits, 2);
  } finally {
    restore();
  }
});

test("a nothing-to-do tick backs off without committing", async () => {
  const repo = await initializedRepo();
  const restore = fakePi(`printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`);
  try {
    const config = defaultConfig();
    const runner = new LoopRunner(repo, "clean", config, "main");
    const before = sh(repo, "git", "rev-parse", "main");
    const first = await runner.tick();
    assert.equal(first.result, "no_change");
    assert.equal(sh(repo, "git", "rev-parse", "main"), before);
    assert.equal(runner.state.backoffSeconds, config.idleBackoff.initialSeconds);
    const second = await runner.tick();
    assert.equal(second.result, "no_change");
    assert.equal(
      runner.state.backoffSeconds,
      config.idleBackoff.initialSeconds * config.idleBackoff.factor,
    );
    assert.ok(runner.state.nextRunAt > Date.now());
  } finally {
    restore();
  }
});

test("a nothing-to-do declaration in an intermediate turn does not warn (regression)", async () => {
  const repo = await initializedRepo();
  // pi declares nothing-to-do, then emits a closing remark afterwards; no file changes.
  const restore = fakePi(
    `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'\n` +
      `printf '%s\n' '${assistantLine("all done")}'`,
  );
  try {
    const runner = new LoopRunner(repo, "clean", defaultConfig(), "main");
    assert.equal((await runner.tick()).result, "no_change");
    const warnings = readEvents(repo).filter((e) => e.type === "warning");
    assert.deepEqual(warnings, [], "no spurious warning when the sentinel was declared mid-run");
  } finally {
    restore();
  }
});

test("a non-compliant tick warns and notes a truncated final message", async () => {
  const repo = await initializedRepo();
  const restore = fakePi(`printf '%s\n' '${assistantLine("hmm, let me think", { stopReason: "length" })}'`);
  try {
    const runner = new LoopRunner(repo, "clean", defaultConfig(), "main");
    assert.equal((await runner.tick()).result, "no_change");
    const [warning] = readEvents(repo).filter((e) => e.type === "warning");
    assert.ok(warning, "expected exactly one warning");
    assert.match(String(warning.message), /stopReason=length/);
  } finally {
    restore();
  }
});

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
    const runner = new LoopRunner(repo, "clean", defaultConfig(), "main");
    assert.equal((await runner.tick()).result, "no_change");
    const [warning] = readEvents(repo).filter((e) => e.type === "warning");
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
    [
      `flags=""`,
      `for a in "$@"; do case "$a" in --continue|-n) flags="$flags $a";; esac; done`,
      `echo "run:$flags" >> "${argsFile}"`,
      `printf '%s\n' '${thinkingOnlyLine("cut off again", { output: 16 })}'`,
    ].join("\n"),
  );
  try {
    fs.mkdirSync(sessionDir(repo, "perf"), { recursive: true });
    fs.writeFileSync(path.join(sessionDir(repo, "perf"), "s.jsonl"), "{}\n");
    const runner = new LoopRunner(repo, "perf", defaultConfig(), "main");
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
    const runner = new LoopRunner(repo, "director", defaultConfig(), "main");
    assert.equal((await runner.tick()).result, "no_change");
    assert.equal(inboxSize(repo), 1, "the truncated prompt was not fulfilled: back in the inbox");
    assert.equal(dequeuePrompt(repo), "add a widget");
    assert.ok(!runner.state.resumePending, "the director reruns the prompt fresh");
  } finally {
    restore();
  }
});

test("a silent tick warns that no assistant text was captured", async () => {
  const repo = await initializedRepo();
  const restore = fakePi(`exit 0`);
  try {
    const runner = new LoopRunner(repo, "clean", defaultConfig(), "main");
    assert.equal((await runner.tick()).result, "no_change");
    const [warning] = readEvents(repo).filter((e) => e.type === "warning");
    assert.ok(warning, "expected exactly one warning");
    assert.match(String(warning.message), /no assistant text/);
  } finally {
    restore();
  }
});

test("a failing pi run records an error and backs off", async () => {
  const repo = await initializedRepo();
  const restore = fakePi(`echo 'pi exploded' >&2\nexit 1`);
  try {
    const runner = new LoopRunner(repo, "clean", defaultConfig(), "main");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "error");
    assert.ok(runner.state.lastError);
    assert.ok(runner.state.backoffSeconds > 0);
  } finally {
    restore();
  }
});

// tick() promises to never throw: runTick's own error paths RETURN an "error" outcome, but
// any unexpected exception (a bug in a new code path, a failed git call, …) must be caught
// by tick()'s defensive branch and degrade the same way. Without it the rejection would
// escape into the orchestrator's task wrapper as an unhandled rejection — crashing the whole
// fleet over one loop's surprise.
test("an unexpected throw inside runTick degrades to an error result instead of escaping", async () => {
  const repo = await initializedRepo();
  const runner = new LoopRunner(repo, "clean", defaultConfig(), "main");
  const stubRunTick = (impl: () => Promise<unknown>) => {
    (runner as unknown as { runTick: () => Promise<unknown> }).runTick = impl;
  };

  // An Error throw is recorded by its message.
  stubRunTick(async () => {
    throw new Error("simulated internal failure");
  });
  const outcome = await runner.tick();
  assert.equal(outcome.result, "error");
  assert.equal(runner.state.lastError, "simulated internal failure");

  // Scheduling continues as for any error tick: the loop backs off (no hot-looping), the
  // running flag clears so the next poll can pick it up, and the result is persisted.
  assert.equal(runner.state.running, false);
  assert.equal(runner.state.lastResult, "error");
  assert.ok(runner.state.backoffSeconds > 0, "backed off instead of retrying immediately");
  assert.ok(runner.state.nextRunAt > Date.now(), "next run scheduled in the future");

  // The tick stays observable: tick_end lands with the error result and message.
  const ends = readEvents(repo).filter((e) => e.type === "tick_end");
  assert.equal(ends.length, 1);
  assert.equal(ends[0]?.result, "error");
  assert.match(String(ends[0]?.error), /simulated internal failure/);

  // A non-Error throw is recorded via String(), not as "undefined" or a crash.
  stubRunTick(async () => {
    throw "raw failure value";
  });
  const outcome2 = await runner.tick();
  assert.equal(outcome2.result, "error");
  assert.equal(runner.state.lastError, "raw failure value");
});

test("director skips with an empty inbox and runs a queued prompt", async () => {
  const repo = await initializedRepo();
  const restore = fakePi(
    [
      `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
      `printf '%s\n' '${assistantLine("ok\nSUMMARY: honor user request")}'`,
      `echo req > request.txt`,
    ].join("\n"),
  );
  try {
    const runner = new LoopRunner(repo, "director", defaultConfig(), "main");
    assert.equal((await runner.tick()).result, "skipped");
    enqueuePrompt(repo, "please add request.txt");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "changed");
    assert.ok(fs.existsSync(path.join(repo, "request.txt")));
    assert.equal(inboxSize(repo), 0, "a fulfilled prompt is not re-queued");
  } finally {
    restore();
  }
});

// A shell fragment for fake-pi scripts: create a session file in the --session-dir pi was given,
// so the harness's resume/continue guard (hasResumableSession) sees a session to continue.
const TOUCH_SESSION = `prev=""; for a in "$@"; do if [ "$prev" = "--session-dir" ]; then mkdir -p "$a"; touch "$a/s.jsonl"; fi; prev="$a"; done`;

test("worktree changes commit even when pi forgets the summary line: the subject names the changed files", async () => {
  const repo = await initializedRepo();
  // Neither the run nor the follow-up turn produces a SUMMARY: the subject is derived from
  // what changed instead of the bare "dry tick 1" (73 such commits in the first 670).
  const restore = fakePi(
    [
      TOUCH_SESSION,
      `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
      `printf '%s\n' '${assistantLine("did it, no summary")}'`,
      `echo x > x.txt`,
    ].join("\n"),
  );
  try {
    const runner = new LoopRunner(repo, "dry", defaultConfig(), "main");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "changed");
    assert.match(sh(repo, "git", "log", "-1", "--format=%s"), /^tumwater\(dry\): Update x\.txt$/);
    const warnings = readEvents(repo).filter((e) => e.type === "warning").map((e) => String(e.message));
    assert.ok(warnings.some((w) => /reply had no SUMMARY line — follow-up gave none; subject derived from the changed files: "Update x\.txt"/.test(w)), JSON.stringify(warnings));
  } finally {
    restore();
  }
});

test("a missing SUMMARY is recovered with one follow-up turn in the tick's own session", async () => {
  const repo = await initializedRepo();
  const argsFile = path.join(tmpdir(), "argv.log");
  // The authoring run edits and ends without the block (a cut-off final message, say); the
  // follow-up — recognizable by its prompt — answers with the full block. Every run records
  // whether it continued a session.
  const restore = fakePi(
    [
      TOUCH_SESSION,
      `flags=""; for a in "$@"; do case "$a" in --continue|-n) flags="$flags $a";; esac; done; echo "run:$flags" >> "${argsFile}"`,
      `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
      `for a in "$@"; do case "$a" in *"did not include the required closing block"*)`,
      `  printf '%s\n' '${assistantLine("SUMMARY: Add the x marker file\nWHY: the harness needed a fixture\nRISK: none\nVERIFIED: none")}'`,
      `  exit 0;; esac; done`,
      `echo x > x.txt`,
      `printf '%s\n' '${thinkingOnlyLine("almost done", { output: 5 })}'`,
    ].join("\n"),
  );
  try {
    const runner = new LoopRunner(repo, "dry", defaultConfig(), "main");
    assert.equal((await runner.tick()).result, "changed");
    const message = sh(repo, "git", "log", "-1", "--format=%B");
    assert.match(message, /^tumwater\(dry\): Add the x marker file\n/);
    assert.match(message, /WHY: the harness needed a fixture/);
    const runs = fs.readFileSync(argsFile, "utf8").trim().split("\n");
    // Author run (fresh), follow-up (--continue), reviewer (fresh): the follow-up is the only
    // continuation, so the model sees its own work rather than a cold prompt.
    assert.equal(runs.filter((r) => r.includes("--continue")).length, 1, JSON.stringify(runs));
    const warnings = readEvents(repo).filter((e) => e.type === "warning").map((e) => String(e.message));
    assert.ok(warnings.some((w) => /recovered it with a follow-up turn/.test(w)), JSON.stringify(warnings));
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
    const runner = new LoopRunner(repo, "improve", defaultConfig(), "main", controller.signal);
    const before = sh(repo, "git", "rev-parse", "main");
    setTimeout(() => controller.abort(), 300);
    const outcome = await runner.tick();
    assert.equal(outcome.result, "aborted");
    assert.equal(sh(repo, "git", "rev-parse", "main"), before, "nothing lands on main");
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
    const runner = new LoopRunner(repo, "improve", defaultConfig(), "main", controller.signal);
    // Abort only once the half-done edit has landed: a fixed timer can fire before the
    // fake pi even starts under parallel load, leaving no edits for the resume to keep.
    const tick = runner.tick();
    try {
      await waitForFile(path.join(worktreePath(repo, "improve"), "partial.txt"));
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
        `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
        `flags=""`,
        `for a in "$@"; do case "$a" in --continue|-n) flags="$flags $a";; esac; done`,
        `echo "run:$flags" >> "${argsFile}"`,
        `printf '%s\n' '${assistantLine("done\nSUMMARY: finish the partial work")}'`,
      ].join("\n"),
    );
    const resumed = new LoopRunner(repo, "improve", defaultConfig(), "main");
    assert.equal(resumed.state.resumePending, true, "the flag survives the restart");
    const outcome = await resumed.tick();
    assert.equal(outcome.result, "changed");
    const run = fs.readFileSync(argsFile, "utf8").trim();
    assert.ok(run.includes("--continue"), "the resume continues the interrupted session");
    assert.ok(!run.includes(" -n"), "no fresh session is started");
    assert.ok(fs.existsSync(path.join(repo, "partial.txt")), "the interrupted edits landed on main");
    assert.equal(resumed.state.resumePending, false, "the flag is consumed");
    assert.equal(readEvents(repo).filter((e) => e.type === "resume").length, 1);
  } finally {
    restore();
  }
});

test("resume falls back to a fresh tick when there is no session to continue", async () => {
  const repo = await initializedRepo();
  const argsFile = path.join(tmpdir(), "argv.log");
  const restore = fakePi(
    [
      `flags=""`,
      `for a in "$@"; do case "$a" in --continue|-n) flags="$flags $a";; esac; done`,
      `echo "run:$flags" >> "${argsFile}"`,
      `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
    ].join("\n"),
  );
  try {
    const runner = new LoopRunner(repo, "improve", defaultConfig(), "main");
    runner.state.resumePending = true; // e.g. the sessions were pruned since the abort
    assert.equal((await runner.tick()).result, "no_change");
    const run = fs.readFileSync(argsFile, "utf8").trim();
    assert.ok(!run.includes("--continue"), "nothing to resume: a fresh session is started");
    assert.ok(run.includes(" -n"));
    assert.equal(runner.state.resumePending, false, "the flag is still consumed");
    assert.equal(readEvents(repo).filter((e) => e.type === "resume").length, 0);
  } finally {
    restore();
  }
});

test("a crashed process (stale running flag) resumes like a graceful abort", async () => {
  const repo = await initializedRepo();
  const s = freshLoopState("improve");
  s.running = true; // Persisted at tick start; a crash never cleared it.
  saveLoopState(repo, s);
  const runner = new LoopRunner(repo, "improve", defaultConfig(), "main");
  assert.equal(runner.state.resumePending, true, "a crash mid-tick is resumed too");
  assert.equal(runner.state.running, false);

  // The director never resumes: its recovery is re-queuing the user prompt.
  const d = freshLoopState("director");
  d.running = true;
  saveLoopState(repo, d);
  const director = new LoopRunner(repo, "director", defaultConfig(), "main");
  assert.ok(!director.state.resumePending);
});

test("an aborted director tick re-queues the user prompt", async () => {
  const repo = await initializedRepo();
  const restore = fakePi(`exec sleep 30`);
  try {
    enqueuePrompt(repo, "important request");
    assert.equal(inboxSize(repo), 1);
    const controller = new AbortController();
    const runner = new LoopRunner(repo, "director", defaultConfig(), "main", controller.signal);
    setTimeout(() => controller.abort(), 300);
    const outcome = await runner.tick();
    assert.equal(outcome.result, "aborted");
    assert.equal(inboxSize(repo), 1, "prompt is back in the inbox");
    assert.equal(dequeuePrompt(repo), "important request");
    assert.ok(!runner.state.resumePending, "the director recovers via the re-queued prompt, not a resume");
  } finally {
    restore();
  }
});

// User-initiated abort (tumwater abort --role <id>) vs harness shutdown: both kill the pi
// child, but a deliberate stop discards the half-done work and backs off like an unproductive
// tick instead of leaving it resumable. The marker-file plumbing that reaches here is covered
// by the orchestrator tests; these pin LoopRunner's own contract (the abort plan's loop e2e
// acceptance criterion).
test("a user-aborted tick discards work, backs off, and does not resume", async () => {
  const repo = await initializedRepo();
  // Writes a half-done change, then hangs until killed. `exec` so SIGTERM reaches sleep.
  const restore = fakePi(`echo partial > partial.txt\nexec sleep 30`);
  try {
    const config = defaultConfig();
    const runner = new LoopRunner(repo, "improve", config, "main");
    const before = sh(repo, "git", "rev-parse", "main");
    const tick = runner.tick();
    // Abort only once the half-done edit has landed: a fixed timer can fire before the
    // fake pi even starts under parallel load.
    try {
      await waitForFile(path.join(worktreePath(repo, "improve"), "partial.txt"));
    } catch (err) {
      runner.abortTick(); // don't leave the hung fake pi running after a wait timeout
      throw err;
    }
    runner.abortTick();
    const outcome = await tick;
    assert.equal(outcome.result, "user_aborted");

    // The work is discarded: nothing lands on main and the planted dirty file is gone from
    // the worktree (reset --hard + clean -fd), so the next tick's leftover recovery finds
    // nothing to salvage.
    assert.equal(sh(repo, "git", "rev-parse", "main"), before, "nothing lands on main");
    const wt = worktreePath(repo, "improve");
    assert.ok(!fs.existsSync(path.join(wt, "partial.txt")), "the half-done edit is discarded");
    assert.equal(sh(wt, "git", "status", "--porcelain"), "", "no uncommitted edits remain");

    // A deliberate stop is not an interruption: no resume flag, and the loop backs off like
    // an unproductive tick instead of retrying immediately.
    const s = loadLoopState(repo, "improve");
    assert.ok(!s.resumePending, "nothing to resume — the work was discarded");
    assert.equal(s.backoffSeconds, config.idleBackoff.initialSeconds);
    assert.ok(s.nextRunAt > Date.now(), "backed off, not immediate");

    // The outcome is observable in the event feed.
    const ends = readEvents(repo).filter((e) => e.type === "tick_end");
    assert.equal(ends.length, 1);
    assert.equal(ends[0]?.result, "user_aborted");
  } finally {
    restore();
  }
});

test("a user-aborted director tick drops the prompt instead of re-queueing it", async () => {
  const repo = await initializedRepo();
  // Hangs until killed; writes a marker first so the test can wait for the run to be in flight.
  const restore = fakePi(`echo partial > partial.txt\nexec sleep 30`);
  try {
    enqueuePrompt(repo, "important request");
    assert.equal(inboxSize(repo), 1);
    const runner = new LoopRunner(repo, "director", defaultConfig(), "main");
    const tick = runner.tick();
    try {
      await waitForFile(path.join(worktreePath(repo, "director"), "partial.txt"));
    } catch (err) {
      runner.abortTick(); // don't leave the hung fake pi running after a wait timeout
      throw err;
    }
    runner.abortTick();
    const outcome = await tick;
    assert.equal(outcome.result, "user_aborted");

    // Contrast with a shutdown abort (which re-queues): an explicit stop IS the answer to
    // that request — the prompt is deliberately dropped, not retried.
    assert.equal(inboxSize(repo), 0, "the aborted prompt was not re-queued");
    const s = loadLoopState(repo, "director");
    assert.ok(!s.resumePending, "the director never resumes an author session");

    // The discard is explicit, not accidental: the dequeued prompt is cleared on the live
    // runner (item (a)) rather than left to be overwritten by the next tick's dequeue.
    assert.equal(
      (runner as unknown as { pendingUserPrompt: string | null }).pendingUserPrompt,
      null,
      "the dequeued prompt was discarded from the runner",
    );
  } finally {
    restore();
  }
});

test("a user-abort mid-review discards the committed work too", async () => {
  const repo = await initializedRepo();
  // Author run (the tick prompt): make a change and finish. Review run (its prompt contains
  // VERDICT): hang until the abort kills it — simulating `tumwater abort` while under review.
  const restore = fakePi(
    [
      `for a in "$@"; do case "$a" in *"VERDICT:"*) exec sleep 30;; esac; done`,
      `printf '%s\n' '${assistantLine("done\nSUMMARY: add hello file")}'`,
      `echo hello > hello.txt`,
    ].join("\n"),
  );
  try {
    enqueuePrompt(repo, "ship the hello file");
    const runner = new LoopRunner(repo, "director", defaultConfig(), "main");
    const tick = runner.tick();
    // Abort only once the author run has committed (branch ahead of main): an earlier abort
    // would hit the author-run path instead of the review gate.
    await waitForAhead(repo, "tumwater/director");
    runner.abortTick();
    const outcome = await tick;
    assert.equal(outcome.result, "user_aborted", "a mid-review user abort is an abort, not a failed review");

    // Unlike a shutdown (which fails closed and keeps the commit for re-review), a deliberate
    // stop discards it: resetWorktreeToMain drops the unmerged commit too.
    assert.equal(sh(repo, "git", "rev-list", "--count", "main..tumwater/director"), "0");
    assert.ok(!fs.existsSync(path.join(repo, "hello.txt")), "nothing landed on main");

    // And like the author-run branch: no re-queue of the unfulfilled prompt.
    assert.equal(inboxSize(repo), 0, "the aborted prompt was not re-queued");
    const s = loadLoopState(repo, "director");
    assert.ok(!s.resumePending);
    assert.ok(s.nextRunAt > Date.now(), "backed off, not immediate");
  } finally {
    restore();
  }
});

test("a failing director tick re-queues the user prompt (regression)", async () => {
  const repo = await initializedRepo();
  // pi fails hard: non-zero exit, no assistant text, and no file changes.
  const restore = fakePi(`echo 'pi exploded' >&2\nexit 1`);
  try {
    enqueuePrompt(repo, "please do the thing");
    const runner = new LoopRunner(repo, "director", defaultConfig(), "main");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "error");
    assert.equal(inboxSize(repo), 1, "the unfulfilled prompt is back in the inbox");
    assert.equal(dequeuePrompt(repo), "please do the thing");
  } finally {
    restore();
  }
});

test("a timed-out director tick re-queues the user prompt (regression)", async () => {
  const repo = await initializedRepo();
  const restore = fakePi(`exec sleep 30`);
  try {
    enqueuePrompt(repo, "important request");
    const config = defaultConfig();
    config.tickTimeoutSeconds = 1;
    const runner = new LoopRunner(repo, "director", config, "main");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "error");
    assert.match(runner.state.lastError ?? "", /timed out/);
    assert.equal(inboxSize(repo), 1, "the unfulfilled prompt is back in the inbox");
    assert.equal(dequeuePrompt(repo), "important request");
  } finally {
    restore();
  }
});

test("a director tick that handles a prompt with no file changes does not re-queue it", async () => {
  const repo = await initializedRepo();
  // pi answers the question in its reply and changes nothing: that IS fulfillment.
  const restore = fakePi(`printf '%s\n' '${assistantLine("The answer is 42.")}'`);
  try {
    enqueuePrompt(repo, "what is the answer?");
    const runner = new LoopRunner(repo, "director", defaultConfig(), "main");
    assert.equal((await runner.tick()).result, "no_change");
    assert.equal(inboxSize(repo), 0, "a handled prompt must not loop back into the inbox");
  } finally {
    restore();
  }
});

test("a timed-out tick reports an error and never commits partial work", async () => {
  const repo = await initializedRepo();
  const restore = fakePi(`echo partial > partial.txt\nexec sleep 30`);
  try {
    const config = defaultConfig();
    config.tickTimeoutSeconds = 1;
    const runner = new LoopRunner(repo, "improve", config, "main");
    const before = sh(repo, "git", "rev-parse", "main");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "error");
    assert.match(runner.state.lastError ?? "", /timed out/);
    assert.equal(sh(repo, "git", "rev-parse", "main"), before);
    assert.ok(runner.state.backoffSeconds > 0);
  } finally {
    restore();
  }
});

test("a rebase conflict is resolved by a second pi run and lands with linear history", async () => {
  const repo = await initializedRepo();
  const marker = path.join(tmpdir(), "phase");
  // Phase 1 (the tick): edit seed.txt on the branch AND advance main with a conflicting
  // edit. Phase 2 (the resolution run): replace the conflict markers with a resolution.
  const restore = fakePi(
    [
      // The tick's commit goes through the review gate before the (conflicting) merge.
      `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
      `if [ ! -f "${marker}" ]; then`,
      `  touch "${marker}"`,
      `  printf '%s\n' '${assistantLine("ok\nSUMMARY: branch edit of seed")}'`,
      `  echo branch change > seed.txt`,
      `  echo main change > "${repo}/seed.txt"`,
      `  git -C "${repo}" -c user.name=t -c user.email=t@t commit -am "conflicting main edit"`,
      `else`,
      // The resolution run emits two assistant turns on purpose (plans/commit-bodies.md
      // item c): if it leaked into the trailer's count, the Tick line below would read
      // turns 3 instead of turns 1.
      `  printf '%s\\n' '${assistantLine("looking at the conflict markers")}'`,
      `  printf '%s\\n' '${assistantLine("resolved\nSUMMARY: merged both sides")}'`,
      `  echo resolved > seed.txt`,
      `fi`,
    ].join("\n"),
  );
  try {
    const runner = new LoopRunner(repo, "improve", defaultConfig(), "main");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "changed");
    assert.equal(fs.readFileSync(path.join(repo, "seed.txt"), "utf8"), "resolved\n");
    // The resolution landed as a plain rebased commit: no merge commits on main.
    assert.equal(sh(repo, "git", "log", "--merges", "--oneline"), "", "main's history stays linear");
    // Self-explaining commit bodies (plans/commit-bodies.md item c): the trailer counts
    // only the authoring run's turns — the reviewer and conflict-resolution runs fold into
    // tickTurns after the trailer string is already assembled.
    const body = sh(repo, "git", "log", "-1", "--format=%B");
    assert.match(body, /^Tick: improve #\d+ · turns 1 · ctx 0$/m);
    // Routine conflict → pi-resolve → land is normal operation, not something to warn
    // about: the merged event and tick_end already cover observability.
    const warnings = readEvents(repo).filter((e) => e.type === "warning");
    assert.equal(
      warnings.length,
      0,
      `expected no warning events, got: ${JSON.stringify(warnings.map((w) => w.message))}`,
    );
  } finally {
    restore();
  }
});

test("an unresolvable conflict aborts cleanly and reports merge_conflict", async () => {
  const repo = await initializedRepo();
  const marker = path.join(tmpdir(), "phase");
  const restore = fakePi(
    [
      // The tick's commit goes through the review gate before the (conflicting) merge.
      `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
      `if [ ! -f "${marker}" ]; then`,
      `  touch "${marker}"`,
      `  printf '%s\n' '${assistantLine("ok\nSUMMARY: branch edit of seed")}'`,
      `  echo branch change > seed.txt`,
      `  echo main change > "${repo}/seed.txt"`,
      `  git -C "${repo}" -c user.name=t -c user.email=t@t commit -am "conflicting main edit"`,
      `fi`, // Phase 2 does nothing: the conflict markers stay.
    ].join("\n"),
  );
  try {
    const runner = new LoopRunner(repo, "improve", defaultConfig(), "main");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "merge_conflict");
    assert.equal(fs.readFileSync(path.join(repo, "seed.txt"), "utf8"), "main change\n", "main keeps its version");
    const wt = path.join(repo, ".tumwater/worktrees/improve");
    assert.ok(!sh(wt, "git", "status", "--porcelain").includes("UU"));
    // No rebase is left in progress: the branch ref is checked out again (mid-rebase HEAD
    // would be detached).
    assert.equal(sh(wt, "git", "symbolic-ref", "--short", "HEAD"), "tumwater/improve");
  } finally {
    restore();
  }
});

// A pi that commits during the tick (forbidden by the prompt, but a confused pi might do it)
// leaves an extra commit under the harness's own commit. When the merge's rebase stops on
// the stray one and the resolution run ALSO commits its resolution, `rebase --continue`
// replays the remaining authoring commit onto that stray commit, hits a SECOND conflict,
// and throws — merge.ts's catch must abort cleanly and report merge_conflict instead of
// crashing or landing broken work (the only path that reaches it; see continueRebase's doc
// comment). Phase detection in the shim: reviewer runs carry VERDICT:, resolution runs find
// conflict markers in seed.txt, everything else is the authoring run.
test("a stray pi commit makes rebase --continue stop a second time: aborted, merge_conflict", async () => {
  const repo = await initializedRepo();
  const restore = fakePi(
    [
      // The tick's commit goes through the review gate before the (conflicting) merge.
      `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
      // Phase 2 (the resolution run): seed.txt carries conflict markers — resolve them, then
      // commit anyway. That stray commit is what `rebase --continue` replays the remaining
      // authoring commit onto.
      `if grep -q '<<<<<<<' seed.txt 2>/dev/null; then`,
      `  echo resolved > seed.txt`,
      `  git add -A && git commit -m "stray resolver commit"`,
      `else`,
      // Phase 1 (the tick): pi commits its first edit itself (a stray commit the harness
      // never reviewed as such), then leaves a second edit uncommitted — the harness's
      // commitAll lands it on top, so the branch is two commits ahead of main. Main advances
      // with an edit that conflicts with the STRAY one, so the rebase stops there first.
      `  echo branch change 1 > seed.txt`,
      `  git add -A && git commit -m "stray authoring commit"`,
      `  echo branch change 2 > seed.txt`,
      `  printf '%s\n' '${assistantLine("ok\nSUMMARY: branch edit of seed")}'`,
      `  echo main change > "${repo}/seed.txt"`,
      `  git -C "${repo}" -c user.name=t -c user.email=t@t commit -am "conflicting main edit"`,
      `fi`,
    ].join("\n"),
  );
  try {
    const runner = new LoopRunner(repo, "improve", defaultConfig(), "main");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "merge_conflict", "the second conflict is reported, not crashed on");
    // Nothing landed: main keeps its version…
    assert.equal(fs.readFileSync(path.join(repo, "seed.txt"), "utf8"), "main change\n", "main keeps its version");
    // …and both of the tick's commits stay stranded on the branch for the next tick's
    // recovery, exactly like any other failed merge.
    assert.equal(sh(repo, "git", "rev-list", "--count", "main..tumwater/improve"), "2", "the tick's commits are kept for recovery");
    const wt = path.join(repo, ".tumwater/worktrees/improve");
    // No rebase is left in progress: the branch ref is checked out again (mid-rebase HEAD
    // would be detached), and no conflict markers survive.
    assert.equal(sh(wt, "git", "symbolic-ref", "--short", "HEAD"), "tumwater/improve");
    assert.ok(!sh(wt, "git", "status", "--porcelain").includes("UU"));
  } finally {
    restore();
  }
});

test("a dirty primary checkout blocks the fast-forward: merge_blocked, commit kept for recovery", async () => {
  const repo = await initializedRepo();
  // The user has uncommitted edits to seed.txt in the PRIMARY checkout (on main). The tick's
  // branch changes the same file, so `git merge --ff-only` must refuse to overwrite the local
  // edit — the one way ffMainTo fails after a clean rebase. A broken failure path here
  // would either clobber the user's work or report "changed" for work that never landed.
  const restore = fakePi(
    [
      // The review gate (any run whose prompt asks for a VERDICT) approves, so the tick reaches
      // the merge and can be blocked there.
      `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
      `printf '%s\n' '${assistantLine("ok\nSUMMARY: branch edit of seed")}'`,
      `echo branch change > seed.txt`,
    ].join("\n"),
  );
  try {
    fs.writeFileSync(path.join(repo, "seed.txt"), "user's uncommitted edit\n");
    const runner = new LoopRunner(repo, "improve", defaultConfig(), "main");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "merge_blocked");
    // The user's local edit survives — the blocked merge must not touch it.
    assert.equal(fs.readFileSync(path.join(repo, "seed.txt"), "utf8"), "user's uncommitted edit\n");
    // main did not move; the tick's commit stays on the branch for the next tick's recovery.
    assert.equal(sh(repo, "git", "rev-list", "--count", "main..tumwater/improve"), "1");
    assert.match(sh(repo, "git", "show", "main:seed.txt"), /^seed$/);
    // The failure is recorded and the loop backs off like any other error.
    assert.equal(runner.state.lastError, "merge failed: merge_blocked");
    assert.ok(runner.state.backoffSeconds > 0);
    assert.ok(runner.state.nextRunAt > Date.now());
  } finally {
    restore();
  }
});

test("leftover commits from a failed merge are recovered on the next tick", async () => {
  const repo = await initializedRepo();
  const m1 = path.join(tmpdir(), "phase1");
  const m2 = path.join(tmpdir(), "phase2");
  // Phase 0 (any run whose prompt asks for a VERDICT — the review gate, which recovery
  // now routes through): approve, so the leftover may land. Phase 1 (tick 1): edit
  // seed.txt on the branch AND advance main with a conflicting edit. Phase 2 (tick 1's
  // resolution run): leave the markers — the merge fails and the tick's commit is left
  // stranded on the branch. Phase 3 (tick 2's recovery run): resolve them this time.
  // Phase 4 (tick 2's own tick): nothing to do.
  const restore = fakePi(
    [
      `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\n' '${assistantLine("VERDICT: approve\n1. checked the diff; it holds")}'; exit 0;; esac; done`,
      `if [ ! -f "${m1}" ]; then`,
      `  touch "${m1}"`,
      `  printf '%s\n' '${assistantLine("ok\nSUMMARY: branch edit of seed")}'`,
      `  echo branch change > seed.txt`,
      `  echo main change > "${repo}/seed.txt"`,
      `  git -C "${repo}" -c user.name=t -c user.email=t@t commit -am "conflicting main edit"`,
      `elif [ ! -f "${m2}" ]; then`,
      `  touch "${m2}"`, // Unresolvable on the first attempt.
      `else`,
      `  if grep -q '<<<<<<<' seed.txt 2>/dev/null; then echo resolved > seed.txt`,
      `  else printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'; fi`,
      `fi`,
    ].join("\n"),
  );
  try {
    const runner = new LoopRunner(repo, "improve", defaultConfig(), "main");
    assert.equal((await runner.tick()).result, "merge_conflict");
    // The tick's commit is stranded on the branch: that is what recovery must salvage.
    assert.equal(sh(repo, "git", "rev-list", "--count", "main..tumwater/improve"), "1");

    const second = await runner.tick();
    assert.equal(second.result, "no_change", "tick 2 itself found nothing to do");
    // The stranded work landed on main via recovery.
    assert.equal(fs.readFileSync(path.join(repo, "seed.txt"), "utf8"), "resolved\n");
    const merged = readEvents(repo).filter((e) => e.type === "merged");
    assert.ok(
      merged.some((e) => String(e.summary) === "recovered leftover work from improve"),
      "recovery is recorded as a merge of the leftover work",
    );
    // The branch is reset to main afterwards, so nothing is stranded twice.
    assert.equal(sh(repo, "git", "rev-list", "--count", "main..tumwater/improve"), "0");
  } finally {
    restore();
  }
});

test("unmergeable leftover commits are discarded with a warning on the next tick", async () => {
  const repo = await initializedRepo();
  const m1 = path.join(tmpdir(), "phase1");
  // Phase 0 (any run whose prompt asks for a VERDICT — the review gate, which recovery
  // now routes through): approve, so recovery reaches the merge and can fail there. Phase
  // 1 (tick 1): branch edit + conflicting main advance. Every conflict-resolution run
  // (detected by markers in seed.txt) leaves the markers: unresolvable, both ticks.
  const restore = fakePi(
    [
      `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\n' '${assistantLine("VERDICT: approve\n1. checked the diff; it holds")}'; exit 0;; esac; done`,
      `if [ ! -f "${m1}" ]; then`,
      `  touch "${m1}"`,
      `  printf '%s\n' '${assistantLine("ok\nSUMMARY: branch edit of seed")}'`,
      `  echo branch change > seed.txt`,
      `  echo main change > "${repo}/seed.txt"`,
      `  git -C "${repo}" -c user.name=t -c user.email=t@t commit -am "conflicting main edit"`,
      `elif grep -q '<<<<<<<' seed.txt 2>/dev/null; then`,
      `  : # leave the markers in place (unresolvable)`,
      `else`,
      `  printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
      `fi`,
    ].join("\n"),
  );
  try {
    const runner = new LoopRunner(repo, "improve", defaultConfig(), "main");
    assert.equal((await runner.tick()).result, "merge_conflict");
    assert.equal((await runner.tick()).result, "no_change");

    // Recovery gave up: the discard is warned about and main keeps its version.
    const warnings = readEvents(repo).filter((e) => e.type === "warning").map((e) => String(e.message));
    assert.ok(
      warnings.some((w) => /discarding 1 unmergeable leftover commit\(s\) \(merge_conflict\)/.test(w)),
      `expected a discard warning, got: ${JSON.stringify(warnings)}`,
    );
    assert.equal(fs.readFileSync(path.join(repo, "seed.txt"), "utf8"), "main change\n");
    // The stranded commit is gone (reset to main), so it cannot resurface on tick 3.
    assert.equal(sh(repo, "git", "rev-list", "--count", "main..tumwater/improve"), "0");
  } finally {
    restore();
  }
});

test("a failed recovery review keeps its commit on the branch for re-review", async () => {
  const repo = await initializedRepo();
  const m1 = path.join(tmpdir(), "phase1");
  // Phase 0 (any run whose prompt asks for a VERDICT — the review gate): reply without a
  // VERDICT line, failing closed under the strike cap both times, and leave an untracked
  // stray file in the worktree. Phase 1 (tick 1): edit seed.txt on the branch — its commit
  // is stranded when the tick's own review fails. Phase 2 (tick 2's own tick): nothing to do.
  const restore = fakePi(
    [
      `for a in "$@"; do case "$a" in *"VERDICT:"*)`,
      `  touch stray.txt`,
      `  printf '%s\n' '${assistantLine("I think this is fine overall.")}'`,
      `  exit 0;; esac; done`,
      `if [ ! -f "${m1}" ]; then`,
      `  touch "${m1}"`,
      `  printf '%s\n' '${assistantLine("ok\nSUMMARY: branch edit of seed")}'`,
      `  echo branch change > seed.txt`,
      `else`,
      `  printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
      `fi`,
    ].join("\n"),
  );
  try {
    const runner = new LoopRunner(repo, "improve", defaultConfig(), "main");
    assert.equal((await runner.tick()).result, "review_error");
    // The tick's commit is stranded on the branch; its recovery review will fail too.
    assert.equal(sh(repo, "git", "rev-list", "--count", "main..tumwater/improve"), "1");

    const second = await runner.tick();
    assert.equal(second.result, "no_change", "tick 2 itself found nothing to do");

    // The failed recovery review (under the strike cap) deliberately left its commit on
    // the branch for re-review — a plain reset-to-main would have discarded it. This is
    // tick()'s left-for-retry path: reset --hard HEAD + clean -fd keep the commit but drop
    // uncommitted strays (regression: this path once called git() without importing it,
    // erroring every such tick and breaking the build).
    assert.equal(sh(repo, "git", "rev-list", "--count", "main..tumwater/improve"), "1");
    const wt = worktreePath(repo, "improve");
    assert.ok(!fs.existsSync(path.join(wt, "stray.txt")), "the stray untracked file is cleaned");
    assert.equal(sh(wt, "git", "status", "--porcelain"), "", "no uncommitted edits remain");
    const failed = readEvents(repo).filter((e) => e.type === "review_failed");
    assert.ok(
      failed.some((e) => /no parseable VERDICT/.test(String(e.message))),
      `expected a verdict-less review failure, got: ${JSON.stringify(failed)}`,
    );
  } finally {
    restore();
  }
});

test("a shutdown mid-review fails closed: commit stays on the branch and the prompt is re-queued", async () => {
  const repo = await initializedRepo();
  // Author run (the tick prompt): make a change and finish. Review run (its prompt contains
  // VERDICT): hang until the abort kills it — simulating Ctrl+C while under review.
  const restore = fakePi(
    [
      `for a in "$@"; do case "$a" in *"VERDICT:"*) exec sleep 30;; esac; done`,
      `printf '%s\n' '${assistantLine("done\nSUMMARY: add hello file")}'`,
      `echo hello > hello.txt`,
    ].join("\n"),
  );
  const controller = new AbortController();
  try {
    enqueuePrompt(repo, "ship the hello file");
    const runner = new LoopRunner(repo, "director", defaultConfig(), "main", controller.signal);
    const tick = runner.tick();
    // Abort only once the author run has committed (branch ahead of main): an earlier abort
    // would hit the author-run path instead of the review gate.
    await waitForAhead(repo, "tumwater/director");
    controller.abort();
    const outcome = await tick;
    assert.equal(outcome.result, "aborted", "a mid-review shutdown is an abort, not a failed review");

    // Fail closed: nothing merged — the commit stays on the branch for re-review.
    assert.equal(sh(repo, "git", "rev-list", "--count", "main..tumwater/director"), "1");
    assert.ok(!fs.existsSync(path.join(repo, "hello.txt")), "nothing landed on main");

    // The unfulfilled director prompt goes back in the inbox: the director recovers via the
    // re-queued prompt (a fresh run), not a session resume.
    assert.equal(inboxSize(repo), 1);
    assert.equal(dequeuePrompt(repo), "ship the hello file");
    assert.ok(!runner.state.resumePending, "the director does not resume an author session");

    // phase="review" survives to disk: on the next launch runTick must re-review the
    // committed work fresh instead of resuming an author session whose task is already
    // committed (a regression that cleared it would also misreport the tick as a failed
    // review with backoff instead of a prompt-resume).
    const s = loadLoopState(repo, "director");
    assert.equal(s.phase, "review", "the review phase marker survives the abort");
    assert.ok(s.nextRunAt <= Date.now(), "resumes promptly on restart");
  } finally {
    // Kill any in-flight fake pi BEFORE PATH is restored: an orphaned run spawned after
    // restore would resolve `pi` to a later test's fake (or the real one) and corrupt it.
    controller.abort();
    restore();
  }
});

test("a rejected change rides along on the role's next tick prompt with its reasons", async () => {
  const repo = await initializedRepo();
  // The reviewer (any run whose prompt asks for a VERDICT) rejects with two numbered
  // reasons. Author runs record their full argv — the prompt is pi's last argument — so
  // the test can assert what each tick was actually told, not just that state changed.
  const promptsFile = path.join(tmpdir(), "prompts.log");
  const marker = path.join(tmpdir(), "changed-once");
  const restore = fakePi(
    [
      `for a in "$@"; do case "$a" in *"VERDICT:"*)`,
      `  printf '%s\n' '${assistantLine("VERDICT: reject\n1. breaks the zero-dep rule\n2. no regression test")}'`,
      `  exit 0;; esac; done`,
      `{ printf '%s\n' "$@"; echo "===RUN==="; } >> "${promptsFile}"`,
      `if [ ! -f "${marker}" ]; then`,
      `  touch "${marker}"`,
      `  printf '%s\n' '${assistantLine("did it\nSUMMARY: add rejected thing")}'`,
      `  echo bad > rejected.txt`,
      `else`,
      `  printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
      `fi`,
    ].join("\n"),
  );
  try {
    const runner = new LoopRunner(repo, "improve", defaultConfig(), "main");
    // Tick 1: the change is committed, then rejected — nothing lands on main.
    assert.equal((await runner.tick()).result, "rejected");
    assert.equal(sh(repo, "git", "rev-list", "--count", "main..tumwater/improve"), "0");
    assert.ok(!fs.existsSync(path.join(repo, "rejected.txt")), "the rejected change did not merge");

    // Tick 2: the rejection is the only cross-tick memory — every tick starts a fresh pi
    // session, so its full reasons must ride along on this tick's prompt.
    assert.equal((await runner.tick()).result, "no_change");
    const runs = fs.readFileSync(promptsFile, "utf8").split("===RUN===").filter((b) => b.trim());
    assert.equal(runs.length, 2, "exactly two author runs were recorded");
    assert.ok(!runs[0]?.includes("rejected in review"), "tick 1's prompt had no rejection note yet");
    const second = runs[1] ?? "";
    assert.match(second, /Your previous change was rejected in review:/);
    assert.match(second, /1\. breaks the zero-dep rule/);
    assert.match(second, /2\. no regression test/);
    assert.match(second, /Address the objections or take a different approach\./);
  } finally {
    restore();
  }
});

test("concurrent-main-advance still lands (rebase path, linear history)", async () => {
  const repo = await initializedRepo();
  // The fake pi advances main itself mid-tick, simulating another loop landing work.
  const restore = fakePi(
    [
      // The tick's commit goes through the review gate before the (rebased) merge.
      `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
      `printf '%s\n' '${assistantLine("ok\nSUMMARY: slow work")}'`,
      `echo slow > slow.txt`,
      `git -C "${repo}" -c user.name=t -c user.email=t@t commit --allow-empty -m "someone else"`,
    ].join("\n"),
  );
  try {
    const runner = new LoopRunner(repo, "organize", defaultConfig(), "main");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "changed");
    assert.ok(fs.existsSync(path.join(repo, "slow.txt")));
    // The tick's commit was rebased onto the concurrent main advance: no merge commits.
    assert.equal(sh(repo, "git", "log", "--merges", "--oneline"), "", "main's history stays linear");
  } finally {
    restore();
  }
});

test("a clean resolution of a conflicted file with setext underlines lands (regression)", async () => {
  const repo = await initializedRepo();
  // docs.md uses a setext heading whose underline is exactly seven '=' — legitimate content
  // that the old marker check mistook for an unresolved conflict separator.
  fs.writeFileSync(path.join(repo, "docs.md"), "History\n=======\n\nFirst entry.\n");
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "docs with setext heading");
  const marker = path.join(tmpdir(), "phase");
  // Phase 1 (the tick): both sides edit the same line. Phase 2 (the resolution run):
  // combine them, keeping the setext underline — no real conflict markers remain.
  const restore = fakePi(
    [
      `if [ ! -f "${marker}" ]; then`,
      `  touch "${marker}"`,
      `  printf '%s\n' '${assistantLine("ok\nSUMMARY: branch docs edit")}'`,
      `  printf 'History\\n=======\\n\\nBranch entry.\\n' > docs.md`,
      `  printf 'History\\n=======\\n\\nMain entry.\\n' > "${repo}/docs.md"`,
      `  git -C "${repo}" -c user.name=t -c user.email=t@t commit -am "conflicting main docs edit"`,
      `else`,
      `  printf 'History\\n=======\\n\\nBranch entry.\\nMain entry.\\n' > docs.md`,
      `fi`,
    ].join("\n"),
  );
  try {
    const runner = new LoopRunner(repo, "improve", defaultConfig(), "main");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "changed", "a clean resolution must not be rejected as conflicted");
    assert.equal(
      fs.readFileSync(path.join(repo, "docs.md"), "utf8"),
      "History\n=======\n\nBranch entry.\nMain entry.\n",
    );
  } finally {
    restore();
  }
});

test("a transient model-server timeout is retried once and the tick succeeds (regression)", async () => {
  const repo = await initializedRepo();
  const marker = path.join(tmpdir(), "phase");
  // Attempt 1 (the tick's pi run): LM Studio kills an idle predict stream after a machine
  // sleep. Attempt 2 (the harness retry, detected by the phase file): a fresh request
  // succeeds within seconds of the wake.
  const restore = fakePi(
    [
      `if [ ! -f "${marker}" ]; then`,
      `  touch "${marker}"`,
      `  printf '%s\n' '${errorLine("Engine protocol predict stream timed out after 600000ms without receiving data.")}'`,
      `  exit 1`,
      `else`,
      `  printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
      `fi`,
    ].join("\n"),
  );
  try {
    const runner = new LoopRunner(repo, "clean", defaultConfig(), "main");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "no_change", "the retry's verdict stands in for the tick");
    assert.ok(!runner.state.lastError);
    const warnings = readEvents(repo).filter((e) => e.type === "warning").map((e) => String(e.message));
    assert.ok(
      warnings.some((w) => /retrying the pi run once/.test(w)),
      `expected a retry warning, got: ${JSON.stringify(warnings)}`,
    );
  } finally {
    restore();
  }
});

// Self-explaining commit bodies (plans/commit-bodies.md item b): the trailer's turn count is
// the sum over this tick's PRE-COMMIT runs — main attempt plus, on a transient model-server
// timeout, the one resumed retry. runRolePi folds both into tickTurns via foldUsage before
// buildCommitMessage assembles the trailer, so a retried CHANGED tick's commit must read the
// combined count (the no_change regression above never commits, so its trailer is unobservable).
test("a transient-retry changed tick's trailer sums both runs' turns", async () => {
  const repo = await initializedRepo();
  const marker = path.join(tmpdir(), "phase");
  // Attempt 1 (the tick's pi run): two assistant turns of work, then LM Studio kills the
  // idle predict stream — a failed run with transientServerTimeout set. The errored final
  // message is itself an assistant message_end, so attempt 1 counts as THREE turns. Attempt
  // 2 (the harness retry, detected by the phase file): one more turn that finishes the work.
  const restore = fakePi(
    [
      `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
      `if [ ! -f "${marker}" ]; then`,
      `  touch "${marker}"`,
      `  printf '%s\\n' '${assistantLine("first turn of work")}'`,
      `  printf '%s\\n' '${assistantLine("second turn, still working")}'`,
      `  printf '%s\\n' '${errorLine("Engine protocol predict stream timed out after 600000ms without receiving data.")}'`,
      `  exit 1`,
      `else`,
      `  printf '%s\\n' '${assistantLine("done\nSUMMARY: add hello file", { tokens: 42, output: 42, cost: 0.05 })}'`,
      `  echo hello > hello.txt`,
      `fi`,
    ].join("\n"),
  );
  try {
    const runner = new LoopRunner(repo, "improve", defaultConfig(), "main");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "changed", "the retry's work lands the tick");
    // The trailer sums both runs' turns (3 + 1) — and only them: the reviewer run folds
    // after the commit. Peak ctx is the retry run's 42; attempt 1 carried no usage.
    const body = sh(repo, "git", "log", "-1", "--format=%B");
    assert.match(body, /^Tick: improve #\d+ · turns 4 · ctx 42$/m);
  } finally {
    restore();
  }
});
