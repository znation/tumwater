import test from "node:test";
import assert from "node:assert/strict";
import { firstUserMessage, pinPrompt, default as pinPromptExtension } from "../src/pi-extension/pin-prompt.js";

// The bundled pin-prompt extension (src/pi-extension/pin-prompt.ts): tumwater sends the run
// prompt as the first user message, and pi's compaction summarizes it like any other message,
// so after a compaction a run can lose the kill-by-PID rule, the test-runner rule, and the
// write rules. The extension records the first user message verbatim on the first `context`
// event and puts it back at the front on every later one if a compaction displaced it.
//
// The pure parts are `pinPrompt` (re-insert the prompt, idempotently) and `firstUserMessage`
// (the run prompt from a message list). The default export is the thin adapter over pi's
// `context` event and `ctx.sessionManager`, which the tests exercise with a fake api.

/** Build a minimal message object the pure functions understand. */
function user(text: string) {
  return { role: "user" as const, content: text };
}
function assistant(text: string) {
  return { role: "assistant" as const, content: [{ type: "text", text }] };
}
function toolResult(text: string) {
  return { role: "toolResult" as const, content: [{ type: "text", text }] };
}
/** A compaction-summary message, the shape pi's compaction produces. */
function compactionSummary(text: string) {
  return { role: "compactionSummary" as const, content: text, summary: text, tokensBefore: 1, timestamp: 0 };
}

// --- pinPrompt --------------------------------------------------------------

test("pinPrompt returns null for a list that already starts with the prompt", () => {
  const prompt = user("You are the feature role. Always kill by PID.");
  assert.equal(pinPrompt([prompt, assistant("ok"), toolResult("r")], prompt), null);
});

test("pinPrompt re-inserts the prompt at the front after a compaction displaced it", () => {
  const prompt = user("You are the feature role. Always kill by PID.");
  // A list that starts with a compaction summary: the prompt is gone, the rest is in order.
  const summary = compactionSummary("Summary of earlier work…");
  const after = [summary, assistant("ok"), toolResult("r")];
  const expected = [prompt, summary, assistant("ok"), toolResult("r")];
  assert.deepEqual(pinPrompt(after, prompt), expected);
});

test("pinPrompt is idempotent: the prompt never appears twice", () => {
  const prompt = user("You are the feature role.");
  // The prompt has been re-inserted once already and a new message was appended after it.
  const once = [prompt, assistant("a"), toolResult("t")];
  // Running the pin again must not add a second copy.
  assert.equal(pinPrompt(once, prompt), null);
  // And if a later compaction displaced it again, the re-insert drops the old copy first.
  const displaced = [compactionSummary("s"), prompt, assistant("a")];
  const expected = [prompt, compactionSummary("s"), assistant("a")];
  assert.deepEqual(pinPrompt(displaced, prompt), expected);
  // Count the prompt occurrences: exactly one.
  const result = pinPrompt(displaced, prompt)!;
  const count = result.filter((m) => m === prompt).length;
  assert.equal(count, 1);
});

test("pinPrompt matches a multi-block user message by its joined text", () => {
  // The prompt is a user message whose content is an array of text blocks; messageText joins
  // them, so a rebuilt copy with the same block text compares equal (compaction rebuilds
  // messages as new objects, so the pin must match by text, not by identity).
  const prompt = { role: "user" as const, content: [{ type: "text", text: "rule one" }, { type: "text", text: "rule two" }] };
  const rebuilt = { role: "user" as const, content: [{ type: "text", text: "rule one" }, { type: "text", text: "rule two" }] };
  // A rebuilt copy of the prompt is still first (same text, different object): left alone.
  assert.equal(pinPrompt([rebuilt, assistant("a")], prompt), null);
  // After a compaction displaced it, the re-inserted message is the recorded multi-block prompt.
  const displaced = [compactionSummary("s"), assistant("a")];
  assert.deepEqual(pinPrompt(displaced, prompt), [prompt, compactionSummary("s"), assistant("a")]);
});

