import type { BackoffConfig, TumwaterConfig } from "./config-schema.js";
import type { LandingEntry } from "./landing-queue.js";
import type { LoopState } from "./loop-state.js";
import { DIRECTOR_ROLE, OBSERVER_ROLES } from "./roles.js";

/** The per-loop scheduling POLICY for finished work and operator demands: what a finished tick
 * or landing does to the loop's clock — which outcomes retry promptly, which back off and on
 * which ladder, how cut-off and quiet-kill resume streaks are bounded — plus the wake
 * semantics (clearBackoff, restoreMidTickWake), the backoff ladder arithmetic, and the
 * review-verdict record the next tick's prompt reads. Split out of loop-state.ts — which keeps the
 * persisted state file's load/save and the observation-window counter reset — because
 * persistence and policy are different concerns that happen to touch the same LoopState
 * object: this module holds the rules for MUTATING that state, loop-state.ts the rules for keeping
 * it on disk. No I/O here: every function mutates the caller's state in place (the caller's
 * object is authoritative across an in-flight tick and saves it itself), so the policy is
 * unit-testable without touching a disk. The tick's result and outcome types (TickResult,
 * TickOutcome) live here too, beside the policy that schedules on them — moved out of the
 * types.ts grab-bag, as LoopState and HarnessEvent were before it. */

export type TickResult =
  | "changed" // a landing completed: the change is merged to main
  | "queued" // the tick's change is committed and pinned; the orchestrator's landing slot will pick it up from the durable land queue (plans/merge-queue.md 3/5) — the commit count and final outcome are recorded when the landing completes; never stored as `lastResult`, which keeps the last completed outcome
  | "refused" // pi declined the work (TUMWATER_REFUSED); only its markdown objection note landed
  | "no_change" // pi decided there was nothing to do
  | "merge_conflict" // change was made but could not be merged; the pin is re-queued next tick, and discarded after MERGE_CONFLICT_LIMIT in a row
  | "merge_blocked" // fast-forward into main failed (e.g. dirty primary checkout)
  | "rejected" // the review gate rejected the change; branch reset, reasons recorded
  | "review_error" // the review gate failed (no parseable verdict); commit left for retry
  | "error" // pi errored or timed out
  | "aborted" // harness shutdown killed the run mid-tick; partial work discarded
  | "quiet_killed" // the quiet watchdog killed a stalled tool call mid-run; session + worktree edits preserved and resumed promptly
  | "user_aborted" // a user-initiated abort (tumwater abort) killed the run mid-tick; work discarded, loop backed off
  | "main_red" // main's build/test suite is red: a tick's baseline check skipped the authoring run, or a landing's check failed on a red main (pin kept, no strike)
  | "skipped"; // nothing to run (e.g. director with an empty inbox);

/** The outcome of one full tick: its result plus what the harness learned from it.
 * Consumed by the orchestrator's dashboards and by this module's post-tick scheduling
 * (applyTickOutcome). */
export interface TickOutcome {
  result: TickResult;
  summary?: string;
  commit?: string;
  /** The tick's authoring run burned more than the configured thrashTurns turns AND thrashMinutes
   * (plans/refusal-and-thrash.md): difficulty is a signal, so the change went to
   * review flagged and a warning event was logged. */
  highFriction?: boolean;
  /** The run was truncated at the model's context ceiling before it could finish (a
   * no_change tick whose final message carried no text or tool call). The work so far
   * survives in the pi session, which pi compacted at end of run — so the loop resumes
   * it promptly instead of backing off as if the role were idle. */
  cutOff?: boolean;
  /** The tick's leftover recovery re-queued a pin whose last landing failed and kept it for
   * another attempt (review_error, merge_conflict, merge_blocked): the tick itself ends
   * `queued`, but the persistent landing failure must still feed the error streak so a dead
   * reviewer backend raises the alarm instead of resetting it every tick (BUGS.md 2026-09-21).
   * Carries the failure detail for the warning: `lastError` is deliberately cleared off the tick
   * so the failure never rides its `tick_end` (the sibling mislabel fix). */
  recoveryFailure?: string;
  /** The outcome's own cause, written deliberately for this result — never a leftover landing
   * failure (those ride `state.lastError` and the recoveryFailure field above). Set by the
   * red-main baseline gate (src/main-red.ts) so the tick's `tick_end` names what broke: the
   * failure digest's error clusters include main_red ticks, and without a cause on the event
   * the Outcome table's main_red cells would read as a bare count (BUGS.md 2026-09-28). */
  error?: string;
  /** Why a resumed session's bridge prompt names its cause, when the resume's result itself is
   * not specific enough to derive it: a quiet_killed tick can be a hung tool call (the default
   * "hung-tool" bridge) or a tick timeout that fired on a run still making progress (a
   * "timeout" bridge, which asks for the smallest finish against the same limit). Set only by
   * those outcomes; every other resume cause is derived from state (cut-off streak, restart). */
  resumeCause?: "hung-tool" | "timeout";
  /** The tick ended on leftover recovery (src/leftover.ts) — the leftover went on the land queue
   * (or already was there, or could not be pinned) — without an authoring run. No model ran, so
   * the orchestrator's fallback breaker takes the tick as no evidence about the backend. */
  recoveredLeftover?: boolean;
}

