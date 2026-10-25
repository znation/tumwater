// liveMergeMarker's cross-check against the queue, called directly with in-memory markers: the
// per-change record filtering the CLI and snapshot tests only reach through a single-change marker.

import test from "node:test";
import assert from "node:assert/strict";
import { ciParityForPoll, configForStatus, liveMergeMarker, mainCheckForPoll } from "../src/status/status-polls.js";
import { recordParity } from "../src/run/ci-parity.js";
import { commitIn, makeRepo, mainSha } from "./fixtures/repo-fixtures.js";
import { writeEvents } from "./fixtures/log-fixtures.js";
import type { MergeChange, MergeInFlight } from "../src/merge/merge-slot.js";

const sha = (c: string): string => c.repeat(40);

function record(role: string, c: string, status: MergeChange["status"]): MergeChange {
  return { role, sha: sha(c), summary: `${role} change`, status };
}

function marker(changes?: unknown[]): MergeInFlight {
  return {
    role: "feature",
    sha: sha("a"),
    summary: "top",
    startedAt: 1_000,
    ...(changes ? { changes: changes as MergeChange[] } : {}),
  };
}

test("liveMergeMarker shows a single-change marker only while its sha is queued", () => {
  const single = marker();
  assert.equal(liveMergeMarker(single, new Set([sha("a")])), single);
  assert.equal(liveMergeMarker(single, new Set([sha("b")])), undefined);
});

test("liveMergeMarker keeps only the queued records and hides a marker whose queued records are all done", () => {
  const merging = record("feature", "a", "merging");
  const done = record("fixer", "b", "done");
  const approved = record("review", "c", "approved");
  const m = marker([merging, done, approved]);
  const live = liveMergeMarker(m, new Set([sha("a"), sha("b")]));
  assert.deepEqual(live?.changes, [merging, done]);
  assert.equal(liveMergeMarker(m, new Set([sha("b")])), undefined);
});

test("liveMergeMarker drops a null or malformed record instead of throwing", () => {
  const valid = record("feature", "a", "merging");
  const m = marker([null, 7, { role: "x" }, valid]);
  const live = liveMergeMarker(m, new Set([sha("a")]));
  assert.deepEqual(live?.changes, [valid]);
});

test("ciParityForPoll reads current, stale, failed and none", () => {
  const root = makeRepo();
  const cfg = configForStatus(root);
  // No ledger yet: no badge at all.
  assert.equal(ciParityForPoll(root, cfg), undefined, "a repo with no parity record reads as none");

  // A passing record at main's current head is current.
  const tip = mainSha(root);
  recordParity(root, tip, "passed", 1_000);
  assert.deepEqual(ciParityForPoll(root, cfg), { state: "current", covered: tip, lastRunAt: 1_000 });

  // Once main moves, the same record is stale.
  commitIn(root, "move main");
  const stale = ciParityForPoll(root, cfg);
  assert.equal(stale?.state, "stale");
  assert.equal(stale?.covered, tip, "the covered tip is the recorded one, before the move");

  // A failed last run is failed regardless of the tip.
  recordParity(root, mainSha(root), "failed", 2_000);
  assert.deepEqual(ciParityForPoll(root, cfg), { state: "failed", covered: mainSha(root), lastRunAt: 2_000 });
});

test("mainCheckForPoll carries red detail from the main_culprit verdict matching the checked tip", () => {
  const root = makeRepo();
  const tip = mainSha(root);
  // A real-shaped build_check (no failingTests) plus a main_culprit verdict naming the tip it
  // checked — the writer's two real shapes — drive the red detail.
  writeEvents(root, [
    { source: "merge", type: "build_check", scope: "merge", status: "failed", script: "npm test", durationMs: 1, ts: 1_000 },
    { source: "tumwater", type: "main_culprit", commit: tip, runner: "feature", failingTests: ["a", "b"], ts: 2_000 },
  ]);
  const result = mainCheckForPoll(root, configForStatus(root));
  assert.equal(result?.status, "failed");
  assert.deepEqual(result?.red, { failingTests: ["a", "b"], culprit: { commit: tip, runner: "feature" } });
});

test("a main_culprit for a different head carries no red detail", () => {
  const root = makeRepo();
  writeEvents(root, [
    { source: "merge", type: "build_check", scope: "merge", status: "failed", script: "npm test", durationMs: 1, ts: 1_000 },
    // A newer merge-scope failure with a blame the watch wrote for a different head: no red.
    { source: "tumwater", type: "main_culprit", commit: sha("c"), runner: "feature", failingTests: ["a"], ts: 2_000 },
  ]);
  const result = mainCheckForPoll(root, configForStatus(root));
  assert.equal(result?.status, "failed");
  assert.equal(result?.red, undefined);
});

test("a passing check carries no red detail", () => {
  const root = makeRepo();
  writeEvents(root, [
    { source: "merge", type: "build_check", scope: "merge", status: "passed", script: "npm test", durationMs: 1, ts: 1_000 },
    { source: "tumwater", type: "main_culprit", commit: mainSha(root), runner: "feature", failingTests: ["a"], ts: 2_000 },
  ]);
  const result = mainCheckForPoll(root, configForStatus(root));
  assert.equal(result?.status, "passed");
  assert.equal(result?.red, undefined);
});
