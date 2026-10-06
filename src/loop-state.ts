import type { TickResult } from "./tick/tick-outcome.js";
import { readJsonFile, writeJsonAtomic } from "./json-files.js";
import { statePath } from "./paths.js";

/** The loop's persisted state file — one JSON object per role under .tumwater/ — and the
 * observation-window counter reset: fresh-state defaults, the tolerant load, the atomic
 * save, and zeroCounters. The scheduling POLICY that mutates this state from tick outcomes
 * and operator wakes — the outcome application and resume limits in tick-apply.ts, the
 * clock arithmetic (backoff ladders, wakes, yield ring) in backoff.ts; the generic file
 * helpers are files.ts and the JSON convention
 * itself is json-files.ts. */

/** Persisted per-loop state in .tumwater/state/<role>.json. */
export interface LoopState {
  role: string;
  ticks: number;
  commits: number;
  /** Epoch ms before which the loop must not run again. */
  nextRunAt: number;
  /** Current backoff in seconds (0 = not backing off). */
  backoffSeconds: number;
  /** main HEAD observed at the end of the last tick; a different HEAD wakes the loop. */
  lastMainHead: string;
  /** The role's recent yield as a ring of one-char codes, oldest first: `L` for a landing
   * (a `changed`/`queued` tick) and `n` for a counted empty tick — every result except the
   * error class (`error`/`aborted`/`quiet_killed`, which are no evidence of yield either
   * way) and the ring keeps the last YIELD_RING entries. Read by yieldMultiplier
   * (backoff.ts) to stretch the role's min-tick gap while it keeps finding nothing;
   * persisted because the gap decision must survive a restart like the rest of the
   * schedule. Absent on states written before the field existed — reads as an empty ring,
   * multiplier 1. */
  recentOutcomes?: string;
  /** The last COMPLETED result and its summary — the pair the dashboards' "last result" cell
   * renders. A `queued` tick never writes it (tick-apply.ts's applyTickOutcome): its change is still
   * in flight, which the state column already shows, so the pair keeps the prior outcome until
   * the landing resolves and applyLandingOutcome records the landing's own. */
  lastResult?: TickResult;
  lastSummary?: string;
  /** The summary a `queued` tick reported for the change it pinned (the text its tick_end
   * carries, high-friction annotation included), keyed by that change's sha. Held back from
   * `lastSummary` while the change waits, then paired with the landing's result by
   * applyLandingOutcome, which clears it — so after a landing the cell reads the landing's
   * outcome next to the summary of the change it landed, never next to the prior tick's.
   * Persisted: the land queue is durable, so the landing can resolve in a later process. */
  queuedSummary?: { sha: string; summary: string };
  lastTickStartedAt?: number;
  lastTickEndedAt?: number;
  /** True while a tick is in flight (best-effort; cleared on orchestrator start). */
  running?: boolean;
  /** Epoch ms since the orchestrator reserved this loop but its tick still waits in the
   * semaphore queue: it holds no maxConcurrent permit and runs no pi yet. Transient — set
   * by the orchestrator, cleared the moment the permit is granted (and defensively on tick
   * outcome / orchestrator start) — and never persisted, so dashboards can render the
   * parked waiter as `awaiting slot` and keep the active-state rows equal to the real
   * permit holders (BUGS.md 2026-09-24). */
  parkedSince?: number;
  /** True when the last tick was interrupted mid-task — aborted by a harness shutdown, or
   * truncated at the model's context ceiling — with its pi session (and any uncommitted
   * worktree edits, for shutdowns) left in place: the next tick resumes that session
   * (--continue) instead of starting fresh. Consumed (cleared) by that tick; set again only
   * by another interruption, so a failing resume falls back to a fresh start. */
  resumePending?: boolean;
  /** Why a pending resume happened when it was not a cut-off: "hung-tool" when the quiet
   * watchdog killed a run on a stalled tool call, so the bridge prompt names that cause (and
   * warns against re-running the hung command unchanged); "budget-resumed" when the budget
   * gate reopened and the in-flight fallback tick was handed back to the primary model
   * (PLANS.md 2026-09-30). Cleared with resumePending at tick start; absent for restart/cut-off
   * resumes, whose causes are derived. */
  resumeCause?: "hung-tool" | "timeout" | "budget-resumed";
  /** Queue file holding the user prompt a resume-owning tick re-queued: the interrupted pi
   * session still owns that request in its context, so the resume must reclaim exactly this
   * file as its own user prompt — the resume's fulfillment consumes it, and only its failure
   * paths re-queue it — instead of leaving the copy queued for a later fresh tick to run the
   * same request twice. Cleared at every tick's start; reclaimed only by a tick that resumes. */
  resumePromptFile?: string;
  /** Epoch ms of the last operator wake (`tumwater wake`, or the auto-wake a queued
   * per-role prompt sends) that cleared this loop's schedule. Scheduling input, not
   * observation: isEligible exempts the role's min-tick interval when the wake is newer
   * than the last tick's end, so an explicit "try again now" brings a slow-clock loop
   * (qa, steward) in within one poll instead of waiting out the interval it ticked inside
   * — the same exemption the director's inbox already grants user prompts. Self-clearing:
   * the next tick's end re-stamps lastTickEndedAt past the wake, restoring the ordinary
   * gap without a separate erase. */
  wokenAt?: number;
  /** Consecutive ticks that ended truncated at the context ceiling. Bounds cut-off resumes:
   * past the limit the loop abandons the runaway task and falls back to a fresh tick. */
  cutOffStreak?: number;
  /** Consecutive ticks ended by the quiet watchdog (`quiet_killed`). Bounds quiet-kill
   * resumes: while at or under the limit the loop resumes the starved session promptly,
   * past it the loop abandons the session and takes a fresh tick on the idle ladder, so a
   * session the backend will not schedule cannot retry immediately forever (BUGS.md
   * 2026-09-18). Reset by any non-quiet-kill outcome. */
  quietKillStreak?: number;
  /** Consecutive failed ticks: an `error`-result tick OR one whose leftover recovery left a
   * landing pin behind (TickOutcome.recoveryFailure). While at or past the warning threshold
   * (tick-apply.ts's ERROR_STREAK_WARN) the state cell reads "failing" instead of "sleeping",
   * and the crossing fires one warning event per episode (BUGS.md 2026-09-15: 44
   * identical tick failures looked like a quiet fleet; BUGS.md 2026-09-21: a dead reviewer
   * backend left every recovery landing failing silently and reset this streak each tick).
   * A review-rejected landing counts in too (BUGS.md 2026-09-30): the authoring tick ends
   * `queued`, which preserves the streak, and applyLandingOutcome's rejected branch is the
   * accumulation point; a landed change resets it. Reset by any other completed result. */
  consecutiveErrors?: number;
  /** Where in its cycle the loop was when it last persisted state: "review" means the
   * interruption hit during the review gate, so any uncommitted worktree edits are the
   * reviewer's stray output (discarded on resume), not author work. Set + saved around the
   * reviewer run; cleared at tick end alongside `running`. */
  phase?: "pi" | "review";
  /** The most recent review-gate outcome for this loop: what was decided, why, and which
   * branch HEAD it covered. A reject's reasons are injected into the role's next tick prompt
   * — every tick starts a fresh session, so this is the only cross-tick memory of what was
   * built and why it failed. */
  lastReview?: { verdict: string; reasons: string[]; head?: string; at: number };
  /** Branch HEAD that passed review most recently. Leftover commits at exactly this HEAD
   * merge without re-review (a merge_blocked retry must not burn another review run). */
  lastApprovedHead?: string;
  /** git/git.ts patchId of the change at lastApprovedHead against main — the diff the reviewer
   * judged. A different head carrying the same patch (a clean rebase onto a moved main) reuses
   * the approval: no second model review, though the gate's build pre-check still runs. */
  lastApprovedPatchId?: string;
  /** Consecutive failed reviews of the SAME branch HEAD (reset when the reviewed HEAD
   * changes or a review succeeds). Past the limit the leftover is discarded with a warning,
   * so a misconfigured reviewer cannot wedge a loop re-reviewing one commit forever. */
  unreviewFailures?: number;
  /** Consecutive landings of the SAME pinned sha that ended `merge_conflict` — each one a failed
   * conflict-resolution run. Keyed by sha: a pin that rebased cleanly onto a moved main is a new
   * attempt and starts fresh. At MERGE_CONFLICT_LIMIT leftover recovery discards the pin instead
   * of re-queuing it, so an unmergeable change cannot hold its role off authoring forever. */
  mergeConflicts?: { sha: string; count: number };
  /** The change leftover recovery discarded at MERGE_CONFLICT_LIMIT, named in the role's
   * prompts until its next change is queued — the author's only memory that the work is gone
   * and must be redone against current main if it is still wanted. */
  conflictDiscard?: { sha: string; summary: string; attempts: number; at: number };
  /** Consecutive landings of one patch (git/git.ts patchId, stable across a clean rebase) whose
   * in-lock check went red on the rebased tree. At landing-check-failures.ts's LANDING_CHECK_FAILURE_LIMIT the
   * red is attributed through main's own verdict instead of re-queued as merge_blocked again. */
  landingCheckFailures?: { patchId: string; count: number };
  /** Tokens the model generated in this loop's current or last completed tick — a per-tick
   * window (loop.ts resets it at tick start), not a lifetime total. */
  generatedTokens: number;
  /** Largest single-request context of this loop's current or last completed tick (per-tick
   * window, reset at tick start). */
  peakContextTokens: number;
  totalCostUsd: number;
  /** Local calendar day (YYYY-MM-DD) that `dayCostUsd` belongs to; a stale or missing stamp
   * reads as $0 today — spend before this field existed is unknown, and a tick crossing local
   * midnight attributes its spend to the new day. See plans/daily-cost-budget.md. */
  dayStamp?: string;
  /** This loop's spend for `dayStamp`'s local day (the daily cost budget window). Deliberately
   * NOT zeroed by reset-counters: the budget is a safety valve, not an observation window. */
  dayCostUsd?: number;
  lastError?: string;
}

