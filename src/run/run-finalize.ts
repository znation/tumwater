import type { TumwaterConfig } from "../config/config-schema.js";
import { hasOutstandingWork, saveRunnerStateBestEffort, type RunnerState } from "../runner/runner-state.js";
import { branchHead } from "../git/git.js";
import { logEventBestEffort, usageFragment, warnEventBestEffort } from "../events/events.js";
import { observeAccount } from "../agent/subscription-account.js";
import { CUT_OFF_RESUME_LIMIT, ERROR_STREAK_WARN, QUIET_KILL_RESUME_LIMIT, applyRunOutcome } from "./run-apply.js";
import { restoreMidRunWake } from "../scheduling/backoff.js";
import { consecutiveFailuresWarning } from "../text/phrases.js";
import type { RunOutcome, RunResult } from "./run-outcome.js";
import type { RunUsage } from "./run-usage.js";

/** What finalizeRun needs from the runner: everything the post-outcome bookkeeping reads,
 * passed explicitly so the policy below stays a free function over plain state. */
interface FinalizeRunDeps {
  root: string;
  role: string;
  mainBranch: string;
  /** The role-resolved config view (src/config/config-views.ts's configForRole result) this run
   * already computed — applyRunOutcome schedules the next run from its interval overrides. */
  config: TumwaterConfig;
  state: RunnerState;
  outcome: RunOutcome;
  /** The run number run_start announced, captured at run start — NOT re-read from
   * `state.runs` here: `resetCounters` zeroes `state.runs` in place mid-run (the
   * documented running-team reset), so a finalize-time re-read could emit a run_end
   * numbered 0 (or a later run's number) under a run_start that announced the real one. */
  runNumber: number;
  /** When this run started (the runner stamps state.lastRunStartedAt at run start);
   * captured once so the run_end span measures the run's own wall clock. */
  runStartedAt: number;
  /** The run's usage accumulator (src/run/run-usage.ts): its costUsd rides the run_end
   * event. */
  usage: RunUsage;
  /** The merge failure this run's leftover recovery is retrying, if any (set by
   * finishRecoveryRun); undefined for a run that ran no leftover recovery. */
  recoveryFailure?: string;
}

/** The run results that end an instance's claim: the run found nothing to do, refused the
 * entry, was aborted by the user, or was skipped — none of them leaves work in flight. */
const CLAIM_RELEASING: ReadonlySet<RunResult> = new Set([
  "no_change",
  "refused",
  "user_aborted",
  "skipped",
]);

/** Fold a finished run's outcome into the role's state and the event feed — everything that
 * happens AFTER the pi run, extracted from RoleRunner.run (src/runner/runner.ts) so the runner
 * keeps only run lifecycle (worktree, sessions, abort) and this module owns the per-result
 * bookkeeping policy. Order matters here and is pinned by behavior, not by a test seam: the
 * outcome's folds are applied to state before applyRunOutcome schedules the next run, the
 * main-head read happens while `running` is still true (a poll that runs in that window must not
 * double-wake the role), and the warnings read the streaks exactly once per episode, after the
 * schedule. */
export async function finalizeRun(deps: FinalizeRunDeps): Promise<RunOutcome> {
  const { root, role, mainBranch, config, state: s, usage, runNumber } = deps;
  let { outcome } = deps;
  // A re-queued leftover's merge failure is not the run's own result, so it rides the
  // outcome separately: applyRunOutcome feeds it into the error streak, and the warning
  // below names it — even though runOnce cleared `lastError` so it never latched onto
  // `run_end` (BUGS.md 2026-09-21).
  if (deps.recoveryFailure !== undefined) outcome.recoveryFailure = deps.recoveryFailure;
  // A main_red run's cause is written for that result (src/baseline/main-red.ts), not a leftover
  // merge failure: fold it onto the state here so `run_end` logs it like every other
  // failure's and the digest can itemize what the Outcome table's main_red cells mean
  // (BUGS.md 2026-09-28). runOnce cleared `lastError` at its start, so nothing foreign
  // can precede this.
  if (outcome.error !== undefined) s.lastError = outcome.error;

  // Read main's current head while this run is still reserved (running=true): the
  // applyRunOutcome below clears running, and a poll that runs between that clear and a later
  // head update would see a stale lastMainHead and wake the role again on the very move
  // that triggered this run — a duplicate wake event plus an extra run for one world change.
  // branchHead reads the ref files first (microsecond-scale, like the orchestrator's per-poll
  // watch) and spawns `git rev-parse` only when they cannot resolve it; a null result keeps
  // the previous value rather than waking on "main moved" to nowhere.
  s.lastMainHead = (await branchHead(root, mainBranch)) ?? s.lastMainHead;
  // Record the outcome on state and schedule the next run (see src/run/run-apply.ts for the
  // per-result policy: prompt retry, backoff, bounded cut-off resumes).
  applyRunOutcome(s, config, role, outcome);
  releaseFinishedClaim(root, role, s, outcome);
  restoreMidRunWake(s);
  // A failed save warns and the run still ends: the in-memory state already holds the fold and
  // the runner's next save writes it, while a throw here would skip run_end and the launch
  // task's breaker fold.
  saveRunnerStateBestEffort(root, s);
  warnOnStreakCrossings(root, role, s, outcome);
  // The run's wall-clock span rides on run_end too: the
  // failure digest prices a run by its own durationMs first (src/failure/failure-data.ts
  // runDurationMs), so the field is ALWAYS present — a run that ends within the same
  // Date.now() millisecond it started (an instant early-abort error run) or crosses a
  // backward clock step still attests its 0 ms, where the old omit-when-zero convention
  // dropped the field and broke the "every run_end carries a span" contract (BUGS.md
  // 2026-09-29). Unlike the usage fields, run_end's renderer never prints the span, so an
  // always-present 0 changes no rendered line.
  const runDurationMs = Math.max(0, Date.now() - deps.runStartedAt);
  observeRunAccount(root, usage);
  logRunEnd(root, role, runNumber, s, outcome, usage, runDurationMs);
  return outcome;
}

