import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { readTranscriptTail } from "../src/ui/transcript-tail.js";
// Oracle: the tail reader must match a full re-read rendered by transcript.ts.
import { formatTranscript, type TranscriptEntry } from "../src/ui/transcript.js";
import { piLogPath } from "../src/paths.js";
import { readCompleteLines } from "../src/files/tail.js";
import { expectedTimestamp } from "./helpers/oracles.js";
import { writeLogLines, writeTurnLog } from "./log-fixtures.js";
import { ensureParentDir } from "../src/files/files.js";
import { tmpdir } from "./repo-fixtures.js";
import { recreateSmallerOnOpen, vanishOnOpen } from "./helpers/fs-faults.js";
import { FIXED_TS, agentStart, assistantBlocks, kindMarker, runMarker, userLine } from "./pi-events.js";

/** The oracle a tail read must match: the whole log read from a fresh stat and rendered exactly
 * as transcript.ts renders it. `entries` is the full re-read; `size` is that stat, for tests
 * that also pin the window's end offset. */
function fullRead(
  file: string,
  opts?: { includePrompts?: boolean },
): { entries: TranscriptEntry[]; size: number } {
  const size = fs.statSync(file).size;
  return { entries: formatTranscript(readCompleteLines(file, 0, size).lines, opts), size };
}

/** The full-re-read oracle the cases below share: at each `limit`, the tail read returns
 * exactly the last `limit` entries of `full` (fullRead's whole-log render). `opts.includePrompts`
 * mirrors the read's own option; `opts.size` (fullRead's stat) additionally pins each window's end
 * offset to the full read's last complete newline. */
function assertTailMatchesFullRead(
  file: string,
  limits: readonly number[],
  full: TranscriptEntry[],
  opts: { includePrompts?: boolean; size?: number } = {},
): void {
  for (const limit of limits) {
    const tail = readTranscriptTail(file, limit, { includePrompts: opts.includePrompts });
    assert.deepEqual(tail?.entries, full.slice(-limit), `limit ${limit}`);
    if (opts.size !== undefined) {
      assert.equal(tail?.end, readCompleteLines(file, 0, opts.size).end, `limit ${limit} end offset`);
    }
  }
}

test("readTranscriptTail matches a full re-read on a small log", () => {
  const { file } = writeTurnLog(3);

  const { entries: full, size } = fullRead(file);
  assertTailMatchesFullRead(file, [1, 2, 50], full, { size });
});

test("readTranscriptTail honors limit=0: slice(-0) must not widen the window", () => {
  const { file } = writeTurnLog(3);

  // A zero-sized window is the empty list — not slice(-0)'s whole window (the arming scan
  // already bounds a limit-0 walk to the newest run, so the breach shows as that run's
  // entries, and the same contract readTranscript's take guard pins covers both surfaces).
  const tail = readTranscriptTail(file, 0);
  assert.ok(tail);
  assert.deepEqual(tail.entries, []);
  // The follow start is unchanged: just past the last complete newline, so a followFile
  // seeded from a limit-0 window re-delivers nothing old.
  assert.equal(tail.end, readCompleteLines(file, 0, fs.statSync(file).size).end);
  // A negative limit is the same nonsense input — empty, not slice(negative)'s head cut.
  assert.deepEqual(readTranscriptTail(file, -2)?.entries, []);
});

test("readTranscriptTail matches a full re-read with prompts included, newest entry a prompt", () => {
  const { file } = writeTurnLog(6, { reviewMarkerAt: (i) => i % 2 === 0 });
  // The newest run has its prompt but no assistant turn yet: with prompts included the newest
  // entry IS the prompt (separator + its lines).
  fs.appendFileSync(
    file,
    [agentStart(), userLine("newest prompt\nwith two lines", FIXED_TS + 7 * 60_000)].join("\n") + "\n",
  );

  const { entries: full } = fullRead(file, { includePrompts: true });
  assertTailMatchesFullRead(file, [1, 2, 3, 50], full, { includePrompts: true });
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
  writeLogLines(file, lines);
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

  const { entries: full } = fullRead(file); // after the mock is gone
  assert.ok(tail);
  assert.deepEqual(tail.entries, full.slice(-50));
  assert.equal(tail.end, readCompleteLines(file, 0, size).end);
  assert.ok(bytesRead < size / 2, `expected a bounded read (got ${bytesRead} of ${size})`);

  // With prompts opted in, user message_end lines become entry candidates too; the backward
  // scan must stay exact across the multi-chunk log.
  const { entries: fullWithPrompts } = fullRead(file, { includePrompts: true });
  assert.deepEqual(readTranscriptTail(file, 3, { includePrompts: true })?.entries, fullWithPrompts.slice(-3));
});

