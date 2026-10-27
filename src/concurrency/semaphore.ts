/** In-process counting semaphore bounding concurrent work (the orchestrator uses it to
 * cap simultaneous pi runs). The cross-PROCESS mutex lives in lock.ts; this one only
 * coordinates within a single harness process. A run is admitted by the one team total
 * (`maxConcurrent`) alone — there is no per-provider cap any more (the cap, its surfaces
 * and its keyed machinery were subtracted in parts 5b/6 and 5i/6); a lease is a team
 * permit that can pause and resume so an idle wait (a failed review's in-place retry)
 * hands the slot back and re-takes it before the next attempt. */

/** The handle one acquired lease owns: a release that hands the team permit back, and a
 * pause/resume pair for an idle wait inside its work. */
export interface SemaphoreLease {
  /** Return the team permit, then hand it to a parked waiter. */
  release(): void;
  /** Hand the team permit back while the lease stays open, for an idle wait inside its work
   * (a failed review's in-place retry pause), so a parked waiter can use it. A no-op on a
   * released or already paused lease. */
  pause(): void;
  /** Take a paused lease's permit back, re-admitted at its own tier in queue order like any
   * admission waiter. A no-op unless paused. A release() while it waits cancels it and owes
   * nothing. */
  resume(): Promise<void>;
}

