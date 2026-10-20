import test from "node:test";
import assert from "node:assert/strict";

import { addTo, getOrCreate, groupBy, memoSetLru, rankCountEntries, sortByValueDesc } from "../src/collections.js";

// Unit seam for collections.ts's get-or-create step, the shape factored out of the failure
// digest, the team hold, and the error-storm reducer. Those paths already cover it end to
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
// rule the usage report's per-role lines and the team warnings' strongest-cause picks share.
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

// sortByValueDesc is the sibling ordering for `[key, value, …]` pairs that want a code-unit
// tiebreak instead of rankCountEntries's localeCompare: the log-commands per-type event-count
// lines and the report's mergeDone ranking. These pin its contract directly — value descending,
// then code-unit ascending — and that it sorts the input array in place and returns it (the
// `.sort()` the call sites replaced).

test("sortByValueDesc orders by value descending, breaking ties in code-unit order", () => {
  assert.deepEqual(
    sortByValueDesc([
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

test("sortByValueDesc uses code-unit order for the tiebreak, not localeCompare", () => {
  // "é" is U+00E9; code-unit order puts "z" (0x7A) before it, where localeCompare would not.
  assert.deepEqual(
    sortByValueDesc([
      ["é", 1],
      ["z", 1],
    ]),
    [
      ["z", 1],
      ["é", 1],
    ],
  );
});

test("sortByValueDesc sorts in place and returns the input array", () => {
  const entries: Array<[string, number]> = [
    ["b", 2],
    ["a", 3],
  ];
  const out = sortByValueDesc(entries);
  assert.equal(out, entries);
  assert.deepEqual(entries, [
    ["a", 3],
    ["b", 2],
  ]);
});

test("sortByValueDesc carries extra trailing fields through untouched", () => {
  assert.deepEqual(
    sortByValueDesc([
      ["b", 2, "x"],
      ["a", 3, "y"],
    ]),
    [
      ["a", 3, "y"],
      ["b", 2, "x"],
    ],
  );
});

// addTo seeds a missing key at `amount`, so its read must be an OWN property: the custom-role
// name charset (/^[a-z0-9][a-z0-9_-]{0,31}$/) admits "constructor", which collides with an
// Object.prototype key. A bare `record[key] ?? 0` would read the inherited function, store
// `function Object() { [native code] }5`, and every later sum (roleSum, report totals) would
// concatenate strings instead of adding numbers (BUGS.md 2026-10-10, the record-counter
// sibling of the overlayDefaults prototype-key fix).
test("addTo counts a key that collides with an Object.prototype name", () => {
  const counts: Partial<Record<string, number>> = {};
  const key = "constructor";
  addTo(counts, key, 5);
  addTo(counts, key, 2);
  assert.equal(typeof counts["constructor"], "number", "the stored value stays a number");
  assert.equal(counts["constructor"], 7);
});

// memoSetLru is the shared home of the bounded-memo discipline the report fold, the failure
// digest, and the baseline verdict cache hand-rolled. These pin the two facts its doc
// comment claims: a hit is refreshed to the LRU tail (so it is not evicted next at the cap),
// and the map never exceeds `max` entries.

test("memoSetLru refreshes a hit to the tail and evicts the oldest at the cap", () => {
  const cache = new Map<string, number>();
  memoSetLru(cache, "a", 1, 2);
  memoSetLru(cache, "b", 2, 2);
  // Refreshing "a" moves it past "b", so the oldest ("b") is the one evicted on the next set.
  memoSetLru(cache, "a", 11, 2);
  assert.deepEqual([...cache.keys()], ["b", "a"]);
  memoSetLru(cache, "c", 3, 2);
  assert.deepEqual([...cache.keys()], ["a", "c"]);
  assert.equal(cache.get("a"), 11);
  assert.equal(cache.get("c"), 3);
  assert.equal(cache.size, 2);
});

test("memoSetLru never exceeds max entries even when all distinct", () => {
  const cache = new Map<string, number>();
  for (let i = 0; i < 10; i++) memoSetLru(cache, `k${i}`, i, 3);
  assert.equal(cache.size, 3);
  assert.deepEqual([...cache.values()], [7, 8, 9]);
});
