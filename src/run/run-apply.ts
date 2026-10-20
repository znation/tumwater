// vocabulary: plain
import type { TumwaterConfig } from "../config/config-schema.js";
import type { MergeEntry } from "../merge/merge-queue.js";
import { hasOutstandingWork, type RunnerState } from "../runner/runner-state.js";
import { DIRECTOR_ROLE, OBSERVER_ROLES } from "../roles/roles.js";
import { baseRoleOf } from "../roles/runner-ids.js";
import {
  ERROR_BACKOFF,
  pushYieldOutcome,
  scheduleAtMinInterval,
  scheduleBackoff,
} from "../scheduling/backoff.js";
import type { RunOutcome, RunResult } from "./run-outcome.js";
import { firstReason } from "../text/phrases.js";

/** The state machine that applies a finished run or merge to the role's state: the
 * outcome application (applyRunOutcome — which outcomes count which streaks, when a
 * cut-off or quiet-killed session resumes and when it is abandoned), its merge sibling
 * (applyMergeOutcome), the error-streak thresholds, the resume limits, and the
 * review-verdict record the next run's prompt reads. Split out of run-outcome.ts — which
 * keeps the RunResult/RunOutcome vocabulary the dashboards and call sites share — because
 * "what an outcome is" and "what applying it records" are different concerns that happen to
 * touch the same RunnerState object. The role's CLOCK side of the same policy — the wake
 * semantics, the backoff ladders, the yield-scaled clock — lives next door in backoff.ts,
 * which this module drives. No I/O here: every function mutates the caller's state in place
 * (the caller's object is authoritative across an in-flight run and saves it itself), so
 * the policy is unit-testable without touching a disk. */

export function recordReview(s: RunnerState, verdict: string, reasons: string[], head?: string): void {
  s.lastReview = { verdict, reasons, ...(head === undefined ? {} : { head }), at: Date.now() };
}

/** Drop a stale review rejection once the change it objected to is superseded (BUGS.md
 * 2026-10-07): the review-exempt and refusal-note merges record no new verdict, so a reject
 * would otherwise ride every later run prompt as if it were the role's last review outcome.
 * Called from the points a change merges (`applyMergeOutcome`'s changed branch and
 * `handleRefusal`'s note merge), never while a revision is still owed: a merge that leaves
 * `state.revision` set — a per-role user-request run did not apply the rejected change — did
 * not resolve it, and its next revision run still needs the objections (runner-run.ts's revision
 * note). A model-reviewed merge already overwrote `lastReview` with its approve; this only
 * clears a standing `reject`. */
export function clearSupersededRejection(s: RunnerState): void {
  if (s.revision === undefined && (s.lastReview?.verdict === "reject" || s.lastReview?.verdict === "reverted")) s.lastReview = undefined;
}

/** Consecutive failed runs after which the role raises a harness warning and its state
 * cell reads "failing" (BUGS.md 2026-09-15: every role failing identically looked like a
 * quiet team). Small on purpose — at 3 the error ladder has already doubled twice and
 * the failure is clearly not transient. */
export const ERROR_STREAK_WARN = 3;

/** Consecutive failed runs after which the error-streak circuit breaker (src/gates/streak-gate.ts)
 * auto-pauses the role through the per-role pause marker — the same act-on-it escalation the
 * budget gate and the pause gates perform, applied to a role failing on its own cause. Ten,
 * not the warn bar: at 3 the failure is diagnosed but possibly transient, and by run 4 the
 * error ladder has already doubled to its 10-minute rung, so 10 consecutive failures is 45+
 * minutes of a role failing on the slowest rung — long enough to ride out genuine transience,
 * short enough to stop the burn well before an all-day failure. One sensible default, no knob. */
export const ERROR_STREAK_BREAKER = 10;

/** Resumes granted to one context-ceiling cut-off streak before the role stops resuming the
 * task and falls back to a fresh run: a task that outruns the ceiling on every attempt (even
 * from a freshly compacted context) is too big to converge, and each cycle costs an hour-plus
 * of model time on local hardware. The streak itself keeps counting (RunnerState.cutOffStreak). */
