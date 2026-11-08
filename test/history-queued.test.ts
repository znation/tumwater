/** Direct unit tests for the queued-row merge join (src/history/history-queued.ts). The
 * history-data integration covers the rebased-retry saga (each retry re-enqueues a DIFFERENT
 * sha) through runRows; these cases reach the branches that saga never exercises — an
 * UN-rebased retry (a retriable failure keeps the pin and the verification re-enqueues the
 * identical sha, so findLast must pick the newest same-sha outcome), a torn merge_failed whose
 * result is not text (attemptVerdict reads null), and the claim guard that keeps a row raw
 * when its end precedes every pin. Rows resolve newest-first (history-data's scan order),
 * sharing the claim cursor exactly as runRows does. */
import test from "node:test";
import assert from "node:assert/strict";
import type { HarnessEvent } from "../src/events/events.js";
import { bucketMergeEvents, resolveQueuedResult } from "../src/history/history-queued.js";

/** Resolve run_end rows newest-first over one shared claim cursor, exactly as runRows does. */
function resolveNewestFirst(
  ends: HarnessEvent[],
  events: HarnessEvent[],
): (ReturnType<typeof resolveQueuedResult>)[] {
  const { mergeQueuedByRunner, outcomeByRunner } = bucketMergeEvents(events);
  const claimTop = new Map<string, number>();
  const joinStarts = new Map<string, number>();
  // history-data scans rows newest-first (runRows loops i from length-1 down), so a newer
  // row claims the newest unclaimed pin before an older row claims the next one down.
  const newestFirst = [...ends].sort((a, b) => b.ts - a.ts);
  return newestFirst.map((end) =>
    resolveQueuedResult(end, mergeQueuedByRunner, outcomeByRunner, claimTop, joinStarts, null),
  );
}

test("an un-rebased retry re-enqueues the identical sha, and each row reads the attempt it owns (findLast picks the newest same-sha outcome)", () => {
  // A retriable merge failure (merge_blocked) keeps the pin. When main did NOT move, the
  // recovery re-enqueues the SAME sha (pinR sha1) while both attempts' outcomes log that sha.
  // The authoring row must resolve to the FINAL "changed" (the newest same-sha outcome), not
  // latch the first merge_blocked; the recovery row reads the block it re-queued, bounded to
  // the outcome between pinA and pinR so the later merge does not leak onto it.
  const pinA: HarnessEvent = { ts: 10, source: "feature", type: "merge_queued", commit: "sha1", summary: "work one" };
  const endA: HarnessEvent = { ts: 20, source: "feature", type: "run_end", run: 1, result: "queued", summary: "work one" };
  const blocked: HarnessEvent = { ts: 30, source: "feature", type: "merge_failed", commit: "sha1", result: "merge_blocked" };
  const pinR: HarnessEvent = { ts: 40, source: "feature", type: "merge_queued", commit: "sha1", summary: "recovered leftover work from feature: work one" };
  const endR: HarnessEvent = { ts: 50, source: "feature", type: "run_end", run: 2, result: "queued", summary: "recovered leftover work from feature: work one" };
  const merged: HarnessEvent = { ts: 60, source: "feature", type: "merge_done", commit: "sha1", result: "changed" };

  // Newest row (endR) resolves first and returns ["merge_blocked", "changed"] in
  // newest-first order, whose pair is (endR, endA).
  const [recovery, authoring] = resolveNewestFirst([endA, endR], [pinA, endA, blocked, pinR, endR, merged]);

  assert.equal(recovery?.result, "merge_blocked");
  assert.equal(recovery?.sha, "sha1");
  // The recovery row's verdict carries the FIRST attempt's pin and outcome (the block it
  // re-queued), not the merge that ended the change.
  assert.equal(recovery?.pin.ts, 10);
  assert.equal(recovery?.outcome.ts, 30);
  // The authoring row resolves to the FINAL merge ("changed"), not the first attempt's
  // merge_blocked: with identical shas, findLast picks the newest same-sha outcome and the
  // walk never latches the kept pin's retriable failure.
  assert.equal(authoring?.result, "changed");
  assert.equal(authoring?.sha, "sha1");
});

test("a merge_failed whose result is not text (each of a retriable chain logged the same sha) reads null, so the row keeps its raw queued label", () => {
  // attemptVerdict reads a non-text (torn) outcome result as null: a merge_done's torn result
  // falls back to "changed", but a merge_failed's falls back to "" and the attempt is dropped.
  const pin: HarnessEvent = { ts: 10, source: "feature", type: "merge_queued", commit: "sha1", summary: "work one" };
  const end: HarnessEvent = { ts: 20, source: "feature", type: "run_end", run: 1, result: "queued", summary: "work one" };
  const tornFail: HarnessEvent = { ts: 30, source: "feature", type: "merge_failed", commit: "sha1", result: { torn: true } as never };

  const [row] = resolveNewestFirst([end], [pin, end, tornFail]);
  assert.equal(row, null);
});

test("a queued row whose end precedes every merge_queued pin is never resolved (claimQueuedPin returns -1)", () => {
  // claimQueuedPin walks newest-first for a pin at or before the row's end; when the row
  // ends before every pin (belongs to a later change, or the pin is logged after the run),
  // it finds none and resolveQueuedResult keeps the raw queued label.
  const end: HarnessEvent = { ts: 40, source: "feature", type: "run_end", run: 1, result: "queued", summary: "work one" };
  const pin: HarnessEvent = { ts: 50, source: "feature", type: "merge_queued", commit: "sha1", summary: "work one" };
  const merged: HarnessEvent = { ts: 60, source: "feature", type: "merge_done", commit: "sha1", result: "changed" };

  const [row] = resolveNewestFirst([end], [end, pin, merged]);
  assert.equal(row, null);
});
