import fs from "node:fs";
import path from "node:path";
import { errCode } from "../errno.js";

/** Generic file operations under the harness's error policy — missing is no data, cleanup
 * must not throw, directories are created before writes: stat-or-missing for log readers,
 * PATH lookup for the pi-installation preflight, size-based rotation, recursive directory
 * creation before file writes, quiet deletes after marker consumption, and age-based pruning
 * of pi session files. The JSON state-file convention (tolerant reads of possibly-torn
 * writes, pretty-printed overwrites) lives in src/files/json-files.ts; stat-keyed caching of
 * polled values in src/files/stat-cache.ts; incremental consumption of the append-only logs
 * (complete-line tail reading, the backwards chunk scan readTailText behind it, tail-state
 * folding, byte-offset following) in files/tail.ts. */

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

/** Open `file` for reading, or null when it vanished between a prior stat and this open — the
 * shared race-handling step for the incremental/tail log readers (forEachTailChunk,
 * terminateTornTail, readCompleteLines, readTranscriptTail), all of which treat a rotated-away
 * file as "no data" rather than an error. The caller owns the returned fd and closes it. */
export function openForRead(file: string): number | null {
  try {
    return fs.openSync(file, "r");
  } catch {
    return null; // Vanished (rotated) between stat and open — no data.
  }
}

/** Read a text file whole, or null when it does not exist (or cannot be read) — the harness's
 * "missing is no data" policy for the markdown and prompt text a render or prompt-building
 * path must never throw on: the backlog's PLANS/BUGS/QUESTIONS, the principles injected into
 * every tick prompt, the usage report's sources, and a queued prompt that vanished mid-
 * listing. The single home of that read-and-swallow step; callers pick their empty value
 * (`?? ""` when a blank default reads better than null). */
export function readTextOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null; // Missing or unreadable — no data.
  }
}

/** Unlink each file, tolerating only "already absent" (ENOENT) and rethrowing any other
 * error — the unwind policy shared by the inbox paths that roll back saved images after a
 * failed submit or a failed multi-image save: a file vanished mid-roll-back needs no action,
 * but a real removal failure (EACCES, EISDIR) must surface rather than be swallowed. */
export function unlinkAllMissingTolerant(files: readonly string[]): void {
  for (const file of files) {
    try {
      fs.unlinkSync(file);
    } catch (err) {
      if (errCode(err) !== "ENOENT") throw err;
    }
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

/** Write `data` — UTF-8 text or raw bytes — to `file` via a tmp file + rename, so a concurrent
 * reader of the same path sees either the old (absent) or the new content, never a partial
 * write: the prompt-inbox queue files (inbox.ts's enqueueRolePrompt) are written by one process
 * while dashboards poll, `--list` reads, and the loops dequeue in others, and a read that races
 * the write could run a tick on a truncated user request or flash one on the dashboard. The tmp
 * name carries the pid because several processes can write at once (CLI, TUI, GUI, a loop's
 * re-queue); on failure the tmp is removed and the error rethrown, leaving the target untouched.
 * The harness's JSON writer (writeJsonAtomic in src/files/json-files.ts) and the config write-back
 * (writeBytesAtomic's caller, landing-git.ts's restoreConfigBytes) write through this, so the
 * pid-tmp and no-torn-file contract lives in exactly one place. */
function writeAtomic(file: string, data: string | Uint8Array): void {
  ensureParentDir(file);
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file); // atomic on POSIX — readers never see a partial file
  } catch (err) {
    removeQuiet(tmp); // a failed write leaves no tmp remnant behind
    throw err;
  }
}

/** Write `text` to `file` as UTF-8 — the text entry point to writeAtomic's tmp+rename. */
export function writeTextAtomic(file: string, text: string): void {
  writeAtomic(file, text);
}

/** Write raw `data` bytes to `file` — the byte entry point to writeAtomic's tmp+rename, for
 * writers that must preserve the source bytes exactly (landing-git.ts's restoreConfigBytes
 * writes back the live tumwater.json bytes a landing's merge deleted). */
export function writeBytesAtomic(file: string, data: Uint8Array): void {
  writeAtomic(file, data);
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

/** Delete a directory tree, retrying the transient filesystem races (`ENOTEMPTY`/`EBUSY`/
 * `EPERM`) that recursive `rmSync` otherwise turns into a hard failure. Node defaults
 * `maxRetries` to 0, and on macOS an entry appearing between `rmSync`'s walk and its `rmdir`
 * (Spotlight, `.DS_Store`) is routine — so the swap's `dist.prev` cleanup was one race away
 * from blocking a redeploy. `force` still treats an already-absent target as success, and a
 * failure that survives the retries still throws so the swap's error policy is unchanged. */
export function removeTree(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

/** Delete regular files under `dir` (recursively) older than `days` days. Walks with a plain
 * per-directory readdir instead of {recursive: true} + entry.parentPath, so it stays within the
 * Node >= 20 floor declared in package.json — parentPath landed only in v20.12, and on earlier
 * releases path.join(undefined, name) threw here, crashing the orchestrator's session cleanup.
 * Symlinks are skipped (lstat semantics: a symlink is neither file nor directory), matching the
 * old recursive-readdir behavior of not following them.
 *
 * A subdirectory that cannot be listed — without read permission, or removed by a concurrent
 * pass between the parent's readdir and this one — is skipped, the same vanish-tolerant policy
 * the per-file stat/delete below applies. This cleanup runs inside the orchestrator's poll loop
 * (RetentionPruner.poll), so a readdir throw escaping here would end the whole fleet; one
 * unreadable session directory must cost at most its own contents' retention pass. */
export function pruneOldFiles(dir: string, days: number): number {
  if (!fs.existsSync(dir)) return 0;
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  let pruned = 0;
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return; // Vanished (or unreadable) mid-scan; skip this directory.
    }
    for (const entry of entries) {
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

/** Remove `dir` entirely when the directory itself is older than `days` days (its own mtime,
 * not its children's). Worktree builds leave a gitignored `dist/` dir that `git clean -fd`
 * does not drop; this prunes it at the next tick, bounded by the same age rule. Returns true
 * when the directory was removed. Mirrors pruneOldFiles' vanish-tolerant style. */
export function pruneOldDirectory(dir: string, days: number): boolean {
  if (!fs.existsSync(dir)) return false;
  let pruned = false;
  try {
    if (fs.statSync(dir).mtimeMs < Date.now() - days * 24 * 3600 * 1000) {
      removeTree(dir);
      pruned = true;
    }
  } catch {
    // Vanished mid-check; skip.
  }
  return pruned;
}
