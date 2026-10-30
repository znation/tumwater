// The failure digest's time-and-spend accounting and the loss-cause ranking it feeds — moved
// out of failure-render.test.ts (2026-10-01) so that file holds the digest's collection,
// rendering, and CLI-shell tests while this one owns the per-role × outcome-class pricing
// (src/failure/failure-time-spend.ts) and the "Top loss causes by time" table's semantics:
// time-first ranking, the queued→merged join, and pooled timeouts. The direct-fold tests
// (through `timeAndSpend` on in-memory events) and the digest-route tests (through
// `collectFailureReport`/`renderFailureMarkdown` on a written event log) live together here —
// the module's one test file, like each of its failure-* siblings.
import test from "node:test";
import assert from "node:assert/strict";
import { renderFailureMarkdown } from "../src/failure/failure-render.js";
import { collectFailureReport } from "../src/failure/failure-data.js";
import { timeAndSpend } from "../src/failure/failure-time-spend.js";
import type { HarnessEvent } from "../src/events/events.js";
import { atLocalTs as at } from "./helpers/oracles.js";
import { writeEvents } from "./fixtures/log-fixtures.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

// The direct fold. These tests pin the rules the digest's numbers live on — the result→class
// mapping, the duration source chain (own durationMs, then the run_start pairing, then 0), the
// queued→merge-outcome join, and the loss-cause keys (error cluster, per-role no_change,
// per-role review-rejected, and per-role merge-conflict/merge-blocked) with their newest-wins
// example and the top-5 cap.
function ev(extra: Partial<HarnessEvent> & { ts?: number }): HarnessEvent {
  return { ts: 1000, source: "coverage", type: "run_end", ...extra } as HarnessEvent;
}