/** Clear a loop's backoff so its next orchestrator poll finds it immediately due: zero
 * backoffSeconds (so the next no_change/error tick restarts the backoff ladder from the
 * bottom instead of climbing from wherever the fleet parked) and pull nextRunAt forward to
 * now. Pure: returns a new state and preserves everything else — counters (an
 * observation-window reset is zeroCounters' job), wake tracking (lastMainHead), and the
 * last-result fields. Scheduling operation, not observation-window reset: it exists so an
 * operator who fixed what the loops were failing on can say "try again" (BUGS.md
 * 2026-09-15: the fleet had no wake lever). Also stamps wokenAt, which is what lets
 * isEligible honor the demand over the role's min-tick interval (LoopState.wokenAt). */
export function clearBackoff(s: LoopState, now: number): LoopState {
  // wokenAt marks the wake as newer than the current gap window's opening tick, which is
  // what lets isEligible honor the demand over the min-tick interval (LoopState.wokenAt):
  // without it a loop that ticked inside its own slow clock stays asleep for the rest of
  // the interval and both `tumwater wake` and a queued per-role prompt silently do nothing.
  return { ...s, backoffSeconds: 0, nextRunAt: now, wokenAt: now };
}

/** Re-apply a wake that was consumed while the just-ended tick was still in flight. The tick
 * holds the same state object wake() mutated in place, but applyTickOutcome's own schedule
 * overwrites the wake: lastTickEndedAt is re-stamped past wokenAt (so the min-gap exemption
 * reads stale) and nextRunAt is scheduled a fresh gap or backoff out — the operator's "try
 * again now" silently waits out the whole interval. Called by the tick's end-save after
 * applyTickOutcome, it re-applies the demand exactly like a wake arriving one poll after the
 * tick ended: backoff cleared, nextRunAt now, wokenAt re-armed past the new gap window's
 * opening. Returns whether a mid-tick wake was found. Two cases deliberately do not restore:
 * a wake older than the tick's start was already honored by the tick that just ran (the
 * ordinary self-clearing must hold), and a cut-off/aborted outcome's `resumePending` — the
 * next run deliberately waits one interval from the compacted context, and a mid-tick wake
 * must not shortcut that wait. */
export function restoreMidTickWake(s: LoopState): boolean {
  if (s.resumePending) return false;
  if (s.wokenAt === undefined || s.wokenAt <= (s.lastTickStartedAt ?? 0)) return false;
  // clearBackoff stamps wokenAt = now, which must read NEWER than the end-save's
  // lastTickEndedAt for isEligible's exemption to fire — both are Date.now() reads, so a
  // same-millisecond tie would swallow the demand; floor it just past the end stamp.
  Object.assign(s, clearBackoff(s, Math.max(Date.now(), (s.lastTickEndedAt ?? 0) + 1)));
  return true;
}

/** Record the review gate's verdict on a HEAD into `lastReview` — the field the author's next
 * tick prompt injects (tick-prompt.ts's buildRejectedReviewNote) and the same-head strike
 * counter reads (review.ts's unreviewFailures). Mutates `s` in place; the timestamp is
 * stamped here so every call site shares one Date.now() read and the shape stays in one place
 * (loop-state.ts's lastReview). */
export function recordReview(s: LoopState, verdict: string, reasons: string[], head?: string): void {
  s.lastReview = { verdict, reasons, ...(head === undefined ? {} : { head }), at: Date.now() };
}

/** Next step of a backoff ladder: initial (capped) on the first step, then multiplied, capped. */
export function nextBackoffSeconds(current: number, ladder: BackoffConfig): number {
  const { initialSeconds, factor, maxSeconds } = ladder;
  if (current <= 0) return Math.min(initialSeconds, maxSeconds);
  return Math.min(current * factor, maxSeconds);
}

