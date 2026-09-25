/** Wait-for-something helpers shared across the test suite: polling (waitFor, waitForFile,
 * waitForLogLines) and the logical clock for runPi's watchdog (watchdogClock). Split from
 * test/util.ts, whose grab-bag made these unfindable by name. */
import type { TestContext } from "node:test";
import fs from "node:fs";

/** The real setTimeout, captured when this module loads — before any test installs node:test
 * mock timers — so the wait helpers below keep polling in real time under a test that mocks
 * setTimeout itself (watchdogClock with `timeouts`). */
const realSetTimeout = globalThis.setTimeout;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => realSetTimeout(resolve, ms));

/** Poll until `fn` holds. `ms` is a DEADLINE, not a sleep — this returns the moment the
 * condition is true, so a generous budget costs nothing on the success path and buys only
 * slower reporting of a genuine hang. The default was 20s until 2026-09-18, when it became the
 * proximate cause of landing rejections: the fleet runs this suite concurrently with its own
 * ticks, and waits that complete in ~2s idle took past 20s loaded (BUGS.md). */
export async function waitFor(fn: () => boolean, what: string, ms = 60_000): Promise<void> {
  // performance.now(), not Date.now(): a test on watchdogClock has Date frozen between its
  // advances, and a deadline read off it would never expire.
  const deadline = performance.now() + ms;
  while (!fn()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

/** Poll until `file` exists (bounded), so a test can act only after the fake pi run has
 * done its work — a fixed sleep races process startup when the suite runs in parallel.
 * 30s: the landing gate runs the whole suite concurrently on a saturated machine, where
 * worktree setup plus fake-pi startup can blow a 10s budget (BUGS.md load-sensitive tests). */
export async function waitForFile(file: string, timeoutMs = 30_000): Promise<void> {
  const start = performance.now(); // monotonic, and live under watchdogClock (see waitFor)
  while (!fs.existsSync(file)) {
    if (performance.now() - start > timeoutMs) throw new Error(`timed out waiting for ${file}`);
    await sleep(25);
  }
}

/** Put runPi's watchdog (src/pi.ts: the quiet kill and the stall warning) on logical time for
 * the rest of test `t`. The watchdog is a setInterval that reads Date.now(), and open tool
 * calls are stamped with Date.now() (pi-event-line.ts); both become node:test mock timers,
 * started at the real current time. setTimeout stays real, so everything else a run or tick
 * does — spawns, git, locks, the tick timeout — keeps the wall clock. `timeouts: true` puts
 * setTimeout on the same clock, for a test of the tick timeout itself; it is safe only on a
 * path with no other timer to wait out (no contended lock, no rate-limit wait, no build
 * check). The wait helpers here poll on a real timer captured at load, so they work either way.
 *
 * The test moves the watchdog's time with `advance(ms)` at the points it chooses — once the
 * run's raw log shows what it is waiting on (waitForLogLines) — and every check due in that
 * span runs, in order, before advance returns. A real-time watchdog test can only pick
 * margins, which a loaded machine eats (BUGS.md 2026-09-18, 2026-09-21); logical time has no
 * jitter to eat, and a ten-second window costs nothing to cross. `release()` hands the clock
 * back early, for a later phase whose regression should end in a real-time kill rather than
 * hang on a clock nobody advances. */
export function watchdogClock(
  t: TestContext,
  opts: { timeouts?: boolean } = {},
): { advance(ms: number): void; release(): void } {
  t.mock.timers.enable({
    apis: opts.timeouts ? ["Date", "setInterval", "setTimeout"] : ["Date", "setInterval"],
    now: Date.now(),
  });
  return {
    // In steps of the watchdog's shortest check interval (250 ms): one tick(ms) sets the clock
    // to the END of the span before running what fell due, so every check in it would read the
    // same Date.now() and never see silence grow.
    advance: (ms) => {
      for (let left = ms; left > 0; left -= 250) t.mock.timers.tick(Math.min(250, left));
    },
    release: () => t.mock.timers.reset(),
  };
}

/** Wait, in real time, until `file` holds at least `count` lines containing `needle` — how a
 * watchdogClock test knows runPi has parsed the fake pi's output before it advances the
 * clock: runPi writes each stdout line to its raw log in the same synchronous step that feeds
 * the parser, so a line on disk is a line the watchdog has already seen. Resolves true once
 * the lines are there — or false as soon as `stop()` holds, for a test that interleaves
 * advances with fresh output until the run it drives has ended and will print nothing more. */
export async function waitForLogLines(
  file: string,
  needle: string,
  count = 1,
  stop?: () => boolean,
): Promise<boolean> {
  const start = performance.now();
  for (;;) {
    let n = 0;
    try {
      for (const line of fs.readFileSync(file, "utf8").split("\n")) if (line.includes(needle)) n++;
    } catch {
      // Not written yet.
    }
    if (n >= count) return true;
    if (stop?.()) return false;
    if (performance.now() - start > 30_000)
      throw new Error(`timed out waiting for ${count} line(s) containing ${JSON.stringify(needle)} in ${file}`);
    await sleep(10);
  }
}
