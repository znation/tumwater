// The detached-victim fixtures shared by the process-tree tests: a long-idling node child
// whose SIGKILL is armed with the test runner the moment the victim exists, so a failed
// readiness assertion can never strand it at PPID 1 (the 2026-09-30 orphan leak).
import { type ChildProcess, spawn } from "node:child_process";
import type { TestContext } from "node:test";

/** Arm `child`'s kill on `t`: registered synchronously, with no await between spawn and
 * arming, so the caller cannot throw first. The sole home of the SIGKILL try/catch hook —
 * spawnMarkedVictim arms it at spawn, and callers that spawn their own shaped victim
 * (process.test.ts's terminateChild escalation, run-marker.test.ts's escalation closure
 * and its regression safety net) arm it right after. */
export function armVictimKill(t: TestContext, child: ChildProcess): void {
  t.after(() => {
    try {
      if (child.pid) process.kill(child.pid, "SIGKILL");
    } catch {
      // Already gone — the expected outcome.
    }
  });
}

/** A detached, marked `node -e` victim that writes its pid (or a readiness line) into `file`
 * and idles until killed, with the kill armed at spawn (armVictimKill). */
export function spawnMarkedVictim(t: TestContext, marker: string, file: string, script: string): ChildProcess {
  const child = spawn(process.execPath, ["-e", script, file], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, TUMWATER_RUN: marker },
  });
  child.unref();
  armVictimKill(t, child);
  return child;
}