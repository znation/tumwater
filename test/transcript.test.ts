import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createTranscriptRenderer, formatTranscript, readTranscript } from "../src/transcript.js";
import { readTranscriptTail } from "../src/transcript-tail.js";
import { piLogPath } from "../src/paths.js";
import { readCompleteLines } from "../src/tail.js";
import { tmpdir } from "./util.js";

const TS = 1787222691956; // a fixed epoch-ms timestamp for deterministic separators

function agentStart(): string {
  return JSON.stringify({ type: "agent_start" });
}

function userLine(text: string, timestamp: number = TS): string {
  return JSON.stringify({
    type: "message_end",
    message: { role: "user", content: [{ type: "text", text }], timestamp },
  });
}

function assistantLine(content: unknown[]): string {
  return JSON.stringify({ type: "message_end", message: { role: "assistant", content, stopReason: "stop" } });
}

/** Local wall-clock rendering of an epoch-ms timestamp (independent of the implementation). */
function expectedTimestamp(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

test("formatTranscript renders a run separator and an assistant turn", () => {
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: "x" }), // skipped: only agent_start separates runs
    agentStart(),
    userLine("You are the feature loop of tumwater. (multi-KB tick prompt)"),
    assistantLine([
      { type: "thinking", thinking: "Let me start by reading the project files to understand what is here." },
      { type: "text", text: "Reading the key files first." },
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "/repo/PLANS.md" } },
    ]),
  ];
  const entries = formatTranscript(lines);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], [
    `── run @ ${expectedTimestamp(TS)} ──`,
    "· Let me start by reading the project files to understand what is here.",
    "  Reading the key files first.",
    "→ read PLANS.md",
  ]);
});

test("formatTranscript skips deltas, bookkeeping events, and user content", () => {
  const prompt = "TICK PROMPT ".repeat(50); // must never appear in output
  const lines = [
    agentStart(),
    JSON.stringify({ type: "turn_start" }),
    JSON.stringify({ type: "message_start", message: { role: "user" } }),
    userLine(prompt),
    JSON.stringify({ type: "message_update", delta: { type: "text_delta", textDelta: prompt } }),
    JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: "x.md" } }),
    assistantLine([{ type: "text", text: "done" }]),
    JSON.stringify({ type: "tool_execution_end", toolCallId: "c1" }),
    JSON.stringify({ type: "turn_end" }),
    JSON.stringify({ type: "agent_end" }),
  ];
  const out = formatTranscript(lines).flat();
  assert.ok(!out.some((l) => l.includes("TICK PROMPT")));
  assert.deepEqual(out, [`── run @ ${expectedTimestamp(TS)} ──`, "  done"]);
});

test("formatTranscript skips torn and non-JSON lines without failing", () => {
  const out = formatTranscript([
    "",
    "not json at all",
    '{"type":"agent_start"', // torn write
    agentStart(),
    userLine("p"),
    assistantLine([{ type: "text", text: "ok" }]),
  ]);
  assert.deepEqual(out.flat(), [`── run @ ${expectedTimestamp(TS)} ──`, "  ok"]);
});

test("formatTranscript abbreviates long thinking and caps text at four lines", () => {
  const lines = [
    agentStart(),
    userLine("p"),
    assistantLine([
      { type: "thinking", thinking: "x".repeat(200) },
      { type: "text", text: ["l1", "l2", "", "l3", "y".repeat(300), "l5"].join("\n") },
    ]),
  ];
  const out = formatTranscript(lines).flat();
  assert.ok(out[0]?.startsWith("── run @ "));
  assert.equal(out[1], `· ${"x".repeat(79)}…`); // ~80 chars, ellipsis when cut
  assert.deepEqual(out.slice(2), ["  l1", "  l2", "  l3", `  ${"y".repeat(119)}…`, "  …"]);
});

test("formatTranscript surfaces auto_retry_start as a warning line", () => {
  const lines = [
    agentStart(),
    userLine("p"),
    JSON.stringify({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "Request timed out." }),
    assistantLine([{ type: "text", text: "recovered" }]),
  ];
  const entries = formatTranscript(lines);
  assert.deepEqual(entries[0], [`── run @ ${expectedTimestamp(TS)} ──`, "⚠ retry 1/3: Request timed out."]);
  assert.deepEqual(entries[1], ["  recovered"]);
});

test("formatTranscript renders an unstamped separator when no user message precedes the turn", () => {
  const out = formatTranscript([agentStart(), assistantLine([{ type: "text", text: "hi" }])]).flat();
  assert.deepEqual(out, ["── run ──", "  hi"]);
});

