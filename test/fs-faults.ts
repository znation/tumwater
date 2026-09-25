import fs from "node:fs";

/** Fault-injection file helpers: monkey-patched fs entry points that simulate the races and
 * surprises real readers must survive (a log rotation rename landing between a reader's stat
 * and its open, a file vanishing mid-read). Each returns an undo function; none belong in the
 * general test grab-bag (util.ts) because they patch global state and are meaningful only to
 * reader-robustness tests. */

/** Wrap fs.openSync so the first open of `file` unlinks it instead — simulating a log
 * rotation rename landing between a reader's stat and its open (the race tail readers must
 * survive as "no data", not an ENOENT throw). Returns an undo function. */
export function vanishOnOpen(file: string): () => void {
  const orig = fs.openSync.bind(fs);
  let hit = false;
  (fs as Record<string, unknown>).openSync = (p: unknown, flags: string) => {
    if (!hit && p === file) {
      hit = true;
      fs.unlinkSync(file);
    }
    return (orig as (x: unknown, f: string) => number)(p, flags);
  };
  return () => {
    (fs as Record<string, unknown>).openSync = orig;
  };
}

/** The rotation twin of vanishOnOpen where the path comes back before open: on the first
 * open of `file`, rename the old file away and recreate it with `content` (smaller than the
 * original in every use so far), then open — simulating a rotation rename plus a fresh append
 * landing between a reader's stat and its open. Returns an undo function. */
export function recreateSmallerOnOpen(file: string, content: string): () => void {
  const orig = fs.openSync.bind(fs);
  let hit = false;
  (fs as Record<string, unknown>).openSync = (p: unknown, flags: string) => {
    if (!hit && p === file) {
      hit = true;
      fs.renameSync(file, file + ".1");
      fs.writeFileSync(file, content);
    }
    return (orig as (x: unknown, f: string) => number)(p, flags);
  };
  return () => {
    (fs as Record<string, unknown>).openSync = orig;
  };
}

/** The readFileSync twin of vanishOnOpen — for readers that stat and then read a small file
 * whole. Returns an undo function. */
export function vanishOnReadFile(file: string): () => void {
  const orig = fs.readFileSync.bind(fs);
  let hit = false;
  (fs as Record<string, unknown>).readFileSync = (p: unknown, ...rest: unknown[]) => {
    if (!hit && p === file) {
      hit = true;
      fs.unlinkSync(file);
    }
    return (orig as (x: unknown, ...r: unknown[]) => Buffer)(p, ...rest);
  };
  return () => {
    (fs as Record<string, unknown>).readFileSync = orig;
  };
}
