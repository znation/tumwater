import fs from "node:fs";
import path from "node:path";

/** Generic file operations under the harness's error policy — missing is no data, cleanup
 * must not throw, directories are created before writes: stat-or-missing for log readers,
 * PATH lookup for the pi-installation preflight, size-based rotation and bounded backwards
 * tail scans for append-only logs,
 * recursive directory creation before file writes, quiet deletes after marker consumption,
 * and age-based pruning of pi session files. The JSON state-file convention (tolerant reads
 * of possibly-torn writes, pretty-printed overwrites) lives in json-files.ts; stat-keyed
 * caching of polled values in stat-cache.ts; incremental consumption of the append-only logs
 * (complete-line tail reading, tail-state folding, byte-offset following) in tail.ts. */

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

/** Locate an executable on PATH the same way spawn() would resolve it: a regular file
 * with the execute bit in some PATH directory. Returns its absolute path, or null when
 * missing (or not executable), so callers can fail fast with a clear message instead of
 * letting every tick die with "spawn <name> ENOENT". */
export function findOnPath(name: string, pathEnv: string = process.env.PATH ?? ""): string | null {
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK); // Directories pass X_OK; require a file.
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Not in this directory; keep looking.
    }
  }
  return null;
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
 * the log's size — callers typically unshift each chunk into an array and decode
 * Buffer.concat(parts) once the scan ends. */
export function forEachTailChunk(file: string, onChunk: (chunk: Buffer) => boolean): void {
  const st = statOrNull(file);
  if (!st || st.size === 0) return; // No log yet.
  let size = st.size;
  if (size <= TAIL_SCAN_THRESHOLD) {
    onChunk(fs.readFileSync(file));
    return;
  }
  const fd = fs.openSync(file, "r");
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
      if (onChunk(buf.subarray(0, got))) break; // Early stop: the caller has enough bytes in hand.
      end -= got;
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** Ensure `dir` exists (created recursively if needed), so a write into it cannot fail on a
 * missing path. The one place for that pre-write step — every writer of harness state/log/
 * inbox/session files goes through this or ensureParentDir instead of mkdirSync itself. */
export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Ensure the parent directory of `file` exists — the common pre-write step before creating
 * or appending a file whose path may not exist yet. */
export function ensureParentDir(file: string): void {
  ensureDir(path.dirname(file));
}

/** Delete a file, swallowing every error — the one place for cleanup deletes that must never
 * throw. Marker/info files removed after being consumed may already be gone (a concurrent
 * process or an earlier pass took them), and a failed removal is not worth failing the poll
 * over; "already absent" reads as success. */
export function removeQuiet(file: string): void {
  try {
    fs.rmSync(file);
  } catch {
    // Already gone (or unremovable) — cleanup must not throw.
  }
}

/** Delete regular files under `dir` (recursively) older than `days` days. Walks with a plain
 * per-directory readdir instead of {recursive: true} + entry.parentPath, so it stays within the
 * Node >= 20 floor declared in package.json — parentPath landed only in v20.12, and on earlier
 * releases path.join(undefined, name) threw here, crashing the orchestrator's session cleanup.
 * Symlinks are skipped (lstat semantics: a symlink is neither file nor directory), matching the
 * old recursive-readdir behavior of not following them. */
export function pruneOldFiles(dir: string, days: number): number {
  if (!fs.existsSync(dir)) return 0;
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  let pruned = 0;
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const file = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(file); // recurse; symlinks to dirs report isDirectory() false and are skipped
        continue;
      }
      if (!entry.isFile()) continue; // skip symlinks and other special entries
      try {
        if (fs.statSync(file).mtimeMs < cutoff) {
          fs.rmSync(file);
          pruned += 1;
        }
      } catch {
        // Vanished mid-scan; skip.
      }
    }
  };
  walk(dir);
  return pruned;
}
