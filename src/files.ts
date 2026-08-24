import fs from "node:fs";
import path from "node:path";

/** Shared file helpers: size-based rotation for append-only logs, age-based pruning of
 * pi session files, complete-line tail reading for incrementally consumed JSONL logs, and
 * byte-offset following of live logs. */

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
 * or lost. Shared by progress.ts's incremental pi-log tail reader and the CLI's `logs -f`
 * follow loop. */
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