/** Advance the loop's shared backoffSeconds on `ladder` and schedule its next tick after it.
 * Every backing-off outcome (an unproductive tick, a failed one, a deliberate stop, and the
 * quiet-kill fallback) funnels through here, so the seconds→ms conversion and the rule that
 * each ladder advances from the current value apply identically in all four arms. */
function scheduleBackoff(s: LoopState, ladder: BackoffConfig): void {
  s.backoffSeconds = nextBackoffSeconds(s.backoffSeconds, ladder);
  s.nextRunAt = Date.now() + s.backoffSeconds * 1000;
}

/** Schedule the loop's next tick at its minimum interval — the role-resolved config's
 * minTickIntervalSeconds (a per-role slow clock), converted seconds→ms here so every outcome
 * arm that shares this cadence cannot drift apart. The productive-side counterpart of
 * scheduleBackoff: together the two own the whole "when does this loop run again" decision. */
function scheduleAtMinInterval(s: LoopState, cfg: TumwaterConfig): void {
  s.nextRunAt = Date.now() + cfg.minTickIntervalSeconds * 1000;
}

/** Backoff ladder for failed ticks (`error` results). The idle ladder prices hour-long model
 * runs — its cap exists so a loop that keeps finding nothing stops burning model time. A tick
 * that fails (a broken toolchain, a dead pi subprocess) often never reaches the model, so it
 * climbs this short ladder, capped in minutes: one broken `git` must not park a fleet for the
 * idle ladder's 10-hour sleep (BUGS.md, the 2026-09-15 outage). One ladder, one sensible
 * default, no knob: the cap is the point. */
const ERROR_BACKOFF: BackoffConfig = { initialSeconds: 30, factor: 2, maxSeconds: 600 };

/** Consecutive failed ticks after which the loop raises a harness warning and its state
 * cell reads "failing" (BUGS.md 2026-09-15: every loop failing identically looked like a
 * quiet fleet). Small on purpose — at 3 the error ladder has already doubled twice and
 * the failure is clearly not transient. */
export const ERROR_STREAK_WARN = 3;

/** Resumes granted to one context-ceiling cut-off streak before the loop stops resuming the
 * task and falls back to a fresh tick: a task that outruns the ceiling on every attempt (even
 * from a freshly compacted context) is too big to converge, and each cycle costs an hour-plus
 * of model time on local hardware. The streak itself keeps counting (LoopState.cutOffStreak). */
const CUT_OFF_RESUME_LIMIT = 3;

/** Resumes granted to one quiet-kill streak before the loop abandons the starved pi session
 * and takes a fresh tick on the idle ladder. A session the backend defers past the quiet
 * watchdog every attempt would otherwise re-send the same input immediately and forever,
 * burning an hour of slot time per retry with no output (BUGS.md 2026-09-18: 41 quiet kills
 * consumed 44% of the fleet over two days). Mirrors CUT_OFF_RESUME_LIMIT; the streak itself
 * keeps counting (LoopState.quietKillStreak) so one warning per episode can be raised. */
export const QUIET_KILL_RESUME_LIMIT = 3;

/** Record a finished tick on the loop's state and schedule its next run from the outcome.
 * Split out of LoopRunner.tick() (loop.ts) so the scheduling policy — which outcomes retry
 * promptly, which back off and on which ladder, how cut-off resumes are bounded — sits with
 * the other scheduling helpers here instead of inline in the tick lifecycle. Mutates `s` in place:
 * the caller's state object is authoritative across an in-flight tick (see resetCounters).
 * `cfg` is the role-resolved config (configForRole): its minTickIntervalSeconds carries any
 * per-role slow clock, and idleBackoff passes through it unchanged from the top level. */