const CUT_OFF_RESUME_LIMIT = 3;

/** Resumes granted to one quiet-kill streak before the role abandons the starved pi session
 * and takes a fresh run on the idle ladder. A session the backend defers past the quiet
 * watchdog every attempt would otherwise re-send the same input immediately and forever,
 * burning an hour of slot time per retry with no output (BUGS.md 2026-09-18: 41 quiet kills
 * consumed 44% of the team over two days). Mirrors CUT_OFF_RESUME_LIMIT; the streak itself
 * keeps counting (RunnerState.quietKillStreak) so one warning per episode can be raised. */
export const QUIET_KILL_RESUME_LIMIT = 3;

/** Record a finished run on the role's state and schedule its next run from the outcome.
 * Split out of RoleRunner.run() (runner.ts) so the scheduling policy — which outcomes retry
 * promptly, which back off and on which ladder, how cut-off resumes are bounded — sits with
 * the other scheduling helpers here instead of inline in the run lifecycle. Mutates `s` in place:
 * the caller's state object is authoritative across an in-flight run (see resetCounters).
 * `cfg` is the role-resolved config (configForRole): its minRunIntervalSeconds carries any
 * per-role slow clock, and idleBackoff passes through it unchanged from the top level. */
export function applyRunOutcome(
  s: RunnerState,
  cfg: TumwaterConfig,
  role: string,
  outcome: RunOutcome,
): void {
  s.running = false;
  s.parkedSince = undefined;
  s.parkedOn = undefined;
  // The cut-off streak counts EVERY consecutive run truncated at the context ceiling, past the
  // resume limit too: the next fresh run's prompt names how many attempts the window has eaten
  // (buildCutOffNote), so the count must not freeze at the limit. Any other outcome resets it.
  s.cutOffStreak = outcome.cutOff ? (s.cutOffStreak ?? 0) + 1 : 0;
  // The error streak counts consecutive failed runs; any other result resets it
  // (BUGS.md 2026-09-15: 44 identical failures raised no alarm). A run whose leftover
  // recovery re-queued a pin its last merge failed counts too, even though the run
  // itself ends `queued` (outcome.recoveryFailure): a dead reviewer backend would otherwise
  // reset the streak every run and never raise the alarm (BUGS.md 2026-09-21).
  // run-finalize.ts emits one warning when the streak crosses ERROR_STREAK_WARN — once per
  // episode, since the reset re-arms it — and the dashboards read "failing" from the same field.
  // A plain `queued` run is not yet a verdict about anything: it committed and enqueued, and
  // its MERGE resolves the streak — applyMergeOutcome resets it when the change merges and
  // counts a review rejection into it (BUGS.md 2026-09-30: review-rejected authoring, the
  // digest's #1 loss cause, fell straight through — the run's `queued` reset and the merge's
  // `rejected` increment met nowhere, so the streak read 0 through the whole episode and the
  // re-author ran at min interval, warning-free and pause-proof). Resetting here would pin a
  // rejection streak at 1 forever, since every authoring run in a rejection episode ends
  // `queued` before its merge is decided.
  const failed = outcome.result === "error" || outcome.recoveryFailure !== undefined;
  if (failed) s.consecutiveErrors = (s.consecutiveErrors ?? 0) + 1;
  else if (outcome.result !== "queued") s.consecutiveErrors = 0;
  // The quiet-kill streak counts consecutive watchdog kills; any other result resets it.
  // run-finalize.ts warns once when it crosses QUIET_KILL_RESUME_LIMIT, and the branch below uses
  // it to bound how many times a starved session is resumed (BUGS.md 2026-09-18).
  s.quietKillStreak = outcome.result === "quiet_killed" ? (s.quietKillStreak ?? 0) + 1 : 0;
  // The no-change streak counts consecutive completed runs that ended `no_change` (the
  // resting state cell's ` · no change ×N` suffix — status-model.ts rolePhase). Any other
  // completed result resets it, so a role that merges between no-ops never shows a stale
  // streak. Every completed result reaches this block (run-finalize.ts calls
  // applyRunOutcome for every outcome), so `changed`/`queued`/`error`/`aborted`/
  // `quiet_killed`/`user_aborted` all reset it and only a `no_change` run grows it.
  // Observational only — never warns, unlike the error/quiet-kill streaks: a legitimately
  // idle maintenance role with an empty backlog can hold a long streak and that is expected.
  s.noChangeStreak = outcome.result === "no_change" ? (s.noChangeStreak ?? 0) + 1 : 0;
  // The yield ring records the result beside the streaks: a merge or a counted empty
  // stretches the role's min-run gap (yieldMultiplier, read by isEligible), an error-class
  // result is skipped entirely — no evidence either way (yield-scaled clocks, PLANS.md).
  pushYieldOutcome(s, outcome.result);
  // The review gate persists phase="review" around its run so a dashboard mid-review shows
  // "reviewing". A completed run clears it so the label never lingers — except an aborted
  // one: there the interruption hit mid-review, and the next launch must recover (and
  // re-review) the committed work fresh instead of resuming an author session whose task is
  // already committed.
  if (outcome.result !== "aborted") s.phase = undefined;
  s.lastRunEndedAt = Date.now();
  // `lastResult`/`lastSummary` are the last COMPLETED result, the pair the dashboards' "last
  // result" cell renders, and they must describe ONE run: a completed outcome without a
  // summary CLEARS `lastSummary`, so a summary-less result never renders beside another
  // run's work description (BUGS.md 2026-09-30: a no_change run read "No change — Implement
  // the … plan" beside work that had merged, because the prior summary was retained).
  // A `queued` run is not a completed result: its change is committed but in flight —
  // the state column shows that (`merge <elapsed>`, the merge-queue badge) — so the pair
  // keeps the prior outcome WITH its own summary while the change waits (BUGS.md 2026-09-23),
  // and the run's summary is stashed under the pinned sha for applyMergeOutcome to pair with
  // the merge's result. Every other outcome is completed and clears the stash: a role with a
  // queued or in-flight merge never runs (the orchestrator's interlock), so a stash that
  // survives to a later run names a change that is no longer waiting.
  if (outcome.result === "queued") {
    s.queuedSummary =
      outcome.commit && outcome.summary ? { sha: outcome.commit, summary: outcome.summary } : undefined;
  } else {
    s.queuedSummary = undefined;
    s.lastResult = outcome.result;
    s.lastSummary = outcome.summary; // a summary-less outcome wipes the prior run's text
  }
  if (outcome.result === "changed" || outcome.result === "queued") {
    // "queued" schedules exactly like "changed" — the run committed and enqueued — but the
    // commit count waits for the merge: `commits` keeps meaning "merged to main", and
    // applyMergeOutcome increments it when the change actually merges. The phase-clear above
    // (`result !== "aborted"`) covers both.
    if (outcome.result === "changed") s.commits += 1;
    // A merged change's patch-id approval has done its job: the same patch authored again
    // later (after a revert, say) is a new change and gets its own review.
    if (outcome.result === "changed") s.approvedPatchIds = undefined;
    // The role committed new work, so the note about its discarded change has been delivered.
    s.conflictDiscard = undefined;
    s.backoffSeconds = 0;
    scheduleAtMinInterval(s, cfg);
  } else if (outcome.result === "rejected") {
    // The reviewer objected and the gate already reset the branch: the author should address
    // the recorded reasons on its next eligible run, not sleep through them — schedule like
    // a change without counting a commit (nothing merged).
    s.backoffSeconds = 0;
    scheduleAtMinInterval(s, cfg);
  } else if (outcome.result === "skipped") {
    // Director idles until the inbox has work; no backoff bookkeeping.
    scheduleAtMinInterval(s, cfg);
  } else if (outcome.result === "aborted") {
    // Shutdown, not a verdict about the project: resume promptly on restart. The pi
    // session and the worktree's uncommitted edits were left in place, so the next run
    // picks up exactly where this one was interrupted (director runs instead re-queue
    // their user prompt, which runs fresh).
    if (role !== DIRECTOR_ROLE) {
      s.resumePending = true;
      // A budget handback names its own cause (the bridge prompt must say the model moved,
      // not that the harness restarted); a plain shutdown's stays derived.
      if (outcome.resumeCause) s.resumeCause = outcome.resumeCause;
    }
    s.nextRunAt = Date.now();
  } else if (outcome.result === "quiet_killed") {
    // A hung tool call, not an idle verdict or a shutdown: the kill left the pi session and
    // the worktree's uncommitted edits intact, so resume them promptly like an interruption.
    // The cause is named in state so the bridge prompt tells the resumed session its run died
    // on a stalled tool call (director runs never resume — their prompt was re-queued fresh).
    // Bounded like a cut-off streak: past QUIET_KILL_RESUME_LIMIT the session is
    // abandoned — the backend has refused to schedule it every attempt, so re-sending it only
    // starves the slot again — and the role takes a fresh run on the idle ladder instead
    // (BUGS.md 2026-09-18).
    if (role !== DIRECTOR_ROLE && s.quietKillStreak <= QUIET_KILL_RESUME_LIMIT) {
      s.resumePending = true;
      s.resumeCause = outcome.resumeCause ?? "hung-tool";
      s.nextRunAt = Date.now();
    } else if (role !== DIRECTOR_ROLE) {
      s.resumePending = false;
      s.resumeCause = undefined;
      scheduleBackoff(s, cfg.idleBackoff);
    } else {
      s.nextRunAt = Date.now();
    }
  } else if (outcome.result === "user_aborted") {
    // A deliberate stop, not an interruption: the worktree was already reset to main and a
    // director prompt deliberately dropped, so there is nothing to resume — schedule like an
    // unproductive run (idle backoff) instead of resuming promptly. phase is cleared by the
    // `result !== "aborted"` check above.
    scheduleBackoff(s, cfg.idleBackoff);
  } else if (outcome.result === "error") {
    // A failed run, not an idle verdict: it often never reached the model, so it retries on
    // the short error ladder (capped in minutes) instead of the idle ladder, whose cap prices
    // hour-long model runs. backoffSeconds is shared: each ladder advances from the current
    // value, so an error streak capped at the error ceiling never sleeps LESS than the role
    // already was sleeping, and the idle ladder picks up from there if the failures stop.
    // A subscription claude usage-window rejection is a transient hold, not a failure of the
    // session: the team hold keeps runs from starting until `resetsAt` (plans/agent-backends.md
    // §8, part 6c), and the kept session and worktree edits resume when it lifts (part 6e).
    // The named cause is what the bridge prompt reads, so it does not tell the session the
    // harness merely restarted.
    if (outcome.resumeCause === "rate-limit" && role !== DIRECTOR_ROLE) {
      s.resumePending = true;
      s.resumeCause = "rate-limit";
    }
    scheduleBackoff(s, ERROR_BACKOFF);
  } else if (outcome.cutOff && role !== DIRECTOR_ROLE && s.cutOffStreak <= CUT_OFF_RESUME_LIMIT) {
    // Truncated at the context ceiling, not idle: the hour(s) of work survive in the
    // session pi just compacted, so resume it promptly instead of idle-backing-off.
    // Each resume restarts from the compacted (small) context, so repeated cut-offs on
    // one task still converge — but a task that outruns the ceiling every single time
    // would cycle forever, so after CUT_OFF_RESUME_LIMIT resumes the role gives up on it
    // and falls back to a fresh run with normal backoff (its prompt carrying the streak).
    s.resumePending = true;
    scheduleAtMinInterval(s, cfg);
  } else if (OBSERVER_ROLES.has(baseRoleOf(role))) {
    // An observer's no_change is a success ("checked, all well"), not an idle verdict: it must
    // not climb the idle ladder, which would punish the role monotonically for the product
    // being healthy. With no ladder, minRunIntervalSeconds is the sole, honest cadence
    // (plans/observer-roles.md). The error/user_aborted arms above are untouched — a broken
    // toolchain and a deliberate operator stop still back off like any other role.
    s.backoffSeconds = 0;
    scheduleAtMinInterval(s, cfg);
  } else {
    scheduleBackoff(s, cfg.idleBackoff);
  }
  // A hand-back's marker-bearing edits ARE the resolution its author owes, so the record lives
  // only while that resolution is still in play: a `queued` run committed it, a pending
  // `revision` still owes it, and a resumable session still holds the edits. Every other
  // outcome abandons them (the next fresh run resets the worktree to main), so the hand-back
  // is spent: clear the record, or it would make a later change's cap conflict discard the
  // pin instead of handing it back (PLANS.md "Robust conflict landing, part 2/2"). `changed`
  // clears too — the resolved change merged in-run, so its life is over. This runs after the
  // resume branches above have set `resumePending`.
  if (
    s.conflictHandback &&
    outcome.result !== "queued" &&
    !hasOutstandingWork(s)
  ) {
    s.conflictHandback = undefined;
  }
}

