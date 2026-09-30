import test from "node:test";
import assert from "node:assert/strict";
import {
  FLEET_OPEN,
  fleetHold,
  HOLD_BASE_MS,
  HOLD_CAP_MS,
  HOLD_RELAPSE_MS,
  HOLD_STORM_WINDOW_MS,
  type FleetHold,
  type HoldKind,
  type HoldObservation,
} from "../src/fleet-hold.js";

// The fleet-wide backend-failure hold's policy (src/fleet-hold.ts; BUGS.md 2026-09-21
// "A 429 storm still has no fleet-wide hold", generalized 2026-09-29 PLANS.md to the
// connection/timeout/5xx/model-load kinds): pure, so every clause of the rule — distinct
// roles, the window, per-kind storms, Retry-After, automatic re-open, per-kind relapse
// doubling, the cap — is pinned here without a fleet. The orchestrator's wiring around it is
// pinned in orchestrator-seams.test.ts.

const T0 = 1_000_000_000;

function obs(role: string, at: number, kind: HoldKind = "rate-limit", retryAfterSeconds?: number): HoldObservation {
  return retryAfterSeconds === undefined ? { role, at, kind } : { role, at, kind, retryAfterSeconds };
}

/** Trip a fresh hold at `at` from two roles' same-kind failures. */
function trip(prev: FleetHold, at: number, kind: HoldKind = "rate-limit"): FleetHold {
  return fleetHold(prev, [obs("bugfix", at, kind), obs("coverage", at, kind)], at);
}

test("one role's 429s never trip the hold — the per-run retry already answers them", () => {
  // The same role twice (its first attempt and its retry) is still one role.
  const next = fleetHold(FLEET_OPEN, [obs("feature", T0), obs("feature", T0 + 1_000)], T0 + 1_000);
  assert.equal(next, FLEET_OPEN, "an unchanged step returns prev itself");
  assert.equal(fleetHold(FLEET_OPEN, [], T0).until, null);
});

test("two distinct roles' 429s within the window trip a base hold naming them", () => {
  const next = fleetHold(FLEET_OPEN, [obs("dry", T0), obs("clean", T0 + 6_000)], T0 + 6_000);
  assert.equal(next.until, T0 + 6_000 + HOLD_BASE_MS);
  assert.deepEqual(next.roles, ["clean", "dry"], "distinct roles, sorted");
  assert.equal(next.kind, "rate-limit", "the hold names the failure kind it is about");
  assert.equal(next.escalation, 0, "a fresh storm starts at the base");
});

test("429s further apart than the storm window do not add up", () => {
  const stale = obs("readme", T0);
  const now = T0 + HOLD_STORM_WINDOW_MS + 1;
  assert.equal(fleetHold(FLEET_OPEN, [stale, obs("bugfix", now)], now).until, null);
  // Exactly at the window's edge still counts.
  const edge = T0 + HOLD_STORM_WINDOW_MS;
  assert.notEqual(fleetHold(FLEET_OPEN, [stale, obs("bugfix", edge)], edge).until, null);
});

test("the hold honours the largest Retry-After seen, measured from its own 429, and caps it", () => {
  // bugfix was told 300 s at T0; coverage 30 s at T0+10s. The furthest deadline wins.
  const now = T0 + 10_000;
  const held = fleetHold(FLEET_OPEN, [obs("bugfix", T0, "rate-limit", 300), obs("coverage", now, "rate-limit", 30)], now);
  assert.equal(held.until, T0 + 300_000);
  // A hint shorter than the base hold does not shorten it.
  const short = fleetHold(FLEET_OPEN, [obs("bugfix", T0, "rate-limit", 5), obs("coverage", T0, "rate-limit", 5)], T0);
  assert.equal(short.until, T0 + HOLD_BASE_MS);
  // A generous hint is capped: one provider cannot park the fleet for hours.
  const huge = fleetHold(FLEET_OPEN, [obs("bugfix", T0, "rate-limit", 9_999), obs("coverage", T0)], T0);
  assert.equal(huge.until, T0 + HOLD_CAP_MS);
});

test("backend failures of one kind trip the same hold, but carry no Retry-After", () => {
  // Two roles ending on connection errors trip a hold of that kind at the base — the
  // generalization of the 429 storm (PLANS.md 2026-09-29).
  const held = fleetHold(FLEET_OPEN, [obs("dry", T0, "connection"), obs("perf", T0 + 5_000, "connection")], T0 + 5_000);
  assert.equal(held.until, T0 + 5_000 + HOLD_BASE_MS);
  assert.deepEqual(held.roles, ["dry", "perf"]);
  assert.equal(held.kind, "connection");
  // The other backend kinds work identically — the kind only groups, it does not change the
  // math — and production never attaches a Retry-After hint to them (pi's backend texts
  // carry none), so the base is their whole first hold.
  for (const kind of ["timeout", "server", "model-load"] as const) {
    const heldKind = fleetHold(FLEET_OPEN, [obs("dry", T0, kind), obs("perf", T0, kind)], T0);
    assert.equal(heldKind.until, T0 + HOLD_BASE_MS, `${kind} storms hold for the base`);
    assert.equal(heldKind.kind, kind);
  }
});

