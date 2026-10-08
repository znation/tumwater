import type { TumwaterConfig } from "../config/config-schema.js";
import { saveLoopState, type LoopState } from "../loop/loop-state.js";
import { branchHead } from "../git/git.js";
import { logEvent, usageFragment, warnEvent } from "../events/events.js";
import { ERROR_STREAK_WARN, QUIET_KILL_RESUME_LIMIT, applyTickOutcome } from "./tick-apply.js";
import { restoreMidTickWake } from "../scheduling/backoff.js";
import { consecutiveFailuresWarning } from "../text/phrases.js";
import type { TickOutcome, TickResult } from "./tick-outcome.js";
import type { TickUsage } from "./tick-usage.js";

/** What finalizeTick needs from the runner: everything the post-outcome bookkeeping reads,
 * passed explicitly so the policy below stays a free function over plain state. */
interface FinalizeTickDeps {
  root: string;
  role: string;
  mainBranch: string;
  /** The role-resolved config view (src/config/config-views.ts's configForRole result) this tick
   * already computed — applyTickOutcome schedules the next run from its interval overrides. */
  config: TumwaterConfig;
  state: LoopState;
  outcome: TickOutcome;
  /** The tick number tick_start announced, captured at tick start — NOT re-read from
   * `state.ticks` here: `resetCounters` zeroes `state.ticks` in place mid-tick (the
   * documented running-fleet reset), so a finalize-time re-read could emit a tick_end
   * numbered 0 (or a later tick's number) under a tick_start that announced the real one. */
  tick: number;
  /** When this tick started (the runner stamps state.lastTickStartedAt at tick start);
   * captured once so the tick_end span measures the tick's own wall clock. */
  tickStartedAt: number;
  /** The tick's usage accumulator (src/tick/tick-usage.ts): its costUsd rides the tick_end event. */
  usage: TickUsage;
  /** The landing failure this tick's leftover recovery is retrying, if any (set by
   * finishRecoveryTick); undefined for a tick that ran no leftover recovery. */
  recoveryFailure?: string;
}

/** The tick results that end an instance's claim: the tick found nothing to do, refused the
 * entry, was aborted by the user, or was skipped — none of them leaves work in flight. */
const CLAIM_RELEASING: ReadonlySet<TickResult> = new Set([
  "no_change",
  "refused",
  "user_aborted",
  "skipped",
]);

/** Fold a finished tick's outcome into the loop's state and the event feed — everything that
 * happens AFTER the pi run, extracted from LoopRunner.tick (src/loop/loop.ts) so the runner keeps
 * only tick lifecycle (worktree, sessions, abort) and this module owns the per-result
 * bookkeeping policy. Order matters here and is pinned by behavior, not by a test seam: the
 * outcome's folds land on state before applyTickOutcome schedules the next run, the main-head
 * read happens while `running` is still true (a poll landing in that window must not double-wake
 * the loop), and the warnings read the streaks exactly once per episode, after the schedule. */
