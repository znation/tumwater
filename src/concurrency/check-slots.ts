import path from "node:path";
import { classifyLock, releaseOwnedLockDir, tryClaimLockDir } from "./lock.js";
import { ensureParentDir, isDirectory, removeTree, walkUp } from "../files/files.js";

/** The host-wide suite-slot ledger that bounds how many project check scripts (an agent's bare
 * `npm run test:gate` and the harness's own spawned check alike) run their suite step at once,
 * sized to the same `config.maxConcurrentChecks` the in-process check permit enforces. Where
 * withCheckPermit is one process-wide semaphore (every suite spawned by THIS process shares it),
 * the ledger is files on disk so suites started by DIFFERENT processes — the harness and the pi
 * agent's bash tools, or two agents at once — still contend for the same cap. It exists to close
 * the gap where an agent's own suite run takes no team check permit at all (BUGS.md 2026-10-28),
 * so the two mechanisms coexist: withCheckPermit keeps its in-process tier queue, reentrancy and
 * callers exactly as they are, and the npm check scripts additionally claim a slot here.
 *
 * A slot is a lock dir under `.tumwater/state/check-permits/slot-<n>` using lock.ts's directory-
 * and-pid protocol unchanged (tryClaimLockDir / releaseOwnedLockDir / classifyLock), so a killed
 * suite's slot is reclaimed by lock.ts's stale rules (dead pid, no-pid grace, then age) on a later
 * claim — no separate sweep. A waiter gives up after a bounded wait and runs the suite anyway with
 * a warning rather than hanging past the check deadline or the bash tool's 600 s cap: the ledger
 * is a scheduling throttle, not a correctness mutex, so a full ledger must degrade to "run
 * anyway", never to "hang forever". */

/** How long acquireCheckSlot keeps trying for a free slot before giving up and returning null (the
 * callers then run the suite unpermitted with a warning). Bounded well under the bash tool's 600 s
 * cap so a full ledger never prices a run's own timeout. */
const CHECK_SLOT_WAIT_TIMEOUT_MS = 60_000;

/** The retry cadence between full passes over a full ledger — a slot frees quickly (a suite's
 * release is the moment its check process exits), so a 200 ms repoll finds it almost immediately
 * without hammering the filesystem. */
const CHECK_SLOT_RETRY_MS = 200;

/** The ancestor of `startDir` that holds the team's `.tumwater/state`, or null when none within the
 * walk's bound does. The slot ledger lives under that state dir, so `scripts/check-permit.mjs`
 * locates the root the same way the harness's own root lookup does (shared walkUp climb), and a
 * suite run outside any team root has no ledger to contend for. Exported for tests. */
export function findTeamRoot(startDir = process.cwd()): string | null {
  return walkUp(startDir, 63, (dir) => (isDirectory(path.join(dir, ".tumwater", "state")) ? dir : null));
}

/** The slot directory for `index` of a ledger rooted at `root` (under `root/.tumwater/state`). One
 * function owns the path so the acquirer, the releaser and the reclaim all name the same dir. */
export function checkSlotDir(root: string, index: number): string {
  return path.join(root, ".tumwater", "state", "check-permits", `slot-${index}`);
}

/** Claim one of the `cap` slots of `root`'s ledger, waiting up to `waitMs` for one to free. Walks
 * slots `0..cap-1`, breaking any it finds lock.ts's classifyLock calls "stale" (a dead holder, a
 * leftover no-pid dir past its grace, or an old dir), then trying to claim each by atomic publish;
 * when none is free it sleeps and retries until the budget is spent, returning null. A stale slot
 * is broken as encountered because a dead holder's dir would otherwise block that index forever. */
export async function acquireCheckSlot(root: string, cap: number, waitMs = CHECK_SLOT_WAIT_TIMEOUT_MS): Promise<string | null> {
  // The ledger's parent must exist before any slot's atomic publish can create it: lock.ts's
  // publishLockDir never makes its own parent (withStateLock is where ensureParentDir runs), so a
  // first claim on a root with no check-permits dir would fail its mkdirSync and never acquire.
  ensureParentDir(checkSlotDir(root, 0));
  const startedAt = Date.now();
  for (;;) {
    for (let index = 0; index < cap; index++) {
      const dir = checkSlotDir(root, index);
      if (classifyLock(dir) === "stale") removeTree(dir);
      if (tryClaimLockDir(dir)) return dir;
    }
    if (Date.now() - startedAt >= waitMs) return null;
    await new Promise((resolve) => setTimeout(resolve, CHECK_SLOT_RETRY_MS));
  }
}

/** Return a slot claimed by THIS process. Deleting a dir that another pid now owns must not
 * happen (releaseOwnedLockDir checks the pid first); a slot stolen from under us stays for its
 * new owner or for the stale rules. */
export function releaseCheckSlot(dir: string): void {
  releaseOwnedLockDir(dir);
}
