import test from "node:test";
import assert from "node:assert/strict";
import { sampleSleepClock, sleptMsBetween, type SleepSample } from "../src/host-sleep.js";

// Unit coverage for the measured host sleep (src/host-sleep.ts): the two measurement paths —
// Linux's boottime-vs-monotonic divergence and macOS's sleep-start→wake span — driven by
// synthetic samples, because no test can suspend the host. The regression these pin is
// BUGS.md 2026-09-30: a sleep inside a check's run must leave a measured trace, not only the
// deadlineLateMs a late timer leaves.

const wake = (lastWakeMs: number, lastSleepMs?: number): SleepSample => ({ lastWakeMs, lastSleepMs });
const boot = (bootMs: number, monoMs: number): SleepSample => ({ bootMs, monoNs: BigInt(monoMs) * 1_000_000n });

test("sleptMsBetween measures Linux suspended time as the boottime clock's divergence", () => {
  // 8 s of boottime (CLOCK_BOOTTIME) elapsed while the monotonic clock moved 2 s: 6 s asleep.
  assert.equal(sleptMsBetween(boot(1_000, 1_000), boot(9_000, 3_000)), 6_000);
});

test("sleptMsBetween reads zero when a Linux host stayed awake", () => {
  assert.equal(sleptMsBetween(boot(1_000, 1_000), boot(4_000, 4_000)), 0);
});

test("sleptMsBetween measures the macOS newest sleep's span when a wake fell inside the window", () => {
  // The host woke at 61 s mid-window; that sleep began at 5 s. 56 s suspended.
  assert.equal(sleptMsBetween(wake(1_000), wake(61_000, 5_000)), 56_000);
});

test("sleptMsBetween reads zero on macOS when no new wake fell inside the window", () => {
  assert.equal(sleptMsBetween(wake(1_000), wake(1_000)), 0);
});

test("sleptMsBetween falls back to the opening sample when the sleep stamp is missing", () => {
  // kern.sleeptime unreadable: the wake still proves sleep; the span degrades to the whole
  // window rather than dropping the evidence.
  assert.equal(sleptMsBetween(wake(1_000), wake(1_000)), 0, "no new wake is still no sleep");
  assert.equal(sleptMsBetween(wake(1_000, 500), wake(61_000, undefined)), 60_000);
});

test("sleptMsBetween returns undefined when either sample has no sleep clock", () => {
  assert.equal(sleptMsBetween({}, {}), undefined);
  assert.equal(sleptMsBetween(boot(1_000, 1_000), {}), undefined);
  assert.equal(sleptMsBetween(wake(1_000), boot(1_000, 1_000)), undefined);
});

test("sampleSleepClock reads the macOS sleep clocks", { skip: process.platform !== "darwin" }, async () => {
  const sample = await sampleSleepClock();
  // The kernel's last wake is in the past and near the current wall clock on an awake host.
  assert.ok(sample.lastWakeMs !== undefined && Number.isFinite(sample.lastWakeMs));
  assert.ok(sample.lastWakeMs! <= Date.now());
  assert.ok(sample.lastSleepMs === undefined || sample.lastSleepMs <= sample.lastWakeMs!);
});
