import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readTranscriptTail } from "../src/ui/transcript-tail.js";
// Oracle: the tail reader must match a full re-read rendered by transcript.ts.
import { formatTranscript } from "../src/ui/transcript.js";
import { piLogPath } from "../src/paths.js";
import { readCompleteLines } from "../src/ui/tail.js";
import {
  FIXED_TS,
  agentStart,
  assistantBlocks,
  expectedTimestamp,
  recreateSmallerOnOpen,
  tmpdir,
  userLine,
  vanishOnOpen,
} from "./util.js";

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

test("readTranscriptTail matches a full re-read with prompts included, newest entry a prompt", () => {
  const root = tmpdir();
  const file = piLogPath(root, "feature");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines: string[] = [];
  for (let i = 1; i <= 6; i++) {
    if (i % 2 === 0) lines.push(reviewMarker());
    lines.push(agentStart());
    lines.push(userLine(`prompt ${i}`, FIXED_TS + i * 60_000));
    lines.push(assistantBlocks([{ type: "text", text: `turn ${i}` }]));
  }
  // The newest run has its prompt but no assistant turn yet: with prompts included the newest
  // entry IS the prompt (separator + its lines).
  lines.push(agentStart());
  lines.push(userLine("newest prompt\nwith two lines", FIXED_TS + 7 * 60_000));
  fs.writeFileSync(file, lines.join("\n") + "\n");

  const size = fs.statSync(file).size;
  const full = formatTranscript(readCompleteLines(file, 0, size).lines, { includePrompts: true });
  for (const limit of [1, 2, 3, 50]) {
    assert.deepEqual(
      readTranscriptTail(file, limit, { includePrompts: true })?.entries,
      full.slice(-limit),
      `limit ${limit}`,
    );
  }
  const newest = readTranscriptTail(file, 1, { includePrompts: true });
  assert.deepEqual(newest?.entries[0], [
    `── run @ ${expectedTimestamp(FIXED_TS + 7 * 60_000)} ──`,
    "newest prompt",
    "with two lines",
  ]);
  // The default path still suppresses prompts (no opts).
  assert.ok(
    !readTranscriptTail(file, 50)?.entries.flat().some((l) => l.includes("newest prompt")),
    "prompts stay out without includePrompts",
  );
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

  // With prompts opted in, user message_end lines become entry candidates too; the backward
  // scan must stay exact across the multi-chunk log.
  const fullWithPrompts = formatTranscript(readCompleteLines(file, 0, size).lines, { includePrompts: true });
  assert.deepEqual(readTranscriptTail(file, 3, { includePrompts: true })?.entries, fullWithPrompts.slice(-3));
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

test("readTranscriptTail returns null when rotation removes the file between stat and open", () => {
  const root = tmpdir();
  const file = piLogPath(root, "feature");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, agentStart() + "\n" + assistantBlocks([{ type: "text", text: "hi" }]) + "\n");
  const restore = vanishOnOpen(file);
  try {
    assert.equal(readTranscriptTail(file, 50), null); // no throw — same as a missing log
  } finally {
    restore();
  }
});

// Run labels: a labeled run's marker line sits just before its agent_start, so the backward
// scan arms on a qualifying agent_start and keeps walking older lines for at most one more run:
// a marker becomes the boundary (the window carries the label), while an older agent_start or
// EOF means the run was unlabeled and the window stops at the arming agent_start exactly as
// before. The oracle is always a full re-read — tail ≡ formatTranscript(whole file).slice(-limit).

test("readTranscriptTail scans the opened inode when rotation recreates the path smaller between stat and open", () => {
  const root = tmpdir();
  const file = piLogPath(root, "feature");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Old content: three labeled runs — larger than the new file below.
  const oldLines: string[] = [];
  for (let i = 1; i <= 3; i++) {
    oldLines.push(JSON.stringify({ type: "tumwater_run", label: `old ${i}` }));
    oldLines.push(agentStart());
    oldLines.push(userLine(`prompt ${i}`, FIXED_TS + i * 60_000));
    oldLines.push(assistantBlocks([{ type: "text", text: `turn ${i}` }]));
  }
  fs.writeFileSync(file, oldLines.join("\n") + "\n");
  // New content at the same path after rotation: two labeled runs, smaller.
  const newLines: string[] = [];
  for (let i = 1; i <= 2; i++) {
    newLines.push(JSON.stringify({ type: "tumwater_run", label: `new ${i}` }));
    newLines.push(agentStart());
    newLines.push(userLine(`nprompt ${i}`, FIXED_TS + i * 60_000));
    newLines.push(assistantBlocks([{ type: "text", text: `nturn ${i}` }]));
  }
  const newContent = newLines.join("\n") + "\n";
  assert.ok(newContent.length < fs.statSync(file).size, "new content must be smaller");
  const restore = recreateSmallerOnOpen(file, newContent);
  try {
    const win = readTranscriptTail(file, 50);
    // The window is the tail of what was actually opened — no dropped lines (a stale stat
    // size held back and lost the oldest line), and `end` stays within the real file (stale
    // size arithmetic put it past EOF, where a followFile would re-deliver the whole window).
    assert.deepEqual(win?.entries, formatTranscript(newLines).slice(-50));
    assert.ok(win !== null && win.end <= fs.statSync(file).size);
  } finally {
    restore();
  }
});

test("readTranscriptTail returns null when rotation recreates the path as an empty file between stat and open", () => {
  const root = tmpdir();
  const file = piLogPath(root, "feature");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Non-empty old content so the pre-open stat reports a size worth scanning.
  fs.writeFileSync(
    file,
    agentStart() + "\n" + userLine("prompt", FIXED_TS) + "\n" + assistantBlocks([{ type: "text", text: "hi" }]) + "\n",
  );
  // Rotation renames the old log away and recreates the path before open lands — here as an
  // empty file (a fresh log with nothing appended yet): the opened inode is empty, so the
  // reader reports no data instead of scanning stale bytes off a size that no longer exists.
  const restore = recreateSmallerOnOpen(file, "");
  try {
    assert.equal(readTranscriptTail(file, 50), null); // same policy as a missing or empty log — no throw
  } finally {
    restore();
  }
});

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

test("readTranscriptTail stops at the arming agent_start when EOF precedes any marker", () => {
  // Rotation truncated a previous run mid-stream: the file's oldest lines are that run's
  // orphaned tail — assistant turns with no agent_start and no marker before them. The next
  // run is unlabeled (a resumed session writes no tumwater_run marker), so when the backward
  // scan arms on its agent_start it walks straight into EOF still arming: the window must stop
  // at that agent_start, dropping the orphan tail exactly as a full re-read's slice(-limit) does.
  const root = tmpdir();
  const file = piLogPath(root, "feature");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines: string[] = [];
  for (let i = 1; i <= 3; i++) lines.push(assistantBlocks([{ type: "text", text: `orphan ${i}` }])); // rotated tail
  lines.push(agentStart()); // unlabeled run — no marker line precedes it
  lines.push(userLine("prompt", FIXED_TS + 60_000));
  for (let i = 1; i <= 10; i++) lines.push(assistantBlocks([{ type: "text", text: `turn ${i}` }]));
  fs.writeFileSync(file, lines.join("\n") + "\n");

  const size = fs.statSync(file).size;
  const full = formatTranscript(readCompleteLines(file, 0, size).lines);
  // Limits that arm (≤ the run's own candidate count), limits that don't (≥ total entries), and
  // the whole-file window — the oracle must hold across all of them.
  for (const limit of [1, 2, 5, 8, 13, 50]) {
    assert.deepEqual(readTranscriptTail(file, limit)?.entries, full.slice(-limit), `limit ${limit}`);
  }
  const tail = readTranscriptTail(file, 5);
  assert.ok(tail);
  assert.equal(tail.end, size); // just past the last complete newline — a followFile start point
  assert.ok(!tail.entries.flat().some((l) => l.includes("orphan")), "the orphaned tail stays out of the window");
  const whole = readTranscriptTail(file, 10);
  assert.ok(whole);
  assert.equal(
    whole.entries[0]?.[0],
    `── run @ ${expectedTimestamp(FIXED_TS + 60_000)} ──`,
    "the unlabeled run's separator is stamped from its own user message",
  );
});
