import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { followFile, forEachTailChunk, readCompleteLines, withTail, type TailState } from "../src/tail.js";
import { tmpdir } from "./repo-fixtures.js";
import { vanishOnOpen, vanishOnReadFile } from "./fs-faults.js";
import { waitFor } from "./wait.js";

test("followFile delivers each complete line once, holds torn tails, resets on shrink", async () => {
  const file = path.join(tmpdir(), "live.jsonl");
  fs.writeFileSync(file, "a\n");
  const got: string[] = [];
  // stop() must run even if an assertion fails below, or the poll timer keeps node --test alive.
  const stop = followFile(file, 0, (lines) => got.push(...lines), 25);
  try {
    await waitFor(() => got.includes("a"), `the tail to deliver "a" (got ${JSON.stringify(got)})`);

    // A torn trailing line (no newline yet) is held back until its writer completes it.
    fs.appendFileSync(file, "b");
    assert.ok(!got.includes("b"));
    fs.appendFileSync(file, "\n");
    await waitFor(() => got.includes("b"), `the tail to deliver "b" (got ${JSON.stringify(got)})`);

    // Rotation/truncation: the file shrinks below the consumed offset and restarts.
    fs.writeFileSync(file, "");
    fs.appendFileSync(file, "c\n");
    await waitFor(() => got.includes("c"), `the tail to deliver "c" (got ${JSON.stringify(got)})`);
  } finally {
    stop();
  }

  fs.appendFileSync(file, "d\n");
  await new Promise((r) => setTimeout(r, 150)); // Several poll intervals after stopping.
  assert.ok(!got.includes("d"), "no delivery after stop()");
  assert.deepEqual(got.filter(Boolean), ["a", "b", "c"]);
});

test("followFile delivers appended lines once, in order, and holds a torn tail until complete", async () => {
  const file = path.join(tmpdir(), "follow.jsonl");
  fs.writeFileSync(file, "");
  const seen: string[] = [];
  const stop = followFile(file, 0, (lines) => {
    for (const line of lines.filter(Boolean)) seen.push(line);
  });
  try {
    fs.appendFileSync(file, "line one\n");
    await waitFor(() => seen.length === 1, `the tail to deliver line one (got ${JSON.stringify(seen)})`);
    assert.deepEqual(seen, ["line one"]);

    // A write straddling a poll boundary must not be delivered torn or lost.
    fs.appendFileSync(file, '{"torn":"mes');
    await new Promise((r) => setTimeout(r, 1200)); // several polls with the tail incomplete
    assert.deepEqual(seen, ["line one"], "incomplete trailing line is held back");

    fs.appendFileSync(file, 'sage"}\n');
    await waitFor(() => seen.length === 2, `the tail to complete the torn line (got ${JSON.stringify(seen)})`);
    assert.deepEqual(seen, ["line one", '{"torn":"message"}']);
  } finally {
    stop(); // the poll timer would otherwise keep the test process alive
  }
});

test("followFile survives rotation: lines appended after a rename+rewrite are not lost", async () => {
  const file = path.join(tmpdir(), "rotate.jsonl");
  fs.writeFileSync(file, "old line\n"); // follow starts past the existing content (like the CLI does)
  const seen: string[] = [];
  const stop = followFile(file, fs.statSync(file).size, (lines) => {
    for (const line of lines.filter(Boolean)) seen.push(line);
  });
  try {
    await new Promise((r) => setTimeout(r, 700)); // let polls run while nothing changes
    assert.deepEqual(seen, [], "pre-existing content is not re-delivered");

    // rotateIfLarge renames the log and a fresh (smaller) file starts.
    fs.renameSync(file, file + ".1");
    fs.writeFileSync(file, "");
    await new Promise((r) => setTimeout(r, 700)); // a poll sees size < offset and resets it
    fs.appendFileSync(file, "fresh\n");
    await waitFor(() => seen.length === 1, `the fresh file to deliver a line after rotation (got ${JSON.stringify(seen)})`);
    assert.deepEqual(seen, ["fresh"]);
  } finally {
    stop();
  }
});

