/** The persisted slot layout of the worktree pool (plans/worktree-pool.md): which
 * `.tumwater/worktrees/_slot-<n>` checkouts exist, who leases each, and which role each is
 * pinned for. Kept in its own module, apart from the pool's lease machinery, so the readers that
 * run in OTHER processes — `tumwater diff` (and the GUI's `/api/diff`) and `retire` — can resolve
 * a role's checkout from slots.json without importing the orchestrator's pool.
 *
 * Every read-modify-write goes through withSyncLock on the lock beside the file, because `retire`
 * writes it from the CLI process while the orchestrator may be leasing from its own. */

import { readJsonFile, writeJsonAtomic } from "../files/json-files.js";
import { isJsonObject } from "../files/json-object.js";
import { ensureParentDir } from "../files/files.js";
import { withSyncLock } from "../concurrency/lock.js";
import { slotsLockPath, slotsStatePath, worktreePath } from "../paths.js";
import { isUsableWorktree } from "./worktree.js";

/** A live claim on one slot: the loop and purpose using it, when the lease began, and the
 * orchestrator pid that owns it. A lease whose pid is not the running process is dead. */
interface SlotLease {
  role: string;
  purpose: "tick" | "vet";
  since: number;
  pid: number;
}

/** One pooled slot's durable record. `lastRole` and `lastReleasedAt` drive the pool's
 * most-recently-released affinity when the slot is free. */
interface SlotRecord {
  dir: string;
  lease: SlotLease | null;
  pinnedFor: string | null;
  lastRole: string | null;
  lastReleasedAt: number | null;
}

/** The whole persisted pool. */
interface SlotsState {
  slots: SlotRecord[];
}

/** Run `fn` holding the cross-process slots lock. The parent is created first: a reader or
 * `retire` may run before any state write has made `.tumwater/state/`, and withSyncLock's
 * lock directory is not created recursively. */
function withSlotsLock<T>(root: string, fn: () => T): T {
  const lock = slotsLockPath(root);
  ensureParentDir(lock);
  return withSyncLock(lock, fn);
}

/** The pool layout, or an empty one when the file is missing or unreadable. Each entry must
 * be a plain object naming a `dir` string: a stray `null`/scalar, or an object without a
 * readable `dir`, cannot name a slot, and roleWorktreeDir/slotForDir read every entry's
 * fields directly — one malformed element once threw `Cannot read properties of null`
 * straight into `tumwater diff` and the dashboard's /api/diff. Dropping only the unreadable
 * entries follows readJsonFile's no-data policy for the file as a whole: the good slots stay,
 * the reader and the operator view degrade instead of crashing. Object entries with a `dir`
 * are kept verbatim, so an update's read-modify-write still round-trips fields it does not
 * know. */
export function readSlotsState(root: string): SlotsState {
  const state = readJsonFile<SlotsState>(slotsStatePath(root));
  if (state === null || !Array.isArray(state.slots)) return { slots: [] };
  return { slots: state.slots.filter(isSlotRecord) };
}

/** True when a persisted entry is a plain object naming a `dir` string — the minimum a slot
 * record must carry to be read by roleWorktreeDir, slotForDir, or retire. */
function isSlotRecord(slot: unknown): slot is SlotRecord {
  return isJsonObject(slot) && typeof slot.dir === "string";
}

function writeSlotsStateUnlocked(root: string, state: SlotsState): void {
  writeJsonAtomic(slotsStatePath(root), state);
}

/** Replace the pool layout, serialized against competing writers. */
export function writeSlotsState(root: string, state: SlotsState): void {
  withSlotsLock(root, () => writeSlotsStateUnlocked(root, state));
}

/** Read-modify-write the pool layout under the slots lock: the one way a caller changes one
 * field without racing another process's edit. */
export function updateSlotsState(root: string, change: (state: SlotsState) => void): void {
  withSlotsLock(root, () => {
    const state = readSlotsState(root);
    change(state);
    writeSlotsStateUnlocked(root, state);
  });
}

/** The slot record whose `dir` is `dir`, or undefined when no slot lives there. */
export function slotForDir(root: string, dir: string): SlotRecord | undefined {
  return readSlotsState(root).slots.find((slot) => slot.dir === dir);
}

/** The directory holding a role's checkout, resolved from other processes' point of view
 * (plans/worktree-pool.md, "Readers find a role's checkout"): a slot listed as leased by the role
 * for a tick, or pinned for the role, wins; otherwise the legacy `worktreePath` when it is a
 * usable worktree; otherwise null (the reader's "absent" state). Changes no behavior until role
 * ticks lease slots (part 4/5), because nothing writes those leases yet. */
export async function roleWorktreeDir(root: string, role: string): Promise<string | null> {
  const slots = readSlotsState(root).slots;
  const leased = slots.find((slot) => slot.lease?.role === role && slot.lease.purpose === "tick");
  if (leased !== undefined) return leased.dir;
  const pinned = slots.find((slot) => slot.pinnedFor === role);
  if (pinned !== undefined) return pinned.dir;
  const legacy = worktreePath(root, role);
  return (await isUsableWorktree(legacy)) ? legacy : null;
}
