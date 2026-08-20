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

/** How much log tail to scan; a tick rarely exceeds this, and stats degrade gracefully. */
const TAIL_BYTES = 4 * 1024 * 1024;

function tailLines(file: string): string[] {
  const size = fs.statSync(file).size;
  const start = Math.max(0, size - TAIL_BYTES);
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf8").split("\n");
  } finally {
    fs.closeSync(fd);
  }
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

/** Parse pi event lines (current run = after the last `session` event). Exported for tests. */
export function parseProgress(lines: string[], quietMs: number): LiveProgress {
  const progress: LiveProgress = { turns: 0, toolCalls: 0, contextTokens: 0, quietMs };
  for (const line of lines) {
    if (!line.trim()) continue;
    let event: {
      type?: string;
      toolName?: string;
      args?: unknown;
      message?: { role?: string; usage?: { totalTokens?: number } };
    };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
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
  return progress;
}

/** Live progress for a loop's in-flight tick, or null when there is no log yet. */
export function readLiveProgress(root: string, role: string): LiveProgress | null {
  const file = piLogPath(root, role);
  try {
    const quietMs = Math.max(0, Date.now() - fs.statSync(file).mtimeMs);
    return parseProgress(tailLines(file), quietMs);
  } catch {
    return null;
  }
}
