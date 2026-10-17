import test from "node:test";
import assert from "node:assert/strict";
import {
  STRIP_THINKING_API,
  STRIP_THINKING_MAX_WINDOW,
  default as stripThinkingExtension,
  stripThinking,
  stripsThinking,
  type MessageLike,
} from "../src/pi-extension/strip-thinking.js";

// The bundled strip-thinking extension (src/pi-extension/strip-thinking.ts): on a small-window
// chat-completions model, no request carries the model's earlier thinking, so replayed thoughts
// stop filling the window — and, because every thought goes (not all but the newest), the history
// a request sends stays a prefix of the next one's, which keeps llama.cpp's prompt cache usable on
// the hybrid recurrent Qwen.

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (thinking: string, call: string) => ({
  role: "assistant",
  content: [
    { type: "thinking", thinking, thinkingSignature: "reasoning_content" },
    { type: "toolCall", id: call, name: "bash", arguments: { command: "ls" } },
  ],
});
const toolResult = (call: string, text: string) => ({
  role: "toolResult",
  toolCallId: call,
  content: [{ type: "text", text }],
});

test("stripsThinking holds for a chat-completions model at or under the 256k window", () => {
  for (const contextWindow of [32_768, 126_928, 131_072, 258_000, STRIP_THINKING_MAX_WINDOW]) {
    assert.equal(stripsThinking({ api: STRIP_THINKING_API, contextWindow }), true, String(contextWindow));
  }
  assert.equal(STRIP_THINKING_MAX_WINDOW, 256 * 1024);
});

test("stripsThinking keeps the thinking of a large-window model", () => {
  for (const contextWindow of [STRIP_THINKING_MAX_WINDOW + 1, 1_048_576]) {
    assert.equal(stripsThinking({ api: STRIP_THINKING_API, contextWindow }), false, String(contextWindow));
  }
});

test("stripsThinking keeps signed thinking on every other API, whatever the window", () => {
  // Anthropic (and Gemini's newer models) can reject a tool-use turn without its signed
  // thinking.
  for (const api of ["anthropic-messages", "google-generative-ai", "openai-responses", undefined]) {
    assert.equal(stripsThinking({ api, contextWindow: 200_000 }), false, String(api));
  }
});

test("stripsThinking keeps the thinking when the model or its window is unknown or unusable", () => {
  assert.equal(stripsThinking(undefined), false);
  assert.equal(stripsThinking({ api: STRIP_THINKING_API }), false);
  for (const contextWindow of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "131072", null]) {
    assert.equal(stripsThinking({ api: STRIP_THINKING_API, contextWindow }), false, String(contextWindow));
  }
});

test("stripThinking removes every thinking block, the newest message's included", () => {
  const messages = [user("go"), assistant("first thought", "a"), toolResult("a", "x.txt"), assistant("second thought", "b")];
  const out = stripThinking(messages);
  assert.ok(out);
  assert.deepEqual(
    out.map((m) => (Array.isArray(m.content) ? m.content.map((c) => c.type) : m.content)),
    [["text"], ["toolCall"], ["text"], ["toolCall"]],
  );
  // Text and tool calls survive in order; only thinking goes.
  assert.deepEqual(out[3]!.content, [messages[3]!.content[1]]);
});

test("stripThinking passes untouched messages through as the same objects and never mutates", () => {
  const messages = [user("go"), assistant("thought", "a"), toolResult("a", "out")];
  const before = structuredClone(messages);
  const out = stripThinking(messages)!;
  assert.equal(out[0], messages[0]);
  assert.equal(out[2], messages[2]);
  assert.notEqual(out[1], messages[1]);
  assert.deepEqual(messages, before, "the input array and its messages are unchanged");
});

test("stripThinking returns null when no message carries thinking", () => {
  const plain = { role: "assistant", content: [{ type: "text", text: "done" }] };
  assert.equal(stripThinking([user("go"), plain, toolResult("a", "out")]), null);
  assert.equal(stripThinking([]), null);
  // A string or missing content is not a block list and is left alone.
  assert.equal(stripThinking([{ role: "assistant", content: "plain" }, { role: "assistant" }]), null);
});

test("stripThinking leaves an assistant message that only thought with empty content", () => {
  // pi's chat-completions converter skips an assistant message with neither content nor tool calls.
  const out = stripThinking([user("go"), { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] }]);
  assert.deepEqual(out?.[1], { role: "assistant", content: [] });
});

test("each request's stripped history is a prefix of the next request's", () => {
  // The cache property behind stripping every thought: request k+1 only appends to request k.
  // Keeping the newest thought would fail this — the message that was newest in request k loses
  // its thinking in request k+1, an edit one turn further back on every request.
  const history: MessageLike[] = [user("go")];
  let previous: MessageLike[] | null = null;
  for (let k = 0; k < 5; k++) {
    history.push(assistant(`thought ${k}`, `c${k}`), toolResult(`c${k}`, `result ${k}`));
    const sent = stripThinking(history)!;
    if (previous) assert.deepEqual(sent.slice(0, previous.length), previous, `request ${k}`);
    previous = sent;
  }
});

type ContextHandler = (
  event: { messages?: MessageLike[] },
  ctx?: { model?: { api?: unknown; contextWindow?: unknown } },
) => { messages: MessageLike[] } | undefined;

function loadHandler(): ContextHandler {
  let handler: ContextHandler | undefined;
  stripThinkingExtension({
    on(event, fn) {
      assert.equal(event, "context");
      handler = fn as ContextHandler;
    },
  });
  assert.ok(handler, "the extension registers a context handler");
  return handler;
}

test("the extension strips a qualifying model's request and leaves the rest alone", () => {
  const handler = loadHandler();
  const messages = [user("go"), assistant("thought", "a"), toolResult("a", "out")];
  const small = { model: { api: STRIP_THINKING_API, contextWindow: 131_072 } };
  const result = handler({ messages }, small);
  assert.deepEqual(result?.messages[1]?.content, [messages[1]!.content[1]]);
  assert.equal(handler({ messages }, { model: { api: STRIP_THINKING_API, contextWindow: 1_048_576 } }), undefined);
  assert.equal(handler({ messages }, { model: { api: "anthropic-messages", contextWindow: 200_000 } }), undefined);
  assert.equal(handler({ messages }, undefined), undefined, "no model: keep the thinking");
  assert.equal(handler({ messages: [user("go")] }, small), undefined, "nothing to strip: context untouched");
  assert.equal(handler({}, small), undefined, "no message list: context untouched");
});
