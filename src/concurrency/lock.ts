import fs from "node:fs";
import path from "node:path";
import { pidAlive } from "../process/process.js";
import { errorMessage, parsePositiveInt } from "../text/text.js";
import { ensureParentDir, removeTree } from "../files/files.js";
import { errCode } from "../errno.js";

/** How old a lock dir must be before it is stale on age alone — regardless of whether its
 * recorded pid still looks alive, so a reused pid cannot latch a dead holder as live. */
const STALE_MS = 10 * 60 * 1000;
/** A creator publishes its lock dir with the holder's pid already inside (atomic rename), so a
 * visible lock always carries a readable pid. This grace remains for a pid-less dir an older
 * build or an interrupted hand operation left behind: past it, the dir is an orphan and safe
 * to break. */
const NO_PID_GRACE_MS = 5_000;

/** Remove the lock dir, ignoring races (it may already be gone or unremovable). */
function rmLockDir(dir: string): void {
  try {
    removeTree(dir);
  } catch {
    // The next acquire attempt sorts it out.
  }
}

/** The three states a merge lock can be in from the perspective of an acquirer that cannot
 * get it. "absent": no dir — nothing to wait for or break. "live": held by a process we must
 * not steal (a live pid, or a fresh no-pid dir a legacy writer may still be creating).
 * "stale": safe to break. */
type LockState = "absent" | "live" | "stale";

/** Read the lock's pid file: the holder's pid, or null when it is missing, unreadable, or
 * not plain-decimal digits naming a positive integer. The one reader of withLock's pid-file
 * convention (the `pid` filename and its plain-decimal content), shared by classifyLock,
 * lockHolderNote, and releaseOwnedLock here and by doctor's merge-lock check — so what counts
 * as a readable pid cannot drift between the breaker that acts on it, the timeout message that
 * names the holder, and the reporter that displays it. parsePositiveInt enforces the
 * documented plain-decimal rule: parseInt would accept trailing junk and a fractional or
 * signed prefix ("123abc" → 123, "1.9" → 1, "-5" → -5), so a torn or foreign pid file could
 * name an unrelated live process and latch a dead holder as live — the same latch pidAlive's
 * own guards close on the probe side. Surrounding whitespace is trimmed (a foreign writer may
 * add a newline), but embedded non-digits make the file unreadable, so classifyLock falls back
 * to the no-pid grace and eventually breaks it.
 */
export function readLockPid(dir: string): number | null {
  try {
    return parsePositiveInt(fs.readFileSync(path.join(dir, "pid"), "utf8").trim());
  } catch {
    return null; // No readable pid file.
  }
}

/** Classify a lock dir without touching it — the single definition of when a held lock is
 * safe to break, shared by tryBreakStale (which acts on the verdict) and doctor (which only
 * reports it), so the cases cannot drift. Three stale cases:
 * - the dir is old enough — stale regardless of holder state (covers a reused live pid);
 * - its pid file names a dead process — stale;
 * - no readable pid exists at all: an older build or an interrupted hand write left the dir
 *   without one (the atomic publisher never does). Stale once past NO_PID_GRACE_MS, live
 *   within it. Without this case such an orphan could never be broken — not even by age,
 *   because the pid read threw before the age check ran in the old structure — and every
 *   merge would time out forever until a human deleted the dir by hand. */
export function classifyLock(dir: string): LockState {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch {
    return "absent"; // No lock dir — nothing held, nothing stale.
  }
  const ageMs = Date.now() - stat.mtimeMs;
  if (ageMs > STALE_MS) return "stale";
  const pid = readLockPid(dir);
  if (pid === null) return ageMs > NO_PID_GRACE_MS ? "stale" : "live"; // Orphaned vs mid-creation.
  return pidAlive(pid) ? "live" : "stale";
}

/** Name the lock's holder for the timeout message: the pid its pid file records, or a note
 * that none was readable. The message surfaces as a tick's lastError, and the pid is the one
 * handle an operator needs to tell "waiting on a slow holder" from "an orphan dir nobody can
 * break" — without it every timeout reads the same and the holder has to be found by hand. */