/** Record a completed MERGE on the authoring role's state (plans/merge-queue.md 3/5):
 * the orchestrator calls this on the state object the merge ran against — the runner's live
 * copy when one exists, a disk load otherwise — then saves it, the same in-place discipline
 * applyRunOutcome has (the caller's state object is authoritative; a role with a queued or
 * in-flight merge never runs, so no other writer holds it meanwhile). Sets `lastResult`
 * to the merger's outcome, increments `commits` only on a success (the "merged to main"
 * counter applyRunOutcome's "queued" branch left to the merge), and clears `phase` — the
 * gate persisted `phase = "review"` on this same state object during the run, exactly as it
 * did inside a run, so the label must not linger past the merge (mirroring
 * applyRunOutcome's rule: every outcome except "aborted" clears it — an aborted merge
 * keeps it, because the interruption hit mid-review and the next launch must recover and
 * re-review the pinned work). `lastSummary` becomes the summary of the change this merge
 * resolved — `change` is its merge-queue entry — so the merge's result, success or failure,
 * reads beside the work it names (BUGS.md 2026-09-23: the queued run held its summary back
 * rather than pair it with the prior result). The run's stashed `queuedSummary` wins when it
 * names this sha: it is the text the run reported, high-friction annotation included. The
 * entry's own summary (the commit subject) covers a stash that is missing or names another
 * change — a crash between enqueue and the run's state save, or a merge that finished before
 * its run's outcome was applied. Either way the stash is consumed. The failure detail rides
 * in `lastReview` and the merge_done/merge_failed events. */