test("formatTranscript emits a separator for a trailing run with no turns yet", () => {
  const out = formatTranscript([agentStart(), userLine("p")]).flat();
  assert.deepEqual(out, [`── run @ ${expectedTimestamp(TS)} ──`]);
});

test("createTranscriptRenderer emits each entry exactly once as lines arrive", () => {
  const r = createTranscriptRenderer();
  assert.deepEqual(r.feed(agentStart()), []); // separator waits for the user message's timestamp
  assert.deepEqual(r.feed(userLine("p")), []); // user content is never rendered
  assert.deepEqual(r.feed(assistantLine([{ type: "text", text: "one" }])), [
    `── run @ ${expectedTimestamp(TS)} ──`,
    "  one",
  ]);
  assert.deepEqual(r.feed(assistantLine([{ type: "text", text: "two" }])), ["  two"]); // no duplicate separator
  assert.deepEqual(r.flush(), []);
});

test("createTranscriptRenderer treats delta noise as pure noise (feed fast-path contract)", () => {
  // The renderer's feed() skips JSON.parse for pi lines whose compact `type`-first shape
  // verifiably carries a non-renderable type, which is only safe because such lines can never
  // affect output or state. Pin that invariant: a stream with heavy message_update padding
  // must render exactly like the same stream without it — so a future switch case that
  // consumes a fast-path-skipped line (e.g. deltas) fails here and forces its type into
  // RENDERABLE_TYPES.
  const delta = JSON.stringify({ type: "message_update", delta: { type: "text_delta", textDelta: "x".repeat(200) } });
  const noise = [agentStart(), delta, userLine("p"), delta, assistantLine([{ type: "text", text: "done" }]), delta];
  const clean = [agentStart(), userLine("p"), assistantLine([{ type: "text", text: "done" }])];

  const rNoisy = createTranscriptRenderer();
  const noisyOut: string[][] = [];
  for (const line of noise) {
    const out = rNoisy.feed(line);
    if (out.length > 0) noisyOut.push(out);
  }
  const tail = rNoisy.flush();
  if (tail.length > 0) noisyOut.push(tail);

  assert.deepEqual(noisyOut, formatTranscript(clean));
});

test("createTranscriptRenderer still parses non-compact JSON shapes (fast-path fallback)", () => {
  // The fast path only skips lines matching pi's exact compact `type`-first prefix; anything
  // else — reordered keys, whitespace after the colon, foreign or torn JSON — must fall back
  // to a full parse and render exactly as before. Pin that safe-degradation contract so a
  // future change cannot silently drop events whose serialization differs from pi's.
  const r = createTranscriptRenderer();
  assert.deepEqual(r.feed('{"message":{"role":"user"},"type":"agent_start"}'), []); // reordered keys open the run
  assert.deepEqual(
    r.feed('{ "type": "message_end", "message": { "role": "user", "timestamp": ' + TS + ', "content": [] } }'),
    [], // spaced JSON user message stamps the separator (fast path falls back to parse)
  );
  assert.deepEqual(
    r.feed('{ "type": "message_end", "message": { "role": "assistant", "content": [{ "type": "text", "text": "hi" }] } }'),
    [`── run @ ${expectedTimestamp(TS)} ──`, "  hi"], // spaced JSON still renders
  );
});

test("readTranscript returns the last N entries oldest-first and [] without a log", () => {
  const root = tmpdir();
  assert.deepEqual(readTranscript(root, "feature"), []);
  const file = piLogPath(root, "feature");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines: string[] = [];
  for (let i = 1; i <= 3; i++) {
    lines.push(agentStart());
    lines.push(userLine(`prompt ${i}`, TS + i * 60_000));
    lines.push(assistantLine([{ type: "text", text: `turn ${i}` }]));
  }
  fs.writeFileSync(file, lines.join("\n") + "\n");

  const all = readTranscript(root, "feature");
  assert.equal(all.filter((l) => l.startsWith("── run")).length, 3);
  assert.ok(all.includes("  turn 1")); // oldest first within the window

  const two = readTranscript(root, "feature", 2);
  assert.deepEqual(two, [
    `── run @ ${expectedTimestamp(TS + 2 * 60_000)} ──`,
    "  turn 2",
    `── run @ ${expectedTimestamp(TS + 3 * 60_000)} ──`,
    "  turn 3",
  ]);
});

