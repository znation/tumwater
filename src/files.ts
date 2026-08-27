import fs from "node:fs";
import path from "node:path";

/** Shared file helpers: stat-or-missing for log readers, PATH lookup for the pi-installation
 * preflight, tolerant JSON-file reads for state files written by other processes, size-based
 * rotation for append-only logs, and age-based pruning of pi session files. Incremental
 * consumption of those append-only logs (complete-line tail reading, tail-state folding,
 * byte-offset following) lives in tail.ts. */

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


