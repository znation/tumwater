import test from "node:test";
import assert from "node:assert/strict";
import { backendKindPhrase, describeToolCall } from "../src/phrases.js";

// phrases.ts is the single home of the fleet's shared wording fragments (the tool-call label,
// the backend-hold kind phrasing, and their siblings). These tests pin the documented contracts
// of the two phrases whose arms the renderer tests' chosen kinds and shapes never exercise.

// --- describeToolCall (one-line labels for in-flight and stalled tool calls) ---

test("describeToolCall summarizes common arg shapes tersely", () => {
  assert.equal(describeToolCall("read", { path: "/a/b/loop.ts" }), "read loop.ts");
  assert.equal(describeToolCall("bash", { command: "npm run build" }), "bash npm run build");
  assert.equal(describeToolCall("edit", {}), "edit");
  assert.equal(describeToolCall("bash", { command: "x".repeat(100) }), `bash ${"x".repeat(31)}…`);
  assert.equal(describeToolCall("bash", { command: "a\n  b\tc" }), "bash a b c");
});

test("describeToolCall with an omitted toolName yields the bare detail, no leading space", () => {
  // pi omits toolName on some start events; the stall warning must still name the command.
  assert.equal(describeToolCall("", { command: "sleep 999" }), "sleep 999");
  assert.equal(describeToolCall("", { path: "/a/b/loop.ts" }), "loop.ts");
  assert.equal(describeToolCall("", {}), "", "no name and no recognizable arg — the caller falls back");
});

test("describeToolCall basenames path-like keys and shows the others verbatim", () => {
  // Both path spellings reduce to the file name, not the full directory.
  assert.equal(describeToolCall("read", { file_path: "/a/b/loop.ts" }), "read loop.ts");
  assert.equal(describeToolCall("write", { path: "relative/dir/file.md" }), "write file.md");
  // The remaining candidate keys are shown as-is (no basename), whitespace-collapsed.
  assert.equal(describeToolCall("bash", { cmd: "git status" }), "bash git status");
  assert.equal(describeToolCall("grep", { pattern: "foo\\.bar" }), "grep foo\\.bar");
  assert.equal(describeToolCall("web_fetch", { url: "https://example.com/a b" }), "web_fetch https://example.com/a b");
});

test("describeToolCall prefers the first present key in path, file_path, command, cmd, pattern, url order", () => {
  assert.equal(describeToolCall("t", { path: "/p/x.ts", file_path: "/f/y.ts" }), "t x.ts");
  assert.equal(describeToolCall("t", { file_path: "/f/y.ts", command: "run it" }), "t y.ts");
  assert.equal(describeToolCall("t", { command: "run it", cmd: "other" }), "t run it");
  assert.equal(describeToolCall("t", { cmd: "other", pattern: "p*" }), "t other");
  assert.equal(describeToolCall("t", { pattern: "p*", url: "https://x" }), "t p*");
});

test("describeToolCall falls back to the bare tool name for non-object or non-string args", () => {
  // No object to read keys from.
  assert.equal(describeToolCall("bash", null), "bash");
  assert.equal(describeToolCall("bash", undefined), "bash");
  assert.equal(describeToolCall("bash", "npm test"), "bash");
  assert.equal(describeToolCall("bash", 42), "bash");
  // Object present but the candidate value is not a string (or no known key at all).
  assert.equal(describeToolCall("read", { path: 123 }), "read");
  assert.equal(describeToolCall("grep", { pattern: ["a"] }), "grep");
  assert.equal(describeToolCall("edit", { unrelated: "/a/b.ts" }), "edit");
});

// backendKindPhrase is the one home of a backend hold's kind wording, shared by the event
// feed (event-format.ts) and the failure digest (failure-state-change.ts). The timeout arm
// and the unknown-kind fallback are the arms the renderer tests' chosen kinds never
// exercise: a "Request timed out" storm must render its own phrase (not a connection's),
// and an unreadable kind (a hand-edited or future kind value) must degrade to the generic
// wording rather than leak "undefined" into the feed or digest.
test("backendKindPhrase names each backend-failure kind and falls back on an unreadable kind", () => {
  assert.equal(backendKindPhrase("connection"), "connection error");
  assert.equal(backendKindPhrase("timeout"), "request timed out");
  assert.equal(backendKindPhrase("server"), "server error");
  assert.equal(backendKindPhrase("model-load"), "model load failure");
  assert.equal(backendKindPhrase("stream-severed"), "stream severed");
  assert.equal(backendKindPhrase("gateway-noon"), "backend failure");
  assert.equal(backendKindPhrase(undefined), "backend failure");
});
