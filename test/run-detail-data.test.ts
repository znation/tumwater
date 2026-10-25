/** Unit-tier coverage for the run-detail collector (src/run/run-detail-data.ts): the payload
 * behind `tumwater history <role> <n>` and the GUI's History drill-down. Until now its block
 * rules ran in no test — the nearest relatives (history-data.test.ts pins the row view,
 * event-read.test.ts the pairing helpers) never exercise readRunDetail itself, so a slip in
 * the block bounds (leaking the next run's events into this one, fabricating a duration for
 * an unpaired run, answering an old counter-reset block as current) would reach users
 * untested. These tests seed events.jsonl through writeEvents and pin the collector's
 * decisions: which events make the block, how an in-flight or rotation-cut run reads, and
 * which block a repeated run number answers with. */

import test from "node:test";
import assert from "node:assert/strict";
import type { HarnessEvent } from "../src/events/events.js";
import { readRunDetail } from "../src/run/run-detail-data.js";
import { tmpdir, writeConfig } from "./fixtures/repo-fixtures.js";
import { writeEvents } from "./fixtures/log-fixtures.js";
import { setEnv } from "./helpers/env.js";
import { writeModelsFile } from "./fixtures/models-fixtures.js";

function startEvent(over: Partial<HarnessEvent>): HarnessEvent {
  return { ts: 0, loop: "feature", type: "run_start", run: 1, ...over } as HarnessEvent; // retired-name-ok: legacy event field in a fixture
}

function endEvent(over: Partial<HarnessEvent>): HarnessEvent {
  return { ts: 0, loop: "feature", type: "run_end", run: 1, result: "changed", ...over } as HarnessEvent; // retired-name-ok: legacy event field in a fixture
}

/** A run-less in-run event — the review gate's and build check's output, filed under the
 * role but carrying no run of its own. */
function inRunEvent(over: Partial<HarnessEvent>): HarnessEvent {
  return { ts: 0, loop: "feature", type: "review_verdict", verdict: "approve", ...over } as HarnessEvent; // retired-name-ok: legacy event field in a fixture
}

test("a missing or empty log reads as no such run", () => {
  assert.equal(readRunDetail(tmpdir(), "feature", 1), null);
  const empty = tmpdir();
  writeEvents(empty, []);
  assert.equal(readRunDetail(empty, "feature", 1), null);
});

