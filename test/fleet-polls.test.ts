import test from "node:test";
import assert from "node:assert/strict";
import { FLEET_OPEN, HOLD_BASE_MS, HOLD_CAP_MS } from "../src/fleet-hold.js";
import { pollFleetHold, type HoldInputs } from "../src/fleet-polls.js";
import { readEvents } from "../src/event-read.js";
import { tmpdir } from "./repo-fixtures.js";

// The orchestrator's fleet-hold poll (src/fleet-polls.ts): the wiring half of the fleet-wide
// backend-failure hold. Its pure policy is pinned in fleet-hold.test.ts; what is only pinned
// here is the wiring itself — the HoldInputs→observations mapping (lastRateLimit and
// lastBackendFailure, retry-after carried only on the former) and the exactly-one-event-per-
// crossing rule: `rate_limit_hold` on the way in, `rate_limit_resumed` at the deadline
// carrying the ended hold's own kind (BUGS.md 2026-09-29), silence while held.

const T0 = 1_000_000_000;

function holdEvents(root: string) {
  return readEvents(root).filter((e) => e.type === "rate_limit_hold" || e.type === "rate_limit_resumed");
}

function runner(role: string, inputs: Partial<HoldInputs> = {}): HoldInputs {
  return { role, ...inputs };
}

test("pollFleetHold maps HoldInputs to observations: rate-limit with retry-after, backend failures without", () => {
  const root = tmpdir("tumwater-fleet-polls-");
  // Three distinct roles: one plain 429, one 429 with a Retry-After, one connection failure.
  const held = pollFleetHold(
    root,
    FLEET_OPEN,
    [
      runner("clean", { lastRateLimit: { at: T0 } }),
      runner("coverage", { lastRateLimit: { at: T0 + 5_000, retryAfterSeconds: 300 } }),
      runner("dry", { lastBackendFailure: { at: T0 + 5_000, kind: "connection" } }),
    ],
    T0 + 5_000,
  );
  assert.notEqual(held.until, null, "two distinct roles' 429s trip the hold");
  // The first qualifying kind in observation order wins: the rate-limit group has the two
  // roles it needs, so dry's connection failure rides along in the observations but does
  // not join this hold.
  assert.equal(held.kind, "rate-limit");
  assert.deepEqual(held.roles, ["clean", "coverage"]);
  // The 300 s Retry-After from coverage, measured from its own 429, beats the base hold.
  assert.equal(held.until, T0 + 5_000 + 300_000, "the wired retry-after reaches the gate");
});

test("pollFleetHold logs exactly one rate_limit_hold on the crossing, naming kind, roles, holdMs, escalation", () => {
  const root = tmpdir("tumwater-fleet-polls-");
  const held = pollFleetHold(
    root,
    FLEET_OPEN,
    [
      runner("clean", { lastRateLimit: { at: T0 } }),
      runner("coverage", { lastRateLimit: { at: T0 } }),
    ],
    T0,
  );
  assert.equal(held.until, T0 + HOLD_BASE_MS);
  const events = holdEvents(root);
  assert.equal(events.length, 1, "one event per crossing");
  const first = events[0]!;
  assert.equal(first.type, "rate_limit_hold");
  assert.equal(first.loop, "harness");
  assert.equal(first.kind, "rate-limit");
  assert.deepEqual(first.roles, ["clean", "coverage"]);
  assert.equal(first.holdMs, HOLD_BASE_MS);
  assert.equal(first.escalation, 0);

  // Held again before the deadline: prev passes through and stays event-free.
  const still = pollFleetHold(
    root,
    held,
    [
      runner("clean", { lastRateLimit: { at: T0 } }),
      runner("coverage", { lastRateLimit: { at: T0 } }),
    ],
    T0 + 1_000,
  );
  assert.equal(still, held, "a held step returns prev itself");
  assert.equal(holdEvents(root).length, 1, "no event while held");
});

test("pollFleetHold logs one rate_limit_resumed at the deadline, carrying the ended hold's kind", () => {
  const root = tmpdir("tumwater-fleet-polls-");
  // A connection-error hold, not a 429 one — the resumed event must name what actually ended.
  const held = pollFleetHold(
    root,
    FLEET_OPEN,
    [
      runner("clean", { lastBackendFailure: { at: T0, kind: "connection" } }),
      runner("coverage", { lastBackendFailure: { at: T0, kind: "connection" } }),
    ],
    T0,
  );
  assert.equal(held.kind, "connection");
  assert.equal(holdEvents(root).length, 1);

  // At the deadline, with no fresh failures, the hold re-opens and the lift is logged with
  // the hold's own kind — "429 hold lifted" after a connection-error hold would be a lie.
  const open = pollFleetHold(root, held, [], held.until!);
  assert.equal(open.until, null);
  assert.equal(open.kind, "connection", "kind stays for the relapse test after the lift");
  const resumed = holdEvents(root).filter((e) => e.type === "rate_limit_resumed");
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0]!.kind, "connection");
  assert.equal(resumed[0]!.loop, "harness");
});

test("pollFleetHold logs a relapse crossing with its escalation depth", () => {
  const root = tmpdir("tumwater-fleet-polls-");
  const failures = (at: number) => [
    runner("clean", { lastRateLimit: { at } }),
    runner("coverage", { lastRateLimit: { at } }),
  ];
  const held = pollFleetHold(root, FLEET_OPEN, failures(T0), T0);
  const open = pollFleetHold(root, held, [], held.until!);
  // The same kind relapses within HOLD_RELAPSE_MS on fresh failures (the gate ignores
  // observations from before the re-open): a second hold event, escalation 1.
  const relapsed = pollFleetHold(root, open, failures(open.reopenedAt! + 1_000), open.reopenedAt! + 1_000);
  assert.equal(relapsed.escalation, 1);
  assert.equal(relapsed.until, open.reopenedAt! + 1_000 + HOLD_BASE_MS * 2);
  const holds = holdEvents(root).filter((e) => e.type === "rate_limit_hold");
  assert.equal(holds.length, 2, "each crossing logs its own event");
  assert.equal(holds[1]!.escalation, 1);
});

test("pollFleetHold stays event-free while the fleet is open", () => {
  const root = tmpdir("tumwater-fleet-polls-");
  // One role's 429s (its attempt and its retry) never trip the hold — and log nothing.
  const next = pollFleetHold(
    root,
    FLEET_OPEN,
    [
      runner("feature", { lastRateLimit: { at: T0 } }),
      runner("feature", { lastRateLimit: { at: T0 + 1_000 } }),
      runner("quiet", { lastBackendFailure: { at: T0, kind: "model-load" } }),
    ],
    T0 + 1_000,
  );
  assert.equal(next.until, null);
  assert.equal(holdEvents(root).length, 0, "an open fleet logs no hold events");

  // A huge Retry-After is still capped through the wiring.
  const capped = pollFleetHold(
    root,
    FLEET_OPEN,
    [
      runner("clean", { lastRateLimit: { at: T0, retryAfterSeconds: 9_999 } }),
      runner("coverage", { lastRateLimit: { at: T0 } }),
    ],
    T0,
  );
  assert.equal(capped.until, T0 + HOLD_CAP_MS);
  assert.equal(holdEvents(root).length, 1);
});
