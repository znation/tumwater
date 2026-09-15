import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { LoopRunner } from "../src/loop.js";
import { initProject } from "../src/init.js";
import { defaultConfig } from "../src/config.js";
import { dequeuePrompt, enqueuePrompt, inboxSize } from "../src/inbox.js";
import { readEvents } from "../src/events.js";
import { setRef } from "../src/git.js";
import { freshLoopState, loadLoopState, saveLoopState } from "../src/state.js";
import { landingRefName, sessionDir, worktreePath } from "../src/paths.js";
import { ensureWorktree } from "../src/worktree.js";
import { headLanding, queueDepth } from "../src/land-queue.js";
import { landQueuedEntry } from "../src/orchestrator.js";
import { assistantLine, errorLine, fakePi, landHead, makeRepo, sh, thinkingOnlyLine, tmpdir } from "./util.js";

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

/** Poll until `ref` exists (bounded). Times an abort to land AFTER the tick's commit is
 * pinned by its landing ref and BEFORE/IN the review gate's run — a fixed sleep would race the
 * pin under parallel load. Since merge queue 2/5 the role branch resets to main immediately
 * after the pin, so "branch ahead of main" can no longer mark that window; the ref is what
 * survives it. */
async function waitForLandingRef(repo: string, role: string, timeoutMs = 10_000): Promise<string> {
  const start = Date.now();
  for (;;) {
    let sha: string | null = null;
    try {
      sha = sh(repo, "git", "rev-parse", "--verify", landingRefName(role)).trim() || null;
    } catch {
      // Ref not pinned yet — keep polling.
    }
    if (sha) return sha;
    if (Date.now() - start > timeoutMs)
      throw new Error(`timed out waiting for ${landingRefName(role)} to be pinned`);
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
    // Merge queue 3/5: the tick ends at commit + pin — the landing is the orchestrator's
    // separate serial step, and landHead drives it exactly as the drain does (the exported
    // landQueuedEntry), so the whole flow below is the production path.
    assert.equal(outcome.result, "queued");
    assert.equal(outcome.summary, "add hello file");
    assert.equal(await landHead(repo, runner, defaultConfig(), "improve"), "changed");
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
    assert.equal((await runner.tick()).result, "queued");
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
    assert.equal((await runner.tick()).result, "queued");
    // After the first completed tick + its landing the state file holds that tick's usage only.
    assert.equal(await landHead(repo, runner, defaultConfig(), "improve"), "changed");
    assert.equal(runner.state.generatedTokens, 42);
    assert.equal(runner.state.peakContextTokens, 42);
    assert.equal(loadLoopState(repo, "improve").generatedTokens, 42);

    assert.equal((await runner.tick()).result, "queued");
    assert.equal(await landHead(repo, runner, defaultConfig(), "improve"), "changed");
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
    assert.equal(outcome.result, "queued");
    assert.equal(await landHead(repo, runner, defaultConfig(), "director"), "changed");
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
    assert.equal(outcome.result, "queued");
    assert.equal(await landHead(repo, runner, defaultConfig(), "dry"), "changed");
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
    assert.equal((await runner.tick()).result, "queued");
    assert.equal(await landHead(repo, runner, defaultConfig(), "dry"), "changed");
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
    assert.equal(outcome.result, "queued");
    assert.equal(await landHead(repo, resumed, defaultConfig(), "improve"), "changed");
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

// BUGS.md 2026-09-12 (fixed 2026-09-13): a hung tool call used to land as a timeout error
// whose next-tick reset discarded the run's work. The kill must now preserve session + edits,
// resume them promptly, and name the real cause in the bridge so the session does not re-run
// the hung command unchanged.
test("a quiet-killed tick keeps its edits and resumes promptly instead of discarding", async () => {
  const repo = await initializedRepo();
  const config = defaultConfig();
  config.quietTimeoutSeconds = 2;
  const argsFile = path.join(tmpdir(), "argv.log");
  let restore = fakePi(
    [
      `echo work > kept.txt`, // half-done edit the kill must not destroy
      `printf '%s\n' '${JSON.stringify({ type: "tool_execution_start", toolName: "bash" })}'`,
      `exec sleep 30`,
    ].join("\n"),
  );
  try {
    const runner = new LoopRunner(repo, "improve", config, "main");
    const tick = runner.tick();
    // Wait for the half-done edit to land: a fixed timer can fire before the fake pi even
    // starts under parallel load. The watchdog kills the run itself — no abort controller.
    await waitForFile(path.join(worktreePath(repo, "improve"), "kept.txt"));
    assert.equal((await tick).result, "quiet_killed");
    assert.ok(
      fs.existsSync(path.join(worktreePath(repo, "improve"), "kept.txt")),
      "the edits survive the kill",
    );
    assert.equal(runner.state.resumePending, true, "the next tick resumes this one");
    assert.ok(runner.state.nextRunAt <= Date.now(), "the resume is scheduled promptly, not backed off");

    // The killed run's pi session is on disk (the fake pi writes none, so seed one).
    fs.mkdirSync(sessionDir(repo, "improve"), { recursive: true });
    fs.writeFileSync(path.join(sessionDir(repo, "improve"), "interrupted.jsonl"), "{}\n");

    // Next launch resumes the session and finishes the task; the bridge names the hang
    // watchdog. If it did not (regression), the fake pi stalls again and the assertions fail.
    restore = fakePi(
      [
        `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
        `flags=""`,
        `for a in "$@"; do case "$a" in --continue|-n) flags="$flags $a";; esac; done`,
        `echo "run:$flags" >> "${argsFile}"`,
        `for a in "$@"; do case "$a" in *"hang watchdog"*) printf '%s\n' '${assistantLine("done\nSUMMARY: finish the partial work")}'; exit 0;; esac; done`,
        `exec sleep 30`,
      ].join("\n"),
    );
    const resumed = new LoopRunner(repo, "improve", config, "main");
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
  // Since merge queue 3/5 the gate runs in the LANDING, not the tick: the abort below hits
  // landQueuedEntry's signal (the same wiring the orchestrator's drain hands it). At the
  // loop level an aborted landing KEEPS the pin — the drain adds the deliberate-stop ref
  // deletion on top (pinned in the orchestrator tests). The queue entry itself is dropped:
  // retry rides the pin, never the queue.
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
    const runner = new LoopRunner(repo, "director", defaultConfig(), "main");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "queued", "the tick ends at the pin; the review is the landing's");
    const head = headLanding(repo);
    assert.ok(head, "the landing is queued");
    const landing = landQueuedEntry(
      repo,
      head.entry,
      head.file,
      runner,
      defaultConfig(),
      "main",
      controller.signal,
    );
    // Abort only once the lander worktree exists: an earlier abort would hit nothing.
    await waitForFile(path.join(repo, ".tumwater/worktrees/_land-director"));
    controller.abort();
    assert.equal(await landing, "aborted", "a mid-review abort is an abort, not a failed review");

    // Fail closed: nothing merged — the role worktree is clean at main AND the pin survives
    // the abort at this level for next-start recovery; a deliberate user stop discards the
    // ref, and that deletion is the DRAIN's job (pinned in the orchestrator tests, which run
    // the full loop with its userAborted flag). The queue entry is dropped either way.
    assert.equal(sh(repo, "git", "rev-list", "--count", "main..tumwater/director"), "0");
    const pinned = sh(repo, "git", "rev-parse", "--verify", landingRefName("director")).trim();
    assert.ok(pinned.length === 40, "the pin survived the aborted landing");
    assert.ok(!fs.existsSync(path.join(repo, "hello.txt")), "nothing landed on main");
    assert.equal(queueDepth(repo), 0, "the entry is dropped after the aborted landing");

    // The tick COMPLETED (it committed and enqueued), so the prompt is consumed, not
    // re-queued — the work's recovery is the pin, not a fresh prompt run.
    assert.equal(inboxSize(repo), 0);
    const s = loadLoopState(repo, "director");
    assert.equal(s.lastResult, "aborted");
    assert.ok(!s.resumePending, "the director never resumes an author session");
    assert.ok(s.nextRunAt > Date.now(), "recovery runs at the role's normal cadence");
  } finally {
    controller.abort(); // kill the hung reviewer before PATH is restored
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
    // The tick commits and enqueues; the LANDING is where the conflict is resolved now —
    // phase 2 (the resolution run) runs inside landHead.
    assert.equal(outcome.result, "queued");
    assert.equal(await landHead(repo, runner, defaultConfig(), "improve"), "changed");
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
    assert.equal(outcome.result, "queued");
    assert.equal(await landHead(repo, runner, defaultConfig(), "improve"), "merge_conflict");
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
    assert.equal(outcome.result, "queued", "the tick commits and enqueues; the conflict is the landing's");
    assert.equal(
      await landHead(repo, runner, defaultConfig(), "improve"),
      "merge_conflict",
      "the second conflict is reported, not crashed on",
    );
    // Nothing landed: main keeps its version…
    assert.equal(fs.readFileSync(path.join(repo, "seed.txt"), "utf8"), "main change\n", "main keeps its version");
    // …and both of the tick's commits are kept for recovery — pinned by the landing ref (the
    // pin names the top commit, which contains the stray one below it).
    assert.equal(sh(repo, "git", "rev-list", "--count", "main..tumwater/improve"), "0");
    const pinned = sh(repo, "git", "rev-parse", "--verify", landingRefName("improve")).trim();
    assert.ok(pinned.length === 40, "the tick's commits are kept for recovery via the pin");
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
    assert.equal(outcome.result, "queued");
    assert.equal(await landHead(repo, runner, defaultConfig(), "improve"), "merge_blocked");
    // The user's local edit survives — the blocked merge must not touch it.
    assert.equal(fs.readFileSync(path.join(repo, "seed.txt"), "utf8"), "user's uncommitted edit\n");
    // main did not move; the tick's commit is kept in its landing pin for the next tick's
    // recovery — and the role worktree is clean at main whatever the landing outcome.
    assert.equal(sh(repo, "git", "rev-list", "--count", "main..tumwater/improve"), "0");
    const pinned = sh(repo, "git", "rev-parse", "--verify", landingRefName("improve")).trim();
    assert.ok(pinned.length === 40, "the blocked commit is pinned for recovery");
    assert.equal(sh(worktreePath(repo, "improve"), "git", "status", "--porcelain"), "", "role worktree clean at main");
    assert.match(sh(repo, "git", "show", "main:seed.txt"), /^seed$/);
    // The failure is recorded on the state; the retry rides the next tick's leftover recovery
    // at the role's NORMAL cadence — the tick itself was productive (it committed), so no
    // idle backoff applies to a landing failure.
    assert.equal(runner.state.lastError, "merge failed: merge_blocked");
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
    // Tick 1 commits and enqueues; its landing hits the conflict and fails (the m2 phase
    // leaves the markers): that conflict state is what tick 2's recovery must salvage.
    assert.equal((await runner.tick()).result, "queued");
    assert.equal(await landHead(repo, runner, defaultConfig(), "improve"), "merge_conflict");
    // The landing's commit is pinned by its landing ref: that is what recovery must salvage.
    // (The role branch itself is clean at main — the pin is the leftover now.)
    assert.equal(sh(repo, "git", "rev-list", "--count", "main..tumwater/improve"), "0");
    const pinned = sh(repo, "git", "rev-parse", "--verify", landingRefName("improve")).trim();
    assert.ok(pinned.length === 40, "the failed merge's commit is pinned for recovery");

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

// The crash path of plans/merge-queue.md invariant 7: a shutdown between the tick's commitAll
// and its landing leaves the pin on disk (the branch is already reset to main). The next tick
// must re-land that sha through the SAME gate — reviewed, never smuggled in unreviewed.
test("a landing pin left behind by an interrupted tick is re-landed through the gate on the next tick", async () => {
  const repo = await initializedRepo();
  // Simulate the crash: a commit not contained in main, pinned by the landing ref, with the
  // role branch back at main.
  sh(repo, "git", "checkout", "--detach");
  fs.writeFileSync(path.join(repo, "crash.txt"), "interrupted work\n");
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "interrupted tick's commit");
  const sha = sh(repo, "git", "rev-parse", "HEAD").trim();
  sh(repo, "git", "checkout", "main");
  await setRef(repo, landingRefName("improve"), sha);

  // The next tick's recovery re-lands the pin through the full gate: approve → land.
  const restore = fakePi(
    [
      `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
      `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
    ].join("\n"),
  );
  try {
    const runner = new LoopRunner(repo, "improve", defaultConfig(), "main");
    assert.equal((await runner.tick()).result, "no_change", "the tick's own authoring run found nothing to do");

    // The interrupted work landed on main via recovery — reviewed, not smuggled in.
    assert.equal(sh(repo, "git", "rev-parse", "main"), sha);
    assert.ok(fs.existsSync(path.join(repo, "crash.txt")), "the recovered file is on main");
    const merged = readEvents(repo).filter((e) => e.type === "merged");
    assert.ok(
      merged.some((e) => String(e.summary) === "recovered leftover work from improve"),
      "recovery is recorded as a merge of the leftover work",
    );
    let refGone = false;
    try {
      sh(repo, "git", "rev-parse", "--verify", landingRefName("improve"));
    } catch {
      refGone = true; // a missing ref makes rev-parse --verify exit nonzero
    }
    assert.ok(refGone, "the pin was deleted once the work landed");
  } finally {
    restore();
  }
});

// The user-abort sibling of the crash-pin test above: a `tumwater abort` that lands in the
// leftover-recovery window (the pin exists BEFORE the tick starts) must discard the pinned work
// exactly like an abort in the tick's own landing path — keeping it would let next-tick recovery
// resurrect what the operator explicitly killed (`abort`: "work discarded").
test("a user-abort during leftover recovery discards the pinned work too", async () => {
  const repo = await initializedRepo();
  // Simulate the crash: a commit not contained in main, pinned by the landing ref, with the
  // role branch back at main — exactly what an interrupted tick leaves behind.
  sh(repo, "git", "checkout", "--detach");
  fs.writeFileSync(path.join(repo, "crash.txt"), "interrupted work\n");
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "interrupted tick's commit");
  const sha = sh(repo, "git", "rev-parse", "HEAD").trim();
  sh(repo, "git", "checkout", "main");
  await setRef(repo, landingRefName("improve"), sha);

  // The recovery review (its prompt contains VERDICT): hang until the abort kills it. The tick's
  // own authoring run then starts with an already-aborted signal and returns aborted at once.
  const restore = fakePi(
    [
      `for a in "$@"; do case "$a" in *"VERDICT:"*) exec sleep 30;; esac; done`,
      `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
    ].join("\n"),
  );
  try {
    const runner = new LoopRunner(repo, "improve", defaultConfig(), "main");
    const tick = runner.tick();
    // Abort only once recovery has checked the pin out into its lander worktree: an earlier
    // abort would take the same path, but this pins the window under test.
    await waitForFile(path.join(repo, ".tumwater/worktrees/_land-improve"));
    runner.abortTick();
    const outcome = await tick;
    assert.equal(outcome.result, "user_aborted", "a mid-recovery user abort is an abort, not a failed review");

    // A deliberate stop discards the pinned work: nothing landed on main and the pin is gone —
    // next-tick recovery must NOT resurrect it.
    assert.ok(!fs.existsSync(path.join(repo, "crash.txt")), "nothing landed on main");
    let refGone = false;
    try {
      sh(repo, "git", "rev-parse", "--verify", landingRefName("improve"));
    } catch {
      refGone = true; // a missing ref makes rev-parse --verify exit nonzero
    }
    assert.ok(refGone, "the pinned commit was discarded with the abort");
  } finally {
    restore();
  }
});

