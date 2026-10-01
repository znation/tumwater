import fs from "node:fs";

/** Set `path`'s atime and mtime to one timestamp `ageMs` milliseconds before now — the one
 * home of the backdate-a-fixture dance (`const t = new Date(Date.now() - ms);
 * fs.utimesSync(p, t, t)`) that files/lock/status-model/fleet-state/doctor-checks/retention/
 * orchestrator-e2e each spelled out per site (lock.test.ts even grew its own local `setAge`
 * twin). A negative `ageMs` future-dates instead: the stat-cache fixtures bump a rewritten
 * file's mtime forward so the new stamp is guaranteed distinct from the previous write's on
 * coarse-grained filesystems. Both stamps always get the same value. */
export function backdate(path: string, ageMs: number): void {
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(path, t, t);
}
