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

  constructor(private capacity: number) {}

  /** Acquire a permit, parking in the wait queue when none is free. `tier` orders WAITING
   * requests only: on arrival a waiter inserts ahead of every parked waiter with a strictly
   * greater tier (the orchestrator passes roleTier so work roles beat maintenance across
   * polls), keeping stable FIFO within a tier. In-flight holders are never preempted — they
   * run to completion and their release is what hands out the permit. */
  async acquire(tier: number): Promise<void> {
    if (this.inUse < this.capacity) {
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

  release(): void {
    // The finishing work gives back its permit first. A queued waiter takes it over only if
    // there is headroom: after a shrink, inUse can sit at or above the cap for a while (the
    // in-flight work admitted before it), and no new grant may proceed until releases bring
    // in-use under the cap. In the normal case this is exactly the classic hand-off — one
    // release wakes one waiter, net in-use unchanged.
    this.inUse -= 1;
    if (this.inUse < this.capacity) {
      const next = this.waiters.shift();
      if (next) {
        this.inUse += 1;
        next.resolve();
      }
    }
  }

  /** Live-resize the cap (a mid-run tumwater.json edit). Growing admits queued waiters up to
   * the new headroom — one permit per woken waiter. Shrinking never preempts in-flight work:
   * it only caps future grants until releases bring in-use under the new cap. */
  setCapacity(n: number): void {
    this.capacity = n;
    while (this.inUse < this.capacity) {
      const next = this.waiters.shift();
      if (!next) break;
      this.inUse += 1;
      next.resolve();
    }
  }
}