// The no-pin crash window: a shutdown between the tick's commitAll and its pin write leaves the
// commit on the role branch with NO landing ref. Recovery must fall back to the branch tip so
// invariant 1 (a shutdown between commit and landing loses nothing) holds whether or not the
// pin survived.
test("an unpinned commit ahead of main is recovered from the branch tip", async () => {
  const repo = await initializedRepo();
  // Simulate the crash: a commit on the role branch, no landing ref written.
  const wt = await ensureWorktree(repo, "improve", "main");
  fs.writeFileSync(path.join(wt, "unpinned.txt"), "committed but unpinned\n");
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-m", "the pin write never happened");
  const sha = sh(wt, "git", "rev-parse", "HEAD").trim();

  // The next tick's recovery finds no ref but a branch ahead of main: it re-lands the tip.
  const restore = fakePi(
    [
      `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
      `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
    ].join("\n"),
  );
  try {
    const runner = new LoopRunner(repo, "improve", defaultConfig(), "main");
    assert.equal((await runner.tick()).result, "no_change", "the tick's own authoring run found nothing to do");

    // The unpinned work landed on main via recovery — reviewed, not smuggled in.
    assert.equal(sh(repo, "git", "rev-parse", "main"), sha);
    assert.ok(fs.existsSync(path.join(repo, "unpinned.txt")), "the recovered file is on main");
    const merged = readEvents(repo).filter((e) => e.type === "merged");
    assert.ok(
      merged.some((e) => String(e.summary) === "recovered leftover work from improve"),
      "recovery is recorded as a merge of the leftover work",
    );
    // The role worktree is clean at main whatever recovery did.
    assert.equal(sh(wt, "git", "status", "--porcelain"), "");
    assert.equal(sh(repo, "git", "rev-list", "--count", "main..tumwater/improve"), "0");
  } finally {
    restore();
  }
});