/** A run that ends without producing or keeping work releases this instance's backlog claim
 * (plans/parallel-work-instances.md "Claims", part 4/7): the next run may take a different
 * entry. Every other result — queued, changed, rejected with a revision, an error, an abort
 * that resumes — keeps the claim so the same instance retries it; an outstanding revision or
 * a pending resume also holds it, because the entry is still this instance's task. */
function releaseFinishedClaim(root: string, role: string, state: RunnerState, outcome: RunOutcome): void {
  if (
    state.claim &&
    CLAIM_RELEASING.has(outcome.result) &&
    !hasOutstandingWork(state)
  ) {
    const title = state.claim.title;
    state.claim = undefined;
    logEventBestEffort(root, { source: role, type: "claim", action: "released", title, reason: outcome.result });
  }
}

/** One warning per error episode (BUGS.md 2026-09-15: every role failing identically
 * looked like a quiet team), quiet-kill episode (BUGS.md 2026-09-18: a role burning an hour
 * per run with no output must not look like a sleeping role) and cut-off episode (mirroring
 * quiet-kill: a role cycling cut-off → resume burns an hour-plus per cycle with no other
 * operator signal) — each fired exactly once at the streak's crossing, after the schedule. */
function warnOnStreakCrossings(root: string, role: string, state: RunnerState, outcome: RunOutcome): void {
  // One warning per error episode (BUGS.md 2026-09-15: every role failing identically
  // looked like a quiet team). applyRunOutcome increments the streak on error-class
  // outcomes, preserves it across a plain `queued` run (the run's merge resolves it),
  // and resets it on any other completed result — so warn only when THIS outcome incremented
  // the streak up to the threshold: a preserved streak already sitting at the bar must not
  // re-warn on the queued run's end. A rejection's crossing warns from the merge side
  // instead (writeMergeOutcome, src/merge/merge-slot.ts), which is where rejections resolve.
  if (
    (outcome.result === "error" || outcome.recoveryFailure !== undefined) &&
    (state.consecutiveErrors ?? 0) === ERROR_STREAK_WARN
  ) {
    warnEventBestEffort(
      root,
      role,
      consecutiveFailuresWarning(
        state.consecutiveErrors ?? 0,
        state.lastError ?? outcome.recoveryFailure ?? "unknown error",
      ),
    );
  }
  // One warning per quiet-kill episode (BUGS.md 2026-09-18): a role burning an hour per
  // run with no output must not look like a sleeping role. applyRunOutcome grows the
  // streak on each kill and resets it on any other result, so the crossing fires once;
  // the give-up (fresh session + backoff) follows on the next kill.
  if ((state.quietKillStreak ?? 0) === QUIET_KILL_RESUME_LIMIT) {
    warnEventBestEffort(root, role, `${state.quietKillStreak} consecutive stalls (no progress): ${state.lastError ?? "unknown hang"}`);
  }
  // One warning per cut-off episode, mirroring quiet-kill above: a role cycling cut-off →
  // resume burns an hour-plus per cycle (run-apply.ts CUT_OFF_RESUME_LIMIT) with no other
  // operator signal, so the crossing must not look like a benign idle role. The `outcome.cutOff`
  // guard makes it fire only on the run that increments the streak to the limit — every
  // non-cut-off run resets the streak to 0 and a later cut-off sits above the limit — so
  // exactly one warning per episode. No role guard, matching quiet-kill (a cut-off director
  // prompt is re-queued but its streak still counts).
  if (outcome.cutOff === true && (state.cutOffStreak ?? 0) === CUT_OFF_RESUME_LIMIT) {
    warnEventBestEffort(root, role, `${state.cutOffStreak} consecutive runs cut off at the context ceiling; give the role a smaller task or a longer context window`);
  }
}

