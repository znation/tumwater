/** Unit-tier coverage for the tick-detail collector (src/tick/tick-detail-data.ts): the payload
 * behind `tumwater tick <role> <n>` and the GUI's History drill-down. Until now its block
 * rules ran in no test — the nearest relatives (history-data.test.ts pins the row view,
 * event-read.test.ts the pairing helpers) never exercise readTickDetail itself, so a slip in
 * the block bounds (leaking the next tick's events into this one, fabricating a duration for
 * an unpaired tick, answering an old counter-reset block as current) would reach users
 * untested. These tests seed events.jsonl through writeEvents and pin the collector's
 * decisions: which events make the block, how an in-flight or rotation-cut tick reads, and
 * which block a repeated tick number answers with. */

import test from "node:test";
import assert from "node:assert/strict";
import type { HarnessEvent } from "../src/events/events.js";
import { readTickDetail } from "../src/tick/tick-detail-data.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { writeEvents } from "./fixtures/log-fixtures.js";

function startEvent(over: Partial<HarnessEvent>): HarnessEvent {
  return { ts: 0, loop: "feature", type: "run_start", run: 1, ...over } as HarnessEvent;
}

function endEvent(over: Partial<HarnessEvent>): HarnessEvent {
  return { ts: 0, loop: "feature", type: "run_end", run: 1, result: "changed", ...over } as HarnessEvent;
}

/** A tick-less in-tick event — the review gate's and build check's output, filed under the
 * role but carrying no tick of its own. */
function inTickEvent(over: Partial<HarnessEvent>): HarnessEvent {
  return { ts: 0, loop: "feature", type: "review_verdict", verdict: "approve", ...over } as HarnessEvent;
}

test("a missing or empty log reads as no such tick", () => {
  assert.equal(readTickDetail(tmpdir(), "feature", 1), null);
  const empty = tmpdir();
  writeEvents(empty, []);
  assert.equal(readTickDetail(empty, "feature", 1), null);
});

test("a paired tick's block is its start, its in-tick events, and its end — nothing else's", () => {
  const root = tmpdir();
  writeEvents(root, [
    startEvent({ ts: 1000, run: 1 }),
    inTickEvent({ ts: 1400, run: 1 }),
    // An event stamped exactly at the end's ts is inside the block: the bound is exclusive
    // only past it, so a same-ms build_check is not dropped.
    inTickEvent({ ts: 2000, run: 1 }),
    endEvent({ ts: 2000, run: 1, result: "changed", tokens: 1234, costUsd: 0.5 }),
    // The next tick, and another role's tick entirely — both outside tick 1's block.
    startEvent({ ts: 3000, run: 2, loop: "helper" }),
    endEvent({ ts: 4000, run: 2, loop: "helper" }),
  ]);
  const detail = readTickDetail(root, "feature", 1);
  assert.ok(detail);
  assert.deepEqual(
    { startTs: detail.startTs, endTs: detail.endTs, durationMs: detail.durationMs, result: detail.result },
    { startTs: 1000, endTs: 2000, durationMs: 1000, result: "changed" },
  );
  assert.equal(detail.tokens, 1234);
  assert.equal(detail.costUsd, 0.5);
  assert.equal(detail.usage, "1234 tok · $0.50");
  assert.deepEqual(
    detail.events.map((e) => [e.type, e.ts, e.source]),
    [
      ["run_start", 1000, "feature"],
      ["review_verdict", 1400, "feature"],
      ["review_verdict", 2000, "feature"],
      ["run_end", 2000, "feature"],
    ],
  );
});

test("a torn run_end outcome reads as ?, never undefined", () => {
  // The collector used String(end.result) raw: a hand-edited run_end with a missing or
  // non-string result shipped the literal "undefined" as TickDetail.result, which the CLI
  // header and /api/tick drill-down printed. It now rides the shared outcomeText.
  for (const result of [undefined, 7] as const) {
    const root = tmpdir();
    writeEvents(root, [startEvent({ ts: 1000 }), endEvent({ ts: 2000, result } as never)]);
    const detail = readTickDetail(root, "feature", 1);
    assert.ok(detail);
    assert.equal(detail.result, "?");
  }
});