export function applyTickOutcome(
  s: LoopState,
  cfg: TumwaterConfig,
  role: string,
  outcome: TickOutcome,
): void {
  s.running = false;
  s.parkedSince = undefined;
  // The cut-off streak counts EVERY consecutive tick truncated at the context ceiling, past the
  // resume limit too: the next fresh tick's prompt names how many attempts the window has eaten
  // (buildCutOffNote), so the count must not freeze at the limit. Any other outcome resets it.
  s.cutOffStreak = outcome.cutOff ? (s.cutOffStreak ?? 0) + 1 : 0;
  // The error streak counts consecutive failed ticks; any other result resets it
  // (BUGS.md 2026-09-15: 44 identical failures raised no alarm). A tick whose leftover
  // recovery re-queued a pin its last landing failed to land counts too, even though the tick
  // itself ends `queued` (outcome.recoveryFailure): a dead reviewer backend would otherwise
  // reset the streak every tick and never raise the alarm (BUGS.md 2026-09-21). loop.ts emits
  // one warning when the streak crosses ERROR_STREAK_WARN — once per episode, since the reset
  // re-arms it — and the dashboards read "failing" from the same field.
  const failed = outcome.result === "error" || outcome.recoveryFailure !== undefined;
  s.consecutiveErrors = failed ? (s.consecutiveErrors ?? 0) + 1 : 0;
  // The quiet-kill streak counts consecutive watchdog kills; any other result resets it.
  // loop.ts warns once when it crosses QUIET_KILL_RESUME_LIMIT, and the branch below uses
  // it to bound how many times a starved session is resumed (BUGS.md 2026-09-18).
  s.quietKillStreak = outcome.result === "quiet_killed" ? (s.quietKillStreak ?? 0) + 1 : 0;
  // The review gate persists phase="review" around its run so a dashboard mid-review shows
  // "reviewing". A completed tick clears it so the label never lingers — except an aborted
  // one: there the interruption hit mid-review, and the next launch must recover (and
  // re-review) the committed work fresh instead of resuming an author session whose task is
  // already committed.
  if (outcome.result !== "aborted") s.phase = undefined;
  s.lastTickEndedAt = Date.now();
  // `lastResult`/`lastSummary` are the last COMPLETED result, the pair the dashboards' "last
  // result" cell renders. A `queued` tick is not one: its change is committed but in flight —
  // the state column shows that (`landing <elapsed>`, the land-queue badge) — so the pair keeps
  // the prior outcome WITH its own summary while the change waits (BUGS.md 2026-09-23), and the
  // tick's summary is stashed under the pinned sha for applyLandingOutcome to pair with the
  // landing's result. Every other outcome is completed and clears the stash: a role with a
  // queued or in-flight landing never ticks (the orchestrator's interlock), so a stash that
  // survives to a later tick names a change that is no longer waiting.
  if (outcome.result === "queued") {
    s.queuedSummary =
      outcome.commit && outcome.summary ? { sha: outcome.commit, summary: outcome.summary } : undefined;
  } else {
    s.queuedSummary = undefined;
    s.lastResult = outcome.result;
    if (outcome.summary) s.lastSummary = outcome.summary;
  }
  if (outcome.result === "changed" || outcome.result === "queued") {
    // "queued" schedules exactly like "changed" — the tick committed and enqueued — but the
    // commit count waits for the landing: `commits` keeps meaning "landed on main", and
    // applyLandingOutcome increments it when the change actually lands. The phase-clear above
    // (`result !== "aborted"`) covers both.
    if (outcome.result === "changed") s.commits += 1;
    // A landed change's patch-id approval has done its job: the same patch authored again
    // later (after a revert, say) is a new change and gets its own review.
    if (outcome.result === "changed") s.lastApprovedPatchId = undefined;
    // The role committed new work, so the note about its discarded change has been delivered.
    s.conflictDiscard = undefined;
    s.backoffSeconds = 0;
    scheduleAtMinInterval(s, cfg);
  } else if (outcome.result === "rejected") {
    // The reviewer objected and the gate already reset the branch: the author should address
    // the recorded reasons on its next eligible tick, not sleep through them — schedule like
    // a change without counting a commit (nothing landed).
    s.backoffSeconds = 0;
    scheduleAtMinInterval(s, cfg);
  } else if (outcome.result === "skipped") {
    // Director idles until the inbox has work; no backoff bookkeeping.
    scheduleAtMinInterval(s, cfg);
  } else if (outcome.result === "aborted") {
    // Shutdown, not a verdict about the project: resume promptly on restart. The pi
    // session and the worktree's uncommitted edits were left in place, so the next tick
    // picks up exactly where this one was interrupted (director ticks instead re-queue
    // their user prompt, which runs fresh).
    if (role !== DIRECTOR_ROLE) s.resumePending = true;
    s.nextRunAt = Date.now();
  } else if (outcome.result === "quiet_killed") {
    // A hung tool call, not an idle verdict or a shutdown: the kill left the pi session and
    // the worktree's uncommitted edits intact, so resume them promptly like an interruption.
    // The cause is named in state so the bridge prompt tells the resumed session its run died
    // on a stalled tool call (director ticks never resume — their prompt was re-queued fresh).
    // Bounded like a cut-off streak: past QUIET_KILL_RESUME_LIMIT the session is
    // abandoned — the backend has refused to schedule it every attempt, so re-sending it only
    // starves the slot again — and the loop takes a fresh tick on the idle ladder instead
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
    // unproductive tick (idle backoff) instead of resuming promptly. phase is cleared by the
    // `result !== "aborted"` check above.
    scheduleBackoff(s, cfg.idleBackoff);
  } else if (outcome.result === "error") {
    // A failed tick, not an idle verdict: it often never reached the model, so it retries on
    // the short error ladder (capped in minutes) instead of the idle ladder, whose cap prices
    // hour-long model runs. backoffSeconds is shared: each ladder advances from the current
    // value, so an error streak capped at the error ceiling never sleeps LESS than the loop
    // already was sleeping, and the idle ladder picks up from there if the failures stop.
    scheduleBackoff(s, ERROR_BACKOFF);
  } else if (outcome.cutOff && role !== DIRECTOR_ROLE && s.cutOffStreak <= CUT_OFF_RESUME_LIMIT) {
    // Truncated at the context ceiling, not idle: the hour(s) of work survive in the
    // session pi just compacted, so resume it promptly instead of idle-backing-off.
    // Each resume restarts from the compacted (small) context, so repeated cut-offs on
    // one task still converge — but a task that outruns the ceiling every single time
    // would cycle forever, so after CUT_OFF_RESUME_LIMIT resumes the loop gives up on it
    // and falls back to a fresh tick with normal backoff (its prompt carrying the streak).
    s.resumePending = true;
    scheduleAtMinInterval(s, cfg);
  } else if (OBSERVER_ROLES.has(role)) {
    // An observer's no_change is a success ("checked, all well"), not an idle verdict: it must
    // not climb the idle ladder, which would punish the role monotonically for the product
    // being healthy. With no ladder, minTickIntervalSeconds is the sole, honest cadence
    // (plans/observer-roles.md). The error/user_aborted arms above are untouched — a broken
    // toolchain and a deliberate operator stop still back off like any other role.
    s.backoffSeconds = 0;
    scheduleAtMinInterval(s, cfg);
  } else {
    scheduleBackoff(s, cfg.idleBackoff);
  }
}

