import fs from "node:fs";
import { openForRead, statOrNull } from "./files/files.js";
import { piLogPath } from "./paths.js";

/** Incremental consumption of append-only logs (the harness's JSONL event and pi logs):
 * complete-line window reads, the bounded backwards chunk scan (forEachTailChunk and the
 * readTailText collection loop built on it) that the windowed readers ask for, per-file tail
 * state that folds only appended bytes on each poll (plus the shared stat-and-clear entry
 * point for polling a role's pi log), and byte-offset following for `logs -f`. Split out of src/files/files.ts — which keeps the
 * generic file helpers — because this is one self-contained concern with its own internal
 * structure (readCompleteLines and forEachTailChunk as the primitives; withTail, followFile,
 * and readTailText built on them).
 * Lives here in src/, not src/ui/: it is core file I/O with no presentation concern, and
 * its consumers — the ui observer layer polling those logs — may import core freely,
 * while the reverse edge would be forbidden (DEVELOPMENT.md Layout). */

/** Read [offset, size) and split into complete lines. `end` is the offset just past the
 * last newline: a trailing partial line (torn write in flight) is NOT consumed, so it is
 * re-read next poll once its writer has written the newline instead of being parsed torn
 * or lost. Shared by every JSONL reader that consumes incrementally — progress-data.ts's live
 * tail, followFile, and the transcript one-shot reads (transcript.ts, transcript-tail.ts). */
export function readCompleteLines(file: string, offset: number, size: number): { lines: string[]; end: number } {
  const len = size - offset;
  if (len <= 0) return { lines: [], end: offset };
  const fd = openForRead(file);
  if (fd === null) {
    // The caller's stat saw the file but rotation renamed it away before this open — no data
    // yet, exactly like a shrunken read below; the next poll re-stats and reseeds.
    return { lines: [], end: offset };
  }
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
    // The region always ends at a newline (complete stops just past the last \n), so split's
    // trailing "" is an artifact, not a line — drop it so callers get exactly the complete
    // lines and need no defensive filter of their own.
    const lines = text.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    return { lines, end: offset + complete };
  } finally {
    fs.closeSync(fd);
  }
}

/** Files at or under this size are read whole in one go; larger ones get a tail window.
 * Small on purpose: below it a single read is cheapest, and above it the windowed path reads
 * only what the caller's stop condition needs — so a poll asking for ~40 events never pays to
 * re-read log growth (the event log rotates at 16 MB). */
const TAIL_SCAN_THRESHOLD = 8 * 1024;

/** Chunk size for the backwards tail scan. Small on purpose: a bounded query (last N lines,
 * events since day X) needs only a few KB, and one oversized chunk per poll would re-read bytes
 * no caller asked for — with the old 64KB chunk, every poll of a grown log cost as much as
 * reading it whole. */
const TAIL_CHUNK_BYTES = 8 * 1024;

/** Read an append-only line log backwards from EOF in TAIL_CHUNK_BYTES chunks, delivering each
 * chunk (newest first) to `onChunk`, which returns true to stop early once enough bytes are in
 * hand. Files at or under TAIL_SCAN_THRESHOLD are delivered whole as a single chunk; a missing
 * or empty file delivers nothing. Per-call I/O is bounded by the caller's stop condition, not
 * the log's size. Callers that accumulate the chunks into one decoded string should use
 * readTailText, the shared collection loop built on this. Each delivered chunk arrives with
 * `coveredEnd`, the byte offset the scan covers through — the file's size at scan time (the
 * whole-file delivery reports the bytes actually read, the chunked one the opened inode's
 * fstat size) — so a caller can position a follow at where its read stopped; the follow-facing
 * readTailTextWithEnd backs that raw end up to the last complete line's boundary. */
