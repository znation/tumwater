// The failure digest's time-and-spend accounting and the loss-cause ranking it feeds — moved
// out of failure-render.test.ts (2026-10-01) so that file holds the digest's collection,
// rendering, and CLI-shell tests while this one owns the per-role × outcome-class pricing
// (src/failure/time-spend.ts, folded in through collectFailureReport) and the "Top loss causes by
// time" table's semantics: time-first ranking, the queued→landed join, and pooled timeouts.
import test from "node:test";
import assert from "node:assert/strict";
import { renderFailureMarkdown } from "../src/failure/failure-render.js";
import { collectFailureReport } from "../src/failure/failure-data.js";
import { atLocalTs as at } from "./oracles.js";
import { writeEvents } from "./log-fixtures.js";
import { tmpdir } from "./repo-fixtures.js";

test("time and spend: one 30-minute timeout outranks ten 1-second errors", () => {
  const root = tmpdir();
  const events: Array<Record<string, unknown>> = [
    { ts: at(0), loop: "bugfix", type: "tick_end", tick: 1, result: "error", error: "Request timed out", durationMs: 1_800_000, costUsd: 0.5 },
  ];
  for (let i = 0; i < 10; i++) {
    events.push({ ts: at(0), loop: "feature", type: "tick_end", tick: i + 2, result: "error", error: "pi exited 1", durationMs: 1_000, costUsd: 0.01 });
  }
  writeEvents(root, events);
  const data = collectFailureReport(root, 1);
  assert.equal(data.lossCauses.length, 2);
  assert.equal(data.lossCauses[0]?.kind, "error-cluster");
  assert.equal(data.lossCauses[0]?.example, "Request timed out", "the timeout ranks first by hours, not by count");
  assert.equal(data.lossCauses[0]?.ms, 1_800_000);
  assert.equal(data.lossCauses[1]?.ticks, 10, "the ten 1-second errors rank behind it");
  assert.equal(data.lossCauses[1]?.ms, 10_000);
  assert.equal((data.lossCauses[1]?.costUsd ?? 0).toFixed(2), "0.10", "the ten errors' summed cost");
  const md = renderFailureMarkdown(data);
  const lossBlock = md.slice(md.indexOf("Top loss causes by time:"));
  assert.ok(
    lossBlock.indexOf("Request timed out") < lossBlock.indexOf("pi exited 1"),
    `the digest ranks the timeout first: ${lossBlock}`,
  );
  assert.match(md, /0\.5 h · \$0\.50 — 1 tick: Request timed out \(bugfix\)/);
});

test("time and spend folds role × outcome class, pairing old events with tick_start", () => {
  const root = tmpdir();
  writeEvents(root, [
    // Old-style event: no durationMs on tick_end; the span comes from the tick_start pairing.
    { ts: at(0, 11), loop: "feature", type: "tick_start", tick: 1 },
    { ts: at(0, 12), loop: "feature", type: "tick_end", tick: 1, result: "changed", costUsd: 0.2 },
    // New-style event: the event's own durationMs wins over the pairing.
    { ts: at(0, 11), loop: "bugfix", type: "tick_start", tick: 2 },
    { ts: at(0, 12), loop: "bugfix", type: "tick_end", tick: 2, result: "no_change", durationMs: 3_600_000, costUsd: 0.3 },
    // An end whose start rotated out: the tick still counts, priced at 0 ms.
    { ts: at(0), loop: "bugfix", type: "tick_end", tick: 3, result: "error", error: "boom" },
  ]);
  const data = collectFailureReport(root, 1);
  const feature = data.timeSpend.find((r) => r.role === "feature");
  assert.deepEqual(feature?.classes.landed, { ticks: 1, ms: 3_600_000, costUsd: 0.2 });
  const bugfix = data.timeSpend.find((r) => r.role === "bugfix");
  assert.deepEqual(bugfix?.classes.no_change, { ticks: 1, ms: 3_600_000, costUsd: 0.3 });
  assert.deepEqual(bugfix?.classes.error, { ticks: 1, ms: 0, costUsd: 0 }, "unpaired: counted, not priced");
  // A no_change role is a loss cause even with no error cluster.
  assert.deepEqual(
    data.lossCauses.map((c) => [c.kind, c.example]),
    [["no_change", ""], ["error-cluster", "boom"]],
    "no_change on bugfix outranks the unpriced error",
  );
  const md = renderFailureMarkdown(data);
  assert.match(md, /\| feature \| 1\.0 h · \$0\.20 \| — \| — \|/);
  assert.match(md, /\| bugfix \| — \| 1\.0 h · \$0\.30 \| 0\.0 h · \$0\.00 \|/);
  assert.match(md, /no_change on bugfix/);
});

