/** The worktree pool's lease machinery (plans/worktree-pool.md, "Leases"; part 2a/5): a fixed set
 * of `.tumwater/worktrees/_slot-<n>` checkouts that runs and verifies lease and switch commits in
 * place, instead of keeping one `_land-<role>` checkout per role. The persisted layout and its
 * cross-process lock live in slots-state.ts, which other processes (`tumwater diff`, `retire`) also
 * read; this module owns choosing a slot, holding it through the disk-floor registry, and handing
 * it back. Since part 4/5 landed, a role's run (runner-run.ts) and a merge (merge-batch.ts)
 * both acquire one through leaseSlot.
 *
 * The lease decision is synchronous: `updateSlotsState` writes slots.json under the slots lock, and
 * one Node process runs every run and merge, so two concurrent `leaseSlot` calls claim distinct
 * free slots and a call with none free registers an in-process waiter. A release wakes the waiters,
 * which re-decide; `signal` aborts a waiter. */

import path from "node:path";
import { loadConfig, slotCount } from "../config/config.js";
import { worktreesDir, slotWorktreePath } from "../paths.js";
import { loadRunnerState } from "../runner/runner-state-load.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";
import { readSlotsState, slotForDir, updateSlotsState, type SlotPurpose } from "./slots-state.js";
import { salvageSlotLeftovers } from "./slot-salvage.js";
import { beginWorktreeUse } from "./worktree-use.js";
import { ensureDetachedWorktree, removeWorktreeDir } from "./worktree.js";
import { logEventBestEffort, warnEventBestEffort, tryOrWarn, TUMWATER_SOURCE } from "../events/events.js";
import { errorMessage } from "../text/text.js";
import { subdirectoryNames } from "../files/files.js";
import { dropProviderLeaseKey } from "../concurrency/provider-lease.js";

/** A live lease as callers see it: the slot directory, the one-shot release, and whether the
 * slot's existing checkout was kept as-is. */
export interface SlotLeaseHandle {
  dir: string;
  /** Idempotent. Only the first call's options apply; `pin` keeps the slot pinned for the role,
   * and `unsettled` says a run lease is given up without its run settling the worktree (an
   * exception escaped it), so edits left in the slot go back to the role's next run. */
  release: (options?: { pin?: boolean; unsettled?: boolean }) => void;
  /** True when the slot was already pinned for the role and its checkout was left untouched;
   * false when the lease reset the slot to `ref`. */
  preserved: boolean;
}

interface LeaseSlotOptions {
  /** The role the slot is held for; drives affinity and the persisted lease record. */
  role: string;
  purpose: SlotPurpose;
  /** The commit the slot is prepared at (a sha or branch name; ensureDetachedWorktree
   * resets it). */
  ref: string;
  /** Aborts a lease that is still waiting for a free slot. */
  signal?: AbortSignal;
  /** Keep the existing checkout when the chosen slot is pinned for `role` instead of resetting
   * it to `ref` (a resume must run in the same cwd its session last used). */
  keep?: boolean;
  /** The pool budget the LIVE config resolves to (slotCount of the orchestrator's
   * last-known-good view). When given, acquire never re-reads tumwater.json itself — a
   * mid-run broken file used to error every lease with a raw load failure before any pi run
   * (2026-10-08) even though the orchestrator held a good config all along. */
  slotBudget?: number;
}

/** The parts of a slot record this module reads and writes — structurally slots-state.ts's
 * SlotRecord. Redeclared rather than imported so the persisted shape stays owned by the state
 * module and this one depends only on the fields it uses. */
interface PoolSlot {
  dir: string;
  lease: { role: string; purpose: SlotPurpose; since: number; pid: number } | null;
  pinnedFor: string | null;
  /** When the current pin began (epoch ms), or null when unpinned. Optional so slot records
   * written before this field existed read as "pin age unknown" (the doctor warns only on a
   * known-old pin). */
  pinnedAt?: number | null;
  lastRole: string | null;
  lastReleasedAt: number | null;
  unsettledRun?: string | null;
}

interface PoolState {
  slots: PoolSlot[];
}

/** In-process waiters per root, woken when any slot is released. Keyed by resolved root so two
 * roots never wake each other. */
const waiters = new Map<string, Set<() => void>>();

