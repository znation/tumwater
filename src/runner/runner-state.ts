// vocabulary: plain
import type { RunResult } from "../run/run-outcome.js";
import type { MergeEntry } from "../merge/merge-queue.js";
import type { ModelFallbackState } from "./model-fallback.js";
import { writeJsonAtomic } from "../files/json-files.js";
import { statePath } from "../paths.js";

/** The runner's persisted state file — one JSON object per role under .tumwater/ — and the
 * observation-window counter reset: fresh-state defaults, the atomic save, and zeroCounters
 * (the tolerant load and the live-claim scan are runner-state-load.ts). The scheduling POLICY
 * that mutates this state from run outcomes and operator wakes — the outcome application and
 * resume limits in run-apply.ts, the clock arithmetic (backoff ladders, wakes, yield ring) in
 * backoff.ts; the generic file helpers are src/files/files.ts and the JSON convention itself is
 * src/files/json-files.ts. */

/** How many times a progressing-timeout review may be resumed before the next attempt
 * reviews the change from scratch (RunnerState.reviewResume). The budget bounds a reviewer that
 * keeps timing out mid-progress, so a wedged review converges to a fresh run instead of
 * resuming the same session forever. */
export const REVIEW_RESUME_LIMIT = 2;

/** Approved patch-ids a runner remembers (RunnerState.approvedPatchIds). */
export const APPROVED_PATCH_IDS_MAX = 8;

