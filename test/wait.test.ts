/** Unit pins for the deadline waits' injectable `WaitClock` (test/helpers/wait.ts): a `fakeClock`
 * must decide waitFor's and waitForFile's expiry, so host load can never spend a budget the test
 * set. The live-CLI seam's own test is test/cli-harness.test.ts; these are the helper-level
 * cases the poll-deadline conversion (PLANS.md part 2/5) promises. */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { awaitQuietHost, recheckQuietHost, waitFor, waitForFile, waitForQuietHost } from "./helpers/wait.js";
import { fakeClock } from "./fakes/time.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

test("waitFor's deadline is the injected clock's, so crossing it expires without real time", async () => {
  const clock = fakeClock();
  await assert.rejects(waitFor(() => false, "the thing", 1_000, clock), /timed out waiting for the thing/);
  assert.ok(clock.now() > 1_000, `the injected clock crossed the budget; saw ${clock.now()}`);
});

test("waitFor returns as soon as the predicate holds, without spending the injected budget", async () => {
  const clock = fakeClock();
  let polls = 0;
  await waitFor(() => ++polls >= 3, "three polls", 10_000, clock);
  assert.ok(clock.now() < 10_000, `the wait must not spend its budget; saw ${clock.now()}`);
});

test("waitForFile's deadline is the injected clock's", async () => {
  const clock = fakeClock();
  const missing = path.join(tmpdir(), "wait-for-file-missing");
  await assert.rejects(waitForFile(missing, 100, clock), /timed out waiting for/);
  assert.ok(clock.now() > 100, `the injected clock crossed the budget; saw ${clock.now()}`);
});

test("awaitQuietHost returns immediately under a quiet injected sampler", async () => {
  const clock = fakeClock();
  const result = await awaitQuietHost(300_000, () => ({ load1: 1, cpus: 4 }), clock);
  assert.ok(result.quiet);
  assert.equal(result.load1, 1);
  assert.equal(clock.now(), 0, "a quiet host must not spend the wait budget");
});

test("awaitQuietHost defers after the bounded wait under a saturated injected sampler", async () => {
  const clock = fakeClock();
  const result = await awaitQuietHost(100_000, () => ({ load1: 8, cpus: 4 }), clock);
  assert.ok(!result.quiet, "a host saturated for the whole wait must defer, never run starved");
  assert.ok(clock.now() >= 100_000, `the bounded wait must elapse; saw ${clock.now()}`);
  assert.equal(result.cpus, 4);
});

test("awaitQuietHost defers a near-bar host whose 5-minute average is still elevated", async () => {
  // The flake: the 1-minute load dipped below the core count (so the old `load1 <= cpus` gate
  // admitted the test) while the sustained 5-minute average was still above it, so the admitted
  // run then starved its 150 s spawn wait. With the fix the gate also reads load5 and defers.
  const clock = fakeClock();
  const result = await awaitQuietHost(100_000, () => ({ load1: 3, load5: 12, cpus: 4 }), clock);
  assert.ok(!result.quiet, "a host at/below the bar on 1-minute but elevated on 5-minute must defer, never run starved");
  assert.ok(clock.now() >= 100_000, `the bounded wait must elapse; saw ${clock.now()}`);
  assert.equal(result.load1, 3);
  assert.equal(result.load5, 12);
});

test("awaitQuietHost returns once the injected sampler crosses to quiet", async () => {
  const clock = fakeClock();
  let load = 8;
  const result = await awaitQuietHost(100_000, () => ({ load1: load, cpus: 4 }), clock);
  assert.ok(!result.quiet);
  load = 2;
  const second = await awaitQuietHost(100_000, () => ({ load1: load, cpus: 4 }), clock);
  assert.ok(second.quiet, "a host that drops below the bar at any point runs");
});

test("recheckQuietHost is quiet on a quiet injected sampler", async () => {
  const result = recheckQuietHost(() => ({ load1: 1, load5: 2, cpus: 4 }));
  assert.ok(result.quiet);
  assert.equal(result.load1, 1);
  assert.equal(result.load5, 2);
  assert.equal(result.cpus, 4);
});

test("recheckQuietHost defers a host that re-saturated after it was admitted", async () => {
  // The flake: the at-admission gate (awaitQuietHost) saw a below-bar sample and admitted the test,
  // but the 5-minute average re-rose over the core count in the meantime, so the 150 s spawn wait
  // would starve. The re-check the test applies just before that wait must defer, not run starved.
  const result = recheckQuietHost(() => ({ load1: 2, load5: 32, cpus: 18 }));
  assert.ok(!result.quiet, "a host whose 5-minute average rose over the bar after admission must defer");
  assert.equal(result.load5, 32);
  assert.equal(result.cpus, 18);
});

test("recheckQuietHost defers a near-bar host whose 5-minute average sits just under the core count", async () => {
  // The residual flake (BUGS.md 2026-11-17): the single-sample re-check judged the host on the
  // core count itself, so 17.63 on 18 cores was admitted, and the 5-minute average is a TRAILING
  // mean — the host had just peaked and re-saturated inside the 150 s spawn wait, which starved.
  // The bar carries headroom, so a near-bar sample does not buy the 150 s wait.
  const result = recheckQuietHost(() => ({ load1: 17.63, load5: 17.63, cpus: 18 }));
  assert.ok(!result.quiet, "a host reading just under the core count must defer, not spend the 150 s wait");
  assert.equal(result.load5, 17.63);
  assert.equal(result.cpus, 18);
});

