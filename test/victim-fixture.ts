// The detached-victim fixtures shared by the process-tree tests: a long-idling node child
// whose SIGKILL is armed with the test runner the moment the victim exists, so a failed
// readiness assertion can never strand it at PPID 1 (the 2026-09-30 orphan leak) — and which
// exits by itself once the test process is gone, for the deaths no in-process hook survives
// (the 2026-10-04 leak).
import { type ChildProcess, spawn } from "node:child_process";
import type { TestContext } from "node:test";

import { runMarkerEnv } from "../src/run-marker.js";

/** Arm `child`'s kill on `t`: registered synchronously, with no await between spawn and
 * arming, so the caller cannot throw first. The sole home of the SIGKILL try/catch hook —
 * spawnVictim arms it at spawn, and callers that spawn their own shaped victim
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

/** The victim's own half of the cleanup, appended to every spawnVictim script: exit once the
 * process that spawned it is gone. armVictimKill's hook and any finally die with the test
 * process when something outside kills it mid-test, and that is not hypothetical: on
 * 2026-10-04 a conflict resolver ran `npx vitest run` in a landing worktree, vitest imported
 * the node:test files into workers (node:test runs a file's tests on import), counted 0
 * tests per file and tore each worker down mid-test, and run-marker.test.ts's detached
 * victim was left at PPID 1 four times. Reparenting is the one signal that survives every
 * such death, SIGKILL included. The spawner's pid rides in as argv[2] rather than being read
 * at startup, so a spawner that dies before the victim's first line still counts as gone. */
export const EXIT_WITH_SPAWNER = "setInterval(() => { if (process.ppid !== Number(process.argv[2])) process.exit(); }, 250);";

/** A detached `node -e` victim that writes its pid (or a readiness line) into `file` and
 * idles until killed: the kill armed at spawn (armVictimKill), the script followed by
 * EXIT_WITH_SPAWNER, and `env` (this process's environment unless given) as its launch
 * environment. */
export function spawnVictim(
  t: TestContext,
  file: string,
  script: string,
  env: NodeJS.ProcessEnv = process.env,
): ChildProcess {
  const child = spawn(process.execPath, ["-e", `${script}\n${EXIT_WITH_SPAWNER}`, file, String(process.pid)], {
    detached: true,
    stdio: "ignore",
    env,
  });
  child.unref();
  armVictimKill(t, child);
  return child;
}

/** spawnVictim carrying `marker` as a run mark. The mark is APPENDED to any inherited one
 * (runMarkerEnv, the way runPi stamps pi), never put in its place: a suite run inside a pi
 * run hands every child that run's mark, and the run's exit sweep reaps whatever still
 * carries it — on 2026-10-04 that sweep reaped the unmarked neighbour, which inherited the
 * mark, and missed the victim whose mark had been replaced. */
export function spawnMarkedVictim(t: TestContext, marker: string, file: string, script: string): ChildProcess {
  return spawnVictim(t, file, script, runMarkerEnv(process.env, marker));
}
