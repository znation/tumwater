import { writeJsonAtomic } from "../files/json-files.js";
import { statePath } from "../paths.js";
import { tryOrWarn } from "../events/events.js";
import type { RunnerState } from "./runner-state-types.js";

/** The runner's persisted state file — one JSON object per role under .tumwater/ — and the
 * observation-window counter reset: fresh-state defaults, the atomic save, and zeroCounters
 * (the tolerant load and the live-claim scan are runner-state-load.ts). The published shape
 * itself — `RunnerState`, `SkipReason` and `SKIP_REASONS` — is runner-state-types.ts, the same
 * contract-file pattern as `status-types.ts`, so the observers that only read a role's schedule
 * never import this writer. The scheduling POLICY
 * that mutates this state from run outcomes and operator wakes — the outcome application and
 * resume limits in run-apply.ts, the clock arithmetic (backoff ladders, wakes, yield ring) in
 * backoff.ts; the generic file helpers are src/files/files.ts and the JSON convention itself is
 * src/files/json-files.ts. */

/** A new RunnerState for one role, before its first run. */
export function freshRunnerState(role: string): RunnerState {
  return {
    role,
    runs: 0,
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


/** Persist the runner's state atomically via writeJsonAtomic, so a crash mid-write cannot
 * leave a torn file behind. Its per-pid tmp name matters here: two processes can write one
 * role's state concurrently — the orchestrator saves at run end and around its review gate
 * while `tumwater reset-counters` rewrites the same file from the CLI process — and per-pid
 * names give each writer its own tmp with a clean last-writer-wins. */
export function saveRunnerState(root: string, state: RunnerState): void {
  writeJsonAtomic(statePath(root, state.role), state);
}

/** Save for callers that cannot afford a throw — the orchestrator's poll loop, which has no
 * catch, and a run's end, where a throw would skip run_end and the launch task's breaker fold:
 * a failed write warns under the role's id and returns. The in-memory state stays ahead of the
 * file until the runner's next successful save. */
export function saveRunnerStateBestEffort(root: string, state: RunnerState): void {
  tryOrWarn(root, state.role, "save the role's state", () => saveRunnerState(root, state));
}

/** Zero the accumulated counters (runs, commits, tokens, cost) so a fresh observation
 * window can begin. Pure: returns a new state and preserves everything else — scheduling
 * fields (nextRunAt, backoffSeconds), wake tracking (lastMainHead), and the last-result
 * fields. peakContextTokens is zeroed too: under per-run semantics it holds the runner's
 * last completed run's peak, so a fresh window must clear it or sleeping runners keep
 * showing their old value until they next run. The daily cost budget window (dayStamp/
 * dayCostUsd) is deliberately NOT zeroed: the budget is a safety valve, not an observation
 * window — zeroing today's spend would let the cap be bypassed by running reset-counters.
 */
export function zeroCounters(s: RunnerState): RunnerState {
  return { ...s, runs: 0, commits: 0, generatedTokens: 0, peakContextTokens: 0, totalCostUsd: 0 };
}

/** The skip reason a runner's persisted state yields when it does not run this round: a pending
 * resume wait outranks backoff, anything else is idle. The shared tail of the two skip
 * classifiers — once-round.ts's settleSkipped (which adds the disabled arm) and
 * cli/cli-start-summary.ts's once-summary (which adds the team-pause arm) — so the two surfaces
 * cannot drift on which
 * reason wins when several conditions hold at once. */
export function stateSkipReason(
  s: Pick<RunnerState, "resumePending" | "backoffSeconds">,
): string {
  if (s.resumePending) return "resume pending";
  if (s.backoffSeconds > 0) return "backoff"; // vocabulary-ok: skip-reason code is a state value until the state rename
  return "idle";
}

/** True when the runner still owes follow-up work for its current task after a run: a rejected
 * change it must revise (state.revision) or a session it must resume (state.resumePending).
 * The hand-back keeps the instance bound to the same task, so the claim-release rule
 * (run/run-finalize.ts), the conflict-handback rule (run/run-apply.ts), and claims.ts's
 * idle test all read this one predicate instead of repeating the revision/resume conjunction. */
export function hasOutstandingWork(s: Pick<RunnerState, "revision" | "resumePending">): boolean {
  return s.revision !== undefined || s.resumePending === true;
}

/** True when the runner got an explicit operator wake after its last completed run
 * (state.wokenAt newer than lastRunEndedAt), so the scheduler ships its min-interval gap and
 * the need-based deferral stands the runner down. The single home of the "freshly woken since
 * the last run end" test, previously repeated inline by the due-check, plan deferral, and
 * need-based deferral (scheduling.ts's isEligible, planDeferral, and deferRunReason) and by
 * the orchestrator's fresh-demand and plans-full stand-down tests (scheduling/skip.ts's
 * per-runner demand and scheduling/admit.ts's stand-down guard), so those surfaces cannot drift
 * on what counts
 * as a fresh wake. */
export function freshlyWoken(s: RunnerState): boolean {
  return s.wokenAt !== undefined && s.wokenAt > (s.lastRunEndedAt ?? 0);
}

/** Consecutive conflict-ended merges of `sha` in the role's conflict streak (0 when the
 * streak is absent or names another sha). The single home of the read every consumer of
 * RunnerState.mergeConflicts needs: the drain's retry decision (pinnedRetrySha), leftover
 * recovery's cap check, the director-pin owed-run classification (scheduling/scope.ts), and
 * the streak increment on a `merge_conflict` (run-apply.ts), so none of them can drift on
 * what counts as the streak's own sha. */
export function conflictAttempts(streak: RunnerState["mergeConflicts"], sha: string): number {
  return streak?.sha === sha ? streak.count : 0;
}
