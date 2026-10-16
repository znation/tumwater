/** In-process counting semaphore bounding concurrent work (the orchestrator uses it to
 * cap simultaneous pi runs). The cross-PROCESS mutex lives in lock.ts; this one only
 * coordinates within a single harness process.
 *
 * Since 2026-10-15 it also bounds a model provider (a "key") independently, so a full
 * provider never blocks a waiter on another (plans/provider-concurrency.md §3). The keyless
 * entry points — acquire/tryAcquire/release — are unchanged; only acquireLease, forceLease
 * and setKeyCaps touch the keyed path. */

/** The handle one keyed acquisition owns: the key it currently holds, a release that hands the
 * fleet permit and the key's slot back, and a rekey that moves the lease onto another key. */
export interface SemaphoreLease {
  /** The key the lease currently holds (undefined for an uncapped holder). */
  key?: string;
  /** Return the fleet permit and the key's in-use slot, then hand either to a parked waiter. */
  release(): void;
  /** Move the lease onto `to`: give the old key back first (waking its waiters), then wait
   * only for the new key's headroom while keeping the fleet permit. A parked re-key queues
   * ahead of every admission waiter, because it holds a fleet permit nobody else can use while
   * it waits. A forced lease re-keys without waiting. */
  rekey(to?: string): Promise<void>;
}

export class Semaphore {
  /** A parked WAITING (admission) waiter: its scheduling tier, optional provider key, and the
   * resolver that hands it the permit. Keyless waiters (the legacy path) carry no key and are
   * never held by a key cap. */
  private readonly waiters: Array<{ tier: number; key?: string; resolve: () => void }> = [];
  /** A parked re-key waiter: it already holds a fleet permit, so it waits only for its key's
   * headroom, ahead of every admission waiter (which would otherwise queue a fleet permit
   * uselessly behind another provider's runs). `granted` flips when drive() hands the waiter
   * the target key's slot, so the lease's release can tell a landed grant (give it back) from
   * a still-parked one (cancel it) when the two interleave. */
  private readonly rekeyWaiters: Array<{ key: string; resolve: () => void; granted: boolean }> = [];
  /** Permits currently held, tracked separately from capacity (rather than as an "available"
   * count): setCapacity can shrink below the current in-use, and a free-permit count cannot
   * represent that state — it would over-admit new work after a shrink. */
  private inUse = 0;
  /** The per-key permits currently held: a lease or forced lease charges its key here, and a
   * key at its cap withholds further grants on it. Grows and shrinks only through release and
   * rekey — never preempted. */
  private readonly keyInUse = new Map<string, number>();
  /** The live per-key caps, from `maxConcurrentPerProvider` (plans/provider-concurrency.md
   * §1). An absent key is uncapped — bounded by `capacity` alone. */
  private keyCaps = new Map<string, number>();
  /** Permits withheld from tier ≥ 1 acquirers so a work loop that has work to take can claim
   * one without waiting for a maintenance tick to release (plans/parallel-work-instances.md
   * "Priority headroom", part 7/7). Tiers ≤ 0 (work, LANDING_TIER, MERGE_TIER) ignore it. */
  private reserve = 0;

  constructor(private capacity: number) {}

  /** The current cap — the live `maxConcurrent`, for callers that size work against it. */
  get limit(): number {
    return this.capacity;
  }

  /** How many acquirers are parked for a permit right now, admission and re-key waiters both.
   * With no keys there are never re-key waiters, so this is exactly today's count. */
  get waiting(): number {
    return this.waiters.length + this.rekeyWaiters.length;
  }

  /** Take a free permit without parking: true when one was granted (the same fast path
   * acquire takes), false when acquire would have to wait. Unkeyed, as before. */
  tryAcquire(): boolean {
    if (this.inUse >= this.capacity) return false;
    this.inUse += 1;
    return true;
  }

  /** Acquire a permit, parking in the wait queue when none is free. `tier` orders WAITING
   * requests only: on arrival a waiter inserts ahead of every parked waiter with a strictly
   * greater tier (the orchestrator passes roleTier so work roles beat maintenance across
   * polls), keeping stable FIFO within a tier. In-flight holders are never preempted — they
   * run to completion and their release is what hands out the permit. Unkeyed, as before. */
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

