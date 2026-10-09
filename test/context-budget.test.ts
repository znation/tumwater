import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTEXT_THRESHOLDS,
  contextNote,
  default as contextBudget,
} from "../src/pi-extension/context-budget.js";
import { READ_LIMIT_CHARS, default as boundedOutput } from "../src/pi-extension/bounded-output.js";

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
  // Counts render through format.ts's compactTokens, the harness's one token format.
  assert.match(first.text, /your context window is 52% full \(66\.4k of 126\.9k tokens\)/);
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
  // pi's projection can carry a percent with no token estimate at all (undefined, not null):
  // the counts stay out rather than rendering "undefined of …".
  const noTokens = contextNote(60, undefined, 100_000, 0);
  assert.match(noTokens!.text, /^\[tumwater: your context window is 60% full\. /);
  // And a known token count with an unknown window (0) must not render a half reading —
  // "55.0k of 0 tokens" would be worse than silence.
  const noWindow = contextNote(60, 55_000, 0, 0);
  assert.match(noWindow!.text, /^\[tumwater: your context window is 60% full\. /);
  assert.ok(!noWindow!.text.includes("55.0k"), "known tokens are held back with the window");
  // A NaN/Infinity/negative wire number is as unknowable as a missing one: the note must not
  // render "NaN of 100.0k tokens", an infinite window, or a negative count.
  const poison: Array<[number, number]> = [
    [Number.NaN, 100_000],
    [Number.POSITIVE_INFINITY, 100_000],
    [-1, 100_000],
    [55_000, Number.POSITIVE_INFINITY],
    [55_000, Number.NaN],
  ];
  for (const [tokens, window] of poison) {
    const note = contextNote(60, tokens, window, 0)!;
    assert.match(note.text, /^\[tumwater: your context window is 60% full\. /, `tokens=${tokens} window=${window}`);
    assert.ok(
      !note.text.includes("NaN") && !note.text.includes("Infinity"),
      `no broken number for tokens=${tokens} window=${window}`,
    );
  }
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
  assert.match(patched.content[1]!.text, /55% full \(55\.0k of 100\.0k tokens\)/);
  assert.equal(handler(event, ctx), undefined, "the same threshold never fires twice");
  percent = 72;
  assert.ok(handler(event, ctx), "the next threshold fires");
});

test("a tool result with no content array still gets the note alone", () => {
  // pi can deliver a tool_result patch whose content is absent or not an array (bounded-output
  // and pi's own handlers control the shape, but the extension must not assume it): the note
  // then makes up the whole patched content instead of crashing on the spread.
  let handler: ((event: { content?: unknown }, ctx?: unknown) => unknown) | undefined;
  contextBudget({ on: (_event, cb) => { handler = cb as typeof handler; } });
  const ctx = { getContextUsage: () => ({ tokens: 55_000, contextWindow: 100_000, percent: 55 }) };
  const missing = handler!({}, ctx) as { content: Array<{ type: string; text: string }> };
  assert.equal(missing.content.length, 1, "the note is the only content");
  assert.match(missing.content[0]!.text, /55% full/);
  // A non-array content rides the same degradation — and the fired threshold is remembered,
  // so the next result below the next threshold stays untouched.
  assert.equal(handler!({ content: "raw text" }, ctx), undefined);
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

test("empty thresholds warn at nothing and never ask for a projection", () => {
  // The degenerate configuration (no thresholds configured) must degrade to silence, not to
  // a crash on the missing last threshold — and with nothing to warn about the extension
  // never spends a projection rebuild either.
  const thresholds = CONTEXT_THRESHOLDS as number[];
  const saved = thresholds.splice(0, thresholds.length);
  try {
    let handler: ((event: object, ctx?: unknown) => unknown) | undefined;
    contextBudget({ on: (_event, cb) => { handler = cb as typeof handler; } });
    let calls = 0;
    const ctx = { getContextUsage: () => { calls++; return { tokens: 90_000, contextWindow: 100_000, percent: 90 }; } };
    assert.equal(handler!({ content: [] }, ctx), undefined);
    assert.equal(calls, 0, "nothing to warn about, so no usage is asked for");
  } finally {
    thresholds.push(...saved);
  }
});

test("the extension stops asking for usage once the last threshold has fired", () => {
  let handler: ((event: object, ctx?: unknown) => unknown) | undefined;
  contextBudget({ on: (_event, cb) => { handler = cb as typeof handler; } });
  let calls = 0;
  const ctx = { getContextUsage: () => { calls++; return { tokens: 90_000, contextWindow: 100_000, percent: 90 }; } };
  assert.ok(handler!({ content: [] }, ctx), "the 85% note fires");
  assert.equal(calls, 1);
  for (let i = 0; i < 5; i++) assert.equal(handler!({ content: [] }, ctx), undefined);
  assert.equal(calls, 1, "no further projection work after the last note");
});

test("composed after bounded-output the way pi composes handlers, the note follows the bounded result", () => {
  // pi runs tool_result handlers in load order, each seeing the prior handler's patch
  // (extensions.md "Events and concurrency"); pi-args loads bounded-output first.
  const handlers: Array<(event: { toolName: string; toolCallId: string; input: object; content: Array<{ type: string; text: string }> }, ctx?: unknown) => unknown> = [];
  const api = { on: (_event: string, cb: (typeof handlers)[number]) => { handlers.push(cb); } };
  boundedOutput(api as never);
  contextBudget(api as never);
  let event = { toolName: "read", toolCallId: "t1", input: { path: "big.ts" }, content: [{ type: "text", text: "x\n".repeat(20_000) }] };
  const ctx = { getContextUsage: () => ({ tokens: 72_000, contextWindow: 100_000, percent: 72 }) };
  for (const h of handlers) {
    const patch = h(event, ctx) as { content?: typeof event.content } | undefined;
    if (patch?.content) event = { ...event, content: patch.content };
  }
  assert.equal(event.content.length, 2, "bounded result plus the note");
  assert.match(event.content[0]!.text, /chars of this read were omitted/, "bounded-output still bounded the read");
  assert.ok(event.content[0]!.text.length <= READ_LIMIT_CHARS, "the bound holds for the result itself");
  assert.match(event.content[1]!.text, /72% full \(72\.0k of 100\.0k tokens\)\. Wrap up/);
});
