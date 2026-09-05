import test from "node:test";
import assert from "node:assert/strict";
import { parsePiEventLine, piEventType } from "../src/pi-event-line.js";

test("piEventType reads pi's compact type-first prefix and returns null on any other shape", () => {
  assert.equal(piEventType('{"type":"message_end","x":1}'), "message_end");
  assert.equal(piEventType('{"type":"session"}'), "session");
  // Anything not matching that exact prefix must fall through to a full parse: spaced JSON,
  // torn lines, foreign JSON with type later, and an empty type value.
  assert.equal(piEventType('{ "type": "message_end" }'), null);
  assert.equal(piEventType('{"type":"messag'), null);
  assert.equal(piEventType('{"x":1,"type":"session"}'), null);
  assert.equal(piEventType('{"type":""}'), null);
});

test("parsePiEventLine parses lines whose type the consumer acts on", () => {
  const types = new Set(["message_end"]);
  const event = parsePiEventLine<{ type: string; n?: number }>('{"type":"message_end","n":7}', types);
  assert.deepEqual(event, { type: "message_end", n: 7 });
});

test("parsePiEventLine skips blank lines and torn or non-JSON noise without failing", () => {
  const types = new Set(["session"]);
  assert.equal(parsePiEventLine("", types), null);
  assert.equal(parsePiEventLine("   \n", types), null);
  assert.equal(parsePiEventLine('{"type":"sess', types), null); // Torn mid-line.
  assert.equal(parsePiEventLine("not json at all", types), null);
});

test("parsePiEventLine skips the parse when the compact prefix names a type outside `types`", () => {
  const types = new Set(["message_end"]);
  // The fast path must skip even lines that would otherwise parse fine.
  assert.equal(parsePiEventLine('{"type":"message_update","delta":"x"}', types), null);
});

test("parsePiEventLine still fully parses non-compact shapes whose type is wanted", () => {
  const types = new Set(["session"]);
  // Spaced JSON does not match the compact prefix, so it falls through to a full parse.
  assert.deepEqual(parsePiEventLine<{ type: string }>('{"type": "session"}', types), { type: "session" });
});