/** Persisted per-runner state in .tumwater/state/<role>.json. */
export interface RunnerState {
  role: string;
  runs: number;
  commits: number;
  /** Epoch ms before which the runner must not run again. */
  nextRunAt: number;
  /** Current backoff in seconds (0 = not backing off). */
  backoffSeconds: number;
  /** main HEAD observed at the end of the last run; a different HEAD wakes the runner. */
  lastMainHead: string;
  /** The role's recent yield as a ring of one-char codes, oldest first: `L` for a merge
   * (a `changed`/`queued` run) and `n` for a counted empty run — every result except the
   * error class (`error`/`aborted`/`quiet_killed`, which are no evidence of yield either
   * way) and the ring keeps the last YIELD_RING entries. Read by yieldMultiplier
   * (backoff.ts) to stretch the role's min-run gap while it keeps finding nothing;
   * persisted because the gap decision must survive a restart like the rest of the
   * schedule. Absent on states written before the field existed — reads as an empty ring,
   * multiplier 1. */
  recentOutcomes?: string;
  /** The last COMPLETED result and its summary — the pair the dashboards' "last result" cell
   * renders. A `queued` run never writes it (run-apply.ts's applyRunOutcome): its change is
   * still in flight, which the state column already shows, so the pair keeps the prior outcome
   * until the merge resolves and applyMergeOutcome records the merge's own. */
  lastResult?: RunResult;
  lastSummary?: string;
  /** The summary a `queued` run reported for the change it pinned (the text its run_end
   * carries, high-friction annotation included), keyed by that change's sha. Held back from
   * `lastSummary` while the change waits, then paired with the merge's result by
   * applyMergeOutcome, which clears it — so after a merge the cell reads the merge's
   * outcome next to the summary of the change it merged, never next to the prior run's.
   * Persisted: the merge queue is durable, so the merge can resolve in a later process. */
  queuedSummary?: { sha: string; summary: string };
  lastRunStartedAt?: number;
  lastRunEndedAt?: number;
  /** True while a run is in flight (best-effort; cleared on orchestrator start). */
  running?: boolean;
  /** Epoch ms since the orchestrator reserved this runner but its run still waits in the
   * semaphore queue: it holds no maxConcurrent permit and runs no pi yet. Transient — set
   * by the orchestrator, cleared the moment the permit is granted (and defensively on run
   * outcome / orchestrator start) — and never persisted, so dashboards can render the
   * parked waiter as `awaiting slot` and keep the active-state rows equal to the real
   * permit holders (BUGS.md 2026-09-24). */
  parkedSince?: number;
  /** The provider key a parked waiter is queued on (plans/provider-concurrency.md §8), set
   * alongside `parkedSince` by the orchestrator and cleared the moment the permit is
   * granted — the key the admission lease will acquire. It lets the dashboards render
   * `awaiting omlx slot` instead of the bare `awaiting slot` when that key is at its cap.
   * Transient like `parkedSince` — never persisted — and absent for a team-total waiter
   * (no key) or the director (which never queues), so both render exactly as before. */
  parkedOn?: string;
  /** True when the last run was interrupted mid-task — aborted by a harness shutdown, or
   * truncated at the model's context ceiling — with its pi session (and any uncommitted
   * worktree edits, for shutdowns) left in place: the next run resumes that session
   * (--continue) instead of starting fresh. Consumed (cleared) by that run; set again only
   * by another interruption, so a failing resume falls back to a fresh start. */
  resumePending?: boolean;
  /** True when the run that set `resumePending` reported via `PiRunResult.resumeMissing`
   * that the backend no longer holds the session it tried to `--resume` (claude's "No
   * conversation found", or a pruned session). The transcript file the resume guard checks
   * can outlive the conversation — the fake leaves one, and a torn/empty file can — so the
   * next run must hand off on this verdict rather than trust `backendSessionResumable` and
   * re-resume a session that is gone (BUGS.md 2026-10-09). Set only alongside
   * `resumePending` and cleared with it at run start. */
  resumeMissing?: boolean;
  /** Why a pending resume happened when it was not a cut-off: "hung-tool" when the quiet
   * watchdog killed a run on a stalled tool call, so the bridge prompt names that cause (and
   * warns against re-running the hung command unchanged); "timeout" when the run deadline
   * fired on a run still making progress — a slow run, not a failed one — so the bridge asks
   * for the smallest finish against the same limit; "budget-resumed" when the budget gate
   * reopened and the in-flight fallback run was handed back to the primary model
   * (PLANS.md 2026-09-30); "rate-limit" when a subscription claude usage window rejected the
   * run, so the bridge names the held window rather than a restart (plans/agent-backends.md
   * part 6e); "budget-capped" when an API-billed claude run hit its per-run `--max-budget-usd`
   * cap, so the next run hands the kept worktree off to the fallback seam (part 7a/7);
   * "image-reroute" when an authoring run read an image its model cannot see and the next
   * run hands the kept worktree off to an image-capable peer tier (plans/image-input.md
   * part 4/5). Cleared with resumePending at run start; absent for restart/cut-off resumes,
   * whose causes are derived. */
  resumeCause?: "hung-tool" | "timeout" | "budget-resumed" | "rate-limit" | "budget-capped" | "image-reroute";
  /** Queue file holding the user prompt a resume-owning run re-queued: the interrupted pi
   * session still owns that request in its context, so the resume must reclaim exactly this
   * file as its own user prompt — the resume's fulfillment consumes it, and only its failure
   * paths re-queue it — instead of leaving the copy queued for a later fresh run to run the
   * same request twice. Cleared at every run's start; reclaimed only by a run that resumes. */
  resumePromptFile?: string;
  /** Epoch ms of the last operator wake (`tumwater wake`, or the auto-wake a queued
   * per-role prompt sends) that cleared this runner's schedule. Scheduling input, not
   * observation: isEligible exempts the role's min-run interval when the wake is newer
   * than the last run's end, so an explicit "try again now" brings a slow-clock runner
   * (qa, steward) in within one poll instead of waiting out the interval it ran inside
   * — the same exemption the director's inbox already grants user prompts. Self-clearing:
   * the next run's end re-stamps lastRunEndedAt past the wake, restoring the ordinary
   * gap without a separate erase. */
  wokenAt?: number;
  /** Consecutive runs that ended truncated at the context ceiling. Bounds cut-off resumes:
   * past the limit the runner abandons the runaway task and falls back to a fresh run. */
  cutOffStreak?: number;
  /** Consecutive runs ended by the quiet watchdog (`quiet_killed`). Bounds quiet-kill
   * resumes: while at or under the limit the runner resumes the starved session promptly,
   * past it the runner abandons the session and takes a fresh run on the idle ladder, so a
   * session the backend will not schedule cannot retry immediately forever (BUGS.md
   * 2026-09-18). Reset by any non-quiet-kill outcome. */
  quietKillStreak?: number;
  /** Consecutive failed runs: an `error`-result run OR one whose leftover recovery left a
   * merge pin behind (RunOutcome.recoveryFailure). While at or past the warning threshold
   * (run-apply.ts's ERROR_STREAK_WARN) the state cell reads "failing" instead of "sleeping",
   * and the crossing fires one warning event per episode (BUGS.md 2026-09-15: 44
   * identical run failures looked like a quiet team; BUGS.md 2026-09-21: a dead reviewer
   * backend left every recovery merge failing silently and reset this streak each run).
   * A review-rejected merge counts in too (BUGS.md 2026-09-30): the authoring run ends
   * `queued`, which preserves the streak, and applyMergeOutcome's rejected branch is the
   * accumulation point; a merged change resets it. Reset by any other completed result. */
  consecutiveErrors?: number;
  /** Consecutive completed runs that ended `no_change`. Observational only — the resting
   * state cell's ` · no change ×N` suffix (status-model.ts rolePhase) — so a runner that keeps
   * waking and returning nothing to do stops reading as an ordinary idle; a legitimately idle
   * maintenance runner with an empty backlog can hold a long streak and that is expected, so it
   * never warns (unlike consecutiveErrors/quietKillStreak). Reset by any completed result
   * other than `no_change`. Absent on states written before the field existed — reads as 0. */
  noChangeStreak?: number;
  /** Where in its cycle the runner was when it last persisted state: "review" means the
   * interruption hit during the review gate, so any uncommitted worktree edits are the
   * reviewer's stray output (discarded on resume), not author work. Set + saved around the
   * reviewer run; cleared at run end alongside `running`. */
  phase?: "pi" | "review";
  /** The most recent review-gate outcome for this runner: what was decided, why, and which
   * branch HEAD it covered. A reject's reasons are injected into the role's next run prompt
   * — every run starts a fresh session, so this is the only cross-run memory of what was
   * built and why it failed. */
  lastReview?: {
    verdict: string;
    reasons: string[];
    head?: string;
    at: number;
    /** Set on a rejection that used up the change's last revision round (plans/revise-
     * rejected.md): the rejected diff is gone, so the next prompt's rejected note says so and
     * no longer reads as an invitation to revise. Cleared implicitly on the next rejection,
     * which writes a fresh lastReview object. */
    exhausted?: boolean;
  };
  /** Branch HEAD that passed review most recently. Leftover commits at exactly this HEAD
   * merge without re-review (a merge_blocked retry must not burn another review run). */
  lastApprovedHead?: string;
  /** git/git.ts patchIds (the change's own lines, no context) of the diffs the reviewer approved,
   * oldest first, at most APPROVED_PATCH_IDS_MAX. A head carrying any of them (a rebase onto a
   * moved main, a requeue, a restart) reuses the approval: no second model review, though the
   * gate's build pre-check still runs. Cleared when the change merges or is finally rejected. */
  approvedPatchIds?: string[];
  /** Consecutive failed reviews of the SAME branch HEAD (reset when the reviewed HEAD
   * changes or a review succeeds). Past the limit the leftover is discarded with a warning,
   * so a misconfigured reviewer cannot wedge a runner re-reviewing one commit forever. */
  unreviewFailures?: number;
  /** The reviewer session a progressing-timeout review left for the next attempt: the
   * patch-id it was judging (only the same diff may resume), the per-run session directory to
   * `--continue` in, how many resumes have already been attempted, and when the marker was
   * written. Set when a review run hits its time budget while still making progress; cleared
   * by any verdict, any other failure, a discard, or a merge. Absent for a runner with no
   * timed-out review, so existing state files read unchanged. */
  reviewResume?: { patchId: string; sessionDir: string; attempts: number; at: number };
  /** Consecutive merges of the SAME pinned sha that ended `merge_conflict` — each one a failed
   * conflict-resolution run. Keyed by sha: a pin that rebased cleanly onto a moved main is a new
   * attempt and starts fresh. At MERGE_CONFLICT_LIMIT leftover recovery stops re-queuing: it
   * hands the pin back to its author to resolve (PLANS.md "Robust conflict landing, part 2/2"),
   * or discards it when that lineage was already handed back — either way an unmergeable change
   * cannot hold its role off authoring forever. */
  mergeConflicts?: { sha: string; count: number };
  /** The change leftover recovery discarded at MERGE_CONFLICT_LIMIT, named in the role's
   * prompts until its next change is queued — the author's only memory that the work is gone
   * and must be redone against current main if it is still wanted. */
  conflictDiscard?: { sha: string; summary: string; attempts: number; at: number };
  /** A change handed back to its author when its merges kept ending in unresolved merge
   * conflicts with main, or its revision re-apply conflicted (PLANS.md "Robust conflict
   * landing, part 2/2"): its sha, when, why, the revision round when the hand-back is a
   * revision, and whether the re-apply onto current main has happened yet. The author's next
   * non-resume run re-applies the sha with conflict markers left as ordinary uncommitted
   * edits, appends the hand-back note, and deletes the merge ref. The record then lives
   * exactly as long as the resolved change: while it is queued or pinned for its merge, a
   * conflict at the cap discards it rather than handing it back a second time. It is cleared
   * when that change merges or is rejected (run-apply.ts), and when a run neither commits the
   * marker edits nor leaves a session to resume them (no_change, a deliberate user_aborted, or
   * an error/quiet-kill with no resume), nor while a rejected change's revision still owes
   * them. Absent for a runner with no hand-back, so older state files read unchanged. */
  conflictHandback?: {
    sha: string;
    at: number;
    reason: "merge" | "revision";
    round?: number;
    applied: boolean;
  };
  /** This role's active model-fallback episode (src/runner/model-fallback.ts): set once
   * consecutive provider-class failures on the primary trip it, cleared by a probe run on
   * the primary that answers without a provider failure. Absent means the role runs its
   * primary model, so existing state files read unchanged. Persisted: an episode must survive
   * a restart like the schedule does. */
  modelFallback?: ModelFallbackState;
  /** The one-shot image-input reroute a blind-read run left for the next run
   * (plans/image-input.md "Rerunning on a model that can read images"): the target tier and
   * the resolved target seam (provider/model/thinking), plus `from` (the selector string of
   * the model the blind run was on) and `path` (the image file it read). The next run starts
   * directly on the target in a FRESH session over the kept worktree, never `--continue`;
   * the field is cleared at that run's start. Persisted like modelFallback (healed); absent
   * for a runner with no pending reroute, so older state files read unchanged. */
  imageReroute?: {
    tier: "small" | "default" | "strong";
    provider?: string;
    model?: string;
    thinking?: string;
    from?: string;
    path?: string;
  };
  /** True while the CURRENT run is an image-input reroute — it started on the image-capable
   * target (from a blind-read handoff or an attachment preflight) instead of the runner's own
   * tier. Read by the verdict's one-hop guard, which fails a blind read during a rerouted
   * run instead of rerouting it again. Transient: reset at every run start. */
  imageRerouteActive?: boolean;
  /** The pinned change a merge failed to review on a permanent provider configuration error
   * (a 4xx other than 408/429): the request can never succeed until the model config changes,
   * so leftover recovery holds the pin instead of re-queuing it at suite speed (BUGS.md
   * 2026-10-06). `selector` is the resolved reviewer selector that failed — when the runner's
   * current reviewer selector differs, the config has changed and recovery clears the hold and
   * re-queues. Cleared when the pin merges or is rejected. */
  mergeReviewError?: { sha: string; selector?: string; message: string };
  /** A `main_red` merge's kept pin, waiting for main to move: `head` is main's head when the
   * attempt settled and `entry` the dropped queue entry (minus its sha, which is the pin's
   * current one). The orchestrator poll re-queues it on the first poll whose main head differs
   * (merge-slot.ts requeueKeptChange) whose head is not cached red, or once
   * MAIN_RED_VERDICT_WAIT_MS has passed with no verdict; cleared then, or when the pin is gone.
   * `waitingSince` is the ms epoch of the first poll that saw main moved with no cached verdict
   * for its head. */
  mainRedRetry?: { head: string; entry: Omit<MergeEntry, "sha">; waitingSince?: number };
  /** Consecutive merges of one patch (git/git.ts patchId, stable across a clean rebase) whose
   * in-lock check went red on the rebased tree. At merge-check-failures.ts's
   * MERGE_CHECK_FAILURE_LIMIT the red is attributed through main's own verdict instead of
   * re-queued as merge_blocked again. `headline` is the failing test's headline, set only by a
   * red merge check (never by a cross-check block), so a retry that passes can be recorded as
   * a flake. */
  mergeCheckFailures?: { patchId: string; count: number; headline?: string };
  /** The normalized failure headline (normalizeClusterKey) that merge-check-failures.ts's
   * attributeRedCheck last excused as a known flake for this role's pinned change: the pin is
   * kept once per headline, and a repeat of the same headline is attributed. Cleared when the
   * change merges or is rejected. */
  mergeFlakeExcused?: string;
  /** Tokens the model generated in this runner's current or last completed run — a per-run
   * window (runner-run.ts resets it at run start), not a lifetime total. */
  generatedTokens: number;
  /** Largest single-request context of this runner's current or last completed run (per-run
   * window, reset at run start). */
  peakContextTokens: number;
  totalCostUsd: number;
  /** Local calendar day (YYYY-MM-DD) that `dayCostUsd` belongs to; a stale or missing stamp
   * reads as $0 today — spend before this field existed is unknown, and a run crossing local
   * midnight attributes its spend to the new day. See plans/daily-cost-budget.md. */
  dayStamp?: string;
  /** This runner's spend for `dayStamp`'s local day (the daily cost budget window). Deliberately
   * NOT zeroed by reset-counters: the budget is a safety valve, not an observation window. */
  dayCostUsd?: number;
  /** Real USD spent for `dayStamp`'s local day per model pair name (`modelPairName`): the
   * per-step spend a priced fallback step's own `maxDailyCostUsd` is checked against. Rolls
   * over with `dayCostUsd`; estimated (subscription) spend never folds in. */
  dayCostByPair?: Record<string, number>;
  lastError?: string;
  /** Epoch ms (Date.now()) of the last time this runner merged a change on main (set only in
   * applyMergeOutcome's `changed` branch, src/run/run-apply.ts). Absent until the first
   * merge, and absent on state files written before the field existed, so the last-merged
   * age reads "never" until then. Mirrors lastRunEndedAt: an observational timestamp that
   * reset-counters deliberately leaves alone — the dry-spell question it answers is about
   * merged work, not counters. */
  lastMergedAt?: number;
  /** The backlog entry this instance is assigned to implement or fix (plans/parallel-work-
   * instances.md "Claims", part 4/7): its file, the stamp-free key (backlog-eligibility.ts's
   * entryKey) that survives a done stamp or a Refused note, the verbatim heading at
   * assignment, when it was assigned, and whether the harness assigned it (`assigned`) or an
   * unassigned run moved it at staging (`staged`). Persisted with the runner's state, so a
   * crash, resume, revision or leftover recovery carries it with no extra store. Absent for a
   * runner with no claim, so existing state files read unchanged. */
  claim?: {
    file: "PLANS.md" | "BUGS.md";
    key: string;
    title: string;
    at: number;
    source: "assigned" | "staged";
  };
  /** Titles of the entries siblings hold while this instance runs unassigned (nothing free to
   * claim): set by the scheduling poll, read by the run prompt's exclusion note, so a primary
   * does not author an entry a sibling already holds. Cleared whenever the poll finds nothing
   * held or assigns a claim. */
  heldElsewhere?: string[];
  /** Why the scheduling poll last skipped this runner while it was due: set by the poll for an idle
   * extra instance with no free entry, the claim-group hold, or a need-based deferral, and
   * cleared when the poll admits the runner or finds it not due. Absent otherwise. */
  skipReason?: SkipReason;
  /** The rejected change this runner owes a revision to (plans/revise-rejected.md): its head, how
   * many revision rounds have been attempted, and when the rejection was recorded. Set at a gate
   * rejection that keeps revising; consumed when the revision stages, drops, or conflicts;
   * cleared when the rejected change is final (a repeated objection or the backstop, BUGS.md
   * 2026-10-14). `reasonCounts` holds each of that rejection's objections' persistence counts —
   * how many consecutive revisions each has survived — aligned with `lastReview.reasons`;
   * staging copies it onto the queued merge's PriorReview so the next rejection can resolve a
   * `(prior N)` tag to a count. Absent for a runner with no outstanding rejection, so existing
   * state files read unchanged (and an older file without `reasonCounts` reads as all-new). */
  revision?: { sha: string; round: number; at: number; reasonCounts?: number[] };
}

/** Why a due runner was skipped by the scheduling poll (RunnerState.skipReason). */
export type SkipReason = "no-free-entry" | "claim-hold" | "deferred-backlog" | "deferred-no-work" | "deferred-plans-full";

export const SKIP_REASONS: readonly string[] = [
  "no-free-entry",
  "claim-hold",
  "deferred-backlog",
  "deferred-no-work",
  "deferred-plans-full",
];

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
 * classifiers — once-round.ts's settleSkipped (which adds the disabled arm) and cli/cli-start.ts's
 * once-summary (which adds the team-pause arm) — so the two surfaces cannot drift on which
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
 * Both keep the instance bound to the same task, so the claim-release rule
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
 * the orchestrator's fresh-demand and plans-full stand-down tests
 * (orchestrator-scheduling.ts's hasDemand and its stand-down guard), so those surfaces cannot
 * drift on what counts as a fresh wake. */
export function freshlyWoken(s: RunnerState): boolean {
  return s.wokenAt !== undefined && s.wokenAt > (s.lastRunEndedAt ?? 0);
}
