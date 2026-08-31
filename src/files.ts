import fs from "node:fs";
import path from "node:path";

/** Shared file helpers: stat-or-missing for log readers, PATH lookup for the pi-installation
 * preflight, tolerant JSON-file reads for state files written by other processes, stat-keyed
 * caching of file-derived values polled on an interval, size-based rotation for append-only
 * logs, and age-based pruning of pi session files. Incremental consumption of those append-only
 * logs (complete-line tail reading, tail-state folding, byte-offset following) lives in tail.ts. */

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

/** One entry of a stat-keyed cache: the file's identity and freshness at read time plus the
 * value derived from it. */
export interface StatKeyedValue<T> {
  dev: number;
  ino: number;
  mtimeMs: number;
  size: number;
  value: T;
}

/** Safety cap so a stat-keyed cache can never grow unbounded (e.g. many short-lived roots in
 * tests). Evicting only costs one re-read per file on the next call. */
const MAX_STAT_CACHED = 64;

/** Serve `file`'s derived value from a stat-keyed cache: fresh when the file's identity or
 * mtime/size changed since this process last read it, cached otherwise — one stat syscall per
 * file per poll instead of re-reading and re-parsing data that grows without bound. Any write
 * invalidates via dev/ino/mtime/size (the same freshness check as tail.ts's incremental log
 * readers). `load` runs only on a miss (first observation or change) — never on a hit, so a
 * steady-state poll does no read I/O at all; it returns null when the file cannot be read. A
 * missing file yields null without attempting a doomed read, and any stale entry is dropped in
 * both cases. The result is always `clone`d, so each caller owns its data: mutating one result
 * must not poison later polls. */
export function cachedByStat<T>(
  cache: Map<string, StatKeyedValue<T>>,
  key: string,
  file: string,
  load: () => T | null,
  clone: (value: T) => T,
): T | null {
  const st = statOrNull(file);
  if (!st) {
    cache.delete(key); // Vanished — drop any stale entry.
    return null;
  }
  const hit = cache.get(key);
  if (hit && hit.dev === st.dev && hit.ino === st.ino && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    return clone(hit.value); // A copy: callers may treat the result as their own.
  }
  const value = load();
  if (value === null) {
    cache.delete(key); // Unreadable — don't serve a stale entry for it.
    return null;
  }
  if (cache.size >= MAX_STAT_CACHED) cache.clear();
  cache.set(key, { dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs, size: st.size, value });
  return clone(value);
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
