// The detached-victim fixtures shared by the process-tree tests: a long-idling node child
// whose SIGKILL is armed with the test runner the moment the victim exists, so a failed
// readiness assertion can never strand it at PPID 1 (the 2026-09-30 orphan leak) — and which
// exits by itself once the test process is gone, for the deaths no in-process hook survives
// (the 2026-10-04 leak). exitWithOwnerEnv and ownerAliveSh give any other child a test starts
// that same second half.
import { type ChildProcess, spawn } from "node:child_process";
import type { TestContext } from "node:test";

import { runMarkerEnv } from "../src/process/run-marker.js";
import { OWNER_PID_ENV } from "./exit-with-owner.js";

/** The owner-watch preload (exit-with-owner.ts), as the NODE_OPTIONS flag that loads it. */
const OWNER_PRELOAD = `--import=${new URL("./exit-with-owner.js", import.meta.url).href}`;

/** `base` for a child that must not outlive `owner` (this test process unless given): every
 * node process started under it — the child and, since NODE_OPTIONS and the pid variable ride
 * along, everything node it starts in turn — exits once the owner is gone, however the owner
 * died. A finally or t.after hook still does the normal reaping; this covers the deaths that
 * run neither (a foreign runner's worker teardown, a SIGKILL). The preload is appended once,
 * after whatever NODE_OPTIONS already carries; the owner is always this call's, so a stand-in
 * test process that spawns its own children through here becomes their owner. */
export function exitWithOwnerEnv(base: NodeJS.ProcessEnv = process.env, owner = process.pid): NodeJS.ProcessEnv {
  const opts = base.NODE_OPTIONS ?? "";
  const nodeOptions = opts.split(/\s+/).includes(OWNER_PRELOAD) ? opts : `${opts} ${OWNER_PRELOAD}`.trim();
  return { ...base, [OWNER_PID_ENV]: String(owner), NODE_OPTIONS: nodeOptions };
}

/** The shell half of exitWithOwnerEnv, for the fake scripts a test writes (sh never loads the
 * node preload): a condition that holds while `owner` lives. A wait loop that would otherwise
 * spin until the test creates a file (`while [ ! -f go ]`) ANDs it in, so a test process
 * killed mid-wait does not leave the loop forking `sleep` forever. */
export function ownerAliveSh(owner = process.pid): string {
  return `kill -0 ${owner} 2>/dev/null`;
}

/** Arm `child`'s kill on `t`: registered synchronously, with no await between spawn and
 * arming, so the caller cannot throw first. The sole home of the SIGKILL try/catch hook —
 * spawnVictim arms it at spawn, and callers that spawn their own shaped child
 * (run-marker.test.ts's stand-in test process and its regression safety net) arm it right
 * after. */
export function armVictimKill(t: TestContext, child: ChildProcess): void {
  t.after(() => {
    try {
      if (child.pid) process.kill(child.pid, "SIGKILL");
    } catch {
      // Already gone — the expected outcome.
    }
  });
}

/** A detached `node -e` victim that writes its pid (or a readiness line) into `file` and
 * idles until killed: the kill armed at spawn (armVictimKill), and `env` (this process's
 * environment unless given) as its launch environment, under exitWithOwnerEnv. */
export function spawnVictim(
  t: TestContext,
  file: string,
  script: string,
  env: NodeJS.ProcessEnv = process.env,
): ChildProcess {
  const child = spawn(process.execPath, ["-e", script, file], {
    detached: true,
    stdio: "ignore",
    env: exitWithOwnerEnv(env),
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
