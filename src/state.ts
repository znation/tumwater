import type { TumwaterConfig, LoopState, TickOutcome, TickResult, BackoffConfig } from "./types.js";
import { DIRECTOR_ROLE, OBSERVER_ROLES } from "./roles.js";
import { readJsonFile, writeJsonAtomic } from "./json-files.js";
import { statePath } from "./paths.js";

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

/** Clear a loop's backoff so its next orchestrator poll finds it immediately due: zero
 * backoffSeconds (so the next no_change/error tick restarts the backoff ladder from the
 * bottom instead of climbing from wherever the fleet parked) and pull nextRunAt forward to
 * now. Pure: returns a new state and preserves everything else — counters (an
 * observation-window reset is zeroCounters' job), wake tracking (lastMainHead), and the
 * last-result fields. Scheduling operation, not observation-window reset: it exists so an
 * operator who fixed what the loops were failing on can say "try again" (BUGS.md
 * 2026-09-15: the fleet had no wake lever). */
export function clearBackoff(s: LoopState, now: number): LoopState {
  return { ...s, backoffSeconds: 0, nextRunAt: now };
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
  // The cut-off streak counts EVERY consecutive tick truncated at the context ceiling, past the
  // resume limit too: the next fresh tick's prompt names how many attempts the window has eaten
  // (buildCutOffNote), so the count must not freeze at the limit. Any other outcome resets it.
  s.cutOffStreak = outcome.cutOff ? (s.cutOffStreak ?? 0) + 1 : 0;
  // The error streak counts consecutive failed ticks; any other result resets it
  // (BUGS.md 2026-09-15: 44 identical failures raised no alarm). A tick whose leftover
  // recovery left a pin behind counts too, even when its own authoring run is healthy
  // (outcome.recoveryFailure): a dead reviewer backend would otherwise reset the streak
  // every tick and never raise the alarm (BUGS.md 2026-09-21). loop.ts emits one warning
  // when the streak crosses ERROR_STREAK_WARN — once per episode, since the reset re-arms
  // it — and the dashboards read "failing" from the same field.
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
  s.lastResult = outcome.result;
  if (outcome.summary) s.lastSummary = outcome.summary;
  if (outcome.result === "changed" || outcome.result === "queued") {
    // "queued" schedules exactly like "changed" — the tick committed and enqueued — but the
    // commit count waits for the landing: `commits` keeps meaning "landed on main", and
    // applyLandingOutcome increments it when the change actually lands. The phase-clear above
    // (`result !== "aborted"`) covers both.
    if (outcome.result === "changed") s.commits += 1;
    s.backoffSeconds = 0;
    s.nextRunAt = Date.now() + cfg.minTickIntervalSeconds * 1000;
  } else if (outcome.result === "rejected") {
    // The reviewer objected and the gate already reset the branch: the author should address
    // the recorded reasons on its next eligible tick, not sleep through them — schedule like
    // a change without counting a commit (nothing landed).
    s.backoffSeconds = 0;
    s.nextRunAt = Date.now() + cfg.minTickIntervalSeconds * 1000;
  } else if (outcome.result === "skipped") {
    // Director idles until the inbox has work; no backoff bookkeeping.
    s.nextRunAt = Date.now() + cfg.minTickIntervalSeconds * 1000;
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
      s.resumeCause = "hung-tool";
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
    s.nextRunAt = Date.now() + cfg.minTickIntervalSeconds * 1000;
  } else if (OBSERVER_ROLES.has(role)) {
    // An observer's no_change is a success ("checked, all well"), not an idle verdict: it must
    // not climb the idle ladder, which would punish the role monotonically for the product
    // being healthy. With no ladder, minTickIntervalSeconds is the sole, honest cadence
    // (plans/observer-roles.md). The error/user_aborted arms above are untouched — a broken
    // toolchain and a deliberate operator stop still back off like any other role.
    s.backoffSeconds = 0;
    s.nextRunAt = Date.now() + cfg.minTickIntervalSeconds * 1000;
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
 * re-review the pinned work). `lastSummary` is left untouched: the tick's summary stays, and
 * the failure detail rides in `lastReview` and the landed/land_failed events. */
export function applyLandingOutcome(s: LoopState, result: TickResult): void {
  s.lastResult = result;
  if (result === "changed") s.commits += 1;
  if (result !== "aborted") s.phase = undefined;
}


