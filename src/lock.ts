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

/** Break a lock we cannot acquire when its holder is gone. Three cases:
 * - the dir is old enough — break regardless of holder state (covers a reused live pid);
 * - its pid file names a dead process — break;
 * - no readable pid exists at all: the holder died between mkdir and writing it (or
 *   mid-write). Break once past NO_PID_GRACE_MS. Without this case such an orphan could
 *   never be broken — not even by age, because the pid read threw before the age check ran
 *   in the old structure — and every merge would time out forever until a human deleted
 *   the dir by hand. */
function tryBreakStale(dir: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch {
    return; // Lock vanished; the next acquire attempt sorts it out.
  }
  const ageMs = Date.now() - stat.mtimeMs;
  if (ageMs > STALE_MS) {
    rmLockDir(dir);
    return;
  }
  let pid: number | null = null;
  try {
    const parsed = parseInt(fs.readFileSync(path.join(dir, "pid"), "utf8"), 10);
    if (Number.isFinite(parsed)) pid = parsed;
  } catch {
    // No readable pid file — handled below via the grace.
  }
  if (pid === null) {
    if (ageMs > NO_PID_GRACE_MS) rmLockDir(dir); // Orphaned: creator died before writing its pid.
  } else if (!pidAlive(pid)) {
    rmLockDir(dir);
  }
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