test("an in-flight tick reads open: no end, no fabricated duration, zero usage", () => {
  const root = tmpdir();
  writeEvents(root, [
    startEvent({ ts: 5000, run: 3 }),
    inTickEvent({ ts: 5500, run: 3 }),
    // Nothing after: no run_end and no next run_start, so everything since the start is
    // the open tick's block.
  ]);
  const detail = readTickDetail(root, "feature", 3);
  assert.ok(detail);
  assert.deepEqual(
    { startTs: detail.startTs, endTs: detail.endTs, durationMs: detail.durationMs, result: detail.result },
    { startTs: 5000, endTs: null, durationMs: null, result: null },
  );
  assert.deepEqual({ tokens: detail.tokens, costUsd: detail.costUsd, usage: detail.usage }, { tokens: 0, costUsd: 0, usage: "" });
  assert.deepEqual(detail.events.map((e) => e.ts), [5000, 5500]);
});

test("a next tick's start closes an end-less block exclusive: the following tick's events stay out", () => {
  const root = tmpdir();
  writeEvents(root, [
    // Tick 4's end was lost to rotation; tick 5's start is the surviving boundary.
    startEvent({ ts: 6000, run: 4 }),
    inTickEvent({ ts: 6500, run: 4 }),
    startEvent({ ts: 7000, run: 5 }),
    endEvent({ ts: 8000, run: 5 }),
  ]);
  const detail = readTickDetail(root, "feature", 4);
  assert.ok(detail);
  assert.deepEqual(
    { startTs: detail.startTs, endTs: detail.endTs, durationMs: detail.durationMs, result: detail.result },
    { startTs: 6000, endTs: null, durationMs: null, result: null },
  );
  assert.deepEqual(detail.events.map((e) => e.ts), [6000, 6500]);
});

test("a counter reset's repeated tick number answers with the newest block", () => {
  const root = tmpdir();
  writeEvents(root, [
    startEvent({ ts: 1000, run: 1 }),
    endEvent({ ts: 2000, run: 1, result: "changed" }),
    // The state reset to zero and tick 1 ran again: the operator asking for tick 1 means
    // the recent one, not the ancient block with the same number.
    startEvent({ ts: 9000, run: 1 }),
    endEvent({ ts: 9500, run: 1, result: "no_change" }),
  ]);
  const detail = readTickDetail(root, "feature", 1);
  assert.ok(detail);
  assert.equal(detail.startTs, 9000);
  assert.equal(detail.result, "no_change");
  assert.deepEqual(detail.events.map((e) => e.ts), [9000, 9500]);
});

test("a rotation-cut start answers unpaired from a surviving end: no start, no duration", () => {
  const root = tmpdir();
  writeEvents(root, [
    // Everything before the end event rotated away — only the run_end survives.
    endEvent({ ts: 11000, run: 6, result: "changed", tokens: 0, costUsd: 0 }),
  ]);
  const detail = readTickDetail(root, "feature", 6);
  assert.ok(detail);
  assert.deepEqual(
    { startTs: detail.startTs, endTs: detail.endTs, durationMs: detail.durationMs, result: detail.result },
    { startTs: null, endTs: 11000, durationMs: null, result: "changed" },
  );
  // Zero usage renders empty (the omit-when-zero convention), not a fabricated figure.
  assert.equal(detail.usage, "");
  assert.deepEqual(detail.events.map((e) => e.type), ["run_end"]);
});

test("a tick the scan never saw reads as not found, start or end", () => {
  const root = tmpdir();
  writeEvents(root, [startEvent({ ts: 1000, run: 1 }), endEvent({ ts: 2000, run: 1 })]);
  assert.equal(readTickDetail(root, "feature", 9), null);
  // Another role's tick 1 does not answer for feature's.
  assert.equal(readTickDetail(root, "helper", 1), null);
});

