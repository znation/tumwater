/** The UNFULFILLED-VERDICT half of a finished pi run's classification (see loop.ts's
 * handlePiResult for the seam): everything that decides a run left nothing landable — abort,
 * config request, quiet kill, timeout, refusal, failure without changes, or no change at all —
 * with the staging handoff (src/tick/tick-stage.ts) staying on the runner. Returns null when the
 * run IS fulfillable, which loop.ts answers with stageTickLanding. Split out of loop.ts so the
 * runner keeps only its plumbing (state saves, prompt assembly, the pi wiring) and the verdict
 * tree reads next to its sibling outcome modules (tick-outcome, tick-apply, tick-stage). */
import type { LoopState } from "../loop/loop-state.js";
import type { PiRunResult } from "../pi/pi-run-result.js";
import type { TickOutcome } from "./tick-outcome.js";
import type { FlowResult } from "../verdict/reply-contract.js";
import type { PendingPrompt } from "../pending-prompt.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";
import { isDirty } from "../git/git.js";
import { applyConfigRequest } from "../config/config-write.js";
import { diagnoseNoChange } from "../verdict/no-change.js";
import { handleRefusal, refusalContradiction } from "../verdict/refusal.js";
import { extractSummary } from "../commit-message.js";
import { recordFlow } from "./qa-coverage.js";

interface TickVerdictContext {
  root: string;
  role: string;
  mainBranch: string;
  /** The loop's live state object — mutated in place (`lastError`), not swapped. */
  state: LoopState;
  /** The dequeued prompt's requeue policy (src/pending-prompt.ts): unfulfilled outcomes
   * re-queue the raw director request through it. */
  pending: PendingPrompt;
  /** Assistant turns folded into this tick so far — the same field handleRefusal reads. */
  turns: number;
  /** The raw director prompt this tick is executing (null for role loops). */
  userPrompt: string | null;
  wt: string;
  pi: PiRunResult;
  flow: FlowResult | null;
  warn(message: string): void;
  /** Land the worktree branch on main with the loop's shared wiring (refusal-note landings). */
  merge(wt: string, summary: string): Promise<TickOutcome["result"]>;
  finishAbortedTick(): Promise<TickOutcome>;
}

/** Classify what the finished run left behind; null means the run is fulfillable and staging
 * should take over. Never throws: every branch returns an outcome, recording what went wrong
 * in `state.lastError` or a warning event. */
