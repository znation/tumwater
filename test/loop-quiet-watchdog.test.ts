/** The loop e2e suite's quiet-watchdog slice — the tick's hang detection and its kill
 * semantics, extracted from loop-4.test.ts (2026-09-29) so the topic has a name instead of a
 * row in a numbered grab-bag. The suite's slices run one test FILE per process (each file gets
 * its own process and PATH, which fakePi's global PATH swap requires — see loop-4.test.ts's
 * header), so this file runs in parallel with the numbered ones; the header's keep-them-equal
 * balance rule applies to moves between the existing slices, not to a new topic file. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initProject } from "../src/init/init.js";
import { defaultConfig } from "../src/config/config.js";
import { validateConfig } from "../src/config/config-validation.js";
import { piLogPath } from "../src/paths.js";
import { warningMessages } from "./log-fixtures.js";
import { makeLoopRunner, roleWt } from "./loop-fixtures.js";
import { initializedRepo, mainSha, makeRepo, tmpdir } from "./repo-fixtures.js";
import { fakePi } from "./fake-pi.js";
import { waitForFile, waitForLogLines, watchdogClock } from "./wait.js";
import { assistantLine } from "./pi-events.js";
import { ownerAliveSh } from "./victim-fixture.js";

// Quiet watchdog: the run is killed when pi stops making *progress* (message/turn/tool
// boundary events — streaming deltas never count), not merely when it stops running fast.
// These tests run it on logical time (watchdogClock, test/wait.ts): each waits for the fake
// pi's output to reach the raw log, then advances the watchdog's clock past the window it
// pins — exact where real-time windows were widened after every loaded-machine flake
// (BUGS.md 2026-09-18, 2026-09-21), and free where they cost seconds.

test("a pi run that goes silent is killed as hung and never commits partial work", async (t) => {
  const repo = await initializedRepo();
  // Emits one line (so it is not silent from birth), writes a partial edit, then hangs
  // like an interactive tool waiting for stdin. `exec` so the signal reaches sleep.
  const restore = fakePi(
    [`printf '%s\n' '${assistantLine("starting work")}'`, `echo partial > partial.txt`, `exec sleep 60`].join("\n"),
  );
  try {
    const config = defaultConfig();
    config.quietTimeoutSeconds = 3;
    config.tickTimeoutSeconds = 3600; // The watchdog, not the tick timeout, must fire.
    const clock = watchdogClock(t);
    const runner = makeLoopRunner(repo, "improve", config);
    const before = mainSha(repo);
    const tick = runner.tick();
    // The kill must come only once the shim has spoken and reached `echo partial` — the
    // "partial edit survives" assertion below is about the kill, not about shell startup.
    await waitForFile(path.join(roleWt(repo, "improve"), "partial.txt"));
    await waitForLogLines(piLogPath(repo, "improve"), "starting work");
    clock.advance(15_000); // silence well past the 3 s window
    const outcome = await tick;
    assert.equal(outcome.result, "quiet_killed");
    assert.match(runner.state.lastError ?? "", /killed as hung: no pi progress/);
    assert.equal(mainSha(repo), before, "nothing landed on main");
    assert.ok(!fs.existsSync(path.join(repo, "partial.txt")));
    // The kill is non-destructive (BUGS.md 2026-09-12): the partial edit survives in the
    // worktree and the next tick resumes the session instead of resetting it away.
    assert.ok(
      fs.existsSync(path.join(roleWt(repo, "improve"), "partial.txt")),
      "the partial edit survives the kill",
    );
    assert.equal(runner.state.resumePending, true, "the next tick resumes this one");
  } finally {
    restore();
  }
});

// The stall warning (BUGS.md 2026-09-13 sibling): a tool call open and silent past the
// threshold names itself in the event feed while the run is still alive — before this, a hung
// command was invisible until the quiet watchdog's kill.

test("a stalled tool call warns in the event feed with the command named", async (t) => {
  const repo = await initializedRepo();
  // Names a hung bash command, then hangs like an interactive tool waiting for stdin.
  const restore = fakePi(
    [
      `printf '%s\n' '${JSON.stringify({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "sleep 999" } })}'`,
      `exec sleep 60`, // exec so the signal reaches the sleeper directly
    ].join("\n"),
  );
  try {
    const config = defaultConfig();
    // The ORDER is what this pins — warning first, kill second — exact on logical time, where a
    // real-time 1s gap was thinner than the jitter of two suites at once (BUGS.md).
    config.quietTimeoutSeconds = 5; // the watchdog still owns the kill...
    config.toolCallStallSeconds = 2; // ...but the warning lands first, 3s ahead of it
    const clock = watchdogClock(t);
    const runner = makeLoopRunner(repo, "improve", config);
    const tick = runner.tick();
    await waitForLogLines(piLogPath(repo, "improve"), "tool_execution_start");
    clock.advance(30_000); // past the stall threshold, then past the quiet window
    const outcome = await tick;
    assert.equal(outcome.result, "quiet_killed");
    const warnings = warningMessages(repo);
    assert.ok(
      warnings.some((m) => m.startsWith("tool call stalled: bash sleep 999")),
      `the stall warning names the hung command; got: ${JSON.stringify(warnings)}`,
    );
  } finally {
    restore();
  }
});

test("a slow but talkative pi run is not killed by the quiet watchdog", async (t) => {
  const repo = await initializedRepo();
  // Streams a line immediately, then one per 3 s gap for 18 s — far longer than the 10 s quiet
  // window would allow if it were measuring total runtime, but never silent longer than the
  // window. The ratio is what this pins. The gaps are logical time (watchdogClock): the shim
  // prints its next line only when the test says so, after the clock has moved 3 s — so no
  // machine load can stretch a gap, which is how the real-time version of this test flaked
  // even at 3 s gaps against a 10 s window (BUGS.md 2026-09-18, 2026-09-21). 18 s, not 12 s:
  // the watchdog checks every 5 s and kills on silence strictly over the window, so a
  // runtime-measuring regression is first visible at the 15 s check.
  const dir = tmpdir();
  const gaps = 6;
  const go = (k: number) => path.join(dir, `go-${k}`);
  const turnStart = `printf '%s\n' '${JSON.stringify({ type: "turn_start" })}'`;
  const chatter = Array.from(
    { length: gaps },
    (_, k) => `while [ ! -f '${go(k)}' ] && ${ownerAliveSh()}; do sleep 0.02; done\n${turnStart}`,
  );
  const restore = fakePi([turnStart, ...chatter, `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`].join("\n"));
  try {
    const config = defaultConfig();
    config.quietTimeoutSeconds = 10;
    const clock = watchdogClock(t);
    const runner = makeLoopRunner(repo, "improve", config);
    let settled = false;
    const tick = runner.tick().finally(() => (settled = true));
    const log = piLogPath(repo, "improve");
    // A killed run prints nothing more: stop feeding it and let the assertion name the result.
    for (let k = 0; k < gaps && (await waitForLogLines(log, "turn_start", k + 1, () => settled)); k++) {
      clock.advance(3_000);
      fs.writeFileSync(go(k), "");
    }
    const outcome = await tick;
    assert.equal(outcome.result, "no_change", "run completed despite taking longer than the quiet window");
  } finally {
    restore();
  }
});

test("quietTimeoutSeconds 0 disables the watchdog", async (t) => {
  const repo = await initializedRepo();
  // Speaks first — a byte-silent run is never quiet-killed anyway, so silence only tests the
  // switch once progress has flowed — then stays silent until the test says go.
  const go = path.join(tmpdir(), "go");
  const restore = fakePi(
    [
      `printf '%s\n' '${JSON.stringify({ type: "turn_start" })}'`,
      `while [ ! -f '${go}' ] && ${ownerAliveSh()}; do sleep 0.02; done`,
      `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
    ].join("\n"),
  );
  try {
    const config = defaultConfig();
    config.quietTimeoutSeconds = 0;
    const clock = watchdogClock(t);
    const runner = makeLoopRunner(repo, "improve", config);
    const tick = runner.tick();
    await waitForLogLines(piLogPath(repo, "improve"), "turn_start");
    clock.advance(120_000); // two minutes of silence: any window at all would have fired
    fs.writeFileSync(go, "");
    const outcome = await tick;
    assert.equal(outcome.result, "no_change");
  } finally {
    restore();
  }
});

test("config validation accepts 0 and rejects negatives for quietTimeoutSeconds", () => {
  validateConfig({ quietTimeoutSeconds: 0 });
  validateConfig({ quietTimeoutSeconds: 1800 });
  assert.throws(() => validateConfig({ quietTimeoutSeconds: -5 }), /quietTimeoutSeconds/);
  assert.throws(() => validateConfig({ quietTimeoutSeconds: "long" }), /quietTimeoutSeconds/);
});

test("a zombie stream dripping content-free keepalive updates is killed as hung", async (t) => {
  const repo = makeRepo();
  await initProject(repo, "zombie stream test");
  // Emits an identical empty message_update every 200ms forever — bytes without progress,
  // exactly what a dead generation's kept-alive connection looks like.
  const keepalive = JSON.stringify({
    type: "message_update",
    message: { role: "assistant", content: [], usage: { totalTokens: 0 } },
  });
  const restore = fakePi(
    [`while true; do`, `  printf '%s\n' '${keepalive}'`, `  sleep 0.2`, `done`].join("\n"),
  );
  try {
    const config = defaultConfig();
    config.quietTimeoutSeconds = 1;
    config.tickTimeoutSeconds = 3600;
    const clock = watchdogClock(t);
    const controller = new AbortController();
    const runner = makeLoopRunner(repo, "improve", config, "main", controller.signal);
    let settled = false;
    const tick = runner.tick().finally(() => (settled = true));
    // Half a second of watchdog time per fresh keepalive, so bytes keep landing as the clock
    // runs — a watchdog that let raw bytes (or deltas) count as progress would never fire.
    // Ten windows' worth bounds it: the abort then ends a run the watchdog failed to kill.
    const log = piLogPath(repo, "improve");
    for (let k = 1; k <= 40 && (await waitForLogLines(log, "message_update", k, () => settled)); k++) {
      clock.advance(500);
    }
    controller.abort(); // a no-op once the watchdog has killed the run
    const outcome = await tick;
    assert.equal(outcome.result, "quiet_killed", "a zombie stream is a hung run, not an unfulfilled timeout");
    assert.match(runner.state.lastError ?? "", /killed as hung: no pi progress/);
  } finally {
    restore();
  }
});