/** The account state (plans/agent-backends.md part 6a): fold this run's billing answer and
 * rate-window readings into the reporting backend's .tumwater/state/<backend>-account.json
 * for the sibling parts that throttle or display the subscription window. Best-effort — the
 * file is a cache, and an unwritable state dir must not fail a run whose real work is
 * already done. A pi run never reports either, so in practice claude owns the file until a
 * second subscription backend lands (plans/codex-backend.md). */
function observeRunAccount(root: string, usage: RunUsage): void {
  if (usage.billing !== undefined || usage.rateWindows !== undefined) {
    try {
      observeAccount(root, usage.agent ?? "pi", {
        billing: usage.billing,
        rateWindows: usage.rateWindows,
      });
    } catch {
      // The next reporting run rewrites it; nothing this run depends on is lost.
    }
  }
}

/** Assemble and log the run_end event: the per-run usage fields (tokens and cost), the run's
 * wall-clock span, and every conditional payload spread. Omitted-when-zero fields ride the
 * event feed only when nonzero so skipped runs render byte-identically to a pre-feature line;
 * `durationMs` is ALWAYS present to keep the "every run_end carries a span" contract. */
function logRunEnd(
  root: string,
  role: string,
  runNumber: number,
  state: RunnerState,
  outcome: RunOutcome,
  usage: RunUsage,
  runDurationMs: number,
): void {
  // The per-provider split of this run's usage (plans: per-provider spend in the day
  // report): a Record<provider, {costUsd, notionalCostUsd}> for the report's `Cost by
  // provider` line. Omitted when empty like the prompt-token fields, so a run whose runs
  // carried no provider renders byte-identically to today.
  const providerCost = usage.serializeProviderCost();
  logEventBestEffort(root, {
    source: role,
    type: "run_end",
    run: runNumber,
    result: outcome.result,
    summary: outcome.summary,
    error: state.lastError,
    durationMs: runDurationMs,
    ...(outcome.heldOnBranch ? { heldOnBranch: true } : {}),
    // The context-ceiling truncation flag: set when the run burned its whole window and
    // the harness resumes its pinned session (slotPinnedForResume). Omitted when false, so
    // a normal run — and every run_end written by an older build — renders byte-identically.
    ...(outcome.cutOff === true ? { cutOff: true } : {}),
    ...usageFragment(state.generatedTokens, usage.costUsd, usage.notionalCostUsd),
    ...(Object.keys(providerCost).length > 0 ? { providerCost } : {}),
    // The billing answer the run's runs reported, so the report can tell notional spend from
    // real spend without re-deriving it from the file (plans/agent-backends.md part 6a).
    ...(usage.billing !== undefined ? { billing: usage.billing } : {}),
    // The backend that reported the billing/rate windows (plans/codex-backend.md part 3d/9):
    // carried under the same condition the account file is written (observeAccount above), so
    // the report folds a run's notional spend to the subscription backend whose runs made it.
    ...(usage.billing !== undefined || usage.rateWindows !== undefined ? { agent: usage.agent } : {}),
    // Per-run prompt-token telemetry: how many prompt
    // tokens the run sent, how many were cache reads, and how many went out before its first
    // edit. Omitted when zero like usageFragment's fields, so a run that sent no prompt — and
    // every run_end written by an older build — renders byte-identically.
    ...(usage.promptTokens > 0 ? { promptTokens: usage.promptTokens } : {}),
    ...(usage.cacheReadTokens > 0 ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    ...(usage.preEditPromptTokens > 0 ? { preEditPromptTokens: usage.preEditPromptTokens } : {}),
    // The run's peak single-request context: how hot the run's largest model call ran
    // against the model's declared window (runner-state.ts's peakContextTokens, reset at
    // run start). Omitted when zero like the prompt-token fields, so a run that reported
    // no context — and every run_end written by an older build — renders byte-identically.
    ...(state.peakContextTokens > 0 ? { peakContextTokens: state.peakContextTokens } : {}),
  });
}
