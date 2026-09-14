import { applyToolExecutionEvent, parsePiEventLine, type OpenToolCall } from "../pi-event-line.js";
import { collapseWhitespace, describeToolCall, truncate } from "../text.js";
import { defaultConfig, loadConfigCached } from "../config.js";
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
  /** Tool calls started but not yet ended in this run (pi runs a message's tool calls
   * concurrently by default), keyed by pi's toolCallId. lastActivityAt moves only on
   * content-bearing updates, so a hung command's entry goes stale while its siblings keep
   * streaming — readLiveProgress turns the first one past the configured stall threshold into
   * stalledTool. Tail state like every other field: freshProgress restores it to undefined. */
  openToolCalls?: OpenToolCall[];
  /** What the loop is working on: first assistant text of the current run (~60 chars). */
  currentWork?: string;
  /** ms since pi last emitted anything (from file mtime). */
  quietMs: number;
  /** The first open tool call that has been silent for at least the configured stall
   * threshold — the in-flight cell's "tool call stalled" flag names it. Derived, not folded:
   * silence is a property of wall-clock time, so readLiveProgress recomputes it on every read
   * (like quietMs) instead of feedLine setting it from any single line. */
  stalledTool?: string;
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
    // Run-scoped like the rest (a `session` event restores it to "no calls tracked").
    // stalledTool is deliberately NOT part of fresh: it is derived from wall-clock time on
    // every read, never folded from lines.
    openToolCalls: undefined,
    currentWork: undefined,
    quietMs,
  };
}

/** The event types feedLine acts on — everything else (streaming deltas, turn/agent
 * bookkeeping) is ignored. Also passed as parsePiEventLine's pre-filter to skip JSON.parse for
 * pi lines whose type is verifiably not one of these; a new case in the switch must be added
 * here too. */
const PROGRESS_TYPES = new Set([
  "session",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "message_end",
]);

/** The fields feedLine reads off a parsed progress event (a structural subset of pi's JSON). */
interface ProgressEvent {
  type?: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  partialResult?: unknown;
  message?: { role?: string; content?: unknown; usage?: { totalTokens?: number; output?: number } };
}

/** Apply one raw log line to a progress object (mutates it). Non-JSON noise is skipped. */
function feedLine(progress: LiveProgress, line: string): void {
  const event = parsePiEventLine<ProgressEvent>(line, PROGRESS_TYPES);
  if (!event) return; // Blank, unparseable, or a type this feed does not act on.
  switch (event.type) {
    case "session": // A new run starts: everything before it was a previous tick — restore the at-time-zero state.
      Object.assign(progress, freshProgress(progress.quietMs));
      break;
    case "tool_execution_start": {
      progress.toolCalls += 1;
      const label = event.toolName ? describeToolCall(event.toolName, event.args) : undefined;
      if (label) progress.lastTool = label;
      // Track the open call for the stall flag — pi runs a message's tool calls concurrently
      // by default, so several can be open at once and end in completion order. The state
      // machine is shared with runPi's warning (pi.ts); only the fallback label differs here.
      applyToolExecutionEvent(
        progress.openToolCalls ??= [],
        event.type,
        event.toolCallId,
        event.partialResult,
        label ?? "tool",
      );
      break;
    }
    case "tool_execution_update": {
      // Only content-bearing updates prove the command is alive — bash emits one empty-content
      // update right after start, and a content-free keepalive must not mask a hang.
      if (progress.openToolCalls)
        applyToolExecutionEvent(progress.openToolCalls, event.type, event.toolCallId, event.partialResult);
      break;
    }
    case "tool_execution_end": {
      if (progress.openToolCalls)
        applyToolExecutionEvent(progress.openToolCalls, event.type, event.toolCallId, event.partialResult);
      break;
    }
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
  // Freshly fed lines stamp Date.now(), so nothing is stalled right after parsing — the flag
  // exists here so callers that pass a hand-built tail through workingDetail see the same
  // shape readLiveProgress returns.
  progress.stalledTool = stalledToolLabel(progress.openToolCalls);
  return progress;
}

/** The configured threshold for flagging an open tool call as stalled, in ms (0 when
 * disabled) — the same value runPi's stall warning uses, so the state cell and the event feed
 * agree on "stalled". Resolved through loadConfigCached: stat-keyed, so an unedited
 * tumwater.json costs one stat per poll. */
export function toolCallStallMs(root: string): number {
  const loaded = loadConfigCached(root);
  const seconds = loaded.config?.toolCallStallSeconds ?? defaultConfig().toolCallStallSeconds;
  return Math.max(0, seconds) * 1000;
}

/** The label of the first open tool call that has been silent for at least `stallMs` — the
 * in-flight cell's stall flag. Silence is a property of wall-clock time, not of any single
 * line, so this runs on every read rather than in feedLine; `now` and `stallMs` are injectable
 * for tests (freshly fed lines stamp Date.now(), so nothing is stalled right after parsing). */
export function stalledToolLabel(
  open: LiveProgress["openToolCalls"],
  now = Date.now(),
  stallMs = defaultConfig().toolCallStallSeconds * 1000,
): string | undefined {
  if (!open || stallMs <= 0) return undefined;
  for (const call of open) {
    if (now - call.lastActivityAt >= stallMs) return call.label;
  }
  return undefined;
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
  // The stall flag is derived from wall-clock time (like quietMs), not folded from lines —
  // recomputed on every read with the configured threshold. A call already open when this
  // observer first saw the log stamps "now" at seed, so it cannot be flagged retroactively;
  // the mtime-based "no pi output" flag covers late observers.
  progress.stalledTool = stalledToolLabel(progress.openToolCalls, Date.now(), toolCallStallMs(root));
  // Copy the open-call entries: feedLine mutates the stored tail value in place — an
  // un-copied collection would alias one mutable structure across every frame ever returned
  // AND with the live tail state.
  return {
    ...progress,
    openToolCalls: progress.openToolCalls ? progress.openToolCalls.map((c) => ({ ...c })) : undefined,
  };
}
