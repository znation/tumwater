// liveMergeMarker's cross-check against the queue, called directly with in-memory markers: the
// per-change record filtering the CLI and snapshot tests only reach through a single-change marker.

import test from "node:test";
import assert from "node:assert/strict";
import { liveMergeMarker } from "../src/status/status-polls.js";
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
