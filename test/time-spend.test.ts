import test from "node:test";
import assert from "node:assert/strict";
import { timeAndSpend } from "../src/failure/time-spend.js";
import type { HarnessEvent } from "../src/events/events.js";

// The failure digest's time-and-spend fold: how the window's run_ends price into the
// per-role × outcome-class table and the loss-cause ranking. These tests pin the rules the
// digest's numbers live on — the result→class mapping, the duration source chain (own
// durationMs, then the run_start pairing, then 0), the queued→landing-outcome join, and the
// loss-cause keys (error cluster, per-role no_change, per-role review-rejected, and per-role
// merge-conflict/merge-blocked) with their newest-wins example and the top-5 cap.

function ev(extra: Partial<HarnessEvent> & { ts?: number }): HarnessEvent {
  return { ts: 1000, source: "coverage", type: "run_end", ...extra } as HarnessEvent;
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
        merged: { runs: 1, ms: 1000, costUsd: 0.1 },
        no_change: { runs: 1, ms: 500, costUsd: 0.2 },
        error: { runs: 1, ms: 2000, costUsd: 0.3 },
      },
    },
  ]);
});

test("duration source chain: own durationMs, else the run_start pairing, else 0", () => {
  const { timeSpend } = timeAndSpend(
    [
      ev({ ts: 2000, run: 1, result: "changed" }), // paired: span 2000−1000
      ev({ ts: 3000, run: 2, result: "no_change", durationMs: 500 }), // own wins
      ev({ ts: 4000, run: 99, result: "error" }), // unpaired start (rotation cut it): 0
    ],
    [ev({ ts: 1000, type: "run_start", run: 1 })],
  );
  assert.deepEqual(timeSpend[0]!.classes, {
    merged: { runs: 1, ms: 1000, costUsd: 0 },
    no_change: { runs: 1, ms: 500, costUsd: 0 },
    error: { runs: 1, ms: 0, costUsd: 0 },
  });
});