function rootKey(root: string): string {
  return path.resolve(root);
}

function abortError(): Error {
  const err = new Error("the workspace request was stopped before one was free");
  err.name = "AbortError";
  return err;
}

/** Register a waiter and return the promise a release settles, plus the resolver a caller needs
 * to drop it on abort. Registration is synchronous and runs in the same turn as the failed
 * claim, so a release can never slip between the two and leave the waiter asleep. */
function registerWaiter(root: string): { promise: Promise<void>; resolve: () => void } {
  const key = rootKey(root);
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  let set = waiters.get(key);
  if (set === undefined) {
    set = new Set();
    waiters.set(key, set);
  }
  set.add(resolve);
  return { promise, resolve };
}

function dropWaiter(root: string, resolve: () => void): void {
  const key = rootKey(root);
  const set = waiters.get(key);
  if (set === undefined) return;
  set.delete(resolve);
  if (set.size === 0) waiters.delete(key);
}

function wakeWaiters(root: string): void {
  const key = rootKey(root);
  const set = waiters.get(key);
  if (set === undefined) return;
  waiters.delete(key);
  for (const resolve of set) resolve();
}

/** Reject when `signal` aborts before `wait` resolves; pass `wait` through when there is none. */
function raceAbort(wait: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) return wait;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    void wait.then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}

/** Clear leases owned by any process other than this one: their runs are dead (design "Leases").
 * Pins are kept, and the freed slots become candidates for the current claim. A dead lease never
 * released, so its role is recorded as the slot's last holder here, and a dead run as unsettled:
 * whatever it left in the slot is that role's unfinished work (slot-salvage.ts). */
function clearDeadLeases(state: PoolState, pid: number): void {
  for (const slot of state.slots) {
    if (slot.lease === null || slot.lease.pid === pid) continue;
    slot.lastRole = slot.lease.role;
    slot.unsettledRun = slot.lease.purpose === "run" ? slot.lease.role : null;
    slot.lease = null;
  }
}

function claim(slot: PoolSlot, role: string, purpose: SlotPurpose, now: number, pid: number): string {
  slot.lease = { role, purpose, since: now, pid };
  return slot.dir;
}

/** The free slot released most recently among `slots`, or undefined when none qualifies. A
 * never-released slot sorts as oldest. */
function mostRecentlyReleased(slots: PoolSlot[]): PoolSlot | undefined {
  return slots.reduce<PoolSlot | undefined>(
    (best, slot) =>
      best === undefined || (slot.lastReleasedAt ?? -1) > (best.lastReleasedAt ?? -1) ? slot : best,
    undefined,
  );
}

/** Choose and claim a slot for `role` in the design's order: its pinned slot, the free slot it
 * released most recently, the free slot anyone released most recently, a new `_slot-<n>` while
 * fewer than `count` unpinned slots exist, else null (the caller waits). Mutates `state`; a slot
 * pinned for another role is reserved and never chosen. */
function chooseSlot(
  root: string,
  state: PoolState,
  role: string,
  purpose: SlotPurpose,
  count: number,
  now: number,
  pid: number,
): string | null {
  clearDeadLeases(state, pid);
  const free = state.slots.filter((slot) => slot.lease === null);
  // A check slot is a scratch checkout: it never takes a slot pinned for any role, the leasing
  // role's own included (that pin holds the author's resumable work).
  const eligible = free.filter((slot) =>
    purpose === "verify-check" ? slot.pinnedFor === null : slot.pinnedFor === null || slot.pinnedFor === role,
  );
  const pinned = eligible.find((slot) => slot.pinnedFor === role);
  if (pinned !== undefined) return claim(pinned, role, purpose, now, pid);

  const mine = mostRecentlyReleased(
    eligible.filter((slot) => slot.pinnedFor === null && slot.lastRole === role),
  );
  if (mine !== undefined) return claim(mine, role, purpose, now, pid);
  const any = mostRecentlyReleased(eligible.filter((slot) => slot.pinnedFor === null));
  if (any !== undefined) return claim(any, role, purpose, now, pid);

  const unpinned = state.slots.filter((slot) => slot.pinnedFor === null).length;
  if (unpinned < count) {
    const used = new Set(state.slots.map((slot) => slot.dir));
    let n = 1;
    while (used.has(slotWorktreePath(root, n))) n += 1;
    const dir = slotWorktreePath(root, n);
    state.slots.push({
      dir,
      lease: { role, purpose, since: now, pid },
      pinnedFor: null,
      pinnedAt: null,
      lastRole: null,
      lastReleasedAt: null,
    });
    return dir;
  }
  return null;
}

