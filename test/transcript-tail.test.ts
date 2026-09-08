import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readTranscriptTail } from "../src/ui/transcript-tail.js";
// Oracle: the tail reader must match a full re-read rendered by transcript.ts.
import { formatTranscript } from "../src/ui/transcript.js";
import { piLogPath } from "../src/paths.js";
import { readCompleteLines } from "../src/ui/tail.js";
import { FIXED_TS, agentStart, assistantBlocks, tmpdir, userLine } from "./util.js";

/** Local wall-clock rendering of an epoch-ms timestamp (independent of the implementation). */
function expectedTimestamp(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** A harness-written run-label marker line (src/pi.ts writes it for labeled runs). */
function reviewMarker(): string {
  return JSON.stringify({ type: "tumwater_run", label: "review" });
}

test("readTranscriptTail matches a full re-read on a small log", () => {
  const root = tmpdir();
  const file = piLogPath(root, "feature");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines: string[] = [];
  for (let i = 1; i <= 3; i++) {
    lines.push(agentStart());
    lines.push(userLine(`prompt ${i}`, FIXED_TS + i * 60_000));
    lines.push(assistantBlocks([{ type: "text", text: `turn ${i}` }]));
  }
  fs.writeFileSync(file, lines.join("\n") + "\n");

  const size = fs.statSync(file).size;
  const full = formatTranscript(readCompleteLines(file, 0, size).lines);
  for (const limit of [1, 2, 50]) {
    const tail = readTranscriptTail(file, limit);
    assert.ok(tail);
    assert.deepEqual(tail.entries, full.slice(-limit));
    assert.equal(tail.end, readCompleteLines(file, 0, size).end);
  }
});

test("readTranscriptTail matches a full re-read on a multi-MB log and reads only the tail", (t) => {
  const root = tmpdir();
  const file = piLogPath(root, "feature");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // ~400 runs with realistic padding (deltas + tool noise) → several MB, so the last-50
  // window (~half a scan chunk) is far smaller than the file.
  const lines: string[] = [];
  for (let i = 1; i <= 400; i++) {
    lines.push(agentStart());
    lines.push(userLine(`prompt ${i} ` + "x".repeat(200), FIXED_TS + i * 60_000));
    lines.push(JSON.stringify({ type: "message_update", delta: { type: "text_delta", textDelta: "y".repeat(10000) } }));
    lines.push(
      assistantBlocks([
        { type: "thinking", thinking: `thinking ${i} ` + "z".repeat(100) },
        { type: "text", text: `turn ${i}` },
        { type: "toolCall", id: `c${i}`, name: "read", arguments: { path: `/repo/file-${i}.md` } },
      ]),
    );
  }
  fs.writeFileSync(file, lines.join("\n") + "\n");
  const size = fs.statSync(file).size;
  assert.ok(size > 3 * 1024 * 1024, `fixture should span several scan chunks (got ${size})`);

  // Count the bytes actually read from disk while the tail is computed.
  let bytesRead = 0;
  const realReadSync = fs.readSync.bind(fs);
  t.mock.method(
    fs,
    "readSync",
    ((fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null) => {
      const got = realReadSync(fd, buffer, offset, length, position);
      if (position !== null && position >= 0) bytesRead += got;
      return got;
    }) as typeof fs.readSync,
  );
  const tail = readTranscriptTail(file, 50);
  t.mock.restoreAll();

  const full = formatTranscript(readCompleteLines(file, 0, size).lines); // after the mock is gone
  assert.ok(tail);
  assert.deepEqual(tail.entries, full.slice(-50));
  assert.equal(tail.end, readCompleteLines(file, 0, size).end);
  assert.ok(bytesRead < size / 2, `expected a bounded read (got ${bytesRead} of ${size})`);
});

test("readTranscriptTail re-reads fully when contentless turns undercount candidates", () => {
  const root = tmpdir();
  const file = piLogPath(root, "feature");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Each run's second assistant turn is contentless: a candidate line that renders nothing,
  // so the backward scan's stop boundary under-delivers and must fall back to a full read.
  const lines: string[] = [];
  for (let i = 1; i <= 40; i++) {
    lines.push(agentStart());
    lines.push(userLine(`prompt ${i}`, FIXED_TS + i * 60_000));
    lines.push(assistantBlocks([{ type: "text", text: `turn ${i}` }]));
    lines.push(assistantBlocks([]));
  }
  fs.writeFileSync(file, lines.join("\n") + "\n");

  const size = fs.statSync(file).size;
  const full = formatTranscript(readCompleteLines(file, 0, size).lines);
  for (const limit of [1, 2, 50]) {
    assert.deepEqual(readTranscriptTail(file, limit)?.entries, full.slice(-limit));
  }
});

test("readTranscriptTail skips blank lines exactly like a full re-read", () => {
  const root = tmpdir();
  const file = piLogPath(root, "feature");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Blank lines can land in pi's JSONL log (a torn write whose newline arrives separately,
  // or a manual edit). The backward scan walks lines with its own arithmetic and has a
  // dedicated skip for them — pin that it skips them exactly like the full re-read does:
  // not counted as entry candidates, at every window size, including where one sits right
  // before the stop boundary (limit 1/2) and at file start (leading blank).
  const lines: string[] = [
    "", // leading blank
    agentStart(),
    userLine("prompt 1", FIXED_TS + 60_000),
    assistantBlocks([{ type: "text", text: "turn 1" }]),
    "",
    "", // consecutive blanks between runs
    agentStart(),
    userLine("prompt 2", FIXED_TS + 2 * 60_000),
    assistantBlocks([{ type: "text", text: "turn 2" }]),
    "",
    agentStart(),
    userLine("prompt 3", FIXED_TS + 3 * 60_000),
    assistantBlocks([{ type: "text", text: "turn 3" }]),
    "", // trailing blank line (the file still ends with a newline)
  ];
  fs.writeFileSync(file, lines.join("\n") + "\n");

  const size = fs.statSync(file).size;
  const full = formatTranscript(readCompleteLines(file, 0, size).lines);
  assert.equal(full.length, 3, "sanity: three rendered runs");
  for (const limit of [1, 2, 50]) {
    const tail = readTranscriptTail(file, limit);
    assert.ok(tail, `limit ${limit}`);
    assert.deepEqual(tail.entries, full.slice(-limit), `limit ${limit} entries`);
    assert.equal(tail.end, readCompleteLines(file, 0, size).end, `limit ${limit} end offset`);
  }
});

test("readTranscriptTail handles torn tails and newline-less files", () => {
  const root = tmpdir();
  const file = piLogPath(root, "feature");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const completeLines = [agentStart(), userLine("p"), assistantBlocks([{ type: "text", text: "turn" }])];
  const complete = completeLines.join("\n") + "\n";
  fs.writeFileSync(file, complete);

  // A torn trailing line (no newline yet) is excluded from entries; end stops before it.
  fs.appendFileSync(file, agentStart());
  let tail = readTranscriptTail(file, 50);
  assert.ok(tail);
  assert.equal(tail.end, complete.length); // just past the last newline
  assert.deepEqual(tail.entries, formatTranscript(completeLines));

  // A file with no newline at all: nothing is complete yet.
  const root2 = tmpdir();
  const file2 = piLogPath(root2, "feature");
  fs.mkdirSync(path.dirname(file2), { recursive: true });
  fs.writeFileSync(file2, agentStart()); // no trailing newline
  assert.deepEqual(readTranscriptTail(file2, 50), { entries: [], end: 0 });
});

test("readTranscriptTail returns null for missing or empty logs", () => {
  const root = tmpdir();
  assert.equal(readTranscriptTail(piLogPath(root, "feature"), 50), null);
  const file = piLogPath(root, "feature");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "");
  assert.equal(readTranscriptTail(file, 50), null);
});

