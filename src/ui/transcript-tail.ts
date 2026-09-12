import fs from "node:fs";
import { statOrNull } from "../files.js";
import { formatTranscript, type TranscriptEntry } from "./transcript.js";
import { readCompleteLines } from "./tail.js";

/** Rendered tail of a raw pi log for one-shot display (`tumwater logs --role <id>`): the last
 * `limit` transcript entries without reading (or parsing) the whole file, which grows to
 * logMaxBytes (~16MB+) between rotations. Split out of transcript.ts — which keeps the
 * rendering itself (createTranscriptRenderer/formatTranscript) and the incremental reader the
 * dashboards poll every second (readTranscript) — because this is a self-contained concern with
 * its own data model (TranscriptWindow) and I/O strategy: a backward chunk scan over raw bytes.
 * Its only touch of transcript.ts is formatTranscript, which it calls on the collected lines.
 *
 * The stopping boundary depends on the renderer's state machine: agent_start resets/captures
 * its cross-line state (the pending run separator and the pending label set by a tumwater_run
 * marker), so a window starting at an agent_start — or at the marker line preceding it, which
 * this scan arms for after finding a qualifying agent_start — renders identically to a full
 * re-read. If createTranscriptRenderer gains another piece of cross-line state, this scan must
 * stop earlier — keep the two in sync. */

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

interface TranscriptWindow {
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
 * after it: agent_start resets/captures the renderer's cross-line state (the pending run
 * separator and the pending label), so everything from that line on renders identically to a
 * full re-read. A labeled run's marker line sits just before its agent_start, between it and
 * the previous run — so after arming on a qualifying agent_start the scan keeps walking older
 * lines for at most one more run: a tumwater_run marker becomes the boundary (window [marker ..
 * EOF] carries the label), while an older agent_start or EOF means the run was unlabeled and
 * the window stops at the arming agent_start exactly as before. When no such boundary exists
 * (small log, or fewer than `limit` entries total) the scan reaches EOF and the window is the
 * whole file — still exact, never more I/O than today's read plus one run of lines. Returns
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

  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    // Rotation renamed the file away between stat and open — no data, same as missing.
    return null;
  }
  let pos = size; // Exclusive end of the not-yet-scanned region [pos - chunk, pos).
  let held: Buffer = EMPTY_BUFFER; // Tail (with its newline) of a line that starts before the current chunk and ends inside it.
  const lines: string[] = []; // Complete lines, newest first.
  let candidates = 0; // Entry-candidate lines seen so far, counting from EOF.
  let end = 0; // Offset just past the last complete newline; 0 when the file has none.
  let stoppedAtBoundary = false;
  let armed = false; // A qualifying agent_start was recorded; walking older lines for its marker line.
  let boundaryIndex = -1; // Index in `lines` of the arming agent_start (valid while armed).
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
      // A newline at c's start terminates a zero-length line (a blank line whose terminating
      // \n is the region's first byte — e.g. the log starts with one). The walk below finds a
      // line's start via lastIndexOf(10, lineEnd - 1), which for that line would search from
      // index -1 and wrap to c's LAST newline — re-emitting every newer line until the
      // candidate count reaches limit. Skip the zero-length line by starting the walk after it.
      if (c[emitStart] === 10) emitStart += 1;
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
        if (armed) {
          // Walking for the marker line preceding the arming agent_start; every line pushed
          // here sits inside [marker .. EOF] when a marker lands, so keep it.
          if (raw.includes('"tumwater_run"')) {
            armed = false; // Boundary found — the post-loop EOF-while-armed fallback must not fire.
            stoppedAtBoundary = true; // Window [this marker .. EOF] renders identically to a full re-read.
            break;
          }
          if (raw.includes('"agent_start"')) {
            lines.splice(boundaryIndex + 1); // No marker before the next older run: unlabeled — stop at A.
            armed = false;
            stoppedAtBoundary = true;
            break;
          }
        } else if (isEntryCandidate(raw)) {
          candidates += 1;
        } else if (raw.includes('"agent_start"') && candidates >= limit) {
          armed = true; // Keep walking for the marker line preceding this agent_start.
          boundaryIndex = lines.length - 1;
        }
        lineEnd = lineStart - 1;
      }
      pos -= got;
      if (stoppedAtBoundary || pos <= 0) break;
    }
  } finally {
    fs.closeSync(fd);
  }

  if (armed) {
    // Reached EOF while still arming: no marker precedes the run — unlabeled, stop at its agent_start.
    lines.splice(boundaryIndex + 1);
    stoppedAtBoundary = true;
  }

  let entries = formatTranscript(lines.reverse()); // Oldest first.
  if (entries.length < limit && stoppedAtBoundary) {
    // Contentless assistant turns made the rendered entries fewer than the candidate count
    // promised — re-read the whole file (the pre-optimization behavior) so slice(-limit) is exact.
    entries = formatTranscript(readCompleteLines(file, 0, size).lines);
  }
  return { entries: entries.slice(-limit), end };
}