/** A lease that waited at least this long for a free slot is worth an event: it is the
 * operator's signal that `worktreeSlots` is too small for the current concurrency. */
export const SLOT_WAIT_EVENT_MS = 30_000;

/** Log one `slot_wait` when a lease waited at least SLOT_WAIT_EVENT_MS; a shorter wait is
 * ordinary queueing and stays silent. The event names the pool size and how many of its slots
 * are pinned, so an operator can size `worktreeSlots` from the line alone. Best-effort: an
 * unwritable feed must not fail the lease it describes. */
function logSlotWait(root: string, role: string, purpose: SlotPurpose, waitedMs: number): void {
  if (waitedMs < SLOT_WAIT_EVENT_MS) return;
  const slots = readSlotsState(root).slots;
  logEventBestEffort(root, {
    source: role,
    type: "slot_wait",
    role,
    purpose,
    waitedMs,
    slots: slots.length,
    pinned: slots.filter((slot) => slot.pinnedFor !== null).length,
  });
}

function tryClaim(
  root: string,
  role: string,
  purpose: SlotPurpose,
  count: number,
): string | null {
  let chosen: string | null = null;
  const key = rootKey(root);
  const unsaved = unsavedReleases.get(key);
  updateSlotsState(root, (state) => {
    for (const slot of state.slots) {
      if (unsaved?.has(slot.dir) && slot.lease?.pid === process.pid) slot.lease = null;
    }
    chosen = chooseSlot(root, state, role, purpose, count, Date.now(), process.pid);
  });
  // The write landed, so the reclaim of every unsaved release is on disk.
  unsavedReleases.delete(key);
  return chosen;
}

async function acquire(
  root: string,
  role: string,
  purpose: SlotPurpose,
  signal?: AbortSignal,
  slotBudget?: number,
): Promise<string> {
  // The caller's live budget when given; else liveCount's tolerance — a broken or missing
  // tumwater.json degrades to the default budget rather than erroring the lease with a raw
  // load failure (2026-10-08: a mid-run broken config errored every run via this read even
  // while the orchestrator held last-known-good).
  const count = slotBudget ?? liveCount(root);
  const startedAt = Date.now();
  for (;;) {
    if (signal?.aborted) throw abortError();
    const chosen = tryClaim(root, role, purpose, count);
    if (chosen !== null) {
      logSlotWait(root, role, purpose, Date.now() - startedAt);
      return chosen;
    }
    // The pool-slot wait rule (plans/provider-concurrency.md §5 "No deadlock"): a lease never holds
    // a provider key while it waits for a pool slot. Drop the calling lease's key (which never
    // waits) before parking here, so this run or verify holds no provider slot whose in-use a
    // re-key waiter is waiting to drain; the next run re-takes the key as an ordinary re-key.
    await dropProviderLeaseKey();
    const waiter = registerWaiter(root);
    try {
      await raceAbort(waiter.promise, signal);
    } catch (err) {
      dropWaiter(root, waiter.resolve);
      throw err;
    }
  }
}

/** The pool's live state for observers (status, TUI, dashboard): slots leased by this process out
 * of the configured budget, and the leases waiting for one. A lease held by another pid is dead
 * (see `SlotLease`), so it is not counted. `wakeWaiters` empties the waiter set before woken
 * waiters re-register, so `waiting` can read low for one turn; observers poll, so the next poll
 * corrects it. */
export function slotPoolSnapshot(root: string): { leased: number; limit: number; waiting: number } {
  const leased = readSlotsState(root).slots.filter((s) => s.lease !== null && s.lease.pid === process.pid).length;
  return { leased, limit: liveCount(root), waiting: waiters.get(rootKey(root))?.size ?? 0 };
}

/** The live slot budget, or an unbounded one when the config is unreadable: an invalid config
 * must not stop a held slot from being freed. */