export function forEachTailChunk(
  file: string,
  onChunk: (chunk: Buffer, coveredEnd: number) => boolean,
): void {
  const st = statOrNull(file);
  if (!st || st.size === 0) return; // No log yet.
  let size = st.size;
  if (size <= TAIL_SCAN_THRESHOLD) {
    try {
      const whole = fs.readFileSync(file);
      onChunk(whole, whole.length); // Read covers through the bytes actually read.
    } catch {
      return; // Rotated away between stat and read — no data, the same policy as a missing file.
    }
    return;
  }
  const fd = openForRead(file);
  if (fd === null) return; // Vanished (rotated) between stat and open — nothing to deliver.
  try {
    // fstat on the opened inode stays correct even if rotation renames the file mid-read.
    size = fs.fstatSync(fd).size;
    let end = size;
    for (;;) {
      const len = Math.min(TAIL_CHUNK_BYTES, end);
      if (len <= 0) break; // Reached the start of the file: everything is in hand.
      const buf = Buffer.alloc(len);
      const got = fs.readSync(fd, buf, 0, len, end - len);
      if (got === 0) break; // File shrank under us; use what we have.
      if (onChunk(buf.subarray(0, got), size)) break; // Early stop: the caller has enough bytes in hand.
      end -= got;
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** Scan an append-only line log backwards (forEachTailChunk) and return the delivered bytes
 * as one decoded string. Each chunk is unshifted into `parts` (newest-first delivery, so
 * oldest-first order) BEFORE the caller's stop predicate runs, and the predicate receives both
 * the chunk just delivered and everything in hand — so it can count what it has seen (readEvents'
 * newline count) or inspect the oldest bytes (readWindowEvents' oldest complete line) without
 * carrying its own parts array. Missing/empty files and a scan that never delivers return
 * "". */
export function readTailText(
  file: string,
  onChunk: (chunk: Buffer, parts: Buffer[]) => boolean,
): string {
  return readTailTextWithEnd(file, onChunk).text;
}

/** readTailText, plus the byte offset the scan covered through (forEachTailChunk's
 * `coveredEnd`), backed up to the last complete line's boundary: the file's size at read time
 * minus any trailing torn bytes the scan read but never parsed. A caller that seeds a follow
 * from it can neither skip an event appended between this read and a later stat — the race a
 * fresh `statOrNull(file).size` seed carries — nor land mid-line: followFile's offset must sit
 * on a line boundary (readCompleteLines' contract), and a seed past a torn trailing line's
 * start would deliver that line's tail as a garbled fragment once its writer completed it,
 * its head never delivered. Early stops and mid-scan appends leave the covered region
 * contiguous through the scan's EOF either way: chunks are delivered newest-first from the
 * size the scan measured, so everything below that offset up to the delivered total was
 * read, and everything at or above it was not. With no newline in the covered region the
 * whole region is one torn fragment and the end backs up to its start, so the follow re-reads
 * and delivers it whole once completed (an early stop requires newlines, so that region
 * start is always the file's own start). */
export function readTailTextWithEnd(
  file: string,
  onChunk: (chunk: Buffer, parts: Buffer[]) => boolean,
): { text: string; coveredEnd: number } {
  const parts: Buffer[] = [];
  let coveredEnd = 0;
  forEachTailChunk(file, (chunk, end) => {
    coveredEnd = end;
    parts.unshift(chunk);
    return onChunk(chunk, parts);
  });
  const raw = Buffer.concat(parts);
  // Byte arithmetic on the raw buffer, not the decoded text: a torn write can end mid-character,
  // where the decoded string's byte length no longer matches the bytes on disk.
  const lastNl = raw.lastIndexOf(10);
  const completeEnd = lastNl >= 0 ? coveredEnd - (raw.length - 1 - lastNl) : coveredEnd - raw.length;
  return { text: raw.toString("utf8"), coveredEnd: completeEnd };
}
/** Per-file state for a consumer that polls an append-only log tick by tick and only wants
 * the bytes appended since its last visit: where it stopped reading (dev/ino guard against
 * rotation, offset always at a line boundary) plus its accumulated value. */
export interface TailState<T> {
  dev: number;
  ino: number;
  /** Byte offset already consumed, always at a line boundary. */
  offset: number;
  value: T;
}

/** Safety cap so a tail cache can never grow unbounded (e.g. many short-lived roots in
 * tests). Evicting only costs one reseed per file on the next poll. */
const MAX_TAILS = 64;

/** Incrementally consume an append-only log for `file` into its entry of `tails`, returning
 * the accumulated value (which callers may mutate further):
 * - first observation, rotation (rename + new inode), or a shrunken file → seed by reading
 *   from `fresh()`'s offset and folding every line into its fresh value;
 * - append-only growth since the last visit → fold only the newly complete lines in.
 * A torn trailing line is left unconsumed until its newline lands (the offset advances to
 * the last complete line). Shared by every observer that polls a log once per tick —
 * progress-data.ts's live tail and transcript.ts's rendered entries. */
export function withTail<T>(
  tails: Map<string, TailState<T>>,
  file: string,
  st: fs.Stats,
  fresh: (size: number) => { fromOffset: number; value: T },
  feed: (value: T, line: string) => void,
): T {
  let tail = tails.get(file);
  if (!tail || tail.dev !== st.dev || tail.ino !== st.ino || st.size < tail.offset) {
    const { fromOffset, value } = fresh(st.size);
    const { lines, end } = readCompleteLines(file, fromOffset, st.size);
    for (const line of lines) feed(value, line);
    if (tails.size >= MAX_TAILS) tails.clear();
    tail = { dev: st.dev, ino: st.ino, offset: end, value };
    tails.set(file, tail);
  } else if (st.size > tail.offset) {
    const { lines, end } = readCompleteLines(file, tail.offset, st.size);
    for (const line of lines) feed(tail.value, line);
    if (end > tail.offset) tail.offset = end; // A torn trailing line is re-read next poll.
  }
  return tail.value;
}

/** Stat a role's raw pi log for incremental consumption, dropping any stale TailState when
 * the file is missing or has vanished (null = "no data yet", so callers bail out before
 * seeding). Shared by progress-data.ts and transcript.ts — both poll one role's log per second
 * through their own TailState map keyed by this exact path, so the missing-file bookkeeping
 * lives in one place instead of drifting between them. */
export function statRoleLog<T>(
  tails: Map<string, T>,
  root: string,
  role: string,
): { file: string; st: fs.Stats } | null {
  const file = piLogPath(root, role);
  const st = statOrNull(file);
  if (!st) {
    tails.delete(file); // Missing (or vanished) — drop any stale state.
    return null;
  }
  return { file, st };
}

/** Follow an append-only file from byte `offset`, delivering every complete line at or past
 * it exactly once — both what is already on disk and everything appended later. Polls every
 * `intervalMs` (default 500ms — the harness's follow cadence); a torn trailing line without
 * its newline is held back until completed, and rotation/truncation restarts from the
 * beginning of the new content — detected by a shrink (the same-path truncate) and by an
 * inode change (the rename + fresh file whose replacement can outgrow the old offset within
 * one poll interval, which size alone reads as an append). A missing file simply delivers
 * nothing until it appears. Returns a stop function that ends polling.
 *
 * Polling is unconditional (setInterval + stat) rather than fs.watchFile's change detection:
 * watchFile only fires when the stat differs from its asynchronously established baseline, so
 * writes landing between the initial read and that first baseline stat would go undelivered.
 * Rotation also drains the outgoing inode's unread tail from the `<file>.1` archive the
 * rotation left behind (drainRotatedTail below), so lines appended between the last poll and
 * the rename are delivered too. */
export function followFile(
  file: string,
  offset: number,
  onLines: (lines: string[]) => void,
  intervalMs = 500,
): () => void {
  let stopped = false;
  // The dev/ino pair of the file the current `offset` was measured against — null until the
  // first successful stat, so the caller's seed offset is honored on the opening poll.
  let seen: { dev: number; ino: number } | null = null;
  const poll = (): void => {
    if (stopped) return;
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      return; // Not created yet (or vanished); the next poll re-checks.
    }
    // Rotation is an inode change, not only a shrink: a replacement file that reaches the old
    // offset's byte count before the next poll is indistinguishable from an append by size
    // alone, and reading it from the stale offset delivers the new content's tail as a
    // mangled mid-line fragment while its head is never delivered (withTail's TailState
    // carries the same dev/ino guard for the same reason).
    // Resetting the offset alone would also abandon the outgoing inode's unread tail — lines
    // appended between the last poll and the rename — so the archive the rotation left behind
    // is drained first.
    if (seen && (st.dev !== seen.dev || st.ino !== seen.ino)) {
      drainRotatedTail(file, offset, seen, onLines);
      offset = 0;
    }
    seen = { dev: st.dev, ino: st.ino };
    const size = st.size;
    if (size < offset) offset = 0; // Truncated in place: re-read the new content from the
    // start. The old bytes live in the renamed inode, so nothing is delivered twice — and
    // lines written between rotation and this poll are not skipped.
    if (size === offset) return;
    const { lines, end } = readCompleteLines(file, offset, size);
    onLines(lines);
    offset = end;
  };
  poll(); // Deliver what is already past `offset`.
  const timer = setInterval(poll, intervalMs);
  return () => {
    if (!stopped) {
      stopped = true;
      clearInterval(timer);
    }
  };
}

/** Deliver the complete lines a rotation moved out of the followed path: the bytes the poll
 * never consumed from the outgoing inode — everything appended between the last poll and the
 * rename — live in the `<file>.1` archive rotateIfLarge leaves behind, still addressable by
 * the old byte offsets, so they are read from there and delivered before the fresh file's
 * content. The archive is trusted only when it IS the outgoing inode (its dev/ino must match
 * the pair the offset was measured against): a second rotation inside one poll interval
 * replaces the archive with an older generation, and matching it would deliver that older
 * content as the missed lines — so that rarer race keeps the pre-drain behavior (those lines
 * are lost, exactly as before). A missing, fully-consumed, or vanished archive drains nothing.
 * A torn trailing line in the archive stays held back (readCompleteLines' contract) and is
 * not re-delivered later — the fresh file never contained it — so a write in flight exactly
 * at rotation can still lose its tail, the same policy every other archive consumer applies. */
function drainRotatedTail(
  file: string,
  offset: number,
  seen: { dev: number; ino: number },
  onLines: (lines: string[]) => void,
): void {
  const archive = `${file}.1`;
  const ast = statOrNull(archive);
  if (!ast || ast.dev !== seen.dev || ast.ino !== seen.ino || ast.size <= offset) return;
  const { lines } = readCompleteLines(archive, offset, ast.size);
  onLines(lines);
}