test("readTranscriptTail re-reads fully when contentless turns undercount candidates", () => {
  const root = tmpdir();
  const file = piLogPath(root, "feature");
  // Each run's second assistant turn is contentless: a candidate line that renders nothing,
  // so the backward scan's stop boundary under-delivers and must fall back to a full read.
  const lines: string[] = [];
  for (let i = 1; i <= 40; i++) {
    lines.push(agentStart());
    lines.push(userLine(`prompt ${i}`, FIXED_TS + i * 60_000));
    lines.push(assistantBlocks([{ type: "text", text: `turn ${i}` }]));
    lines.push(assistantBlocks([]));
  }
  writeLogLines(file, lines);

  const { entries: full } = fullRead(file);
  assertTailMatchesFullRead(file, [1, 2, 50], full);
});

test("readTranscriptTail skips blank lines exactly like a full re-read", () => {
  const root = tmpdir();
  const file = piLogPath(root, "feature");
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
  writeLogLines(file, lines);

  const { entries: full, size } = fullRead(file);
  assert.equal(full.length, 3, "sanity: three rendered runs");
  assertTailMatchesFullRead(file, [1, 2, 50], full, { size });
});

test("readTranscriptTail handles torn tails and newline-less files", () => {
  const root = tmpdir();
  const file = piLogPath(root, "feature");
  ensureParentDir(file);
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
  ensureParentDir(file2);
  fs.writeFileSync(file2, agentStart()); // no trailing newline
  assert.deepEqual(readTranscriptTail(file2, 50), { entries: [], end: 0 });
});

test("readTranscriptTail returns null for missing or empty logs", () => {
  const root = tmpdir();
  assert.equal(readTranscriptTail(piLogPath(root, "feature"), 50), null);
  const file = piLogPath(root, "feature");
  ensureParentDir(file);
  fs.writeFileSync(file, "");
  assert.equal(readTranscriptTail(file, 50), null);
});

test("readTranscriptTail returns null when rotation removes the file between stat and open", () => {
  const root = tmpdir();
  const file = piLogPath(root, "feature");
  writeLogLines(file, [agentStart(), assistantBlocks([{ type: "text", text: "hi" }])]);
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
  // Old content: three labeled runs — larger than the new file below.
  const oldLines: string[] = [];
  for (let i = 1; i <= 3; i++) {
    oldLines.push(JSON.stringify({ type: "tumwater_run", label: `old ${i}` }));
    oldLines.push(agentStart());
    oldLines.push(userLine(`prompt ${i}`, FIXED_TS + i * 60_000));
    oldLines.push(assistantBlocks([{ type: "text", text: `turn ${i}` }]));
  }
  writeLogLines(file, oldLines);
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
  // Non-empty old content so the pre-open stat reports a size worth scanning.
  writeLogLines(file, [agentStart(), userLine("prompt", FIXED_TS), assistantBlocks([{ type: "text", text: "hi" }])]);
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
  // Every run is labeled; with limit 1 the walk arms on the newest agent_start and must keep
  // walking to its marker — the window starts at M even though A is what armed the stop.
  const { file } = writeTurnLog(5, { reviewMarkerAt: () => true });

  const { entries: full } = fullRead(file);
  assertTailMatchesFullRead(file, [1, 2, 50], full);
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
  const { file } = writeTurnLog(40, { reviewMarkerAt: (i) => i % 2 === 0 });

  const { entries: full } = fullRead(file);
  assertTailMatchesFullRead(file, [1, 2, 3, 7, 50], full);
});

