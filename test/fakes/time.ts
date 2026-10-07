/** Injectable clocks and sleeps for deadline/window logic, under the shared test-fake
 * catalog (test/fakes/, PLANS.md 2026-10-04). No test can suspend the real host or live
 * through a real minute-scale wait: every timer the harness honors through a parameter
 * accepts these fakes instead. Like src's `todayStamp` injectability, the fake is passed in,
 * never monkey-patched onto a module under test. Node built-ins only (PRINCIPLES.md). */

/** A fake wall clock the test advances by hand: `now()` answers the current fake time and
 * `advance(ms)` moves it forward (backwards too, for window-boundary cases). Sleeps through
 * `sleep(ms)` also advance the clock, so code that sleeps then re-checks its deadline sees
 * the passage of time a real `setTimeout` would have given it — instantly. */
export function fakeClock(startMs = 0): {
  now(): number;
  advance(ms: number): void;
  sleep(ms: number): Promise<void>;
} {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    advance: (ms: number) => {
      nowMs += ms;
    },
    sleep: async (ms: number) => {
      nowMs += ms;
    },
  };
}

/** A sleep that records every wait it was asked for and resolves instantly — the collector
 * the retry-policy tests hand to code that takes an injectable sleep, replacing the
 * per-test `const sleeps: number[] = []; async (ms) => { sleeps.push(ms); }` closure. The
 * recorded list is the assertion surface: the waits themselves are never lived through. */
export function sleepRecorder(): { sleeps: number[]; sleep: (ms: number) => Promise<void> } {
  const sleeps: number[] = [];
  return {
    sleeps,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  };
}