test("pinPrompt with an empty list returns the prompt alone", () => {
  const prompt = user("You are the feature role.");
  assert.deepEqual(pinPrompt([], prompt), [prompt]);
});

// --- firstUserMessage -------------------------------------------------------

test("firstUserMessage returns the first user message or null", () => {
  assert.deepEqual(firstUserMessage([assistant("a"), user("u1"), user("u2")]), user("u1"));
  assert.equal(firstUserMessage([assistant("a")]), null);
  assert.equal(firstUserMessage([]), null);
});

// --- the default export (the pi adapter) ------------------------------------

/** A fake pi extension api that records the registered context handler. */
function fakeApi() {
  let handler: ((event: { messages: any[] }, ctx?: any) => any) | null = null;
  const api = {
    on(event: string, fn: (event: any, ctx?: any) => any): void {
      assert.equal(event, "context");
      handler = fn as typeof handler;
    },
    fire(messages: any[], ctx?: any) {
      return handler!({ messages }, ctx);
    },
  };
  return api;
}

/** A fake session manager whose branch yields the first user message. */
function fakeSessionManager(firstUserText: string) {
  return {
    getBranch() {
      return [{ type: "message", message: { role: "user", content: firstUserText } }];
    },
  };
}

test("adapter: records the first user message on the first context event and leaves it in place", () => {
  const api = fakeApi();
  pinPromptExtension(api as any);
  const prompt = user("You are the feature role.");
  // First event: the prompt is first; the adapter records it and returns nothing.
  const first = api.fire([prompt, assistant("a")]);
  assert.equal(first, undefined);
  // A later event with the prompt still first: returns nothing (list unchanged, cache kept).
  assert.equal(api.fire([prompt, assistant("a"), toolResult("t")]), undefined);
});

test("adapter: puts the recorded prompt back at the front after a compaction displaced it", () => {
  const api = fakeApi();
  pinPromptExtension(api as any);
  const prompt = user("You are the feature role. Always kill by PID.");
  // First event records the prompt (it is first).
  api.fire([prompt, assistant("a")]);
  // A later event after compaction: the summary is first, the prompt is gone.
  const summary = compactionSummary("Summary…");
  const result = api.fire([summary, assistant("a")])!;
  assert.deepEqual(result.messages, [prompt, summary, assistant("a")]);
});

test("adapter: a resumed session (a new process) recovers the prompt from the session manager", () => {
  const api = fakeApi();
  pinPromptExtension(api as any);
  // A resumed session whose first context event already has a compaction summary first, with
  // the original prompt no longer in the messages. The adapter recovers it from the branch.
  const summary = compactionSummary("Summary of the earlier session…");
  const ctx = { sessionManager: fakeSessionManager("You are the feature role.") };
  const first = api.fire([summary, assistant("a")], ctx);
  assert.equal(first, undefined);
  // The prompt is now recorded; a subsequent event that still starts with the summary
  // re-inserts it at the front.
  const second = api.fire([summary, assistant("a"), toolResult("t")], ctx)!;
  const expected = [
    { role: "user", content: "You are the feature role." },
    summary,
    assistant("a"),
    toolResult("t"),
  ];
  assert.deepEqual(second.messages, expected);
});

test("adapter: never throws into pi — a missing handler or unreadable session leaves messages untouched", () => {
  const api = fakeApi();
  pinPromptExtension(api as any);
  // No user message on the first event and no session manager: the adapter records nothing
  // and returns undefined (it logged one line to stderr rather than throwing).
  const result = api.fire([assistant("a"), toolResult("t")]);
  assert.equal(result, undefined);
  // A later event is also left untouched.
  assert.equal(api.fire([assistant("a")]), undefined);
});

test("adapter: a handler that throws never throws into pi", () => {
  // A list whose first message has an unexpected content shape that messageText would
  // mishandle does not crash: the adapter catches the error and returns undefined.
  const api = fakeApi();
  pinPromptExtension(api as any);
  const weird = { role: "user" as const, content: 42 };
  const result = api.fire([weird, assistant("a")]);
  assert.equal(result, undefined);
});
