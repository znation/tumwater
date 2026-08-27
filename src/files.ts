import fs from "node:fs";
import path from "node:path";

/** Shared file helpers: stat-or-missing for log readers, tolerant JSON-file reads for state
 * files written by other processes, size-based rotation for append-only logs, age-based
 * pruning of pi session files, complete-line tail reading and incremental tail-state
 * consumption for polled JSONL logs, and byte-offset following of live logs. */

/** Stat a file, returning null when it does not exist (or cannot be read). The harness's
 * log readers all treat a missing log as "no data yet" rather than an error — this is the
 * single place for that policy, shared by every observer that polls those logs. */
export function statOrNull(file: string): fs.Stats | null {
  try {
    return fs.statSync(file);
  } catch {
    return null; // Missing (or vanished) — no data yet.
  }
}

/** Read and parse a JSON file, returning null when it does not exist or cannot be read or
 * parsed. The harness's state files (loop state, orchestrator info, the reset-counters
 * marker) are written by other processes and may be missing or torn mid-write — readers
 * treat that as "no data" rather than an error, so a crash in one process can never take
 * down the observers polling these files. */
export function readJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null; // Missing or torn — no data.
  }
}

/** Keep an append-only log bounded: over `maxBytes` it is renamed to `<file>.1`
 * (replacing any previous rotation) and a fresh file starts. Returns true if rotated. */
export function rotateIfLarge(file: string, maxBytes: number): boolean {
  try {
    if (fs.statSync(file).size <= maxBytes) return false;
    fs.renameSync(file, file + ".1");
    return true;
  } catch {
    return false; // Missing file or racing rotation; nothing to do.
  }
}

/** Delete regular files under `dir` (recursively) older than `days` days. */
export function pruneOldFiles(dir: string, days: number): number {
  if (!fs.existsSync(dir)) return 0;
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  let pruned = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) {
        fs.rmSync(file);
        pruned += 1;
      }
    } catch {
      // Vanished mid-scan; skip.
    }
  }
  return pruned;
}

/** Read [offset, size) and split into complete lines. `end` is the offset just past the
 * last newline: a trailing partial line (torn write in flight) is NOT consumed, so it is
 * re-read next poll once its writer has written the newline instead of being parsed torn
 * or lost. Shared by every JSONL reader that consumes incrementally — progress.ts's live
 * tail, followFile, and the transcript one-shot reads (transcript.ts, cli.ts). */
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
 * progress.ts's live tail and transcript.ts's rendered entries. */
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

/** Follow an append-only file from byte `offset`, delivering every complete line at or past
 * it exactly once — both what is already on disk and everything appended later. Polls every
 * `intervalMs` (default 500ms — the harness's follow cadence); a torn trailing line without
 * its newline is held back until completed, and rotation/truncation (file shrinks) restarts
 * from the beginning of the new content. A missing file simply delivers nothing until it
 * appears. Returns a stop function that ends polling.
 *
 * Polling is unconditional (setInterval + stat) rather than fs.watchFile's change detection:
 * watchFile only fires when the stat differs from its asynchronously established baseline, so
 * writes landing between the initial read and that first baseline stat would go undelivered. */
export function followFile(
  file: string,
  offset: number,
  onLines: (lines: string[]) => void,
  intervalMs = 500,
): () => void {
  let stopped = false;
  const poll = (): void => {
    if (stopped) return;
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return; // Not created yet (or vanished); the next poll re-checks.
    }
    if (size < offset) offset = 0; // Rotated or truncated: re-read the new content from the
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