/** A new LoopState for one role, before its first tick. */
export function freshLoopState(role: string): LoopState {
  return {
    role,
    ticks: 0,
    commits: 0,
    nextRunAt: 0,
    backoffSeconds: 0,
    lastMainHead: "",
    generatedTokens: 0,
    peakContextTokens: 0,
    totalCostUsd: 0,
    dayStamp: "",
    dayCostUsd: 0,
  };
}

/** Load the loop's persisted state; never throws — a missing or unreadable file yields a
 * fresh state, and fields absent from an older file fall back to defaults. */
export function loadLoopState(root: string, role: string): LoopState {
  const saved = readJsonFile<Partial<LoopState>>(statePath(root, role));
  return { ...freshLoopState(role), ...(saved ?? {}) };
}

/** Persist the loop's state atomically via writeJsonAtomic, so a crash mid-write cannot
 * leave a torn file behind. Its per-pid tmp name matters here: two processes can write one
 * role's state concurrently — the orchestrator saves at tick end and around its review gate
 * while `tumwater reset-counters` rewrites the same file from the CLI process — and per-pid
 * names give each writer its own tmp with a clean last-writer-wins. */
export function saveLoopState(root: string, state: LoopState): void {
  writeJsonAtomic(statePath(root, state.role), state);
}

