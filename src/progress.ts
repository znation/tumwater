import fs from "node:fs";
import path from "node:path";
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
  /** Short human label of the most recent tool call, e.g. `bash npm test`. */
  lastTool?: string;
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
interface TailState {
  dev: number;
  ino: number;
  /** Byte offset already consumed, always at a line boundary. */
  offset: number;
  progress: LiveProgress;
}

const tails = new Map<string, TailState>();
/** Safety cap so the cache can never grow unbounded (e.g. many short-lived roots in tests).
 * Evicting only costs one reseed scan per role on the next poll. */
const MAX_TAILS = 64;

function freshProgress(quietMs: number): LiveProgress {
  return { turns: 0, toolCalls: 0, contextTokens: 0, quietMs };
}

/** One-line description of a tool call from its name and args. */
export function describeToolCall(toolName: string, args: unknown): string {
  let detail = "";
  if (args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    const candidate = a.path ?? a.file_path ?? a.command ?? a.cmd ?? a.pattern ?? a.url;
    if (typeof candidate === "string") {
      detail = candidate === a.path || candidate === a.file_path ? path.basename(candidate) : candidate;
    }
  }
  detail = detail.replace(/\s+/g, " ").trim();
  if (detail.length > 32) detail = detail.slice(0, 31) + "…";
  return detail ? `${toolName} ${detail}` : toolName;
}

/** Apply one raw log line to a progress object (mutates it). Non-JSON noise is skipped. */
function feedLine(progress: LiveProgress, line: string): void {
  if (!line.trim()) return;
  let event: {
    type?: string;
    toolName?: string;
    args?: unknown;
    message?: { role?: string; usage?: { totalTokens?: number } };
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
      progress.lastTool = undefined;
      break;
    case "tool_execution_start":
      progress.toolCalls += 1;
      if (event.toolName) progress.lastTool = describeToolCall(event.toolName, event.args);
      break;
    case "message_end":
      if (event.message?.role === "assistant") {
        progress.turns += 1;
        progress.contextTokens = event.message.usage?.totalTokens ?? progress.contextTokens;
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

/** Read [offset, size) and split into complete lines. `end` is the offset just past the
 * last newline: a trailing partial line (torn write in flight) is NOT consumed, so it is
 * re-read next poll once pi has written its newline instead of being parsed torn or lost.
 * Shared by readLiveProgress's incremental tail and the CLI's `logs -f` follow loop. */
export function readCompleteLines(file: string, offset: number, size: number): { lines: string[]; end: number } {
  const len = size - offset;
  if (len <= 0) return { lines: [], end: offset };
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(len);
    const got = fs.readSync(fd, buf, 0, len, offset);
    if (got <= 0) return { lines: [], end: offset }; // Shrank under us; caller reseeds next poll.
    let complete = got;
    if (buf[got - 1] !== 10) {
      const lastNl = buf.lastIndexOf(10, got - 1);
      if (lastNl < 0) return { lines: [], end: offset }; // No newline yet; wait for the rest.
      complete = lastNl + 1;
    }
    const text = buf.toString("utf8", 0, complete);
    return { lines: text.split("\n"), end: offset + complete };
  } finally {
    fs.closeSync(fd);
  }
}

/** Live progress for a loop's in-flight tick, or null when there is no log yet.
 * The raw log is append-only while pi runs (and each run starts with a `session` event),
 * so after seeding from the tail window once we only read and parse bytes appended since
 * the last poll — observers that call this every second (TUI, GUI) stop rescanning up to
 * TAIL_BYTES of JSON per role per poll. */
export function readLiveProgress(root: string, role: string): LiveProgress | null {
  const file = piLogPath(root, role);
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    tails.delete(file); // Missing (or vanished) — drop any stale state.
    return null;
  }
  const quietMs = Math.max(0, Date.now() - st.mtimeMs);

  let tail = tails.get(file);
  if (!tail || tail.dev !== st.dev || tail.ino !== st.ino || st.size < tail.offset) {
    // First observation, rotation (rename + new file), or a shrunken file: seed from the
    // tail window. A leading partial line is unparseable and skipped by feedLine.
    const offset = Math.max(0, st.size - TAIL_BYTES);
    const progress = freshProgress(quietMs);
    const { lines, end } = readCompleteLines(file, offset, st.size);
    for (const line of lines) feedLine(progress, line);
    tail = { dev: st.dev, ino: st.ino, offset: end, progress };
    if (tails.size >= MAX_TAILS) tails.clear();
    tails.set(file, tail);
  } else if (st.size > tail.offset) {
    // Append-only growth since the last poll: parse only the new bytes.
    const { lines, end } = readCompleteLines(file, tail.offset, st.size);
    for (const line of lines) feedLine(tail.progress, line);
    tail.offset = end;
  }

  tail.progress.quietMs = quietMs;
  return { ...tail.progress };
}