test("the quiet-host bar admits a host with headroom and defers one at the headroom boundary", async () => {
  // One fraction of the core count decides both halves, so the boundary is checkable: on 18 cores
  // the bar is 0.8 × 18 = 14.4, so 14.4 (at the bar, inclusive) runs and 14.41 does not. A host
  // at the old bar of exactly the core count is now deferred.
  assert.ok(recheckQuietHost(() => ({ load1: 14.4, load5: 14.4, cpus: 18 })).quiet, "14.4 = 0.8 * 18");
  assert.ok(!recheckQuietHost(() => ({ load1: 14.41, load5: 14.41, cpus: 18 })).quiet);
  // A sampler reporting no 5-minute reading is judged on its 1-minute reading against the same bar.
  assert.ok(recheckQuietHost(() => ({ load1: 3, cpus: 4 })).quiet, "3 <= 0.8 * 4 = 3.2");
  assert.ok(!recheckQuietHost(() => ({ load1: 3.3, cpus: 4 })).quiet, "3.3 > 3.2");
});

test("awaitQuietHost defers a near-bar host for the whole bounded wait instead of admitting it", async () => {
  // The at-admission half of the same bar: a host reading 17.63 on 18 cores must never be let in,
  // so the gate spends its bounded wait and defers rather than starving the run it admitted.
  const clock = fakeClock();
  const result = await awaitQuietHost(100_000, () => ({ load1: 5, load5: 17.63, cpus: 18 }), clock);
  assert.ok(!result.quiet, "a near-bar host must defer at admission, not run and starve");
  assert.ok(clock.now() >= 100_000, `the bounded wait must elapse; saw ${clock.now()}`);
  assert.equal(result.load5, 17.63);
});

test("waitForQuietHost defers the moment a mid-wait sample crosses, without living the wait", async () => {
  // The flake (BUGS.md 2026-11-17, 2026-11-20): a host under the bar at admission and at the
  // point-in-time re-check re-saturates INSIDE the 150 s spawn wait. The sampler is quiet until
  // clock.now() crosses 60 s, then reads 0.9 x cpus — over the 0.8 x cpus bar (3.2 on 4 cores,
  // so 3.6 crosses). The predicate never holds, so the first post-cross sample defers.
  const clock = fakeClock();
  const result = await waitForQuietHost(
    () => false,
    "never true",
    120_000,
    {
      clock,
      sample: () => (clock.now() < 60_000 ? { load1: 1, load5: 1, cpus: 4 } : { load1: 3.6, load5: 3.6, cpus: 4 }),
    },
  );
  assert.equal(result.deferred, true, "a crossing sample mid-wait defers, never a verdict");
  // The plan's criterion, read off the inputs rather than the code: the sampler crosses at 60 s
  // and the gate samples at most once per pollEvery (the 2 s default), so a correct gate defers
  // by 62 s — never after living through the 120 s budget it was supposed to cut short.
  assert.ok(clock.now() <= 62_000, `deferred no later than the post-cross sample; saw ${clock.now()}`);
  if (result.deferred) {
    assert.equal(result.load1, 3.6);
    assert.equal(result.load5, 3.6);
    assert.equal(result.cpus, 4);
  }
});

test("waitForQuietHost returns deferred:false once the predicate holds and reports no crossing", async () => {
  // A host that stays under the bar the whole wait: the predicate turning true at 60 s wins
  // before any sample reports a crossing, so the wait completes exactly as today and skips nothing.
  const clock = fakeClock();
  const result = await waitForQuietHost(
    () => clock.now() >= 60_000,
    "a predicate that turns true",
    120_000,
    { clock, sample: () => ({ load1: 1, load5: 1, cpus: 4 }) },
  );
  assert.equal(result.deferred, false, "a quiet host with a satisfied predicate completes the wait");
  assert.ok(clock.now() >= 60_000 && clock.now() <= 120_000, `completes when the predicate holds; saw ${clock.now()}`);
});

test("waitForQuietHost does not flip the verdict on a crossing sample after the predicate held", async () => {
  // The predicate holds from the start (first poll checks it before any sample), so a sampler
  // that would cross on every reading never outranks the satisfied predicate.
  const clock = fakeClock();
  const result = await waitForQuietHost(
    () => true,
    "a predicate that already holds",
    120_000,
    { clock, sample: () => ({ load1: 3.6, load5: 3.6, cpus: 4 }) },
  );
  assert.equal(result.deferred, false, "a crossing after the predicate held must not flip the verdict");
  assert.equal(clock.now(), 0, "an already-held predicate returns before any wait or sample");
});

test("waitForQuietHost expires a hung marker under the injected clock's deadline", async () => {
  // The deadline half: a marker that never holds and a host under the bar the whole wait expires
  // like waitFor's, instead of spinning forever — a genuinely hung spawn still reports.
  const clock = fakeClock();
  await assert.rejects(
    waitForQuietHost(() => false, "a hung marker", 1_000, { clock, sample: () => ({ load1: 1, load5: 1, cpus: 4 }) }),
    /timed out waiting for a hung marker/,
  );
  assert.ok(clock.now() > 1_000, `the injected clock crossed the budget; saw ${clock.now()}`);
});