function liveCount(root: string): number {
  try {
    return slotCount(loadConfig(root));
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/** A slot dir is canonical when it is exactly a `_slot-<n>` checkout under the worktrees dir.
 * A migrated legacy `<role>` dir is not, which marks it for retirement once its resume finishes
 * (retireLegacyRoleWorktrees and releaseSlot). */
function isCanonicalSlotDir(dir: string): boolean {
  return /^_slot-\d+$/.test(path.basename(dir));
}

/** Slot dirs per root whose release write to slots.json failed in this process; the next claim
 * clears their stale lease. */
const unsavedReleases = new Map<string, Set<string>>();

/** `releaseSlot` that never throws: a failed slots.json write (ENOSPC, EACCES, a lock timeout)
 * warns and remembers the slot so the next `tryClaim` here reclaims it, instead of masking the
 * caller's own outcome and leaving the slot leased by this live pid. The pin and `lastRole` the
 * failed release would have recorded are not replayed; a lost pin only means the next resume
 * gets a fresh checkout. */
function freeSlot(
  root: string,
  dir: string,
  role: string,
  count: number,
  pin: boolean,
  unsettledRun: string | null = null,
): string[] {
  try {
    return releaseSlot(root, dir, role, count, pin, unsettledRun);
  } catch (err) {
    const key = rootKey(root);
    const dirs = unsavedReleases.get(key) ?? new Set<string>();
    dirs.add(dir);
    unsavedReleases.set(key, dirs);
    warnEventBestEffort(
      root,
      TUMWATER_SOURCE,
      `could not free slot ${path.basename(dir)}: ${errorMessage(err)}; the next lease reclaims it`,
    );
    return [];
  }
}

/** Free `dir` in slots.json, record `lastRole`/`lastReleasedAt`/`unsettledRun`, and return the
 * idle unpinned slot dirs to remove because the live slot budget shrank below them
 * (oldest-released first). `pin` keeps the slot pinned for `role`; otherwise a pin this role held
 * is cleared. A non-canonical (migrated legacy) slot is dropped the moment it is unpinned, so the
 * one resume it was kept for runs in it and the dir is removed on that first release. */
function releaseSlot(
  root: string,
  dir: string,
  role: string,
  count: number,
  pin: boolean,
  unsettledRun: string | null,
): string[] {
  const toRemove: string[] = [];
  updateSlotsState(root, (state) => {
    const slot = state.slots.find((s) => s.dir === dir);
    if (slot !== undefined) {
      slot.lease = null;
      slot.lastRole = role;
      slot.lastReleasedAt = Date.now();
      slot.unsettledRun = unsettledRun;
      if (pin) {
        if (slot.pinnedFor !== role) slot.pinnedAt = Date.now();
        slot.pinnedFor = role;
      } else if (slot.pinnedFor === role) {
        slot.pinnedFor = null;
        slot.pinnedAt = null;
      }
      if (!pin && slot.pinnedFor === null && !isCanonicalSlotDir(slot.dir)) {
        state.slots = state.slots.filter((s) => s !== slot);
        toRemove.push(slot.dir);
      }
    }
    for (;;) {
      const idle = state.slots.filter((s) => s.lease === null && s.pinnedFor === null);
      if (idle.length <= count) break;
      idle.sort((a, b) => (a.lastReleasedAt ?? -1) - (b.lastReleasedAt ?? -1));
      const victim = idle[0]!;
      state.slots = state.slots.filter((s) => s !== victim);
      toRemove.push(victim.dir);
    }
  });
  return toRemove;
}

/** Remove the idle slot directories a shrunken budget dropped, one at a time. Called from a
 * lease's synchronous `release` (the caller cannot await it), so a removal failure — a worktree
 * a leaked process still holds (EBUSY), a path that survives removeTree's retries — must not
 * escape as an unhandled rejection and kill the orchestrator: the slots are already
 * unregistered from slots.json, so a directory left behind is only a leak the next prune
 * collects. Each failure is logged so it stays visible, and the remaining removals still run.
 * The log itself must not throw: warnEventBestEffort keeps an unwritable events feed (ENOSPC,
 * EACCES, the path replaced) from rejecting this function and re-creating the very unhandled
 * rejection the catch exists to prevent. The remover is an injectable seam so tests can drive a
 * failing removal without a real filesystem failure. */
export async function removeDroppedSlots(
  root: string,
  dirs: readonly string[],
  remove: (root: string, dir: string) => Promise<void> = removeWorktreeDir,
): Promise<void> {
  for (const dir of dirs) {
    try {
      await remove(root, dir);
    } catch (err) {
      warnEventBestEffort(root, TUMWATER_SOURCE, `could not remove idle workspace ${dir}: ${errorMessage(err)}`);
    }
  }
}

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

/** Lease a pooled slot for `role`, prepared at `ref`. Resolves once a slot is held and reset to
 * `ref`, any uncommitted edits its last holder left saved first (salvageSlotLeftovers), as work
 * to hand back when that holder was a run that never settled them; rejects on a `signal` abort
 * while waiting. The returned `release` is idempotent. */
export async function leaseSlot(
  root: string,
  options: LeaseSlotOptions,
): Promise<SlotLeaseHandle> {
  const dir = await acquire(root, options.role, options.purpose, options.signal, options.slotBudget);
  return prepareLeased(root, dir, options);
}

/** Lease a pooled slot only when one is free right now: resolves null instead of waiting, so a
 * caller that can do without a second checkout (a verify's check slot) never queues behind
 * the pool. Otherwise as leaseSlot. */
export async function tryLeaseSlot(
  root: string,
  options: LeaseSlotOptions,
): Promise<SlotLeaseHandle | null> {
  const dir = tryClaim(root, options.role, options.purpose, options.slotBudget ?? liveCount(root));
  return dir === null ? null : prepareLeased(root, dir, options);
}

/** Prepare the slot `dir` this process just claimed at `options.ref` and hand back its handle. */
async function prepareLeased(
  root: string,
  dir: string,
  options: LeaseSlotOptions,
): Promise<SlotLeaseHandle> {
  const { role, purpose, ref, keep } = options;
  const record = slotForDir(root, dir);
  // A run that gave the slot up unsettled is the one its leftovers belong to, even when a
  // failed prepare has since recorded another role as the last holder.
  const unsettledRun = record?.unsettledRun ?? null;
  const preserved = keep === true && record?.pinnedFor === role;
  const useRelease = await beginWorktreeUse(root, dir);
  // The use registry is LRU bookkeeping; freeing the slot is the real work of a release, so a
  // failed registry write here (ENOSPC, a lock timeout) must not escape: the dead-lease reaper
  // only clears another process's lease, so the slot would stay leased by this live pid and the
  // pool would shrink by one every time. Warn so the failure stays visible, then free anyway.
  const releaseUse = (): void => {
    tryOrWarn(root, TUMWATER_SOURCE, `record use release for ${path.basename(dir)}`, useRelease);
  };
  if (!preserved) {
    try {
      // A run the harness could not clean up after may have left uncommitted edits here; save
      // them before the reset discards them, for that role's next run when it left them
      // unsettled (slot-salvage.ts).
      await salvageSlotLeftovers(root, dir, {
        leftBy: unsettledRun ?? record?.lastRole ?? null,
        recoverFor: unsettledRun,
        forRole: role,
      });
      await ensureDetachedWorktree(root, dir, ref);
    } catch (err) {
      releaseUse();
      // Free the claim without shrinking. releaseSlot retires a migrated legacy slot on this
      // unpinned release, so hand its removal to removeDroppedSlots; a canonical slot survives
      // for reuse on the next lease. This lease never used the slot, so an unsettled run's
      // claim on what is left there stands.
      const toRemove = freeSlot(root, dir, role, Number.MAX_SAFE_INTEGER, false, unsettledRun);
      wakeWaiters(root);
      void removeDroppedSlots(root, toRemove);
      throw err;
    }
  }
  let released = false;
  return {
    dir,
    preserved,
    release: (how) => {
      if (released) return;
      released = true;
      releaseUse();
      const unsettled = how?.unsettled === true && purpose === "run" ? role : null;
      const toRemove = freeSlot(root, dir, role, liveCount(root), how?.pin === true, unsettled);
      wakeWaiters(root);
      // Best-effort: a slot whose directory is already gone is unregistered by the prune.
      void removeDroppedSlots(root, toRemove);
    },
  };
}
