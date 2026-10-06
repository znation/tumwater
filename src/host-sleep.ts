/** Measured host sleep inside a time window — the evidence that lets the harness tell "the
 * build failed" from "the host was asleep while the build ran". The fleet's host is a laptop
 * in clamshell maintenance sleep (BUGS.md 2026-09-21 logged 569 sleeps over three days), and
 * a sleep shorter than a check's remaining deadline but longer than a test's own wall-clock
 * wait expires that wait at the next wake: the suite exits nonzero INSIDE the deadline, so
 * the run carries no deadlineLateMs, and every caller reads a deterministic rejection
 * (BUGS.md 2026-09-30). What makes the two distinguishable is a measured suspended time, and
 * each platform exposes one differently:
 *
 * - **macOS:** the kernel stamps when it last went to sleep (`sysctl kern.sleeptime`) and
 *   when it last woke (`kern.waketime`). A wake newer than the window's opening sample means
 *   the host slept inside it; the newest sleep's span — wake minus sleep start — is its
 *   measured duration. libuv's monotonic clock on macOS counts time asleep (the
 *   BuildCheckRun docblock in build/build-check.ts), so it cannot be differenced against anything.
 * - **Linux:** `/proc/uptime` runs on CLOCK_BOOTTIME, which advances through suspend, while
 *   the monotonic clock does not; their divergence over the window is the suspended time.
 *
 * Zero dependencies: sysctl through execFile, /proc through a plain read. Split from
 * build/build-check.ts so the measurement is testable on its own — every reader takes its samples
 * through the injectable SleepSampler, and tests hand synthetic samples to sleptMsBetween
 * instead of suspending the host. */

import fs from "node:fs";
import { execFileAsync } from "./process/process.js";

/** One reading of whatever sleep clocks the platform exposes. Every field is optional:
 * a platform with no readable clock, or one that failed to read, yields an empty sample —
 * sleptMsBetween then returns undefined rather than a number, and the caller records no
 * sleep evidence instead of a wrong one. */
export interface SleepSample {
  /** Epoch ms of the kernel's last wake (macOS `kern.waketime`). */
  lastWakeMs?: number;
  /** Epoch ms of the kernel's last sleep START (macOS `kern.sleeptime`). */
  lastSleepMs?: number;
  /** CLOCK_BOOTTIME ms since boot (Linux `/proc/uptime`'s first field), paired with monoNs. */
  bootMs?: number;
  /** The monotonic clock at the same instant as bootMs (hrtime), on the same scale. */
  monoNs?: bigint;
}

/** Where a sleep sample comes from — the real clocks (sampleSleepClock), or a test's script
 * standing in for a host it cannot suspend. */
export type SleepSampler = () => Promise<SleepSample>;

/** Read the sleep clocks once. Never throws: a failing or missing clock is an empty sample. */
export async function sampleSleepClock(): Promise<SleepSample> {
  if (process.platform === "darwin") {
    // One exec per sysctl; they are independent, so they run together.
    const [wake, sleep] = await Promise.all([
      readSysctlTime("kern.waketime"),
      readSysctlTime("kern.sleeptime"),
    ]);
    return { lastWakeMs: wake, lastSleepMs: sleep };
  }
  if (process.platform === "linux") {
    try {
      // `/proc/uptime` is `<boottime-seconds> <idle-seconds>`; the first field advances
      // through suspend (CLOCK_BOOTTIME), the monotonic clock does not.
      const uptime = Number(fs.readFileSync("/proc/uptime", "utf8").split(" ")[0]);
      if (!Number.isFinite(uptime)) return {};
      return { bootMs: uptime * 1000, monoNs: process.hrtime.bigint() };
    } catch {
      return {};
    }
  }
  return {};
}

/** `sysctl -n kern.waketime` prints `{ sec = 1790801674, usec = 520348 }` — an epoch time.
 * Returns undefined when the value is absent or shaped differently. */
async function readSysctlTime(name: string): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync("sysctl", ["-n", name], { timeout: 10_000 });
    const m = /sec = (\d+), usec = (\d+)/.exec(stdout);
    return m ? Number(m[1]) * 1000 + Math.floor(Number(m[2]) / 1000) : undefined;
  } catch {
    return undefined;
  }
}

/** How long the host was suspended between two samples, or undefined when either sample
 * carries no readable sleep clock. On macOS the measurement is the newest sleep's span —
 * a window holding several sleeps is undercounted, never overcounted — and 0 means no wake
 * fell inside the window, i.e. no evidence of sleep. On Linux it is the boottime clock's
 * divergence from the monotonic clock, 0 when the host stayed awake. Callers decide what
 * counts as sleep (SLEEP_SPAN_TOLERANCE_MS in build/build-check-events.ts), not this function. */
export function sleptMsBetween(a: SleepSample, b: SleepSample): number | undefined {
  if (a.bootMs !== undefined && b.bootMs !== undefined && a.monoNs !== undefined && b.monoNs !== undefined) {
    const wall = b.bootMs - a.bootMs;
    const mono = Number(b.monoNs - a.monoNs) / 1e6;
    return Math.max(0, wall - mono);
  }
  if (a.lastWakeMs !== undefined && b.lastWakeMs !== undefined) {
    // A new wake inside the window means the host slept; the newest sleep began after the
    // opening sample (the host was awake when it was taken) and ended at that wake. A sleep
    // stamp outside the window's bounds (a clock that moved under us) clamps to them, so the
    // measurement never reaches outside the run it describes.
    if (b.lastWakeMs <= a.lastWakeMs) return 0;
    const start = b.lastSleepMs !== undefined
      ? Math.max(a.lastWakeMs, Math.min(b.lastSleepMs, b.lastWakeMs))
      : a.lastWakeMs;
    return Math.max(0, b.lastWakeMs - start);
  }
  return undefined;
}
