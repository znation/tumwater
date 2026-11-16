import test from "node:test";
import assert from "node:assert/strict";

import { addTo, compareCodeUnits, distinctOrdered, filterKeepPositions, getOrCreate, groupBy, lowerMedian, memoSetLru, rankCountEntries, sortByValueDesc, topAndHidden } from "../src/collections.js";

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
// tiebreak instead of rankCountEntries's localeCompare: the cli-log-commands per-type event-count
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

// addTo also WRITES through an OWN property, not a plain `record[key] = …`: assignment to
// "__proto__" (another Object.prototype key, reachable through a failing-test name) would
// trigger the inherited setter and create no own key, silently dropping the count. The
// defineProperty write must keep __proto__ an own enumerable counter while leaving the
// object a plain prototype (so later reporting of the rest of the map is unaffected).
test("addTo counts a key named __proto__ as its own key", () => {
  const counts: Partial<Record<string, number>> = {};
  addTo(counts, "__proto__", 1);
  addTo(counts, "__proto__", 3);
  assert.equal(Object.hasOwn(counts, "__proto__"), true, "__proto__ becomes an own key");
  assert.equal(counts["__proto__"], 4, "the count accumulates");
  assert.equal(Object.keys(counts).length, 1, "one own enumerable key");
  assert.equal(
    Object.getPrototypeOf(counts),
    Object.prototype,
    "the record stays a plain object",
  );
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

// topAndHidden is the shared home of the "slice to a cap and count the remainder" pairing the
// merge-intent and conflict-hunk caps (merge-git.ts), the failure digest tops
// (failure-time-spend.ts, failure-cluster.ts), and the answered-questions cap
// (backlog-question-answer.ts) built by hand.
// These pin the two facts its doc comment claims: the visible slice is the first `top`, and
// hidden is the number cut off (zero when the list is shorter than the cap).

test("topAndHidden slices the first top and reports the hidden remainder", () => {
  const items = ["a", "b", "c", "d", "e"];
  const { visible, hidden } = topAndHidden(items, 3);
  assert.deepEqual(visible, ["a", "b", "c"]);
  assert.equal(hidden, 2);
});

test("topAndHidden reports zero hidden when the list fits within the cap", () => {
  const { visible, hidden } = topAndHidden(["a", "b"], 5);
  assert.deepEqual(visible, ["a", "b"]);
  assert.equal(hidden, 0);
});

test("topAndHidden respects the cap exactly at the boundary", () => {
  const { visible, hidden } = topAndHidden(["a", "b", "c"], 3);
  assert.deepEqual(visible, ["a", "b", "c"]);
  assert.equal(hidden, 0);
});

// distinctOrdered is the one home of the "keep the first occurrence of each distinct element,
// in the order first seen, dropping later repeats" step its ~19 call sites share (the TUI panes'
// role lists, the startup gates' in-use agents, the doctor descendant/pid lists, the baseline
// known-failure list, the CLI command/key/path-flag lists, and the text comma-list + token
// lists). Its siblings in the file are each pinned above; this is the one with no direct unit
// pin. These pin the two facts its doc comment claims: a repeated element does not leak through,
// and the surviving elements keep the order in which they were first seen.

test("distinctOrdered drops a repeat, keeping the first occurrence in place", () => {
  const items = ["a", "b", "a", "c"];
  const out = distinctOrdered(items);
  assert.deepEqual(out, ["a", "b", "c"]);
  // A dropped `includes` guard would leak the repeat at index 2, giving ["a","b","a","c"].
  assert.equal(out.length, 3);
});

test("distinctOrdered keeps first-seen order rather than re-sorting", () => {
  // First occurrences are "c","a","b" — alphabetical would be ["a","b","c"].
  const out = distinctOrdered(["c", "a", "b", "c"]);
  assert.deepEqual(out, ["c", "a", "b"]);
  // A stray `.sort()` would reorder to ["a","b","c"]; the forward `for` must not.
});

test("distinctOrdered returns a fresh array and leaves the input unmutated", () => {
  const items = ["x", "y", "z"];
  const out = distinctOrdered(items);
  assert.deepEqual(out, ["x", "y", "z"]);
  assert.notEqual(out, items, "the result is a fresh array, not the caller's reference");
  assert.deepEqual(items, ["x", "y", "z"], "the caller's array is left unmutated");
});

test("distinctOrdered returns an empty array for empty input", () => {
  const out = distinctOrdered([]);
  assert.deepEqual(out, []);
  assert.equal(out.length, 0);
});

// filterKeepPositions is the single home of the "keep some, but number by the whole list"
// step the post-merge-review render's --role/--status filter shares (src/review/
// post-merge-review-render.ts). It is the positional twin of the value-only
// Array.prototype.filter: it returns the kept items AND each kept item's 1-indexed position
// in the ORIGINAL list. Its siblings above are pinned here; this was the one with no direct
// unit pin. These pin the documented contract directly.

test("filterKeepPositions returns kept items in source order with 1-indexed original positions", () => {
  const out = filterKeepPositions(["a", "b", "c", "d"], (s) => s === "b" || s === "d");
  assert.deepEqual(out.kept, ["b", "d"]);
  assert.deepEqual(out.positions, [2, 4]);
  // A kept-only renumber to [1, 2] or a 0-based [1, 3] would fail this: the positions must
  // index the ORIGINAL list, where "b" is 2nd and "d" is 4th.
});

test("filterKeepPositions keeps every input across the full 1..n range", () => {
  const out = filterKeepPositions(["a", "b", "c"], () => true);
  assert.deepEqual(out.kept, ["a", "b", "c"]);
  assert.deepEqual(out.positions, [1, 2, 3]);
});

test("filterKeepPositions returns two empty results when nothing is kept", () => {
  const out = filterKeepPositions(["a", "b", "c"], () => false);
  assert.equal(out.kept.length, 0);
  assert.deepEqual(out.positions, []);
});

test("filterKeepPositions returns two empty results for empty input", () => {
  const out = filterKeepPositions([], () => true);
  assert.equal(out.kept.length, 0);
  assert.deepEqual(out.positions, []);
});

test("filterKeepPositions does not mutate its input array", () => {
  const input = ["a", "b", "c"];
  filterKeepPositions(input, () => false);
  assert.deepEqual(input, ["a", "b", "c"]);
  assert.equal(input.length, 3);
});

// Pins the one unpinned member of collections.ts's string-ordering family. The
// expectations are the sign of the raw UTF-16 comparison (a < b ? -1 : a > b ? 1 : 0),
// derived from the definition; none is computed by calling the function under test.
test("compareCodeUnits orders by raw code unit, not locale", () => {
  // The three comparator branches, pinned by their exact sign.
  assert.equal(compareCodeUnits("a", "a"), 0);
  assert.equal(compareCodeUnits("a", "b"), -1);
  assert.equal(compareCodeUnits("b", "a"), 1);
  // The discriminator: uppercase 0x5A sorts before lowercase 0x61 under raw code
  // units, while localeCompare (accent- and case-insensitive) orders them opposite.
  // A regression that routed this comparator through localeCompare would fail here.
  assert.equal(compareCodeUnits("Z", "a"), -1);
  // Punctuation 0x21 sorts before a letter 0x41: a raw code-unit order, not a
  // collation order.
  assert.equal(compareCodeUnits("!", "A"), -1);
});

// Pins the one unpinned collections median rule. lowerMedian is the single home of the
// lower-median rule the report and doctor rows read, whose doc comment draws the contrast
// against failure-data.ts's mean-of-two median. Each expectation is index
// Math.floor((n - 1) / 2) into an ascending sort of a fresh copy, derived from the
// definition; none is computed by calling the function.
test("lowerMedian takes the single middle (odd) or the lower middle (even)", () => {
  // Odd count -> the single middle.
  assert.equal(lowerMedian([1, 2, 3, 4, 5]), 3);
  // Even count -> the lower of the two middles: 2, not the mean-of-two 2.5 that
  // failure-data.ts's median would give. This is the regression the pin guards against.
  assert.equal(lowerMedian([1, 2, 3, 4]), 2);
  // Smallest counts: a single value, and the lower of the two.
  assert.equal(lowerMedian([7]), 7);
  assert.equal(lowerMedian([2, 5]), 2);
  // A fresh copy is sorted; the caller's array is never mutated.
  const input = [4, 1, 3, 2];
  assert.equal(lowerMedian(input), 2);
  assert.deepEqual(input, [4, 1, 3, 2]);
});
