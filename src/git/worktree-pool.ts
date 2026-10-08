/** The worktree pool's lease machinery (plans/worktree-pool.md, "Leases"; part 2a/5): a fixed
 * set of `.tumwater/worktrees/_slot-<n>` checkouts that ticks and vets lease and switch commits
 * in place, instead of keeping one `_land-<role>` checkout per role. The persisted layout and
 * its cross-process lock live in slots-state.ts, which other processes (`tumwater diff`,
 * `retire`) also read; this module owns choosing a slot, holding it through the disk-floor
 * registry, and handing it back. Nothing leases a slot yet — part 4/5 wires the loops to it.
 *
 * The lease decision is synchronous: `updateSlotsState` writes slots.json under the slots lock,
 * and one Node process runs every tick and landing, so two concurrent `leaseSlot` calls claim
 * distinct free slots and a call with none free registers an in-process waiter. A release wakes
 * the waiters, which re-decide; `signal` aborts a waiter. */

import path from "node:path";
import { loadConfig, slotCount } from "../config/config.js";
import { slotWorktreePath } from "../paths.js";
import { updateSlotsState } from "./slots-state.js";
import { beginWorktreeUse } from "./worktree-use.js";
import { ensureDetachedWorktree, removeWorktreeDir } from "./worktree.js";

/** A live lease as callers see it: the slot directory and the one-shot release. */
export interface SlotLeaseHandle {
  dir: string;
  release: () => void;
}

interface LeaseSlotOptions {
  /** The loop the slot is held for; drives affinity and the persisted lease record. */
  role: string;
  purpose: "tick" | "vet";
  /** The commit the slot is prepared at (a sha or branch name; ensureDetachedWorktree resets it). */
  ref: string;
  /** Aborts a lease that is still waiting for a free slot. */
  signal?: AbortSignal;
}

/** The parts of a slot record this module reads and writes — structurally slots-state.ts's
 * SlotRecord. Redeclared rather than imported so the persisted shape stays owned by the state
 * module and this one depends only on the fields it uses. */
interface PoolSlot {
  dir: string;
  lease: { role: string; purpose: "tick" | "vet"; since: number; pid: number } | null;
  pinnedFor: string | null;
  lastRole: string | null;
  lastReleasedAt: number | null;
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
  const err = new Error("slot lease aborted before a slot was free");
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
 * Pins are kept, and the freed slots become candidates for the current claim. */
function clearDeadLeases(state: PoolState, pid: number): void {
  for (const slot of state.slots) {
    if (slot.lease !== null && slot.lease.pid !== pid) slot.lease = null;
  }
}

function claim(slot: PoolSlot, role: string, purpose: "tick" | "vet", now: number, pid: number): string {
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
  purpose: "tick" | "vet",
  count: number,
  now: number,
  pid: number,
): string | null {
  clearDeadLeases(state, pid);
  const free = state.slots.filter((slot) => slot.lease === null);
  const eligible = free.filter((slot) => slot.pinnedFor === null || slot.pinnedFor === role);
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
      lastRole: null,
      lastReleasedAt: null,
    });
    return dir;
  }
  return null;
}

function tryClaim(
  root: string,
  role: string,
  purpose: "tick" | "vet",
  count: number,
): string | null {
  let chosen: string | null = null;
  updateSlotsState(root, (state) => {
    chosen = chooseSlot(root, state, role, purpose, count, Date.now(), process.pid);
  });
  return chosen;
}

async function acquire(
  root: string,
  role: string,
  purpose: "tick" | "vet",
  signal?: AbortSignal,
): Promise<string> {
  const count = slotCount(loadConfig(root));
  for (;;) {
    if (signal?.aborted) throw abortError();
    const chosen = tryClaim(root, role, purpose, count);
    if (chosen !== null) return chosen;
    const waiter = registerWaiter(root);
    try {
      await raceAbort(waiter.promise, signal);
    } catch (err) {
      dropWaiter(root, waiter.resolve);
      throw err;
    }
  }
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

/** Free `dir` in slots.json, record `lastRole`/`lastReleasedAt`, and return the idle unpinned
 * slot dirs to remove because the live slot budget shrank below them (oldest-released first). */
function releaseSlot(root: string, dir: string, role: string, count: number): string[] {
  const toRemove: string[] = [];
  updateSlotsState(root, (state) => {
    const slot = state.slots.find((s) => s.dir === dir);
    if (slot !== undefined) {
      slot.lease = null;
      slot.lastRole = role;
      slot.lastReleasedAt = Date.now();
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

/** Lease a pooled slot for `role`, prepared at `ref`. Resolves once a slot is held and reset to
 * `ref`; rejects on a `signal` abort while waiting. The returned `release` is idempotent. */
export async function leaseSlot(
  root: string,
  options: LeaseSlotOptions,
): Promise<SlotLeaseHandle> {
  const { role, purpose, ref, signal } = options;
  const dir = await acquire(root, role, purpose, signal);
  const useRelease = await beginWorktreeUse(root, dir);
  try {
    await ensureDetachedWorktree(root, dir, ref);
  } catch (err) {
    useRelease();
    // Free the claim without shrinking: the slot may be reused on the next lease.
    releaseSlot(root, dir, role, Number.MAX_SAFE_INTEGER);
    wakeWaiters(root);
    throw err;
  }
  let released = false;
  return {
    dir,
    release: () => {
      if (released) return;
      released = true;
      useRelease();
      const toRemove = releaseSlot(root, dir, role, liveCount(root));
      wakeWaiters(root);
      // Best-effort: a slot whose directory is already gone is unregistered by the prune.
      for (const stale of toRemove) void removeWorktreeDir(root, stale);
    },
  };
}
