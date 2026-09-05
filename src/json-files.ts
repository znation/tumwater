import fs from "node:fs";
import { ensureParentDir } from "./files.js";

/** The harness's plain JSON marker/info/state files (loop state is the exception — it writes
 * atomically via tmp+rename in state.ts): tolerant reads of files written by other processes,
 * and pretty-printed overwrites whose format cannot drift per writer. Split out of files.ts —
 * which keeps the generic file operations — because this is one self-contained convention with
 * its own error policy (a missing or torn file is "no data", never an error) shared by every
 * reader and writer of those files. */

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
 * paths: loop state writes atomically via tmp+rename (state.ts), tumwater.json appends a
 * trailing newline (config.ts), and the event log appends + rotates (events.ts). */
export function writeJsonFile(file: string, value: unknown): void {
  ensureParentDir(file);
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}
