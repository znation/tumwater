/** The worktree pool's one-time startup layout migration (plans/worktree-pool.md, parts 4c/5):
 * move the pre-pool `.tumwater/worktrees/<role>` checkouts onto the pooled `_slot-<n>` layout, and
 * pin the slots a previous process died in. Split out of worktree-pool.ts so that module — the
 * runtime lease machinery every run and verify calls — does not also carry the passes the
 * orchestrator runs exactly once on a team's start. These two passes read and rewrite the same
 * persisted slots.json (updateSlotsState) and run after every RoleRunner is constructed but
 * before any run can lease; they are exported only for orchestrator.ts and the worktree-pool
 * tests. */

import path from "node:path";
import { worktreesDir, isCanonicalSlotDir } from "../paths.js";
import { loadRunnerState } from "../runner/runner-state-load.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";
import { updateSlotsState } from "./slots-state.js";
import { removeWorktreeDir } from "./worktree.js";
import { warnEventBestEffort, TUMWATER_SOURCE } from "../events/events.js";
import { errorMessage } from "../text/text.js";
import { subdirectoryNames } from "../files/files.js";

/** One-time startup migration (plans/worktree-pool.md "Legacy role worktrees", part 4c/5):
 * retire the pre-pool `.tumwater/worktrees/<role>` checkouts now that runs lease pooled slots.
 * A resumable enabled role keeps its legacy dir as a pinned slot so its pending resume runs in
 * the same cwd; every other legacy dir is removed (its branch keeps any commit), and pins for
 * roles outside `configured` are cleared. `configured` is every role id the config's roles
 * enable (`runnerIds`), never a `--once --role` filter: a scoped run must leave the other roles'
 * legacy dirs and pins alone, or it silently loses their pending resumes. It runs after
 * `runOrchestrator` constructs every
 * `RoleRunner` but before any run can call `leaseSlot`: the constructor infers `resumePending`
 * from the on-disk `running` flag only in memory (it does not save it), so `loadRunnerState` here
 * still reports the on-disk flags. *Removing* a dir is best-effort and logged: the slot records
 * are already updated, so a leaked directory is only a leak the next prune collects. */
export async function retireLegacyRoleWorktrees(
  root: string,
  configured: readonly string[],
): Promise<void> {
  const dir = worktreesDir(root);
  // A missing worktrees dir (a team that has not started) yields no names to migrate; the pin
  // retirement pass below still runs over whatever slots.json holds.
  const names = subdirectoryNames(
    dir,
    (name) => name !== DIRECTOR_ROLE && !name.startsWith("_"),
  );
  const configuredSet = new Set(configured);
  const toRemove = new Set<string>();
  updateSlotsState(root, (state) => {
    for (const role of names) {
      const legacyDir = path.join(dir, role);
      const legacy = loadRunnerState(root, role);
      const resumable = legacy.resumePending === true || legacy.running === true;
      const ownRecord = state.slots.find((slot) => slot.dir === legacyDir);
      if (resumable && configuredSet.has(role)) {
        const owned = state.slots.find(
          (slot) =>
            slot.pinnedFor === role ||
            (slot.lease?.role === role && slot.lease.purpose === "run"),
        );
        if (owned !== undefined) {
          // The resume happens in the owned slot: drop the legacy record and remove its dir.
          if (owned.dir !== legacyDir) {
            state.slots = state.slots.filter((slot) => slot.dir !== legacyDir);
            toRemove.add(legacyDir);
          }
          if (owned.pinnedFor !== role) owned.pinnedAt = Date.now();
          owned.pinnedFor = role;
        } else if (ownRecord !== undefined) {
          // Already migrated (a restart before the resume ran): keep it pinned and inert,
          // preserving the pin's original age for the doctor's stuck-pin warning.
          ownRecord.lease = null;
          if (ownRecord.pinnedFor !== role) ownRecord.pinnedAt = Date.now();
          ownRecord.pinnedFor = role;
          ownRecord.lastRole = null;
          ownRecord.lastReleasedAt = null;
        } else {
          state.slots.push({
            dir: legacyDir,
            lease: null,
            pinnedFor: role,
            pinnedAt: Date.now(),
            lastRole: null,
            lastReleasedAt: null,
          });
        }
      } else {
        state.slots = state.slots.filter((slot) => slot.dir !== legacyDir);
        toRemove.add(legacyDir);
      }
    }
    // A paused or removed role must not leak a permanently pinned checkout.
    for (const slot of [...state.slots]) {
      if (slot.pinnedFor === null || configuredSet.has(slot.pinnedFor)) continue;
      slot.pinnedFor = null;
      slot.pinnedAt = null;
      if (!isCanonicalSlotDir(slot.dir)) {
        state.slots = state.slots.filter((s) => s !== slot);
        toRemove.add(slot.dir);
      }
    }
  });
  for (const victim of toRemove) {
    try {
      await removeWorktreeDir(root, victim);
    } catch (err) {
      warnEventBestEffort(
        root,
        TUMWATER_SOURCE,
        `could not remove legacy role workspace ${victim}: ${errorMessage(err)}`,
      );
    }
  }
}

/** Startup pass for runs the previous process died in (crash, kill -9, power loss): such a run's
 * lease is still in slots.json with the dead pid, and its RoleRunner reads the persisted
 * `running` flag as a resume that must run in the same checkout, the cwd its session used. Pin
 * each such slot for its role, as the graceful shutdown's abort pin would have, unless the role
 * already holds a pin; the next claim then clears the dead lease (marking the run unsettled) and
 * the resume leases the pinned slot with its edits in place. Only configured roles count, as in
 * retireLegacyRoleWorktrees, so a removed role never leaks a pin. Like that pass, it runs before
 * any run can lease, while loadRunnerState still reports the on-disk flags. */
export function pinCrashedRuns(root: string, configured: readonly string[]): void {
  const configuredSet = new Set(configured);
  updateSlotsState(root, (state) => {
    for (const slot of state.slots) {
      const lease = slot.lease;
      if (lease === null || lease.pid === process.pid || lease.purpose !== "run") continue;
      if (!configuredSet.has(lease.role) || state.slots.some((s) => s.pinnedFor === lease.role)) continue;
      const runner = loadRunnerState(root, lease.role);
      if (runner.running !== true && runner.resumePending !== true) continue;
      slot.pinnedFor = lease.role;
      slot.pinnedAt = Date.now();
    }
  });
}
