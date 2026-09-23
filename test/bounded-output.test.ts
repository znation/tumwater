import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
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
import { piArgs } from "../src/pi.js";
import { defaultConfig } from "../src/config.js";

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

test("boundReadResult falls back to a plain cut when lines are too long to snap", () => {
  const text = "z".repeat(READ_LIMIT_CHARS + 3_000); // single line, no newlines
  const result = boundReadResult(text, undefined);
  assert.ok(cps(result) <= READ_LIMIT_CHARS);
  // No newline anywhere, so no line snap is possible — the marker still reports the omission.
  assert.match(result, /chars of this read were omitted/);
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

// ---- findTumwaterRoot / writeFullOutput ------------------------------------

test("writeFullOutput writes into .tumwater/log/tool-output named by toolCallId", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bound-"));
  fs.mkdirSync(path.join(dir, ".tumwater"));
  const nested = path.join(dir, "worktrees", "feature");
  fs.mkdirSync(nested, { recursive: true });
  const file = writeFullOutput("full output text", "call-42", nested);
  assert.ok(file, "returns the written path");
  assert.equal(file, path.join(dir, ".tumwater", "log", "tool-output", "call-42.log"));
  assert.equal(fs.readFileSync(file!, "utf-8"), "full output text");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("writeFullOutput returns null when no ancestor has .tumwater/", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bound-none-"));
  assert.equal(writeFullOutput("text", "call-1", dir), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("findTumwaterRoot walks up to the harness root", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bound-root-"));
  fs.mkdirSync(path.join(dir, ".tumwater"));
  const deep = path.join(dir, "a", "b", "c");
  fs.mkdirSync(deep, { recursive: true });
  assert.equal(findTumwaterRoot(deep), dir);
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "bound-bare-"));
  assert.equal(findTumwaterRoot(bare), null);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(bare, { recursive: true, force: true });
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

// ---- piArgs wiring ---------------------------------------------------------

test("piArgs loads the bundled bounded-output extension before user piArgs", () => {
  const config = defaultConfig();
  config.piArgs = ["--no-skills"];
  const args = piArgs({ config, sessionDir: "/tmp/s", sessionName: "n" });
  const eIndex = args.indexOf("-e");
  assert.ok(eIndex !== -1, "-e flag present");
  const extPath = args[eIndex + 1]!;
  assert.ok(path.isAbsolute(extPath), `extension path is absolute: ${extPath}`);
  assert.ok(fs.existsSync(extPath), `extension exists in dist: ${extPath}`);
  assert.ok(extPath.endsWith("pi-extension" + path.sep + "bounded-output.js"));
  // The extension is offered before user flags, so a user flag still wins.
  assert.ok(eIndex < args.indexOf("--no-skills"));
});

test("piArgs skips the extension flag for non-pi agent binaries", () => {
  const args = piArgs({
    config: defaultConfig(),
    sessionDir: "/tmp/s",
    sessionName: "n",
    agentBin: "/usr/local/bin/other-agent",
  });
  assert.ok(!args.includes("-e"), "no -e for a non-pi agent");
  const piShaped = piArgs({
    config: defaultConfig(),
    sessionDir: "/tmp/s",
    sessionName: "n",
    agentBin: "/opt/tools/pi",
  });
  assert.ok(piShaped.includes("-e"), "a configured pi path still gets the extension");
});