// Run labels: a labeled run's marker line sits just before its agent_start, so the backward
// scan arms on a qualifying agent_start and keeps walking older lines for at most one more run:
// a marker becomes the boundary (the window carries the label), while an older agent_start or
// EOF means the run was unlabeled and the window stops at the arming agent_start exactly as
// before. The oracle is always a full re-read — tail ≡ formatTranscript(whole file).slice(-limit).

test("readTranscriptTail includes a marker line when it labels the boundary run", () => {
  const root = tmpdir();
  const file = piLogPath(root, "feature");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Every run is labeled; with limit 1 the walk arms on the newest agent_start and must keep
  // walking to its marker — the window starts at M even though A is what armed the stop.
  const lines: string[] = [];
  for (let i = 1; i <= 5; i++) {
    lines.push(reviewMarker());
    lines.push(agentStart());
    lines.push(userLine(`prompt ${i}`, FIXED_TS + i * 60_000));
    lines.push(assistantBlocks([{ type: "text", text: `turn ${i}` }]));
  }
  fs.writeFileSync(file, lines.join("\n") + "\n");

  const size = fs.statSync(file).size;
  const full = formatTranscript(readCompleteLines(file, 0, size).lines);
  for (const limit of [1, 2, 50]) {
    assert.deepEqual(readTranscriptTail(file, limit)?.entries, full.slice(-limit), `limit ${limit}`);
  }
  const tail = readTranscriptTail(file, 1);
  assert.ok(tail);
  assert.equal(
    tail.entries[0]?.[0],
    `── review @ ${expectedTimestamp(FIXED_TS + 5 * 60_000)} ──`,
    "the boundary run's separator carries its label",
  );
});