export async function resolveTickVerdict(ctx: TickVerdictContext): Promise<TickOutcome | null> {
  const { pi, state: s } = ctx;
  // A killed run (shutdown or timeout) may leave half-done edits; never commit those.
  // The next tick's reset discards them.
  if (pi.aborted) return ctx.finishAbortedTick();
  ctx.pending.clear();
  // Harness-mediated config writes (plans/portability.md §3/7): the director may have left a
  // config request in its worktree. Consume it here — after the abort return (a deliberate
  // abort still discards an unfulfilled request) and before every staging path (quiet-kill,
  // timeout, refusal, isDirty, commitAll) — so the request file never enters a diff or a
  // review prompt, and a quiet-killed/timeout re-run starts clean instead of losing the
  // request to the reset. Applied names are announced by the orchestrator's ~2 s live reload
  // (one config_changed event naming the keys); this tick logs only the rejection paths.
  if (ctx.role === DIRECTOR_ROLE) {
    const request = applyConfigRequest(ctx.root, ctx.wt);
    if (request) {
      if (request.error) ctx.warn(`config request rejected: ${request.error}`);
      if (request.ignored.length)
        ctx.warn(
          `config request ignored key(s): ${request.ignored.join(", ")} — only customLoops is accepted`,
        );
    }
  }
  if (pi.quietKilled) {
    // A hung tool call, not a slow run: the session and the worktree's edits are intact.
    // Preserve both — applyTickOutcome resumes them promptly like an interruption instead of
    // leaving hours of work for the next tick's reset to discard. Director ticks never resume;
    // their prompt goes back to the inbox to run fresh, as on any other unfulfilled kill.
    s.lastError = pi.errorMessage ?? "killed as hung";
    ctx.pending.requeueForResume(s, ctx.userPrompt);
    return { result: "quiet_killed" };
  }
  if (pi.timedOut && pi.timedOutProgressing) {
    // The deadline fired on a run still making progress: a slow run, not a failed one, and
    // the slow run is exactly the case where discarding costs the most (BUGS.md 2026-09-29:
    // 97 timeouts in 8 hours, ~55 agent-hours discarded). Handle it the way a quiet kill is
    // handled — keep the session and the worktree's edits, resume promptly, bounded by the
    // same quiet-kill streak — while a run with no recent progress keeps the discard path
    // below. Director ticks never resume; requeueForResume re-queues their prompt
    // fresh (src/pending-prompt.ts), and applyTickOutcome schedules the immediate retry
    // without a resume.
    s.lastError = pi.errorMessage ?? "timed out while still making progress";
    ctx.pending.requeueForResume(s, ctx.userPrompt);
    return { result: "quiet_killed", resumeCause: "timeout" };
  }
  if (pi.timedOut) {
    s.lastError = pi.errorMessage ?? "timed out";
    // The request never ran to completion and no work landed: put it back so the next
    // tick retries it. (A killed run's half-done edits are discarded by the reset.)
    ctx.pending.requeueUnfulfilled(ctx.userPrompt);
    return { result: "error" };
  }

  // A refusal is a decision, not a failure: even when pi's exit was abnormal, the sentinel
  // and any note it left are the run's verdict — classify what it left behind (src/verdict/refusal.ts).
  if (pi.refused) {
    // A refusal contradicted by its own reply — a SUMMARY beside non-markdown work — is
    // surfaced, not obeyed: the work is finished output a discard would destroy, so the
    // normal flow keeps it and the review gate judges it (BUGS.md 2026-09-23).
    const contradicted = await refusalContradiction(ctx.wt, pi.finalText);
    if (contradicted.length > 0) {
      ctx.warn(
        `refusal contradicted by its own reply: SUMMARY beside non-markdown work ` +
          `(${contradicted.slice(0, 3).join(", ")}) — keeping the work; the normal flow judges it`,
      );
    } else {
      return handleRefusal(
        {
          role: ctx.role,
          mainBranch: ctx.mainBranch,
          turns: ctx.turns,
          merge: (w, sum) => ctx.merge(w, sum),
        },
        s,
        ctx.wt,
        pi,
      );
    }
  }

  const changed = await isDirty(ctx.wt);
  if (!pi.ok && !changed) {
    s.lastError = pi.errorMessage ?? "pi failed";
    // No work landed, so the request was not fulfilled: re-queue it. A no_change outcome
    // IS fulfillment (a question-type prompt answered without file changes) — never
    // re-queue that, or such prompts would loop forever.
    ctx.pending.requeueUnfulfilled(ctx.userPrompt);
    return { result: "error" };
  }
  if (!changed) {
    // No sentinel anywhere in the reply is either non-compliance or truncation —
    // diagnoseNoChange (src/verdict/no-change.ts) tells which, so the warning event below is
    // diagnosable on its own.
    const diagnosis = diagnoseNoChange(pi);
    if (!pi.nothingToDo) {
      ctx.warn(
        `pi finished without changes and without declaring nothing-to-do` +
          (diagnosis.notes.length ? ` (${diagnosis.notes.join(", ")})` : ""),
      );
    }
    // A cut-off run did real work and was NOT fulfilled: a director prompt goes back
    // to the inbox to rerun fresh; a role loop resumes the just-compacted session
    // next tick (see the cutOff handling in tick()).
    if (diagnosis.cutOff) ctx.pending.requeueForResume(s, ctx.userPrompt);
    // A cut-off run did real work but was truncated before declaring its outcome: the FLOW
    // line it left mid-stream is not a finished verdict, so recording it would advance the
    // rotation past a check that did not complete. Only a run that was not cut off records.
    if (ctx.flow && !diagnosis.cutOff)
      recordFlow(
        ctx.root,
        ctx.flow.flow,
        ctx.flow.result,
        ctx.flow.result === "bug" ? extractSummary(pi.finalText) ?? undefined : undefined,
      );
    return { result: "no_change", cutOff: diagnosis.cutOff || undefined };
  }
  return null;
}