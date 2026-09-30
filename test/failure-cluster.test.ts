import test from "node:test";
import assert from "node:assert/strict";
import {
  EXAMPLE_MAX,
  TICK_TIMEOUT_KEY,
  clusterMessages,
  normalizeClusterKey,
  poolTimeoutKey,
} from "../src/failure-cluster.js";

// failure-cluster.ts is the shared grouping engine behind the failure digest and the
// error-storm reducer; both count by its normalized keys, so a wrong rule here silently
// merges two real failure modes or splits one into half-size rows. These tests pin the
// documented contract of each rule directly instead of only through one indirect case
// per consumer.

test("normalizeClusterKey replaces hashes, paths, timestamps, durations, and bare numbers", () => {
  assert.equal(
    normalizeClusterKey(
      "checkout abc123def9 failed for /home/zach/repo/src/main.ts at 2026-09-29T10:00:00Z after 500ms with code 3",
    ),
    "checkout <sha> failed for <path> at <ts> after <dur> with code <n>",
  );
});

test("normalizeClusterKey keeps the exit status after 'exited' intact", () => {
  // The lookbehind keeps `pi exited 1` and `pi exited null` distinct — the status is
  // semantic, not a volatile count.
  assert.equal(normalizeClusterKey("pi exited 1"), "pi exited 1");
  assert.equal(normalizeClusterKey("pi exited null"), "pi exited null");
  assert.equal(normalizeClusterKey("retry 4 of 5 failed"), "retry <n> of <n> failed");
});

test("normalizeClusterKey trims whitespace and clips the key to EXAMPLE_MAX", () => {
  assert.equal(normalizeClusterKey("   padded   "), "padded");
  const long = "x".repeat(EXAMPLE_MAX + 40);
  assert.equal(normalizeClusterKey(long).length, EXAMPLE_MAX);
});

test("poolTimeoutKey pools the progressing-timeout variant into the plain key", () => {
  // These are the exact shapes src/pi.ts emits; TICK_TIMEOUT_KEY is the plain one's
  // normalized form verbatim.
  const plain = normalizeClusterKey("timed out after 900s");
  const progressing = normalizeClusterKey(
    "timed out after 900s while still making progress — session and worktree edits preserved for resume",
  );
  assert.notEqual(plain, progressing);
  assert.equal(plain, TICK_TIMEOUT_KEY);
  assert.equal(poolTimeoutKey(progressing), TICK_TIMEOUT_KEY);
  assert.equal(poolTimeoutKey(plain), TICK_TIMEOUT_KEY);
  assert.equal(poolTimeoutKey("some other cause"), "some other cause");
});

test("clusterMessages aggregates by normalized key with sorted roles and seen bounds", () => {
  const { clusters, hiddenClusters } = clusterMessages(
    [
      { message: "boom 2", role: "feature", ts: 200 },
      { message: "boom 1", role: "cleanup", ts: 100 },
      { message: "boom 3", role: "cleanup", ts: 300 },
    ],
    10,
  );
  assert.equal(hiddenClusters, 0);
  assert.deepEqual(clusters, [
    {
      key: "boom <n>",
      count: 3,
      roles: ["cleanup", "feature"],
      firstSeen: 100,
      lastSeen: 300,
      example: "boom 3", // the newest verbatim occurrence (at lastSeen), not the normalized form
    },
  ]);
});

test("clusterMessages labels the cluster with the NEWEST verbatim message, not the first seen", () => {
  // The reported shape (BUGS.md 2026-09-30): a cluster outlives a config change, so its
  // oldest message carries a retired value (1800s) while the knob now applies 900s. Events
  // arrive oldest-first, so the first-seen example was the retired one.
  const { clusters } = clusterMessages(
    [
      { message: "timed out after 1800s", role: "review", ts: 1 },
      { message: "timed out after 900s while still making progress — session and worktree edits preserved for resume", role: "review", ts: 2 },
      { message: "timed out after 900s", role: "bugfix", ts: 3 },
    ],
    10,
  );
  assert.equal(clusters.length, 1);
  const pooled = clusters[0]!;
  assert.equal(pooled.key, TICK_TIMEOUT_KEY);
  assert.equal(pooled.lastSeen, 3);
  assert.equal(pooled.example, "timed out after 900s", "the example is the message at lastSeen");
});

test("clusterMessages pools both tick-timeout shapes into one cluster", () => {
  const { clusters, hiddenClusters } = clusterMessages(
    [
      { message: "timed out after 900s", role: "feature", ts: 1 },
      {
        message:
          "timed out after 900s while still making progress — session and worktree edits preserved for resume",
        role: "review",
        ts: 2,
      },
    ],
    10,
  );
  assert.equal(hiddenClusters, 0);
  assert.equal(clusters.length, 1);
  const pooled = clusters[0]!;
  assert.equal(pooled.key, TICK_TIMEOUT_KEY);
  assert.equal(pooled.count, 2);
  assert.deepEqual(pooled.roles, ["feature", "review"]);
  // The pooled cluster's example is the newest message's verbatim text, whichever shape it
  // took (BUGS.md 2026-09-30).
  assert.match(pooled.example, /^timed out after 900s/);
});

test("clusterMessages keys a keyPrefix separately from the bare message", () => {
  const { clusters } = clusterMessages(
    [
      { message: "same text", role: "a", ts: 1 },
      { message: "same text", role: "b", ts: 2, keyPrefix: "reject:" },
    ],
    10,
  );
  assert.equal(clusters.length, 2);
  assert.deepEqual(
    clusters.map((c) => c.key).sort(),
    ["reject:same text", "same text"],
  );
});

test("clusterMessages returns the top-N by count with ties broken by key, and the hidden rest", () => {
  const many = (n: number, role: string) =>
    Array.from({ length: n }, (_, i) => ({ message: `failure ${role}`, role, ts: i }));
  const { clusters, hiddenClusters } = clusterMessages(
    [...many(3, "big"), { message: "zzz unique", role: "a", ts: 0 }, { message: "aaa unique", role: "b", ts: 1 }],
    2,
  );
  assert.equal(hiddenClusters, 1); // three distinct keys, top cut at 2
  assert.deepEqual(
    clusters.map((c) => c.key),
    ["failure big", "aaa unique"], // "big" ×3 first, then the tied singles by key
  );
});
