/** parseQuietHours / inQuietHours / pollQuietHoursGate (src/quiet-hours.ts): the config value's
 * one parse, the local-time membership decision, and the edge-triggered quiet/awake events the
 * orchestrator's poll loop depends on. The gate's live wiring — role ticks blocked, the
 * director exempt, a live edit ending the window — is pinned at the orchestrator e2e tier in
 * test/orchestrator-quiet-hours.e2e.test.ts; this file covers the unit surface. */

import test from "node:test";
import assert from "node:assert/strict";

import {
  inQuietHours,
  newQuietHoursGateState,
  parseQuietHours,
  pollQuietHoursGate,
  quietHoursStatus,
  roleQuietHold,
} from "../src/quiet-hours.js";
import { readEvents } from "../src/event-read.js";
import { tmpdir } from "./repo-fixtures.js";

function localDate(hours: number, minutes: number): Date {
  // A fixed calendar date with the wall-clock fields under test set in LOCAL time —
  // inQuietHours reads getHours/getMinutes, so the assertion travels with the machine's zone.
  return new Date(2026, 8, 30, hours, minutes, 0, 0);
}

function types(root: string, ...names: string[]): string[] {
  return readEvents(root, 100)
    .map((e) => e.type)
    .filter((t) => names.includes(t))
    .sort();
}

// parseQuietHours — the one definition of a valid quietHours value, shared by validateConfig
// and `config set`'s per-key validator.
test("parseQuietHours: valid windows, empty means off, absent means off", () => {
  assert.deepEqual(parseQuietHours("09:00-17:00"), {
    ok: true,
    window: { startMin: 9 * 60, endMin: 17 * 60 },
  });
  // The overnight case the format exists for: start > end wraps midnight.
  assert.deepEqual(parseQuietHours("23:00-07:00"), {
    ok: true,
    window: { startMin: 23 * 60, endMin: 7 * 60 },
  });
  // Whitespace around the ends is tolerated; empty and absent are off, not errors.
  assert.deepEqual(parseQuietHours(" 23:00-07:00 "), {
    ok: true,
    window: { startMin: 23 * 60, endMin: 7 * 60 },
  });
  assert.deepEqual(parseQuietHours(""), { ok: true, window: null });
  assert.deepEqual(parseQuietHours("   "), { ok: true, window: null });
  assert.deepEqual(parseQuietHours(undefined), { ok: true, window: null });
  assert.deepEqual(parseQuietHours(null), { ok: true, window: null });
});

test("parseQuietHours: malformed values fail with an actionable message", () => {
  for (const value of [
    7, // a non-string
    true,
    "23:00", // no dash
    "23:00-07:00-09:00", // two dashes
    "2300-0700", // missing colons
    "25:00-07:00", // hours out of range
    "23:00-07:60", // minutes out of range
    "ab:cd-ef:gh",
    "23:00-23:00", // a zero-length window is a parse error, not always-on
  ]) {
    const parsed = parseQuietHours(value);
    assert.equal(parsed.ok, false, `expected a parse error for ${JSON.stringify(value)}`);
    if (!parsed.ok) assert.match(parsed.error, /quietHours/);
  }
  // The messages name the offending value so the operator can fix one edit.
  const parsed = parseQuietHours(7);
  assert.ok(parsed.ok === false && /got 7/.test(parsed.error));
  const zero = parseQuietHours("23:00-23:00");
  assert.ok(zero.ok === false && /zero-length/.test(zero.error));
});

// inQuietHours — the membership decision at the boundaries: a same-day window is the
// half-open [start, end); a wrapping window spans across 00:00.
test("inQuietHours: same-day window boundaries — start in, end out", () => {
  const window = { startMin: 9 * 60, endMin: 17 * 60 };
  assert.equal(inQuietHours(window, localDate(9, 0)), true, "start minute is inside");
  assert.equal(inQuietHours(window, localDate(16, 59)), true, "the minute before end is inside");
  assert.equal(inQuietHours(window, localDate(17, 0)), false, "end minute is outside");
  assert.equal(inQuietHours(window, localDate(8, 59)), false, "the minute before start is outside");
  assert.equal(inQuietHours(window, localDate(12, 0)), true, "midday is inside");
});

