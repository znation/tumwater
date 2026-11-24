/** Unit pins for the merge-settle waiter (test/fixtures/orchestrator-fixtures.ts, INV-F3): the
 * live-orchestrator tier hands off on a role's merge settling, never on a ref-, state-, or
 * queue-shaped effect, so the waiter's own arms — a landed settle, a rejected settle, another
 * role's settle, and no settle at all — are pinned offline here against a hand-written events log
 * and `fakeClock`. No live orchestrator and no real time: the tier that drives the real queue is
 * test/orchestrator-3.e2e.test.ts. */
import test from "node:test";
import assert from "node:assert/strict";
import { awaitMergeSettled } from "./fixtures/orchestrator-fixtures.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { writeEvents } from "./fixtures/log-fixtures.js";
import { fakeClock } from "./fakes/time.js";

test("awaitMergeSettled returns the merge_done event a landed settle logged", async () => {
  const repo = tmpdir();
  writeEvents(repo, [
    { ts: 1, source: "founder", type: "run_end", run: 1 },
    { ts: 2, source: "founder", type: "merge_done", commit: "abc1234", result: "changed", summary: "a landed change" },
  ]);
  const settle = await awaitMergeSettled(repo, "founder", "its change", 1_000, fakeClock());
  assert.equal(settle.type, "merge_done", "a landed settle answers with merge_done");
  assert.equal(settle.result, "changed", "the event is handed back so a caller pins its result");
  assert.equal(settle.commit, "abc1234");
});

test("awaitMergeSettled returns the merge_failed event a rejected settle logged", async () => {
  const repo = tmpdir();
  writeEvents(repo, [
    { ts: 1, source: "steward", type: "merge_queued", commit: "def2345", summary: "a queued change" },
    { ts: 2, source: "steward", type: "merge_failed", commit: "def2345", result: "rejected", reason: "the gate refused" },
  ]);
  const settle = await awaitMergeSettled(repo, "steward", "its change", 1_000, fakeClock());
  assert.equal(settle.type, "merge_failed", "a rejected settle answers with merge_failed");
  assert.equal(settle.result, "rejected", "the event is handed back so a caller pins its result");
});

test("awaitMergeSettled keys on the settling role, so another role's merge never answers", async () => {
  const repo = tmpdir();
  writeEvents(repo, [{ ts: 1, source: "reviewer", type: "merge_done", commit: "aaa1111", result: "changed" }]);
  const clock = fakeClock();
  await assert.rejects(
    awaitMergeSettled(repo, "founder", "its change", 1_000, clock),
    /timed out waiting for the founder role's merge of its change to settle/,
    "a settle logged under another source is not this role's settle",
  );
  assert.ok(clock.now() > 1_000, `the injected clock spent the budget; saw ${clock.now()}`);
});

test("awaitMergeSettled times out on a log with no settle for the role", async () => {
  const repo = tmpdir();
  writeEvents(repo, [
    { ts: 1, source: "founder", type: "run_start", run: 1 },
    { ts: 2, source: "founder", type: "merge_queued", commit: "bbb2222", summary: "still in the queue" },
  ]);
  const clock = fakeClock();
  await assert.rejects(
    awaitMergeSettled(repo, "founder", "its change", 1_000, clock),
    /timed out waiting for the founder role's merge of its change to settle/,
    "a queued merge with no settle must time out, never report a false merge",
  );
  assert.ok(clock.now() > 1_000, `the injected clock spent the budget; saw ${clock.now()}`);
});

test("awaitMergeSettled answers with the role's latest settle when an earlier one is in the log", async () => {
  const repo = tmpdir();
  writeEvents(repo, [
    { ts: 1, source: "founder", type: "merge_failed", commit: "ccc3333", result: "rejected", reason: "an earlier refusal" },
    { ts: 2, source: "founder", type: "merge_done", commit: "ddd4444", result: "changed", summary: "the retry landed" },
  ]);
  const settle = await awaitMergeSettled(repo, "founder", "its retry", 1_000, fakeClock());
  assert.equal(settle.type, "merge_done", "the latest settle decides, not the first in the log");
  assert.equal(settle.commit, "ddd4444");
});
