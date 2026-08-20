import fs from "node:fs";
import path from "node:path";

/** How old a lock must be before we consider stealing it from a dead process. */
const STALE_MS = 10 * 60 * 1000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tryBreakStale(dir: string): void {
  try {
    const stat = fs.statSync(dir);
    const pid = parseInt(fs.readFileSync(path.join(dir, "pid"), "utf8"), 10);
    const dead = Number.isFinite(pid) && !pidAlive(pid);
    const old = Date.now() - stat.mtimeMs > STALE_MS;
    if (dead || old) fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Lock vanished or is unreadable; the next acquire attempt sorts it out.
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
      if (Date.now() > deadline) throw new Error(`timed out acquiring lock ${dir}`);
      await new Promise((r) => setTimeout(r, 200 + Math.random() * 300));
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
