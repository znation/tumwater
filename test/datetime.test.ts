import test from "node:test";
import assert from "node:assert/strict";
import { dayAt, dayKey, dayLabel, dayWindow, elapsedSeconds, formatDate, formatTime, formatTimestamp, humanSeconds, pad2, reportWindow } from "../src/text/datetime.js";
import { clockOf, dateOf } from "./helpers/oracles.js";

// datetime.ts is the single home of local date/time formatting and calendar-day arithmetic
// (the transcript run separators, status table's last-tick cell, daily-budget day stamps,
// and both reports' day windows render through it). These tests pin the documented contract
// directly instead of only through one indirect case per consumer.

test("dayAt returns local midnight offset from the given instant, rolling month/year edges", () => {
  const now = new Date(2026, 2, 1, 14, 30, 5); // 2026-03-01 14:30 local
  assert.equal(dateOf(dayAt(0, now)), "2026-03-01");
  assert.equal(dateOf(dayAt(1, now)), "2026-02-28"); // crosses the month edge
  assert.equal(dateOf(dayAt(3, now)), "2026-02-26");
  // The time of day of `now` is discarded (midnight), so day-key arithmetic is stable.
  assert.equal(dayAt(0, now).getHours(), 0);
  assert.equal(dayAt(0, now).getMinutes(), 0);
  assert.equal(dayAt(0, now).getSeconds(), 0);
});

test("formatDate renders the local calendar date, zero-padded, from date parts alone", () => {
  // Direct pin against literal local dates (built from year/month/day parts, never via
  // dayAt): this is the independent oracle for the day-key format itself, complementing the
  // dayAt test above, which checks day arithmetic through this same format.
  assert.equal(formatDate(new Date(2026, 2, 1, 14, 30, 5)), "2026-03-01"); // time of day ignored
  assert.equal(formatDate(new Date(2026, 0, 5)), "2026-01-05"); // single-digit month and day pad
  assert.equal(formatDate(new Date(2026, 11, 31)), "2026-12-31");
});

test("dayWindow bounds a trailing window of `days` local calendar days ending today", () => {
  const now = new Date(2026, 2, 1, 14, 30, 5); // 2026-03-01 14:30 local
  assert.deepEqual(dayWindow(1, now), { from: "2026-03-01", to: "2026-03-01" });
  // The far edge crosses the month/year edge through dayAt's midnight arithmetic.
  assert.deepEqual(dayWindow(3, now), { from: "2026-02-27", to: "2026-03-01" });
});

test("dayLabel is singular at one day and plural otherwise", () => {
  assert.equal(dayLabel(1), "1 day");
  assert.equal(dayLabel(2), "2 days");
  assert.equal(dayLabel(14), "14 days");
});

test("reportWindow renders one shared header line, singular at one day", () => {
  assert.equal(
    reportWindow("2026-08-29", "2026-09-11", 14, "rotated at 16 MB"),
    "Window: 2026-08-29 → 2026-09-11 (14 days) · source: events.jsonl (rotated at 16 MB)",
  );
  assert.equal(
    reportWindow("2026-09-11", "2026-09-11", 1, "rotated at 16 MB"),
    "Window: 2026-09-11 → 2026-09-11 (1 day) · source: events.jsonl (rotated at 16 MB)",
  );
});

test("pad2 zero-pads to two digits and leaves longer numbers alone", () => {
  assert.equal(pad2(0), "00");
  assert.equal(pad2(5), "05");
  assert.equal(pad2(9), "09");
  assert.equal(pad2(10), "10");
  assert.equal(pad2(59), "59");
  assert.equal(pad2(100), "100", "already two digits wide is not truncated");
});

test("formatTime renders the zero-padded local wall clock from date parts alone", () => {
  assert.equal(formatTime(new Date(2026, 2, 1, 14, 30, 5)), "14:30:05");
  assert.equal(formatTime(new Date(2026, 2, 1, 3, 7, 9)), "03:07:09", "single-digit parts pad");
  // Direct pin against the raw-local-parts clock oracle (never a UTC-derived readback) so a
  // drift to UTC rendering fails here rather than matching the constructor's own timezone.
  const d = new Date(2026, 2, 1, 23, 59, 59);
  assert.equal(formatTime(d), clockOf(d));
});

