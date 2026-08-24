import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { followFile, pruneOldFiles, readCompleteLines, rotateIfLarge } from "../src/files.js";
import { tmpdir } from "./util.js";

/** Poll until `pred` holds or the timeout elapses; returns whether it held. */
async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
}

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

test("followFile delivers appended lines once, in order, and holds a torn tail until complete", async () => {
  const file = path.join(tmpdir(), "follow.jsonl");
  fs.writeFileSync(file, "");
  const seen: string[] = [];
  void followFile(file, 0, (line) => seen.push(line));
  try {
    fs.appendFileSync(file, "line one\n");
    assert.ok(await waitFor(() => seen.length === 1), `expected line one, got ${JSON.stringify(seen)}`);
    assert.deepEqual(seen, ["line one"]);

    // A write straddling a poll boundary must not be delivered torn or lost.
    fs.appendFileSync(file, '{"torn":"mes');
    await new Promise((r) => setTimeout(r, 1200)); // several polls with the tail incomplete
    assert.deepEqual(seen, ["line one"], "incomplete trailing line is held back");

    fs.appendFileSync(file, 'sage"}\n');
    assert.ok(await waitFor(() => seen.length === 2), `expected completed torn line, got ${JSON.stringify(seen)}`);
    assert.deepEqual(seen, ["line one", '{"torn":"message"}']);
  } finally {
    fs.unwatchFile(file); // followFile's watcher would otherwise keep the test process alive
  }
});

test("followFile survives rotation: lines appended after a rename+rewrite are not lost", async () => {
  const file = path.join(tmpdir(), "rotate.jsonl");
  fs.writeFileSync(file, "old line\n"); // follow starts past the existing content (like the CLI does)
  const seen: string[] = [];
  void followFile(file, fs.statSync(file).size, (line) => seen.push(line));
  try {
    await new Promise((r) => setTimeout(r, 700)); // let a poll establish the baseline
    assert.deepEqual(seen, [], "pre-existing content is not re-delivered");

    // rotateIfLarge renames the log and a fresh (smaller) file starts.
    fs.renameSync(file, file + ".1");
    fs.writeFileSync(file, "");
    await new Promise((r) => setTimeout(r, 700)); // a poll sees size < offset and resets it
    fs.appendFileSync(file, "fresh\n");
    assert.ok(await waitFor(() => seen.length === 1), `expected fresh line after rotation, got ${JSON.stringify(seen)}`);
    assert.deepEqual(seen, ["fresh"]);
  } finally {
    fs.unwatchFile(file);
  }
});

test("followFile waits for a missing file to appear", async () => {
  const file = path.join(tmpdir(), "late.jsonl"); // does not exist yet
  const seen: string[] = [];
  void followFile(file, 0, (line) => seen.push(line));
  try {
    await new Promise((r) => setTimeout(r, 700));
    assert.deepEqual(seen, [], "a missing file is skipped without failing");
    fs.writeFileSync(file, "appeared\n");
    assert.ok(await waitFor(() => seen.length === 1), `expected line after creation, got ${JSON.stringify(seen)}`);
    assert.deepEqual(seen, ["appeared"]);
  } finally {
    fs.unwatchFile(file);
  }
});

test("readCompleteLines returns only complete lines and stops at the last newline", () => {
  const file = path.join(tmpdir(), "log.jsonl");
  fs.writeFileSync(file, 'a\n{"torn":"mes'); // trailing partial line (no newline)
  let r = readCompleteLines(file, 0, fs.statSync(file).size);
  assert.deepEqual(r.lines.filter(Boolean), ["a"]);
  assert.equal(r.end, 2); // just past the first \n; the torn tail is not consumed

  fs.appendFileSync(file, 'sage"}\n');
  r = readCompleteLines(file, r.end, fs.statSync(file).size);
  assert.deepEqual(r.lines.filter(Boolean), ['{"torn":"message"}']); // re-read once complete

  // No growth and no newline yet: nothing consumed.
  const empty = path.join(tmpdir(), "empty.jsonl");
  fs.writeFileSync(empty, "abc");
  assert.deepEqual(readCompleteLines(empty, 0, 3), { lines: [], end: 0 });
});
