import fs from "node:fs";
import { ensureParentDir, writeTextAtomic } from "./files.js";
import { isJsonObject } from "./json-object.js";

/** The harness's plain JSON marker/info/state files: tolerant reads of files written by other
 * processes, and pretty-printed overwrites — plain or atomic (tmp+rename) — whose format
 * cannot drift per writer. Split out of files.ts — which keeps the generic file operations —
 * because this is one self-contained convention with its own error policy (a missing or torn
 * file is "no data", never an error) shared by every reader and writer of those files. */

/** Read and parse a JSON *object* file, returning null when it does not exist, cannot be read
 * or parsed, or parses to a valid JSON value that is not a plain object (a scalar, `null`, or
 * an array). The harness's state/marker/info files (loop state, orchestrator info, landing
 * marker, reset/wake/abort markers, restart stamp, build stamp) are all objects written by
 * other processes and may be missing or torn mid-write — readers treat that as "no data"
 * rather than an error, so a crash in one process can never take down the observers polling
 * them. A wrong-shaped file reads the same way: casting a scalar/array to `T` would hand
 * callers a value that looks like data but is not (loadLoopState would spread a string's
 * characters into the loop's state, readOrchestratorInfo's `pid` would read undefined off an
 * array), so the object check is part of the no-data policy, not an extra one. */
export function readJsonFile<T extends object>(file: string): T | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!isJsonObject(parsed)) return null; // Not a state object — no data.
    return parsed as T;
  } catch {
    return null; // Missing or torn — no data.
  }
}

/** Write `value` to `file` as pretty-printed (2-space) JSON, creating the parent directory
 * first — the shared pre-write step for every harness marker/info file that is a plain
 * overwrite (the reset-counters, wake, and abort markers in operator-commands.ts, the
 * orchestrator info file), so
 * their format cannot drift per writer. Writers with stronger guarantees keep their own
 * paths: the event log appends + rotates (events.ts). */
export function writeJsonFile(file: string, value: unknown): void {
  ensureParentDir(file);
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

/** Write `value` to `file` as pretty-printed (2-space) JSON — the serialization half of the
 * harness's atomic write, whose mechanics live in writeTextAtomic: the tmp file + rename that
 * keeps a crash mid-write from leaving a torn file (readers like readJsonFile see either the
 * old or the new content, never a mixture), the per-pid tmp names that let several processes
 * write one file concurrently (the orchestrator and `tumwater reset-counters` both rewrite a
 * role's state; two dashboards can save tumwater.json at once), and the no-tmp-remnant
 * cleanup on failure. `trailingNewline` keeps tumwater.json's POSIX-newline convention; the
 * state files (like writeJsonFile) end without one. */
export function writeJsonAtomic(file: string, value: unknown, trailingNewline = false): void {
  writeTextAtomic(file, JSON.stringify(value, null, 2) + (trailingNewline ? "\n" : ""));
}