test("followFile drains the lines the rotation moved into <file>.1: nothing appended before the rename is lost", async () => {
  const file = path.join(tmpdir(), "rotate-drain.jsonl");
  fs.writeFileSync(file, "old line\n");
  const seen: string[] = [];
  const stop = followFile(file, fs.statSync(file).size, (lines) => {
    for (const line of lines.filter(Boolean)) seen.push(line);
  }, 25);
  try {
    await new Promise((r) => setTimeout(r, 100)); // a poll consumes the pre-existing content
    assert.equal(seen.length, 0);

    // Lines appended to the outgoing inode after the last poll, then the rename: the next
    // poll stats only the fresh file, so without a drain these lines are silently lost —
    // the append and the rename are back-to-back synchronous calls, so no poll can run
    // between them and the loss is deterministic.
    fs.appendFileSync(file, "missed one\nmissed two\n");
    fs.renameSync(file, file + ".1");
    fs.writeFileSync(file, "");
    fs.appendFileSync(file, "fresh\n");
    await waitFor(() => seen.includes("fresh"), `the fresh file to deliver "fresh" (got ${JSON.stringify(seen)})`);
    assert.deepEqual(seen, ["missed one", "missed two", "fresh"]);
  } finally {
    stop();
  }

  // A second poll after everything settled must not re-deliver the drained lines: the
  // archive's size no longer exceeds the offset the follow consumed through.
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(seen, ["missed one", "missed two", "fresh"]);
});

test("followFile survives a rotation whose replacement outgrows the old offset within one poll: the new content is delivered whole, not from the stale offset", async () => {
  const file = path.join(tmpdir(), "rotate-grow.jsonl");
  fs.writeFileSync(file, "old line\n");
  const seen: string[] = [];
  const stop = followFile(file, fs.statSync(file).size, (lines) => {
    for (const line of lines.filter(Boolean)) seen.push(line);
  }, 25);
  try {
    await new Promise((r) => setTimeout(r, 100)); // let polls run while nothing changes

    // Rotation where the fresh file is written LONGER than the old offset before the next
    // poll: size alone reads as an append, so only the dev/ino guard catches it — the stale
    // offset would deliver the new content's tail as a mangled mid-line fragment and lose
    // its head.
    fs.renameSync(file, file + ".1");
    fs.writeFileSync(file, "x".repeat(40) + "\n" + "fresh\n");
    await waitFor(() => seen.length === 2, `the replacement's whole content to arrive (got ${JSON.stringify(seen)})`);
    assert.deepEqual(seen, ["x".repeat(40), "fresh"]);
  } finally {
    stop();
  }
  fs.rmSync(file, { force: true });
  fs.rmSync(file + ".1", { force: true });
});

test("followFile waits for a missing file to appear", async () => {
  const file = path.join(tmpdir(), "late.jsonl"); // does not exist yet
  const seen: string[] = [];
  const stop = followFile(file, 0, (lines) => {
    for (const line of lines.filter(Boolean)) seen.push(line);
  });
  try {
    await new Promise((r) => setTimeout(r, 700));
    assert.deepEqual(seen, [], "a missing file is skipped without failing");
    fs.writeFileSync(file, "appeared\n");
    await waitFor(() => seen.length === 1, `the created file to deliver its line (got ${JSON.stringify(seen)})`);
    assert.deepEqual(seen, ["appeared"]);
  } finally {
    stop();
  }
});

test("withTail reseeds when the file is truncated in place (same inode)", () => {
  // The rotation tests cover rename (new dev/ino); this pins the other half of the reseed
  // condition: an in-place truncation keeps the inode but shrinks below the consumed
  // offset. Without that check the reader would stall at its stale offset and skip every
  // line written until the file grew past it again.
  const dir = tmpdir();
  const file = path.join(dir, "log.jsonl");
  fs.writeFileSync(file, "a\nb\nc\n");
  const tails = new Map<string, TailState<string[]>>();
  const fresh = (_size: number) => ({ fromOffset: 0, value: [] as string[] });
  const feed = (v: string[], line: string) => {
    if (line) v.push(line);
  };

  let val = withTail(tails, file, fs.statSync(file), fresh, feed);
  assert.deepEqual(val, ["a", "b", "c"], "first observation seeds from scratch");

  fs.appendFileSync(file, "d\n");
  val = withTail(tails, file, fs.statSync(file), fresh, feed);
  assert.deepEqual(val, ["a", "b", "c", "d"], "append-only growth folds only the new lines");

  // Truncate in place (writeFileSync truncates but keeps dev/ino) and rewrite smaller.
  fs.writeFileSync(file, "e\n");
  val = withTail(tails, file, fs.statSync(file), fresh, feed);
  assert.deepEqual(val, ["e"], "in-place shrink reseeds instead of stalling at the old offset");

  // And keeps consuming appends afterwards.
  fs.appendFileSync(file, "f\n");
  val = withTail(tails, file, fs.statSync(file), fresh, feed);
  assert.deepEqual(val, ["e", "f"]);
});

