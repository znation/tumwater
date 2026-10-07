import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { sampleSleepClock, sleptMsBetween, type SleepSample } from "../src/build/host-sleep.js";

/** Pin the platform for one test and restore it, the same pattern test/process.test.ts uses:
 * the real clocks differ per OS, but the branch logic under test runs wherever the platform
 * says it does. */
async function withPlatform<T>(platform: string, run: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform });
  try {
    return await run();
  } finally {
    if (original) Object.defineProperty(process, "platform", original);
  }
}

// Unit coverage for the measured host sleep (src/build/host-sleep.ts): the two measurement paths —
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

test("sampleSleepClock on Linux reads /proc/uptime's boottime clock beside the monotonic clock", async (t) => {
  // The Linux branch reads /proc/uptime — the dev box is a Mac and never takes it, so pin the
  // platform and fake the kernel's file. The contract under test: the first field (CLOCK_BOOTTIME
  // seconds, which advances through suspend) is scaled to ms and paired with the monotonic
  // hrtime taken at the same instant, so sleptMsBetween can difference the two clocks.
  const read = t.mock.method(fs, "readFileSync", (path: fs.PathOrFileDescriptor) => {
    assert.equal(path, "/proc/uptime");
    return "12345.5 4021.8\n";
  });
  const sample = await withPlatform("linux", sampleSleepClock);
  assert.equal(read.mock.calls.length, 1);
  assert.equal(sample.bootMs, 12_345_500);
  assert.equal(typeof sample.monoNs, "bigint");
  assert.ok(sample.monoNs! > 0n, "the monotonic clock is past boot");
});

test("sampleSleepClock on Linux yields an empty sample when /proc/uptime is unreadable", async (t) => {
  // A container or a hardened kernel can hide /proc/uptime; the contract is that a missing
  // clock reads as an empty sample — no sleep evidence, never a wrong number.
  t.mock.method(fs, "readFileSync", () => {
    throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
  });
  const sample = await withPlatform("linux", sampleSleepClock);
  assert.deepEqual(sample, {});
});

test("sampleSleepClock on Linux yields an empty sample when /proc/uptime is not a number", async (t) => {
  // A first field Number() cannot parse (a changed format, an empty file) fails the finite
  // guard and degrades to an empty sample rather than NaN downstream.
  t.mock.method(fs, "readFileSync", () => "n/a 0.0\n");
  const sample = await withPlatform("linux", sampleSleepClock);
  assert.deepEqual(sample, {});
});

test("sampleSleepClock yields an empty sample on a platform with neither clock", async () => {
  // Neither darwin's sysctl pair nor Linux's /proc/uptime: no readable clock at all.
  const sample = await withPlatform("sunos", sampleSleepClock);
  assert.deepEqual(sample, {});
});
