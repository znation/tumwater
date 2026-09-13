import { parsePiEventLine } from "../pi-event-line.js";
import { collapseWhitespace, truncate } from "../text.js";
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
  /** Output-token samples for the trailing rate window: one per assistant message_end with
   * usage.output > 0, stamped with the line's own timestamp (parse time when absent).
   * Tail state like every other field — not display data; tokenRate() derives the moving
   * average. Optional and lazily initialized in feedLine so freshProgress can omit it: a
   * `session` event restores freshProgress via Object.assign and must NOT clear the ring,
   * because the window legitimately spans tick boundaries (back-to-back ticks, review runs). */
  samples?: Array<{ t: number; tokens: number }>;
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

/** The trailing window for the per-loop token generation rate (one opinionated default —
 * no knob): output tokens over the last five minutes, smoothed to hide turn granularity and
 * tool-call gaps. */
export const TOKEN_RATE_WINDOW_MS = 5 * 60_000;

/** Moving-average output-token rate: the sum of samples stamped in [now − window, now]
 * divided by min(window, elapsed since the oldest such sample). Dividing a young window by
 * its own span — not the full five minutes — converges to the true rate immediately and
 * becomes exactly the five-minute moving average once samples span the whole window. Null
 * when there are no in-window samples or their span is under a second (a sub-second
 * division would be a meaningless spike, e.g. one sample stamped by the parse-time fallback). */
export function tokenRate(samples: Array<{ t: number; tokens: number }>, now: number): number | null {
  const inWindow = samples.filter((s) => s.t >= now - TOKEN_RATE_WINDOW_MS && s.t <= now);
  if (inWindow.length === 0) return null;
  const oldest = Math.min(...inWindow.map((s) => s.t));
  const elapsed = now - oldest;
  if (elapsed < 1000) return null; // Minimum-span guard: no rate until the window has a second of span.
  const total = inWindow.reduce((sum, s) => sum + s.tokens, 0);
  // Tokens per SECOND: the span is in ms.
  return (total * 1000) / Math.min(TOKEN_RATE_WINDOW_MS, elapsed);
}

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
 * bookkeeping) is ignored. Also passed as parsePiEventLine's pre-filter to skip JSON.parse for
 * pi lines whose type is verifiably not one of these; a new case in the switch must be added
 * here too. */
const PROGRESS_TYPES = new Set(["session", "tool_execution_start", "message_end"]);

/** The fields feedLine reads off a parsed progress event (a structural subset of pi's JSON). */
interface ProgressEvent {
  type?: string;
  toolName?: string;
  args?: unknown;
  // pi stamps every assistant message with an epoch-ms timestamp at creation; the rate
  // window keys off it (parse time is only the fallback for malformed or legacy lines).
  message?: { role?: string; content?: unknown; usage?: { totalTokens?: number; output?: number }; timestamp?: number };
}

/** Apply one raw log line to a progress object (mutates it). Non-JSON noise is skipped. */
function feedLine(progress: LiveProgress, line: string): void {
  const event = parsePiEventLine<ProgressEvent>(line, PROGRESS_TYPES);
  if (!event) return; // Blank, unparseable, or a type this feed does not act on.
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
          // Rate sample: one per assistant message with real output, stamped with the line's
          // own timestamp so a reseeded tail rebuilds the window from history.
          const out = usage.output ?? 0;
          if (out > 0) {
            const t = typeof event.message.timestamp === "number" ? event.message.timestamp : Date.now();
            (progress.samples ??= []).push({ t, tokens: out });
            // Prune what has aged out of the window — the ring is bounded by a window's worth
            // of assistant messages, not by run length.
            const cutoff = Date.now() - TOKEN_RATE_WINDOW_MS;
            progress.samples = progress.samples.filter((s) => s.t >= cutoff);
          }
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
  // Copy the sample ring: feedLine mutates the stored tail value in place, and every other
  // LiveProgress field is a scalar — an un-copied array would alias one mutable ring across
  // every frame ever returned AND with the live tail state.
  return { ...progress, samples: progress.samples ? [...progress.samples] : undefined };
}
