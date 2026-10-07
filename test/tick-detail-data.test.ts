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
import { tmpdir } from "./repo-fixtures.js";
import { writeEvents } from "./log-fixtures.js";

function startEvent(over: Partial<HarnessEvent>): HarnessEvent {
  return { ts: 0, loop: "feature", type: "tick_start", tick: 1, ...over } as HarnessEvent;
}

function endEvent(over: Partial<HarnessEvent>): HarnessEvent {
  return { ts: 0, loop: "feature", type: "tick_end", tick: 1, result: "changed", ...over } as HarnessEvent;
}

/** A tick-less in-tick event — the review gate's and build check's output, filed under the
 * loop but carrying no tick of its own. */
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
    startEvent({ ts: 1000, tick: 1 }),
    inTickEvent({ ts: 1400, tick: 1 }),
    // An event stamped exactly at the end's ts is inside the block: the bound is exclusive
    // only past it, so a same-ms build_check is not dropped.
    inTickEvent({ ts: 2000, tick: 1 }),
    endEvent({ ts: 2000, tick: 1, result: "changed", tokens: 1234, costUsd: 0.5 }),
    // The next tick, and another loop's tick entirely — both outside tick 1's block.
    startEvent({ ts: 3000, tick: 2, loop: "helper" }),
    endEvent({ ts: 4000, tick: 2, loop: "helper" }),
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
    detail.events.map((e) => [e.type, e.ts, e.loop]),
    [
      ["tick_start", 1000, "feature"],
      ["review_verdict", 1400, "feature"],
      ["review_verdict", 2000, "feature"],
      ["tick_end", 2000, "feature"],
    ],
  );
});

test("a torn tick_end outcome reads as ?, never undefined", () => {
  // The collector used String(end.result) raw: a hand-edited tick_end with a missing or
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
    startEvent({ ts: 5000, tick: 3 }),
    inTickEvent({ ts: 5500, tick: 3 }),
    // Nothing after: no tick_end and no next tick_start, so everything since the start is
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
    startEvent({ ts: 6000, tick: 4 }),
    inTickEvent({ ts: 6500, tick: 4 }),
    startEvent({ ts: 7000, tick: 5 }),
    endEvent({ ts: 8000, tick: 5 }),
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
    startEvent({ ts: 1000, tick: 1 }),
    endEvent({ ts: 2000, tick: 1, result: "changed" }),
    // The state reset to zero and tick 1 ran again: the operator asking for tick 1 means
    // the recent one, not the ancient block with the same number.
    startEvent({ ts: 9000, tick: 1 }),
    endEvent({ ts: 9500, tick: 1, result: "no_change" }),
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
    // Everything before the end event rotated away — only the tick_end survives.
    endEvent({ ts: 11000, tick: 6, result: "changed", tokens: 0, costUsd: 0 }),
  ]);
  const detail = readTickDetail(root, "feature", 6);
  assert.ok(detail);
  assert.deepEqual(
    { startTs: detail.startTs, endTs: detail.endTs, durationMs: detail.durationMs, result: detail.result },
    { startTs: null, endTs: 11000, durationMs: null, result: "changed" },
  );
  // Zero usage renders empty (the omit-when-zero convention), not a fabricated figure.
  assert.equal(detail.usage, "");
  assert.deepEqual(detail.events.map((e) => e.type), ["tick_end"]);
});

test("a tick the scan never saw reads as not found, start or end", () => {
  const root = tmpdir();
  writeEvents(root, [startEvent({ ts: 1000, tick: 1 }), endEvent({ ts: 2000, tick: 1 })]);
  assert.equal(readTickDetail(root, "feature", 9), null);
  // Another loop's tick 1 does not answer for feature's.
  assert.equal(readTickDetail(root, "helper", 1), null);
});
