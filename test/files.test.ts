import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { followFile, pruneOldFiles, readCompleteLines, rotateIfLarge } from "../src/files.js";
import { tmpdir } from "./util.js";

/** Poll `cond` until true or the deadline passes (watchFile cadence is timing-based). */
async function waitFor(cond: () => boolean, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for followFile delivery");
    await new Promise((r) => setTimeout(r, 10));
  }
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

test("followFile delivers each complete line once, holds torn tails, resets on shrink", async () => {
  const file = path.join(tmpdir(), "live.jsonl");
  fs.writeFileSync(file, "a\n");
  const got: string[] = [];
  // stop() must run even if an assertion fails below, or the watcher keeps node --test alive.
  const stop = followFile(file, 0, (lines) => got.push(...lines), 25);
  try {
    await waitFor(() => got.includes("a"), 3000);

    // A torn trailing line (no newline yet) is held back until its writer completes it.
    fs.appendFileSync(file, "b");
    assert.ok(!got.includes("b"));
    fs.appendFileSync(file, "\n");
    await waitFor(() => got.includes("b"), 3000);

    // Rotation/truncation: the file shrinks below the consumed offset and restarts.
    fs.writeFileSync(file, "");
    fs.appendFileSync(file, "c\n");
    await waitFor(() => got.includes("c"), 3000);
  } finally {
    stop();
  }

  fs.appendFileSync(file, "d\n");
  await new Promise((r) => setTimeout(r, 150)); // Several poll intervals after stopping.
  assert.ok(!got.includes("d"), "no delivery after stop()");
  assert.deepEqual(got.filter(Boolean), ["a", "b", "c"]);
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
