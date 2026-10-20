import test from "node:test";
import assert from "node:assert/strict";
import { TEAM_OPEN, teamHold, HOLD_BASE_MS, type HoldKind, type HoldObservation } from "../src/team/team-hold.js";

// Edge clauses of teamHold (src/team/team-hold.ts) that test/team-hold.test.ts leaves open: which
// qualifying group wins a poll, and the strict re-open boundary.

const T0 = 1_000_000_000;

function obs(role: string, at: number, kind: HoldKind = "rate-limit"): HoldObservation {
  return { role, at, kind };
}

test("when two provider+kind groups both storm in one poll, the first one seen wins", () => {
  const connectionFirst = teamHold(
    TEAM_OPEN,
    [obs("dedupe", T0, "connection"), obs("perf", T0, "server"), obs("qa", T0, "connection"), obs("readme", T0, "server")],
    T0,
  );
  assert.equal(connectionFirst.kind, "connection");
  assert.deepEqual(connectionFirst.roles, ["dedupe", "qa"]);
  assert.equal(connectionFirst.until, T0 + HOLD_BASE_MS);

  const serverFirst = teamHold(
    TEAM_OPEN,
    [obs("perf", T0, "server"), obs("dedupe", T0, "connection"), obs("readme", T0, "server"), obs("qa", T0, "connection")],
    T0,
  );
  assert.equal(serverFirst.kind, "server");
  assert.deepEqual(serverFirst.roles, ["perf", "readme"]);
});

test("a failure stamped at the re-open poll never re-trips the hold; one a millisecond later does", () => {
  const held = teamHold(TEAM_OPEN, [obs("bugfix", T0), obs("coverage", T0)], T0);
  const until = held.until!;
  const reopened = teamHold(held, [obs("perf", until), obs("steward", until)], until);
  assert.equal(reopened.until, null);
  assert.equal(reopened.reopenedAt, until);

  const relapsed = teamHold(reopened, [obs("perf", until + 1), obs("steward", until + 1)], until + 1);
  assert.equal(relapsed.escalation, 1);
  assert.equal(relapsed.until, until + 1 + 2 * HOLD_BASE_MS);
});