test("a queued tick resolves to its merge's verdict and outcome event; a pending merge stays queued", () => {
  const root = tmpdir();
  const ev = (o: Partial<HarnessEvent>): HarnessEvent => ({ loop: "feature", ...o }) as HarnessEvent;
  writeEvents(root, [
    startEvent({ ts: 1000, run: 1 }),
    ev({ ts: 1100, type: "merge_queued", commit: "sha1" }),
    endEvent({ ts: 1200, run: 1, result: "queued" }),
    ev({ ts: 1300, type: "merge_done", commit: "sha1", result: "changed" }),
    startEvent({ ts: 2000, run: 2 }),
    ev({ ts: 2100, type: "merge_queued", commit: "sha2" }),
    endEvent({ ts: 2200, run: 2, result: "queued" }),
    ev({ ts: 2300, type: "merge_failed", commit: "sha2", result: "rejected" }),
    startEvent({ ts: 3000, run: 3 }),
    ev({ ts: 3100, type: "merge_queued", commit: "sha3" }),
    endEvent({ ts: 3200, run: 3, result: "queued" }),
    startEvent({ ts: 4000, run: 4 }),
    endEvent({ ts: 4100, run: 4, result: "changed" }),
  ]);
  const one = readTickDetail(root, "feature", 1)!;
  assert.equal(one.result, "changed");
  assert.equal(one.merge?.type, "merge_done");
  assert.ok(!one.events.some((e) => e.type === "merge_done"));
  const two = readTickDetail(root, "feature", 2)!;
  assert.equal(two.result, "rejected");
  assert.equal(two.merge?.type, "merge_failed");
  assert.ok(!two.events.some((e) => e.type === "merge_failed"));
  const three = readTickDetail(root, "feature", 3)!;
  assert.equal(three.result, "queued");
  assert.equal(three.merge, null);
  const four = readTickDetail(root, "feature", 4)!;
  assert.equal(four.result, "changed");
  assert.equal(four.merge, null);
});

test("mergedSha pairs a run with its role's merged event inside the merge window; every other case is null", () => {
  const root = tmpdir();
  const ev = (o: Partial<HarnessEvent>): HarnessEvent => ({ loop: "feature", ...o }) as HarnessEvent;
  const merged = (ts: number, commit: string, loop = "feature"): HarnessEvent => ev({ ts, loop, type: "merged", commit });
  writeEvents(root, [
    merged(100, "old"),
    startEvent({ ts: 1000, run: 1 }),
    ev({ ts: 1100, type: "merge_queued", commit: "sha1" }),
    endEvent({ ts: 1200, run: 1, result: "queued" }),
    merged(1250, "other", "bugfix"),
    merged(1280, "landed1"),
    ev({ ts: 1300, type: "merge_done", commit: "sha1", result: "changed", durationMs: 100 }),
    startEvent({ ts: 2000, run: 2 }),
    ev({ ts: 2100, type: "merge_queued", commit: "sha2" }),
    endEvent({ ts: 2200, run: 2, result: "queued" }),
    ev({ ts: 2300, type: "merge_failed", commit: "sha2", result: "rejected", durationMs: 100 }),
    startEvent({ ts: 3000, run: 3 }),
    ev({ ts: 3100, type: "merge_queued", commit: "sha3" }),
    endEvent({ ts: 3200, run: 3, result: "queued" }),
    startEvent({ ts: 4000, run: 4 }),
    merged(4050, "direct"),
    endEvent({ ts: 4100, run: 4, result: "changed" }),
    startEvent({ ts: 5000, run: 5 }),
    ev({ ts: 5100, type: "merge_queued", commit: "sha5" }),
    endEvent({ ts: 5200, run: 5, result: "queued" }),
    ev({ ts: 3_605_000, type: "merge_done", commit: "sha5", result: "changed", durationMs: 1000 }),
  ]);
  assert.equal(readTickDetail(root, "feature", 1)!.mergedSha, "landed1");
  assert.equal(readTickDetail(root, "feature", 2)!.mergedSha, null);
  assert.equal(readTickDetail(root, "feature", 3)!.mergedSha, null);
  assert.equal(readTickDetail(root, "feature", 4)!.mergedSha, "direct");
  assert.equal(readTickDetail(root, "feature", 5)!.mergedSha, null);
});
