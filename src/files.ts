import fs from "node:fs";
import path from "node:path";

/** Generic file operations under the harness's error policy — missing is no data, cleanup
 * must not throw, directories are created before writes: stat-or-missing for log readers,
 * PATH lookup for the pi-installation preflight, size-based rotation for append-only logs,
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
