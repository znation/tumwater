/** A scripted sleep clock for tests of the sleep-attributing checks (build-check,
 * main-baseline, main-red's gate, review's pre-check): each attempt samples the clock twice
 * (open, close), so the samples hand the measurement its evidence and a test can put a host
 * sleep inside one attempt and none inside the next — no test can suspend the real host.
 * The single home of the `scriptedSampler`/`woke` pair — it lived as four per-file copies
 * (build-check, main-baseline, main-red, review-precheck), three of them annotated "like
 * build-check.test.ts's" while drifting as separate definitions. */
import assert from "node:assert/strict";
import type { SleepSample, SleepSampler } from "../src/build/host-sleep.js";

/** A sampler whose samples are consumed in order; asserts when a check samples more times
 * than the test scripted, so under-specified expectations fail loudly instead of reading as
 * an unslept (clean) attempt. */
export function scriptedSampler(samples: SleepSample[]): SleepSampler {
  return () => {
    assert.ok(samples.length > 0, "more sleep-clock samples were taken than scripted");
    return Promise.resolve(samples.shift()!);
  };
}

/** One scripted sample: the host woke at `lastWakeMs` after sleeping `lastSleepMs` (unset
 * when the sample is a clock open with nothing behind it). */
export const woke = (lastWakeMs: number, lastSleepMs?: number): SleepSample => ({
  lastWakeMs,
  lastSleepMs,
});
