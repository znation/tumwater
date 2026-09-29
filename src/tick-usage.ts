import type { BackendFailureKind, PiRunResult } from "./pi.js";
import type { LoopState } from "./loop-state.js";
import { recordDailyCost } from "./budget.js";

/** Usage accounting for one role loop, split out of loop.ts — which keeps the tick lifecycle —
 * because token/cost/turn bookkeeping is a self-contained concern with its own consumers: the
 * commit trailer reads turns, the tick_end event reads costUsd, and the orchestrator's fleet-wide
 * hold reads lastRateLimit and lastBackendFailure (src/rate-limit-hold.ts, src/tick-timing.ts).
 *
 * fold() is the once-per-run choke point: every pi run of a tick — main attempt, transient
 * retry, conflict resolution, landing runs via foldLandingUsage — lands here exactly once, so
 * adding a usage field to PiRunResult touches this single place. */
export class TickUsage {
  /** Assistant turns folded into THIS tick so far (non-persisted): reset at tick start,
   * grown in fold. Read at commit time for the trailer, where it holds exactly the
   * pre-commit runs' total (main + transient retry) — conflict-resolution and review runs
   * fold after the commit and never inflate it. Deliberately not on LoopState: its only
   * consumer is the trailer stamped into the commit message itself, which is durable. */
  turns = 0;
  /** USD cost folded into THIS tick so far (non-persisted): reset at tick start alongside
   * turns, grown in fold. Deliberately not on LoopState — unlike generatedTokens, no
   * dashboard reads it mid-run; its only consumer is the tick_end event, which fires before
   * the next tick resets it (plans: per-tick usage in the event feed). */
  costUsd = 0;
  /** This loop's most recent pi run that ended on a provider 429 — author run, retry,
   * reviewer or landing run alike, since every one folds through fold — with the provider's
   * Retry-After hint when it sent one. The orchestrator reads it every poll as this role's
   * rate-limit input to the fleet-wide hold (src/rate-limit-hold.ts): the per-run retry has no
   * cross-role view, and a field on the runner the orchestrator already holds carries the
   * fact without a new cross-module channel. In memory only — a hold is minutes long, so a
   * restart forgetting it costs nothing. Undefined until the first such run. */
  lastRateLimit?: { at: number; retryAfterSeconds?: number };
  /** This loop's most recent pi run that ended on a provider-wide failure that was NOT rate
   * limiting — the connection down, a 5xx, the model failing to load (PiRunResult.
   * transientBackend) — with the kind the hold's storm test groups storms by. Stamped under
   * the same rule and for the same consumer as lastRateLimit above: the fleet-wide hold
   * (src/rate-limit-hold.ts) reads it every poll. In memory only, like lastRateLimit.
   * Undefined until the first such run. */
  lastBackendFailure?: { at: number; kind: BackendFailureKind };

  /** Clear the per-tick windows (turns, costUsd) at tick start. lastRateLimit and
   * lastBackendFailure are NOT cleared: they are episodic observations the orchestrator's
   * hold consumes, not per-tick windows. */
  reset(): void {
    this.turns = 0;
    this.costUsd = 0;
  }

  /** Fold one pi run's usage into the tick's counters (gen / peak ctx / cost / turns) and
   * the loop's lifetime totals on `s`. */
  fold(s: LoopState, run: PiRunResult): void {
    s.generatedTokens += run.outputTokens;
    s.peakContextTokens = Math.max(s.peakContextTokens, run.peakContextTokens);
    s.totalCostUsd += run.costUsd;
    this.costUsd += run.costUsd;
    // The daily cost budget window (plans/daily-cost-budget.md): every pi run of a tick folds
    // here exactly once, so the fleet's spend for the local day is complete at each tick end.
    recordDailyCost(s, run.costUsd);
    this.turns += run.turns;
    // The fleet-wide hold's rate-limit input (lastRateLimit above), from the same once-per-run choke
    // point. Only a run that ENDED on the 429 counts: pi exits on the error, so "now" is when
    // the provider refused — a run that merely logged one inside pi's own auto-retry and then
    // finished would stamp a 429 at its end, possibly hours late, and could trip a false storm.
    if (run.transientRateLimit && !run.ok)
      this.lastRateLimit = { at: Date.now(), retryAfterSeconds: run.retryAfterSeconds };
    // The backend-failure sibling of the stamp above, same rule: only a run that ENDED on the
    // failure counts, and the kind travels with it (src/pi-stream.ts backendKind classified
    // the text at parse time). A 429 never lands here — pi-stream checks rate-limit first.
    if (run.transientBackend && !run.ok && run.backendKind)
      this.lastBackendFailure = { at: Date.now(), kind: run.backendKind };
  }
}
