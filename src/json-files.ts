import fs from "node:fs";
import { ensureParentDir } from "./files.js";
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
 * overwrite (the reset-counters and abort markers in cli.ts, the orchestrator info file), so
 * their format cannot drift per writer. Writers with stronger guarantees keep their own
 * paths: the event log appends + rotates (events.ts). */
export function writeJsonFile(file: string, value: unknown): void {
  ensureParentDir(file);
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

/** Write `value` to `file` as pretty-printed (2-space) JSON via a tmp file + rename, so a
 * crash mid-write can never leave a torn file behind: readers like readJsonFile see either
 * the old or the new content, never a mixture. The tmp name carries the pid because several
 * processes can write one file concurrently (the orchestrator and `tumwater reset-counters`
 * both rewrite a role's state; two dashboards can save tumwater.json at once) — per-pid names
 * give each writer its own tmp, so their writes cannot interleave into mixed JSON or fail the
 * other writer's rename with ENOENT, and the last writer wins. On failure the tmp is removed
 * and the error rethrown; the target file is left untouched. `trailingNewline` keeps
 * tumwater.json's POSIX-newline convention; the state files (like writeJsonFile) end
 * without one. */
export function writeJsonAtomic(file: string, value: unknown, trailingNewline = false): void {
  ensureParentDir(file);
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + (trailingNewline ? "\n" : ""));
    fs.renameSync(tmp, file); // atomic on POSIX — readers never see a partial file
  } catch (err) {
    fs.rmSync(tmp, { force: true }); // a failed write leaves no tmp remnant behind
    throw err;
  }
}