test("withTail bounds its tail cache: seeding many files never grows it unbounded", () => {
  // Long-lived observers (TUI/GUI) poll one log per root; short-lived roots (tests, scratch
  // repos) must not accumulate a tail entry each. The cap evicts on seed — assert the
  // contract (bounded), not the exact constant.
  const dir = tmpdir();
  const tails = new Map<string, TailState<number>>();
  const fresh = (_size: number) => ({ fromOffset: 0, value: 0 });
  const feed = (v: number) => v + 1;
  for (let i = 0; i < 200; i++) {
    const f = path.join(dir, `f${i}.jsonl`);
    fs.writeFileSync(f, "x\n");
    withTail(tails, f, fs.statSync(f), fresh, feed);
  }
  assert.ok(tails.size < 100, `tail cache must stay bounded (got ${tails.size} entries)`);
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

test("readCompleteLines returns no lines when rotation removes the file between stat and open", () => {
  const file = path.join(tmpdir(), "log.jsonl");
  fs.writeFileSync(file, "a\nb\nc\n");
  const size = fs.statSync(file).size; // the caller's stat sees the pre-rotation file
  const restore = vanishOnOpen(file);
  try {
    assert.deepEqual(readCompleteLines(file, 0, size), { lines: [], end: 0 }); // no throw — next poll reseeds
  } finally {
    restore();
  }
});
test("forEachTailChunk delivers chunks newest-first and honors onChunk's early stop", () => {
  const dir = tmpdir();
  const file = path.join(dir, "log.jsonl");
  // Exactly three tail chunks (8 KB each), with a position-identifiable byte pattern.
  const data = Buffer.alloc(3 * 8192);
  for (let i = 0; i < data.length; i++) data[i] = i % 251;
  fs.writeFileSync(file, data);

  // Early stop: a callback that returns true after the first chunk must not read further —
  // this is what keeps per-poll I/O bounded by the caller's need (readEvents' limit lines,
  // readWindowEvents' window) rather than by how far the log has grown.
  const stopped: Buffer[] = [];
  forEachTailChunk(file, (chunk) => {
    stopped.push(Buffer.from(chunk));
    return true;
  });
  assert.equal(stopped.length, 1, "scan stops after the first chunk");
  assert.ok(stopped[0]!.equals(data.subarray(2 * 8192)), "first chunk is the newest (tail) bytes");

  // No early stop: all three chunks arrive in newest-first order with their exact contents.
  const full: Buffer[] = [];
  forEachTailChunk(file, (chunk) => {
    full.push(Buffer.from(chunk));
    return false;
  });
  assert.equal(full.length, 3);
  for (let k = 0; k < 3; k++) {
    const start = (2 - k) * 8192; // newest first: [16384..), [8192..16384), [0..8192)
    assert.ok(
      full[k]!.equals(data.subarray(start, start + 8192)),
      `chunk ${k} is bytes ${start}..${start + 8192}`,
    );
  }

  // A file at or under the small-file threshold is delivered whole as a single chunk.
  const small = path.join(dir, "small.jsonl");
  fs.writeFileSync(small, "abc\n");
  const smallParts: Buffer[] = [];
  forEachTailChunk(small, (chunk) => {
    smallParts.push(Buffer.from(chunk));
    return true;
  });
  assert.equal(smallParts.length, 1);
  assert.equal(smallParts[0]!.toString("utf8"), "abc\n");

  // A missing file delivers nothing.
  let missingCalls = 0;
  forEachTailChunk(path.join(dir, "nope.jsonl"), () => {
    missingCalls++;
    return false;
  });
  assert.equal(missingCalls, 0);
});

test("forEachTailChunk delivers nothing when rotation removes the file between stat and open", () => {
  const dir = tmpdir();
  // Both read paths: over the small-file threshold opens an fd, at or under it reads whole.
  for (const [name, data] of [
    ["large.jsonl", Buffer.alloc(3 * 8192).fill(0x61)],
    ["small.jsonl", Buffer.from("abc\n")],
  ] as const) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, data);
    const restore = name === "large.jsonl" ? vanishOnOpen(file) : vanishOnReadFile(file);
    try {
      let calls = 0;
      forEachTailChunk(file, () => {
        calls++;
        return false;
      }); // must not throw — a rotated-away file is no data, like a missing one
      assert.equal(calls, 0, `${name}: nothing delivered`);
    } finally {
      restore();
    }
  }
});