export function applyMergeOutcome(
  s: RunnerState,
  result: RunResult,
  change: Pick<MergeEntry, "sha" | "summary">,
): void {
  s.lastResult = result;
  s.lastSummary = s.queuedSummary?.sha === change.sha ? s.queuedSummary.summary : change.summary;
  s.queuedSummary = undefined;
  if (result === "changed") {
    s.commits += 1;
    // The last-merged timestamp: set only on a successful merge, so the rendered age means
    // "time since the role last actually merged to main" — a rejected/merge_conflict/aborted
    // merge, like a no_change run, leaves the prior value standing (PLANS.md "Each loop's
    // last-landed age").
    s.lastMergedAt = Date.now();
    s.approvedPatchIds = undefined; // see applyRunOutcome
    // A merge supersedes a stale rejection: a model-reviewed merge has already overwritten
    // lastReview with its approve, but a review-exempt (or review-disabled) merge records no
    // verdict, so a stale reject would otherwise ride every later run prompt (BUGS.md
    // 2026-10-07). Cleared only with no revision pending — see clearSupersededRejection.
    clearSupersededRejection(s);
    // A merged change resets the error streak exactly as an error-free run does (BUGS.md
    // 2026-09-30): the queued run that authored it preserved the streak — a rejection counts
    // into it below — so the merge, the episode's only clean verdict, ends it.
    s.consecutiveErrors = 0;
  }
  if (result === "rejected") {
    // A review rejection is a failure the streak must count ONLY when it is final (BUGS.md
    // 2026-10-14): recordRejectedChange (src/merge/merge-core.ts) already decided finality
    // by the time this runs — it sets `state.revision` when the change goes back for another
    // round and clears it when the chain is exhausted (or never sets it for a role that cannot
    // revise, the director). A rejection that leaves a revision to work on is not a verdict
    // about the author yet: counting every round of ONE change made an exhausted chain's third
    // round cross the warn bar and flash a red "failing run after run" alert that needed
    // nothing from the operator and was gone before it could be read (0–30 s). Counting only
    // final rejections makes a streak of 3 mean three changes ended rejected (or errored) —
    // the non-converging author the 2026-09-30 fix meant to catch — while a chain's rounds
    // leave the streak unchanged and keep the fast minimum-interval retry the queued run
    // scheduled. This merge outcome is the accumulation point (the authoring run ends
    // `queued`, which no longer resets the streak, see applyRunOutcome) — the same field the
    // warn, the breaker (src/gates/streak-gate.ts), and the error-storm observation
    // (src/team/team-polls.ts) already read. No new machinery, no new constants: the warn
    // bar and the breaker bar are ERROR_STREAK_WARN and ERROR_STREAK_BREAKER themselves.
    if (s.revision === undefined) {
      s.approvedPatchIds = undefined; // the chain ended: nothing queued is still approved
      s.consecutiveErrors = (s.consecutiveErrors ?? 0) + 1;
      const lastReasons = s.lastReview?.verdict === "reject" || s.lastReview?.verdict === "reverted" ? s.lastReview.reasons : undefined;
      s.lastError = `review rejected: ${firstReason(lastReasons).slice(0, 200)}`;
    // Past the warn bar the re-author backs off on the error ladder instead of the minimum
    // interval the queued run scheduled: the fast first retries stay — the rejected branch's
    // design intent, letting the author address the recorded reasons at once — but a
    // non-converging author slows down instead of re-authoring at full price all day. The
    // rung derives from the streak (not from backoffSeconds, which every queued run zeroes
    // on its way out, pinning a state-derived ladder at its first rung), and never pulls
    // nextRunAt earlier than the already-scheduled minimum interval.
      const streak = s.consecutiveErrors;
      if (streak >= ERROR_STREAK_WARN) {
        const rung = Math.min(
          ERROR_BACKOFF.initialSeconds * 2 ** (streak - ERROR_STREAK_WARN),
          ERROR_BACKOFF.maxSeconds,
        );
        s.backoffSeconds = rung;
        s.nextRunAt = Math.max(s.nextRunAt ?? 0, Date.now() + rung * 1000);
      }
    }
  }
  // A merge or a rejection is the end of the change's life; a merge_conflict keeps its pin.
  // The per-change markers below all clear on this one outcome set, so name it once.
  const changeGone = result === "changed" || result === "rejected";
  // The conflict streak counts failed resolutions of one pinned sha; a merge or a rejection
  // ends that pin's life. Every other outcome kept the pin as it was, so its count stands.
  if (result === "merge_conflict") {
    const prior = s.mergeConflicts?.sha === change.sha ? s.mergeConflicts.count : 0;
    s.mergeConflicts = { sha: change.sha, count: prior + 1 };
  } else if (changeGone) {
    s.mergeConflicts = undefined;
  }
  // Likewise the red-merge-check streak (keyed by patch-id): its change is gone either way.
  if (changeGone) {
    s.mergeCheckFailures = undefined;
    s.mergeFlakeExcused = undefined;
  }
  // A permanent-reviewer-config hold ends with its pin's life: merged, or rejected away.
  if (changeGone) s.mergeReviewError = undefined;
  // A hand-back ends with its change's life too: once the resolved change merges or is rejected,
  // a later change gets its own one-hand-back budget (PLANS.md "Robust conflict landing, part
  // 2/2"). A merge_conflict keeps it, so the resolved change's own cap discard fires.
  if (changeGone) s.conflictHandback = undefined;
  if (result !== "aborted") s.phase = undefined;
}

/** @deprecated Use applyRunOutcome. */
export const applyTickOutcome = applyRunOutcome;