test("an unmergeable leftover is retried on the next tick and keeps its landing pin", async () => {
  const repo = await initializedRepo();
  const m1 = path.join(tmpdir(), "phase1");
  // Phase 0 (any run whose prompt asks for a VERDICT — the review gate, which recovery
  // routes through): approve, so recovery reaches the merge and can fail there. Phase
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
    assert.equal((await runner.tick()).result, "queued");
    assert.equal(await landHead(repo, runner, defaultConfig(), "improve"), "merge_conflict");

    // Tick 2: recovery re-lands the pin through the same gate (the early approved return — no
    // reviewer run — since the first landing's gate already signed off on this HEAD) and hits
    // the same unresolvable conflict; the tick's own authoring run then finds nothing to do.
    assert.equal((await runner.tick()).result, "no_change");

    // merge_conflict is non-terminal: a fresh-context retry may resolve what two consecutive
    // attempts could not (a bounded attempt count lands with merge queue 3/5; review failures
    // have their own strike cap). The pin survives for the next tick's retry, and main keeps
    // its version either way.
    const pinned = sh(repo, "git", "rev-parse", "--verify", landingRefName("improve")).trim();
    assert.ok(pinned.length === 40, "the unmergeable commit is kept for the next tick's retry");
    assert.equal(fs.readFileSync(path.join(repo, "seed.txt"), "utf8"), "main change\n");
    assert.equal(sh(repo, "git", "rev-list", "--count", "main..tumwater/improve"), "0");
  } finally {
    restore();
  }
});