/** Zero the accumulated counters (ticks, commits, tokens, cost) so a fresh observation
 * window can begin. Pure: returns a new state and preserves everything else — scheduling
 * fields (nextRunAt, backoffSeconds), wake tracking (lastMainHead), and the last-result
 * fields. peakContextTokens is zeroed too: under per-tick semantics it holds the loop's
 * last completed tick's peak, so a fresh window must clear it or sleeping loops keep
 * showing their old value until they next tick. The daily cost budget window (dayStamp/
 * dayCostUsd) is deliberately NOT zeroed: the budget is a safety valve, not an observation
 * window — zeroing today's spend would let the cap be bypassed by running reset-counters.
 */
export function zeroCounters(s: LoopState): LoopState {
  return { ...s, ticks: 0, commits: 0, generatedTokens: 0, peakContextTokens: 0, totalCostUsd: 0 };
}

/** The skip reason a loop's persisted state yields when it does not run this round: a pending
 * resume wait outranks backoff, anything else is idle. The shared tail of the two skip
 * classifiers — once-round.ts's settleSkipped (which adds the disabled arm) and cli/cli-run.ts's
 * once-summary (which adds the fleet-pause arm) — so the two surfaces cannot drift on which
 * reason wins when several conditions hold at once. */
export function stateSkipReason(
  s: Pick<LoopState, "resumePending" | "backoffSeconds">,
): string {
  if (s.resumePending) return "resume pending";
  if (s.backoffSeconds > 0) return "backoff";
  return "idle";
}
