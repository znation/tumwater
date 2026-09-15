import fs from "node:fs";
import { ensureParentDir } from "./files.js";

/** The harness's plain JSON marker/info/state files: tolerant reads of files written by other
 * processes, and pretty-printed overwrites — plain or atomic (tmp+rename) — whose format
 * cannot drift per writer. Split out of files.ts — which keeps the generic file operations —
 * because this is one self-contained convention with its own error policy (a missing or torn
 * file is "no data", never an error) shared by every reader and writer of those files. */

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
