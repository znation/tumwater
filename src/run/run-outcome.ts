/** What a finished run or merge is (the RunResult/RunOutcome vocabulary), shared by the
 * runner that produces it, the dashboards that render it, and the state machine that applies
 * it. The application policy — which outcomes count which streaks, when a session resumes,
 * how the next run is scheduled — lives next door in run-apply.ts; the clock arithmetic it
 * drives in backoff.ts. This module holds only the shared types. Split out of runner-state.ts —
 * the persisted state file's load/save — and later of the types.ts grab-bag, as RunnerState and
 * HarnessEvent were before it. */

export type RunResult =
  /** A merge completed: the change is merged to main. */
  | "changed"
  /** The run's change is committed and pinned; the orchestrator's merge slot will pick it up
   * from the durable merge queue (plans/merge-queue.md 3/5); the commit count and final outcome
   * are recorded when the merge completes; never stored as `lastResult`, which keeps the last
   * completed outcome. */
  | "queued"
  /** pi declined the work (TUMWATER_REFUSED); only its markdown objection note merged. */
  | "refused"
  /** pi decided there was nothing to do. */
  | "no_change"
  /** Change was made but could not be merged; the pin is re-pinned next run. At
   * MERGE_CONFLICT_LIMIT in a row it is handed back to its author to resolve, or discarded
   * when that lineage was already handed back. */
  | "merge_conflict"
  /** Fast-forward into main failed (e.g. dirty primary checkout). */
  | "merge_blocked"
  /** The review gate rejected the change; branch reset, reasons recorded. */
  | "rejected"
  /** The review gate failed (no parseable verdict); commit left for retry. */
  | "review_error"
  /** pi errored or timed out. */
  | "error"
  /** Harness shutdown killed the run mid-run; partial work discarded. */
  | "aborted"
  /** The quiet watchdog killed a stalled tool call mid-run; session + worktree edits
   * preserved and resumed promptly. */
  | "quiet_killed"
  /** A user-initiated abort (tumwater abort) killed the run mid-run; work discarded,
   * role backed off. */
  | "user_aborted"
  /** The change works on a backlog entry main no longer lists (the operator withdrew it, or
   * another change took it): the merge dropped it unmerged and deleted its pin, with no strike
   * and no revision (src/merge/merge-withdrawn.ts). */
  | "withdrawn"
  /** Nothing to run (e.g. director with an empty inbox). */
  | "skipped";

/** Why the orchestrator handed an in-flight run back resumably (RoleRunner.handBackRun): the
 * budget reopened while it ran on a fallback pair, or its pair failed the model check while it
 * waited on an unanswered model request. Each is the run's resume cause. */
export type HandBackCause = "budget-resumed" | "model-check";

/** The outcome of one full run: its result plus what the harness learned from it.
 * Consumed by the orchestrator's dashboards and by run-apply.ts's post-run
 * scheduling (applyRunOutcome). */
