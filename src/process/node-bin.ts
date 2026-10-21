/** Choosing which node binary a supervised child or self-reexec spawns, shared by the
 * supervisor (spawnSupervised, src/process/supervisor.ts) and the dashboard reload
 * (reexecSelf, src/redeploy/self-reload.ts). Both embed `process.execPath`, which is the
 * running process's resolved, versioned node path — a Homebrew upgrade under the running team
 * deletes the old keg while the team stays up, so `execPath` names a file that no longer
 * exists (BUGS.md 2026-10-21). The fix is the same trick build-stage's `compileStaged` uses
 * for tsc (BUGS-FIXED.md, the 2026-09-29 `tsc exited ENOENT` cluster): PATH resolves a live
 * node at spawn time, so fall back to the bare `node` when the recorded binary is gone.
 * Nothing spawns until a child is created, so this cheap existence check is the whole fix. */

import fs from "node:fs";

/** The node binary to pass `spawn` for a harness child: the running process's own `execPath`
 * while it still exists, else the bare `node` resolved through PATH. An explicit path makes
 * the deleted-keg branch testable without touching this process. */
export function liveNodeBin(execPath: string = process.execPath): string {
  return fs.existsSync(execPath) ? execPath : "node";
}
