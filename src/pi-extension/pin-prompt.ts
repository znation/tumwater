/**
 * Bundled pi extension: pins the run's prompt verbatim at the front of the conversation across
 * every compaction. Loaded last on every pi run via `-e <this file>` from src/pi/pi-args.ts,
 * after context-shake and context-budget.
 *
 * Why: tumwater sends the entire run prompt, with every rule, as the first user message. pi's
 * compaction summarizes that message like any other (pi docs, compaction.md "How It
 * Works"): after one LLM summary roughly half of a rule set survives, and after five only 10%
 * ("The Compaction Cliff", arXiv 2608.22752). After this extension a compacted run still sees
 * the kill-by-PID rule, the test-runner rule, and the write rules exactly as written.
 *
 * Mechanism: on the first `context` event of a session the extension records the first user
 * message (the run prompt) verbatim. On every later `context` event, if that message is no
 * longer first, it puts the recorded message back at the front; if it is still first it returns
 * nothing, so the list is unchanged and the cache prefix is kept. The re-inserted message is
 * the same bytes every time, so after compaction the prefix is stable and caches as well as
 * before. A resumed session (`--continue`, a new process) recovers the prompt from the first
 * user message on the branch via `ctx.sessionManager`. The extension never throws into pi.
 *
 * The pinning logic is a pure, exported function (`pinPrompt`) so it is unit-testable without
 * pi, the same pattern context-budget uses with `contextNote`.
 */

import { messageText } from "./message-text.js";

/** A minimal structural type for the message objects the pure function reads. */
interface PinMessage {
  role?: string;
  content: unknown;
}

/**
 * The pure pinning logic: given the current conversation messages and the recorded prompt
 * message, return the messages with the prompt re-inserted at the front, or null if it is
 * already first. Re-inserting is idempotent: any prior copy of the prompt is removed so it
 * never appears twice.
 */
export function pinPrompt(messages: PinMessage[], prompt: PinMessage): PinMessage[] | null {
  const promptText = messageText(prompt);
  if (messages.length > 0) {
    const first = messages[0]!;
    if (first.role === "user" && messageText(first) === promptText) return null;
  }
  const filtered = messages.filter(
    (m) => !(m.role === "user" && messageText(m) === promptText),
  );
  return [prompt, ...filtered];
}

/**
 * Find the first user message in a message list, or null if none. Used by the adapter to
 * identify the run prompt on the first `context` event.
 */
export function firstUserMessage(messages: PinMessage[]): PinMessage | null {
  for (const msg of messages) {
    if (msg.role === "user") return msg;
  }
  return null;
}

/** A structural type for the session manager's branch entries, matching pi's SessionEntry. */
interface BranchEntry {
  type?: string;
  message?: { role?: string; content: unknown };
}

/** A minimal structural type for the session manager the adapter reads. */
interface SessionManagerLike {
  getBranch?(): BranchEntry[];
}

/** A minimal structural type for pi's extension context. */
interface PinPromptContext {
  sessionManager?: SessionManagerLike;
}

/** A minimal structural type for pi's context event. */
interface ContextEvent {
  messages?: PinMessage[];
}

/** The pi extension API surface this extension uses. */
interface PiExtensionApi {
  on(
    event: "context",
    handler: (
      event: ContextEvent,
      ctx?: PinPromptContext,
    ) => { messages: PinMessage[] } | undefined,
  ): void;
}

/**
 * The pi extension entry point: pin the run's prompt at the front of the conversation across
 * every compaction. On the first `context` event it records the first user message. On each
 * later event it puts the recorded message back at the front if a compaction displaced it.
 */
export default function pinPromptExtension(pi: PiExtensionApi): void {
  let prompt: PinMessage | null = null;
  let contextFired = false;

  pi.on("context", (event, ctx) => {
    const messages = event.messages;
    if (!messages) return undefined;

    try {
      if (!contextFired) {
        // First context event of this session: record the run prompt verbatim from the first
        // user message on the branch via the session manager (per the plan). The original
        // prompt entry stays on the branch even after a compaction — a resumed session
        // (--continue, a new process) recovers it from there. When the session manager is
        // absent (an unreadable session) fall back to the first user message in the
        // conversation, which is the run prompt for a fresh session.
        const branch = ctx?.sessionManager?.getBranch?.();
        for (const entry of branch ?? []) {
          if (entry.type === "message" && entry.message?.role === "user") {
            prompt = entry.message;
            break;
          }
        }
        if (!prompt) prompt = firstUserMessage(messages);
        if (!prompt) {
          // No user message found (e.g., an unreadable session): leave the messages
          // untouched and log one line to stderr rather than throw into pi.
          process.stderr.write("[tumwater pin-prompt] no user message found; prompt not pinned\n");
        }
        contextFired = true;
        return undefined;
      }

      if (!prompt) return undefined;
      const result = pinPrompt(messages, prompt);
      if (!result) return undefined;
      return { messages: result };
    } catch (err) {
      process.stderr.write(
        `[tumwater pin-prompt] ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return undefined;
    }
  });
}
