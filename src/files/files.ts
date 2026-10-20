import fs from "node:fs";
import path from "node:path";
import { errCode } from "../errno.js";

/** Generic file operations under the harness's error policy — missing is no data, cleanup
 * must not throw, directories are created before writes: stat-or-missing for log readers,
 * PATH lookup for the pi-installation preflight, size-based rotation, recursive directory
 * creation before file writes, quiet deletes after marker consumption, age-based pruning
 * of pi session files, and a generic ancestor climb for the build check and the extension
 * harness-root lookup. The JSON state-file convention (tolerant reads of possibly-torn
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

/** Whether a freshly stat'd file is still the same file at the same bytes as a prior
 * observation: matching dev/ino (a replaced inode is a different file even at the same size)
 * plus matching size and, when the caller tracks it, mtime. The one home of the freshness
 * check shared by files/stat-cache.ts's cachedByStat, events/events.ts's appended-shape memo
 * (`mtimeMs` omitted — it decides "our own append left this log clean" from identity and size
 * alone), report/report-fold.ts's fold cache, gates/maintenance-quota.ts's window counter,
 * and failure/failure-data.ts's digest cache. Callers whose cached field is a byte offset
 * rather than a size (report-fold, maintenance-quota) pass that offset as `size`, since a
 * fully-folded log's offset equals its length. */
export function sameStatIdentity(
  st: { dev: number; ino: number; size: number; mtimeMs: number },
  prev: { dev: number; ino: number; size: number; mtimeMs?: number },
): boolean {
  if (st.dev !== prev.dev || st.ino !== prev.ino || st.size !== prev.size) return false;
  return prev.mtimeMs === undefined || st.mtimeMs === prev.mtimeMs;
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

/** Append a newline when `file`'s last byte is not one — terminating a torn trailing line so
 * the next append starts on its own line instead of gluing onto the fragment. Returns whether
 * a newline was appended. No-op for a missing, empty, already-terminated, or vanished file.
 * Only the open is swallowed: the fstat/read/append/close on the opened fd can throw like any
 * fs call, so a caller that must not throw wraps this whole call — session-ledger.ts's
 * recordSession and events.ts's logEventBestEffort both do. `st` is the caller's fresh stat
 * of `file`; the opened fd is still fstat'd for size — correct even if a rotation renamed the
 * file between the stat and the open. The append-only logs share this one repair: the event
 * log's appendEventLine (src/events/events.ts) and the session ledger's recordSession
 * (src/agent/session-ledger.ts), whose torn line would otherwise glue the next record to the
 * fragment so both fail to parse and neither run stays resumable. */
export function terminateTornTail(file: string, st: { size: number } | null): boolean {
  if (!st || st.size === 0) return false; // No log yet.
  const fd = openForRead(file);
  if (fd === null) return false; // Vanished between stat and open — nothing to terminate.
  try {
    const size = fs.fstatSync(fd).size; // fstat on the opened inode: correct even if rotation renamed the file mid-check.
    if (size === 0) return false;
    const buf = Buffer.alloc(1);
    const got = fs.readSync(fd, buf, 0, 1, size - 1);
    if (got !== 1 || (buf[0] ?? 0) === 10) return false; // Already newline-terminated (or vanished).
    fs.appendFileSync(file, "\n");
    return true;
  } finally {
    fs.closeSync(fd);
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

/** Read a text file whole, or null only when it does not exist (ENOENT) — for the paths that
 * must never mistake an unreadable file for an absent one. A permission or I/O failure (EACCES,
 * EISDIR, EMFILE) is rethrown so the caller fails loudly instead of treating the file as gone:
 * the backlog scaffold read-modify-write (backlog-write.ts) would otherwise overwrite an
 * existing file, and the prompt-queue readers (inbox.ts's listing cache and takeQueuedFile,
 * inbox-edit.ts's rewrite) would misreport an unreadable prompt as an empty queue. Unlike
 * readTextOrNull, whose missing-and-unreadable policy serves the render paths that must never
 * throw. */
export function readTextIfExists(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    if (errCode(err) === "ENOENT") return null;
    throw err;
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

/** The PATH a binary lookup searches by default: the process PATH, or the empty string when
 * it is unset (findOnPath then finds no directories). The one home of the default so every
 * caller that exposes a `pathEnv` override falls back the same way. */
/** Expand a `~` at the start of a directory against the home dir, for an env var that points
 * at a subdirectory of home — e.g. `$PI_CODING_AGENT_DIR` (pi-models.ts's piAgentDir) and
 * `$CLAUDE_CONFIG_DIR` (claude-backend.ts's claudeConfigDir), which share this exact rule. The
 * empty case is the caller's job (each returns its own default subpath); this helper only maps
 * the bare `~` → home and `~/x` → home/x, otherwise the literal dir. */
export function expandHomeTilde(dir: string, homeDir: string): string {
  if (dir === "~") return homeDir;
  if (dir.startsWith("~/")) return path.join(homeDir, dir.slice(2));
  return dir;
}

export function envPath(): string {
  return process.env.PATH ?? "";
}

/** Locate an executable on PATH the same way spawn() would resolve it: a regular file
 * with the execute bit in some PATH directory. Returns its absolute path, or null when
 * missing (or not executable), so callers can fail fast with a clear message instead of
 * letting every tick die with "spawn <name> ENOENT". */
export function findOnPath(name: string, pathEnv: string = envPath()): string | null {
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

/** Walk UP from `startDir` — at most `maxLevels` ancestors after it, starting with `startDir`
 * itself — calling `visit` on each directory and returning the first non-null result; null
 * when no level qualifies or the filesystem root is reached. The shared climb of the build
 * check's two walk-ups (build-check-detect.ts) and the extension-side harness-root lookup
 * (pi-extension/full-output.ts). */
export function walkUp<T>(startDir: string, maxLevels: number, visit: (dir: string) => T | null): T | null {
  let dir = startDir;
  for (let level = 0; level <= maxLevels; level++) {
    const found = visit(dir);
    if (found !== null) return found;
    const parent = path.dirname(dir);
    if (parent === dir) break; // Filesystem root reached.
    dir = parent;
  }
  return null;
}

/** Recurse depth-first through `dir` calling `visit(file, entry)` for every non-directory
 * entry — regular files, symlinks, and other special entries alike, since a symlink reports
 * `isDirectory()` false; the caller filters by `entry` (isFile, name, extension). A directory
 * whose name is in `skipDirs` is not descended (node_modules/dist for the source haystack),
 * and an unreadable or vanished directory is skipped rather than thrown on, the harness's
 * missing-is-no-data policy. The shared recursion of the two tree scans — session-ledger.ts's
 * ledger prune and verdict/fix-claim.ts's source haystack — so the descend-and-swallow rule
 * cannot drift between them. (files.ts's own pruneOldFiles keeps its hand-rolled walk: it
 * removes emptied directories on the way back up, which this file-only visitor cannot do.) */
export function walkFiles(
  dir: string,
  visit: (file: string, entry: fs.Dirent) => void,
  skipDirs: ReadonlySet<string> = new Set(),
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // Vanished or unreadable — skip this directory.
  }
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) walkFiles(file, visit, skipDirs);
      continue;
    }
    visit(file, entry);
  }
}

/** Immediate subdirectory names under `dir`, in readdir order; `[]` when the directory is
 * missing or unreadable. `keep`, when given, filters by name. The worktree-root scans — the
 * doctor's leftover-checkout report, the pool's legacy-`<role>` retirement, reclaim's candidate
 * pass, and the pre-pool `_land-*` removal — all read a directory's immediate subdirectories
 * with the same walk-and-swallow error policy, so it lives here once. (walkFiles above is the
 * recursive, file-only sibling.) */
export function subdirectoryNames(dir: string, keep?: (name: string) => boolean): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // Missing or unreadable — no data.
  }
  const names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  return keep ? names.filter(keep) : names;
}

