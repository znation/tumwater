/** Process-liveness probe shared by every place that decides whether a recorded pid still
 * belongs to a live process: the merge lock's stale-holder check (lock.ts) and the
 * orchestrator-alive status (state.ts). */

/** True when a process with this pid exists — a signal-0 send, which cannot affect the
 * target. Any error reads as "not alive": no such process (ESRCH), or permission denied
 * (EPERM, e.g. the pid was recycled by another user's process) — the harness only probes
 * pids of its own fleet, so a live foreign holder must not be mistaken for one of ours. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
