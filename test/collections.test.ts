import test from "node:test";
import assert from "node:assert/strict";

import { getOrCreate, groupBy } from "../src/collections.js";

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
