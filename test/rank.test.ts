import test from "node:test";
import assert from "node:assert/strict";
import { rankCountEntries } from "../src/rank.js";

// rank.ts is the single home of the "count descending, then key ascending" ranking rule the
// usage report's per-role lines and the fleet warnings' strongest-cause picks share. These
// tests pin the documented contract directly.

test("rankCountEntries orders by count descending, then key ascending", () => {
  assert.deepEqual(
    rankCountEntries([
      ["b", 2],
      ["a", 3],
      ["c", 2],
    ]),
    [
      ["a", 3],
      ["b", 2],
      ["c", 2],
    ],
  );
});

test("rankCountEntries breaks equal-count ties alphabetically for determinism", () => {
  assert.deepEqual(
    rankCountEntries([
      ["rate_limit", 4],
      ["auth", 4],
      ["network", 4],
    ]),
    [
      ["auth", 4],
      ["network", 4],
      ["rate_limit", 4],
    ],
  );
});

test("rankCountEntries accepts a Map and leaves the input unmutated", () => {
  const counts = new Map([
    ["hold", 1],
    ["budget", 5],
  ]);
  const ranked = rankCountEntries(counts);
  assert.deepEqual(ranked, [
    ["budget", 5],
    ["hold", 1],
  ]);
  assert.deepEqual([...counts.entries()], [
    ["hold", 1],
    ["budget", 5],
  ]);
  assert.notEqual(ranked, counts);
});
