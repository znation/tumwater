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
  findTumwaterRoot,
  writeFullOutput,
  default as boundedOutput,
} from "../src/pi-extension/bounded-output.js";
import { tmpdir } from "./repo-fixtures.js";

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
  const match = result.match(MARKER_RE);
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
  assert.ok(result.trimEnd().endsWith(`line ${600}: ${"b".repeat(40)}`), "last line kept");
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
  const marker = result.match(/\.\.\..*?\.\.\./)![0];
  const omitted = Number(result.match(MARKER_RE)![1]);
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
  const marker = result.match(/\.\.\..*?\.\.\./)![0];
  const omitted = Number(result.match(MARKER_RE)![1]);
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

// ---- findTumwaterRoot / writeFullOutput ------------------------------------

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

test("writeFullOutput writes into .tumwater/log/tool-output named by toolCallId", () => {
  const dir = tmpdir("bound-");
  fs.mkdirSync(path.join(dir, ".tumwater"));
  const nested = path.join(dir, "worktrees", "feature");
  fs.mkdirSync(nested, { recursive: true });
  const file = writeFullOutput("full output text", "call-42", nested);
  assert.ok(file, "returns the written path");
  assert.equal(file, path.join(dir, ".tumwater", "log", "tool-output", "call-42.log"));
  assert.equal(fs.readFileSync(file!, "utf-8"), "full output text");
});

test("writeFullOutput returns null when no ancestor has .tumwater/", () => {
  const dir = tmpdir("bound-none-");
  assert.equal(writeFullOutput("text", "call-1", dir), null);
});

test("writeFullOutput returns null when the write fails instead of throwing", () => {
  const dir = tmpdir("bound-fail-");
  fs.mkdirSync(path.join(dir, ".tumwater", "log"), { recursive: true });
  // .tumwater/log/tool-output exists as a regular file, so the recursive mkdirSync inside
  // writeFullOutput throws: the catch must turn that into null (a failing write can never
  // crash a tick's tool_result handling), and nothing is written.
  fs.writeFileSync(path.join(dir, ".tumwater", "log", "tool-output"), "occupied");
  assert.equal(writeFullOutput("text", "call-9", dir), null);
});

test("findTumwaterRoot gives up after 64 levels without .tumwater/ instead of looping forever", () => {
  // A chain deeper than the walk's 64-level cap, with no .tumwater/ on any ancestor of it:
  // the walk exhausts its depth budget and returns null (it must terminate by depth, not
  // only by reaching the filesystem root).
  const base = tmpdir("bound-deep-");
  const deep = path.join(base, ...Array(70).fill("d"));
  fs.mkdirSync(deep, { recursive: true });
  assert.equal(findTumwaterRoot(deep), null);
});

test("findTumwaterRoot walks up to the harness root", () => {
  const dir = tmpdir("bound-root-");
  fs.mkdirSync(path.join(dir, ".tumwater"));
  const deep = path.join(dir, "a", "b", "c");
  fs.mkdirSync(deep, { recursive: true });
  assert.equal(findTumwaterRoot(deep), dir);
  const bare = tmpdir("bound-bare-");
  assert.equal(findTumwaterRoot(bare), null);
});

// ---- pi extension adapter --------------------------------------------------

/** Install the adapter on a fake pi object and return the registered tool_result handler. */
function captureHandler(): { handler: (event: any) => unknown } {
  let handler: (event: any) => unknown = () => undefined;
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

test("writeFullOutput falls back to a timestamped name when the tool call has no id", () => {
  // Parallel tool mode names files by toolCallId; a call without one (or with a junk-free
  // empty id) still gets a file — named by the current time instead of crashing or
  // colliding on a bare ".log".
  const dir = tmpdir("bound-id-");
  fs.mkdirSync(path.join(dir, ".tumwater"));
  const nested = path.join(dir, "worktrees", "feature");
  fs.mkdirSync(nested, { recursive: true });
  const file = writeFullOutput("full output text", undefined, nested);
  assert.ok(file, "returns the written path");
  assert.match(file!, /result-\d+\.log$/, "timestamped name");
  assert.equal(fs.readFileSync(file!, "utf-8"), "full output text");
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

test("adapter leaves a non-array content payload untouched", () => {
  // pi tool results are normally block arrays, but a non-array content shape (a bare
  // string, an object) is not something this extension understands: it returns no patch
  // instead of crashing on the missing array.
  const { handler } = captureHandler();
  assert.equal(handler({ toolName: "read", toolCallId: "t6", input: { path: "f.ts" }, content: "plain text" }), undefined);
  assert.equal(handler({ toolName: "bash", toolCallId: "t7", content: { type: "text", text: "big" } }), undefined);
});
// The piArgs wiring tests (extension flag placement, non-pi agent skip) live in
// test/pi-args.test.ts beside the rest of the piArgs suite — they were duplicated here
// and in pi.test.ts since the feature landed (2026-09-23), and pi.test.ts's copies
// carry the stronger exact-dist-path assertion.
