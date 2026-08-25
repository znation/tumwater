import fs from "node:fs";
import { readCompleteLines } from "./files.js";
import { piLogPath } from "./paths.js";
import { describeToolCall } from "./progress.js";

/** A rendered transcript entry: the lines for one assistant turn (optionally prefixed by its
 * run's separator) or a lone retry warning / run separator. */
export type TranscriptEntry = string[];

const THINKING_MAX_CHARS = 80;
const TEXT_LINE_MAX_COLS = 120;
const TEXT_LINES_PER_MESSAGE = 4;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local wall-clock time for an epoch-ms timestamp (e.g. `2026-08-23 14:32:05`). */
function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(
    d.getHours(),
  )}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Abbreviate to at most `max` chars (ellipsis when cut). */
function abbreviate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

type ContentBlock = {
  type?: unknown;
  thinking?: unknown;
  text?: unknown;
  name?: unknown;
  arguments?: unknown;
};

/** Render one completed assistant message into transcript lines: abbreviated thinking,
 * indented text (capped), and labeled tool calls — in the order they appear. */
function renderAssistantMessage(content: unknown): string[] {
  const out: string[] = [];
  if (!Array.isArray(content)) return out;
  let textShown = 0;
  let textOverflowMarked = false;
  for (const raw of content) {
    const block = (raw ?? {}) as ContentBlock;
    switch (block.type) {
      case "thinking": {
        const thinking = collapseWhitespace(String(block.thinking ?? ""));
        if (thinking) out.push(`· ${abbreviate(thinking, THINKING_MAX_CHARS)}`);
        break;
      }
      case "text": {
        for (const rawLine of String(block.text ?? "").split("\n")) {
          const line = rawLine.trim();
          if (!line) continue;
          if (textShown >= TEXT_LINES_PER_MESSAGE) {
            if (!textOverflowMarked) {
              out.push("  …");
              textOverflowMarked = true;
            }
            break;
          }
          out.push(`  ${abbreviate(line, TEXT_LINE_MAX_COLS)}`);
          textShown += 1;
        }
        break;
      }
      case "toolCall":
        out.push(`→ ${describeToolCall(String(block.name ?? "?"), block.arguments)}`);
        break;
    }
  }
  return out;
}

export interface TranscriptRenderer {
  /** Feed one raw JSONL line; returns the rendered lines of any entry this line completes
   * (empty for deltas, bookkeeping events, and user messages). */
  feed(line: string): string[];
  /** Emit a pending run separator for a run that produced no renderable event yet. */
  flush(): string[];
  /** The pending run separator without consuming it — [] when no run is open. Lets an
   * incremental reader show a just-started run's separator before its first turn, the way a
   * full re-read's trailing flush does, while keeping the timestamp current until the
   * separator merges into the first rendered entry. */
  pendingSeparator(): string[];
}

/** Incremental renderer over pi's streaming JSONL log. Only complete, renderable events ever
 * produce output: `agent_start` (a run separator, stamped from the first user message's
 * epoch-ms timestamp), assistant `message_end` turns, and `auto_retry_start` warnings.
 * Streaming deltas (`message_update`), tool-execution/turn bookkeeping, and user messages —
 * in particular the multi-KB tick prompt sent each run — are never rendered. */
export function createTranscriptRenderer(): TranscriptRenderer {
  let runOpen = false; // agent_start seen for this run, separator not yet emitted
  let runTime: string | null = null;

  const separatorLine = (): string => (runTime ? `── run @ ${runTime} ──` : "── run ──");
  const emitSeparator = (): string[] => {
    if (!runOpen) return [];
    runOpen = false;
    return [separatorLine()];
  };

  return {
    feed(line: string): string[] {
      const trimmed = line.trim();
      if (!trimmed) return [];
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(trimmed);
      } catch {
        return []; // torn or non-JSON line; skip without failing
      }
      switch (event.type) {
        case "agent_start":
          runOpen = true;
          runTime = null;
          return []; // separator is stamped from the first user message, then emitted lazily
        case "message_end": {
          const message = event.message as
            | { role?: unknown; timestamp?: unknown; content?: unknown }
            | undefined;
          if (!message || typeof message !== "object") return [];
          if (message.role === "user") {
            if (runOpen && runTime === null && typeof message.timestamp === "number") {
              runTime = formatTimestamp(message.timestamp);
            }
            return []; // never render user content (the tick prompt)
          }
          if (message.role !== "assistant") return [];
          const turn = renderAssistantMessage(message.content);
          return [...emitSeparator(), ...turn];
        }
        case "auto_retry_start": {
          const attempt = typeof event.attempt === "number" ? event.attempt : "?";
          const maxAttempts = typeof event.maxAttempts === "number" ? event.maxAttempts : "?";
          const error = abbreviate(collapseWhitespace(String(event.errorMessage ?? "unknown error")), 120);
          return [...emitSeparator(), `⚠ retry ${attempt}/${maxAttempts}: ${error}`];
        }
        default:
          return []; // message_update deltas, tool_execution_*, turn_*, agent_end, session, …
      }
    },
    flush(): string[] {
      return emitSeparator();
    },
    pendingSeparator(): string[] {
      return runOpen ? [separatorLine()] : [];
    },
  };
}

