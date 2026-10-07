import type { LoopState } from "../loop/loop-state.js";
import { hasResumableSession } from "../pi/pi.js";
import { RETRIABLE_LANDING_RESULTS } from "../landing/landing-core.js";
import type { PendingPrompt } from "../inbox/pending-prompt.js";
import { sessionDir } from "../paths.js";
import { buildResumePrompt, type ResumeCause } from "../prompt/prompt-followup.js";

/** What a tick starts with, decided before any worktree or pi work: whether it resumes the
 * interrupted session (and why), the prompt it runs, and the raw user request it executes.
 * planTickStart owns the whole decision — runTick (src/loop/loop.ts) consumes the plan verbatim:
 * a null plan means the loop has nothing to run (the tick is skipped), a resumed tick gets
 * the cause-named bridge prompt, a fresh tick the assembled one. */
export interface TickStartPlan {
  /** The last landing's failure (the lander's own vocabulary — review_error, merge_conflict,
   * merge_blocked — with the detail it wrote into `lastError`), captured before the plan
   * clears lastError: a non-terminally failed landing kept its pin, and when this tick's
   * recovery re-queues that pin the failure must still feed the error streak
   * (finishRecoveryTick). Undefined when the last result was not a retriable landing failure. */
  priorLandingFailure: string | undefined;
  /** Resume the interrupted session instead of starting fresh. */
  resuming: boolean;
  /** Why the resume: a named quiet-kill means the last run died on a stalled tool call (the
   * bridge then warns against re-running it unchanged) or on the tick deadline while still
   * making progress (the bridge asks for the smallest finish against the same limit); a
   * cut-off streak means the last run ran out of context and pi compacted the session (the
   * bridge asks for the smallest finish); otherwise a shutdown/crash. */
  resumeCause: ResumeCause;
  /** The prompt this tick runs: the resume bridge when resuming, the assembled tick prompt
   * otherwise (runTick may still append notes — a conflict-discard note, a main-red note —
   * before the run). Never null: a null prompt means nothing to run and planTickStart
   * returns null instead. */
  prompt: string;
  /** The raw user prompt this tick is executing (null for role loops), so an unfulfilled
   * outcome can re-queue it. */
  userPrompt: string | null;
}

/** Decide how a tick starts, consuming the resume flags as a side effect (the flag is
 * consumed here so a resume that fails falls back to a normal fresh tick; another shutdown
 * mid-resume sets it again) and reclaiming the interrupted tick's re-queued prompt. Returns
 * null — meaning the tick is skipped — when the loop has nothing to run (an empty director
 * inbox); a role loop's assembly never returns null. */
export function planTickStart(opts: {
  root: string;
  role: string;
  state: LoopState;
  /** The loop's prompt queue: the interrupted tick's re-queued request is reclaimed into it,
   * and a fresh tick's assembled prompt is recorded onto it (via tickPrompt). */
  pending: PendingPrompt;
  /** Assemble a fresh tick's prompt (null when the loop has nothing to run); the runner's
   * tickPrompt() so the dequeued user request is recorded as pending exactly as before. */
  tickPrompt: () => string | null;
}): TickStartPlan | null {
  const s = opts.state;
  // The last landing's failure, read before the clear below: a landing that failed
  // non-terminally kept its pin (the lander's own vocabulary — review_error, merge_conflict,
  // merge_blocked — with the detail it wrote into `lastError`), and when this tick's recovery
  // re-queues that pin, the failure must still feed the error streak (finishRecoveryTick).
  const priorLandingFailure =
    s.lastResult !== undefined && RETRIABLE_LANDING_RESULTS.has(s.lastResult)
      ? (s.lastError ?? `landing failed: ${s.lastResult}`)
      : undefined;
  s.lastError = undefined;

  // A tick interrupted by a harness shutdown left its pi session and its worktree's
  // uncommitted edits in place: resume that session instead of starting fresh. The flag
  // is consumed here so a resume that fails falls back to a normal fresh tick; another
  // shutdown mid-resume sets it again. Nothing to resume (sessions pruned, or pi never
  // started) also falls back to fresh.
  const resumableSession = s.resumePending === true && hasResumableSession(sessionDir(opts.root, opts.role));
  // Captured before the flag is consumed below; a stale cause must not leak into a later resume.
  const pendingResumeCause = s.resumeCause;
  s.resumePending = false;
  s.resumeCause = undefined;
  // An interruption during the review gate leaves the author's work fully committed — there
  // is nothing left to finish in its session. Recover (and re-review) the leftover commits
  // via a fresh tick instead: continuing the author session would burn a run on finished
  // work, and any uncommitted edits are the reviewer's stray output, discarded by the fresh
  // path's reset below.
  const resuming = resumableSession && s.phase !== "review";
  // Reclaim the prompt the interrupted tick re-queued for its resume (src/inbox/pending-prompt.ts):
  // the resumed session still owns that request in its context, so this tick's bookkeeping
  // operates on the queue's copy. Consumed even when this tick does not resume, so a stale
  // record never survives into a later resume.
  opts.pending.reclaimForResume(s, resuming);

  // Why the resume: a named quiet-kill means the last run died on a stalled tool call (the
  // bridge then warns against re-running it unchanged) or on the tick deadline while still
  // making progress (the bridge asks for the smallest finish against the same limit); a
  // cut-off streak means the last run ran out of context and pi compacted the session (the
  // bridge asks for the smallest finish); otherwise a shutdown/crash.
  const resumeCause = pendingResumeCause ?? ((s.cutOffStreak ?? 0) > 0 ? "cut-off" : "restart");
  const prompt = resuming ? buildResumePrompt(opts.role, resumeCause) : opts.tickPrompt();
  if (prompt === null) return null;
  // The raw user prompt a director tick is executing (null for role loops), so an
  // unfulfilled outcome below can re-queue it. Captured before the field is cleared.
  const userPrompt = opts.pending.get();
  return { priorLandingFailure, resuming, resumeCause, prompt, userPrompt };
}