test("inQuietHours: wrapping window spans midnight", () => {
  const window = { startMin: 23 * 60, endMin: 7 * 60 };
  assert.equal(inQuietHours(window, localDate(23, 0)), true, "start minute is inside");
  assert.equal(inQuietHours(window, localDate(23, 59)), true, "late evening is inside");
  assert.equal(inQuietHours(window, localDate(0, 0)), true, "midnight is inside");
  assert.equal(inQuietHours(window, localDate(6, 59)), true, "the minute before end is inside");
  assert.equal(inQuietHours(window, localDate(7, 0)), false, "end minute is outside");
  assert.equal(inQuietHours(window, localDate(12, 0)), false, "midday is outside");
  assert.equal(inQuietHours(window, localDate(22, 59)), false, "the minute before start is outside");
});

// pollQuietHoursGate — the edge-triggered event logging the orchestrator's poll depends on:
// exactly one event per crossing, none while settled, one on a restart mid-window.
// quietHoursStatus (plans: "Quiet hours … part 2/2, observability") is what the dashboards
// read: the operator's own window string whenever the gate would hold, null otherwise, and
// the membership decision from the same predicate the scheduler uses.

test("quietHoursStatus: the window string plus the gate's own membership predicate", () => {
  assert.deepEqual(quietHoursStatus("23:00-07:00", localDate(3, 0)), { window: "23:00-07:00", inWindow: true });
  assert.deepEqual(quietHoursStatus("23:00-07:00", localDate(12, 0)), { window: "23:00-07:00", inWindow: false });
  // The operator's own spelling survives, trimmed but never reformatted.
  assert.deepEqual(quietHoursStatus(" 9:00 - 17:00 ", localDate(10, 0)), { window: "9:00 - 17:00", inWindow: true });
  // Off in every shape the gate treats as off — unset, empty, malformed — advertises nothing.
  assert.deepEqual(quietHoursStatus(undefined, localDate(3, 0)), { window: null, inWindow: false });
  assert.deepEqual(quietHoursStatus("", localDate(3, 0)), { window: null, inWindow: false });
  assert.deepEqual(quietHoursStatus("25:00-07:00", localDate(3, 0)), { window: null, inWindow: false });
  assert.deepEqual(quietHoursStatus("23:00-23:00", localDate(3, 0)), { window: null, inWindow: false });
});

test("pollQuietHoursGate: one started/ended event per crossing, none while settled", () => {
  const root = tmpdir("quiet-hours-");
  const state = newQuietHoursGateState();
  const at = (h: number, m: number) => pollQuietHoursGate(root, "10:00-12:00", state, localDate(h, m));

  // Entering the window logs exactly one quiet_hours_started (with the window string).
  assert.equal(at(10, 30), true);
  assert.deepEqual(types(root, "quiet_hours_started", "quiet_hours_ended"), ["quiet_hours_started"]);
  // Still inside: the ~2s poll cadence must not re-log.
  assert.equal(at(11, 0), true);
  assert.deepEqual(types(root, "quiet_hours_started", "quiet_hours_ended"), ["quiet_hours_started"]);
  // Exiting logs exactly one quiet_hours_ended.
  assert.equal(at(12, 30), false);
  assert.deepEqual(types(root, "quiet_hours_started", "quiet_hours_ended"), [
    "quiet_hours_ended",
    "quiet_hours_started",
  ]);
  // Settled outside: nothing further.
  at(13, 0);
  assert.deepEqual(types(root, "quiet_hours_started", "quiet_hours_ended"), [
    "quiet_hours_ended",
    "quiet_hours_started",
  ]);

  const events = readEvents(root, 100);
  const started = events.find((e) => e.type === "quiet_hours_started");
  assert.equal(started?.loop, "harness");
  assert.equal(started?.window, "10:00-12:00");
});

