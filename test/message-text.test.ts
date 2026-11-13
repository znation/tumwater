import test from "node:test";
import assert from "node:assert/strict";
import { messageText } from "../src/pi-extension/message-text.js";

// The extensions' one shared reader of a pi message's text (src/pi-extension/message-text.ts).
// context-shake measures a result's bulk through it, pin-prompt pins the run prompt verbatim,
// and the harness's pi-stream.ts reads assistant reply text the same way. A non-array content
// (a plain string, a number, a null, or absent) reads as empty — the same rule transcript.ts's
// contentBlocks and progress-data.ts's workItemFromContent apply — so the three readers cannot
// drift apart on that shape.

test("messageText joins the text blocks of an array in order", () => {
  assert.equal(
    messageText({ content: [{ type: "text", text: "rule one" }, { type: "text", text: "rule two" }] }),
    "rule one\nrule two",
  );
});

test("messageText skips non-text blocks, bare-string elements, and torn entries", () => {
  // A thinking block, a bare string, a null, and a text block with a non-string text are all
  // skipped; only the well-formed text blocks survive, in order.
  const content = [
    { type: "thinking", thinking: "hmm" },
    "bare string",
    null,
    { type: "text", text: 42 },
    { type: "text", text: "first" },
    { type: "text", text: null },
    { type: "text", text: "second" },
  ];
  assert.equal(messageText({ content }), "first\nsecond");
});

test("messageText reads a non-array content as empty, never throwing", () => {
  assert.equal(messageText({ content: "a plain string" }), "");
  assert.equal(messageText({ content: 42 }), "");
  assert.equal(messageText({ content: null }), "");
  assert.equal(messageText({}), "");
});

test("messageText reads an empty array as empty", () => {
  assert.equal(messageText({ content: [] }), "");
});
