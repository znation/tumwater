/** The pi run's watchdog timing policy (src/pi/pi-watchdogs.ts) driven end-to-end through
 * runPi against the fake pi: the quiet watchdog's kill and how the run reports it
 * (quietKilled, not timedOut), the zero-byte startup grace and its finite 30-minute bound,
 * and the gate run's one-shot deadline extension. All on logical time (watchdogClock), so
 * the ordering each test pins is exact and crossing a window costs nothing. The runPi wiring
 * these drive — spawn, stream decoding, stall warnings, session lifecycle, and stderr
 * classification — stays in test/pi.test.ts. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runPi } from "../src/pi/pi.js";
import { defaultConfig } from "../src/config/config.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { withPi } from "./fakes/fake-pi.js";
import { waitForLogLines, watchdogClock } from "./helpers/wait.js";
import { assistantLine } from "./fixtures/pi-events.js";
import { ownerAliveSh } from "./fixtures/victim-fixture.js";
import { runPiFixture } from "./helpers/pi-run-harness.js";

// The quiet watchdog's kill is reported as quietKilled, not timedOut: a hung tool call leaves
// its session and worktree edits intact, so the loop resumes them instead of discarding hours
// of work for the next tick's reset (BUGS.md 2026-09-12).
//
// The watchdog tests below run it on logical time (watchdogClock): each waits until the raw
// log shows the fake pi's output — so the parser has counted it — then advances the clock
// past the window it pins. Their windows used to be real seconds, widened after every
// loaded-machine flake (BUGS.md 2026-09-18, 2026-09-21); on logical time the ordering they
// assert is exact, and crossing a window costs nothing.

test("a stalled run is reported as quiet-killed, not timed out", async (t) => {
  const dir = tmpdir();
  const config = defaultConfig();
  config.quietTimeoutSeconds = 2; // the watchdog checks every second and kills after ~2 s of silence
  const clock = watchdogClock(t);
  await withPi(
    [
      `printf '%s\n' '${JSON.stringify({ type: "tool_execution_start", toolName: "bash" })}'`,
      `exec sleep 30`, // exec so SIGTERM reaches the sleeper directly and the run ends promptly
    ].join("\n"),
    async () => {
      const opts = runPiFixture(dir, { config });
      const run = runPi(opts);
      await waitForLogLines(opts.rawLogFile, "tool_execution_start");
      clock.advance(10_000); // silence well past the 2 s window
      const result = await run;
      assert.equal(result.ok, false);
      assert.equal(result.quietKilled, true, "the watchdog kill is reported as quiet-killed");
      assert.equal(result.timedOut, false, "a hung tool call is not a tick timeout");
      assert.match(result.errorMessage ?? "", /killed as hung/);
    },
  );
});

// BUGS.md 2026-09-23: under full-suite load a run's first output could land past the quiet
// window measured from runPi's start — the OS had not yet scheduled the process, so the
// watchdog killed a run that never had the chance to speak. The doubled window that fix
// granted a zero-progress run still false-killed under merge-check load: the kill check can
// fire before the child's first bytes exist at all (fork/exec starved by the same load, or
// bytes written but not yet drained — a firing timer phase precedes the poll phase that
// delivers stdout). The fix gave a byte-silent run no quiet kill at all; BUGS.md 2026-09-29
// replaced that unbounded exemption (which delegated its bound to tickTimeoutSeconds, and
// the live 54000 s config left a wedged run 15 hours in a slot) with a finite zero-byte
// bound of max(two quiet windows, 30 min). This pins that ordinary startup latency — a
// minute of byte-silence, far past the old single and doubled windows — still does not
// kill a run; the 30-minute bound is tested separately below.
test("a run that is slow to speak is not quiet-killed during startup", async (t) => {
  const dir = tmpdir();
  const config = defaultConfig();
  config.quietTimeoutSeconds = 5; // old single window killed a silent run at the ~7.5 s check
  const go = path.join(dir, "go");
  const clock = watchdogClock(t);
  await withPi(
    [
      `while [ ! -f '${go}' ] && ${ownerAliveSh()}; do sleep 0.02; done`, // byte-silent until the test says go
      `printf '%s\n' '${assistantLine("done\nSUMMARY: spoke late")}'`,
    ].join("\n"),
    async () => {
      const run = runPi(runPiFixture(dir, { config }));
      // A minute of silence before the first byte: past the old single window (5 s) and the
      // doubled startup window (10 s) alike, and well under the 30-minute zero-byte bound.
      clock.advance(60_000);
      fs.writeFileSync(go, "");
      const result = await run;
      assert.equal(result.quietKilled, false, "startup latency is not a hung tool call");
      assert.equal(result.ok, true, "the run completes once pi finally speaks");
    },
  );
});

// BUGS.md 2026-09-29: the 2026-09-23 zero-byte exemption was unbounded — a run that never
// emits a byte was bounded only by tickTimeoutSeconds, which operators raise for unrelated
// reasons (the live config's 54000 s left a wedged model connection 15 hours in a
// concurrency slot). The zero-byte bound is now max(two quiet windows, 30 min), independent
// of the tick timeout. This pins that a byte-silent run is reaped by the quiet watchdog —
// reported quietKilled, so the loop resumes it — with a tick timeout set far beyond the
// bound; under the old exemption this run never settles short of the real 2 h timeout.
test("a run that never emits a byte is quiet-killed at 30 minutes regardless of the tick timeout", async (t) => {
  const dir = tmpdir();
  const config = defaultConfig();
  config.quietTimeoutSeconds = 2; // zero-byte bound = max(2 × 2 s, 30 min) = 30 min
  config.tickTimeoutSeconds = 7200; // far beyond the zero-byte bound: it must not be the reaper
  const clock = watchdogClock(t);
  await withPi(
    // exec so SIGTERM reaches the sleeper directly and the run ends promptly; the script
    // writes nothing, so sawOutput stays false for the whole run.
    `exec sleep 30`,
    async () => {
      const run = runPi(runPiFixture(dir, { config }));
      clock.advance(31 * 60_000); // one minute past the 30-minute zero-byte bound
      const result = await run;
      assert.equal(result.quietKilled, true, "a byte-silent run is reaped by the quiet watchdog");
      assert.equal(result.timedOut, false, "the tick timeout is not the zero-byte bound");
      assert.match(result.errorMessage ?? "", /killed as hung/);
    },
  );
});

// BUGS.md 2026-10-07: a gate run (the reviewer, the landing conflict resolver) runs a fresh
// session every time, so a deadline that fires mid-verification throws away everything it
// read and the next attempt re-reads a large diff from scratch. A gate run that is still
// making progress at its deadline therefore gets one extension of the same length. These
// three tests pin the extension, its one-shot bound, and the discrimination from a run that
// has stopped progressing — all on logical time.
test("a gate run still progressing at its deadline gets one extension and finishes", async (t) => {
  const dir = tmpdir();
  const config = defaultConfig();
  config.tickTimeoutSeconds = 2;
  config.quietTimeoutSeconds = 0; // the extension must not depend on the quiet watchdog
  const mid = path.join(dir, "mid");
  const finish = path.join(dir, "finish");
  const clock = watchdogClock(t, { timeouts: true });
  await withPi(
    [
      `printf '%s\n' '${assistantLine("reading the diff")}'`,
      `while [ ! -f '${mid}' ] && ${ownerAliveSh()}; do sleep 0.02; done`,
      `printf '%s\n' '${assistantLine("still reading")}'`,
      `while [ ! -f '${finish}' ] && ${ownerAliveSh()}; do sleep 0.02; done`,
      `printf '%s\n' '${assistantLine("done\nSUMMARY: review finished")}'`,
    ].join("\n"),
    async () => {
      const opts = runPiFixture(dir, { config, kind: "gate" });
      const run = runPi(opts);
      await waitForLogLines(opts.rawLogFile, "reading the diff");
      clock.advance(1_500); // past the 1 s checkpoint, still inside the base 2 s budget
      fs.writeFileSync(mid, "");
      await waitForLogLines(opts.rawLogFile, "still reading");
      clock.advance(1_000); // cross the 2 s deadline: progress since the checkpoint extends it
      fs.writeFileSync(finish, "");
      const result = await run;
      assert.equal(result.ok, true, "the extension let the progressing run finish");
      assert.equal(result.timedOut, false, "the base deadline did not kill the run");
    },
  );
});

test("a gate run that stopped progressing before its deadline is not extended", async (t) => {
  const dir = tmpdir();
  const config = defaultConfig();
  config.tickTimeoutSeconds = 2;
  const clock = watchdogClock(t, { timeouts: true });
  await withPi(
    [`printf '%s\n' '${assistantLine("reading the diff")}'`, `exec sleep 60`].join("\n"),
    async () => {
      const opts = runPiFixture(dir, { config, kind: "gate" });
      const run = runPi(opts);
      await waitForLogLines(opts.rawLogFile, "reading the diff");
      clock.advance(2_500); // past the 1 s checkpoint AND the base 2 s deadline
      const result = await run;
      assert.equal(result.timedOut, true, "a run that stalled keeps the base bound");
      assert.equal(
        result.timedOutProgressing,
        false,
        "a run whose progress stopped before the checkpoint is not progressing, even though the quiet window is longer than the tick budget",
      );
      assert.match(result.errorMessage ?? "", /timed out after 2s/);
      assert.doesNotMatch(result.errorMessage ?? "", /after 4s/);
    },
  );
});

test("a gate run's extension is one-shot: the second deadline kills it at twice the budget", async (t) => {
  const dir = tmpdir();
  const config = defaultConfig();
  config.tickTimeoutSeconds = 2;
  const mid = path.join(dir, "mid");
  const clock = watchdogClock(t, { timeouts: true });
  await withPi(
    [
      `printf '%s\n' '${assistantLine("reading the diff")}'`,
      `while [ ! -f '${mid}' ] && ${ownerAliveSh()}; do sleep 0.02; done`,
      `printf '%s\n' '${assistantLine("still reading")}'`,
      `exec sleep 60`,
    ].join("\n"),
    async () => {
      const opts = runPiFixture(dir, { config, kind: "gate" });
      const run = runPi(opts);
      await waitForLogLines(opts.rawLogFile, "reading the diff");
      clock.advance(1_500); // past the checkpoint, still inside the base budget
      fs.writeFileSync(mid, "");
      await waitForLogLines(opts.rawLogFile, "still reading");
      clock.advance(3_000); // base deadline extends it; the re-armed deadline at 2× then kills it
      const result = await run;
      assert.equal(result.timedOut, true, "the extension is spent after one slice");
      assert.match(result.errorMessage ?? "", /timed out after 4s/, "the kill names the real doubled budget");
      assert.doesNotMatch(result.errorMessage ?? "", /after 2s/);
    },
  );
});

test("an authoring run is not extended even while it is progressing", async (t) => {
  const dir = tmpdir();
  const config = defaultConfig();
  config.tickTimeoutSeconds = 2;
  const mid = path.join(dir, "mid");
  const clock = watchdogClock(t, { timeouts: true });
  await withPi(
    [
      `printf '%s\n' '${assistantLine("working")}'`,
      `while [ ! -f '${mid}' ] && ${ownerAliveSh()}; do sleep 0.02; done`,
      `printf '%s\n' '${assistantLine("still working")}'`,
      `exec sleep 60`,
    ].join("\n"),
    async () => {
      const opts = runPiFixture(dir, { config }); // kind "author"
      const run = runPi(opts);
      await waitForLogLines(opts.rawLogFile, "working");
      clock.advance(1_500); // past the checkpoint, still inside the base budget
      fs.writeFileSync(mid, "");
      await waitForLogLines(opts.rawLogFile, "still working");
      clock.advance(1_000); // cross the deadline with progress since the checkpoint
      const result = await run;
      assert.equal(result.timedOut, true, "only gate runs earn the extension");
      assert.match(result.errorMessage ?? "", /timed out after 2s/);
      assert.doesNotMatch(result.errorMessage ?? "", /after 4s/);
    },
  );
});