test("a paired run's block is its start, its in-run events, and its end — nothing else's", () => {
  const root = tmpdir();
  writeEvents(root, [
    startEvent({ ts: 1000, run: 1 }),
    inRunEvent({ ts: 1400, run: 1 }),
    // An event stamped exactly at the end's ts is inside the block: the bound is exclusive
    // only past it, so a same-ms build_check is not dropped.
    inRunEvent({ ts: 2000, run: 1 }),
    endEvent({ ts: 2000, run: 1, result: "changed", tokens: 1234, costUsd: 0.5 }),
    // The next run, and another role's run entirely — both outside run 1's block.
    startEvent({ ts: 3000, run: 2, loop: "helper" }), // retired-name-ok: legacy event field in a fixture
    endEvent({ ts: 4000, run: 2, loop: "helper" }), // retired-name-ok: legacy event field in a fixture
  ]);
  const detail = readRunDetail(root, "feature", 1);
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

test("readRunDetail carries the run's model from its run_start, and null without one", () => {
  // A run_start carrying a model names it: the same selector the run row and report key on.
  const withModel = tmpdir();
  writeEvents(withModel, [
    startEvent({ ts: 1000, run: 1, model: "claude/claude-sonnet-5-5" }),
    endEvent({ ts: 2000, run: 1, result: "changed" }),
  ]);
  assert.equal(readRunDetail(withModel, "feature", 1)!.model, "claude/claude-sonnet-5-5");
  // A start carrying none leaves model null.
  const noModel = tmpdir();
  writeEvents(noModel, [startEvent({ ts: 1000, run: 1 }), endEvent({ ts: 2000, run: 1 })]);
  assert.equal(readRunDetail(noModel, "feature", 1)!.model, null);
  // An empty model string also reads as null (the omit-when-absent rule RunRow shares).
  const emptyModel = tmpdir();
  writeEvents(emptyModel, [startEvent({ ts: 1000, run: 1, model: "" }), endEvent({ ts: 2000, run: 1 })]);
  assert.equal(readRunDetail(emptyModel, "feature", 1)!.model, null);
  // A rotation-cut start (only the end survives) carries no model.
  const unpaired = tmpdir();
  writeEvents(unpaired, [endEvent({ ts: 11000, run: 6, result: "changed" })]);
  assert.equal(readRunDetail(unpaired, "feature", 6)!.model, null);
});

test("a torn run_end outcome reads as ?, never undefined", () => {
  // The collector used String(end.result) raw: a hand-edited run_end with a missing or
  // non-string result shipped the literal "undefined" as RunDetail.result, which the CLI
  // header and /api/run drill-down printed. It now rides the shared outcomeText.
  for (const result of [undefined, 7] as const) {
    const root = tmpdir();
    writeEvents(root, [startEvent({ ts: 1000 }), endEvent({ ts: 2000, result } as never)]);
    const detail = readRunDetail(root, "feature", 1);
    assert.ok(detail);
    assert.equal(detail.result, "?");
  }
});

test("an in-flight run reads open: no end, no fabricated duration, zero usage", () => {
  const root = tmpdir();
  writeEvents(root, [
    startEvent({ ts: 5000, run: 3 }),
    inRunEvent({ ts: 5500, run: 3 }),
    // Nothing after: no run_end and no next run_start, so everything since the start is
    // the open run's block.
  ]);
  const detail = readRunDetail(root, "feature", 3);
  assert.ok(detail);
  assert.deepEqual(
    { startTs: detail.startTs, endTs: detail.endTs, durationMs: detail.durationMs, result: detail.result },
    { startTs: 5000, endTs: null, durationMs: null, result: null },
  );
  assert.deepEqual({ tokens: detail.tokens, costUsd: detail.costUsd, usage: detail.usage }, { tokens: 0, costUsd: 0, usage: "" });
  assert.deepEqual(detail.events.map((e) => e.ts), [5000, 5500]);
});

test("readRunDetail carries a run's context cut-off", () => {
  const root = tmpdir();
  writeEvents(root, [startEvent({ ts: 1000, run: 1 }), endEvent({ ts: 2000, run: 1, result: "no_change", cutOff: true })]);
  assert.equal(readRunDetail(root, "feature", 1)!.cutOff, true);
  // A run_end without the field leaves the key absent.
  const plain = tmpdir();
  writeEvents(plain, [startEvent({ ts: 1000, run: 1 }), endEvent({ ts: 2000, run: 1 })]);
  assert.equal(readRunDetail(plain, "feature", 1)!.cutOff, undefined);
  // An in-flight run with no end has no cutOff either.
  const inFlight = tmpdir();
  writeEvents(inFlight, [startEvent({ ts: 5000, run: 3 })]);
  assert.equal(readRunDetail(inFlight, "feature", 3)!.cutOff, undefined);
});

test("a next run's start closes an end-less block exclusive: the following run's events stay out", () => {
  const root = tmpdir();
  writeEvents(root, [
    // Run 4's end was lost to rotation; run 5's start is the surviving boundary.
    startEvent({ ts: 6000, run: 4 }),
    inRunEvent({ ts: 6500, run: 4 }),
    startEvent({ ts: 7000, run: 5 }),
    endEvent({ ts: 8000, run: 5 }),
  ]);
  const detail = readRunDetail(root, "feature", 4);
  assert.ok(detail);
  assert.deepEqual(
    { startTs: detail.startTs, endTs: detail.endTs, durationMs: detail.durationMs, result: detail.result },
    { startTs: 6000, endTs: null, durationMs: null, result: null },
  );
  assert.deepEqual(detail.events.map((e) => e.ts), [6000, 6500]);
});

test("a counter reset's repeated run number answers with the newest block", () => {
  const root = tmpdir();
  writeEvents(root, [
    startEvent({ ts: 1000, run: 1 }),
    endEvent({ ts: 2000, run: 1, result: "changed" }),
    // The state reset to zero and run 1 ran again: the operator asking for run 1 means
    // the recent one, not the ancient block with the same number.
    startEvent({ ts: 9000, run: 1 }),
    endEvent({ ts: 9500, run: 1, result: "no_change" }),
  ]);
  const detail = readRunDetail(root, "feature", 1);
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
  const detail = readRunDetail(root, "feature", 6);
  assert.ok(detail);
  assert.deepEqual(
    { startTs: detail.startTs, endTs: detail.endTs, durationMs: detail.durationMs, result: detail.result },
    { startTs: null, endTs: 11000, durationMs: null, result: "changed" },
  );
  // Zero usage renders empty (the omit-when-zero convention), not a fabricated figure.
  assert.equal(detail.usage, "");
  assert.deepEqual(detail.events.map((e) => e.type), ["run_end"]);
});

test("a run the scan never saw reads as not found, start or end", () => {
  const root = tmpdir();
  writeEvents(root, [startEvent({ ts: 1000, run: 1 }), endEvent({ ts: 2000, run: 1 })]);
  assert.equal(readRunDetail(root, "feature", 9), null);
  // Another role's run 1 does not answer for feature's.
  assert.equal(readRunDetail(root, "helper", 1), null);
});

test("a queued run resolves to its merge's verdict and outcome event; a pending merge stays queued", () => {
  const root = tmpdir();
  const ev = (o: Partial<HarnessEvent>): HarnessEvent => ({ loop: "feature", ...o }) as HarnessEvent; // retired-name-ok: legacy event field in a fixture
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
  const one = readRunDetail(root, "feature", 1)!;
  assert.equal(one.result, "changed");
  assert.equal(one.merge?.type, "merge_done");
  assert.ok(!one.events.some((e) => e.type === "merge_done"));
  const two = readRunDetail(root, "feature", 2)!;
  assert.equal(two.result, "rejected");
  assert.equal(two.merge?.type, "merge_failed");
  assert.ok(!two.events.some((e) => e.type === "merge_failed"));
  const three = readRunDetail(root, "feature", 3)!;
  assert.equal(three.result, "queued");
  assert.equal(three.merge, null);
  const four = readRunDetail(root, "feature", 4)!;
  assert.equal(four.result, "changed");
  assert.equal(four.merge, null);
});

test("mergedSha pairs a run with its role's merged event inside the merge window; every other case is null", () => {
  const root = tmpdir();
  const ev = (o: Partial<HarnessEvent>): HarnessEvent => ({ loop: "feature", ...o }) as HarnessEvent; // retired-name-ok: legacy event field in a fixture
  const merged = (ts: number, commit: string, source = "feature"): HarnessEvent => ev({ ts, source, loop: source, type: "merged", commit }); // retired-name-ok: legacy event field in a fixture
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
  assert.equal(readRunDetail(root, "feature", 1)!.mergedSha, "landed1");
  assert.equal(readRunDetail(root, "feature", 2)!.mergedSha, null);
  assert.equal(readRunDetail(root, "feature", 3)!.mergedSha, null);
  assert.equal(readRunDetail(root, "feature", 4)!.mergedSha, "direct");
  assert.equal(readRunDetail(root, "feature", 5)!.mergedSha, null);
});

test("an operator_revert names the operator's deliberate revert of the run's landed sha", () => {
  const root = tmpdir();
  const ev = (o: Partial<HarnessEvent>): HarnessEvent => ({ loop: "feature", ...o }) as HarnessEvent; // retired-name-ok: legacy event field in a fixture
  const merged = (ts: number, commit: string): HarnessEvent => ev({ ts, source: "feature", loop: "feature", type: "merged", commit }); // retired-name-ok: legacy event field in a fixture
  writeEvents(root, [
    startEvent({ ts: 1000, run: 1 }),
    merged(1050, "landed1"),
    endEvent({ ts: 1100, run: 1, result: "changed" }),
    ev({ ts: 1300, source: "tumwater", loop: "tumwater", type: "operator_revert", commit: "landed1", revert: "rev1", runner: "feature", subject: "tumwater(feature): add x" }), // retired-name-ok: legacy event field in a fixture
  ]);
  assert.deepEqual(readRunDetail(root, "feature", 1)!.reverted, {
    kind: "operator",
    sha: "landed1",
    revert: "rev1",
    failingTests: [],
  });
  // A wrong runner or a wrong commit each leave this run uncovered — the match is on both.
  const wrongRunner = tmpdir();
  writeEvents(wrongRunner, [
    startEvent({ ts: 1000, run: 1 }),
    merged(1050, "landed1"),
    endEvent({ ts: 1100, run: 1, result: "changed" }),
    ev({ ts: 1300, source: "tumwater", loop: "tumwater", type: "operator_revert", commit: "landed1", revert: "rev1", runner: "bugfix" }), // retired-name-ok: legacy event field in a fixture
  ]);
  assert.equal(readRunDetail(wrongRunner, "feature", 1)!.reverted, null);
  const wrongCommit = tmpdir();
  writeEvents(wrongCommit, [
    startEvent({ ts: 1000, run: 1 }),
    merged(1050, "landed1"),
    endEvent({ ts: 1100, run: 1, result: "changed" }),
    ev({ ts: 1300, source: "tumwater", loop: "tumwater", type: "operator_revert", commit: "other", revert: "rev1", runner: "feature" }), // retired-name-ok: legacy event field in a fixture
  ]);
  assert.equal(readRunDetail(wrongCommit, "feature", 1)!.reverted, null);
});

test("an instance run matches its operator_revert by base role (it commits under the base role)", () => {
  const root = tmpdir();
  const ev = (o: Partial<HarnessEvent>): HarnessEvent => ({ loop: "feature-2", ...o }) as HarnessEvent; // retired-name-ok: legacy event field in a fixture
  writeEvents(root, [
    startEvent({ ts: 1000, run: 1, loop: "feature-2" }), // retired-name-ok: legacy event field in a fixture
    ev({ ts: 1050, source: "feature-2", loop: "feature-2", type: "merged", commit: "landed1" }), // retired-name-ok: legacy event field in a fixture
    endEvent({ ts: 1100, run: 1, result: "changed", loop: "feature-2" }), // retired-name-ok: legacy event field in a fixture
    ev({ ts: 1300, source: "tumwater", loop: "tumwater", type: "operator_revert", commit: "landed1", revert: "rev1", runner: "feature", subject: "tumwater(feature): add x" }), // retired-name-ok: legacy event field in a fixture
  ]);
  assert.deepEqual(readRunDetail(root, "feature-2", 1)!.reverted, {
    kind: "operator",
    sha: "landed1",
    revert: "rev1",
    failingTests: [],
  });
});

test("readRunDetail resolves the run's peak and its role's declared window", () => {
  // A run_end carrying a peak and a pi models.json declaring the role's window: both ride
  // the payload, sized against the same seam `tumwater role <id>`'s `- Context window:`
  // line prints (seamContextWindow over configForRole of loadConfigSafe).
  const modelsDir = tmpdir("models-");
  writeModelsFile(
    modelsDir,
    JSON.stringify({ providers: { local: { models: [{ id: "tiny", contextWindow: 131072 }] } } }),
  );
  const restoreAgentDir = setEnv("PI_CODING_AGENT_DIR", modelsDir);
  try {
    const root = tmpdir();
    writeConfig(root, { provider: "local", model: "tiny" });
    writeEvents(root, [startEvent({ ts: 1000 }), endEvent({ ts: 2000, result: "changed", peakContextTokens: 110_000 })]);
    const detail = readRunDetail(root, "feature", 1)!;
    assert.equal(detail.peakContextTokens, 110_000);
    assert.equal(detail.contextWindow, 131072);
  } finally {
    restoreAgentDir();
  }

  // With no resolvable seam the window is null while the peak still rides.
  const noModelsRoot = tmpdir();
  writeEvents(noModelsRoot, [
    startEvent({ ts: 1000 }),
    endEvent({ ts: 2000, result: "changed", peakContextTokens: 110_000 }),
  ]);
  const noModels = readRunDetail(noModelsRoot, "feature", 1)!;
  assert.equal(noModels.peakContextTokens, 110_000);
  assert.equal(noModels.contextWindow, null);

  // A run whose run_end carries no peak reads 0.
  const noPeakRoot = tmpdir();
  writeEvents(noPeakRoot, [startEvent({ ts: 1000 }), endEvent({ ts: 2000, result: "changed" })]);
  const noPeak = readRunDetail(noPeakRoot, "feature", 1)!;
  assert.equal(noPeak.peakContextTokens, 0);
});
