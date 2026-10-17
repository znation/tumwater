// vocabulary: plain
/**
 * Bundled pi extension: on a model with a small context window, send none of the model's earlier
 * thinking back to it. Loaded on every pi run via `-e <this file>` from src/pi/pi-args.ts.
 *
 * Why: pi replays each earlier assistant message's thinking with the message (as
 * `reasoning_content` on a chat-completions API), and the Qwen3.8-27B chat template renders it
 * for every turn after the last user message, which in a run is every turn. Measured 2026-10-17 on
 * the local Qwen (llama-server) over 12 replays of two real feature runs: the old thinking was
 * 18–31% of the final context; runs that kept it crossed 48k tokens (a 64k window minus pi's 16k
 * compaction reserve) in 4 of 6, runs that stripped it in 0 of 6, and all 12 finished and passed
 * the project's check. One of the two tasks took more turns without its thinking (40 requests
 * against 32), so the saving is not free.
 *
 * All of it, not "all but the newest": on a hybrid recurrent model (48 of Qwen3.8's 64 layers)
 * llama.cpp can only rewind its prompt cache to a saved checkpoint and drops the checkpoints past
 * the rollback point, so stripping a message one turn further back on each request made the server
 * re-read nearly the whole transcript every time (893k prompt tokens against 32k). With every
 * thought stripped, each request differs from the last only in the newest assistant message, which
 * starts right at the previous request's end-of-prompt checkpoint.
 *
 * When: only when the model declares a context window of at most STRIP_THINKING_MAX_WINDOW, where
 * the space decides whether a run fits. A 1M-window model keeps the thinking its vendor asks for
 * (DeepSeek, GLM and MiniMax document their models as trained to see it during tool calls), and
 * there the replay is mostly cheap cached tokens. And only on the `openai-completions` API, where
 * the thought is a plain text field: the Anthropic API (and Gemini's, for its newer models) can
 * require its signed thinking back during tool use and reject a turn without it.
 *
 * pi's `context` event transforms the messages of one request only (pi docs, extensions.md
 * "Events and concurrency"), so the session file keeps the full thinking — the 2026-10-17 strip
 * runs still recorded every thought — and only what the model is sent changes. The rule and the
 * edit are pure exported functions
 * so they are unit-testable without pi; the default export is the thin adapter over pi's `context`
 * event and `ctx.model`.
 */

import { declaredWindow } from "./context-window.js";

/** The largest declared context window, in tokens, that gets its replayed thinking stripped:
 * 256k (256 × 1024), so a model declaring Qwen's native 262,144 still counts. */
export const STRIP_THINKING_MAX_WINDOW = 262_144;

/** The one pi API whose replayed thinking is a plain, unsigned text field. */
export const STRIP_THINKING_API = "openai-completions";

/** The fields of pi's model that the rule reads. */
interface ModelLike {
  api?: unknown;
  contextWindow?: unknown;
}

/** Whether a run on `model` should have its replayed thinking stripped: a chat-completions
 * model that declares a positive context window of at most STRIP_THINKING_MAX_WINDOW. An unknown
 * model, API or window (missing, non-finite, negative, zero) keeps the thinking. Pure. */
export function stripsThinking(model: ModelLike | undefined): boolean {
  if (model?.api !== STRIP_THINKING_API) return false;
  const window = declaredWindow(model.contextWindow);
  return window !== null && window <= STRIP_THINKING_MAX_WINDOW;
}

/** One content block of an assistant message, as far as the edit needs to see it. */
interface ContentBlock {
  type?: unknown;
}

/** One message of pi's request context, as far as the edit needs to see it. */
export interface MessageLike {
  role?: unknown;
  content?: unknown;
}

/** `messages` with every thinking block removed from every assistant message, or null when there
 * was none to remove (so the caller can leave pi's context untouched). Messages with no thinking
 * are passed through as the same objects, and the input is never mutated. A message left with no
 * content at all is kept: pi's chat-completions converter already skips an assistant message with
 * neither content nor tool calls. Pure. */
export function stripThinking<M extends MessageLike>(messages: readonly M[]): M[] | null {
  let changed = false;
  const out = messages.map((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return message;
    const blocks = message.content as ContentBlock[];
    const kept = blocks.filter((block) => block?.type !== "thinking");
    if (kept.length === blocks.length) return message;
    changed = true;
    return { ...message, content: kept };
  });
  return changed ? out : null;
}

/** Minimal structural types for pi's extension API — pi itself loads this file, so the real
 * types are not needed at compile time and stay out of the dependency tree. */
interface ContextEventLike {
  messages?: MessageLike[];
}

interface ContextLike {
  model?: ModelLike;
}

interface PiExtensionApi {
  on(
    event: "context",
    handler: (event: ContextEventLike, ctx?: ContextLike) => { messages: MessageLike[] } | undefined,
  ): void;
}

/** The pi extension entry point: before each model request on a qualifying model, replace the
 * request's messages with a copy that carries no thinking. The model is read per request, so a
 * mid-session model change is honored. */
export default function stripThinkingExtension(pi: PiExtensionApi): void {
  pi.on("context", (event, ctx) => {
    if (!stripsThinking(ctx?.model) || !Array.isArray(event.messages)) return undefined;
    const messages = stripThinking(event.messages);
    return messages ? { messages } : undefined;
  });
}