function lockHolderNote(dir: string): string {
  const pid = readLockPid(dir);
  return pid === null ? " (no readable pid file)" : ` (held by pid ${pid})`;
}

function tryBreakStale(dir: string): void {
  if (classifyLock(dir) === "stale") rmLockDir(dir);
}

/** Release a lock dir only while it is still ours — the pid file naming our process is the
 * proof. A holder whose lock was stolen from under it (the age rule can break a live-but-
 * stalled holder's lock) must not delete whatever sits at the lock path when it lets go: by
 * then that is the successor's lock, and deleting it would let a third writer in while the
 * successor is mid-section — the exact lost-update the lock exists to prevent. Leaving the
 * dir in every other case is safe: it is either already gone, a successor's, or an orphan the
 * classify rules (dead pid, no-pid grace, age) clean up on a later acquire. */
function releaseOwnedLock(dir: string): void {
  if (readLockPid(dir) !== process.pid) return;
  rmLockDir(dir);
}

type AcquireStep =
  /** The verdict of one acquire attempt against the lock: "acquired" means our atomically
   * published dir is in place; "retry" means a live holder kept it — sleep the caller's
   * backoff and try again. acquireStep is the one definition of the acquire protocol, shared
   * by withLock and withSyncLock so the async and sync mutexes cannot drift on when a held
   * lock may be broken or how failure is reported. It throws (identically for both callers)
   * for anything waiting cannot fix: a filesystem error other than contention, or the wait
   * budget running out. */
  "acquired" | "retry";

function acquireStep(dir: string, timeoutMs: number, waitedMs: number): AcquireStep {
  // An existing path is a held lock to wait on (and maybe break); publishLockDir is only for
  // an absent path, so a read-only parent that already holds a stale lock reports contention
  // and waits instead of failing on a temp dir it cannot create.
  if (fs.existsSync(dir)) return retryOrTimeout(dir, timeoutMs, waitedMs);
  try {
    publishLockDir(dir);
  } catch (err) {
    // A lock published between the absent check and the rename: wait for it like any holder.
    // Any other errno (a read-only or missing parent, ENOSPC) cannot be fixed by waiting;
    // retrying to the deadline would replace the real cause with a misleading "timed out …
    // waiting for lock" two minutes later. Name it and fail now.
    const code = errCode(err);
    if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "ENOTDIR") {
      throw new Error(`cannot acquire lock ${dir}: ${errorMessage(err)}`);
    }
    return retryOrTimeout(dir, timeoutMs, waitedMs);
  }
  return "acquired";
}

/** The tail every wait-step in acquireStep shares once a lock is held (or was lost in the
 * publish race): break it if stale, then hand back "retry" for another pass — or throw the one
 * timeout error once the wait budget is spent. That error surfaces as a tick's lastError, and
 * naming the holder is what distinguishes a slow holder from a wedged one (and says which
 * process to look at). Single-homed so the held path and the lost-race path cannot drift. */
function retryOrTimeout(dir: string, timeoutMs: number, waitedMs: number): AcquireStep {
  tryBreakStale(dir);
  if (waitedMs > timeoutMs)
    throw new Error(`timed out after ${timeoutMs / 1000}s waiting for lock ${dir}${lockHolderNote(dir)}`);
  return "retry";
}

/** Create the lock with its holder pid already inside, published atomically by rename. The
 * protocol used to mkdir the lock path and write its pid in a second call; that left a window
 * in which the path existed with no readable pid, and a loaded host can starve the creator
 * past NO_PID_GRACE_MS inside it. A waiter then took the pid-less dir for a crashed writer's
 * remnant, broke it, and admitted a second writer while the first was still acquiring — two
 * writers ran the guarded section at once and one read-modify-write was lost (BUGS.md
 * 2026-10-07). Publishing the finished dir with rename closes the window: the lock path is
 * either absent or carries its pid, so classifyLock's no-pid branch only ever sees a remnant
 * an older build or an interrupted hand write left behind. */