  /** Admit by both the fleet total and an optional provider key at once, waiting until both
   * hold, and return a lease handle. `tier` orders the wait exactly as acquire does; `key`
   * bounds the permit by its provider cap: granted when `inUse < capacity − reserveFor(tier)`
   * and the key is under its cap (an absent or uncapped key always passes). FIFO holds within
   * a key, and a full key never delays a waiter on another. */
  async acquireLease(tier: number, key?: string): Promise<SemaphoreLease> {
    let currentKey = key;
    // True once release() has run: a released lease owns no slot and must not undo one again —
    // a second release (or a parked rekey's late grant) must be a no-op, never a negative
    // count. The orchestrator releases each lease exactly once, but the rekey cancel path
    // relies on this guard so a cancelled lease never re-decrements its target key.
    let closed = false;
    // The lease's parked re-key, while it waits on a full target key. At that point the lease
    // holds NO key slot (the old one was returned at the rekey's start), so release() must
    // CANCEL the pending grant rather than undo a slot this lease never took. Null when no
    // rekey is parked.
    let parkedRekey: { key: string; resolve: () => void; granted: boolean } | null = null;
    const release = (): void => {
      if (closed) return;
      closed = true;
      if (parkedRekey !== null) {
        // A re-key is parked waiting on its new key. Cancel it: pull it off the queue (so
        // drive can't grant it) and, if the grant already landed this microtask, give the
        // new key's slot back. The lease holds no slot either way, so the fleet permit is the
        // only thing to free.
        const w = parkedRekey;
        const idx = this.rekeyWaiters.indexOf(w);
        if (idx >= 0) this.rekeyWaiters.splice(idx, 1);
        if (w.granted) {
          this.bumpKeyInUse(w.key, -1);
        }
        w.resolve();
        parkedRekey = null;
      } else if (currentKey !== undefined) {
        this.bumpKeyInUse(currentKey, -1);
      }
      this.inUse -= 1;
      this.drive();
    };
    const rekey = async (to?: string): Promise<void> => {
      if (to === currentKey || closed) return;
      // Give the old key back first, waking that key's waiters.
      if (currentKey !== undefined) {
        this.bumpKeyInUse(currentKey, -1);
      }
      currentKey = to;
      lease.key = to;
      this.drive();
      if (to !== undefined && this.keyAtCap(to)) {
        // The new key is full: wait only for its headroom, ahead of every admission waiter.
        const w = { key: to, resolve: (): void => {}, granted: false };
        parkedRekey = w;
        this.rekeyWaiters.push(w);
        await new Promise<void>((resolve) => {
          w.resolve = resolve;
        });
        parkedRekey = null;
        if (w.granted) this.drive();
        return;
      }
      if (to !== undefined) this.bumpKeyInUse(to, 1);
      this.drive();
    };
    const lease: SemaphoreLease = { key: currentKey, release, rekey };

    if (this.inUse < this.capacity - this.reserveFor(tier) && (key === undefined || !this.keyAtCap(key))) {
      this.inUse += 1;
      if (key !== undefined) this.bumpKeyInUse(key, 1);
      return lease;
    }
    await new Promise<void>((resolve) => {
      const waiter = { tier, key, resolve };
      let i = this.waiters.length;
      while (i > 0) {
        const prev = this.waiters[i - 1];
        if (!prev || prev.tier <= tier) break;
        i -= 1;
      }
      this.waiters.splice(i, 0, waiter);
    });
    return lease;
  }

  /** Synchronously report whether acquireLease(tier, key) would return at once — both the
   * fleet total and the key (when set) have headroom right now, and the tier's reserve is
   * satisfied. Mirrors the exact fast-path condition acquireLease's first branch uses, so a
   * caller can decide whether to show a "waiting for a slot" state before awaiting a lease
   * that would actually park (landing-drain.ts's resolver wrapper). */
  canLeaseAtOnce(tier: number, key?: string): boolean {
    return this.inUse < this.capacity - this.reserveFor(tier) && (key === undefined || !this.keyAtCap(key));
  }

  /** The director's bypass: take a key's slot at once, never waiting, and never counting toward
   * the fleet cap. It DOES count toward the key's in-use, so a forced lease can overshoot a
   * full key by one holder; no grant on that key happens until a release drains it back under
   * the cap. Its re-key also never waits. */
  forceLease(key?: string): SemaphoreLease {
    let currentKey = key;
    if (currentKey !== undefined) {
      this.bumpKeyInUse(currentKey, 1);
    }
    const release = (): void => {
      if (currentKey !== undefined) {
        this.bumpKeyInUse(currentKey, -1);
      }
      this.drive();
    };
    const rekey = async (to?: string): Promise<void> => {
      if (to === currentKey) return;
      if (currentKey !== undefined) {
        this.bumpKeyInUse(currentKey, -1);
      }
      currentKey = to;
      lease.key = to;
      if (to !== undefined) this.bumpKeyInUse(to, 1);
      this.drive();
    };
    const lease: SemaphoreLease = { key: currentKey, release, rekey };
    return lease;
  }

