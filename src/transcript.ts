import fs from "node:fs";
import { statOrNull } from "./files.js";
import { readCompleteLines, statRoleLog, TailState, withTail } from "./tail.js";
import { collapseWhitespace, formatDate, formatTime, truncate } from "./text.js";
import { describeToolCall } from "./tool-call.js";

/** A rendered transcript entry: the lines for one assistant turn (optionally prefixed by its
 * run's separator) or a lone retry warning / run separator. */
export type TranscriptEntry = string[];

const THINKING_MAX_CHARS = 80;
const TEXT_LINE_MAX_COLS = 120;
const TEXT_LINES_PER_MESSAGE = 4;

/** Local wall-clock time for an epoch-ms timestamp (e.g. `2026-08-23 14:32:05`). */
function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  return `${formatDate(d)} ${formatTime(d)}`;
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
        if (thinking) out.push(`· ${truncate(thinking, THINKING_MAX_CHARS)}`);
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
          out.push(`  ${truncate(line, TEXT_LINE_MAX_COLS)}`);
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

/** The event types createTranscriptRenderer's feed() acts on — everything else (streaming
 * deltas, tool/turn bookkeeping) renders nothing. `message_end` covers both roles: assistant
 * turns render and user messages stamp the run separator. Also used by feed()'s pre-filter to
 * skip JSON.parse for pi lines whose type is verifiably not one of these; a new renderable case
 * in the switch must be added here too or it will never reach the renderer. */
const RENDERABLE_TYPES = new Set(["agent_start", "message_end", "auto_retry_start"]);

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
 * in particular the multi-KB tick prompt sent each run — are never rendered; feed() skips
 * even parsing them via a fast path over pi's compact `type`-first JSON shape. */
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
      // Cheap pre-filter before JSON.parse: pi's logs are ~97% streaming delta lines
      // (message_update), which the switch below discards after parsing them. Pi serializes
      // every event as compact JSON with `type` first (`{"type":"<event>",…}` — 100% of lines
      // in observed logs), so for that shape we read just the type value (~30ns) and skip the
      // parse when it is not one this renderer acts on; measured ~28–46ms → ~5–8ms of
      // parse/render per 12–21MB log (seeding or a full re-read).
      // Any line NOT matching that exact prefix (a future pi serialization, torn or foreign
      // JSON) falls through to a full parse — exactly today's behavior — so the fast path can
      // only ever skip lines whose type is verifiably non-renderable, never lose output. A new
      // renderable case in the switch below must be added to RENDERABLE_TYPES too.
      if (trimmed.startsWith('{"type":"')) {
        const end = trimmed.indexOf('"', 9);
        if (end > 9 && !RENDERABLE_TYPES.has(trimmed.slice(9, end))) return [];
      }
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
          const error = truncate(collapseWhitespace(String(event.errorMessage ?? "unknown error")), 120);
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

/** Chunk size for readTranscriptTail's backward scan: large enough that one chunk holds most
 * of what a one-shot display needs, small enough to keep each syscall cheap. */
const TAIL_SCAN_CHUNK = 1024 * 1024;

/** Shared empty buffer (readTranscriptTail's "no line straddles this boundary" state). */
const EMPTY_BUFFER = Buffer.alloc(0);

/** Cheap substring over-approximation of "this raw line produces at least one rendered entry"
 * (an assistant message_end or a retry warning). Used only to decide how far back
 * readTranscriptTail must scan — an over-count just makes it scan a little further. */
function isEntryCandidate(line: string): boolean {
  return (
    (line.includes('"message_end"') && line.includes('"assistant"')) || line.includes('"auto_retry_start"')
  );
}

export interface TranscriptWindow {
  /** The last `limit` rendered entries, oldest first — identical to
   * formatTranscript(whole file).slice(-limit). */
  entries: TranscriptEntry[];
  /** Offset just past the last complete newline in the file (a followFile start point), or 0
   * when the file holds no newline at all. */
  end: number;
}

/** Rendered tail of a raw pi log for one-shot display (`tumwater logs --role <id>`): the last
 * `limit` transcript entries without reading (or parsing) the whole file — which grows to
 * logMaxBytes (~16MB+) between rotations. Scans backwards from EOF in chunks, collecting
 * complete lines until it passes an agent_start with at least `limit` entry-candidate lines
 * after it: agent_start resets the renderer's only cross-line state (the pending run
 * separator), so everything from that line on renders identically to a full re-read. When no
 * such boundary exists (small log, or fewer than `limit` entries total) the scan reaches EOF
 * and the window is the whole file — still exact, never more I/O than today's read. Returns
 * null when the file is missing or empty.
 *
 * All line-boundary work happens on raw bytes: a newline (0x0A) can never occur inside a
 * multi-byte UTF-8 sequence, so byte-level boundaries are exact even though logs may contain
 * lossy/invalid UTF-8 — and each complete line decodes identically to the whole-file decode
 * readCompleteLines uses. A line straddling a chunk boundary is held (tail + newline) until
 * its head arrives from an older chunk, so no line is ever decoded torn. */