function publishLockDir(dir: string): void {
  sweepStaleTemps(dir);
  const tmp = `${dir}.acquiring-${process.pid}`;
  rmLockDir(tmp); // Our own remnant from an acquire this process crashed before publishing.
  fs.mkdirSync(tmp, { recursive: false });
  try {
    fs.writeFileSync(path.join(tmp, "pid"), String(process.pid));
    fs.renameSync(tmp, dir); // Atomic: a non-empty dir already at `dir` means someone else holds it.
  } catch (err) {
    rmLockDir(tmp); // Never leave behind a temp dir we own but did not publish.
    throw err;
  }
}

/** Remove `.acquiring-*` temp dirs left beside a lock by a creator that crashed before its
 * rename — the one remnant atomic publication can leave. Only dirs older than STALE_MS are
 * touched, far beyond any scheduling stall, so a live creator's in-flight temp is never
 * removed. */
function sweepStaleTemps(dir: string): void {
  const parent = path.dirname(dir);
  const prefix = `${path.basename(dir)}.acquiring-`;
  let entries: string[];
  try {
    entries = fs.readdirSync(parent);
  } catch {
    return; // No parent to sweep; the acquire's own mkdir reports the real cause.
  }
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    const candidate = path.join(parent, name);
    try {
      if (Date.now() - fs.statSync(candidate).mtimeMs > STALE_MS) rmLockDir(candidate);
    } catch {
      // Raced away or unreadable — the next acquire can sort it out.
    }
  }
}

/** Directory-and-pid mutex shared by all loops (and processes) of one project: the holder
 * publishes a dir with its pid in it by atomic rename. */
export async function withLock<T>(dir: string, fn: () => Promise<T>, timeoutMs = 120_000): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    if (acquireStep(dir, timeoutMs, Date.now() - startedAt) === "acquired") break;
    await new Promise((r) => setTimeout(r, 200 + Math.random() * 300));
  }
  try {
    return await fn();
  } finally {
    releaseOwnedLock(dir);
  }
}

/** The synchronous twin of withLock, for short critical sections reached from code that cannot
 * await — pauseRole/resumeRole are called from sync writers and from sync tests. The protocol
 * itself is literally shared (acquireStep carries rename-admits-one-writer and the pid the
 * published dir carries, classifyLock's live-vs-stale rule, and the timeout error;
 * releaseOwnedLock keeps a
 * robbed holder from deleting its successor's lock), so the two mutexes cannot drift on when a
 * held lock may be broken. Waits on a millisecond busy-sleep instead of an async timer — the
 * sections it guards are single-file read-modify-writes, microseconds long, so the finer
 * backoff. The default timeout out-waits the NO_PID_GRACE_MS recovery of a crashed creator yet
 * still degrades a wedged holder to a clear error rather than a silent unlocked write. */
export function withSyncLock<T>(dir: string, fn: () => T, timeoutMs = 10_000): T {
  const startedAt = Date.now();
  for (;;) {
    if (acquireStep(dir, timeoutMs, Date.now() - startedAt) === "acquired") break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5 + Math.floor(Math.random() * 10));
  }
  try {
    return fn();
  } finally {
    releaseOwnedLock(dir);
  }
}

/** The one way a state-file read-modify-write takes its cross-process lock: create the lock's
 * parent directory first, then run `fn` under withSyncLock. The parent must exist because these
 * locks sit under `.tumwater/state/`, which a first writer (a CLI command, a standalone
 * dashboard) may reach before any state file has created it, and withSyncLock does not create
 * its lock directory recursively. Single-homing the pair keeps the parent-dir requirement from
 * being forgotten when a new state file adds a lock. */
export function withStateLock<T>(lock: string, fn: () => T, timeoutMs = 10_000): T {
  ensureParentDir(lock);
  return withSyncLock(lock, fn, timeoutMs);
}

/** The async twin of withStateLock, for a critical section that must await (the landing's
 * working-tree fast-forward runs git). Same lock directory and protocol as withStateLock, so a
 * sync writer and an async one on the same path exclude each other; ensureParentDir runs first
 * for the same reason. The default timeout is withStateLock's, not withLock's longer merge-lock
 * budget: these sections are one file read-modify-write or one fast-forward. */
export async function withStateLockAsync<T>(lock: string, fn: () => Promise<T>, timeoutMs = 10_000): Promise<T> {
  ensureParentDir(lock);
  return withLock(lock, fn, timeoutMs);
}
