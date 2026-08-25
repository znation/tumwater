import test from "node:test";
import assert from "node:assert/strict";
import { describeToolCall } from "../src/tool-call.js";

test("describeToolCall summarizes common arg shapes tersely", () => {
  assert.equal(describeToolCall("read", { path: "/a/b/loop.ts" }), "read loop.ts");
  assert.equal(describeToolCall("bash", { command: "npm run build" }), "bash npm run build");
  assert.equal(describeToolCall("edit", {}), "edit");
  assert.equal(describeToolCall("bash", { command: "x".repeat(100) }), `bash ${"x".repeat(31)}…`);
  assert.equal(describeToolCall("bash", { command: "a\n  b\tc" }), "bash a b c");
});