test("dayKey is the LOCAL calendar day of the instant, never the UTC date", () => {
  // Pin the local-day rule at both edges of the local day, where a UTC-based implementation
  // disagrees in every non-UTC timezone: late evening reads as the next UTC date west of
  // UTC, just after midnight reads as the previous UTC date east of it. Whichever side the
  // runner's timezone is on, at least one of the two pins a UTC drift.
  const oracle = (ms: number) => formatDate(new Date(ms));
  const evening = new Date(2026, 2, 1, 23, 30, 0).getTime();
  const justAfterMidnight = new Date(2026, 2, 1, 0, 30, 0).getTime();
  assert.equal(dayKey(evening), "2026-03-01");
  assert.equal(dayKey(evening), oracle(evening), "evening edge stays the local date");
  assert.equal(dayKey(justAfterMidnight), "2026-03-01");
  assert.equal(dayKey(justAfterMidnight), oracle(justAfterMidnight), "post-midnight edge stays the local date");
});

test("formatTimestamp renders date and clock from ONE Date, so its halves cannot disagree", () => {
  // The documented invariant: the date half and the time half come from the same instant.
  // Both edges here sit either side of local midnight, where a timestamp assembled from two
  // Date reads (or a UTC-based date half) would show a date/time pair no clock ever displayed.
  const justBeforeMidnight = new Date(2026, 2, 1, 23, 59, 59).getTime();
  const justAfterMidnight = new Date(2026, 2, 2, 0, 0, 1).getTime();
  assert.equal(formatTimestamp(justBeforeMidnight), "2026-03-01 23:59:59");
  assert.equal(formatTimestamp(justAfterMidnight), "2026-03-02 00:00:01");
  // One-instant consistency: the halves always join into the parts' own date and time.
  const at = (h: number, m: number, s: number) => new Date(2026, 4, 15, h, m, s).getTime();
  for (const ms of [at(0, 0, 0), at(9, 5, 3), at(23, 59, 59)]) {
    const d = new Date(ms);
    const dateHalf = formatDate(d);
    const timeHalf = formatTime(d);
    assert.equal(formatTimestamp(ms), `${dateHalf} ${timeHalf}`);
  }
});

test("formatTimestamp renders a non-finite instant as the em dash, never NaN", () => {
  // A corrupt event `ts` reaches these surfaces through the real read paths, and new Date(NaN)
  // would print "NaN-NaN-NaN NaN:NaN:NaN" from every one. The em dash is the project's "no
  // value" marker (history's unpaired duration), so a stamp that cannot be known reads so.
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.equal(formatTimestamp(bad), "—");
  }
});

test("humanSeconds buckets sub-second-to-day spans compactly", () => {
  // Each value sits well inside its bucket so the rounding edge cannot flip it.
  assert.equal(humanSeconds(45), "45s", "sub-minute reads seconds");
  assert.equal(humanSeconds(120), "2m", "sub-hour reads minutes");
  assert.equal(humanSeconds(3 * 3600), "3h", "sub-day reads hours");
  assert.equal(humanSeconds(90 * 86400), "90d", "days read days, not an hour count");
  // A day-plus-a-few-hours span rounds to whole days.
  assert.equal(humanSeconds(3 * 86400 + 2 * 3600), "3d");
  // A rounding carry rolls into the next bucket instead of printing "60m" or "24h".
  assert.equal(humanSeconds(3599), "1h", "59m59s rounds up into the hour bucket");
  assert.equal(humanSeconds(86399), "1d", "23h59m59s rounds up into the day bucket");
});

test("elapsedSeconds ages an instant in clamped whole seconds", () => {
  const realNow = Date.now;
  try {
    const now = new Date(2026, 9, 4, 12, 0, 0).getTime();
    Date.now = () => now;
    // One second before now reads exactly 1; half a second ago rounds to 1 (rounding).
    assert.equal(elapsedSeconds(now - 1000), 1);
    assert.equal(elapsedSeconds(now - 500), 1);
    // Exactly now reads 0, and a future instant (a clock skew) clamps to 0 rather than
    // reporting a negative age.
    assert.equal(elapsedSeconds(now), 0);
    assert.equal(elapsedSeconds(now + 90_000), 0);
  } finally {
    Date.now = realNow;
  }
});
