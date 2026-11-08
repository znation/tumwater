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

/** A parked WAITING (admission) waiter: its scheduling tier, the clock tick it parked at
 * (`since`, recorded the moment it enqueues), and the resolver that hands it the permit.
 * `since` feeds the age bound that promotes a tier ≥ 1 waiter once it has been passed over
 * past a clock deadline (see Semaphore.effectiveTier) — the fix for BUGS.md 2026-11-08's
 * tier-1 role starvation, so a maintenance role cannot be passed over by work runs for a
 * day. */
interface Waiter {
  tier: number;
  /** Clock tick when the waiter parked; stamped by enqueue at the moment it inserts. Optional
   * in the type so an acquirer's `{ tier, resolve }` literal is assignable; effectiveTier reads
   * it as "never aged" when absent. */
  since?: number;
  resolve: () => void;
}

/** How long the age bound lets a tier ≥ 1 waiter be passed over before a fresh tier-0
 * (work) arrival stops jumping ahead of it (BUGS.md 2026-11-05/08: tier-1 starvation). */
const DEFAULT_STARVE_MS = 2 * 60 * 60 * 1000; // two hours

export class Semaphore {
  /** A parked WAITING (admission) waiter: its scheduling tier, the clock tick at which it
   * parked, and the resolver that hands it the permit. */
  private readonly waiters: Array<Waiter> = [];
  /** The clock for the age bound — injectable so a test can age a waiter without a two-hour
   * real wait. Defaults to Date.now. */
  private readonly now: () => number;
  /** The age bound: a tier ≥ 1 waiter parked this long is promoted to tier 0 (effectiveTier)
   * so new tier-0 arrivals stop passing it over and it bypasses the work reserve. */
  private readonly starveMs: number;
  /** Permits currently held, tracked separately from capacity (rather than as an "available"
   * count): setCapacity can shrink below the current in-use, and a free-permit count cannot
   * represent that state — it would over-admit new work after a shrink. */
  private inUse = 0;
  /** Permits withheld from tier ≥ 1 acquirers so a work role that has work to take can claim
   * one without waiting for a maintenance run to release (plans/parallel-work-instances.md
   * "Priority headroom", part 7/7). Tiers ≤ 0 (work, VERIFY_TIER, MERGE_TIER) ignore it. */
  private reserve = 0;

