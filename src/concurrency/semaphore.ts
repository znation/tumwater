/** In-process counting semaphore bounding concurrent work (the orchestrator uses it to
 * cap simultaneous pi runs). The cross-PROCESS mutex lives in lock.ts; this one only
 * coordinates within a single harness process. */

export class Semaphore {
  /** A parked waiter: its scheduling tier plus the resolver that hands it the permit. */
  private waiters: Array<{ tier: number; resolve: () => void }> = [];
  /** Permits currently held, tracked separately from capacity (rather than as an "available"
   * count): setCapacity can shrink below the current in-use, and a free-permit count cannot
   * represent that state — it would over-admit new work after a shrink. */
  private inUse = 0;
  /** Permits withheld from tier ≥ 1 acquirers so a work loop that has work to take can claim
   * one without waiting for a maintenance tick to release (plans/parallel-work-instances.md
   * "Priority headroom", part 7/7). Tiers ≤ 0 (work, LANDING_TIER, MERGE_TIER) ignore it. */
  private reserve = 0;

  constructor(private capacity: number) {}

  /** The current cap — the live `maxConcurrent`, for callers that size work against it. */
  get limit(): number {
    return this.capacity;
  }

  /** How many acquirers are parked for a permit right now. */
  get waiting(): number {
    return this.waiters.length;
  }

  /** Take a free permit without parking: true when one was granted (the same fast path
   * acquire takes), false when acquire would have to wait. */
  tryAcquire(): boolean {
    if (this.inUse >= this.capacity) return false;
    this.inUse += 1;
    return true;
  }

  /** Acquire a permit, parking in the wait queue when none is free. `tier` orders WAITING
   * requests only: on arrival a waiter inserts ahead of every parked waiter with a strictly
   * greater tier (the orchestrator passes roleTier so work roles beat maintenance across
   * polls), keeping stable FIFO within a tier. In-flight holders are never preempted — they
   * run to completion and their release is what hands out the permit. */
  async acquire(tier: number): Promise<void> {
    if (this.inUse < this.capacity - this.reserveFor(tier)) {
      this.inUse += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      const waiter = { tier, resolve };
      let i = this.waiters.length;
      while (i > 0) {
        const prev = this.waiters[i - 1];
        if (!prev || prev.tier <= tier) break; // insert before strictly-greater tiers only
        i -= 1;
      }
      this.waiters.splice(i, 0, waiter);
    });
  }

  /** Hand the next parked waiter a permit when in-use is under the cap, returning whether one
   * was woken. The one home of the permit hand-off: release() calls it once, setCapacity()
   * loops it to fill new headroom. It never admits past the cap, so a shrink wakes nothing
   * until releases drain in-use under it. */
  private grantNextWaiter(): boolean {
    // Peek before admitting: a tier ≥ 1 waiter at the head is the highest-priority one (the
    // queue is tier-ascending), so when the reserve withholds a permit from it, it withholds
    // one from every waiter behind it too.
    const next = this.waiters[0];
    if (!next) return false;
    if (this.inUse >= this.capacity - this.reserveFor(next.tier)) return false;
    this.waiters.shift();
    this.inUse += 1;
    next.resolve();
    return true;
  }

  /** The permits withheld from `tier`: `reserve` for tier ≥ 1 (maintenance), 0 for every tier
   * that ships work or lands a change (work, LANDING_TIER, MERGE_TIER). */
  private reserveFor(tier: number): number {
    return tier >= 1 ? this.reserve : 0;
  }

  /** Release a held permit. The finishing work gives back its permit first, and a queued waiter
   * takes it over only if there is headroom (grantNextWaiter): after a shrink, inUse can sit at
   * or above the cap for a while (the in-flight work admitted before it), and no new grant may
   * proceed until releases bring in-use under the cap. In the normal case this is exactly the
   * classic hand-off — one release wakes one waiter, net in-use unchanged. */
  release(): void {
    this.inUse -= 1;
    this.grantNextWaiter();
  }

  /** Live-resize the cap (a mid-run tumwater.json edit). Growing admits queued waiters up to
   * the new headroom — one permit per woken waiter. Shrinking never preempts in-flight work:
   * it only caps future grants until releases bring in-use under the new cap. */
  setCapacity(n: number): void {
    this.capacity = n;
    while (this.grantNextWaiter()) {
      // One permit per woken waiter, up to the new headroom.
    }
  }

  /** Live-resize the permits withheld from tier ≥ 1 acquirers. Lowering it re-runs the hand-off
   * so a parked maintenance waiter can take a permit the reserve had held; raising it never
   * preempts an in-flight holder — it only withholds future grants. */
  setReserve(n: number): void {
    this.reserve = Math.max(0, n);
    while (this.grantNextWaiter()) {
      // One permit per woken waiter, up to the headroom the new reserve leaves.
    }
  }
}