export class Semaphore {
  /** A parked WAITING (admission) waiter: its scheduling tier and the resolver that hands
   * it the permit. */
  private readonly waiters: Array<{ tier: number; resolve: () => void }> = [];
  /** Permits currently held, tracked separately from capacity (rather than as an "available"
   * count): setCapacity can shrink below the current in-use, and a free-permit count cannot
   * represent that state — it would over-admit new work after a shrink. */
  private inUse = 0;
  /** Permits withheld from tier ≥ 1 acquirers so a work role that has work to take can claim
   * one without waiting for a maintenance run to release (plans/parallel-work-instances.md
   * "Priority headroom", part 7/7). Tiers ≤ 0 (work, VERIFY_TIER, MERGE_TIER) ignore it. */
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
      this.enqueue({ tier, resolve });
    });
  }

  /** Admit by the team total alone and return a lease handle. `tier` orders the wait exactly
   * as acquire does. FIFO holds within a tier. */
  async acquireLease(tier: number): Promise<SemaphoreLease> {
    // True once release() has run: a released lease owns no slot and must not undo one again —
    // a second release must be a no-op, never a negative count. The orchestrator releases each
    // lease exactly once, but a cancelled parked resume relies on this guard so a cancelled
    // lease never re-decrements what it took.
    let closed = false;
    // True while pause() has handed the team permit back: release() then owes nothing, and
    // resume() re-admits at this lease's tier in queue order.
    let paused = false;
    // resume()'s admission waiter while it is queued. release() cancels it if drive has not
    // granted it yet, and gives the grant back if it has.
    let parkedResume: { tier: number; resolve: () => void } | null = null;
    const release = (): void => {
      if (closed) return;
      closed = true;
      if (parkedResume !== null) {
        const w = parkedResume;
        parkedResume = null;
        const idx = this.waiters.indexOf(w);
        if (idx >= 0) {
          // Still queued: it took nothing, so cancel it and owe nothing.
          this.waiters.splice(idx, 1);
          w.resolve();
          return;
        }
        // drive granted it this microtask: its permit is taken, so give it back.
        paused = false;
      }
      if (paused) return; // pause() already gave the permit back
      this.inUse -= 1;
      this.drive();
    };
    const pause = (): void => {
      if (closed || paused) return;
      paused = true;
      this.inUse -= 1;
      this.drive();
    };
    const resume = async (): Promise<void> => {
      if (closed || !paused || parkedResume !== null) return;
      if (this.canLeaseAtOnce(tier)) {
        this.inUse += 1;
        paused = false;
        return;
      }
      await new Promise<void>((resolve) => {
        const waiter = { tier, resolve };
        parkedResume = waiter;
        this.enqueue(waiter);
      });
      parkedResume = null;
      // drive granted it (the permit is taken), unless release() cancelled it.
      if (!closed) paused = false;
    };
    const lease: SemaphoreLease = { release, pause, resume };

    if (this.inUse < this.capacity - this.reserveFor(tier)) {
      this.inUse += 1;
      return lease;
    }
    await new Promise<void>((resolve) => {
      this.enqueue({ tier, resolve });
    });
    return lease;
  }

  /** Queue an admission waiter behind every waiter of its tier or a lower one, so it inserts
   * before strictly-greater tiers only (tier order, FIFO within a tier) — the one home of the
   * queue's ordering, shared by acquire, acquireLease and a paused lease's resume. */
  private enqueue(waiter: { tier: number; resolve: () => void }): void {
    let i = this.waiters.length;
    while (i > 0) {
      const prev = this.waiters[i - 1];
      if (!prev || prev.tier <= waiter.tier) break;
      i -= 1;
    }
    this.waiters.splice(i, 0, waiter);
  }

  /** Synchronously report whether acquireLease(tier) would return at once — the team total
   * has headroom right now and the tier's reserve is satisfied. Mirrors the exact fast-path
   * condition acquireLease's first branch uses, so a caller can decide whether to show a
   * "waiting for a slot" state before awaiting a lease that would actually park
   * (merge-drain.ts's resolver wrapper). */
  canLeaseAtOnce(tier: number): boolean {
    return this.inUse < this.capacity - this.reserveFor(tier);
  }

  /** Hand every parked waiter a permit it can take in one pass. The one home of the permit
   * hand-off: release, setCapacity, setReserve and a pause/resume all drive it, and growth
   * loops it to fill new headroom. It never admits past the team cap. Admission waiters are
   * scanned in queue (tier, then FIFO) order; the reserve stops the scan at the first tier ≥ 1
   * waiter it withholds from, since the tier-ascending queue means everything behind is
   * withheld too. */
  private drive(): void {
    for (;;) {
      let granted = false;
      for (let i = 0; i < this.waiters.length; i++) {
        const w = this.waiters[i]!;
        if (this.inUse >= this.capacity - this.reserveFor(w.tier)) break; // reserve/full stops the scan
        this.waiters.splice(i, 1);
        this.inUse += 1;
        w.resolve();
        granted = true;
        break;
      }
      if (!granted) break;
    }
  }

  /** The permits withheld from `tier`: `reserve` for tier ≥ 1 (maintenance), 0 for every tier
   * that ships work or merges a change (work, VERIFY_TIER, MERGE_TIER). */
  private reserveFor(tier: number): number {
    return tier >= 1 ? this.reserve : 0;
  }

  /** Release a held permit. The finishing work gives back its permit first, and a queued waiter
   * takes it over only if there is headroom (drive): after a shrink, inUse can sit at or above
   * the cap for a while (the in-flight work admitted before it), and no new grant may proceed
   * until releases bring in-use under the cap. In the normal case this is exactly the classic
   * hand-off — one release wakes one waiter, net in-use unchanged. */
  release(): void {
    this.inUse -= 1;
    this.drive();
  }

  /** Live-resize the cap (a mid-run tumwater.json edit). Growing admits queued waiters up to
   * the new headroom — one permit per woken waiter. Shrinking never preempts in-flight work:
   * it only caps future grants until releases bring in-use under the new cap. */
  setCapacity(n: number): void {
    this.capacity = n;
    this.drive();
  }

  /** Live-resize the permits withheld from tier ≥ 1 acquirers. Lowering it re-runs the hand-off
   * so a parked maintenance waiter can take a permit the reserve had held; raising it never
   * preempts an in-flight holder — it only withholds future grants. */
  setReserve(n: number): void {
    this.reserve = Math.max(0, n);
    this.drive();
  }

  /** The pool's live state for observability: the team in-use/cap and the reserve. `byKey`
   * stays an empty map until part 5j/6 removes the provider-key displays that read it. */
  snapshot(): {
    inUse: number;
    limit: number;
    reserve: number;
    byKey: Record<string, never>;
  } {
    return { inUse: this.inUse, limit: this.capacity, reserve: this.reserve, byKey: {} };
  }
}