test("a review-rejected change's authoring hours price into error-class, not landed", () => {
  // The 2026-09-30 digest bug: a tick ends `queued` when it pins its change, and the landing
  // slot rejects that change AFTER the tick_end — so the fold that reads only tick_ends read
  // the authoring span into the landed column, contradicting its own contract ("the review
  // gate" is error-class) and never appearing in the loss ranking. The fold now joins each
  // queued tick_end through its land_queued pin to the same-sha landed/land_failed outcome —
  // history-data's exact join — and prices a rejected landing's authoring span as the loss it
  // was. The fixture uses the live shape: land_queued DURING the tick, review_rejected +
  // land_failed after it, the land_failed carrying the LANDING's own duration, not the tick's.
  const root = tmpdir();
  const head = (c: string) => c.repeat(40);
  writeEvents(root, [
    // Rejected at the review gate: authoring hours move to error-class + the loss ranking.
    { ts: at(0, 9), loop: "coverage", type: "land_queued", commit: head("a"), summary: "fix a thing" },
    { ts: at(0, 10), loop: "coverage", type: "tick_end", tick: 1, result: "queued", durationMs: 3_600_000, costUsd: 1.0 },
    { ts: at(0, 11), loop: "coverage", type: "review_rejected", head: head("a"), reasons: ["too big"] },
    { ts: at(0, 12), loop: "coverage", type: "land_failed", commit: head("a"), result: "rejected", durationMs: 60_000 },
    // Landed normally: the queued→landed reading survives the join.
    { ts: at(0, 9), loop: "feature", type: "land_queued", commit: head("b"), summary: "land a thing" },
    { ts: at(0, 10), loop: "feature", type: "tick_end", tick: 1, result: "queued", durationMs: 1_800_000, costUsd: 0.2 },
    { ts: at(0, 12), loop: "feature", type: "landed", commit: head("b"), result: "changed", durationMs: 5_000 },
    // Still in the pipeline (no pin, no outcome yet): the conservative fallback keeps it landed.
    { ts: at(0, 10), loop: "bugfix", type: "tick_end", tick: 1, result: "queued", durationMs: 600_000, costUsd: 0.1 },
    // A merge conflict also burns the authoring span into error-class — but is no
    // review-rejection loss cause, having no rejection to name.
    { ts: at(0, 9), loop: "organize", type: "land_queued", commit: head("c"), summary: "tidy" },
    { ts: at(0, 10), loop: "organize", type: "tick_end", tick: 1, result: "queued", durationMs: 1_200_000, costUsd: 0.3 },
    { ts: at(0, 12), loop: "organize", type: "land_failed", commit: head("c"), result: "merge_conflict", durationMs: 30_000 },
  ]);
  const data = collectFailureReport(root, 1);
  const coverage = data.timeSpend.find((r) => r.role === "coverage");
  assert.deepEqual(coverage?.classes.error, { ticks: 1, ms: 3_600_000, costUsd: 1.0 }, "the authoring span prices as error-class, not the landing's own 60s");
  assert.equal(coverage?.classes.landed.ticks, 0);
  const feature = data.timeSpend.find((r) => r.role === "feature");
  assert.deepEqual(feature?.classes.landed, { ticks: 1, ms: 1_800_000, costUsd: 0.2 }, "a landed change stays landed");
  const bugfix = data.timeSpend.find((r) => r.role === "bugfix");
  assert.deepEqual(bugfix?.classes.landed, { ticks: 1, ms: 600_000, costUsd: 0.1 }, "an unresolved landing keeps the conservative fallback");
  const organize = data.timeSpend.find((r) => r.role === "organize");
  assert.deepEqual(organize?.classes.error, { ticks: 1, ms: 1_200_000, costUsd: 0.3 }, "a merge conflict's authoring span prices as error-class too");

  const rejected = data.lossCauses.find((c) => c.kind === "review-rejected");
  assert.deepEqual(
    rejected && { roles: rejected.roles, example: rejected.example, ticks: rejected.ticks, ms: rejected.ms, costUsd: rejected.costUsd },
    { roles: ["coverage"], example: "too big", ticks: 1, ms: 3_600_000, costUsd: 1.0 },
    "the rejection ranks as its own cause, exemplified by the review_rejected reason",
  );
  assert.equal(data.lossCauses.some((c) => c.roles.includes("organize")), false, "a merge conflict is no review-rejection cause");
  const md = renderFailureMarkdown(data);
  assert.match(md, /review-rejected authoring on coverage — too big/);
  assert.match(md, /\| coverage \| — \| — \| 1\.0 h · \$1\.00 \|/);
});

