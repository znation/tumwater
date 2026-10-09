import type { BackendFailureKind } from "../pi/pi.js";
import type { PiRunResult } from "../pi/pi-run-result.js";
import type { LoopState } from "../loop/loop-state.js";
import { recordDailyCost } from "../budget/budget.js";
import { nonNegativeNumber } from "../files/json-object.js";

/** Usage accounting for one role loop, split out of loop.ts — which keeps the tick lifecycle —
 * because token/cost/turn bookkeeping is a self-contained concern with its own consumers: the
 * commit trailer reads turns, the tick_end event reads costUsd, and the orchestrator's fleet-wide
 * hold reads lastRateLimit and lastBackendFailure (src/fleet/fleet-hold.ts, src/fleet/fleet-polls.ts).
 *
 * fold() is the once-per-run choke point: every pi run of a tick — main attempt, transient
 * retry, conflict resolution, landing runs via foldLandingUsage — lands here exactly once, so
 * adding a usage field to PiRunResult touches this single place. */
/** One persisted counter, healed to a finite non-negative number before it is read and
 * rewritten: `generatedTokens`/`peakContextTokens` are per-tick windows and `totalCostUsd` a
 * lifetime total. `loadLoopState` already heals every top-level numeric state field on read,
 * but fold keeps its own invariant at this write choke point so a hand-edited or torn field (a
 * string that would make `+=` concatenate, NaN/±Infinity that would propagate through Math.max
 * and every display of the figure, or a negative that would run a total backwards) can never
 * re-enter the state through a save. Unusable reads as 0, the same policy budget.ts's daily
 * window applies to its stored spend. */
function counter(value: unknown): number {
  return nonNegativeNumber(value, 0);
}

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
  /** Prompt tokens folded into THIS tick so far (non-persisted, reset at tick start). Every
   * pi run of the tick contributes — the authoring run, its transient retry, the SUMMARY
   * follow-up, and (through foldLandingUsage) review and conflict-resolution runs — because
   * all of them re-send context the operator paid for. */
  promptTokens = 0;
  /** The cache-read share of promptTokens folded so far. */
  cacheReadTokens = 0;
  /** Prompt tokens folded before the tick's first edit: authoring runs only, frozen once an
   * authoring run reports an edit (plans/per-tick-prompt-telemetry). Landing, review and
   * conflict-resolution runs are excluded — their context is the gate's, not the authoring
   * tick's pre-edit search. */
  preEditPromptTokens = 0;
  /** True once an authoring run has reported a first edit; the pre-edit counter freezes. */
  private editSeen = false;
  /** This loop's most recent pi run that ended on a provider 429 — author run, retry,
   * reviewer or landing run alike, since every one folds through fold — with the provider's
   * Retry-After hint when it sent one. The orchestrator reads it every poll as this role's
   * rate-limit input to the fleet-wide hold (src/fleet/fleet-hold.ts): the per-run retry has no
   * cross-role view, and a field on the runner the orchestrator already holds carries the
   * fact without a new cross-module channel. In memory only — a hold is minutes long, so a
   * restart forgetting it costs nothing. Undefined until the first such run. */
  lastRateLimit?: { at: number; retryAfterSeconds?: number };
  /** This loop's most recent pi run that ended on a provider-wide failure that was NOT rate
   * limiting — the connection down, a 5xx, the model failing to load (PiRunResult.
   * transientBackend) — with the kind the hold's storm test groups storms by. Stamped under
   * the same rule and for the same consumer as lastRateLimit above: the fleet-wide hold
   * (src/fleet/fleet-hold.ts) reads it every poll. In memory only, like lastRateLimit.
   * Undefined until the first such run. */
  lastBackendFailure?: { at: number; kind: BackendFailureKind };

  /** Clear the per-tick windows (turns, costUsd, the prompt-token counters) at tick start.
   * lastRateLimit and lastBackendFailure are NOT cleared: they are episodic observations the
   * orchestrator's hold consumes, not per-tick windows. */
  reset(): void {
    this.turns = 0;
    this.costUsd = 0;
    this.promptTokens = 0;
    this.cacheReadTokens = 0;
    this.preEditPromptTokens = 0;
    this.editSeen = false;
  }

  /** Fold one pi run's usage into the tick's counters (gen / peak ctx / cost / turns) and
   * the loop's lifetime totals on `s`. `authoring` is false for a landing/review run folded
   * through foldLandingUsage: those never advance the tick's pre-edit counter, which measures
   * the authoring search. */
  fold(s: LoopState, run: PiRunResult, authoring = true): void {
    s.generatedTokens = counter(s.generatedTokens) + run.outputTokens;
    s.peakContextTokens = Math.max(counter(s.peakContextTokens), run.peakContextTokens);
    s.totalCostUsd = counter(s.totalCostUsd) + run.costUsd;
    this.costUsd += run.costUsd;
    this.promptTokens += run.promptTokens;
    this.cacheReadTokens += run.cacheReadTokens;
    // The pre-edit prefix freezes at the tick's first edit: every authoring run while no edit
    // has been seen adds its pre-edit count (including the run that edits), and once one
    // reports an edit later runs add nothing. A review/landing run is skipped entirely.
    if (authoring) {
      if (!this.editSeen) this.preEditPromptTokens += run.preEditPromptTokens;
      if (run.firstEditTurn !== undefined) this.editSeen = true;
    }
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
    // failure counts, and the kind travels with it (src/pi/pi-stream.ts backendKind classified
    // the text at parse time). A 429 never lands here — pi-stream checks rate-limit first.
    if (run.transientBackend && !run.ok && run.backendKind)
      this.lastBackendFailure = { at: Date.now(), kind: run.backendKind };
  }
}