test("pollQuietHoursGate: unset window is silent, restart mid-window logs one event", () => {
  const root = tmpdir("quiet-hours-");

  // No quietHours configured: always "outside", never an event.
  const off = newQuietHoursGateState();
  assert.equal(pollQuietHoursGate(root, undefined, off, localDate(10, 30)), false);
  assert.equal(pollQuietHoursGate(root, "", off, localDate(10, 30)), false);
  assert.deepEqual(types(root, "quiet_hours_started", "quiet_hours_ended"), []);

  // A fresh state (a restarted orchestrator) meeting an active window logs one started event
  // on the first poll — then nothing, like the pause gate's restart story.
  const fresh = newQuietHoursGateState();
  assert.equal(pollQuietHoursGate(root, "10:00-12:00", fresh, localDate(11, 0)), true);
  assert.equal(pollQuietHoursGate(root, "10:00-12:00", fresh, localDate(11, 30)), true);
  assert.deepEqual(types(root, "quiet_hours_started", "quiet_hours_ended"), ["quiet_hours_started"]);
});

test("pollQuietHoursGate: a live edit from a window to off logs the ended crossing", () => {
  const root = tmpdir("quiet-hours-");
  const state = newQuietHoursGateState();
  assert.equal(pollQuietHoursGate(root, "10:00-12:00", state, localDate(11, 0)), true);
  // The operator empties the window live (what `config set quietHours ""` does): the next
  // poll reads "off" and logs exactly one quiet_hours_ended.
  assert.equal(pollQuietHoursGate(root, "", state, localDate(11, 1)), false);
  assert.deepEqual(types(root, "quiet_hours_started", "quiet_hours_ended"), [
    "quiet_hours_ended",
    "quiet_hours_started",
  ]);
});

// Per-role quiet hours (PLANS.md, quietHoursPerRole): roleQuietHold reuses the fleet
// window's parser and predicate, so a per-role value means exactly what the same string
// means fleet-wide — wrapping included. Absent, off, and unparseable all read as off here;
// validation is config-validation.ts's business.
test("roleQuietHold: the per-role window holds the loop it names and no other", () => {
  const perRole = { feature: "23:00-07:00" };
  // Inside a wrapping window (23:00-07:00): 23:30 and 06:59 hold, 07:00 exits, 22:59 has
  // not entered.
  assert.equal(roleQuietHold(perRole, "feature", localDate(23, 30)), true);
  assert.equal(roleQuietHold(perRole, "feature", localDate(6, 59)), true);
  assert.equal(roleQuietHold(perRole, "feature", localDate(7, 0)), false);
  assert.equal(roleQuietHold(perRole, "feature", localDate(22, 59)), false);
  // A same-day window: the ordinary half-open range.
  const day = { qa: "10:00-12:00" };
  assert.equal(roleQuietHold(day, "qa", localDate(10, 0)), true);
  assert.equal(roleQuietHold(day, "qa", localDate(11, 59)), true);
  assert.equal(roleQuietHold(day, "qa", localDate(12, 0)), false);
  // Other roles are untouched by a window that does not name them.
  assert.equal(roleQuietHold(perRole, "docs", localDate(23, 30)), false);
  // An absent key, an empty string (off), and a whitespace value are all off.
  assert.equal(roleQuietHold(undefined, "feature", localDate(23, 30)), false);
  assert.equal(roleQuietHold({ feature: "" }, "feature", localDate(23, 30)), false);
  assert.equal(roleQuietHold({ feature: "  " }, "feature", localDate(23, 30)), false);
  // An unparseable value reads as off — validation rejects it elsewhere; the helper must
  // never hold a loop the operator did not schedule.
  assert.equal(roleQuietHold({ feature: "25:00-07:00" }, "feature", localDate(23, 30)), false);
  assert.equal(roleQuietHold({ feature: "nonsense" }, "feature", localDate(23, 30)), false);
  // A non-string value is off, likewise.
  assert.equal(roleQuietHold({ feature: 5 } as unknown as Record<string, string>, "feature", localDate(23, 30)), false);
});
