import test from "node:test";
import assert from "node:assert/strict";
import { dayAt, dayLabel, formatDate, reportWindow } from "../src/datetime.js";

// datetime.ts is the single home of local date/time formatting and calendar-day arithmetic
// (the transcript run separators, status table's last-tick cell, daily-budget day stamps,
// and both reports' day windows render through it). These tests pin the documented contract
// directly instead of only through one indirect case per consumer.

test("dayAt returns local midnight offset from the given instant, rolling month/year edges", () => {
  const now = new Date(2026, 2, 1, 14, 30, 5); // 2026-03-01 14:30 local
  assert.equal(formatDateOf(dayAt(0, now)), "2026-03-01");
  assert.equal(formatDateOf(dayAt(1, now)), "2026-02-28"); // crosses the month edge
  assert.equal(formatDateOf(dayAt(3, now)), "2026-02-26");
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

test("dayLabel is singular at one day and plural otherwise", () => {
  assert.equal(dayLabel(1), "1 day");
  assert.equal(dayLabel(2), "2 days");
  assert.equal(dayLabel(14), "14 days");
});

test("reportWindow renders one shared header line, singular at one day", () => {
  assert.equal(
    reportWindow("2026-08-29", "2026-09-11", 14),
    "Window: 2026-08-29 → 2026-09-11 (14 days) · source: events.jsonl (rotated at 16 MB)",
  );
  assert.equal(
    reportWindow("2026-09-11", "2026-09-11", 1),
    "Window: 2026-09-11 → 2026-09-11 (1 day) · source: events.jsonl (rotated at 16 MB)",
  );
});

/** Local `YYYY-MM-DD` of a Date — test-local so the assertion is independent of datetime's
 * formatDate (which datetime.test.ts does not otherwise cover). */
function formatDateOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
