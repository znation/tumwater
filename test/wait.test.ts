/** Unit pins for the deadline waits' injectable `WaitClock` (test/helpers/wait.ts): a `fakeClock`
 * must decide waitFor's and waitForFile's expiry, so host load can never spend a budget the test
 * set. The live-CLI seam's own test is test/cli-harness.test.ts; these are the helper-level
 * cases the poll-deadline conversion (PLANS.md part 2/5) promises. */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { awaitQuietHost, waitFor, waitForFile } from "./helpers/wait.js";
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

test("awaitQuietHost returns once the injected sampler crosses to quiet", async () => {
  const clock = fakeClock();
  let load = 8;
  const result = await awaitQuietHost(100_000, () => ({ load1: load, cpus: 4 }), clock);
  assert.ok(!result.quiet);
  load = 2;
  const second = await awaitQuietHost(100_000, () => ({ load1: load, cpus: 4 }), clock);
  assert.ok(second.quiet, "a host that drops below the bar at any point runs");
});
