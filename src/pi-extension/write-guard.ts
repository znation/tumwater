/**
 * Bundled pi extension: refuse an `edit` or `write` that would land under the team root but
 * outside the run's own worktree, and name the path inside the worktree to use instead. Loaded on
 * every pi run via `-e <this file>` from src/pi/pi-args.ts.
 *
 * The rule lives in src/agent/write-guard.ts, shared with claude's hook. This file is the thin
 * adapter over pi's `tool_call` event, which blocks a call when a handler returns
 * `{ block: true, reason }` (pi docs, extensions.md "Events and concurrency"); the model gets the
 * reason as the tool's error. A nested call from a codemode script goes through the same event.
 * pi blocks the tool when a handler throws, so an unexpected failure here lets the write through
 * rather than stopping every edit of the run: runner-run.ts's stray-write warning still sees it.
 */

import { strayWriteRefusal } from "../agent/write-guard.js";

/** The file-writing tools pi ships, by the name a `tool_call` event carries. Both take `path`. */
const WRITE_TOOLS = new Set(["edit", "write"]);

/** Minimal structural types for pi's extension API: pi itself loads this file, so the real types
 * stay out of the dependency tree. */
interface ToolCallLikeEvent {
  toolName?: unknown;
  input?: unknown;
}

interface ToolCallContext {
  cwd?: unknown;
}

interface PiExtensionApi {
  on(
    event: "tool_call",
    handler: (event: ToolCallLikeEvent, ctx?: ToolCallContext) => { block: true; reason: string } | undefined,
  ): void;
}

/** The refusal for one `tool_call` event, or undefined to let it run. Exported for tests. */
export function guardToolCall(event: ToolCallLikeEvent, cwd: string): { block: true; reason: string } | undefined {
  if (typeof event.toolName !== "string" || !WRITE_TOOLS.has(event.toolName)) return undefined;
  const input = event.input;
  if (typeof input !== "object" || input === null) return undefined;
  const target = (input as { path?: unknown }).path;
  if (typeof target !== "string" || target === "") return undefined;
  try {
    const reason = strayWriteRefusal(target, cwd);
    return reason === null ? undefined : { block: true, reason };
  } catch {
    return undefined;
  }
}

/** The pi extension entry point. */
export default function writeGuard(pi: PiExtensionApi): void {
  pi.on("tool_call", (event, ctx) => guardToolCall(event, typeof ctx?.cwd === "string" ? ctx.cwd : process.cwd()));
}
