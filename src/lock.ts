import fs from "node:fs";
import path from "node:path";
import { pidAlive } from "./process.js";

/** How old a lock must be before we consider stealing it from a dead process. */
const STALE_MS = 10 * 60 * 1000;
/** A holder writes its pid file immediately after mkdir; if no readable pid exists this long
 * after the dir appeared, the holder died (or wedged) between the two calls and the lock is
 * orphaned. The grace keeps us from breaking a lock whose live creator is mid-creation. */
const NO_PID_GRACE_MS = 5_000;

/** Remove the lock dir, ignoring races (it may already be gone or unremovable). */
function rmLockDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
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
 * not a finite integer. The one reader of withLock's pid-file convention (the `pid` filename
 * and its plain-decimal content), shared by classifyLock here and doctor's merge-lock check —
 * so what counts as a readable pid cannot drift between the breaker that acts on it and the
 * reporter that displays it. */
export function readLockPid(dir: string): number | null {
  try {
    const parsed = parseInt(fs.readFileSync(path.join(dir, "pid"), "utf8"), 10);
    return Number.isFinite(parsed) ? parsed : null;
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

function tryBreakStale(dir: string): void {
  if (classifyLock(dir) === "stale") rmLockDir(dir);
}

/** mkdir-based mutex shared by all loops (and processes) of one project. */
export async function withLock<T>(dir: string, fn: () => Promise<T>, timeoutMs = 120_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.mkdirSync(dir, { recursive: false });
      fs.writeFileSync(path.join(dir, "pid"), String(process.pid));
      break;
    } catch {
      tryBreakStale(dir);
      // Report the wait budget: this surfaces as a tick's lastError, and "gave up after
      // 120s" is what distinguishes a slow holder from a wedged one.
      if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs / 1000}s waiting for lock ${dir}`);
      await new Promise((r) => setTimeout(r, 200 + Math.random() * 300));
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
