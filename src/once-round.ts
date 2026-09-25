import type { LoopRunner } from "./loop.js";

/**
 * Once-mode bookkeeping (`tumwater run --once`), extracted from the orchestrator's poll loop.
 *
 * At start, each runner's tick count is snapshotted; a role is SETTLED when its ticks have
 * advanced past the snapshot (it ran its one tick), when this round's poll deferred it (a
 * deferred maintenance tick decided not to run — its once-round answer), or when it was skipped
 * with a persistent reason (backoff, paused, disabled mid-round, or the director's empty inbox —
 * nothing a poll can change). The value is the skip reason, for the caller's summary. A role
 * whose tick is merely in flight is NOT settled — the orchestrator only fires its stop once
 * every role is settled AND no tick is in flight AND the land queue has been empty with no
 * landing in flight for one full poll cycle (the guard against dropping a
 * queued-but-not-yet-started landing: a stop that lands during the shutdown drain drops the
 * queue entry, so the slot gets one poll to pick the entry up before the stop is trusted).
 */
export class OnceRound {
  /** Whether a once round is running at all; false makes every method inert. */
  readonly active: boolean;
  private readonly runners: readonly LoopRunner[];
  private readonly tickSnapshot: ReadonlyMap<string, number>;
  private readonly settled = new Map<string, string>();
  private idlePolls = 0;

  constructor(runners: readonly LoopRunner[], active: boolean) {
    this.runners = runners;
    this.active = active;
    this.tickSnapshot = new Map(runners.map((r) => [r.role, r.state.ticks] as const));
  }

  /** A role is settled once it ran its tick or a settle reason was recorded for it. */
  isSettled(runner: LoopRunner): boolean {
    return (
      runner.state.ticks > (this.tickSnapshot.get(runner.role) ?? 0) ||
      this.settled.has(runner.role)
    );
  }

  /** Record the role's once-round answer (why it ran no tick, or that it deferred). */
  settle(role: string, reason: string): void {
    this.settled.set(role, reason);
  }

  /** An idle, not-due role's settle reason: disabled mid-round, error backoff, or (for the
   * director) an empty inbox. No poll of this round changes any of these, so the role is
   * settled with its skip reason (the caller's summary reports it). */
  settleSkipped(runner: LoopRunner, now: number): void {
    this.settle(
      runner.role,
      !runner.config.roles[runner.role]?.enabled
        ? "disabled"
        : runner.state.nextRunAt > now
          ? "backoff"
          : "idle",
    );
  }

  /** The settle reasons recorded so far, for the caller's summary. */
  get reasons(): ReadonlyMap<string, string> {
    return this.settled;
  }

  /** True on the SECOND consecutive quiet poll — every role settled, no role or director tick
   * in flight, no landing task running, land queue empty — and false otherwise (resetting the
   * quiet streak). The orchestrator fires its internal stop when this returns true. */
  exitReady(flight: {
    roleTicks: number;
    directorTicks: number;
    landings: number;
    queuedLandings: number;
  }): boolean {
    const quiet =
      this.runners.every((r) => this.isSettled(r)) &&
      flight.roleTicks === 0 &&
      flight.directorTicks === 0 &&
      flight.landings === 0 &&
      flight.queuedLandings === 0;
    if (!(this.active && quiet)) {
      this.idlePolls = 0;
      return false;
    }
    if (this.idlePolls > 0) return true;
    this.idlePolls++;
    return false;
  }
}