test("a failed recovery review keeps its pinned commit for re-review", async () => {
  const repo = await initializedRepo();
  const m1 = path.join(tmpdir(), "phase1");
  // Phase 0 (any run whose prompt asks for a VERDICT — the review gate): reply without a
  // VERDICT line, failing closed under the strike cap both times. The FIRST review run only
  // leaves an untracked stray file in the worktree it runs in (_land-improve) — guarded so the
  // recovery review does not recreate it and mask the cleanup assertion below. Phase 1 (tick
  // 1): edit seed.txt on the branch — its commit is pinned when the tick's own review fails.
  // Phase 2 (tick 2's own tick): nothing to do.
  const strayOnce = path.join(tmpdir(), "stray-once");
  const restore = fakePi(
    [
      `for a in "$@"; do case "$a" in *"VERDICT:"*)`,
      `  [ -f "${strayOnce}" ] || touch "${strayOnce}" stray.txt`,
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
    assert.equal((await runner.tick()).result, "queued");
    assert.equal(await landHead(repo, runner, defaultConfig(), "improve"), "review_error");
    // The landing's commit is pinned for recovery; the role worktree is clean at main.
    assert.equal(sh(repo, "git", "rev-list", "--count", "main..tumwater/improve"), "0");
    const pinned = sh(repo, "git", "rev-parse", "--verify", landingRefName("improve")).trim();
    assert.ok(pinned.length === 40, "the failed review's commit is pinned for re-review");

    const second = await runner.tick();
    assert.equal(second.result, "no_change", "tick 2 itself found nothing to do");

    // The failed recovery review (under the strike cap) deliberately kept its pin for
    // re-review — a plain ref deletion would have discarded it. The role worktree stays
    // clean at main whatever recovery does, and the reviewer's stray file in _land-improve
    // is cleaned by the next landing's ensureDetachedWorktree.
    assert.equal(sh(repo, "git", "rev-list", "--count", "main..tumwater/improve"), "0");
    const wt = worktreePath(repo, "improve");
    assert.ok(!fs.existsSync(path.join(wt, "stray.txt")), "no stray file in the role worktree");
    assert.equal(sh(wt, "git", "status", "--porcelain"), "", "no uncommitted edits remain");
    const landWt = path.join(repo, ".tumwater/worktrees/_land-improve");
    assert.ok(!fs.existsSync(path.join(landWt, "stray.txt")), "the reviewer's stray file is cleaned on re-landing");
    const failed = readEvents(repo).filter((e) => e.type === "review_failed");
    assert.equal(failed.length, 2, "both the tick's review and its recovery review failed");
    assert.ok(
      failed.some((e) => /no parseable VERDICT/.test(String(e.message))),
      `expected a verdict-less review failure, got: ${JSON.stringify(failed)}`,
    );
  } finally {
    restore();
  }
});

test("a shutdown mid-landing fails closed: the pinned commit survives for next-start recovery", async () => {
  const repo = await initializedRepo();
  // Author run (the tick prompt): make a change and finish. Review run (its prompt contains
  // VERDICT): hang until the abort kills it — simulating Ctrl+C while the LANDING is under
  // review. Since merge queue 3/5 the gate runs in the landing, not the tick, so the
  // shutdown hits landQueuedEntry's signal — the same wiring the orchestrator's drain uses.
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
    const runner = new LoopRunner(repo, "director", defaultConfig(), "main");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "queued", "the tick ends at the pin; the landing runs after");
    const head = headLanding(repo);
    assert.ok(head, "the landing is queued");
    const landing = landQueuedEntry(
      repo,
      head.entry,
      head.file,
      runner,
      defaultConfig(),
      "main",
      controller.signal,
    );
    // Abort only once the lander worktree exists: an earlier abort would hit nothing.
    await waitForFile(path.join(repo, ".tumwater/worktrees/_land-director"));
    controller.abort();
    assert.equal(await landing, "aborted", "a mid-review shutdown is an abort, not a failed review");

    // Fail closed: nothing merged — the role worktree is clean at main and the commit survives
    // in its landing pin for the next start's leftover recovery. The queue entry itself is
    // dropped after the outcome: recovery rides the pin, never the queue.
    assert.equal(sh(repo, "git", "rev-list", "--count", "main..tumwater/director"), "0");
    const pinned = sh(repo, "git", "rev-parse", "--verify", landingRefName("director")).trim();
    assert.ok(pinned.length === 40, "the pin survived the abort");
    assert.ok(!fs.existsSync(path.join(repo, "hello.txt")), "nothing landed on main");
    assert.equal(queueDepth(repo), 0, "the entry is dropped after the aborted landing");

    // The prompt was consumed by the COMPLETED tick (it committed and enqueued) — the work's
    // recovery is the pin, not a re-queued prompt. The state shows the aborted landing.
    assert.equal(inboxSize(repo), 0);
    const s = loadLoopState(repo, "director");
    assert.equal(s.lastResult, "aborted");
    assert.ok(!s.resumePending, "the director does not resume an author session");
    assert.ok(s.nextRunAt > Date.now(), "recovery runs at the role's normal cadence");
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
    // Tick 1: the change is committed and enqueued, then the LANDING rejects it — nothing
    // lands on main.
    assert.equal((await runner.tick()).result, "queued");
    assert.equal(await landHead(repo, runner, defaultConfig(), "improve"), "rejected");
    assert.equal(sh(repo, "git", "rev-list", "--count", "main..tumwater/improve"), "0");
    const wt = worktreePath(repo, "improve");
    assert.equal(sh(wt, "git", "status", "--porcelain"), "", "a rejected tick leaves the role worktree clean at main");
    let refGone = false;
    try {
      sh(repo, "git", "rev-parse", "--verify", landingRefName("improve"));
    } catch {
      refGone = true; // a missing ref makes rev-parse --verify exit nonzero
    }
    assert.ok(refGone, "a rejection is terminal: the pin was deleted with it");
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
    assert.equal(outcome.result, "queued");
    assert.equal(await landHead(repo, runner, defaultConfig(), "organize"), "changed");
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
    assert.equal(outcome.result, "queued");
    assert.equal(
      await landHead(repo, runner, defaultConfig(), "improve"),
      "changed",
      "a clean resolution must not be rejected as conflicted",
    );
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
    assert.equal(outcome.result, "queued", "the retry's work is committed and enqueued");
    assert.equal(await landHead(repo, runner, defaultConfig(), "improve"), "changed");
    // The trailer sums both runs' turns (3 + 1) — and only them: the reviewer run folds
    // after the commit. Peak ctx is the retry run's 42; attempt 1 carried no usage.
    const body = sh(repo, "git", "log", "-1", "--format=%B");
    assert.match(body, /^Tick: improve #\d+ · turns 4 · ctx 42$/m);
  } finally {
    restore();
  }
});