test("readTranscriptTail matches a full re-read with interleaved labels at every limit", () => {
  // Alternating author/review runs — the real shape of a role's shared log. As the window
  // slides, boundaries land on markers and agent_starts alike; the oracle must hold throughout.
  const root = tmpdir();
  const file = piLogPath(root, "feature");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines: string[] = [];
  for (let i = 1; i <= 40; i++) {
    if (i % 2 === 0) lines.push(reviewMarker());
    lines.push(agentStart());
    lines.push(userLine(`prompt ${i}`, FIXED_TS + i * 60_000));
    lines.push(assistantBlocks([{ type: "text", text: `turn ${i}` }]));
  }
  fs.writeFileSync(file, lines.join("\n") + "\n");

  const size = fs.statSync(file).size;
  const full = formatTranscript(readCompleteLines(file, 0, size).lines);
  for (const limit of [1, 2, 3, 7, 50]) {
    assert.deepEqual(readTranscriptTail(file, limit)?.entries, full.slice(-limit), `limit ${limit}`);
  }
});

test("readTranscriptTail matches a full re-read with a stale marker, mislabel included", () => {
  // A failed reviewer spawn leaves a marker whose own agent_start never came: the next run's
  // separator picks it up. The invariant is tail ≡ full re-read — not "labels are always correct".
  const root = tmpdir();
  const file = piLogPath(root, "feature");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines: string[] = [];
  for (let i = 1; i <= 5; i++) {
    if (i === 3) lines.push(reviewMarker()); // stale — its reviewer died before emitting anything
    lines.push(agentStart());
    lines.push(userLine(`prompt ${i}`, FIXED_TS + i * 60_000));
    lines.push(assistantBlocks([{ type: "text", text: `turn ${i}` }]));
  }
  fs.writeFileSync(file, lines.join("\n") + "\n");

  const size = fs.statSync(file).size;
  const full = formatTranscript(readCompleteLines(file, 0, size).lines);
  assert.ok(
    full.flat().includes(`── review @ ${expectedTimestamp(FIXED_TS + 3 * 60_000)} ──`),
    "sanity: the stale marker mislabels run 3 in a full re-read",
  );
  for (const limit of [1, 2, 50]) {
    assert.deepEqual(readTranscriptTail(file, limit)?.entries, full.slice(-limit), `limit ${limit}`);
  }
});

test("readTranscriptTail excludes a labeled run older than the window boundary", () => {
  // Only the OLDEST run is labeled: for small limits its marker sits outside [boundary..EOF]
  // and contributes nothing, while the whole-file window still carries its label.
  const root = tmpdir();
  const file = piLogPath(root, "feature");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines: string[] = [];
  for (let i = 1; i <= 6; i++) {
    if (i === 1) lines.push(reviewMarker());
    lines.push(agentStart());
    lines.push(userLine(`prompt ${i}`, FIXED_TS + i * 60_000));
    lines.push(assistantBlocks([{ type: "text", text: `turn ${i}` }]));
  }
  fs.writeFileSync(file, lines.join("\n") + "\n");

  const size = fs.statSync(file).size;
  const full = formatTranscript(readCompleteLines(file, 0, size).lines);
  for (const limit of [1, 2, 50]) {
    assert.deepEqual(readTranscriptTail(file, limit)?.entries, full.slice(-limit), `limit ${limit}`);
  }
  const one = readTranscriptTail(file, 1);
  assert.ok(one);
  assert.ok(!one.entries.flat().some((l) => l.includes("review")), "the older labeled run contributes nothing");
  const all = readTranscriptTail(file, 50);
  assert.ok(all);
  assert.ok(
    all.entries.flat().includes(`── review @ ${expectedTimestamp(FIXED_TS + 60_000)} ──`),
    "the whole-file window still carries the label",
  );
});