/** Pure one-shot formatter over raw JSONL lines. Returns transcript entries (each an array of
 * rendered lines), oldest first; non-JSON/torn lines are skipped without failing. */
export function formatTranscript(lines: string[]): TranscriptEntry[] {
  const renderer = createTranscriptRenderer();
  const entries: TranscriptEntry[] = [];
  for (const line of lines) {
    const out = renderer.feed(line);
    if (out.length > 0) entries.push(out);
  }
  const tail = renderer.flush();
  if (tail.length > 0) entries.push(tail);
  return entries;
}

/** Per-file incremental state for readTranscript: where we last stopped reading and the
 * rendered entries accumulated from everything read so far. Bounded by the number of distinct
 * log paths observed in this process (one root × its roles for a TUI/GUI). */
interface TranscriptTail {
  dev: number;
  ino: number;
  /** Byte offset already consumed, always at a line boundary. */
  offset: number;
  renderer: TranscriptRenderer;
  /** Rendered entries so far (ring buffer capped at MAX_ENTRIES). */
  entries: string[][];
}

const tails = new Map<string, TranscriptTail>();
/** Safety cap so the cache can never grow unbounded (e.g. many short-lived roots in tests).
 * Evicting only costs one reseed per role on the next poll — same trade as progress.ts. */
const MAX_TAILS = 64;
/** How many rendered entries to keep per file. Hot callers ask for at most ~50 (the GUI
 * panel polls with n=50, the TUI its line budget), so the cap bounds memory while keeping any
 * such request exact; a caller asking for more gets the newest MAX_ENTRIES. */
const MAX_ENTRIES = 200;

function pushEntry(tail: TranscriptTail, entry: string[]): void {
  if (entry.length === 0) return;
  tail.entries.push(entry);
  if (tail.entries.length > MAX_ENTRIES) tail.entries.splice(0, tail.entries.length - MAX_ENTRIES);
}

/** Rendered transcript lines for the last `limit` entries of a loop's pi log, oldest first.
 * Returns [] when the role has no log yet.
 *
 * The raw log is append-only while pi runs and rotates at `logMaxBytes` (default 16MB), so
 * after parsing the current file once per observation (first poll or rotation) only bytes
 * appended since the previous call are read and parsed — observers that call this every
 * second (the TUI's transcript view, the GUI panel) stop rescanning up to 16MB of JSON per
 * role per poll. A torn trailing line is left unconsumed until its newline lands. */
export function readTranscript(root: string, role: string, limit = 50): string[] {
  const file = piLogPath(root, role);
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    tails.delete(file); // Missing (or vanished) — drop any stale state.
    return [];
  }
  if (st.size === 0) return [];

  const want = Math.min(limit, MAX_ENTRIES);
  let tail = tails.get(file);
  if (!tail || tail.dev !== st.dev || tail.ino !== st.ino || st.size < tail.offset) {
    // First observation, rotation (rename + new file), or a shrunken file: parse the whole
    // current file once. That is exactly what every poll used to do; now it happens once per
    // observation instead of on each one, and steady-state polls below touch only appends.
    const { lines, end } = readCompleteLines(file, 0, st.size);
    tail = {
      dev: st.dev,
      ino: st.ino,
      offset: end,
      renderer: createTranscriptRenderer(),
      entries: [],
    };
    for (const line of lines) pushEntry(tail, tail.renderer.feed(line));
    if (tails.size >= MAX_TAILS) tails.clear();
    tails.set(file, tail);
  } else if (st.size > tail.offset) {
    // Append-only growth since the last poll: parse only the new bytes.
    const { lines, end } = readCompleteLines(file, tail.offset, st.size);
    for (const line of lines) pushEntry(tail, tail.renderer.feed(line));
    if (end > tail.offset) tail.offset = end; // A torn trailing line is re-read next poll.
  }

  // A run that started but has no renderable event yet still shows its separator — reported
  // without consuming it, so when the first turn lands the separator merges into that entry
  // exactly as a full re-read would produce (and keeps gaining its timestamp until then).
  const pending = tail.renderer.pendingSeparator();
  const take = Math.max(0, want - (pending.length > 0 ? 1 : 0));
  return [...tail.entries.slice(-take).flat(), ...pending];
}