/** Write `data` — UTF-8 text or raw bytes — to `file` via a tmp file + rename, so a concurrent
 * reader of the same path sees either the old (absent) or the new content, never a partial
 * write: the prompt-inbox queue files (inbox.ts's enqueueRolePrompt) are written by one process
 * while dashboards poll, `--list` reads, and the roles dequeue in others, and a read that races
 * the write could run a tick on a truncated user request or flash one on the dashboard. The tmp
 * name carries the pid because several processes can write at once (CLI, TUI, GUI, a role's
 * re-queue); on failure the tmp is removed and the error rethrown, leaving the target untouched.
 * The harness's JSON writer (writeJsonAtomic in src/files/json-files.ts) and the config write-back
 * (writeBytesAtomic's caller, merge-git.ts's restoreConfigBytes) write through this, so the
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
 * writers that must preserve the source bytes exactly (merge-git.ts's restoreConfigBytes
 * writes back the live tumwater.json bytes the merge deleted). */
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
 * (RetentionPruner.poll), so a readdir throw escaping here would end the whole team; one
 * unreadable session directory must cost at most its own contents' retention pass.
 *
 * After a subdirectory is walked, an empty one whose own mtime is past the cutoff is removed:
 * the per-run review dirs (reviewRunSessionDir) contain only files, so without this they would
 * outlive their pruned files forever. A non-empty directory and one still in use (fresh mtime)
 * are left in place. */
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
        // Drop the directory itself once the pass has emptied it and its own mtime is past
        // the cutoff. Vanish-tolerant: a concurrent pass, a refill between the stat and the
        // readdir, or an unreadable dir just leaves it for the next pass.
        try {
          if (fs.statSync(file).mtimeMs < cutoff && fs.readdirSync(file).length === 0) {
            fs.rmdirSync(file);
          }
        } catch {
          // Vanished, unreadable, or refilled since the check; skip.
        }
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

/** The total bytes under one directory tree, counted iteratively and skipping unreadable
 * entries: a permission-denied subdirectory must not fail doctor. */
export function treeBytes(dir: string): number {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        try {
          total += fs.statSync(full).size;
        } catch {
          // A file that vanished mid-walk contributes nothing.
        }
      }
    }
  }
  return total;
}
