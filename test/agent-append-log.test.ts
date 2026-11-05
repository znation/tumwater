import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { openAppendLog } from "../src/agent/agent-spawn.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

/** Wait until `check` returns true, or fail after ~2 s. Lets a test wait for the
 * async 'close' event of a WriteStream without racing the event loop. */
async function waitFor(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("openAppendLog does not rotate a log another live run in the process still writes", async () => {
  const dir = tmpdir();
  const file = path.join(dir, "role.pi.jsonl");
  fs.writeFileSync(file, "x".repeat(1000));

  // The first run opens the log: it is unheld and past the cap, so this open rotates the
  // old file and starts a fresh one it now holds.
  const first = openAppendLog(file, 500);
  assert.equal(fs.existsSync(file + ".1"), true, "the unheld first open rotated the grown file");
  // Grow the fresh file past the cap while the first run still holds it (a stream write is
  // buffered and may not reach the disk by the next open, so grow it synchronously).
  await waitFor(() => fs.existsSync(file), "the fresh live file to appear");
  fs.appendFileSync(file, "y".repeat(600));

  // A second run of the same role opens the same path while the first is still live
  // (a post-merge review while the role's run is streaming). It must not rename the
  // file the first run is writing.
  const second = openAppendLog(file, 500);
  assert.equal(fs.existsSync(file), true, "second live open must not rotate a log a live run holds");
  assert.equal(fs.existsSync(file + ".2"), false, "no second generation may appear while a live run holds the path");

  first.stream.end();
  await waitFor(() => first.stream.closed, "the first stream to close");
  second.stream.end();
  await waitFor(() => second.stream.closed, "the second stream to close");

  // The first open after the last writer closes rotates the grown log.
  const third = openAppendLog(file, 500);
  assert.equal(fs.existsSync(file + ".1"), true, "the first open after all writers closed rotated");
  const size = fs.statSync(file + ".1").size;
  assert.ok(size >= 600, `the rotated generation holds the first run's bytes (got ${size})`);
  third.stream.end();
  await waitFor(() => third.stream.closed, "the third stream to close");
});

test("openAppendLog rotates again once the only holder of a just-rotated file has closed", async () => {
  const dir = tmpdir();
  const file = path.join(dir, "role.pi.jsonl");
  fs.writeFileSync(file, "x".repeat(1000));

  const first = openAppendLog(file, 500); // live, over the cap
  first.stream.write("y".repeat(600));
  const second = openAppendLog(file, 500); // skips the rename
  first.stream.end();
  await waitFor(() => first.stream.closed, "the first stream to close");
  second.stream.end();
  await waitFor(() => second.stream.closed, "the second stream to close");

  const third = openAppendLog(file, 500); // rotates
  assert.equal(fs.existsSync(file + ".1"), true, "third open rotated");
  // Grow the fresh file past the cap synchronously (a stream write is buffered and may not
  // have reached the disk by the next open).
  fs.appendFileSync(file, "z".repeat(600));
  const fourth = openAppendLog(file, 500); // held: the third is still writing
  // The stream's open is async: wait for the fresh file to appear, then confirm the held
  // fourth open did not rename it away.
  await waitFor(() => fs.existsSync(file), "the fresh live file to appear");
  assert.equal(fs.existsSync(file + ".2"), false, "no shift of the first generation while held");
  third.stream.end();
  await waitFor(() => third.stream.closed, "the third stream to close");
  fourth.stream.end();
  await waitFor(() => fourth.stream.closed, "the fourth stream to close");

  const fifth = openAppendLog(file, 500); // rotates again
  assert.ok(fs.statSync(file + ".1").size >= 600, "the second rotation kept the grown fresh file");
  fifth.stream.end();
  await waitFor(() => fifth.stream.closed, "the fifth stream to close");
});

test("openAppendLog still rotates an oversized file nobody else in the process holds", () => {
  const dir = tmpdir();
  const file = path.join(dir, "solo.pi.jsonl");
  fs.writeFileSync(file, "x".repeat(1000));
  const log = openAppendLog(file, 500);
  assert.equal(fs.existsSync(file + ".1"), true, "unheld oversized file rotates as before");
  assert.ok(!fs.existsSync(file), "a fresh live file starts");
  log.stream.end();
});
