import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTEXT_THRESHOLDS,
  contextNote,
  default as contextBudget,
} from "../src/pi-extension/context-budget.js";

// The bundled context-budget extension (src/pi-extension/context-budget.ts): a run cannot see
// its own context usage and pi never compacts mid-run, so the extension names the fill level
// at fixed thresholds — once each, on the tool result that crosses it.

test("contextNote stays silent below the first threshold and on unknown usage", () => {
  assert.equal(contextNote(49.9, 63_000, 126_928, 0), null);
  assert.equal(contextNote(null, null, 126_928, 0), null);
  assert.equal(contextNote(undefined, 1, 126_928, 0), null);
  assert.equal(contextNote(Number.NaN, 1, 126_928, 0), null);
});

test("contextNote fires once per threshold and names the numbers", () => {
  const first = contextNote(52.3, 66_400, 126_928, 0);
  assert.ok(first);
  assert.equal(first.threshold, 50);
  assert.match(first.text, /your context window is 52% full \(66k of 127k tokens\)/);
  assert.match(first.text, /start no new exploration/);
  // Already warned at 50: nothing new until 70 is crossed.
  assert.equal(contextNote(65, 82_000, 126_928, 50), null);
  const second = contextNote(71, 90_000, 126_928, 50);
  assert.equal(second?.threshold, 70);
  assert.match(second!.text, /Wrap up/);
  const third = contextNote(86, 109_000, 126_928, 70);
  assert.equal(third?.threshold, 85);
  assert.match(third!.text, /Stop reading now/);
  assert.equal(contextNote(99, 125_000, 126_928, 85), null, "nothing past the last threshold");
});

test("contextNote jumps to the highest crossed threshold instead of replaying the lower ones", () => {
  // A resumed session (fresh process) that is already deep in the window warns once, at the
  // level it is actually at.
  const note = contextNote(88, 112_000, 126_928, 0);
  assert.equal(note?.threshold, CONTEXT_THRESHOLDS[CONTEXT_THRESHOLDS.length - 1]);
});

test("contextNote advice is role-agnostic, so the reviewer and conflict runs can carry it", () => {
  for (const t of CONTEXT_THRESHOLDS) {
    const note = contextNote(t, 1000, 2000, 0)!;
    assert.ok(!note.text.includes("SUMMARY"), `no tick-only contract at ${t}%`);
    assert.ok(!note.text.includes("TUMWATER_"), `no sentinel at ${t}%`);
  }
});

test("contextNote omits the token counts when they are unknown", () => {
  const note = contextNote(60, null, 0, 0);
  assert.match(note!.text, /^\[tumwater: your context window is 60% full\. /);
});

test("the extension appends the note after the tool result's own content, once per threshold", () => {
  let handler: ((event: { content?: Array<{ type?: string; text?: string }> }, ctx?: unknown) => unknown) | undefined;
  contextBudget({ on: (_event, cb) => { handler = cb as typeof handler; } });
  assert.ok(handler);
  let percent = 40;
  const ctx = { getContextUsage: () => ({ tokens: percent * 1000, contextWindow: 100_000, percent }) };
  const event = { content: [{ type: "text", text: "file body" }] };
  assert.equal(handler(event, ctx), undefined, "below the first threshold: untouched");
  percent = 55;
  const patched = handler(event, ctx) as { content: Array<{ type: string; text: string }> };
  assert.equal(patched.content.length, 2);
  assert.equal(patched.content[0]!.text, "file body", "the result itself stays first");
  assert.match(patched.content[1]!.text, /55% full \(55k of 100k tokens\)/);
  assert.equal(handler(event, ctx), undefined, "the same threshold never fires twice");
  percent = 72;
  assert.ok(handler(event, ctx), "the next threshold fires");
});

test("the extension tolerates a context without usage or a throwing getter", () => {
  let handler: ((event: object, ctx?: unknown) => unknown) | undefined;
  contextBudget({ on: (_event, cb) => { handler = cb as typeof handler; } });
  assert.equal(handler!({ content: [] }), undefined);
  assert.equal(handler!({ content: [] }, { getContextUsage: () => undefined }), undefined);
  assert.equal(
    handler!({ content: [] }, { getContextUsage: () => { throw new Error("no session"); } }),
    undefined,
  );
});
