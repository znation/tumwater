/** The pi run's watchdog timing policy (src/pi/pi-watchdogs.ts) driven end-to-end through
 * runPi against the fake pi: the quiet watchdog's kill and how the run reports it
 * (quietKilled, not timedOut), the zero-byte startup grace and its finite 30-minute bound,
 * and the gate run's one-shot deadline extension. All on logical time (watchdogClock), so
 * the ordering each test pins is exact and crossing a window costs nothing. The runPi wiring
 * these drive — spawn, stream decoding, stall warnings, session lifecycle, and stderr
 * classification — stays in test/pi.test.ts. */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runPi } from "../src/pi/pi.js";
import { startPiWatchdogs } from "../src/pi/pi-watchdogs.js";
import { defaultConfig } from "../src/config/config.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { withPi } from "./fakes/fake-pi.js";
import { flushImmediate, waitForLogLines, watchdogClock } from "./helpers/wait.js";
import type { SleepSample } from "../src/build/host-sleep.js";
import { assistantLine } from "./fixtures/pi-events.js";
import { ownerAliveSh } from "./fixtures/victim-fixture.js";
import { runPiFixture } from "./helpers/pi-run-harness.js";

// The quiet watchdog's kill is reported as quietKilled, not timedOut: a hung tool call leaves
// its session and worktree edits intact, so the runner resumes them instead of discarding hours
// of work for the next run's reset (BUGS.md 2026-09-12).
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
      assert.equal(result.timedOut, false, "a hung tool call is not a run timeout");
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
// replaced that unbounded exemption (which delegated its bound to runTimeoutSeconds, and
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
// emits a byte was bounded only by runTimeoutSeconds, which operators raise for unrelated
// reasons (the live config's 54000 s left a wedged model connection 15 hours in a
// concurrency slot). The zero-byte bound is now max(two quiet windows, 30 min), independent
// of the run timeout. This pins that a byte-silent run is reaped by the quiet watchdog —
// reported quietKilled, so the runner resumes it — with a run timeout set far beyond the
// bound; under the old exemption this run never settles short of the real 2 h timeout.
test("a run that never emits a byte is quiet-killed at 30 minutes regardless of the run timeout", async (t) => {
  const dir = tmpdir();
  const config = defaultConfig();
  config.quietTimeoutSeconds = 2; // zero-byte bound = max(2 × 2 s, 30 min) = 30 min
  config.runTimeoutSeconds = 7200; // far beyond the zero-byte bound: it must not be the reaper
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
      assert.equal(result.timedOut, false, "the run timeout is not the zero-byte bound");
      assert.match(result.errorMessage ?? "", /killed as hung/);
    },
  );
});

// BUGS.md 2026-10-07: a gate run (the reviewer, the merge conflict resolver) runs a fresh
// session every time, so a deadline that fires mid-verification throws away everything it
// read and the next attempt re-reads a large diff from scratch. A gate run that is still
// making progress at its deadline therefore gets one extension of the same length. These
// three tests pin the extension, its one-shot bound, and the discrimination from a run that
// has stopped progressing — all on logical time.
test("a gate run still progressing at its deadline gets one extension and finishes", async (t) => {
  const dir = tmpdir();
  const config = defaultConfig();
  config.runTimeoutSeconds = 2;
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
  config.runTimeoutSeconds = 2;
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
        "a run whose progress stopped before the checkpoint is not progressing, even though the quiet window is longer than the run budget",
      );
      assert.match(result.errorMessage ?? "", /timed out after 2s/);
      assert.doesNotMatch(result.errorMessage ?? "", /after 4s/);
    },
  );
});

