/** Edges of src/scheduling/quiet-hours.ts that test/quiet-hours.test.ts does not reach: a
 * malformed or non-string live value ending a held window, the two-digit minutes of the clock
 * format, and the window end read back as written. */

import test from "node:test";
import assert from "node:assert/strict";

import {
  newQuietHoursGateState,
  parseQuietHours,
  pollQuietHoursGate,
  quietWindowEnd,
} from "../src/scheduling/quiet-hours.js";
import { readEvents } from "../src/events/event-read.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { eventTypes } from "./fixtures/log-fixtures.js";

function localDate(hours: number, minutes: number): Date {
  // A fixed calendar date with the wall-clock fields under test set in LOCAL time.
  return new Date(2026, 8, 30, hours, minutes, 0, 0);
}

test("pollQuietHoursGate reads a malformed or non-string value as off, ending a held window with one event that carries only a string window", () => {
  const root = tmpdir("quiet-hours-");
  const state = newQuietHoursGateState();
  assert.equal(pollQuietHoursGate(root, "10:00-12:00", state, localDate(11, 0)), true);
  assert.equal(pollQuietHoursGate(root, "25:00-07:00", state, localDate(11, 1)), false);
  assert.deepEqual(eventTypes(root, "quiet_hours_started", "quiet_hours_ended"), [
    "quiet_hours_ended",
    "quiet_hours_started",
  ]);
  const ended = readEvents(root, 100).find((e) => e.type === "quiet_hours_ended");
  assert.equal(ended?.window, "25:00-07:00");

  const root2 = tmpdir("quiet-hours-");
  const state2 = newQuietHoursGateState();
  assert.equal(pollQuietHoursGate(root2, "10:00-12:00", state2, localDate(11, 0)), true);
  assert.equal(pollQuietHoursGate(root2, 7 as unknown, state2, localDate(11, 1)), false);
  const ended2 = readEvents(root2, 100).find((e) => e.type === "quiet_hours_ended");
  assert.equal(ended2?.window, undefined);
  const before = eventTypes(root2, "quiet_hours_started", "quiet_hours_ended");
  assert.equal(pollQuietHoursGate(root2, 7 as unknown, state2, localDate(11, 2)), false);
  assert.deepEqual(eventTypes(root2, "quiet_hours_started", "quiet_hours_ended"), before);
});

test("parseQuietHours takes one- or two-digit hours but exactly two minute digits, and quietWindowEnd reads the end back as written", () => {
  assert.deepEqual(parseQuietHours("7:00-9:00"), {
    ok: true,
    window: { startMin: 420, endMin: 540 },
  });
  const bad = parseQuietHours("07:0-09:00");
  assert.equal(bad.ok, false);
  assert.ok(!bad.ok && bad.error.includes('got "07:0"'), JSON.stringify(bad));
  assert.equal(quietWindowEnd(" 23:00 - 07:00 "), "07:00");
  assert.equal(quietWindowEnd("23:00-07:30"), "07:30");
});
