import type { LoopState } from "../loop/loop-state.js";
import { agentSessionResumable } from "../agent/agent-backend.js";
import { latestSession } from "../agent/session-ledger.js";
import { RETRIABLE_LANDING_RESULTS } from "../landing/landing-core.js";
import type { PendingPrompt } from "../inbox/pending-prompt.js";
import { sessionDir } from "../paths.js";
import { buildHandoffPrompt, buildResumePrompt, type ResumeCause } from "../prompt/prompt-followup.js";

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
  /** Run a fresh session but leave the worktree as the interrupted run left it, with the
   * handoff bridge (plans/agent-backends.md "Sessions"): the newest author session belongs to
   * another agent or another kind, so it is not ours to `--continue` — but the interrupted
   * run's uncommitted edits are still in the worktree and must survive the fresh path's reset.
   * Mutually exclusive with `resuming`. */
  handoff: boolean;
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
   * tickPrompt() so the dequeued user request is recorded as pending exactly as before. The
   * effective `agent` below is passed through so the prompt speaks the dialect of the backend
   * the tick actually runs on, not the role's primary. */
  tickPrompt: (agent?: string) => string | null;
  /** The backend this tick would run on, for the resume decision: a newest author ledger line
   * naming another agent hands off instead of resuming. Defaults to pi, the historical
   * backend. */
  agent?: string;
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
  //
  // The session ledger decides WHICH session a continue would reach. pi's --continue resumes
  // the newest file in the dir, so a conflict resolver's gate run in the same dir (or another
  // backend's session) would shadow the author's: only a newest author line for THIS agent is
  // resumable; any other newest line hands off to a fresh session in the unreset worktree.
  // A pre-ledger dir falls back to the historical any-*.jsonl check.
  const dir = sessionDir(opts.root, opts.role);
  const agent = opts.agent ?? "pi";
  const resumePending = s.resumePending === true;
  // The previous run's own verdict that its `--resume` target is gone is authoritative over the
  // transcript check: a lingering transcript (a torn/empty file, or the fake's planted one) must
  // not re-arm a resume the backend just rejected, or the loop re-resumes and re-fails forever.
  const resumeMissing = s.resumeMissing === true;
  const latest = resumePending ? latestSession(dir) : null;
  // Our backend decides whether the newest session of this kind is actually resumable: pi
  // continues the newest FILE in the dir (only a newest author line for pi is safe), while
  // claude resumes an id (safe across a newer gate line). A backend with no `resumable` hook
  // falls back to the backend-neutral session-file check.
  const resumable = resumePending && !resumeMissing
    ? agentSessionResumable(dir, { kind: "author", agent })
    : false;
  const resumableSession = resumable;
  // A newest line our backend cannot resume is not ours to continue: another kind's or
  // another agent's session, OR our own author line whose session the backend no longer holds
  // (a `--resume` that answered "No conversation found" mid-run, leaving `resumeMissing`, or a
  // pruned session dir). In every such case the interrupted run's uncommitted edits still
  // deserve a handoff rather than the fresh path's worktree reset: the next tick runs a FRESH
  // session over the kept worktree, carrying the assembled tick prompt plus the handoff
  // bridge (plans/agent-backends.md "Sessions"). The failed `resumeMissing` run arms
  // `resumePending` and records `resumeMissing` from the verdict (its error turn carries no
  // assistant content), so the very next tick lands here with the worktree intact. A dir with
  // no ledger line at all is not a handoff — there is no recorded interrupted session to carry
  // forward.
  const handoff = latest !== null && !resumable;
  // Captured before the flag is consumed below; a stale cause must not leak into a later resume.
  const pendingResumeCause = s.resumeCause;
  s.resumePending = false;
  s.resumeCause = undefined;
  s.resumeMissing = undefined;
  // An interruption during the review gate leaves the author's work fully committed — there
  // is nothing left to finish in its session. Recover (and re-review) the leftover commits
  // via a fresh tick instead: continuing the author session would burn a run on finished
  // work, and any uncommitted edits are the reviewer's stray output, discarded by the fresh
  // path's reset below.
  const resumeBlocked = s.phase === "review";
  const resuming = resumableSession && !resumeBlocked;
  const handingOff = handoff && !resumeBlocked;
  // Reclaim the prompt the interrupted tick re-queued for its resume (src/inbox/pending-prompt.ts):
  // the resumed session still owns that request in its context, so this tick's bookkeeping
  // operates on the queue's copy. A handoff runs a FRESH session, so it does not reclaim — the
  // fresh tick dequeues the re-queued request like any other. Consumed even when this tick does
  // not resume, so a stale record never survives into a later resume.
  opts.pending.reclaimForResume(s, resuming);

  // Why the resume: a named quiet-kill means the last run died on a stalled tool call (the
  // bridge then warns against re-running it unchanged) or on the tick deadline while still
  // making progress (the bridge asks for the smallest finish against the same limit); a
  // cut-off streak means the last run ran out of context and pi compacted the session (the
  // bridge asks for the smallest finish); otherwise a shutdown/crash. A handoff names itself.
  const resumeCause: ResumeCause = handingOff
    ? "handoff"
    : pendingResumeCause ?? ((s.cutOffStreak ?? 0) > 0 ? "cut-off" : "restart");
  let prompt: string | null;
  if (resuming) {
    prompt = buildResumePrompt(opts.role, resumeCause, agent);
  } else {
    const assembled = opts.tickPrompt(agent);
    prompt = assembled === null ? null : handingOff ? buildHandoffPrompt(opts.role, assembled) : assembled;
  }
  if (prompt === null) return null;
  // The raw user prompt a director tick is executing (null for role loops), so an
  // unfulfilled outcome below can re-queue it. Captured before the field is cleared.
  const userPrompt = opts.pending.get();
  return { priorLandingFailure, resuming, handoff: handingOff, resumeCause, prompt, userPrompt };
}
