import fs from "node:fs";
import path from "node:path";

/** Shared file helpers: size-based rotation for append-only logs, age-based pruning of
 * pi session files, and complete-line tail reading/following for incrementally consumed
 * JSONL logs. */

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

/** Follow an append-only file, invoking `onLine` for each newly completed line as it is
 * appended. Polls with watchFile every 500ms starting at `startOffset`; the offset advances
 * only past complete lines (readCompleteLines), so a write straddling a poll boundary is
 * re-read once it completes instead of being lost, and rotation/truncation resets to the new
 * size. A missing file (not created yet) is skipped until it appears. Returns a promise that
 * never resolves — await it to follow until interrupted. */
export function followFile(file: string, startOffset: number, onLine: (line: string) => void): Promise<void> {
  let offset = startOffset;
  fs.watchFile(file, { interval: 500 }, () => {
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return; // Not (re)created yet.
    }
    if (size <= offset) {
      offset = size; // Rotated or truncated.
      return;
    }
    const { lines, end } = readCompleteLines(file, offset, size);
    for (const line of lines.filter(Boolean)) onLine(line);
    offset = end;
  });
  return new Promise(() => {}); // Follow until interrupted.
}
