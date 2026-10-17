import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  BASH_LIMIT_CHARS,
  READ_LIMIT_CHARS,
  boundBashResult,
  boundReadResult,
  boundText,
  default as boundedOutput,
  outputLimits,
} from "../src/pi-extension/bounded-output.js";
import { REFERENCE_WINDOW_TOKENS } from "../src/pi-extension/context-window.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

const cps = (text: string): number => Array.from(text).length;
const MARKER_RE = /\.\.\.(\d+) chars/;

// ---- boundText -------------------------------------------------------------

test("boundText returns text under the limit byte-identical", () => {
  const text = "a".repeat(READ_LIMIT_CHARS - 1);
  assert.equal(boundText(text, READ_LIMIT_CHARS), text);
  assert.equal(boundText("", READ_LIMIT_CHARS), "");
});

test("boundText over the limit returns head + marker + tail within the limit", () => {
  const text = "x".repeat(READ_LIMIT_CHARS + 5_000);
  const result = boundText(text, READ_LIMIT_CHARS);
  assert.ok(cps(result) <= READ_LIMIT_CHARS, `result is ${cps(result)} code points`);
  const match = MARKER_RE.exec(result);
  assert.ok(match, "marker states the omitted character count");
  const omitted = Number(match![1]);
  // Split the result into head / marker / tail around the single marker.
  const parts = result.split("...");
  assert.equal(parts.length, 3, "exactly head + marker + tail");
  const head = parts[0]!;
  const tail = parts[2]!;
  assert.ok(text.startsWith(head), "result keeps the original head");
  assert.ok(text.endsWith(tail), "result keeps the original tail");
  // head + tail + marker's omitted count reconstructs the original length.
  assert.equal(cps(head) + omitted + cps(tail), cps(text));
});

test("boundText marker names the full-output path when one is given", () => {
  const text = "y".repeat(READ_LIMIT_CHARS + 1_000);
  const result = boundText(text, READ_LIMIT_CHARS, "/tmp/full.log");
  assert.match(result, /complete output in \/tmp\/full\.log\.\.\./);
});

test("boundText never splits multi-byte UTF-8 mid-character", () => {
  // Emoji are 2 code units each — a naive code-unit cut would split one in half.
  const text = "😀".repeat(READ_LIMIT_CHARS);
  const result = boundText(text, READ_LIMIT_CHARS);
  assert.doesNotMatch(result, /\uFFFD/, "no replacement characters");
  const parts = result.split("...");
  assert.ok(!/[\uD800-\uDBFF]$/.test(parts[0]!), "head ends on a whole character");
  assert.ok(!/^[\uDC00-\uDFFF]/.test(parts[2]!), "tail starts on a whole character");
});

