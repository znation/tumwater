/** First slice of the loop e2e suite (loop-2.test.ts and loop-3.test.ts are the other two) —
 * split so node --test runs the slices in parallel processes: top-level tests within one file
 * run sequentially, while each test FILE gets its own process (and its own PATH, which
 * fakePi's global PATH swap requires). The slices are balanced by measured per-test duration
 * (~26 s each at 2026-09-21); keep them roughly equal when moving tests between the files. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { LoopRunner } from "../src/loop.js";
import { initProject } from "../src/init.js";
import { defaultConfig, customLoopNames, loadConfig } from "../src/config.js";
import { dequeuePrompt, enqueuePrompt, inboxSize } from "../src/inbox.js";
import { readEvents } from "../src/events.js";
import { loadLoopState } from "../src/state.js";
import { configRequestPath, sessionDir, worktreePath } from "../src/paths.js";
import { readQaCoverage, recordFlow } from "../src/qa-coverage.js";
import { assistantLine, fakePi, initializedRepo, landHead, makeRepo, sh, thinkingOnlyLine, tmpdir, waitForFile } from "./util.js";


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
    // separate step, and landHead drives it through the landing pipeline's own vet and merge,
    // so the whole flow below is the production path.
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

test("a full tick → review → merge cycle lands on a repo whose only branch is trunk (portability 2/7)", async () => {
  // The branch plumbing is parameterized end to end; this pins that nothing named "main"
  // leaks into the landing path: rename the only branch to trunk BEFORE init, so no main
  // exists anywhere, and the commit must land on trunk.
  const repo = makeRepo();
  sh(repo, "git", "branch", "-m", "main", "trunk");
  await initProject(repo, "A trunk-based project.");
  const restore = fakePi(
    [
      `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
      `printf '%s\n' '${assistantLine("done\nSUMMARY: add hello file", { tokens: 10, output: 10, cost: 0 })}'`,
      `echo hello > hello.txt`,
    ].join("\n"),
  );
  try {
    const config = defaultConfig();
    const runner = new LoopRunner(repo, "improve", config, "trunk");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "queued");
    assert.equal(
      await landHead(repo, runner, config, "improve", "trunk"),
      "changed",
      "the landing lands on trunk, the only branch there is",
    );
    assert.ok(fs.existsSync(path.join(repo, "hello.txt")));
    assert.equal(sh(repo, "git", "symbolic-ref", "--short", "HEAD"), "trunk");
    assert.match(sh(repo, "git", "log", "-1", "--format=%s"), /tumwater\(improve\): add hello file/);
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

// The qa observer's coverage ledger (plans/observer-roles.md 2/2): every tick is a fresh
// session, so the only memory of which flow it last exercised is the runtime file the harness
// writes from the reply's FLOW line. A passing cheap check changes no files, so it must still
// record; a tick with no FLOW line records nothing and completes normally.

test("a qa no_change tick records the FLOW line it emitted", async () => {
  const repo = await initializedRepo();
  const restore = fakePi(
    `printf '%s\n' '${assistantLine("checked status\nFLOW: status — passed\nTUMWATER_NOTHING_TO_DO")}'`,
  );
  try {
    const runner = new LoopRunner(repo, "qa", defaultConfig(), "main");
    assert.equal((await runner.tick()).result, "no_change");
    const coverage = readQaCoverage(repo);
    assert.equal(coverage.status?.result, "passed");
    assert.equal(typeof coverage.status?.lastRunAt, "number");
    assert.deepEqual(Object.keys(coverage), ["status"]);
  } finally {
    restore();
  }
});

test("a qa tick with no FLOW line records nothing and still completes", async () => {
  const repo = await initializedRepo();
  const restore = fakePi(`printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`);
  try {
    const runner = new LoopRunner(repo, "qa", defaultConfig(), "main");
    assert.equal((await runner.tick()).result, "no_change");
    assert.deepEqual(readQaCoverage(repo), {});
  } finally {
    restore();
  }
});

test("a qa tick cut off before declaring its outcome does not advance the flow rotation", async () => {
  const repo = await initializedRepo();
  // Mid-run FLOW line, then a thinking-only final message (the cut-off signature) with no
  // nothing-to-do sentinel: the run never declared its outcome, so the flow must NOT be
  // recorded — the rotation must not skip a check that did not finish.
  const restore = fakePi(
    `printf '%s\n' '${assistantLine("checking status\nFLOW: status — passed")}'\n` +
      `printf '%s\n' '${thinkingOnlyLine("status looks", { output: 16 })}'`,
  );
  try {
    const runner = new LoopRunner(repo, "qa", defaultConfig(), "main");
    assert.equal((await runner.tick()).result, "no_change");
    assert.deepEqual(readQaCoverage(repo), {});
  } finally {
    restore();
  }
});

test("a qa tick that files a bug records the bug result and its headline", async () => {
  const repo = await initializedRepo();
  const restore = fakePi(
    [
      `printf '%s\n' '${assistantLine("found one\nSUMMARY: status --json omits the fallback badge\nFLOW: status — bug")}'`,
      `printf '%s\n' '- status --json omits the fallback badge' >> BUGS.md`,
    ].join("\n"),
  );
  try {
    const runner = new LoopRunner(repo, "qa", defaultConfig(), "main");
    assert.equal((await runner.tick()).result, "queued");
    const coverage = readQaCoverage(repo);
    assert.equal(coverage.status?.result, "bug");
    assert.equal(coverage.status?.summary, "status --json omits the fallback badge");
  } finally {
    restore();
  }
});

test("a qa tick's prompt carries the rendered coverage block from the ledger", async () => {
  const repo = await initializedRepo();
  // Seed a ledger so the block has content; the shim only emits a FLOW line when it sees the
  // rendered block in its own arguments, so a tick whose prompt omitted it would record nothing.
  recordFlow(repo, "status", "passed", undefined, Date.now() - 4 * 60 * 60 * 1000);
  const restore = fakePi(
    `for a in "$@"; do case "$a" in *"least recently exercised first"*) ` +
      `printf '%s\n' '${assistantLine("checked logs\nFLOW: logs — passed\nTUMWATER_NOTHING_TO_DO")}'; exit 0;; esac; done\n` +
      `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
  );
  try {
    const runner = new LoopRunner(repo, "qa", defaultConfig(), "main");
    assert.equal((await runner.tick()).result, "no_change");
    assert.equal(readQaCoverage(repo).logs?.result, "passed", "the coverage block reached the qa prompt");
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

test("consecutive error ticks raise one warning per episode, not one per tick", async () => {
  // BUGS.md 2026-09-15: 44 identical error ticks across every loop raised no alarm. The
  // streak crossing fires exactly one warning per episode — the fourth failure deepens the
  // episode without re-warniing, and a healthy tick re-arms it for the next episode.
  const repo = await initializedRepo();
  const restore = fakePi(`echo 'git is broken' >&2\nexit 1`);
  try {
    const runner = new LoopRunner(repo, "clean", defaultConfig(), "main");
    const warnings = () => readEvents(repo).filter((e) => e.type === "warning");
    assert.equal((await runner.tick()).result, "error");
    assert.equal((await runner.tick()).result, "error");
    assert.equal(warnings().length, 0, "below the threshold there is no alarm");
    assert.equal((await runner.tick()).result, "error");
    assert.equal(runner.state.consecutiveErrors, 3);
    const [w] = warnings();
    assert.ok(w, "the third consecutive failure crosses the threshold once");
    assert.match(String(w.message), /3 consecutive tick failures: git is broken/);
    // A fourth failure deepens the episode without a second alarm.
    assert.equal((await runner.tick()).result, "error");
    assert.equal(runner.state.consecutiveErrors, 4);
    assert.equal(warnings().length, 1);
    // The persisted state carries the streak, so a restarted observer reads "failing" too.
    const saved = loadLoopState(repo, "clean");
    assert.equal(saved.lastResult, "error");
    assert.equal(saved.consecutiveErrors, 4);
  } finally {
    restore();
  }
});

test("consecutive quiet kills raise one warning per episode, then drop the starved session", async () => {
  // BUGS.md 2026-09-18: quiet_killed was the only outcome with no cap, no backoff and no
  // alarm. The streak crossing warns once; the kill past the limit abandons the session
  // (fresh tick) and backs off instead of retrying the starved session immediately forever.
  const repo = await initializedRepo();
  // One line, then silence — the quiet watchdog kills the run as hung.
  const restore = fakePi(
    [`printf '%s\n' '${assistantLine("starting work")}'`, `exec sleep 60`].join("\n"),
  );
  try {
    const config = defaultConfig();
    config.quietTimeoutSeconds = 1;
    config.tickTimeoutSeconds = 3600;
    const runner = new LoopRunner(repo, "improve", config, "main");
    const warnings = () => readEvents(repo).filter((e) => e.type === "warning");
    // Two prior kills: this one crosses the threshold.
    runner.state.quietKillStreak = 2;
    assert.equal((await runner.tick()).result, "quiet_killed");
    assert.equal(runner.state.quietKillStreak, 3);
    assert.equal(warnings().length, 1, "one warning at the threshold");
    assert.match(String(warnings()[0]?.message), /3 consecutive quiet kills \(no progress\)/);
    // Past the limit: no resume, and the loop climbs the idle ladder rather than retrying now.
    runner.state.quietKillStreak = 3;
    runner.state.resumePending = false;
    assert.equal((await runner.tick()).result, "quiet_killed");
    assert.equal(runner.state.quietKillStreak, 4);
    assert.equal(runner.state.resumePending, false, "the starved session is abandoned");
    assert.ok(runner.state.backoffSeconds > 0, "the give-up backs off on the idle ladder");
    assert.equal(warnings().length, 1, "the warning is once per episode, not once per kill");
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

// Harness-mediated config writes (plans/portability.md §3/7): the director's config request is
// consumed before any commit path — the loop is live on the ~2 s reload, no commit exists, and
// the request file never enters a diff.
test("a director tick applies a config request without producing a commit", async () => {
  const repo = await initializedRepo();
  const restore = fakePi(
    [
      `printf '%s\n' '${assistantLine("done\nSUMMARY: add docs loop")}'`,
      `printf '%s' '{"customLoops":[{"name":"docs","task":"Keep the examples current."}]}' > .tumwater-config-request.json`,
    ].join("\n"),
  );
  try {
    const runner = new LoopRunner(repo, "director", defaultConfig(), "main");
    enqueuePrompt(repo, "add a loop named docs that keeps the examples current");
    // The request is not a worktree change: consumed and deleted before the dirty check, the
    // tick is a fulfillment with nothing to commit (the orchestrator's reload starts the loop).
    assert.equal((await runner.tick()).result, "no_change");
    assert.deepEqual(customLoopNames(loadConfig(repo)), ["docs"]);
    assert.ok(!fs.existsSync(configRequestPath(worktreePath(repo, "director"))), "request consumed");
    assert.equal(
      sh(repo, "git", "log", "--oneline", "main..tumwater/director").trim(),
      "",
      "the request file never reaches a commit",
    );
  } finally {
    restore();
  }
});

test("a config request naming a disallowed key applies customLoops and warns naming the key", async () => {
  const repo = await initializedRepo();
  const restore = fakePi(
    [
      `printf '%s\n' '${assistantLine("done\nSUMMARY: add docs loop")}'`,
      `printf '%s' '{"customLoops":[{"name":"docs","task":"t"}],"maxDailyCostUsd":1}' > .tumwater-config-request.json`,
    ].join("\n"),
  );
  try {
    const runner = new LoopRunner(repo, "director", defaultConfig(), "main");
    enqueuePrompt(repo, "add docs and set the budget to 1");
    await runner.tick();
    // The good half still applies...
    assert.deepEqual(customLoopNames(loadConfig(repo)), ["docs"]);
    // ...and the ignored key is named in a warning event, not dropped silently.
    const warnings = readEvents(repo).filter((e) => e.type === "warning");
    assert.ok(
      warnings.some((e) => String(e.message).includes("maxDailyCostUsd")),
      `expected a warning naming the ignored key, got: ${JSON.stringify(warnings.map((e) => String(e.message)))}`,
    );
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
  // 5s, not 2s: the shim sleeps 30 so the watchdog still owns the kill, but it must not fire
  // before the shell writes kept.txt — at 2s waitForFile timed out under concurrent suites and
  // the test measured scheduling rather than the kill's non-destructiveness (BUGS.md).
  config.quietTimeoutSeconds = 5;
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

