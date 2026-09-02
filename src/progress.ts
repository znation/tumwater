import { piEventType } from "./pi.js";
import { collapseWhitespace, truncate } from "./text.js";
import { describeToolCall } from "./tool-call.js";
import { statRoleLog, TailState, withTail } from "./tail.js";

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
    const collapsed = collapseWhitespace(block.text);
    if (!collapsed) continue;
    return truncate(collapsed, WORK_ITEM_MAX);
  }
  return undefined;
}

/** The state of a pi run at time zero — every run-scoped field at its initial value. This is
 * the single definition of "fresh": first observation and rotation seed from it (withTail),
 * and a `session` event restores exactly it (feedLine) — so adding a field to LiveProgress
 * updates both places automatically instead of drifting apart. */
function freshProgress(quietMs: number): LiveProgress {
  return {
    turns: 0,
    toolCalls: 0,
    contextTokens: 0,
    outputTokens: 0,
    peakContextTokens: 0,
    lastTool: undefined,
    currentWork: undefined,
    quietMs,
  };
}

/** The event types feedLine acts on — everything else (streaming deltas, turn/agent
 * bookkeeping) is ignored. Also used by feedLine's pre-filter to skip JSON.parse for pi lines
 * whose type is verifiably not one of these; a new case in the switch must be added here too.
 */
const PROGRESS_TYPES = new Set(["session", "tool_execution_start", "message_end"]);

/** Apply one raw log line to a progress object (mutates it). Non-JSON noise is skipped. */
function feedLine(progress: LiveProgress, line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  // Cheap pre-filter before JSON.parse: pi's logs are ~97% streaming delta lines
  // (message_update), which the switch below discards after parsing them. Skip the parse when
  // the line's type is verifiably not one this feedLine acts on; measured ~7ms → ~1ms per 4MB
  // seed window (the same fast path as transcript.ts's renderer, which consumes the identical
  // log).
  const type = piEventType(trimmed);
  if (type !== null && !PROGRESS_TYPES.has(type)) return;
  let event: {
    type?: string;
    toolName?: string;
    args?: unknown;
    message?: { role?: string; content?: unknown; usage?: { totalTokens?: number; output?: number } };
  };
  try {
    event = JSON.parse(trimmed);
  } catch {
    return;
  }
  switch (event.type) {
    case "session": // A new run starts: everything before it was a previous tick — restore the at-time-zero state.
      Object.assign(progress, freshProgress(progress.quietMs));
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
  const log = statRoleLog(tails, root, role);
  if (!log) return null; // No raw log yet — nothing to show.
  const quietMs = Math.max(0, Date.now() - log.st.mtimeMs);
  // Seed from the tail window; a leading partial line is unparseable and skipped by feedLine.
  const progress = withTail(
    tails,
    log.file,
    log.st,
    (size) => ({ fromOffset: Math.max(0, size - TAIL_BYTES), value: freshProgress(quietMs) }),
    feedLine,
  );
  progress.quietMs = quietMs;
  return { ...progress };
}