  /** Hand every parked waiter a permit it can take — both fleet and key headroom — in one
   * pass. The one home of the permit hand-off: release, setCapacity, setReserve and setKeyCaps
   * all drive it, and growth loops it to fill new headroom. It never admits past the fleet cap
   * or a key cap. Re-key waiters run first (they already hold a fleet permit, so they wait only
   * on their key). Admission waiters are scanned in queue (tier, then FIFO) order: a waiter
   * whose key is full is skipped and keeps its place, so a later waiter on a free key is never
   * stuck behind it — but the reserve stops the scan at the first tier ≥ 1 waiter it withholds
   * from, since the tier-ascending queue means everything behind is withheld too. */
  private drive(): void {
    for (;;) {
      // Re-key waiters first: no fleet check — they already hold a fleet permit.
      let granted = false;
      for (let i = 0; i < this.rekeyWaiters.length; i++) {
        const w = this.rekeyWaiters[i]!;
        if (this.keyAtCap(w.key)) continue;
        w.granted = true;
        this.rekeyWaiters.splice(i, 1);
        this.bumpKeyInUse(w.key, 1);
        w.resolve();
        granted = true;
        break;
      }
      if (granted) continue;
      for (let i = 0; i < this.waiters.length; i++) {
        const w = this.waiters[i]!;
        if (this.inUse >= this.capacity - this.reserveFor(w.tier)) break; // reserve/full stops the scan
        if (w.key !== undefined && this.keyAtCap(w.key)) continue; // skip a full key, keep its place
        this.waiters.splice(i, 1);
        this.inUse += 1;
        if (w.key !== undefined) this.bumpKeyInUse(w.key, 1);
        w.resolve();
        granted = true;
        break;
      }
      if (!granted) break;
    }
  }

  /** The permits withheld from `tier`: `reserve` for tier ≥ 1 (maintenance), 0 for every tier
   * that ships work or lands a change (work, LANDING_TIER, MERGE_TIER). */
  private reserveFor(tier: number): number {
    return tier >= 1 ? this.reserve : 0;
  }

  /** True when `key` is at its cap — a configured cap the in-use already meets or exceeds. An
   * uncapped key (no cap set) is never "full". */
  private keyAtCap(key: string): boolean {
    const cap = this.keyCaps.get(key);
    return cap !== undefined && (this.keyInUse.get(key) ?? 0) >= cap;
  }

  /** Add `delta` to `key`'s held permits, initializing an absent key at zero first — the
   * single home of the get-or-init bump that release, rekey, force and drive all repeated
   * (an absent key implicitly holds zero, so the first bump must not read `undefined`). */
  private bumpKeyInUse(key: string, delta: number): void {
    this.keyInUse.set(key, (this.keyInUse.get(key) ?? 0) + delta);
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

  /** Live-resize the per-key caps (a mid-run `maxConcurrentPerProvider` edit). Growing admits
   * parked waiters for that key up to the new headroom; shrinking never preempts an in-flight
   * holder — it only withholds future grants on that key until releases drain it under the new
   * cap, the same contract as setCapacity. Non-positive and non-integer entries are dropped. */
  setKeyCaps(caps: Record<string, number>): void {
    this.keyCaps = new Map(Object.entries(caps).filter(([, v]) => Number.isInteger(v) && v > 0));
    this.drive();
  }

  /** The pool's live state for observability (plans/provider-concurrency.md §8): the fleet
   * in-use/cap, the reserve, and each referenced key's in-use, cap (undefined when uncapped)
   * and waiting count. */
  snapshot(): {
    inUse: number;
    limit: number;
    reserve: number;
    byKey: Record<string, { inUse: number; limit?: number; waiting: number }>;
  } {
    const byKey: Record<string, { inUse: number; limit?: number; waiting: number }> = {};
    const addKey = (key?: string): void => {
      if (key === undefined) return;
      if (byKey[key] === undefined) {
        const cap = this.keyCaps.get(key);
        const entry: { inUse: number; limit?: number; waiting: number } = {
          inUse: this.keyInUse.get(key) ?? 0,
          waiting: 0,
        };
        if (cap !== undefined) entry.limit = cap;
        byKey[key] = entry;
      }
    };
    for (const k of this.keyCaps.keys()) addKey(k);
    for (const k of this.keyInUse.keys()) addKey(k);
    for (const w of this.waiters) {
      addKey(w.key);
      if (w.key !== undefined) byKey[w.key]!.waiting += 1;
    }
    for (const w of this.rekeyWaiters) {
      addKey(w.key);
      byKey[w.key]!.waiting += 1;
    }
    return { inUse: this.inUse, limit: this.capacity, reserve: this.reserve, byKey };
  }
}