test("a mixed fleet of plain and progressing tick timeouts pools into one digest cluster", () => {
  const root = tmpdir();
  writeEvents(root, [
    { ts: at(0), loop: "feature", type: "tick_end", result: "error", error: "timed out after 1800s", durationMs: 1_800_000, costUsd: 0.10 },
    { ts: at(0), loop: "bugfix", type: "tick_end", result: "error",
      error: "timed out after 1800s while still making progress — session and worktree edits preserved for resume",
      durationMs: 3_600_000, costUsd: 0.20 },
    { ts: at(0), loop: "clean", type: "tick_end", result: "error", error: "pi exited 1" },
  ]);
  const data = collectFailureReport(root, 1);
  // One cause, one knob (tickTimeoutSeconds): both shapes are the same timeout, so the digest
  // reports one cluster — not two half-size rows a top-N cut can drop.
  const timeout = data.errors.clusters.find((c) => c.key.startsWith("timed out"));
  assert.ok(timeout, `the timeout cause is itemized: ${JSON.stringify(data.errors.clusters)}`);
  assert.equal(timeout?.key, "timed out after <dur>");
  assert.equal(timeout?.count, 2);
  assert.deepEqual(timeout?.roles, ["bugfix", "feature"]);
  // The loss ranking sums both shapes' agent-hours under the pooled cause.
  const loss = data.lossCauses.find((c) => c.example.startsWith("timed out"));
  assert.ok(loss, `the loss table carries the pooled cause: ${JSON.stringify(data.lossCauses)}`);
  assert.equal(loss?.ticks, 2);
  assert.equal(loss?.ms, 5_400_000);
  assert.ok(Math.abs((loss?.costUsd ?? 0) - 0.3) < 1e-9, `summed cost: ${loss?.costUsd}`);
});

test("a cluster that outlived a config change labels itself with its newest message, not its oldest", () => {
  // BUGS.md 2026-09-30: 23 900s review timeouts from 09-28/29 rendered as "timed out after
  // 1800s" because both clusterMessages and the loss fold took the example from the first
  // message seen — the retired value from before the timeout was lowered.
  const root = tmpdir();
  writeEvents(root, [
    { ts: at(0), loop: "review", type: "tick_end", result: "error", error: "timed out after 1800s", durationMs: 1_800_000, costUsd: 0.10 },
    { ts: at(0, 13), loop: "review", type: "tick_end", result: "error",
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

test("a review_error landing prices its authoring hours under the matching review_failed cause", () => {
  // BUGS.md 2026-10-07: a queued tick whose landing ended `review_error` — the reviewer's own
  // process failed (a timeout, a dead backend, no parseable verdict) and the pin was re-queued —
  // was priced into the error-class cell but owned by no loss cause, because the rejected-only
  // branch and CLUSTERED_RESULTS both missed it. The matching `review_failed` event carries the
  // message the digest already clusters, so the authoring span now pools under that key.
  const root = tmpdir();
  const head = (c: string) => c.repeat(40);
  writeEvents(root, [
    { ts: at(0, 9), loop: "bugfix", type: "land_queued", commit: head("d"), summary: "fix a thing" },
    { ts: at(0, 10), loop: "bugfix", type: "tick_end", tick: 1, result: "queued", durationMs: 3_600_000, costUsd: 0.5 },
    { ts: at(0, 11), loop: "bugfix", type: "review_failed", head: head("d"),
      message: "timed out after 900s while still making progress — the commit is kept; the next attempt reviews it from scratch" },
    { ts: at(0, 12), loop: "bugfix", type: "land_failed", commit: head("d"), result: "review_error", durationMs: 60_000 },
  ]);
  const data = collectFailureReport(root, 1);
  assert.deepEqual(
    data.timeSpend.find((r) => r.role === "bugfix")?.classes.error,
    { ticks: 1, ms: 3_600_000, costUsd: 0.5 },
    "the authoring span prices as error-class, not the landing's own 60s",
  );
  const loss = data.lossCauses.find((c) => c.roles.includes("bugfix"));
  assert.ok(loss, `the review_error tick owns a loss cause: ${JSON.stringify(data.lossCauses)}`);
  assert.equal(loss?.kind, "error-cluster");
  assert.equal(loss?.ticks, 1);
  assert.equal(loss?.ms, 3_600_000);
  assert.equal(loss?.costUsd, 0.5);
  assert.match(loss?.example ?? "", /^timed out after 900s/, "exemplified by the matching review_failed message");
  const md = renderFailureMarkdown(data);
  assert.match(md, /timed out after 900s .*\(bugfix\)/, `the loss row names the review failure: ${md}`);
});