test("readTranscriptTail matches a full re-read with a stale marker, mislabel included", () => {
  // A failed reviewer spawn leaves a marker whose own agent_start never came: the next run's
  // separator picks it up. The invariant is tail ≡ full re-read — not "labels are always correct".
  // Run 3's marker is stale — its reviewer died before emitting anything.
  const { file } = writeTurnLog(5, { reviewMarkerAt: (i) => i === 3 });

  const { entries: full } = fullRead(file);
  assert.ok(
    full.flat().includes(`── review @ ${expectedTimestamp(FIXED_TS + 3 * 60_000)} ──`),
    "sanity: the stale marker mislabels run 3 in a full re-read",
  );
  assertTailMatchesFullRead(file, [1, 2, 50], full);
});

test("readTranscriptTail excludes a labeled run older than the window boundary", () => {
  // Only the OLDEST run is labeled: for small limits its marker sits outside [boundary..EOF]
  // and contributes nothing, while the whole-file window still carries its label.
  const { file } = writeTurnLog(6, { reviewMarkerAt: (i) => i === 1 });

  const { entries: full } = fullRead(file);
  assertTailMatchesFullRead(file, [1, 2, 50], full);
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
  const lines: string[] = [];
  for (let i = 1; i <= 3; i++) lines.push(assistantBlocks([{ type: "text", text: `orphan ${i}` }])); // rotated tail
  lines.push(agentStart()); // unlabeled run — no marker line precedes it
  lines.push(userLine("prompt", FIXED_TS + 60_000));
  for (let i = 1; i <= 10; i++) lines.push(assistantBlocks([{ type: "text", text: `turn ${i}` }]));
  writeLogLines(file, lines);

  const { entries: full, size } = fullRead(file);
  // Limits that arm (≤ the run's own candidate count), limits that don't (≥ total entries), and
  // the whole-file window — the oracle must hold across all of them.
  assertTailMatchesFullRead(file, [1, 2, 5, 8, 13, 50], full);
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

test("readTranscriptTail skips kind-only markers to the label a full re-read applies", () => {
  // The stale-label shape part 1/5's every-run marker creates: a failed reviewer spawn's
  // labeled marker, then an author run's own kind-only marker before the same agent_start.
  // The scan must not stop at the kind-only marker (which sets no label) — a full re-read
  // lets it pass and applies the stale label to the author run's separator, so the tail must
  // too. This is the regression a stop-at-any-marker scan would show.
  const root = tmpdir();
  const file = piLogPath(root, "feature");
  const lines = [
    kindMarker("author"),
    agentStart(),
    userLine("prompt 1", FIXED_TS + 60_000),
    assistantBlocks([{ type: "text", text: "turn 1" }]),
    runMarker("review"), // stale: its reviewer died before any agent_start
    kindMarker("author"),
    agentStart(),
    userLine("prompt 2", FIXED_TS + 2 * 60_000),
    assistantBlocks([{ type: "text", text: "turn 2" }]),
  ];
  writeLogLines(file, lines);

  const { entries: full } = fullRead(file);
  assert.ok(
    full.flat().includes(`── review @ ${expectedTimestamp(FIXED_TS + 2 * 60_000)} ──`),
    "sanity: the stale label applies to run 2 in a full re-read",
  );
  assertTailMatchesFullRead(file, [1, 2, 50], full);
});

test("readTranscriptTail matches a full re-read when every run carries a kind-only marker", () => {
  const root = tmpdir();
  const file = piLogPath(root, "feature");
  const lines: string[] = [];
  for (let i = 1; i <= 20; i++) {
    const gate = i % 2 === 0;
    lines.push(kindMarker(gate ? "gate" : "author", gate ? "review" : undefined));
    lines.push(agentStart());
    lines.push(userLine(`prompt ${i}`, FIXED_TS + i * 60_000));
    lines.push(assistantBlocks([{ type: "text", text: `turn ${i}` }]));
  }
  writeLogLines(file, lines);

  const { entries: full } = fullRead(file);
  assertTailMatchesFullRead(file, [1, 2, 3, 7, 50], full);
});
