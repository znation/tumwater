import { statOrNull } from "./files.js";

/** Stat-keyed caching of file-derived values polled on an interval: one stat syscall per
 * file per poll instead of re-reading and re-parsing data that grows without bound. Split out
 * of files.ts — which keeps the generic file operations — because this is a self-contained
 * memoization primitive with its own data model (StatKeyedValue) and safety cap, shared by
 * every observer that polls a slowly-changing file (backlog.ts's markdown sections, inbox.ts's
 * prompt contents, status.ts's loop states). Any write invalidates via dev/ino/mtime/size —
 * the same freshness check as tail.ts's incremental log readers. */

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