test("rows rank by summed wall-clock ms, roles tie-broken by name", () => {
  const { timeSpend } = timeAndSpend(
    [
      ev({ source: "alpha", ts: 100, result: "changed", durationMs: 100 }),
      ev({ source: "beta", ts: 100, result: "changed", durationMs: 300 }),
      ev({ source: "beta", ts: 200, result: "no_change", durationMs: 300 }),
      ev({ source: "gamma", ts: 100, result: "error", durationMs: 300 }),
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
    source: "coverage",
    ts: 100,
    run: 7,
    result: "queued",
    durationMs: 5000,
    costUsd: 0.25,
  });
  const { timeSpend, lossCauses } = timeAndSpend(
    [tickEnd],
    [
      tickEnd,
      ev({ source: "coverage", ts: 95, type: "merge_queued", commit: "abc1234" }),
      ev({
        source: "coverage",
        ts: 112,
        type: "review_rejected",
        head: "abc1234",
        reasons: ["type error: foo is not defined"],
      }),
      ev({
        source: "coverage",
        ts: 120,
        type: "merge_failed",
        commit: "abc1234",
        result: "rejected",
      }),
    ],
  );
  // The authoring tick's transient queued result resolves to the landing gate's rejection,
  // so its agent-hours leave the landed cell the queued label suggested.
  assert.deepEqual(timeSpend[0]!.classes.error, { runs: 1, ms: 5000, costUsd: 0.25 });
  assert.deepEqual(timeSpend[0]!.classes.merged, { runs: 0, ms: 0, costUsd: 0 });
  assert.deepEqual(lossCauses, [
    {
      kind: "review-rejected",
      roles: ["coverage"],
      example: "type error: foo is not defined",
      runs: 1,
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
    [queued, ev({ ts: 95, type: "merge_queued", commit: "abc1234" })],
  );
  assert.deepEqual(timeSpend[0]!.classes.merged, { runs: 1, ms: 1000, costUsd: 0 });
  assert.deepEqual(lossCauses, []);
});

test("a queued tick whose landing failed to merge owns a cause named by its result", () => {
  // BUGS.md 2026-10-10: the queued→landing join repriced merge_conflict/merge_blocked authoring
  // spans into the error-class cell but gave them no loss cause, so those hours were owned by
  // no cause and were not counted by lossCausesHidden. Each now itemizes under its own result,
  // taking the shared no-text placeholder because merge_failed carries no message.
  const conflict = ev({ ts: 100, run: 1, result: "queued", durationMs: 5000, costUsd: 0.25 });
  const blocked = ev({ ts: 100, source: "feature", run: 1, result: "queued", durationMs: 6000, costUsd: 0.1 });
  const { timeSpend, lossCauses, lossCausesHidden } = timeAndSpend(
    [conflict, blocked],
    [
      conflict,
      blocked,
      ev({ ts: 95, type: "merge_queued", commit: "abc1234" }),
      ev({ ts: 90, source: "feature", type: "merge_queued", commit: "def5678" }),
      ev({ ts: 120, type: "merge_failed", commit: "abc1234", result: "merge_conflict" }),
      ev({ ts: 120, source: "feature", type: "merge_failed", commit: "def5678", result: "merge_blocked" }),
    ],
  );
  assert.deepEqual(timeSpend.map((r) => [r.role, r.classes.error]), [
    ["feature", { runs: 1, ms: 6000, costUsd: 0.1 }],
    ["coverage", { runs: 1, ms: 5000, costUsd: 0.25 }],
  ]);
  assert.deepEqual(lossCauses, [
    { kind: "merge-blocked", roles: ["feature"], example: "(no error text recorded)", runs: 1, ms: 6000, costUsd: 0.1 },
    { kind: "merge-conflict", roles: ["coverage"], example: "(no error text recorded)", runs: 1, ms: 5000, costUsd: 0.25 },
  ]);
  assert.equal(lossCausesHidden, 0, "both merge causes are owned, not hidden");
});

test("a merge_blocked landing whose merge-scope check was killed at its own deadline names that cause", () => {
  const blocked = ev({ ts: 100, source: "feature", run: 1, result: "queued", durationMs: 6000, costUsd: 0.1 });
  const { lossCauses } = timeAndSpend(
    [blocked],
    [
      blocked,
      ev({ ts: 90, source: "feature", type: "merge_queued", commit: "def5678" }),
      ev({ ts: 110, source: "feature", type: "build_check", scope: "batch", status: "failed", timeoutMs: 300000, deadlineLateMs: 20 }),
      ev({ ts: 120, source: "feature", type: "merge_failed", commit: "def5678", result: "merge_blocked" }),
    ],
  );
  assert.equal(lossCauses.length, 1);
  assert.equal(lossCauses[0]!.kind, "merge-blocked");
  assert.match(lossCauses[0]!.example, /batch build check killed at its 300s deadline/);
});

test("a queued tick that failed retriably, was rebased, and recovered into a landing prices into the landed cell (BUGS.md 2026-10-10)", () => {
  // A first merge_blocked keeps the pin; the vet had already rebased the ref to sha2, so
  // recovery re-enqueues sha2 while the failed attempt logged sha1, and sha2's retry lands.
  // The authoring tick's span must price under `landed`, with no loss cause, rather than
  // latch the retriable failure and burn agent-hours into the error cell.
  const queued = ev({ ts: 100, source: "feature", run: 1, result: "queued", durationMs: 5000, costUsd: 0.25 });
  const { timeSpend, lossCauses } = timeAndSpend(
    [queued],
    [
      queued,
      ev({ ts: 95, source: "feature", type: "merge_queued", commit: "sha1" }),
      ev({ ts: 120, source: "feature", type: "merge_failed", commit: "sha1", result: "merge_blocked" }),
      ev({ ts: 150, source: "feature", type: "merge_queued", commit: "sha2", summary: "recovered leftover work from feature" }),
      ev({ ts: 180, source: "feature", type: "merge_done", commit: "sha2", result: "changed" }),
    ],
  );
  assert.deepEqual(timeSpend[0]!.classes.merged, { runs: 1, ms: 5000, costUsd: 0.25 });
  assert.deepEqual(timeSpend[0]!.classes.error, { runs: 0, ms: 0, costUsd: 0 });
  assert.deepEqual(lossCauses, []);
});

test("an error cluster pools its members' time across roles and its example rides lastSeen", () => {
  const events = [
    ev({ source: "qa", ts: 100, result: "error", error: "pi exited 1: boom 3", durationMs: 1000 }),
    ev({ source: "qa", ts: 300, result: "error", error: "pi exited 1: boom 42", durationMs: 500 }),
    ev({
      source: "coverage",
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
      runs: 3,
      ms: 3500,
      costUsd: 0.5,
    },
  ]);
});

test("a no_change tick's loss cause is its role, with an empty example", () => {
  const { lossCauses } = timeAndSpend(
    [ev({ source: "steward", ts: 100, result: "no_change", durationMs: 400 })],
    [],
  );
  assert.deepEqual(lossCauses, [
    { kind: "no_change", roles: ["steward"], example: "", runs: 1, ms: 400, costUsd: 0 },
  ]);
});

test("a clustered failure that records no error text still itemizes a loss cause", () => {
  const events = [
    ev({ source: "bugfix", ts: 100, result: "aborted", durationMs: 600_000, costUsd: 0.4 }),
    ev({ source: "feature", ts: 200, result: "error", durationMs: 60_000, costUsd: 0.1 }),
  ];
  const { timeSpend, lossCauses, lossCausesHidden } = timeAndSpend(events, events);
  // The error-class cells price both spans…
  assert.equal(timeSpend.find((r) => r.role === "bugfix")!.classes.error.ms, 600_000);
  assert.equal(timeSpend.find((r) => r.role === "feature")!.classes.error.ms, 60_000);
  // …and, rather than dropping the message-less clustered results, the ranking itemizes
  // them under the digest's no-text placeholder — the same one the error-clusters section uses.
  assert.deepEqual(lossCauses, [
    {
      kind: "error-cluster",
      roles: ["bugfix", "feature"],
      example: "(no error text recorded)",
      runs: 2,
      ms: 660_000,
      costUsd: 0.5,
    },
  ]);
  assert.equal(lossCausesHidden, 0);
});

test("the loss ranking keeps at most five causes", () => {
  const events = ["r1", "r2", "r3", "r4", "r5", "r6"].map((role, i) =>
    ev({ source: role, ts: 100 + i, result: "no_change", durationMs: 1000 }),
  );
  const { lossCauses, timeSpend } = timeAndSpend(events, events);
  assert.equal(timeSpend.length, 6); // the table keeps every role
  assert.equal(lossCauses.length, 5); // the ranking caps at LOSS_TOP
});
