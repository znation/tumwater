import { describeToolCall } from "./tool-call.js";
import { statOrNull, TailState, withTail } from "./files.js";
import { piLogPath } from "./paths.js";

/** Live view of an in-flight tick, derived from the tail of the loop's raw pi log.
 * The log is append-only across ticks; each tick's pi run starts with a `session` event,
 * so everything after the last one belongs to the current run. */
export interface LiveProgress {
  /** Assistant turns completed so far. */
  turns: number;
  /** Tool executions started so far. */
  toolCalls: number;
  /** Context tokens of the latest assistant message. */
  contextTokens: number;
  /** Output tokens generated in this run (usage.output summed over assistant messages). */
  outputTokens: number;
  /** Largest single-request context submitted in this run (max, not sum). */
  peakContextTokens: number;
  /** Short human label of the most recent tool call, e.g. `bash npm test`. */
  lastTool?: string;
  /** What the loop is working on: first assistant text of the current run (~60 chars). */
  currentWork?: string;
  /** ms since pi last emitted anything (from file mtime). */
  quietMs: number;
}

/** How much log tail to scan when first observing a file (or after rotation); a tick
 * rarely exceeds this, and stats degrade gracefully. Steady-state polls only parse the
 * bytes appended since the previous poll, so this window is read once, not every second. */
const TAIL_BYTES = 4 * 1024 * 1024;

/** Per-file incremental state for readLiveProgress: where we last stopped reading and
 * the progress accumulated from everything read so far. Bounded by the number of distinct
 * log paths observed in this process (one root × its roles for a TUI/GUI). */
const tails = new Map<string, TailState<LiveProgress>>();

/** Max length of a captured work item, ellipsis included (~60 chars). */
const WORK_ITEM_MAX = 60;

/** First non-empty text block of an assistant message: whitespace-collapsed and truncated to
 * WORK_ITEM_MAX. Thinking/tool-call-only (or empty-text) messages yield undefined, so the
 * work item stays unset until some message actually carries text. */
function workItemFromContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const raw of content) {
    const block = raw as { type?: unknown; text?: unknown } | null;
    if (block?.type !== "text" || typeof block.text !== "string") continue;
    const collapsed = block.text.replace(/\s+/g, " ").trim();
    if (!collapsed) continue;
    return collapsed.length <= WORK_ITEM_MAX ? collapsed : `${collapsed.slice(0, WORK_ITEM_MAX - 1).trimEnd()}…`;
  }
  return undefined;
}

function freshProgress(quietMs: number): LiveProgress {
  return { turns: 0, toolCalls: 0, contextTokens: 0, outputTokens: 0, peakContextTokens: 0, quietMs };
}

/** Apply one raw log line to a progress object (mutates it). Non-JSON noise is skipped. */
function feedLine(progress: LiveProgress, line: string): void {
  if (!line.trim()) return;
  let event: {
    type?: string;
    toolName?: string;
    args?: unknown;
    message?: { role?: string; content?: unknown; usage?: { totalTokens?: number; output?: number } };
  };
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  switch (event.type) {
    case "session": // A new run starts: everything before it was a previous tick.
      progress.turns = 0;
      progress.toolCalls = 0;
      progress.contextTokens = 0;
      progress.outputTokens = 0;
      progress.peakContextTokens = 0;
      progress.lastTool = undefined;
      progress.currentWork = undefined;
      break;
    case "tool_execution_start":
      progress.toolCalls += 1;
      if (event.toolName) progress.lastTool = describeToolCall(event.toolName, event.args);
      break;
    case "message_end":
      if (event.message?.role === "assistant") {
        progress.turns += 1;
        const usage = event.message.usage;
        if (usage) {
          progress.contextTokens = usage.totalTokens ?? progress.contextTokens;
          progress.outputTokens += usage.output ?? 0;
          progress.peakContextTokens = Math.max(progress.peakContextTokens, usage.totalTokens ?? 0);
        }
        // The first text the loop speaks in this run is its work item ("I'll implement plan X");
        // later messages never replace it.
        if (!progress.currentWork) progress.currentWork = workItemFromContent(event.message.content);
      }
      break;
  }
}

/** Parse pi event lines (current run = after the last `session` event). Exported for tests. */
export function parseProgress(lines: string[], quietMs: number): LiveProgress {
  const progress = freshProgress(quietMs);
  for (const line of lines) feedLine(progress, line);
  return progress;
}

/** Live progress for a loop's in-flight tick, or null when there is no log yet.
 * The raw log is append-only while pi runs (and each run starts with a `session` event),
 * so after seeding from the tail window once we only read and parse bytes appended since
 * the last poll — observers that call this every second (TUI, GUI) stop rescanning up to
 * TAIL_BYTES of JSON per role per poll. */
export function readLiveProgress(root: string, role: string): LiveProgress | null {
  const file = piLogPath(root, role);
  const st = statOrNull(file);
  if (!st) {
    tails.delete(file); // Missing (or vanished) — drop any stale state.
    return null;
  }
  const quietMs = Math.max(0, Date.now() - st.mtimeMs);
  // Seed from the tail window; a leading partial line is unparseable and skipped by feedLine.
  const progress = withTail(
    tails,
    file,
    st,
    (size) => ({ fromOffset: Math.max(0, size - TAIL_BYTES), value: freshProgress(quietMs) }),
    feedLine,
  );
  progress.quietMs = quietMs;
  return { ...progress };
}
