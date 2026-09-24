import test from "node:test";
import assert from "node:assert/strict";
import {
  RATE_LIMIT_HOLD_BASE_MS,
  RATE_LIMIT_HOLD_CAP_MS,
  RATE_LIMIT_OPEN,
  RATE_LIMIT_RELAPSE_MS,
  RATE_LIMIT_STORM_WINDOW_MS,
  rateLimitHold,
  type RateLimitHold,
  type RateLimitObservation,
} from "../src/rate-limit-hold.js";

// The fleet-wide 429 hold's policy (src/rate-limit-hold.ts; BUGS.md 2026-09-21 "A 429 storm
// still has no fleet-wide hold"): pure, so every clause of the rule — distinct roles, the
// window, Retry-After, automatic re-open, relapse doubling, the cap — is pinned here without a
// fleet. The orchestrator's wiring around it is pinned in orchestrator-seams.test.ts.

const T0 = 1_000_000_000;

function obs(role: string, at: number, retryAfterSeconds?: number): RateLimitObservation {
  return retryAfterSeconds === undefined ? { role, at } : { role, at, retryAfterSeconds };
}

/** Trip a fresh hold at `at` from two roles' simultaneous 429s. */
function trip(prev: RateLimitHold, at: number): RateLimitHold {
  return rateLimitHold(prev, [obs("bugfix", at), obs("coverage", at)], at);
}

test("one role's 429s never trip the hold — the per-run retry already answers them", () => {
  // The same role twice (its first attempt and its retry) is still one role.
  const next = rateLimitHold(RATE_LIMIT_OPEN, [obs("feature", T0), obs("feature", T0 + 1_000)], T0 + 1_000);
  assert.equal(next, RATE_LIMIT_OPEN, "an unchanged step returns prev itself");
  assert.equal(rateLimitHold(RATE_LIMIT_OPEN, [], T0).until, null);
});

test("two distinct roles' 429s within the window trip a base hold naming them", () => {
  const next = rateLimitHold(RATE_LIMIT_OPEN, [obs("dry", T0), obs("clean", T0 + 6_000)], T0 + 6_000);
  assert.equal(next.until, T0 + 6_000 + RATE_LIMIT_HOLD_BASE_MS);
  assert.deepEqual(next.roles, ["clean", "dry"], "distinct roles, sorted");
  assert.equal(next.escalation, 0, "a fresh storm starts at the base");
});

test("429s further apart than the storm window do not add up", () => {
  const stale = obs("readme", T0);
  const now = T0 + RATE_LIMIT_STORM_WINDOW_MS + 1;
  assert.equal(rateLimitHold(RATE_LIMIT_OPEN, [stale, obs("bugfix", now)], now).until, null);
  // Exactly at the window's edge still counts.
  const edge = T0 + RATE_LIMIT_STORM_WINDOW_MS;
  assert.notEqual(rateLimitHold(RATE_LIMIT_OPEN, [stale, obs("bugfix", edge)], edge).until, null);
});

test("the hold honours the largest Retry-After seen, measured from its own 429, and caps it", () => {
  // bugfix was told 300 s at T0; coverage 30 s at T0+10s. The furthest deadline wins.
  const now = T0 + 10_000;
  const held = rateLimitHold(RATE_LIMIT_OPEN, [obs("bugfix", T0, 300), obs("coverage", now, 30)], now);
  assert.equal(held.until, T0 + 300_000);
  // A hint shorter than the base hold does not shorten it.
  const short = rateLimitHold(RATE_LIMIT_OPEN, [obs("bugfix", T0, 5), obs("coverage", T0, 5)], T0);
  assert.equal(short.until, T0 + RATE_LIMIT_HOLD_BASE_MS);
  // A generous hint is capped: one provider cannot park the fleet for hours.
  const huge = rateLimitHold(RATE_LIMIT_OPEN, [obs("bugfix", T0, 9_999), obs("coverage", T0)], T0);
  assert.equal(huge.until, T0 + RATE_LIMIT_HOLD_CAP_MS);
});

test("a held fleet stays held until its deadline, then re-opens by itself", () => {
  const held = trip(RATE_LIMIT_OPEN, T0);
  const until = held.until!;
  // Mid-hold, even fresh 429s from new roles change nothing: the hold is already answering them.
  const mid = rateLimitHold(held, [obs("perf", until - 1), obs("steward", until - 1)], until - 1);
  assert.equal(mid, held);
  const reopened = rateLimitHold(held, [obs("perf", until - 1), obs("steward", until - 1)], until);
  assert.equal(reopened.until, null);
  assert.deepEqual(reopened.roles, []);
  assert.equal(reopened.reopenedAt, until);
  // The 429s that tripped it, and those hit while it held, never re-trip it after re-open.
  const after = rateLimitHold(
    reopened,
    [obs("bugfix", T0), obs("coverage", T0), obs("perf", until - 1), obs("steward", until - 1)],
    until + 1_000,
  );
  assert.equal(after.until, null);
});

test("a storm that resumes right after re-open doubles the hold; one after a calm spell starts fresh", () => {
  let hold = trip(RATE_LIMIT_OPEN, T0);
  hold = rateLimitHold(hold, [], hold.until!); // re-open
  const reopenedAt = hold.reopenedAt!;
  // Relapse 30 s after re-opening: the base hold was too short.
  const relapse = trip(hold, reopenedAt + 30_000);
  assert.equal(relapse.escalation, 1);
  assert.equal(relapse.until, reopenedAt + 30_000 + 2 * RATE_LIMIT_HOLD_BASE_MS);

  // After a calm spell longer than the relapse window, the next storm is a new one.
  const calm = rateLimitHold(relapse, [], relapse.until!); // re-open
  const fresh = trip(calm, calm.reopenedAt! + RATE_LIMIT_RELAPSE_MS + 1);
  assert.equal(fresh.escalation, 0);
  assert.equal(fresh.until! - (calm.reopenedAt! + RATE_LIMIT_RELAPSE_MS + 1), RATE_LIMIT_HOLD_BASE_MS);
});

test("a storm that outlasts every re-open escalates to the cap and stays there", () => {
  let hold = RATE_LIMIT_OPEN;
  let now = T0;
  const lengths: number[] = [];
  for (let i = 0; i < 7; i++) {
    hold = trip(hold, now);
    lengths.push(hold.until! - now);
    now = hold.until!;
    hold = rateLimitHold(hold, [], now); // re-open at the deadline
    now += 1_000; // and the storm is back a second later
  }
  const min = 60_000;
  assert.deepEqual(lengths, [1 * min, 2 * min, 4 * min, 8 * min, 15 * min, 15 * min, 15 * min]);
});
