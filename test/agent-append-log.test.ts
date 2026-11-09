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
  // Rotation keeps one generation, so a second open that wrongly rotates replaces the .1;
  // checking its size (1000 from the first rotation, not the grown file's 600) is what makes
  // the held-open assertion hold even if the new stream's asynchronous open races the check.
  assert.equal(fs.statSync(file + ".1").size, 1000, "second live open must not replace the first generation");

  first.stream.end();
  await waitFor(() => first.stream.closed, "the first stream to close");
  second.stream.end();
  await waitFor(() => second.stream.closed, "the second stream to close");

  // The first open after the last writer closes rotates the grown log. Measure the grown
  // file first, then require the archive to be exactly that file — .1 already exists from
  // the first rotation, so its mere existence would not show that the held count was released.
  const grown = fs.statSync(file).size;
  assert.ok(grown >= 600, `the live file holds the first run's bytes (got ${grown})`);
  const third = openAppendLog(file, 500);
  assert.equal(fs.existsSync(file + ".1"), true, "the first open after all writers closed rotated");
  const size = fs.statSync(file + ".1").size;
  assert.equal(
    size,
    grown,
    `the first open after all writers closed rotated the grown log (got ${size}, expected ${grown})`,
  );
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
  assert.equal(
    fs.readFileSync(file + ".1", "utf8"),
    "y".repeat(600),
    "third open rotated the file the first run grew",
  );
  // Grow the fresh file past the cap synchronously (a stream write is buffered and may not
  // have reached the disk by the next open).
  fs.appendFileSync(file, "z".repeat(600));
  const fourth = openAppendLog(file, 500); // held: the third is still writing
  // The stream's open is async: wait for the fresh file to appear, then confirm the held
  // fourth open did not rename it away. The .1 still holding the earlier y bytes proves no
  // shift happened (a second generation never appears when keep is 1).
  await waitFor(() => fs.existsSync(file), "the fresh live file to appear");
  assert.equal(
    fs.readFileSync(file + ".1", "utf8"),
    "y".repeat(600),
    "the held fourth open must not shift the first generation",
  );
  third.stream.end();
  await waitFor(() => third.stream.closed, "the third stream to close");
  fourth.stream.end();
  await waitFor(() => fourth.stream.closed, "the fourth stream to close");

  const fifth = openAppendLog(file, 500); // rotates again
  assert.equal(
    fs.readFileSync(file + ".1", "utf8"),
    "z".repeat(600),
    "the fifth open rotated the file grown while the third held it (the count was released)",
  );
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

test("a next open terminates a torn tail the previous run left, so no reader glues two records into one", async () => {
  const dir = tmpdir();
  const file = path.join(dir, "role.pi.jsonl");
  // A killed run (the SIGTERM → SIGKILL group sweep, a write failure, a power loss) ends the
  // pi log with its last line missing the trailing newline — the file on disk is exactly this.
  // The next run's open is where the torn-tail reader (the log) meets the writer (this run),
  // which is where the repair belongs.
  fs.writeFileSync(
    file,
    JSON.stringify({ type: "session", cwd: "/work" }) + "\n" + JSON.stringify({ type: "message_end" }),
  );
  assert.ok(!fs.readFileSync(file, "utf8").endsWith("\n"), "precondition: the previous run left a torn trailing line");

  const second = openAppendLog(file, 16 * 1024 * 1024); // no other run in the process holds this path
  // The open's torn-tail repair appends the missing newline; wait for it to land on disk.
  await waitFor(() => fs.readFileSync(file, "utf8").endsWith("\n"), "the torn tail to be terminated on the next open");
  const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.length > 0);
  assert.equal(lines.length, 2, "the torn line became its own line");
  for (const line of lines) {
    assert.doesNotThrow(() => JSON.parse(line), `each line parses on its own (no glue), got: ${line}`);
  }
  const [firstLine, secondLine] = lines;
  assert.ok(firstLine !== undefined, "the first record line is present");
  assert.ok(secondLine !== undefined, "the second record line is present");
  assert.ok(firstLine.includes('"session"'), "the earlier complete record is intact");
  assert.ok(secondLine.includes("message_end"), "the torn record survived, now on its own line");
  second.stream.end();
  await waitFor(() => second.stream.closed, "the stream to close");
});

test("a held live writer's file is not torn-tail-repaired by another open of the same path", async () => {
  const dir = tmpdir();
  const file = path.join(dir, "shared.pi.jsonl");
  // A run that is still live (its stream open) leaves a torn tail in the file it writes, and
  // a second run of the same role opens the same path (a post-merge review while the role's
  // run is streaming). The held first writer owns the tail, so the second writer's open must
  // not append a newline into a file a live run still writes — only the writer whose stream
  // actually closed may repair.
  fs.writeFileSync(file, JSON.stringify({ type: "message_end" })); // torn: no trailing newline
  const first = openAppendLog(file, 16 * 1024 * 1024); // the live writer; unheld, so it repairs its own torn tail
  await waitFor(() => first.stream.path === file, "the first stream to open");
  await waitFor(() => fs.readFileSync(file, "utf8").endsWith("\n"), "the live writer's torn tail to be terminated");
  const bytesBeforeSecond = fs.readFileSync(file, "utf8");
  const second = openAppendLog(file, 16 * 1024 * 1024); // held: the first is still writing
  await waitFor(() => second.stream.path === file, "the second stream to open");
  await new Promise((resolve) => setTimeout(resolve, 50)); // let any spurious repair land
  assert.equal(fs.readFileSync(file, "utf8"), bytesBeforeSecond, "a held live writer's file is untouched by another open");
  first.stream.end();
  await waitFor(() => first.stream.closed, "the first stream to close");
  second.stream.end();
  await waitFor(() => second.stream.closed, "the second stream to close");
});

test("a next open leaves an already-newline-terminated log untouched (the repair is a no-op)", async () => {
  const dir = tmpdir();
  const file = path.join(dir, "clean.pi.jsonl");
  // A run that ended cleanly leaves its last line newline-terminated; the next open's
  // torn-tail check finds the trailing newline and must append nothing.
  const clean = JSON.stringify({ type: "session", cwd: "/work" }) + "\n";
  fs.writeFileSync(file, clean);
  const second = openAppendLog(file, 16 * 1024 * 1024);
  await waitFor(() => second.stream.path === file, "the stream to open");
  await new Promise((resolve) => setTimeout(resolve, 50)); // let any spurious repair land
  assert.equal(fs.readFileSync(file, "utf8"), clean, "an already-terminated log is left byte-identical");
  second.stream.end();
  await waitFor(() => second.stream.closed, "the stream to close");
});

test("a destroyed or ended append log reports finished, so a later write or end is skipped", async () => {
  const dir = tmpdir();
  const file = path.join(dir, "finished.pi.jsonl");
  const killed = openAppendLog(file, 16 * 1024 * 1024);
  await waitFor(() => killed.stream.path === file, "the stream to open");
  killed.stream.destroy(); // a killed run ends its stream without a clean end()
  await waitFor(() => killed.stream.closed, "the destroyed stream to close");
  assert.equal(killed.finished, true, "a destroyed stream reports finished");

  const clean = openAppendLog(file, 16 * 1024 * 1024);
  await waitFor(() => clean.stream.path === file, "the stream to open");
  clean.stream.end();
  await waitFor(() => clean.stream.closed, "the ended stream to close");
  assert.equal(clean.finished, true, "a normally ended stream reports finished");
});