export interface RunOutcome {
  result: RunResult;
  summary?: string;
  commit?: string;
  /** The run's authoring run burned more than the configured thrashTurns turns AND thrashMinutes
   * (plans/refusal-and-thrash.md): difficulty is a signal, so the change went to
   * review flagged and a warning event was logged. */
  highFriction?: boolean;
  /** The run was truncated at the model's context ceiling before it could finish (a
   * no_change run whose final message carried no text or tool call). The work so far
   * survives in the pi session, which pi compacted at end of run — so the role resumes
   * it promptly instead of backing off as if the role were idle. */
  cutOff?: boolean;
  /** The pre-queue self-check's one-turn fix-up resolved its findings by reverting the whole
   * change, so the run ended `no_change` with nothing to commit even though the role authored
   * (run-stage.ts's applyStageFixUp). The outcome table still folds the run under no_change,
   * but the failure digest prices the discarded authoring as its own loss cause instead of a
   * quiet idle (BUGS.md 2026-11-08). */
  selfCheckReverted?: boolean;
  /** The run's leftover recovery re-pinned a pin whose last merge failed and kept it for
   * another attempt (review_error, merge_conflict, merge_blocked): the run itself ends
   * `queued`, but the persistent merge failure must still feed the error streak so a dead
   * reviewer backend raises the alarm instead of resetting it every run (BUGS.md 2026-09-21).
   * Carries the failure detail for the warning: `lastError` is deliberately cleared off the run
   * so the failure never rides its `run_end` (the sibling mislabel fix). */
  recoveryFailure?: string;
  /** The outcome's own cause, written deliberately for this result — never a leftover merge
   * failure (those ride `state.lastError` and the recoveryFailure field above), so the run's
   * `run_end` names what broke and the failure digest's error clusters carry the detail
   * (BUGS.md 2026-09-28). */
  error?: string;
  /** Why a resumed session's bridge prompt names its cause, when the resume's result itself is
   * not specific enough to derive it: a quiet_killed run can be a hung tool call (the default
   * "hung-tool" bridge) or a run timeout that fired on a run still making progress (a
   * "timeout" bridge, which asks for the smallest finish against the same limit); an aborted
   * run handed back at budget_resumed (PLANS.md 2026-09-30) carries "budget-resumed", whose
   * bridge says the run moved back to the primary model; a subscription claude usage-window
   * rejection carries "rate-limit", whose bridge names the held window (part 6e); an
   * API-billed claude run cut off at its per-run budget cap ends `aborted` with
   * "budget-capped", whose handoff carries the kept worktree to the fallback (part 7a/7);
   * an image-blind run with an image-capable peer tier ends `aborted` with "image-reroute",
   * whose handoff carries the kept worktree to that tier (plans/image-input.md part 4/5); a run
   * the model check handed back while it waited on an unanswered model request ends `aborted`
   * with "model-check", whose bridge says the model stopped answering (plans/model-check.md).
   * Set only by those outcomes; every other resume cause is derived from state (cut-off streak,
   * restart). */
  resumeCause?: "hung-tool" | "stalled-tool" | "timeout" | "budget-resumed" | "rate-limit" | "budget-capped" | "image-reroute" | "model-check";
  /** A `no_change` run that declared neither nothing-to-do nor a refusal and was not cut off
   * (run-verdict.ts's warnUndeclaredNoChange): the agent replied, but not the way a working
   * model answers its prompt. The orchestrator has the model check probe the run's pair again
   * (src/model-check/model-check-gate.ts), since a serving fault looks exactly like this. */
  undeclared?: boolean;
  /** The run's last authoring agent run failed before its model replied at all
   * (pi-run-result.ts's endedBeforeAnyReply, set by finalizeRun): the orchestrator has the
   * model check probe the run's pair again, as for `undeclared`. A run whose request is still
   * unanswered mid-run reaches the check sooner, through RoleRunner.unansweredRunPair. */
  unanswered?: boolean;
  /** The run ended on leftover recovery (runner-leftover.ts) — the leftover was re-pinned (or
   * already had a queued entry, or could not be pinned) — without an authoring run. No model
   * ran, so the orchestrator's fallback breaker takes the run as no evidence about the backend. */
  recoveredLeftover?: boolean;
  /** The run committed but enqueued nothing because the role already had a queued change or an
   * unmerged pin (interlock relief, plans/interlock-relief.md): its commit stays on the branch,
   * and its `run_end` must not join the queued-row verdict — resolveQueuedResult returns null
   * on the flag so the earlier change's merge outcome is not attributed to this held run. */
  heldOnBranch?: true;
}

/** Record the review gate's verdict on a HEAD into `lastReview` — the field the author's next
 * run prompt injects (run-prompt.ts's buildRejectedReviewNote) and the same-head strike
 * counter reads (review.ts's unreviewFailures). Mutates `s` in place; the timestamp is
 * stamped here so every call site shares one Date.now() read and the shape stays in one place
 * (runner-state.ts's lastReview). */

