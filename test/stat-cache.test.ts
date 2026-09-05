import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readJsonFile } from "../src/json-files.js";
import { cachedByStat, type StatKeyedValue } from "../src/stat-cache.js";
import { tmpdir } from "./util.js";

test("cachedByStat drops a stale entry when the file vanishes and reloads fresh content", () => {
  const dir = tmpdir();
  const file = path.join(dir, "state.json");
  fs.writeFileSync(file, JSON.stringify({ v: 1 }));

  const cache = new Map<string, StatKeyedValue<{ v: number }>>();
  let loads = 0;
  const load = () => {
    loads += 1;
    return readJsonFile<{ v: number }>(file);
  };
  const poll = () => cachedByStat(cache, file, file, load, (x) => ({ ...x }));

  assert.deepEqual(poll(), { v: 1 }); // populates the cache
  assert.equal(loads, 1);

  fs.rmSync(file); // vanished between polls
  assert.equal(poll(), null); // no data — and no doomed read was attempted
  assert.equal(loads, 1);
  assert.equal(cache.size, 0); // stale entry dropped, not kept for a file that is gone

  fs.writeFileSync(file, JSON.stringify({ v: 2 })); // recreated with new content (new inode)
  assert.deepEqual(poll(), { v: 2 }); // fresh load — never the pre-vanish value
});

test("cachedByStat does not cache a failed load: it retries each poll and recovers when repaired", () => {
  const dir = tmpdir();
  const file = path.join(dir, "state.json");
  fs.writeFileSync(file, JSON.stringify({ v: 1 }));

  const cache = new Map<string, StatKeyedValue<{ v: number }>>();
  let loads = 0;
  const load = () => {
    loads += 1;
    return readJsonFile<{ v: number }>(file);
  };
  const poll = () => cachedByStat(cache, file, file, load, (x) => ({ ...x }));

  assert.deepEqual(poll(), { v: 1 }); // healthy baseline is cached

  fs.writeFileSync(file, '{"v": '); // torn write — the changed stat misses the cache…
  assert.equal(poll(), null); // …and the failed load must not serve the stale value
  assert.equal(loads, 2);
  assert.equal(poll(), null); // still torn: retried on every poll (nothing was cached)
  assert.equal(loads, 3);

  fs.writeFileSync(file, JSON.stringify({ v: 3 })); // repaired with new content
  assert.deepEqual(poll(), { v: 3 });
});

test("cachedByStat evicts to stay bounded once the cap is reached", () => {
  const dir = tmpdir();
  const cache = new Map<string, StatKeyedValue<{ v: number }>>();
  const loads = new Map<string, number>();
  const poll = (file: string) => {
    loads.set(file, (loads.get(file) ?? 0) + 1);
    return cachedByStat(cache, file, file, () => readJsonFile<{ v: number }>(file), (x) => ({ ...x }));
  };

  // Fill the cache to its cap with distinct files.
  const files: string[] = [];
  for (let i = 0; i < 64; i++) {
    const file = path.join(dir, `f${i}.json`);
    fs.writeFileSync(file, JSON.stringify({ v: i }));
    assert.deepEqual(poll(file), { v: i });
    files.push(file);
  }
  assert.equal(cache.size, 64);

  // The next distinct file pushes the cache over the cap: everything is evicted and only
  // the newcomer is kept — the map can never grow unbounded (many short-lived roots).
  const extra = path.join(dir, "extra.json");
  fs.writeFileSync(extra, JSON.stringify({ v: 99 }));
  assert.deepEqual(poll(extra), { v: 99 });
  assert.equal(cache.size, 1);

  // An evicted file is re-read on its next poll (the documented cost of eviction) and gets
  // the same value — no data loss, just one extra read.
  const first = files[0]!;
  assert.deepEqual(poll(first), { v: 0 });
  assert.equal(loads.get(first), 2);
});