test("boundText keeps its limit when the full-output path alone swallows the budget", () => {
  // A path longer than the limit makes the marker bigger than the whole budget. Before the
  // clamp this drove headLen/tailLen negative, and negative slice bounds kept nearly the
  // ENTIRE text — the flood the extension exists to prevent.
  const text = "x".repeat(5_000);
  const result = boundText(text, 300, `/tmp/${"d".repeat(500)}/full.log`);
  assert.ok(cps(result) <= 300, `result is ${cps(result)} code points`);
  assert.match(result, /chars truncated/);
  assert.match(result, /complete output in \/tmp\//);
});

test("boundText with a tiny limit and no path still stays within the limit", () => {
  const result = boundText("y".repeat(1_000), 30);
  assert.ok(cps(result) <= 30, `result is ${cps(result)} code points`);
  assert.match(result, /1000 chars truncated/);
});

// ---- boundReadResult -------------------------------------------------------

const bigFileText = (lines: number): string =>
  Array.from({ length: lines }, (_, i) => `line ${i + 1}: ${"b".repeat(40)}`).join("\n") + "\n";

test("boundReadResult keeps whole lines and reports the omitted amount", () => {
  const text = bigFileText(600);
  const result = boundReadResult(text, { path: "src/big.ts" });
  assert.ok(cps(result) <= READ_LIMIT_CHARS);
  assert.match(result, /chars of this read were omitted/);
  assert.match(result, /re-read src\/big\.ts with offset\/limit/);
  // Kept lines are whole: the head ends at a newline and the tail begins at a line start.
  const markerIndex = result.indexOf("...");
  const head = result.slice(0, markerIndex);
  const afterMarker = result.indexOf("...", markerIndex + 3);
  const tail = result.slice(afterMarker + 3);
  assert.ok(head.endsWith("\n"), "head ends with a complete line");
  assert.ok(text.includes(tail), "tail is an exact suffix starting at a line boundary");
  // First and last lines survive.
  assert.ok(result.startsWith("line 1:"), "first line kept");
  assert.ok(result.trimEnd().endsWith(`line 600: ${"b".repeat(40)}`), "last line kept");
});

test("boundReadResult passes through ranged, short, and empty results", () => {
  const text = bigFileText(600);
  assert.equal(boundReadResult(text, { path: "f.ts", offset: 100 }), text, "offset set");
  assert.equal(boundReadResult(text, { path: "f.ts", limit: 50 }), text, "limit set");
  assert.equal(boundReadResult(text, { path: "f.ts", offset: 10, limit: 20 }), text, "both set");
  const short = "tiny file";
  assert.equal(boundReadResult(short, { path: "f.ts" }), short);
  assert.equal(boundReadResult("", { path: "f.ts" }), "");
});

test("boundReadResult of a 1000-line file stays under the read limit without input ranges", () => {
  const text = bigFileText(1_000);
  const result = boundReadResult(text, undefined);
  assert.ok(cps(result) <= READ_LIMIT_CHARS);
  const marker = /\.\.\..*?\.\.\./.exec(result)![0];
  const omitted = Number(MARKER_RE.exec(result)![1]);
  assert.ok(omitted > 0);
  // The omitted count accounts for head, tail, and marker exactly.
  assert.equal(cps(result) - cps(marker) + omitted, cps(text));
});

test("boundReadResult clamps a path-swollen marker to the marker-alone bound, not a dropped tail", () => {
  // A path long enough that the marker alone eats most of a small limit: the raw per-side
  // budget goes negative, which used to send the cut indices past the text's ends — the
  // whole tail vanished and the marker overcounted what it omitted while calling it a
  // missing middle.
  const text = bigFileText(600);
  const result = boundReadResult(text, { path: `${"p".repeat(300)}/big.ts` }, 500);
  assert.ok(cps(result) <= 500, "result stays within the limit");
  // The read marker survives, so the model keeps the re-read-with-offset/limit recovery.
  assert.match(result, /chars of this read were omitted/);
  const marker = /\.\.\..*?\.\.\./.exec(result)![0];
  const omitted = Number(MARKER_RE.exec(result)![1]);
  assert.ok(omitted > 0);
  // The omitted count is exact — no phantom chars from a negative per-side budget.
  assert.equal(cps(result) - cps(marker) + omitted, cps(text));
});

test("boundReadResult falls back to a plain cut when lines are too long to snap", () => {
  const text = "z".repeat(READ_LIMIT_CHARS + 3_000); // single line, no newlines
  const result = boundReadResult(text, undefined);
  assert.ok(cps(result) <= READ_LIMIT_CHARS);
  // No newline anywhere, so no line snap is possible — the marker still reports the omission.
  assert.match(result, /chars of this read were omitted/);
});

test("boundReadResult passes astral-heavy text through when the code-point count fits the limit", () => {
  // The read-side twin of boundBashResult's astral seam: UTF-16 length (24000) is far past
  // the read limit, but the code-point count (12000 — one per emoji) sits exactly on it,
  // so the text is under the limit and passes through untruncated, with no re-read marker.
  const text = "\u{1f680}".repeat(READ_LIMIT_CHARS);
  assert.ok(text.length > READ_LIMIT_CHARS, "test must sit in the length>limit window");
  assert.equal(boundReadResult(text), text);
});

test("boundReadResult falls back to a plain cut when the line snap swallows the whole text", () => {
  // A single-line text barely over a small limit: the per-side budget halves what is left
  // after the marker, but the line-boundary snap (max drift 2000) walks both cut points to
  // the text's ends — the omitted span is zero, so there is no missing middle to wrap a
  // marker around. The plain character cut takes over and keeps the at-most-limit contract.
  const text = "z".repeat(1_200);
  const result = boundReadResult(text, { path: "f.ts" }, 1_000);
  assert.ok(cps(result) <= 1_000, `result is ${cps(result)} code points`);
  assert.match(result, /chars truncated/);
  assert.doesNotMatch(result, /re-read/, "no read marker: there is no missing middle to re-read");
});

test("boundReadResult falls back to a plain cut when snapping overgrows the kept head past the limit", () => {
  // A long first line: the head's cut point snaps forward to the first line boundary —
  // 1501 code points, far past the per-side budget — so head + marker no longer fit the
  // limit. The plain character cut takes over rather than returning the flood.
  const text = `${"z".repeat(1_500)}\n${"y".repeat(400)}`;
  const result = boundReadResult(text, { path: "f.ts" }, 1_000);
  assert.ok(cps(result) <= 1_000, `result is ${cps(result)} code points`);
  assert.match(result, /chars truncated/);
  assert.doesNotMatch(result, /re-read/);
});

// ---- boundBashResult -------------------------------------------------------

test("boundBashResult keeps the first and last line on either side of the marker", () => {
  const text = bigFileText(700);
  const result = boundBashResult(text, null, () => null);
  assert.ok(cps(result) <= BASH_LIMIT_CHARS);
  const firstLine = text.split("\n")[0]!;
  const lastLine = text.trimEnd().split("\n").pop()!;
  assert.ok(result.startsWith(firstLine), "first line kept");
  assert.ok(result.trimEnd().endsWith(lastLine), "last line kept");
  assert.match(result, /chars truncated/);
});

test("boundBashResult prefers pi's own fullOutputPath and never calls the writer", () => {
  const text = bigFileText(700);
  let called = false;
  const result = boundBashResult(text, { fullOutputPath: "/repo/.tumwater/out.log" }, () => {
    called = true;
    return null;
  });
  assert.ok(!called, "writer skipped when pi already saved the full output");
  assert.match(result, /complete output in \/repo\/\.tumwater\/out\.log\.\.\./);
});

test("boundBashResult with no fullOutputPath and no harness root writes nothing", () => {
  const text = bigFileText(700);
  const result = boundBashResult(text, null, () => null);
  assert.doesNotMatch(result, /complete output in/, "marker carries no path");
});

test("boundBashResult uses the writer's path when it provides one", () => {
  const text = bigFileText(700);
  const result = boundBashResult(text, null, () => "/repo/.tumwater/log/tool-output/t1.log");
  assert.match(result, /complete output in \/repo\/\.tumwater\/log\/tool-output\/t1\.log\.\.\./);
});

test("boundBashResult passes short results through untouched", () => {
  const short = "ok\n done";
  assert.equal(boundBashResult(short, null, () => null), short);
});

test("boundBashResult returns astral-heavy under-limit text unchanged and never writes it", () => {
  // The seam: UTF-16 length (30000) is past the limit, but the code-point count
  // (15000 — each emoji is one code point, two UTF-16 units) is within it. Under-limit
  // means pass-through, and the full-output disk write must never fire for it.
  const text = "\u{1f600}".repeat(15_000);
  assert.ok(text.length > BASH_LIMIT_CHARS, "test must sit in the length>limit window");
  assert.ok(cps(text) <= BASH_LIMIT_CHARS, "test must sit in the cps<=limit window");
  let wrote = false;
  const result = boundBashResult(text, null, () => {
    wrote = true;
    return "/repo/.tumwater/log/tool-output/never.log";
  });
  assert.equal(result, text);
  assert.ok(!wrote, "no full-output write for an under-limit result");
});

test("boundBashResult truncates astral-heavy text just past the code-point limit", () => {
  const text = "\u{1f600}".repeat(BASH_LIMIT_CHARS + 1);
  const result = boundBashResult(text, null, () => null);
  assert.ok(cps(result) <= BASH_LIMIT_CHARS, `result is ${cps(result)} code points`);
  assert.match(result, /chars truncated/);
});

test("boundText returns astral-heavy text with cps within the limit unchanged", () => {
  const text = "\u{1f600}".repeat(READ_LIMIT_CHARS); // 24000 UTF-16 units, 12000 code points
  assert.ok(text.length > READ_LIMIT_CHARS && cps(text) <= READ_LIMIT_CHARS);
  assert.equal(boundText(text, READ_LIMIT_CHARS), text);
});

test("boundBashResult returns empty output untouched", () => {
  // The empty guard sits before every other branch: an empty result is never truncated
  // and never earns a full-output write, even with a writer wired up.
  let wrote = false;
  assert.equal(boundBashResult("", null, () => {
    wrote = true;
    return "/repo/.tumwater/log/tool-output/never.log";
  }), "");
  assert.ok(!wrote, "no full-output write for empty output");
});

// ---- pi extension adapter --------------------------------------------------

/** Install the adapter on a fake pi object and return the registered tool_result handler. */
function captureHandler(): { handler: (event: any, ctx?: any) => unknown } {
  let handler: (event: any, ctx?: any) => unknown = () => undefined;
  boundedOutput({ on: (_event, cb) => { handler = cb; } });
  return { handler };
}

test("adapter bounds oversized read results and passes everything else through", () => {
  const { handler } = captureHandler();
  const text = bigFileText(600);
  const patched = handler({
    toolName: "read",
    toolCallId: "t1",
    input: { path: "src/big.ts" },
    content: [{ type: "text", text }],
  }) as { content: Array<{ type: string; text: string }> };
  assert.equal(patched.content.length, 1);
  assert.ok(cps(patched.content[0]!.text) <= READ_LIMIT_CHARS);
  // Ranged read: untouched.
  assert.equal(handler({
    toolName: "read",
    toolCallId: "t2",
    input: { path: "src/big.ts", offset: 5 },
    content: [{ type: "text", text }],
  }), undefined);
  // Image result: untouched.
  assert.equal(handler({
    toolName: "read",
    toolCallId: "t3",
    input: { path: "img.png" },
    content: [{ type: "image", data: "..." }],
  }), undefined);
  // Other tools: untouched.
  assert.equal(handler({
    toolName: "grep",
    toolCallId: "t4",
    content: [{ type: "text", text }],
  }), undefined);
  // Short result: untouched.
  assert.equal(handler({
    toolName: "read",
    toolCallId: "t5",
    input: { path: "f.ts" },
    content: [{ type: "text", text: "short" }],
  }), undefined);
});

test("adapter bounds oversized bash results using pi's fullOutputPath", () => {
  const { handler } = captureHandler();
  const text = bigFileText(700);
  const patched = handler({
    toolName: "bash",
    toolCallId: "call-9",
    details: { fullOutputPath: "/repo/.tumwater/snapshot.log" },
    content: [{ type: "text", text }],
  }) as { content: Array<{ type: string; text: string }> };
  assert.match(patched.content[0]!.text, /complete output in \/repo\/\.tumwater\/snapshot\.log/);
});

test("adapter persists the full output itself when pi's bash tool left no file", () => {
  // pi's bash tool sets details.fullOutputPath only when IT truncates; a bash result that
  // arrives oversized with no file is bounded here instead — the adapter's writer seam
  // persists the complete text under the harness's tool-output directory, named by
  // toolCallId (parallel tool mode interleaves results), and the marker points the model
  // at it. Without this wiring an oversized result pi did not truncate was bounded with a
  // marker pointing nowhere, and the omitted middle was gone for good.
  const dir = tmpdir("bound-adapter-write-");
  fs.mkdirSync(path.join(dir, ".tumwater"));
  const wt = path.join(dir, "worktrees", "feature"); // finds the root three levels up
  fs.mkdirSync(wt, { recursive: true });
  const prevCwd = process.cwd();
  process.chdir(wt); // the adapter's writer resolves the harness root from the process cwd
  try {
    const text = bigFileText(700);
    const patched = captureHandler().handler({
      toolName: "bash",
      toolCallId: "call-7",
      content: [{ type: "text", text }],
    }) as { content: Array<{ type: string; text: string }> };
    const file = path.join(dir, ".tumwater", "log", "tool-output", "call-7.log");
    assert.equal(fs.readFileSync(file, "utf-8"), text, "the complete output was persisted under the tool call's id");
    const bounded = patched.content[0]!.text;
    assert.ok(cps(bounded) <= BASH_LIMIT_CHARS, `bounded to ${cps(bounded)} code points`);
    assert.match(bounded, /complete output in /);
    assert.match(bounded, /call-7\.log/, "the marker names the persisted full-output file");
  } finally {
    process.chdir(prevCwd); // leave the process where the other tests expect it
  }
});

test("adapter leaves a non-array content payload untouched", () => {
  // pi tool results are normally block arrays, but a non-array content shape (a bare
  // string, an object) is not something this extension understands: it returns no patch
  // instead of crashing on the missing array.
  const { handler } = captureHandler();
  assert.equal(handler({ toolName: "read", toolCallId: "t6", input: { path: "f.ts" }, content: "plain text" }), undefined);
  assert.equal(handler({ toolName: "bash", toolCallId: "t7", content: { type: "text", text: "big" } }), undefined);
});
// ---- window-scaled limits ---------------------------------------------------

test("outputLimits keeps the tuned limits at and above the 128k window and when it is unknown", () => {
  const tuned = { read: READ_LIMIT_CHARS, bash: BASH_LIMIT_CHARS };
  for (const window of [REFERENCE_WINDOW_TOKENS, 262_144, 1_048_576, undefined, 0, -1, Number.NaN, "65536"]) {
    assert.deepEqual(outputLimits(window), tuned, String(window));
  }
});

test("outputLimits scales both limits with a smaller window, down to a quarter", () => {
  assert.deepEqual(outputLimits(65_536), { read: 6_000, bash: 8_000 });
  assert.deepEqual(outputLimits(98_304), { read: 9_000, bash: 12_000 });
  // A quarter is the floor: 32k reaches it, and nothing smaller goes under it.
  assert.deepEqual(outputLimits(32_768), { read: 3_000, bash: 4_000 });
  assert.deepEqual(outputLimits(8_192), { read: 3_000, bash: 4_000 });
});

test("adapter bounds a 64k model's results to its scaled limits", () => {
  const { handler } = captureHandler();
  const ctx = { model: { contextWindow: 65_536 } };
  const text = bigFileText(600); // ~30k chars
  const read = handler({
    toolName: "read",
    toolCallId: "w1",
    input: { path: "src/big.ts" },
    content: [{ type: "text", text }],
  }, ctx) as { content: Array<{ text: string }> };
  assert.ok(cps(read.content[0]!.text) <= 6_000, `read bounded to ${cps(read.content[0]!.text)}`);
  // pi's own full-output path is used, so the bash bound writes nothing.
  const bash = handler({
    toolName: "bash",
    toolCallId: "w2",
    details: { fullOutputPath: "/tmp/full.log" },
    content: [{ type: "text", text }],
  }, ctx) as { content: Array<{ text: string }> };
  assert.ok(cps(bash.content[0]!.text) <= 8_000, `bash bounded to ${cps(bash.content[0]!.text)}`);
  // A result between the scaled and the tuned limit passes on a large window, not on 64k.
  const mid = bigFileText(160); // ~8k chars
  const event = { toolName: "read", toolCallId: "w3", input: { path: "f.ts" }, content: [{ type: "text", text: mid }] };
  assert.equal(handler(event, { model: { contextWindow: 1_048_576 } }), undefined);
  assert.ok(handler(event, ctx), "the same read is bounded on the 64k model");
});

// The piArgs wiring tests (extension flag placement, non-pi agent skip) live in
// test/pi-args.test.ts beside the rest of the piArgs suite — they were duplicated here
// and in pi.test.ts since the feature landed (2026-09-23), and pi.test.ts's copies
// carry the stronger exact-dist-path assertion.
