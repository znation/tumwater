import type { BackendFailureKind } from "../pi/pi.js";
import { runCostIsReal, type PiRunResult } from "../pi/pi-run-result.js";
import type { RateWindow } from "../pi/pi-stream.js";
import type { ClaudeBilling } from "../agent/claude/claude-account.js";
import type { LoopState } from "../loop/loop-state.js";
import { recordDailyCost } from "../budget/budget.js";
import { nonNegativeNumber } from "../files/json-object.js";

/** Usage accounting for one role loop, split out of loop.ts — which keeps the tick lifecycle —
 * because token/cost/turn bookkeeping is a self-contained concern with its own consumers: the
 * commit trailer reads turns, the run_end event reads costUsd, and the orchestrator's team-wide
 * hold reads lastRateLimit and lastBackendFailure (src/team/team-hold.ts,
 * src/team/team-polls.ts).
 *
 * fold() is the once-per-run choke point: every pi run of a tick — main attempt, transient
 * retry, conflict resolution, merge runs via foldMergeUsage — ends up here exactly once, so
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

/** One role loop's per-tick usage accounting: the counters fold() grows from each pi run, plus
 * the billing and rate-window readings the orchestrator persists at tick end. */
export class TickUsage {
  /** Assistant turns folded into THIS tick so far (non-persisted): reset at tick start,
   * grown in fold. Read at commit time for the trailer, where it holds exactly the
   * pre-commit runs' total (main + transient retry) — conflict-resolution and review runs
   * fold after the commit and never inflate it. Deliberately not on LoopState: its only
   * consumer is the trailer stamped into the commit message itself, which is durable. */
  turns = 0;
  /** USD cost folded into THIS tick so far (non-persisted): reset at tick start alongside
   * turns, grown in fold. Deliberately not on LoopState — unlike generatedTokens, no
   * dashboard reads it mid-run; its only consumer is the run_end event, which fires before
   * the next tick resets it (plans: per-tick usage in the event feed). */
  costUsd = 0;
  /** Subscription runs' cost folded into THIS tick (non-persisted): API-equivalent spend the
   * run reported but that never charges the daily cap (plans/agent-backends.md part 6a). The
   * run_end event carries it and the report shows it on its own notional line. Reset at tick
   * start like costUsd. */
  notionalCostUsd = 0;
  /** How the tick's runs were last reported as paid for, and the newest subscription
   * rate-window readings any of them carried — the account state (claude-account.ts) the
   * orchestrator persists at tick end. Per-tick windows: reset at tick start, the last
   * reporting run of the tick wins. Undefined until a run reports them. */
  billing?: ClaudeBilling;
  rateWindows?: RateWindow[];
  /** Prompt tokens folded into THIS tick so far (non-persisted, reset at tick start). Every
   * pi run of the tick contributes — the authoring run, its transient retry, the SUMMARY
   * follow-up, and (through foldMergeUsage) review and conflict-resolution runs — because
   * all of them re-send context the operator paid for. */
  promptTokens = 0;
  /** The cache-read share of promptTokens folded so far. */
  cacheReadTokens = 0;
  /** Prompt tokens folded before the tick's first edit: authoring runs only, frozen once an
   * authoring run reports an edit (plans/per-tick-prompt-telemetry). Merge, review and
   * conflict-resolution runs are excluded — their context is the gate's, not the authoring
   * tick's pre-edit search. */
  preEditPromptTokens = 0;
  /** True once an authoring run has reported a first edit; the pre-edit counter freezes. */
  private editSeen = false;
  /** This loop's most recent pi run that ended on a provider 429 — author run, retry,
   * reviewer or merge run alike, since every one folds through fold — with the provider's
   * Retry-After hint when it sent one. The orchestrator reads it every poll as this role's
   * rate-limit input to the team-wide hold (src/team/team-hold.ts): the per-run retry has no
   * cross-role view, and a field on the runner the orchestrator already holds carries the
   * fact without a new cross-module channel. In memory only — a hold is minutes long, so a
   * restart forgetting it costs nothing. Undefined until the first such run. */
  lastRateLimit?: { at: number; retryAfterSeconds?: number; provider?: string };
  /** Per-provider spend folded into THIS tick (non-persisted, reset at tick start): each
   * run's real/notional cost keyed by the provider it ran on, so the run_end event can say
   * which seam of a mixed team spent what (plans: per-provider spend in the day report). A
   * run whose provider was never resolved attributes nothing — the `provider !== undefined`
   * guard below skips the bump — so an old single-provider tick keeps today's byte-identical
   * behavior. Parallel to costUsd/notionalCostUsd, never subtracted from them. */
  private providerCost = new Map<string, { costUsd: number; notionalCostUsd: number }>();

  /** This loop's most recent pi run that ended on a provider-wide failure that was NOT rate
   * limiting — the connection down, a 5xx, the model failing to load (PiRunResult.
   * transientBackend) — with the kind the hold's storm test groups storms by. Stamped under
   * the same rule and for the same consumer as lastRateLimit above: the team-wide hold
   * (src/team/team-hold.ts) reads it every poll. In memory only, like lastRateLimit.
   * Undefined until the first such run. */
  lastBackendFailure?: { at: number; kind: BackendFailureKind; provider?: string };