test("a gate run's extension is one-shot: the second deadline kills it at twice the budget", async (t) => {
  const dir = tmpdir();
  const config = defaultConfig();
  config.runTimeoutSeconds = 2;
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
  config.runTimeoutSeconds = 2;
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

// BUGS.md 2026-10-26: the deadline's "still making progress" classification compared the live
// progress count against a single checkpoint snapshot. When an event-loop stall makes the
// checkpoint and the deadline fire in the same drain — a firing timers phase precedes the
// poll phase that delivers stdout — both read the same already-final count, so a run still
// emitting progress was mis-classified as stalled and its work discarded (the runner-5
// quarantine). The deadline now gives a run that has begun producing progress one short grace
// to drain queued output and re-prove itself before discarding. Pinned directly on
// startPiWatchdogs so the ordering is exact: the count is flat at the deadline, then the run's
// output lands in the grace, and the run is classified as still progressing — the discard
// keeps only a run the grace finds still flat.
test("a deadline whose checkpoint read the same drained count resumes a run that proves progress in the grace (regression)", (t) => {
  const clock = watchdogClock(t, { timeouts: true }); // the deadline and the grace share the logical clock
  let progress = 0;
  let killed = false;
  let killedProgressing: boolean | undefined = undefined;
  const wd = startPiWatchdogs({
    progressCount: () => progress,
    openToolCalls: () => [],
    runTimeoutMs: 2000,
    quietMs: 0,
    stallMs: 0,
    extendOnProgress: false, // an authoring run: no extension, only the classification
    kill: () => {
      killed = true;
      killedProgressing = wd.timedOutProgressing; // read live, as the run's close handler would
    },
  });
  progress = 1; // one structured progress event landed long before the checkpoint
  clock.advance(1000); // the checkpoint fires and snapshots count 1
  assert.equal(killed, false, "the deadline has not yet fired");
  // The stall: the checkpoint and the deadline both fire in the same drain, so the deadline
  // reads the same flat count (1) — and yet the run is still emitting.
  clock.advance(1000); // the base deadline fires with the count still flat
  assert.equal(killed, false, "a begun run is not discarded before its grace can prove it");
  progress = 2; // the run's queued output lands within the grace
  clock.advance(250); // the grace elapses
  assert.equal(killed, true, "the deadline finally kills the run");
  assert.equal(
    killedProgressing,
    true,
    "a run that proved progress in the grace is resumed, not discarded",
  );
});

// BUGS.md host sleep part 2/3: the run deadline counts wall time, so a host that slept through
// most of the budget used the budget up without the run doing any work and was killed as timed
// out. A deadline that fires after a measured sleep re-arms for the slept time instead, so the
// budget is spent on awake time. The host's sleep is scripted: the wall clock (Date.now) runs
// through it, while the boottime clock advances and the monotonic clock does not, which is how
// sleptMsBetween measures a sleep on Linux.
const MIN_MS = 60_000;

function sleepingHost(t: TestContext) {
  const clock = watchdogClock(t, { timeouts: true });
  const t0 = Date.now();
  let sleptTotal = 0; // the cumulative sleep the scripted host has taken so far
  const sampleSleep = async () => {
    const wall = Date.now() - t0;
    return { bootMs: 1_000 + wall, monoNs: BigInt(wall - sleptTotal) * 1_000_000n };
  };
  return {
    clock,
    sampleSleep,
    sleep(ms: number) {
      sleptTotal += ms;
      clock.advance(ms);
    },
  };
}

// The sampler's promise settles in microtasks the mocked clock does not drive, so a test lets
// them run before it reads the kill decision.
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("a run deadline that fires after a 45-minute host sleep is re-armed, and killed only after 60 awake minutes (BUGS.md host sleep part 2/3)", async (t) => {
  const host = sleepingHost(t);
  let killed = false;
  const warnings: string[] = [];
  const wd = startPiWatchdogs({
    progressCount: () => 0,
    openToolCalls: () => [],
    runTimeoutMs: 60 * MIN_MS,
    quietMs: 0,
    stallMs: 0,
    extendOnProgress: false,
    sampleSleep: host.sampleSleep,
    onStallWarning: (message) => warnings.push(message),
    kill: () => {
      killed = true;
    },
  });
  host.clock.advance(15 * MIN_MS); // 15 awake minutes
  host.sleep(45 * MIN_MS); // the lid is closed: the deadline fires at wall 60 with 45 asleep
  await settle();
  assert.equal(killed, false, "a deadline that fires after a host sleep is not a kill");
  assert.equal(wd.timedOut, false, "the run is not flagged timed out at the first firing");
  assert.equal(wd.timeoutBudgetMs, 60 * MIN_MS, "the budget stays the configured 60 minutes");
  assert.equal(warnings.length, 1, "one re-arm leaves one warning");
  assert.match(warnings[0] ?? "", /ran while the host slept 2700s/, "the warning names the slept duration");
  host.clock.advance(44 * MIN_MS); // wall 104: 59 awake minutes
  await settle();
  assert.equal(killed, false, "the run is not killed before its 60 awake minutes");
  host.clock.advance(1 * MIN_MS); // wall 105: 60 awake minutes
  await settle();
  assert.equal(killed, true, "the run is killed once its 60 awake minutes have passed");
  assert.equal(wd.timedOut, true, "the kill is reported as a run timeout");
  assert.equal(wd.timeoutBudgetMs, 60 * MIN_MS, "the kill message's budget is still 60 minutes");
  wd.stop();
});

test("a run deadline with no host sleep recorded is killed at its first firing, as before (BUGS.md host sleep part 2/3)", async (t) => {
  const host = sleepingHost(t);
  let killed = false;
  const wd = startPiWatchdogs({
    progressCount: () => 0,
    openToolCalls: () => [],
    runTimeoutMs: 60 * MIN_MS,
    quietMs: 0,
    stallMs: 0,
    extendOnProgress: false,
    sampleSleep: host.sampleSleep,
    kill: () => {
      killed = true;
    },
  });
  host.clock.advance(60 * MIN_MS);
  await settle();
  assert.equal(killed, true, "an awake deadline kills at its first firing");
  assert.equal(wd.timedOut, true);
  wd.stop();
});

// The per-call stall-kill (PLANS.md 2026-11-11, the user's Option A): a single tool call
// that hangs past two quiet windows kills the run and resumes it on the same model, so a
// hung tool self-resolves instead of holding a "looks stuck" banner until the run deadline.
// These pin the kill's timing and its discrimination from the total-silence quiet kill on
// logical time, directly against the watchdog's deps — the parser and spawn wiring that an
// end-to-end fake-pi run would also exercise stay in test/pi.test.ts. The one thing the
// quiet kill cannot see: a run that keeps trickling progress (refreshing its window) while
// ONE open call sits hung. `killStalledCallCheck` reads each open call's own activity clock,
// so it kills on the call even though the run as a whole is not silent.
function stalledCallDeps(quietMs: number, stallMs: number, staleCall: () => { id: string; label: string; lastActivityAt: number }): { wd: ReturnType<typeof startPiWatchdogs>; kill: () => boolean; stop: () => void } {
  let killed = false;
  const wd = startPiWatchdogs({
    // A run that keeps trickling progress: count rises with the (mocked) clock, so the
    // total-silence quiet kill's window is refreshed at every tick and never fires. This is
    // the case the per-call stall-kill exists for — the quiet kill would not see it.
    progressCount: () => Math.floor(Date.now() / 250),
    openToolCalls: () => [staleCall()],
    runTimeoutMs: 3_600_000, // far out: the deadline is not the reaper here
    quietMs,
    stallMs,
    kill: () => {
      killed = true;
    },
  });
  wd.noteByte(); // the run has begun: the stall-kill's `sawOutput` gate is satisfied
  return { wd, kill: () => killed, stop: () => wd.stop() };
}
test("a stalled tool call kills the run at two quiet windows while the run keeps progressing", (t) => {
  const clock = watchdogClock(t);
  // `now` is the real time captured at enable; pin the call's last activity to it so its age
  // is exactly the clock's advance. quietMs 2000 -> stall-kill bound 4000, quiet window 2000.
  const t0 = Date.now();
  const stale = () => ({ id: "c1", label: "sleep 999", lastActivityAt: t0 });
  const { wd, kill, stop } = stalledCallDeps(2000, 0, stale); // stallMs 0: no warning, kill only
  clock.advance(3_500); // just under the 4000 bound (one quiet window = 2000, bound = 4000)
  assert.equal(wd.stallKilled, false, "a call under the two-window bound is not killed");
  assert.equal(wd.quietKilled, false, "a progressing run is not quiet-killed");
  assert.equal(kill(), false, "no kill yet");
  clock.advance(1_000); // cross the 4000 bound
  assert.equal(wd.stallKilled, true, "the hung call is killed at two quiet windows");
  assert.equal(wd.quietKilled, false, "a progressing run is never quiet-killed");
  assert.equal(kill(), true, "the stall-kill stops the run");
  assert.equal(wd.stallKilledLabel, "sleep 999", "the kill names the hung call");
  stop();
});
test("a still-updating tool call is never stall-killed", (t) => {
  const clock = watchdogClock(t);
  // A call whose lastActivityAt tracks the clock receives content-bearing updates, so its age
  // stays ~0 and it never reaches the bound — INV-A8. This is the false-kill the two-window
  // scale (never below one quiet window) and the shared activity clock guard against.
  const alive = () => ({ id: "c1", label: "tail -f log", lastActivityAt: Date.now() });
  const { wd, kill, stop } = stalledCallDeps(2000, 0, alive);
  clock.advance(30_000); // far past any bound
  assert.equal(wd.stallKilled, false, "a call that keeps updating is not killed");
  assert.equal(wd.quietKilled, false, "and the still-progressing run is not quiet-killed");
  assert.equal(kill(), false);
  stop();
});
test("the stall-kill never fires when the quiet watchdog is disabled (quietMs 0)", (t) => {
  const clock = watchdogClock(t);
  const t0 = Date.now();
  const stale = () => ({ id: "c1", label: "sleep 999", lastActivityAt: t0 });
  // quietMs 0 disables the kill (the bound is derived from it); stallMs 1000 keeps the
  // interval ticking (so the code path runs) but only warnings may fire.
  const { wd, kill, stop } = stalledCallDeps(0, 1000, stale);
  clock.advance(60_000);
  assert.equal(wd.stallKilled, false, "0 disables the stall-kill, as it disables the quiet kill");
  assert.equal(wd.quietKilled, false);
  assert.equal(kill(), false);
  stop();
});
test("the total-silence quiet kill fires first and the stall-kill does not override it", (t) => {
  const clock = watchdogClock(t);
  const t0 = Date.now(); // the mock start; pin the call's age to it (a fixed, not moving, time)
  let killed = false;
  const wd = startPiWatchdogs({
    // Flat progress (count 1, never rises) and a stale open call: once the run stops
    // refreshing its window, the quiet window (2000, progress>0) fires — and on a later
    // tick, once the call is far past the 4000 stall bound, the `quietKilled` guard keeps
    // the stall-kill from firing too. The two kills are mutually exclusive on the state.
    progressCount: () => 1,
    openToolCalls: () => [{ id: "c1", label: "sleep 999", lastActivityAt: t0 }],
    runTimeoutMs: 3_600_000,
    quietMs: 2000,
    stallMs: 0,
    kill: () => {
      killed = true;
    },
  });
  wd.noteByte();
  clock.advance(5_000); // the quiet window fires first; the call is now well past the stall bound
  assert.equal(wd.quietKilled, true, "a run that stops progressing is quiet-killed");
  assert.equal(wd.stallKilled, false, "the quiet kill wins; the stall-kill never overrides it");
  assert.equal(killed, true);
  wd.stop();
});

// BUGS.md 2026-11-21 (part 1/3): the quiet watch judges every silence in awake time. A host sleep
// is not model or tool silence, so a run silent only across a recorded sleep is not quiet-killed,
// and a wait on a model reply or an open call restarts from the wake. The host is scripted: its
// wall clock runs through a suspend and its monotonic clock does not — the pair sleptMsBetween
// reads on Linux (src/build/host-sleep.ts) — so no real machine ever suspends.
function scriptedHost(clock: ReturnType<typeof watchdogClock>) {
  let asleepMs = 0;
  return {
    sampleSleep: async (): Promise<SleepSample> => ({
      bootMs: Date.now(),
      monoNs: BigInt((Date.now() - asleepMs) * 1_000_000),
    }),
    suspend(ms: number): void {
      asleepMs += ms;
      clock.suspend(ms);
    },
  };
}

test("a run silent only across a recorded host sleep is not quiet-killed", async (t) => {
  const clock = watchdogClock(t);
  const host = scriptedHost(clock);
  let progress = 0;
  let killed = false;
  const wd = startPiWatchdogs({
    progressCount: () => progress,
    openToolCalls: () => [],
    runTimeoutMs: 3 * 3_600_000,
    quietMs: 30 * 60_000,
    stallMs: 0,
    sampleSleep: host.sampleSleep,
    kill: () => {
      killed = true;
    },
  });
  await flushImmediate(); // the baseline sample lands
  progress = 1;
  clock.advance(30_000); // the first check sees the progress
  host.suspend(40 * 60_000); // the lid closes for 40 minutes: the first check after the wake
  await flushImmediate(); // the sample that records the sleep lands
  assert.equal(killed, false, "a 40-minute sleep is not 40 minutes of silence");
  clock.advance(30_000); // 30 awake seconds since the progress: under the 30-minute window
  assert.equal(killed, false);
  progress = 2; // the next progress arrives right after wake
  clock.advance(30_000);
  assert.equal(killed, false);
  assert.equal(wd.quietKilled, false);
  wd.stop();
});

test("the same silence with no host sleep recorded is still quiet-killed", async (t) => {
  const clock = watchdogClock(t);
  const host = scriptedHost(clock);
  let progress = 0;
  let killed = false;
  const wd = startPiWatchdogs({
    progressCount: () => progress,
    openToolCalls: () => [],
    runTimeoutMs: 3 * 3_600_000,
    quietMs: 30 * 60_000,
    stallMs: 0,
    sampleSleep: host.sampleSleep,
    kill: () => {
      killed = true;
    },
  });
  await flushImmediate();
  progress = 1;
  clock.advance(30_000);
  clock.advance(40 * 60_000); // 40 awake minutes with no progress
  assert.equal(killed, true, "40 awake minutes of silence is a hang");
  assert.equal(wd.quietKilled, true);
  wd.stop();
});

// The entry's last acceptance criterion: an empty sample (a platform with no sleep clock, or a
// failed read) records no span, so the watch keeps today's wall-clock reading. A detected gap
// must never be read as sleep without measured evidence: the same 40-minute gap a recorded sleep
// forgives is a quiet kill when the sampler reads nothing.
test("a sleep sampler that reads no sleep clock keeps the wall-clock quiet kill", async (t) => {
  const clock = watchdogClock(t);
  let progress = 0;
  let killed = false;
  const wd = startPiWatchdogs({
    progressCount: () => progress,
    openToolCalls: () => [],
    runTimeoutMs: 3 * 3_600_000,
    quietMs: 30 * 60_000,
    stallMs: 0,
    sampleSleep: async () => ({}),
    kill: () => {
      killed = true;
    },
  });
  await flushImmediate(); // the empty baseline sample lands
  progress = 1;
  clock.advance(30_000); // the first check sees the progress
  clock.suspend(40 * 60_000); // the gap a host sleep would leave, with no clock to measure it
  await flushImmediate(); // the empty gap sample lands: no span is recorded
  clock.advance(30_000); // 40 wall minutes, none of them measured sleep
  assert.equal(killed, true, "an unmeasured gap is silence, not sleep");
  assert.equal(wd.quietKilled, true);
  wd.stop();
});

test("a model reply waited across a host sleep warns on its awake wait only", async (t) => {
  const clock = watchdogClock(t);
  const host = scriptedHost(clock);
  const warnings: string[] = [];
  const since = Date.now();
  const wd = startPiWatchdogs({
    progressCount: () => 0,
    openToolCalls: () => [],
    pendingReply: () => ({ since, target: "p/m", attempts: 1 }),
    runTimeoutMs: 3 * 3_600_000,
    quietMs: 0,
    stallMs: 5 * 60_000,
    sampleSleep: host.sampleSleep,
    kill: () => {},
    onStallWarning: (message) => warnings.push(message),
  });
  await flushImmediate();
  clock.advance(3 * 60_000); // 3 awake minutes of wait: under the 5-minute threshold
  host.suspend(22 * 60_000); // 22 minutes asleep inside the same wait
  await flushImmediate();
  clock.advance(30_000);
  assert.deepEqual(warnings, [], "25 wall minutes, 22 of them asleep, is 3 awake minutes");
  clock.advance(90_000); // 5 awake minutes
  assert.deepEqual(warnings, ["model request unanswered: p/m — no reply for 5m"]);
  wd.stop();
});

test("an open tool call silent across a host sleep is warned on its awake silence only", async (t) => {
  const clock = watchdogClock(t);
  const host = scriptedHost(clock);
  const warnings: string[] = [];
  const lastActivityAt = Date.now();
  const wd = startPiWatchdogs({
    progressCount: () => 1,
    openToolCalls: () => [{ id: "c1", label: "bash sleep 999", command: "sleep 999", lastActivityAt }],
    runTimeoutMs: 3 * 3_600_000,
    quietMs: 30 * 60_000,
    stallMs: 5 * 60_000,
    sampleSleep: host.sampleSleep,
    kill: () => {},
    onStallWarning: (message) => warnings.push(message),
  });
  wd.noteByte(); // the run has begun, so the per-call stall-kill is armed too
  await flushImmediate();
  clock.advance(3 * 60_000); // 3 awake minutes of silence: under the 5-minute threshold
  host.suspend(22 * 60_000); // 22 minutes asleep with the call still open
  await flushImmediate();
  clock.advance(30_000);
  assert.deepEqual(warnings, [], "25 wall minutes, 22 of them asleep, is 3 awake minutes of silence");
  assert.equal(wd.stallKilled, false);
  clock.advance(90_000); // 5 awake minutes
  assert.deepEqual(warnings, ["tool call stalled: bash sleep 999 — no output for 5m"]);
  assert.equal(wd.stallKilled, false, "one warned bound is not the two-window stall kill");
  wd.stop();
});
