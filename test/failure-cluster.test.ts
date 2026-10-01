import test from "node:test";
import assert from "node:assert/strict";
import {
  EXAMPLE_MAX,
  TICK_TIMEOUT_KEY,
  clusterMessages,
  normalizeClusterKey,
  poolTimeoutKey,
  sortedRoles,
  truncateExample,
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

test("truncateExample passes a message within the budget through untouched", () => {
  assert.equal(truncateExample("short failure"), "short failure");
  assert.equal(truncateExample("   padded   "), "padded");
  assert.equal(truncateExample("x".repeat(EXAMPLE_MAX)), "x".repeat(EXAMPLE_MAX));
});

test("truncateExample marks a cut at a word boundary with the dropped char count", () => {
  // The tail of an error is often the repro (BUGS.md 2026-09-30): a marked cut must never
  // read as a complete message, and the cut lands at a whitespace boundary when one exists
  // inside the budget rather than mid-word.
  const message = `${"word ".repeat(40)}until main is green`;
  const out = truncateExample(message);
  const marker = /\u2026 \(\+(\d+) chars\)$/.exec(out);
  assert.ok(marker, `marker appended: ${out}`);
  assert.ok(!out.includes("until main"), "the dropped tail is gone");
  // The marker names exactly what the cut dropped: body length + dropped = the message.
  const kept = out.slice(0, marker.index).trimEnd();
  assert.ok(kept.endsWith("word"), `the cut lands after a whole word, not mid-word: ${out}`);
  assert.equal(Number(marker[1]), message.trim().length - kept.length);
});

test("truncateExample keeps the hard cut when no whitespace exists inside the budget", () => {
  const message = "x".repeat(EXAMPLE_MAX + 37);
  const out = truncateExample(message);
  assert.ok(out.startsWith("x".repeat(EXAMPLE_MAX)));
  assert.ok(out.endsWith("… (+37 chars)"));
});

test("truncateExample honors a caller's own cap, as the landed summaries do", () => {
  const message = "alpha beta gamma delta";
  const out = truncateExample(message, 10);
  // The 10-char head is "alpha beta"; the last space inside it is after "alpha", so the cut
  // drops " beta gamma delta" (17 chars) whole.
  assert.equal(out, "alpha … (+17 chars)");
});

test("clusterMessages marks a truncated example instead of presenting a silent cut", () => {
  const tail = " — fix: restore the missing PI_CODING_AGENT_DIR";
  const message = `${"rejection cycle ".repeat(10)}${tail}`;
  const { clusters } = clusterMessages([{ message, role: "bugfix", ts: 1 }], 5);
  assert.equal(clusters.length, 1);
  const cluster = clusters[0]!;
  assert.ok(/\u2026 \(\+\d+ chars\)$/.test(cluster.example), cluster.example);
  assert.ok(!cluster.example.includes(tail), "the tail is not silently present");
  // The grouping key stays the bare normalized prefix — marking is display-only.
  assert.ok(!cluster.key.includes("\u2026"), cluster.key);
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

test("sortedRoles orders a cause's member roles ascending regardless of Set insertion order", () => {
  // The one home for the roles payload the digest's clusters, the digest's loss causes, and
  // the error-storm warning all emit; pinning the rule here keeps those three payloads from
  // drifting back into per-site sort orders.
  assert.deepEqual(sortedRoles(new Set(["tui", "dry", "bugfix"])), ["bugfix", "dry", "tui"]);
  assert.deepEqual(sortedRoles([]), []); // an empty cause renders no roles, not an error
  const input = new Set(["dry", "bugfix"]);
  const out = sortedRoles(input);
  assert.deepEqual(out, ["bugfix", "dry"]);
  assert.deepEqual([...input], ["dry", "bugfix"]); // the accumulated Set is never mutated
  assert.notEqual(out, [...out]); // a fresh array, so re-sorting a payload cannot alias it
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

test("normalizeClusterKey collapses volatile parts and keeps exit codes distinct", () => {
  assert.equal(normalizeClusterKey("boom deadbeef0"), "boom <sha>");
  assert.equal(normalizeClusterKey("ENOENT /Users/a/b/c.ts"), "ENOENT <path>");
  assert.equal(normalizeClusterKey("stalled at 2026-09-18T01:02:03.000Z"), "stalled at <ts>");
  assert.equal(normalizeClusterKey("timed out after 1800s"), "timed out after <dur>");
  assert.equal(normalizeClusterKey("retry 5 of 10"), "retry <n> of <n>");
  // The integer rule's negative lookbehind keeps the exit status semantic.
  assert.equal(normalizeClusterKey("pi exited 1"), "pi exited 1");
  assert.equal(normalizeClusterKey("pi exited null"), "pi exited null");
  assert.notEqual(normalizeClusterKey("pi exited 1"), normalizeClusterKey("pi exited null"));
  // Trimmed to the display cap.
  assert.equal(normalizeClusterKey("x".repeat(200)).length, 120);
});

test("poolTimeoutKey pools the two tick-timeout shapes into one cause", () => {
  assert.equal(poolTimeoutKey("timed out after <dur>"), "timed out after <dur>");
  assert.equal(
    poolTimeoutKey(
      "timed out after <dur> while still making progress — session and worktree edits preserved for resume",
    ),
    "timed out after <dur>",
  );
  assert.equal(poolTimeoutKey("pi exited 1"), "pi exited 1", "every other cause stands as normalized");
});