test("readTranscript polls incrementally: appends only, live separator, no duplicates", () => {
  const root = tmpdir();
  const file = piLogPath(root, "feature");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    [agentStart(), userLine("prompt 1"), assistantLine([{ type: "text", text: "turn 1" }])].join("\n") + "\n",
  );

  // First poll seeds the whole file.
  assert.deepEqual(readTranscript(root, "feature", 50), [
    `── run @ ${expectedTimestamp(TS)} ──`,
    "  turn 1",
  ]);

  // A just-started run shows its (stamped) separator before any of its turns land.
  fs.appendFileSync(file, [agentStart(), userLine("prompt 2", TS + 60_000)].join("\n") + "\n");
  assert.deepEqual(readTranscript(root, "feature", 50), [
    `── run @ ${expectedTimestamp(TS)} ──`,
    "  turn 1",
    `── run @ ${expectedTimestamp(TS + 60_000)} ──`,
  ]);

  // The separator merges into the first turn's entry when it lands — no duplicate line.
  fs.appendFileSync(file, assistantLine([{ type: "text", text: "turn 2" }]) + "\n");
  assert.deepEqual(readTranscript(root, "feature", 50), [
    `── run @ ${expectedTimestamp(TS)} ──`,
    "  turn 1",
    `── run @ ${expectedTimestamp(TS + 60_000)} ──`,
    "  turn 2",
  ]);

  // A torn trailing line (no newline yet) is held back until it completes.
  fs.appendFileSync(file, agentStart());
  assert.deepEqual(readTranscript(root, "feature", 50), [
    `── run @ ${expectedTimestamp(TS)} ──`,
    "  turn 1",
    `── run @ ${expectedTimestamp(TS + 60_000)} ──`,
    "  turn 2",
  ]);
  fs.appendFileSync(file, "\n");
  assert.ok(readTranscript(root, "feature", 50).includes("── run ──")); // unstamped: no user message yet
});

test("readTranscript reseeds when rotation replaces the file", () => {
  const root = tmpdir();
  const file = piLogPath(root, "feature");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    [agentStart(), userLine("p"), assistantLine([{ type: "text", text: "old turn" }])].join("\n") + "\n",
  );
  assert.ok(readTranscript(root, "feature").includes("  old turn"));

  // Rotation renames the big log aside and pi starts a fresh file at the same path.
  fs.renameSync(file, file + ".1");
  fs.writeFileSync(
    file,
    [agentStart(), userLine("p2", TS + 60_000), assistantLine([{ type: "text", text: "new turn" }])].join("\n") + "\n",
  );
  const out = readTranscript(root, "feature");
  assert.ok(out.includes("  new turn"));
  assert.ok(!out.some((l) => l.includes("old turn")));
});

test("readTranscript keeps only the newest entries past the retention cap", () => {
  const root = tmpdir();
  const file = piLogPath(root, "feature");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines: string[] = [];
  for (let i = 1; i <= 250; i++) {
    lines.push(agentStart());
    lines.push(userLine(`prompt ${i}`, TS + i * 60_000));
    lines.push(assistantLine([{ type: "text", text: `turn ${i}` }]));
  }
  fs.writeFileSync(file, lines.join("\n") + "\n");

  // 250 runs exceed the 200-entry retention cap; a request for 50 is still exact.
  const out = readTranscript(root, "feature", 50);
  assert.equal(out.filter((l) => l.startsWith("── run")).length, 50);
  assert.ok(out.includes(`── run @ ${expectedTimestamp(TS + 250 * 60_000)} ──`)); // newest
  assert.ok(out.includes("  turn 201")); // oldest visible: runs 201..250
  assert.ok(!out.includes("  turn 200")); // evicted past the cap
});

test("readTranscriptTail matches a full re-read on a small log", () => {
  const root = tmpdir();
  const file = piLogPath(root, "feature");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines: string[] = [];
  for (let i = 1; i <= 3; i++) {
    lines.push(agentStart());
    lines.push(userLine(`prompt ${i}`, TS + i * 60_000));
    lines.push(assistantLine([{ type: "text", text: `turn ${i}` }]));
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
    lines.push(userLine(`prompt ${i} ` + "x".repeat(200), TS + i * 60_000));
    lines.push(JSON.stringify({ type: "message_update", delta: { type: "text_delta", textDelta: "y".repeat(10000) } }));
    lines.push(
      assistantLine([
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
    lines.push(userLine(`prompt ${i}`, TS + i * 60_000));
    lines.push(assistantLine([{ type: "text", text: `turn ${i}` }]));
    lines.push(assistantLine([]));
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
    userLine("prompt 1", TS + 60_000),
    assistantLine([{ type: "text", text: "turn 1" }]),
    "",
    "", // consecutive blanks between runs
    agentStart(),
    userLine("prompt 2", TS + 2 * 60_000),
    assistantLine([{ type: "text", text: "turn 2" }]),
    "",
    agentStart(),
    userLine("prompt 3", TS + 3 * 60_000),
    assistantLine([{ type: "text", text: "turn 3" }]),
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
  const completeLines = [agentStart(), userLine("p"), assistantLine([{ type: "text", text: "turn" }])];
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
