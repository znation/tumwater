import fs from "node:fs";
import path from "node:path";
import { pidAlive } from "./process.js";
import { errorMessage, parsePositiveInt } from "./text.js";
import { removeTree } from "./files.js";

/** How old a lock dir must be before it is stale on age alone — regardless of whether its
 * recorded pid still looks alive, so a reused pid cannot latch a dead holder as live. */
const STALE_MS = 10 * 60 * 1000;
/** A holder writes its pid file immediately after mkdir; if no readable pid exists this long
 * after the dir appeared, the holder died (or wedged) between the two calls and the lock is
 * orphaned. The grace keeps us from breaking a lock whose live creator is mid-creation. */
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
 * not steal (a live pid, or a fresh no-pid dir whose creator may still be between mkdir and
 * the pid write). "stale": safe to break. */
type LockState = "absent" | "live" | "stale";

/** Read the lock's pid file: the holder's pid, or null when it is missing, unreadable, or
 * not plain-decimal digits naming a positive integer. The one reader of withLock's pid-file
 * convention (the `pid` filename and its plain-decimal content), shared by classifyLock here
 * and doctor's merge-lock check — so what counts as a readable pid cannot drift between the
 * breaker that acts on it and the reporter that displays it. parsePositiveInt enforces the
 * documented plain-decimal rule: parseInt would accept trailing junk and a fractional or
 * signed prefix ("123abc" → 123, "1.9" → 1, "-5" → -5), so a torn or foreign pid file could
 * name an unrelated live process and latch a dead holder as live — the same latch pidAlive's
 * own guards close on the probe side. Surrounding whitespace is trimmed (a foreign writer may
 * add a newline), but embedded non-digits make the file unreadable, so classifyLock falls back
 * to the no-pid grace and eventually breaks it. Read by classifyLock and releaseOwnedLock
 * here and by doctor's merge-lock check — one definition of what counts as a readable pid.
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
 * - no readable pid exists at all: the holder died between mkdir and writing it (or
 *   mid-write). Stale once past NO_PID_GRACE_MS, live within it. Without this case such an
 *   orphan could never be broken — not even by age, because the pid read threw before the
 *   age check ran in the old structure — and every merge would time out forever until a
 *   human deleted the dir by hand. */
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
  /** The verdict of one mkdir attempt against the lock: "acquired" means the dir is ours and
   * its pid file written; "retry" means a live holder kept it — sleep the caller's backoff and
   * try again. acquireStep is the one definition of the acquire protocol, shared by withLock
   * and withSyncLock so the async and sync mutexes cannot drift on when a held lock may be
   * broken or how failure is reported. It throws (identically for both callers) for anything
   * waiting cannot fix: a non-EEXIST mkdir failure, or the wait budget running out. */
  "acquired" | "retry";

function acquireStep(dir: string, timeoutMs: number, waitedMs: number): AcquireStep {
  try {
    fs.mkdirSync(dir, { recursive: false });
  } catch (err) {
    // Only a held lock (EEXIST) is worth waiting for — a concurrent holder releases it. Any
    // other errno (a read-only or missing parent, a file in the way, ENOSPC) cannot be fixed
    // by waiting; retrying to the deadline would replace the real cause with a misleading
    // "timed out … waiting for lock" two minutes later. Name it and fail now.
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new Error(`cannot acquire lock ${dir}: ${errorMessage(err)}`);
    }
    tryBreakStale(dir);
    // Report the wait budget and the holder: this surfaces as a tick's lastError, and
    // "gave up after 120s waiting on pid 999" is what distinguishes a slow holder from a
    // wedged one (and names which process to look at).
    if (waitedMs > timeoutMs)
      throw new Error(`timed out after ${timeoutMs / 1000}s waiting for lock ${dir}${lockHolderNote(dir)}`);
    return "retry";
  }
  markLockHolder(dir);
  return "acquired";
}

/** Write the holder pid into a freshly acquired lock dir; roll the dir back when the write
 * fails so the acquirer never leaves behind an orphan it owns but has not marked. */
function markLockHolder(dir: string): void {
  try {
    fs.writeFileSync(path.join(dir, "pid"), String(process.pid));
  } catch (err) {
    rmLockDir(dir); // We took the dir; a failed pid write must not leave an orphan we own.
    throw err;
  }
}

/** mkdir-based mutex shared by all loops (and processes) of one project. */
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
 * itself is literally shared (acquireStep carries mkdir-admits-one-writer, the pid-file holder
 * mark, classifyLock's live-vs-stale rule, and the timeout error; releaseOwnedLock keeps a
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
