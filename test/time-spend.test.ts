import test from "node:test";
import assert from "node:assert/strict";
import { timeAndSpend } from "../src/time-spend.js";
import type { HarnessEvent } from "../src/events.js";

// The failure digest's time-and-spend fold: how the window's tick_ends price into the
// per-role × outcome-class table and the loss-cause ranking. These tests pin the rules the
// digest's numbers live on — the result→class mapping, the duration source chain (own
// durationMs, then the tick_start pairing, then 0), the queued→landing-outcome join, and the
// loss-cause keys (error cluster, per-role no_change, per-role review-rejected) with their
// newest-wins example and the top-5 cap.

function ev(extra: Partial<HarnessEvent> & { ts?: number }): HarnessEvent {
  return { ts: 1000, loop: "coverage", type: "tick_end", ...extra } as HarnessEvent;
}

test("outcome classes fold per role: landed, no_change, error; unknown results cost nothing", () => {
  const { timeSpend } = timeAndSpend(
    [
      ev({ ts: 100, result: "changed", durationMs: 1000, costUsd: 0.1 }),
      ev({ ts: 200, result: "no_change", durationMs: 500, costUsd: 0.2 }),
      ev({ ts: 300, result: "error", durationMs: 2000, costUsd: 0.3 }),
      // A result the class map does not know (a new src/tick/tick-outcome.ts value the fold has
      // not been taught) is skipped by costing, not guessed into a class.
      ev({ ts: 400, result: "mystery", durationMs: 9000, costUsd: 9 }),
    ],
    [],
  );
  assert.deepEqual(timeSpend, [
    {
      role: "coverage",
      classes: {
        landed: { ticks: 1, ms: 1000, costUsd: 0.1 },
        no_change: { ticks: 1, ms: 500, costUsd: 0.2 },
        error: { ticks: 1, ms: 2000, costUsd: 0.3 },
      },
    },
  ]);
});

test("duration source chain: own durationMs, else the tick_start pairing, else 0", () => {
  const { timeSpend } = timeAndSpend(
    [
      ev({ ts: 2000, tick: 1, result: "changed" }), // paired: span 2000−1000
      ev({ ts: 3000, tick: 2, result: "no_change", durationMs: 500 }), // own wins
      ev({ ts: 4000, tick: 99, result: "error" }), // unpaired start (rotation cut it): 0
    ],
    [ev({ ts: 1000, type: "tick_start", tick: 1 })],
  );
  assert.deepEqual(timeSpend[0]!.classes, {
    landed: { ticks: 1, ms: 1000, costUsd: 0 },
    no_change: { ticks: 1, ms: 500, costUsd: 0 },
    error: { ticks: 1, ms: 0, costUsd: 0 },
  });
});

test("rows rank by summed wall-clock ms, roles tie-broken by name", () => {
  const { timeSpend } = timeAndSpend(
    [
      ev({ loop: "alpha", ts: 100, result: "changed", durationMs: 100 }),
      ev({ loop: "beta", ts: 100, result: "changed", durationMs: 300 }),
      ev({ loop: "beta", ts: 200, result: "no_change", durationMs: 300 }),
      ev({ loop: "gamma", ts: 100, result: "error", durationMs: 300 }),
    ],
    [],
  );
  assert.deepEqual(
    timeSpend.map((r) => r.role),
    ["beta", "gamma", "alpha"], // beta 600 > gamma 300 > alpha 100
  );
});

test("a queued tick whose landing was rejected prices into the error cell and a review-rejected cause", () => {
  const tickEnd = ev({
    loop: "coverage",
    ts: 100,
    tick: 7,
    result: "queued",
    durationMs: 5000,
    costUsd: 0.25,
  });
  const { timeSpend, lossCauses } = timeAndSpend(
    [tickEnd],
    [
      tickEnd,
      ev({ loop: "coverage", ts: 95, type: "land_queued", commit: "abc1234" }),
      ev({
        loop: "coverage",
        ts: 112,
        type: "review_rejected",
        head: "abc1234",
        reasons: ["type error: foo is not defined"],
      }),
      ev({
        loop: "coverage",
        ts: 120,
        type: "land_failed",
        commit: "abc1234",
        result: "rejected",
      }),
    ],
  );
  // The authoring tick's transient queued result resolves to the landing gate's rejection,
  // so its agent-hours leave the landed cell the queued label suggested.
  assert.deepEqual(timeSpend[0]!.classes.error, { ticks: 1, ms: 5000, costUsd: 0.25 });
  assert.deepEqual(timeSpend[0]!.classes.landed, { ticks: 0, ms: 0, costUsd: 0 });
  assert.deepEqual(lossCauses, [
    {
      kind: "review-rejected",
      roles: ["coverage"],
      example: "type error: foo is not defined",
      ticks: 1,
      ms: 5000,
      costUsd: 0.25,
    },
  ]);
});

test("a queued tick with no visible landing outcome keeps the conservative queued→landed reading", () => {
  // Landing still in the pipeline (no outcome event), and an outcome event whose commit does
  // not match the pin: both keep the queued tick in the landed cell with no loss cause.
  const queued = ev({ ts: 100, result: "queued", durationMs: 1000 });
  const { timeSpend, lossCauses } = timeAndSpend(
    [queued],
    [queued, ev({ ts: 95, type: "land_queued", commit: "abc1234" })],
  );
  assert.deepEqual(timeSpend[0]!.classes.landed, { ticks: 1, ms: 1000, costUsd: 0 });
  assert.deepEqual(lossCauses, []);
});

test("an error cluster pools its members' time across roles and its example rides lastSeen", () => {
  const events = [
    ev({ loop: "qa", ts: 100, result: "error", error: "pi exited 1: boom 3", durationMs: 1000 }),
    ev({ loop: "qa", ts: 300, result: "error", error: "pi exited 1: boom 42", durationMs: 500 }),
    ev({
      loop: "coverage",
      ts: 500,
      result: "error",
      error: "pi exited 1: boom 7",
      durationMs: 2000,
      costUsd: 0.5,
    }),
  ];
  const { lossCauses } = timeAndSpend(events, events);
  assert.deepEqual(lossCauses, [
    {
      kind: "error-cluster",
      roles: ["coverage", "qa"], // unique, sorted
      example: "pi exited 1: boom 7", // the newest verbatim occurrence, not the first-seen one
      ticks: 3,
      ms: 3500,
      costUsd: 0.5,
    },
  ]);
});

test("a no_change tick's loss cause is its role, with an empty example", () => {
  const { lossCauses } = timeAndSpend(
    [ev({ loop: "steward", ts: 100, result: "no_change", durationMs: 400 })],
    [],
  );
  assert.deepEqual(lossCauses, [
    { kind: "no_change", roles: ["steward"], example: "", ticks: 1, ms: 400, costUsd: 0 },
  ]);
});

test("the loss ranking keeps at most five causes", () => {
  const events = ["r1", "r2", "r3", "r4", "r5", "r6"].map((role, i) =>
    ev({ loop: role, ts: 100 + i, result: "no_change", durationMs: 1000 }),
  );
  const { lossCauses, timeSpend } = timeAndSpend(events, events);
  assert.equal(timeSpend.length, 6); // the table keeps every role
  assert.equal(lossCauses.length, 5); // the ranking caps at LOSS_TOP
});
