/** In-process counting semaphore bounding concurrent work (the orchestrator uses it to
 * cap simultaneous pi runs). The cross-PROCESS mutex lives in lock.ts; this one only
 * coordinates within a single harness process. */

export class Semaphore {
  private waiters: Array<() => void> = [];
  /** Permits currently held, tracked separately from capacity (rather than as an "available"
   * count): setCapacity can shrink below the current in-use, and a free-permit count cannot
   * represent that state — it would over-admit new work after a shrink. */
  private inUse = 0;

  constructor(private capacity: number) {}

  async acquire(): Promise<void> {
    if (this.inUse < this.capacity) {
      this.inUse += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
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
        next();
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
      next();
    }
  }
}