/** Record a completed LANDING on the authoring loop's state (plans/merge-queue.md 3/5):
 * the orchestrator calls this on the state object the landing ran against — the runner's live
 * copy when one exists, a disk load otherwise — then saves it, the same in-place discipline
 * applyTickOutcome has (the caller's state object is authoritative; a role with a queued or
 * in-flight landing never ticks, so no other writer holds it meanwhile). Sets `lastResult`
 * to the lander's outcome, increments `commits` only on a success (the "landed on main"
 * counter applyTickOutcome's "queued" branch left to the landing), and clears `phase` — the
 * gate persisted `phase = "review"` on this same state object during the run, exactly as it
 * did inside a tick, so the label must not linger past the landing (mirroring
 * applyTickOutcome's rule: every outcome except "aborted" clears it — an aborted landing
 * keeps it, because the interruption hit mid-review and the next launch must recover and
 * re-review the pinned work). `lastSummary` becomes the summary of the change this landing
 * resolved — `change` is its land-queue entry — so the landing's result, success or failure,
 * reads beside the work it names (BUGS.md 2026-09-23: the queued tick held its summary back
 * rather than pair it with the prior result). The tick's stashed `queuedSummary` wins when it
 * names this sha: it is the text the tick reported, high-friction annotation included. The
 * entry's own summary (the commit subject) covers a stash that is missing or names another
 * change — a crash between enqueue and the tick's state save, or a landing that finished before
 * its tick's outcome was applied. Either way the stash is consumed. The failure detail rides
 * in `lastReview` and the landed/land_failed events. */
export function applyLandingOutcome(
  s: LoopState,
  result: TickResult,
  change: Pick<LandingEntry, "sha" | "summary">,
): void {
  s.lastResult = result;
  s.lastSummary = s.queuedSummary?.sha === change.sha ? s.queuedSummary.summary : change.summary;
  s.queuedSummary = undefined;
  if (result === "changed") s.commits += 1;
  if (result === "changed") s.lastApprovedPatchId = undefined; // see applyTickOutcome
  // The conflict streak counts failed resolutions of one pinned sha; a landing or a rejection
  // ends that pin's life. Every other outcome kept the pin as it was, so its count stands.
  if (result === "merge_conflict") {
    const prior = s.mergeConflicts?.sha === change.sha ? s.mergeConflicts.count : 0;
    s.mergeConflicts = { sha: change.sha, count: prior + 1 };
  } else if (result === "changed" || result === "rejected") {
    s.mergeConflicts = undefined;
  }
  // Likewise the red-landing-check streak (keyed by patch-id): its change is gone either way.
  if (result === "changed" || result === "rejected") s.landingCheckFailures = undefined;
  if (result !== "aborted") s.phase = undefined;
}