export function readTranscriptTail(file: string, limit: number): TranscriptWindow | null {
  const st = statOrNull(file);
  if (!st || st.size === 0) return null;
  const size = st.size;

  const fd = fs.openSync(file, "r");
  let pos = size; // Exclusive end of the not-yet-scanned region [pos - chunk, pos).
  let held: Buffer = EMPTY_BUFFER; // Tail (with its newline) of a line that starts before the current chunk and ends inside it.
  const lines: string[] = []; // Complete lines, newest first.
  let candidates = 0; // Entry-candidate lines seen so far, counting from EOF.
  let end = 0; // Offset just past the last complete newline; 0 when the file has none.
  let stoppedAtBoundary = false;
  try {
    for (;;) {
      const len = Math.min(TAIL_SCAN_CHUNK, pos);
      if (len <= 0) break;
      const buf = Buffer.alloc(len);
      const got = fs.readSync(fd, buf, 0, len, pos - len);
      if (got <= 0) break; // Shrank under us — use what we have.
      // Covers the file region [pos - got, pos + held.length): this chunk plus the tail of
      // the line that straddles its newer boundary (if any).
      const c = held.length > 0 ? Buffer.concat([buf.subarray(0, got), held]) : buf.subarray(0, got);
      const lastNl = c.lastIndexOf(10);
      if (lastNl < 0) {
        held = Buffer.from(c); // No complete line in this stretch yet.
        pos -= got;
        continue;
      }
      if (end === 0) end = pos - got + lastNl + 1; // The first complete line found is the newest one.
      // The oldest line of c is incomplete when older bytes exist and the region does not
      // start at a line boundary — hold it for the next chunk instead of decoding it torn.
      let emitStart = 0;
      if (pos - got > 0) {
        const boundary = Buffer.alloc(1);
        fs.readSync(fd, boundary, 0, 1, pos - got - 1);
        if (boundary[0] !== 10) {
          const firstNl = c.indexOf(10); // ≥ 0 — lastNl exists.
          held = Buffer.from(c.subarray(0, firstNl + 1));
          emitStart = firstNl + 1;
        }
      } else {
        held = EMPTY_BUFFER; // Reached file start: nothing older to hold for.
      }
      let lineEnd = lastNl; // Byte index of the \n terminating the newest complete line in c.
      while (lineEnd >= emitStart) {
        const lineStart = c.lastIndexOf(10, lineEnd - 1) + 1;
        if (lineStart < emitStart) break; // Safety — cannot happen: emitStart follows a \n.
        const raw = c.toString("utf8", lineStart, lineEnd);
        if (!raw.trim()) {
          lineEnd = lineStart - 1; // Blank lines render nothing.
          continue;
        }
        lines.push(raw);
        if (isEntryCandidate(raw)) candidates += 1;
        else if (raw.includes('"agent_start"') && candidates >= limit) {
          stoppedAtBoundary = true; // Window [this line .. EOF] renders identically to a full re-read.
          break;
        }
        lineEnd = lineStart - 1;
      }
      pos -= got;
      if (stoppedAtBoundary || pos <= 0) break;
    }
  } finally {
    fs.closeSync(fd);
  }

  let entries = formatTranscript(lines.reverse()); // Oldest first.
  if (entries.length < limit && stoppedAtBoundary) {
    // Contentless assistant turns made the rendered entries fewer than the candidate count
    // promised — re-read the whole file (the pre-optimization behavior) so slice(-limit) is exact.
    entries = formatTranscript(readCompleteLines(file, 0, size).lines);
  }
  return { entries: entries.slice(-limit), end };
}

/** Per-file accumulated value for readTranscript: the incremental renderer and the rendered
 * entries it has produced so far (ring buffer capped at MAX_ENTRIES). Bounded by the number
 * of distinct log paths observed in this process (one root × its roles for a TUI/GUI). */
interface TranscriptValue {
  renderer: TranscriptRenderer;
  /** Rendered entries so far (ring buffer capped at MAX_ENTRIES). */
  entries: string[][];
}

const tails = new Map<string, TailState<TranscriptValue>>();
/** How many rendered entries to keep per file. Hot callers ask for at most ~50 (the GUI
 * panel polls with n=50, the TUI its line budget), so the cap bounds memory while keeping any
 * such request exact; a caller asking for more gets the newest MAX_ENTRIES. */
const MAX_ENTRIES = 200;

/** Fold one raw log line into a transcript's accumulated value. */
function feedEntries(value: TranscriptValue, line: string): void {
  const entry = value.renderer.feed(line);
  if (entry.length === 0) return;
  value.entries.push(entry);
  if (value.entries.length > MAX_ENTRIES) value.entries.splice(0, value.entries.length - MAX_ENTRIES);
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
  const log = statRoleLog(tails, root, role);
  if (!log) return []; // No raw log yet — nothing to show.
  if (log.st.size === 0) return [];

  const want = Math.min(limit, MAX_ENTRIES);
  // Seed by parsing the whole current file once — exactly what every poll used to do; now it
  // happens once per observation instead of on each one, and steady-state polls touch only
  // appends.
  const value = withTail(
    tails,
    log.file,
    log.st,
    () => ({ fromOffset: 0, value: { renderer: createTranscriptRenderer(), entries: [] } }),
    feedEntries,
  );

  // A run that started but has no renderable event yet still shows its separator — reported
  // without consuming it, so when the first turn lands the separator merges into that entry
  // exactly as a full re-read would produce (and keeps gaining its timestamp until then).
  const pending = value.renderer.pendingSeparator();
  const take = Math.max(0, want - (pending.length > 0 ? 1 : 0));
  return [...value.entries.slice(-take).flat(), ...pending];
}
