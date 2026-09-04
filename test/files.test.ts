import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  cachedByStat,
  findOnPath,
  pruneOldFiles,
  readJsonFile,
  rotateIfLarge,
  statOrNull,
  writeJsonFile,
} from "../src/files.js";
import { tmpdir } from "./util.js";

test("rotateIfLarge rotates once over the cap and replaces the previous rotation", () => {
  const dir = tmpdir();
  const file = path.join(dir, "log.jsonl");
  fs.writeFileSync(file, "x".repeat(100));
  assert.equal(rotateIfLarge(file, 1000), false);
  assert.equal(rotateIfLarge(file, 50), true);
  assert.ok(!fs.existsSync(file));
  assert.equal(fs.readFileSync(file + ".1", "utf8").length, 100);
  fs.writeFileSync(file, "y".repeat(80));
  assert.equal(rotateIfLarge(file, 50), true);
  assert.equal(fs.readFileSync(file + ".1", "utf8")[0], "y", "old rotation replaced");
  assert.equal(rotateIfLarge(path.join(dir, "missing"), 50), false);
});

test("pruneOldFiles removes only files older than the retention window", () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, "role"), { recursive: true });
  const oldFile = path.join(dir, "role", "old.jsonl");
  const newFile = path.join(dir, "role", "new.jsonl");
  fs.writeFileSync(oldFile, "old");
  fs.writeFileSync(newFile, "new");
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 3600 * 1000);
  fs.utimesSync(oldFile, tenDaysAgo, tenDaysAgo);
  assert.equal(pruneOldFiles(dir, 7), 1);
  assert.ok(!fs.existsSync(oldFile));
  assert.ok(fs.existsSync(newFile));
  assert.equal(pruneOldFiles(path.join(dir, "nope"), 7), 0);
});

test("findOnPath locates executables like spawn would resolve them", () => {
  const dir = tmpdir();
  const bin = path.join(dir, "pi");
  fs.writeFileSync(bin, "#!/bin/sh\n");
  fs.chmodSync(bin, 0o755);
  assert.equal(findOnPath("pi", dir), bin);

  // A directory named like the binary is not a match (spawn would fail on it too).
  const dirs = tmpdir();
  fs.mkdirSync(path.join(dirs, "pi"));
  assert.equal(findOnPath("pi", dirs), null);

  // Non-executable files are skipped; empty PATH segments are ignored.
  const noexec = tmpdir();
  const plain = path.join(noexec, "pi");
  fs.writeFileSync(plain, "#!/bin/sh\n");
  fs.chmodSync(plain, 0o644);
  assert.equal(findOnPath("pi", `${noexec}::${dir}`), bin);

  // Missing binary or empty PATH.
  assert.equal(findOnPath("definitely-missing-xyz", dir), null);
  assert.equal(findOnPath("pi", ""), null);
});

test("statOrNull and readJsonFile treat missing or torn files as no data, not errors", () => {
  const dir = tmpdir();
  const file = path.join(dir, "state.json");

  assert.equal(statOrNull(file), null); // missing — no throw
  assert.equal(readJsonFile<unknown>(file), null);

  fs.writeFileSync(file, JSON.stringify({ ticks: 3 }));
  assert.ok(statOrNull(file)!.isFile());
  assert.deepEqual(readJsonFile<{ ticks: number }>(file), { ticks: 3 });

  // A torn write (crash mid-write by another process) must not throw — observers polling
  // these files every second would die on it.
  fs.writeFileSync(file, '{"ticks": ');
  assert.equal(readJsonFile<unknown>(file), null);
});

test("cachedByStat drops a stale entry when the file vanishes and reloads fresh content", () => {
  const dir = tmpdir();
  const file = path.join(dir, "state.json");
  fs.writeFileSync(file, JSON.stringify({ v: 1 }));

  const cache = new Map<string, { dev: number; ino: number; mtimeMs: number; size: number; value: { v: number } }>();
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

  const cache = new Map<string, { dev: number; ino: number; mtimeMs: number; size: number; value: { v: number } }>();
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

test("writeJsonFile creates parent dirs and writes pretty-printed JSON (overwriting)", () => {
  const dir = tmpdir();
  const file = path.join(dir, "nested", "marker.json"); // Parent does not exist yet.
  writeJsonFile(file, { at: 123, roles: ["feature"] });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { at: 123, roles: ["feature"] });
  const raw = fs.readFileSync(file, "utf8");
  assert.ok(raw.includes('\n  "at": 123'), "two-space pretty print — the shared marker/info format");

  writeJsonFile(file, { at: 456 }); // Overwrites an existing file in place.
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { at: 456 });
});

test("cachedByStat evicts to stay bounded once the cap is reached", () => {
  const dir = tmpdir();
  const cache = new Map<string, { dev: number; ino: number; mtimeMs: number; size: number; value: { v: number } }>();
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