test("failures of different kinds are different incidents: neither storms alone", () => {
  // Two roles, two kinds, same window: each kind has one role behind it, so nothing trips.
  const next = fleetHold(FLEET_OPEN, [obs("dry", T0, "connection"), obs("perf", T0 + 5_000, "server")], T0 + 5_000);
  assert.equal(next, FLEET_OPEN);
  // Even three roles across three kinds stay open — the storm test counts roles per kind.
  const three = fleetHold(
    FLEET_OPEN,
    [obs("dry", T0, "connection"), obs("perf", T0, "server"), obs("qa", T0, "timeout")],
    T0,
  );
  assert.equal(three, FLEET_OPEN);
  // A 429 plus a backend failure is likewise not a storm of either.
  const mixed = fleetHold(FLEET_OPEN, [obs("dry", T0, "rate-limit"), obs("perf", T0, "model-load")], T0);
  assert.equal(mixed, FLEET_OPEN);
});

test("two roles on the same backend kind storm even while others fail differently", () => {
  const next = fleetHold(
    FLEET_OPEN,
    [obs("dry", T0, "connection"), obs("perf", T0, "server"), obs("qa", T0 + 1_000, "connection")],
    T0 + 1_000,
  );
  assert.equal(next.until, T0 + 1_000 + HOLD_BASE_MS);
  assert.equal(next.kind, "connection", "the first kind to reach two roles wins");
  assert.deepEqual(next.roles, ["dry", "qa"]);
});

test("a held fleet stays held until its deadline, then re-opens by itself", () => {
  const held = trip(FLEET_OPEN, T0);
  const until = held.until!;
  // Mid-hold, even fresh failures from new roles change nothing: the hold is already answering them.
  const mid = fleetHold(held, [obs("perf", until - 1), obs("steward", until - 1)], until - 1);
  assert.equal(mid, held);
  const reopened = fleetHold(held, [obs("perf", until - 1), obs("steward", until - 1)], until);
  assert.equal(reopened.until, null);
  assert.deepEqual(reopened.roles, []);
  assert.equal(reopened.reopenedAt, until);
  // The failures that tripped it, and those hit while it held, never re-trip it after re-open.
  const after = fleetHold(
    reopened,
    [obs("bugfix", T0), obs("coverage", T0), obs("perf", until - 1), obs("steward", until - 1)],
    until + 1_000,
  );
  assert.equal(after.until, null);
});

test("a storm that resumes right after re-open doubles the hold; one after a calm spell starts fresh", () => {
  let hold = trip(FLEET_OPEN, T0);
  hold = fleetHold(hold, [], hold.until!); // re-open
  const reopenedAt = hold.reopenedAt!;
  // Relapse 30 s after re-opening: the base hold was too short.
  const relapse = trip(hold, reopenedAt + 30_000);
  assert.equal(relapse.escalation, 1);
  assert.equal(relapse.until, reopenedAt + 30_000 + 2 * HOLD_BASE_MS);

  // After a calm spell longer than the relapse window, the next storm is a new one.
  const calm = fleetHold(relapse, [], relapse.until!); // re-open
  const fresh = trip(calm, calm.reopenedAt! + HOLD_RELAPSE_MS + 1);
  assert.equal(fresh.escalation, 0);
  assert.equal(fresh.until! - (calm.reopenedAt! + HOLD_RELAPSE_MS + 1), HOLD_BASE_MS);
});

test("a relapse is per kind: the same kind escalates, a different kind starts at the base", () => {
  // A 429 storm relapses right after re-open: doubling, as above.
  let hold = trip(FLEET_OPEN, T0, "rate-limit");
  hold = fleetHold(hold, [], hold.until!);
  const sameKind = trip(hold, hold.reopenedAt! + 10_000, "rate-limit");
  assert.equal(sameKind.escalation, 1, "the same kind relapsing is the same storm");

  // A connection storm arrives just as fast after THAT hold re-opens: a different kind is a
  // new incident, however hot the 429 storm was — the base, not the double.
  hold = fleetHold(sameKind, [], sameKind.until!);
  const otherKind = trip(hold, hold.reopenedAt! + 10_000, "connection");
  assert.equal(otherKind.escalation, 0, "a different kind after a re-open starts fresh");
  assert.equal(otherKind.kind, "connection");
  assert.equal(otherKind.until, hold.reopenedAt! + 10_000 + HOLD_BASE_MS);
});

test("a storm that outlasts every re-open escalates to the cap and stays there", () => {
  let hold = FLEET_OPEN;
  let now = T0;
  const lengths: number[] = [];
  for (let i = 0; i < 7; i++) {
    hold = trip(hold, now);
    lengths.push(hold.until! - now);
    now = hold.until!;
    hold = fleetHold(hold, [], now); // re-open at the deadline
    now += 1_000; // and the storm is back a second later
  }
  const min = 60_000;
  assert.deepEqual(lengths, [1 * min, 2 * min, 4 * min, 8 * min, 15 * min, 15 * min, 15 * min]);
});