export async function finalizeTick(deps: FinalizeTickDeps): Promise<TickOutcome> {
  const { root, role, mainBranch, config, state: s, usage, tick } = deps;
  let { outcome } = deps;
  // A re-queued leftover's landing failure is not the tick's own result, so it rides the
  // outcome separately: applyTickOutcome feeds it into the error streak, and the warning
  // below names it — even though runTick cleared `lastError` so it never latched onto
  // `tick_end` (BUGS.md 2026-09-21).
  if (deps.recoveryFailure !== undefined) outcome.recoveryFailure = deps.recoveryFailure;
  // A main_red tick's cause is written for that result (src/baseline/main-red.ts), not a leftover
  // landing failure: fold it onto the state here so `tick_end` logs it like every other
  // failure's and the digest can itemize what the Outcome table's main_red cells mean
  // (BUGS.md 2026-09-28). runTick cleared `lastError` at its start, so nothing foreign
  // can precede this.
  if (outcome.error !== undefined) s.lastError = outcome.error;

  // Read main's current head while this tick is still reserved (running=true): the
  // applyTickOutcome below clears running, and a poll landing between that clear and a later
  // head update would see a stale lastMainHead and wake the loop again on the very move
  // that triggered this tick — a duplicate wake event plus an extra tick for one world change.
  // branchHead reads the ref files first (microsecond-scale, like the orchestrator's per-poll
  // watch) and spawns `git rev-parse` only when they cannot resolve it; a null result keeps
  // the previous value rather than waking on "main moved" to nowhere.
  s.lastMainHead = (await branchHead(root, mainBranch)) ?? s.lastMainHead;
  // Record the outcome on state and schedule the next run (see src/tick/tick-apply.ts for the
  // per-result policy: prompt retry, backoff, bounded cut-off resumes).
  applyTickOutcome(s, config, role, outcome);
  // A tick that ends without producing or keeping work releases this instance's backlog claim
  // (plans/parallel-work-instances.md "Claims", part 4/7): the next tick may take a different
  // entry. Every other result — queued, changed, rejected with a revision, an error, an abort
  // that resumes — keeps the claim so the same instance retries it; an outstanding revision or
  // a pending resume also holds it, because the entry is still this instance's task.
  if (
    s.claim &&
    CLAIM_RELEASING.has(outcome.result) &&
    s.revision === undefined &&
    s.resumePending !== true
  ) {
    const title = s.claim.title;
    s.claim = undefined;
    logEvent(root, { loop: role, type: "claim", action: "released", title, reason: outcome.result });
  }
  // A wake consumed while this tick ran stamped the shared state in place, but the outcome
  // schedule above overwrites it (lastTickEndedAt past wokenAt, nextRunAt a fresh gap or
  // backoff out), so a plain `tumwater wake --role` with an empty queue would silently wait
  // out the whole interval (BUGS.md 2026-09-25). Re-apply it here — exactly like a wake
  // arriving one poll after the tick ended.
  restoreMidTickWake(s);
  saveLoopState(root, s);
  // One warning per error episode (BUGS.md 2026-09-15: every loop failing identically
  // looked like a quiet fleet). applyTickOutcome increments the streak on error-class
  // outcomes, preserves it across a plain `queued` tick (the tick's landing resolves it),
  // and resets it on any other completed result — so warn only when THIS outcome incremented
  // the streak up to the threshold: a preserved streak already sitting at the bar must not
  // re-warn on the queued tick's end. A rejection's crossing warns from the landing side
  // instead (writeLandingOutcome, src/landing/landing-slot.ts), which is where rejections resolve.
  if (
    (outcome.result === "error" || outcome.recoveryFailure !== undefined) &&
    (s.consecutiveErrors ?? 0) === ERROR_STREAK_WARN
  ) {
    warnEvent(
      root,
      role,
      consecutiveFailuresWarning(
        s.consecutiveErrors ?? 0,
        s.lastError ?? outcome.recoveryFailure ?? "unknown error",
      ),
    );
  }
  // One warning per quiet-kill episode (BUGS.md 2026-09-18): a loop burning an hour per
  // tick with no output must not look like a sleeping loop. applyTickOutcome grows the
  // streak on each kill and resets it on any other result, so the crossing fires once;
  // the give-up (fresh session + backoff) follows on the next kill.
  if ((s.quietKillStreak ?? 0) === QUIET_KILL_RESUME_LIMIT) {
    warnEvent(root, role, `${s.quietKillStreak} consecutive quiet kills (no progress): ${s.lastError ?? "unknown hang"}`);
  }
  // Per-tick usage (PLANS.md, per-tick-usage plan): the event feed is where operators see
  // spend — this tick's tokens and cost ride on tick_end so a budget pause or a money-burning
  // no_change/error/rejected/refused tick shows what it spent without diffing status-table
  // snapshots. Both fields are per-tick windows (reset at tick start, folded in over every
  // pi run of the tick); they ride on HarnessEvent's index signature like other payloads and
  // are omitted when zero so skipped ticks render byte-identical to a pre-feature line.
  // The tick's wall-clock span rides on tick_end too (PLANS.md, time-and-spend plan): the
  // failure digest prices a tick by its own durationMs first (src/failure/failure-data.ts
  // tickDurationMs), so the field is ALWAYS present — a tick that ends within the same
  // Date.now() millisecond it started (an instant early-abort error tick) or crosses a
  // backward clock step still attests its 0 ms, where the old omit-when-zero convention
  // dropped the field and broke the "every tick_end carries a span" contract (BUGS.md
  // 2026-09-29). Unlike the usage fields, tick_end's renderer never prints the span, so an
  // always-present 0 changes no rendered line.
  const tickDurationMs = Math.max(0, Date.now() - deps.tickStartedAt);
  logEvent(root, {
    loop: role,
    type: "tick_end",
    tick,
    result: outcome.result,
    summary: outcome.summary,
    error: s.lastError,
    durationMs: tickDurationMs,
    ...usageFragment(s.generatedTokens, usage.costUsd),
    // Per-tick prompt-token telemetry (PLANS.md, per-tick-prompt-token plan): how many prompt
    // tokens the tick sent, how many were cache reads, and how many went out before its first
    // edit. Omitted when zero like usageFragment's fields, so a tick that sent no prompt — and
    // every tick_end written by an older build — renders byte-identically.
    ...(usage.promptTokens > 0 ? { promptTokens: usage.promptTokens } : {}),
    ...(usage.cacheReadTokens > 0 ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    ...(usage.preEditPromptTokens > 0 ? { preEditPromptTokens: usage.preEditPromptTokens } : {}),
  });
  return outcome;
}