  /** Clear the per-tick windows (turns, costUsd, the prompt-token counters) at tick start.
   * lastRateLimit and lastBackendFailure are NOT cleared: they are episodic observations the
   * orchestrator's hold consumes, not per-tick windows. */
  reset(): void {
    this.turns = 0;
    this.costUsd = 0;
    this.notionalCostUsd = 0;
    this.billing = undefined;
    this.rateWindows = undefined;
    this.promptTokens = 0;
    this.cacheReadTokens = 0;
    this.preEditPromptTokens = 0;
    this.editSeen = false;
    this.providerCost = new Map();
  }

  /** Fold one pi run's usage into the tick's counters (gen / peak ctx / cost / turns) and
   * the loop's lifetime totals on `s`. `authoring` is false for a merge/review run folded
   * through foldMergeUsage: those never advance the tick's pre-edit counter, which measures
   * the authoring search. */
  fold(s: LoopState, run: PiRunResult, authoring = true, provider?: string, pair?: string): void {
    s.generatedTokens = counter(s.generatedTokens) + run.outputTokens;
    s.peakContextTokens = Math.max(counter(s.peakContextTokens), run.peakContextTokens);
    s.totalCostUsd = counter(s.totalCostUsd) + run.costUsd;
    // The billing split (plans/agent-backends.md §7): a subscription run's cost is notional
    // and never charges the daily cap; an API run's — or a run that ever saw overage — is real
    // money. totalCostUsd still counts both: it is lifetime usage, not a budget figure.
    if (runCostIsReal(run)) {
      this.costUsd += run.costUsd;
      // The daily cost budget window (plans/daily-cost-budget.md): every real-money pi run of
      // a tick folds here exactly once, so the team's spend for the local day is complete at
      // each tick end.
      recordDailyCost(s, run.costUsd, Date.now(), pair);
      this.bumpProviderCost(provider, run.costUsd, 'costUsd');
    } else {
      this.notionalCostUsd += run.costUsd;
      this.bumpProviderCost(provider, run.costUsd, 'notionalCostUsd');
    }
    if (run.billing !== undefined) this.billing = run.billing;
    if (run.rateWindows !== undefined) this.rateWindows = run.rateWindows;
    this.promptTokens += run.promptTokens;
    this.cacheReadTokens += run.cacheReadTokens;
    // The pre-edit prefix freezes at the tick's first edit: every authoring run while no edit
    // has been seen adds its pre-edit count (including the run that edits), and once one
    // reports an edit later runs add nothing. A review/merge run is skipped entirely.
    if (authoring) {
      if (!this.editSeen) this.preEditPromptTokens += run.preEditPromptTokens;
      if (run.firstEditTurn !== undefined) this.editSeen = true;
    }
    this.turns += run.turns;
    // The team-wide hold's rate-limit input (lastRateLimit above), from the same
    // once-per-run choke point. Only a run that ENDED on the 429 counts: pi exits on the error,
    // so "now" is when the provider refused — a run that merely logged one inside pi's own
    // auto-retry and then
    // finished would stamp a 429 at its end, possibly hours late, and could trip a false storm.
    if (run.transientRateLimit && !run.ok)
      this.lastRateLimit = { at: Date.now(), retryAfterSeconds: run.retryAfterSeconds, provider };
    // The backend-failure sibling of the stamp above, same rule: only a run that ENDED on the
    // failure counts, and the kind travels with it (src/pi/pi-stream.ts backendKind classified
    // the text at parse time). A 429 never ends up here — pi-stream checks rate-limit first.
    if (run.transientBackend && !run.ok && run.backendKind)
      this.lastBackendFailure = { at: Date.now(), kind: run.backendKind, provider };
  }

  /** Add `amount` to one field of the tick's per-provider spend ledger, initializing the
   * provider's entry on first contact. `provider` undefined (a run that never resolved one)
   * is a no-op, matching how fold calls it: only runs with a provider reach this. */
  private bumpProviderCost(
    provider: string | undefined,
    amount: number,
    field: 'costUsd' | 'notionalCostUsd',
  ): void {
    if (provider === undefined) return;
    const e = this.providerCost.get(provider) ?? { costUsd: 0, notionalCostUsd: 0 };
    e[field] += amount;
    this.providerCost.set(provider, e);
  }

  /** Serialize the per-provider split for the run_end payload: a `Record<provider,
   * {costUsd, notionalCostUsd}>`, or `{}` when no run carried a provider — the
   * omit-when-empty idiom tick-finalize.ts applies, so a tick whose runs never resolved a
   * provider renders no providerCost field at all. */
  serializeProviderCost(): Record<string, { costUsd: number; notionalCostUsd: number }> {
    const out: Record<string, { costUsd: number; notionalCostUsd: number }> = {};
    for (const [provider, e] of this.providerCost) out[provider] = e;
    return out;
  }
}
