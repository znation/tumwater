import test from "node:test";
import assert from "node:assert/strict";

import { getOrCreate, groupBy, rankCountEntries } from "../src/collections.js";

// Unit seam for collections.ts's get-or-create step, the shape factored out of the failure
// digest, the fleet hold, and the error-storm reducer. Those paths already cover it end to
// end; this pins the two facts the helper's doc comment claims: make() runs only on a miss,
// and an existing value is returned as-is.

test("getOrCreate returns the existing value and never calls make", () => {
  const map = new Map<string, { n: number }>();
  const first = getOrCreate(map, "a", () => ({ n: 1 }));
  let made = false;
  const second = getOrCreate(map, "a", () => {
    made = true;
    return { n: 2 };
  });
  assert.equal(second, first);
  assert.equal(second.n, 1);
  assert.equal(made, false);
});

test("getOrCreate makes and stores a value on a miss", () => {
  const map = new Map<string, number[]>();
  const list = getOrCreate(map, "a", () => []);
  list.push(1);
  assert.deepEqual(map.get("a"), [1]);
  assert.equal(getOrCreate(map, "a", () => [9]), list);
});

test("groupBy orders keys first-seen and values by input order", () => {
  const groups = groupBy(["b1", "a1", "b2", "a2"], (s) => s[0]!);
  assert.deepEqual([...groups.keys()], ["b", "a"]);
  assert.deepEqual(groups.get("b"), ["b1", "b2"]);
  assert.deepEqual(groups.get("a"), ["a1", "a2"]);
});

// rankCountEntries is the shared home of the "count descending, then key ascending" ranking
// rule the usage report's per-role lines and the fleet warnings' strongest-cause picks share.
// These pin the documented contract directly.

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