  constructor(
    private capacity: number,
    options: { now?: () => number; starveMs?: number } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.starveMs = options.starveMs ?? DEFAULT_STARVE_MS;
  }

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
   * polls), keeping stable FIFO within a tier. A tier ≥ 1 waiter that has been passed over
   * past the starve bound counts as tier 0 (effectiveTier), so it is promoted ahead of new
   * tier-0 arrivals instead of starving behind them. In-flight holders are never preempted —
   * they run to completion and their release is what hands out the permit. */
  async acquire(tier: number): Promise<void> {
    this.grantAheadOf(tier);
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
      this.grantAheadOf(tier);
      if (this.inUse < this.capacity - this.reserveFor(tier)) {
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

    this.grantAheadOf(tier);
    if (this.inUse < this.capacity - this.reserveFor(tier)) {
      this.inUse += 1;
      return lease;
    }
    await new Promise<void>((resolve) => {
      this.enqueue({ tier, resolve });
    });
    return lease;
  }

  /** The scheduling tier a parked waiter actually waits at once its age is considered: a
   * tier ≥ 1 waiter that has been passed over past the starve bound is treated as tier 0, so
   * it is promoted ahead of new tier-0 (work) arrivals and bypasses the work reserve — the
   * age bound that keeps a maintenance role from starving behind a stream of work runs. A
   * waiter younger than the bound (or below tier 1) keeps its own tier, so the tier ordering
   * is unchanged for everyone but the aged. Re-evaluated on every enqueue and reserve/drive
   * decision, which is exactly when a fresh low-tier arrival would otherwise jump it. */
  private effectiveTier(waiter: Waiter): number {
    const age = this.now() - (waiter.since ?? this.now());
    if (waiter.tier >= 1 && age >= this.starveMs) return 0;
    return waiter.tier;
  }

  /** Queue an admission waiter behind every waiter whose effective (age-aware) tier is not
   * strictly greater, so it inserts before strictly-greater effective tiers only (tier order,
   * FIFO within an effective tier) — the one home of the queue's ordering, shared by acquire,
   * acquireLease and a paused lease's resume. `since` is stamped here, at the moment the
   * waiter parks. */
  private enqueue(waiter: Waiter): void {
    waiter.since = this.now(); // stamp the park time before any effectiveTier reads it
    let i = this.waiters.length;
    while (i > 0) {
      const prev = this.waiters[i - 1];
      if (!prev || this.effectiveTier(prev) <= this.effectiveTier(waiter)) break;
      i -= 1;
    }
    this.waiters.splice(i, 0, waiter);
  }

  /** Synchronously report whether acquireLease(tier) would return at once — no parked waiter
   * ahead of it would take the remaining permits first, and the team total still has headroom
   * for the tier after its reserve. Mirrors acquireLease's grant-ahead and fast-path steps, so
   * a caller can decide whether to show a "waiting for a slot" state before awaiting a lease
   * that would actually park (merge-drain.ts's resolver wrapper). */
  canLeaseAtOnce(tier: number): boolean {
    // A fast-path admission still queues behind every parked waiter whose effective tier is
    // not greater than its own, so account for the permits those waiters would take first.
    let inUse = this.inUse;
    for (const w of this.waiters) {
      const effective = this.effectiveTier(w);
      if (effective > tier) break;
      if (inUse >= this.capacity - this.reserveFor(effective)) return false;
      inUse += 1;
    }
    return inUse < this.capacity - this.reserveFor(tier);
  }

  /** Hand every parked waiter a permit it can take in one pass. The one home of the permit
   * hand-off: release, setCapacity, setReserve and a pause/resume all drive it, and growth
   * loops it to fill new headroom. It never admits past the team cap. Admission waiters are
   * scanned in queue (effective tier, then FIFO) order; the reserve stops the scan at the
   * first waiter it withholds from, since the tier-ascending queue means everything behind is
   * withheld too. An aged tier ≥ 1 waiter counts as tier 0 (effectiveTier), so it bypasses
   * the reserve and is granted like a work waiter. */
  private drive(): void {
    this.grantAheadOf(Number.POSITIVE_INFINITY);
  }

  /** Hand permits to the parked waiters a fresh `tier` arrival would queue behind (effective
   * tier at or below its own), so an immediate admission cannot barge an aged waiter that is
   * already due a permit. Stops at the first waiter the cap or reserve withholds from: the
   * arriving tier is withheld there too, because reserveFor is monotone in tier. */
  private grantAheadOf(tier: number): void {
    for (;;) {
      const waiter = this.waiters[0];
      if (waiter === undefined) return;
      const effective = this.effectiveTier(waiter);
      if (effective > tier) return;
      if (this.inUse >= this.capacity - this.reserveFor(effective)) return;
      this.waiters.shift();
      this.inUse += 1;
      waiter.resolve();
    }
  }

  /** The permits withheld from `tier`: `reserve` for tier ≥ 1 (maintenance), 0 for every tier
   * that ships work or merges a change (work, VERIFY_TIER, MERGE_TIER) — and 0 for an aged
   * tier ≥ 1 waiter whose effective tier is 0, so the age bound also lifts the reserve. */
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

  /** The pool's live state for observability: the team in-use/cap and the reserve, plus the
   * wait in progress — each parked waiter's scheduling tier and how long it has waited
   * (BUGS.md 2026-11-08). The orchestrator publishes it as `permits`, so the doctor's
   * provider-contention view can surface a live tier-1 starve before the wait ends and emits
   * its `provider_wait` event. */
  snapshot(): {
    inUse: number;
    limit: number;
    reserve: number;
    waiting: Array<{ tier: number; waitingMs: number }>;
  } {
    const now = this.now();
    return {
      inUse: this.inUse,
      limit: this.capacity,
      reserve: this.reserve,
      waiting: this.waiters.map((w) => ({
        tier: this.effectiveTier(w),
        waitingMs: now - (w.since ?? now),
      })),
    };
  }
}