test("outcome classes fold per role: merged, no_change, error; unknown results cost nothing", () => {
  const { timeSpend } = timeAndSpend(
    [
      ev({ ts: 100, result: "changed", durationMs: 1000, costUsd: 0.1 }),
      ev({ ts: 200, result: "no_change", durationMs: 500, costUsd: 0.2 }),
      ev({ ts: 300, result: "error", durationMs: 2000, costUsd: 0.3 }),
      // A result the class map does not know (a new src/run/run-outcome.ts value the fold has
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

test("a queued run whose merge was rejected prices into the error cell and a review-rejected cause", () => {
  const runEnd = ev({
    source: "coverage",
    ts: 100,
    run: 7,
    result: "queued",
    durationMs: 5000,
    costUsd: 0.25,
  });
  const { timeSpend, lossCauses } = timeAndSpend(
    [runEnd],
    [
      runEnd,
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
  // The authoring run's transient queued result resolves to the merge gate's rejection,
  // so its agent-hours leave the merged cell the queued label suggested.
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

test("a queued run with no visible merge outcome keeps the conservative queued→merged reading", () => {
  // Merge still in the pipeline (no outcome event), and an outcome event whose commit does
  // not match the pin: both keep the queued run in the merged cell with no loss cause.
  const queued = ev({ ts: 100, result: "queued", durationMs: 1000 });
  const { timeSpend, lossCauses } = timeAndSpend(
    [queued],
    [queued, ev({ ts: 95, type: "merge_queued", commit: "abc1234" })],
  );
  assert.deepEqual(timeSpend[0]!.classes.merged, { runs: 1, ms: 1000, costUsd: 0 });
  assert.deepEqual(lossCauses, []);
});

test("a queued run whose merge failed to merge owns a cause named by its result", () => {
  // BUGS.md 2026-10-10: the queued→merging join repriced merge_conflict/merge_blocked authoring
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

test("a merge_blocked merge whose merge-scope check was killed at its own deadline names that cause", () => {
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

test("a deadline-killed merge whose timeoutMs is not finite prices as 0s, never NaN", () => {
  // The merge_blocked_deadline example renders the deadlineKilledByRunner filter's matched
  // event — which admits ANY `typeof timeoutMs === "number"`, so a torn/foreign build_check
  // can carry NaN/Infinity. The example reads it through nonNegativeNumber(killed.timeoutMs,
  // 0), so an un-attestable deadline prices as 0s instead of the "its NaNs deadline" a bare
  // `Number(killed.timeoutMs) / 1000` would render. In-memory (timeAndSpend) so the non-finite
  // value survives where a JSON event log would round it to null.
  const { lossCauses } = timeAndSpend(
    [
      ev({ ts: 100, source: "alpha", run: 1, result: "queued", durationMs: 6000, costUsd: 0.1 }),
      ev({ ts: 101, source: "beta", run: 1, result: "queued", durationMs: 6000, costUsd: 0.2 }),
    ],
    [
      ev({ ts: 90, source: "alpha", type: "merge_queued", commit: "def5678" }),
      ev({ ts: 110, source: "alpha", type: "build_check", scope: "merge", status: "failed", timeoutMs: NaN }),
      ev({ ts: 120, source: "alpha", type: "merge_failed", commit: "def5678", result: "merge_blocked" }),
      ev({ ts: 90, source: "beta", type: "merge_queued", commit: "abc1234" }),
      ev({ ts: 110, source: "beta", type: "build_check", scope: "merge", status: "failed", timeoutMs: Infinity }),
      ev({ ts: 120, source: "beta", type: "merge_failed", commit: "abc1234", result: "merge_blocked" }),
    ],
  );
  assert.equal(lossCauses.length, 2);
  assert.ok(lossCauses.every((c) => c.kind === "merge-blocked"));
  assert.equal(lossCauses[0]!.example, "merge build check killed at its 0s deadline (tumwater's own timeout, not a test failure)");
  assert.equal(lossCauses[1]!.example, "merge build check killed at its 0s deadline (tumwater's own timeout, not a test failure)");
});

test("a queued run that failed retriably, was rebased, and recovered into a merge prices into the merged cell (BUGS.md 2026-10-10)", () => {
  // A first merge_blocked keeps the pin; the verification had already rebased the ref to sha2, so
  // recovery re-enqueues sha2 while the failed attempt logged sha1, and sha2's retry lands.
  // The authoring run's span must price under `merged`, with no loss cause, rather than
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

test("a recovery run prices under the review failure it re-queued, not once more under the change's rejection", () => {
  // The authoring run's review timed out, a one-second leftover-recovery run re-queued it, and
  // that attempt was rejected. The rejection owns the authoring span (one run), and the
  // recovery run counts under the timeout it re-queued — the history row's rule — instead of
  // adding a second run to the review-rejected cause.
  const authoring = ev({ ts: 100, source: "feature", run: 1, result: "queued", durationMs: 5000, costUsd: 0.25 });
  const recovery = ev({ ts: 151, source: "feature", run: 2, result: "queued", durationMs: 300, summary: "recovered leftover work from feature: work" });
  const { timeSpend, lossCauses } = timeAndSpend(
    [authoring, recovery],
    [
      ev({ ts: 95, source: "feature", type: "merge_queued", commit: "sha1", summary: "work" }),
      authoring,
      ev({ ts: 110, source: "feature", type: "review_failed", head: "sha1", message: "timed out after 1800s" }),
      ev({ ts: 120, source: "feature", type: "merge_failed", commit: "sha1", result: "review_error" }),
      ev({ ts: 150, source: "feature", type: "merge_queued", commit: "sha1", summary: "recovered leftover work from feature: work" }),
      recovery,
      ev({ ts: 170, source: "feature", type: "review_rejected", head: "sha1", reasons: ["breaks the archive"] }),
      ev({ ts: 180, source: "feature", type: "merge_failed", commit: "sha1", result: "rejected" }),
    ],
  );
  assert.deepEqual(timeSpend[0]!.classes.error, { runs: 2, ms: 5300, costUsd: 0.25 });
  const rejected = lossCauses.find((c) => c.kind === "review-rejected");
  assert.deepEqual([rejected?.runs, rejected?.ms, rejected?.example], [1, 5000, "breaks the archive"]);
  const timeout = lossCauses.find((c) => c.kind === "error-cluster");
  assert.deepEqual([timeout?.runs, timeout?.ms], [1, 300]);
  assert.match(timeout?.example ?? "", /^timed out after 1800s/);
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

test("a no_change run's loss cause is its role, with an empty example", () => {
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

// The digest route — through collectFailureReport/renderFailureMarkdown on a written log.

test("time and spend: one 30-minute timeout outranks ten 1-second errors", () => {
  const root = tmpdir();
  const events: Array<Record<string, unknown>> = [
    { ts: at(0), loop: "bugfix", type: "run_end", run: 1, result: "error", error: "Request timed out", durationMs: 1_800_000, costUsd: 0.5 }, // retired-name-ok: legacy event field in a fixture
  ];
  for (let i = 0; i < 10; i++) {
    events.push({ ts: at(0), loop: "feature", type: "run_end", run: i + 2, result: "error", error: "pi exited 1", durationMs: 1_000, costUsd: 0.01 }); // retired-name-ok: legacy event field in a fixture
  }
  writeEvents(root, events);
  const data = collectFailureReport(root, 1);
  assert.equal(data.lossCauses.length, 2);
  assert.equal(data.lossCauses[0]?.kind, "error-cluster");
  assert.equal(data.lossCauses[0]?.example, "Request timed out", "the timeout ranks first by hours, not by count");
  assert.equal(data.lossCauses[0]?.ms, 1_800_000);
  assert.equal(data.lossCauses[1]?.runs, 10, "the ten 1-second errors rank behind it");
  assert.equal(data.lossCauses[1]?.ms, 10_000);
  assert.equal((data.lossCauses[1]?.costUsd ?? 0).toFixed(2), "0.10", "the ten errors' summed cost");
  const md = renderFailureMarkdown(data);
  const lossBlock = md.slice(md.indexOf("Top loss causes by time:"));
  assert.ok(
    lossBlock.indexOf("Request timed out") < lossBlock.indexOf("pi exited 1"),
    `the digest ranks the timeout first: ${lossBlock}`,
  );
  assert.match(md, /0\.5 h · \$0\.50 — 1 run: Request timed out \(bugfix\)/);
});

test("time and spend folds role × outcome class, pairing old events with run_start", () => {
  const root = tmpdir();
  writeEvents(root, [
    // Old-style event: no durationMs on run_end; the span comes from the run_start pairing.
    { ts: at(0, 11), loop: "feature", type: "run_start", run: 1 }, // retired-name-ok: legacy event field in a fixture
    { ts: at(0, 12), loop: "feature", type: "run_end", run: 1, result: "changed", costUsd: 0.2 }, // retired-name-ok: legacy event field in a fixture
    // New-style event: the event's own durationMs wins over the pairing.
    { ts: at(0, 11), loop: "bugfix", type: "run_start", run: 2 }, // retired-name-ok: legacy event field in a fixture
    { ts: at(0, 12), loop: "bugfix", type: "run_end", run: 2, result: "no_change", durationMs: 3_600_000, costUsd: 0.3 }, // retired-name-ok: legacy event field in a fixture
    // An end whose start rotated out: the run still counts, priced at 0 ms.
    { ts: at(0), loop: "bugfix", type: "run_end", run: 3, result: "error", error: "boom" }, // retired-name-ok: legacy event field in a fixture
  ]);
  const data = collectFailureReport(root, 1);
  const feature = data.timeSpend.find((r) => r.role === "feature");
  assert.deepEqual(feature?.classes.merged, { runs: 1, ms: 3_600_000, costUsd: 0.2 });
  const bugfix = data.timeSpend.find((r) => r.role === "bugfix");
  assert.deepEqual(bugfix?.classes.no_change, { runs: 1, ms: 3_600_000, costUsd: 0.3 });
  assert.deepEqual(bugfix?.classes.error, { runs: 1, ms: 0, costUsd: 0 }, "unpaired: counted, not priced");
  // A no_change role is a loss cause even with no error cluster.
  assert.deepEqual(
    data.lossCauses.map((c) => [c.kind, c.example]),
    [["no_change", ""], ["error-cluster", "boom"]],
    "no_change on bugfix outranks the unpriced error",
  );
  const md = renderFailureMarkdown(data);
  assert.match(md, /\| feature \| 1\.0 h · \$0\.20 \| — \| — \|/);
  assert.match(md, /\| bugfix \| — \| 1\.0 h · \$0\.30 \| 0\.0 h · \$0\.00 \|/);
  assert.match(md, /no change on bugfix/);
});

test("a review-rejected change's authoring hours price into error-class, not merged", () => {
  // The 2026-09-30 digest bug: a run ends `queued` when it pins its change, and the merge
  // slot rejects that change AFTER the run_end — so the fold that reads only run_ends read
  // the authoring span into the merged column, contradicting its own contract ("the review
  // gate" is error-class) and never appearing in the loss ranking. The fold now joins each
  // queued run_end through its merge_queued pin to the same-sha merge_done/merge_failed outcome —
  // history-data's exact join — and prices a rejected merge's authoring span as the loss it
  // was. The fixture uses the live shape: merge_queued DURING the run, review_rejected +
  // merge_failed after it, the merge_failed carrying the MERGE's own duration, not the run's.
  const root = tmpdir();
  const head = (c: string) => c.repeat(40);
  writeEvents(root, [
    // Rejected at the review gate: authoring hours move to error-class + the loss ranking.
    { ts: at(0, 9), loop: "coverage", type: "merge_queued", commit: head("a"), summary: "fix a thing" }, // retired-name-ok: legacy event field in a fixture
    { ts: at(0, 10), loop: "coverage", type: "run_end", run: 1, result: "queued", durationMs: 3_600_000, costUsd: 1.0 }, // retired-name-ok: legacy event field in a fixture
    { ts: at(0, 11), loop: "coverage", type: "review_rejected", head: head("a"), reasons: ["too big"] }, // retired-name-ok: legacy event field in a fixture
    { ts: at(0, 12), loop: "coverage", type: "merge_failed", commit: head("a"), result: "rejected", durationMs: 60_000 }, // retired-name-ok: legacy event field in a fixture
    // Merged normally: the queued→merged reading survives the join.
    { ts: at(0, 9), loop: "feature", type: "merge_queued", commit: head("b"), summary: "land a thing" }, // retired-name-ok: legacy event field in a fixture
    { ts: at(0, 10), loop: "feature", type: "run_end", run: 1, result: "queued", durationMs: 1_800_000, costUsd: 0.2 }, // retired-name-ok: legacy event field in a fixture
    { ts: at(0, 12), loop: "feature", type: "merge_done", commit: head("b"), result: "changed", durationMs: 5_000 }, // retired-name-ok: legacy event field in a fixture
    // Still in the pipeline (no pin, no outcome yet): the conservative fallback keeps it merged.
    { ts: at(0, 10), loop: "bugfix", type: "run_end", run: 1, result: "queued", durationMs: 600_000, costUsd: 0.1 }, // retired-name-ok: legacy event field in a fixture
    // A merge conflict also burns the authoring span into error-class — but is no
    // review-rejection loss cause, having no rejection to name.
    { ts: at(0, 9), loop: "organize", type: "merge_queued", commit: head("c"), summary: "tidy" }, // retired-name-ok: legacy event field in a fixture
    { ts: at(0, 10), loop: "organize", type: "run_end", run: 1, result: "queued", durationMs: 1_200_000, costUsd: 0.3 }, // retired-name-ok: legacy event field in a fixture
    { ts: at(0, 12), loop: "organize", type: "merge_failed", commit: head("c"), result: "merge_conflict", durationMs: 30_000 }, // retired-name-ok: legacy event field in a fixture
  ]);
  const data = collectFailureReport(root, 1);
  const coverage = data.timeSpend.find((r) => r.role === "coverage");
  assert.deepEqual(coverage?.classes.error, { runs: 1, ms: 3_600_000, costUsd: 1.0 }, "the authoring span prices as error-class, not the merge's own 60s");
  assert.equal(coverage?.classes.merged.runs, 0);
  const feature = data.timeSpend.find((r) => r.role === "feature");
  assert.deepEqual(feature?.classes.merged, { runs: 1, ms: 1_800_000, costUsd: 0.2 }, "a merged change stays merged");
  const bugfix = data.timeSpend.find((r) => r.role === "bugfix");
  assert.deepEqual(bugfix?.classes.merged, { runs: 1, ms: 600_000, costUsd: 0.1 }, "an unresolved merge keeps the conservative fallback");
  const organize = data.timeSpend.find((r) => r.role === "organize");
  assert.deepEqual(organize?.classes.error, { runs: 1, ms: 1_200_000, costUsd: 0.3 }, "a merge conflict's authoring span prices as error-class too");

  const rejected = data.lossCauses.find((c) => c.kind === "review-rejected");
  assert.deepEqual(
    rejected && { roles: rejected.roles, example: rejected.example, runs: rejected.runs, ms: rejected.ms, costUsd: rejected.costUsd },
    { roles: ["coverage"], example: "too big", runs: 1, ms: 3_600_000, costUsd: 1.0 },
    "the rejection ranks as its own cause, exemplified by the review_rejected reason",
  );
  assert.equal(
    data.lossCauses.some((c) => c.kind === "review-rejected" && c.roles.includes("organize")),
    false,
    "a merge conflict is no review-rejection cause",
  );
  const conflict = data.lossCauses.find((c) => c.kind === "merge-conflict");
  assert.deepEqual(
    conflict && {
      roles: conflict.roles,
      example: conflict.example,
      runs: conflict.runs,
      ms: conflict.ms,
      costUsd: conflict.costUsd,
    },
    { roles: ["organize"], example: "(no error text recorded)", runs: 1, ms: 1_200_000, costUsd: 0.3 },
    "the merge conflict's authoring span owns a cause named by its result (BUGS.md 2026-10-10)",
  );
  const md = renderFailureMarkdown(data);
  assert.match(md, /review-rejected authoring on coverage — too big/);
  assert.match(md, /merge-conflict authoring on organize/);
  assert.match(md, /\| coverage \| — \| — \| 1\.0 h · \$1\.00 \|/);
});

test("a mixed team of plain and progressing run timeouts pools into one digest cluster", () => {
  const root = tmpdir();
  writeEvents(root, [
    { ts: at(0), loop: "feature", type: "run_end", result: "error", error: "timed out after 1800s", durationMs: 1_800_000, costUsd: 0.10 }, // retired-name-ok: legacy event field in a fixture
    { ts: at(0), loop: "bugfix", type: "run_end", result: "error", // retired-name-ok: legacy event field in a fixture
      error: "timed out after 1800s while still making progress — session and worktree edits preserved for resume",
      durationMs: 3_600_000, costUsd: 0.20 },
    { ts: at(0), loop: "clean", type: "run_end", result: "error", error: "pi exited 1" }, // retired-name-ok: legacy event field in a fixture
  ]);
  const data = collectFailureReport(root, 1);
  // One cause, one knob (runTimeoutSeconds): both shapes are the same timeout, so the digest
  // reports one cluster — not two half-size rows a top-N cut can drop.
  const timeout = data.errors.clusters.find((c) => c.key.startsWith("timed out"));
  assert.ok(timeout, `the timeout cause is itemized: ${JSON.stringify(data.errors.clusters)}`);
  assert.equal(timeout?.key, "timed out after <dur>");
  assert.equal(timeout?.count, 2);
  assert.deepEqual(timeout?.roles, ["bugfix", "feature"]);
  // The loss ranking sums both shapes' agent-hours under the pooled cause.
  const loss = data.lossCauses.find((c) => c.example.startsWith("timed out"));
  assert.ok(loss, `the loss table carries the pooled cause: ${JSON.stringify(data.lossCauses)}`);
  assert.equal(loss?.runs, 2);
  assert.equal(loss?.ms, 5_400_000);
  assert.ok(Math.abs((loss?.costUsd ?? 0) - 0.3) < 1e-9, `summed cost: ${loss?.costUsd}`);
});

test("a cluster that outlived a config change labels itself with its newest message, not its oldest", () => {
  // BUGS.md 2026-09-30: 23 900s review timeouts from 09-28/29 rendered as "timed out after
  // 1800s" because both clusterMessages and the loss fold took the example from the first
  // message seen — the retired value from before the timeout was lowered.
  const root = tmpdir();
  writeEvents(root, [
    { ts: at(0), loop: "review", type: "run_end", result: "error", error: "timed out after 1800s", durationMs: 1_800_000, costUsd: 0.10 }, // retired-name-ok: legacy event field in a fixture
    { ts: at(0, 13), loop: "review", type: "run_end", result: "error", // retired-name-ok: legacy event field in a fixture
      error: "timed out after 900s while still making progress — session and worktree edits preserved for resume",
      durationMs: 900_000, costUsd: 0.20 },
  ]);
  const data = collectFailureReport(root, 1);
  const cluster = data.errors.clusters.find((c) => c.key === "timed out after <dur>");
  assert.ok(cluster, `the pooled timeout cluster exists: ${JSON.stringify(data.errors.clusters)}`);
  assert.match(cluster?.example ?? "", /^timed out after 900s/, "the example is the newest occurrence");
  const loss = data.lossCauses.find((c) => c.example.startsWith("timed out"));
  assert.ok(loss, `the loss cause exists: ${JSON.stringify(data.lossCauses)}`);
  assert.match(loss?.example ?? "", /^timed out after 900s/, "the loss fold follows the same rule");
});

test("a review_error merge prices its authoring hours under the matching review_failed cause", () => {
  // BUGS.md 2026-10-07: a queued run whose merge ended `review_error` — the reviewer's own
  // process failed (a timeout, a dead backend, no parseable verdict) and the pin was re-queued —
  // was priced into the error-class cell but owned by no loss cause, because the rejected-only
  // branch and CLUSTERED_RESULTS both missed it. The matching `review_failed` event carries the
  // message the digest already clusters, so the authoring span now pools under that key.
  const root = tmpdir();
  const head = (c: string) => c.repeat(40);
  writeEvents(root, [
    { ts: at(0, 9), loop: "bugfix", type: "merge_queued", commit: head("d"), summary: "fix a thing" }, // retired-name-ok: legacy event field in a fixture
    { ts: at(0, 10), loop: "bugfix", type: "run_end", run: 1, result: "queued", durationMs: 3_600_000, costUsd: 0.5 }, // retired-name-ok: legacy event field in a fixture
    { ts: at(0, 11), loop: "bugfix", type: "review_failed", head: head("d"), // retired-name-ok: legacy event field in a fixture
      message: "timed out after 900s while still making progress — the commit is kept; the next attempt reviews it from scratch" },
    { ts: at(0, 12), loop: "bugfix", type: "merge_failed", commit: head("d"), result: "review_error", durationMs: 60_000 }, // retired-name-ok: legacy event field in a fixture
  ]);
  const data = collectFailureReport(root, 1);
  assert.deepEqual(
    data.timeSpend.find((r) => r.role === "bugfix")?.classes.error,
    { runs: 1, ms: 3_600_000, costUsd: 0.5 },
    "the authoring span prices as error-class, not the merge's own 60s",
  );
  const loss = data.lossCauses.find((c) => c.roles.includes("bugfix"));
  assert.ok(loss, `the review_error run owns a loss cause: ${JSON.stringify(data.lossCauses)}`);
  assert.equal(loss?.kind, "error-cluster");
  assert.equal(loss?.runs, 1);
  assert.equal(loss?.ms, 3_600_000);
  assert.equal(loss?.costUsd, 0.5);
  assert.match(loss?.example ?? "", /^timed out after 900s/, "exemplified by the matching review_failed message");
  const md = renderFailureMarkdown(data);
  assert.match(md, /timed out after 900s .*\(bugfix\)/, `the loss row names the review failure: ${md}`);
});

test("a rebased review_error merge prices under its review_failed message, not the placeholder", () => {
  // BUGS.md 2026-10-10: every verification rebases its pin onto main before the gate
  // (syncPinToMain),
  // so `review_failed` records the rebased head while `merge_queued`/`merge_failed` keep the
  // authored sha. Matching the event on exact sha missed every rebased verification — the common
  // case on a busy team — and priced the span under the anonymous `(no error text recorded)`
  // placeholder
  // even though the digest's review-failure section held the message. The arm now keys on the
  // merge attempt (the claimed pin and its outcome), not the sha.
  const root = tmpdir();
  const head = (c: string) => c.repeat(40);
  writeEvents(root, [
    { ts: at(0, 9), loop: "bugfix", type: "merge_queued", commit: head("a"), summary: "fix a thing" }, // retired-name-ok: legacy event field in a fixture
    { ts: at(0, 10), loop: "bugfix", type: "run_end", run: 1, result: "queued", durationMs: 3_600_000, costUsd: 0.5 }, // retired-name-ok: legacy event field in a fixture
    // The rebased head B is what the reviewer failed; the pin and the outcome still name A.
    { ts: at(0, 11), loop: "bugfix", type: "review_failed", head: head("b"), // retired-name-ok: legacy event field in a fixture
      message: "timed out after 900s while still making progress — the commit is kept; the next attempt reviews it from scratch" },
    { ts: at(0, 12), loop: "bugfix", type: "merge_failed", commit: head("a"), result: "review_error", durationMs: 60_000 }, // retired-name-ok: legacy event field in a fixture
  ]);
  const data = collectFailureReport(root, 1);
  const loss = data.lossCauses.find((c) => c.roles.includes("bugfix"));
  assert.ok(loss, `the rebased review_error run owns a loss cause: ${JSON.stringify(data.lossCauses)}`);
  assert.equal(loss?.runs, 1);
  assert.equal(loss?.ms, 3_600_000);
  assert.match(loss?.example ?? "", /^timed out after 900s/, `the message labels the span, not the placeholder: ${JSON.stringify(loss)}`);
  assert.notEqual(loss?.example, "(no error text recorded)");
});

test("a rebased review-rejected merge names its reason, not an empty example", () => {
  // The sibling of the review_error arm: the same pre-review rebase moves `review_rejected.head`
  // off the authored sha while `merge_queued`/`merge_failed` keep it, so exact-sha equality left
  // the review-rejected cause with no reason. The arm now keys on the claimed pin and its
  // outcome, the merge attempt. The existing rejected fixture uses head === commit, which
  // matches the old filter and hid this.
  const root = tmpdir();
  const head = (c: string) => c.repeat(40);
  writeEvents(root, [
    { ts: at(0, 9), loop: "coverage", type: "merge_queued", commit: head("a"), summary: "fix a thing" }, // retired-name-ok: legacy event field in a fixture
    { ts: at(0, 10), loop: "coverage", type: "run_end", run: 1, result: "queued", durationMs: 3_600_000, costUsd: 1.0 }, // retired-name-ok: legacy event field in a fixture
    // The rebased head B is what the reviewer rejected; the pin and the outcome still name A.
    { ts: at(0, 11), loop: "coverage", type: "review_rejected", head: head("b"), reasons: ["too big"] }, // retired-name-ok: legacy event field in a fixture
    { ts: at(0, 12), loop: "coverage", type: "merge_failed", commit: head("a"), result: "rejected", durationMs: 60_000 }, // retired-name-ok: legacy event field in a fixture
  ]);
  const data = collectFailureReport(root, 1);
  const loss = data.lossCauses.find((c) => c.kind === "review-rejected");
  assert.ok(loss, `the rebased rejection owns a loss cause: ${JSON.stringify(data.lossCauses)}`);
  assert.equal(loss?.runs, 1);
  assert.equal(loss?.ms, 3_600_000);
  assert.equal(loss?.example, "too big", `the reason labels the cause: ${JSON.stringify(loss)}`);
});

test("a main_red run prices its red-main cause into the loss ranking, not only the error clusters", () => {
  // BUGS.md 2026-10-07: a `main_red` run is error-class, but the loss fold's CLUSTERED_RESULTS
  // missed it, so its hours merged in the error-class cell and in the digest's error clusters
  // while owned by no loss cause and not even counted by lossCausesHidden. Its run_end carries
  // the same verbatim redMainMessage the error-clusters section clusters, so it joins the fold.
  const root = tmpdir();
  writeEvents(root, [
    { ts: at(0), loop: "feature", type: "run_end", result: "main_red", // retired-name-ok: legacy event field in a fixture
      error: "main abc1234 is red (test: boom) — authoring skipped until main is green",
      durationMs: 3_600_000, costUsd: 0.05 },
    // A cause-less main_red still owns its span under the shared placeholder rather than vanishing.
    { ts: at(0), loop: "improve", type: "run_end", result: "main_red" }, // retired-name-ok: legacy event field in a fixture
  ]);
  const data = collectFailureReport(root, 1);
  const red = data.lossCauses.find((c) => c.example.includes("is red"));
  assert.ok(red, `the red-main cause is ranked, not dropped: ${JSON.stringify(data.lossCauses)}`);
  assert.equal(red?.kind, "error-cluster");
  assert.deepEqual(red?.roles, ["feature"]);
  assert.equal(red?.ms, 3_600_000);
  assert.ok(Math.abs((red?.costUsd ?? 0) - 0.05) < 1e-9, `the red-main spend is priced: ${red?.costUsd}`);
  const blank = data.lossCauses.find((c) => c.example === "(no error text recorded)");
  assert.ok(blank, `the cause-less main_red itemizes under the placeholder: ${JSON.stringify(data.lossCauses)}`);
  assert.deepEqual(blank?.roles, ["improve"]);
  assert.equal(
    data.lossCauses.reduce((n, c) => n + c.runs, 0),
    2,
    "both main_red spans are owned by a loss cause",
  );
  assert.equal(data.lossCausesHidden, 0, "neither cause is dropped by the top-N cut");
});

test("a refused run prices its own loss cause, not no_change", () => {
  // PLANS.md 2026-10-14: a refusal is a deliberate objection that blocks its entry, yet the
  // loss fold bucketed every no_change-class run under `no_change\u0000<role>` — so a role
  // that actively refuses priced into the digest exactly like a quietly idle one. A refused
  // still counts under no_change in the outcome table (that three-class table is its stated
  // contract), but the loss ranking names the objection via the refusal's own summary.
  const root = tmpdir();
  writeEvents(root, [
    { ts: at(0), loop: "feature", type: "run_end", run: 1, result: "refused", // retired-name-ok: legacy event field in a fixture
      summary: "record: refusal-verdict reason at head", durationMs: 3_600_000, costUsd: 0.5 },
    // The same role idles in a sibling window: its quiet no_change must stay its own cause.
    { ts: at(0, 1), loop: "feature", type: "run_end", run: 2, result: "no_change", // retired-name-ok: legacy event field in a fixture
      durationMs: 1_800_000, costUsd: 0.3 },
  ]);
  const data = collectFailureReport(root, 1);
  const refused = data.lossCauses.find((c) => c.kind === "refused");
  assert.ok(refused, `a refusal names its own loss cause: ${JSON.stringify(data.lossCauses)}`);
  assert.deepEqual(refused?.roles, ["feature"]);
  assert.equal(refused?.example, "record: refusal-verdict reason at head", "the example is the refusal's summary");
  assert.equal(refused?.runs, 1);
  assert.equal(refused?.ms, 3_600_000);
  assert.ok(Math.abs((refused?.costUsd ?? 0) - 0.5) < 1e-9, `the refusal's cost is priced: ${refused?.costUsd}`);
  const idle = data.lossCauses.find((c) => c.kind === "no_change");
  assert.ok(idle, `the idling run stays its own no_change cause: ${JSON.stringify(data.lossCauses)}`);
  assert.equal(idle?.runs, 1, "the idle and refused runs are not merged");
  assert.equal(idle?.example, "", "no_change keeps its empty example");
  // The outcome table still folds the refusal under no_change, its class contract unchanged.
  const feature = data.timeSpend.find((r) => r.role === "feature");
  assert.deepEqual(feature?.classes.no_change, { runs: 2, ms: 5_400_000, costUsd: 0.8 });
  assert.deepEqual(feature?.classes.merged, { runs: 0, ms: 0, costUsd: 0 });
  assert.deepEqual(data.lossCauses.reduce((n, c) => n + c.runs, 0), 2, "both runs are owned by a loss cause");
});

test("a context cut-off run prices its own loss cause, not no_change", () => {
  // PLANS.md 2026-10-25: a run truncated at its model's context ceiling ends no_change with
  // cutOff: true, yet the loss fold bucketed every no_change-class run under
  // `no_change\u0000<role>` — so a role that burned a whole context window priced into the
  // digest exactly like one that quietly idled. A cut-off still counts under no_change in the
  // outcome table (that three-class table is its stated class contract), but the loss ranking
  // names the context cut-off as its own cause.
  const root = tmpdir();
  writeEvents(root, [
    { ts: at(0), loop: "feature", type: "run_end", run: 1, result: "no_change", cutOff: true, // retired-name-ok: legacy event field in a fixture
      durationMs: 3_600_000, costUsd: 0.5 },
    // The same role idles in a sibling run: its quiet no_change must stay its own cause.
    { ts: at(0, 1), loop: "feature", type: "run_end", run: 2, result: "no_change", // retired-name-ok: legacy event field in a fixture
      durationMs: 1_800_000, costUsd: 0.3 },
  ]);
  const data = collectFailureReport(root, 1);
  const cutoff = data.lossCauses.find((c) => c.kind === "cutoff");
  assert.ok(cutoff, `a context cut-off names its own loss cause: ${JSON.stringify(data.lossCauses)}`);
  assert.deepEqual(cutoff?.roles, ["feature"]);
  assert.equal(cutoff?.example, "", "a cut-off cause keeps an empty example, like no_change");
  assert.equal(cutoff?.runs, 1);
  assert.equal(cutoff?.ms, 3_600_000);
  assert.ok(Math.abs((cutoff?.costUsd ?? 0) - 0.5) < 1e-9, `the cut-off's cost is priced: ${cutoff?.costUsd}`);
  const idle = data.lossCauses.find((c) => c.kind === "no_change");
  assert.ok(idle, `the idling run stays its own no_change cause: ${JSON.stringify(data.lossCauses)}`);
  assert.equal(idle?.runs, 1, "the idle and cut-off runs are not merged");
  assert.equal(idle?.ms, 1_800_000);
  // The outcome table still folds the cut-off run under no_change, its class contract unchanged.
  const feature = data.timeSpend.find((r) => r.role === "feature");
  assert.deepEqual(feature?.classes.no_change, { runs: 2, ms: 5_400_000, costUsd: 0.8 });
  assert.deepEqual(feature?.classes.merged, { runs: 0, ms: 0, costUsd: 0 });
  const md = renderFailureMarkdown(data);
  assert.match(md, /context cut-off on feature/);
  assert.match(md, /no change on feature/);
  assert.equal(data.lossCauses.reduce((n, c) => n + c.runs, 0), 2, "both runs are owned by a loss cause");
});
