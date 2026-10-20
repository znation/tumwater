// vocabulary: plain
/** The UNFULFILLED-VERDICT half of a finished pi run's classification (see runner-run.ts's
 * handlePiResultPhase for the seam): everything that decides a run left nothing landable — abort,
 * config request, quiet kill, timeout, refusal, failure without changes, or no change at all —
 * with the staging handoff (src/tick/tick-stage.ts) staying in the tick pipeline. Returns null when
 * the run IS fulfillable, which the pipeline answers with stageTickMerge. Split out of runner.ts so
 * the runner keeps only its plumbing (state saves, prompt assembly, the pi wiring) and the verdict
 * tree reads next to its sibling outcome modules (tick-outcome, tick-apply, tick-stage). */
import type { RunnerState } from "../runner/runner-state.js";
import type { PiRunResult } from "../pi/pi-run-result.js";
import type { TumwaterConfig } from "../config/config-schema.js";
import { imageReroute } from "../agent/image-input.js";
import type { TickOutcome } from "./tick-outcome.js";
import type { FlowResult } from "../verdict/reply-contract.js";
import type { PendingPrompt } from "../inbox/pending-prompt.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";
import { isDirty, deleteRef } from "../git/git.js";
import { applyConfigRequest } from "../config/config-write.js";
import { diagnoseNoChange, extractNoChangeAnswer } from "../verdict/no-change.js";
import { handleRefusal, refusalContradiction } from "../verdict/refusal.js";
import { extractSummary } from "../git/commit-message.js";
import { recordFlow } from "./qa-coverage.js";
import { resetWorktreeToMain } from "../git/worktree.js";
import { readPiListedModels } from "../pi/pi-listed-models.js";
import { rejectedRefName } from "../paths.js";
import { logEventBestEffort } from "../events/events.js";
import { subscriptionWindowRejected } from "../agent/claude/claude-account.js";

interface TickVerdictContext {
  /** The trailer's Model line for the seam this tick ran on (see modelTrailerLine). */
  modelLine?: string;
  root: string;
  role: string;
  mainBranch: string;
  /** The role's live state object — mutated in place (`lastError`), not swapped. */
  state: RunnerState;
  /** The dequeued prompt's requeue policy (src/inbox/pending-prompt.ts): unfulfilled outcomes
   * re-queue the raw director request through it. */
  pending: PendingPrompt;
  /** Assistant turns folded into this tick so far — the same field handleRefusal reads. */
  turns: number;
  /** The raw director prompt this tick is executing (null for role runners). */
  userPrompt: string | null;
  /** The team config, when the caller can provide it, used to resolve an image-reroute
   * target (plans/image-input.md part 4/5). Absent in the unit harness, so those contexts
   * keep the part-3 behavior (a blind read errors) rather than routing to a phantom tier. */
  config?: TumwaterConfig;
  /** Which pair set the image reroute may look among (plans/image-input.md "Reroute target"
   * "Regime"): the primary tiers normally, the free fallback pairs while the budget gate is
   * on fallback or the role is in a model-fallback episode. Defaults to the primary regime. */
  rerouteRegime?: "primary" | "fallback";
  /** The selector string of the model this tick's runs started on — the `from` half of the
   * image_reroute event and the handoff note (the model the blind run was on). */
  runModel?: string;
  /** The revision round this tick holds the rejected diff for (plans/revise-rejected.md), or
   * undefined when the tick is not a revision. A per-role user-request or resume tick leaves
   * `state.revision` set by design but passes undefined here, so the drop branch can never
   * discard a pending revision from a tick that did not apply it. */
  revisionRound?: number;
  wt: string;
  pi: PiRunResult;
  flow: FlowResult | null;
  warn(message: string): void;
  /** Merge the worktree branch on main with the role's shared wiring (refusal-note merges). */
  merge(wt: string, summary: string): Promise<TickOutcome["result"]>;
  finishAbortedTick(): Promise<TickOutcome>;
}

/** Classify what the finished run left behind; null means the run is fulfillable and staging
 * should take over. Never throws: every branch returns an outcome, recording what went wrong
 * in `state.lastError` or a warning event. */
export async function resolveTickVerdict(ctx: TickVerdictContext): Promise<TickOutcome | null> {
  const { pi, state: s } = ctx;
  // A run whose `--resume` target the backend no longer holds records why before any branch
  // returns: the resume guard the next tick consults is the transcript FILE, which can outlive
  // the conversation (a torn/empty file, or the fake's planted one), so this verdict must
  // outrank it. The failed-dirty arm below is the common case, but an aborted, quiet-killed, or
  // progressing-timeout run keeps the same session and arms the same resume (tick-apply.ts), so
  // recording it once here covers every path that resumes (BUGS.md 2026-10-09). Director ticks
  // never resume, so the flag is role-only.
  if (pi.resumeMissing && ctx.role !== DIRECTOR_ROLE) s.resumeMissing = true;
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
          `config request ignored key(s): ${request.ignored.join(", ")} — only customRoles is accepted`,
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
    // fresh (src/inbox/pending-prompt.ts), and applyTickOutcome schedules the immediate retry
    // without a resume.
    s.lastError = pi.errorMessage ?? "timed out while still making progress";
    ctx.pending.requeueForResume(s, ctx.userPrompt);
    return { result: "quiet_killed", resumeCause: "timeout" };
  }
  if (pi.timedOut) {
    s.lastError = pi.errorMessage ?? "timed out";
    // The request never ran to completion and no work merged: put it back so the next
    // tick retries it. (A killed run's half-done edits are discarded by the reset.)
    ctx.pending.requeueUnfulfilled(ctx.userPrompt);
    return { result: "error" };
  }

  // A subscription claude run the usage window rejected is a hold, not a run failure: the
  // team hold keeps every subscription claude seam from starting until `resetsAt`
  // (plans/agent-backends.md §8, part 6c), and this run's session and worktree edits must
  // survive the wait — the next eligible tick resumes them (part 6e) instead of committing
  // partial work or resetting the worktree to main. The rejected-window reading is the
  // signal (subscriptionWindowRejected), so a pi 429, an API-billed run, or an overage
  // window keeps the paths below.
  if (!pi.ok && ctx.role !== DIRECTOR_ROLE && subscriptionWindowRejected(pi)) {
    s.lastError = pi.errorMessage ?? "claude subscription usage window rejected";
    // Arm the resume here rather than in applyTickOutcome: the lease release reads
    // `resumePending` as soon as the tick returns (runTickInLeasePhase), before
    // applyTickOutcome runs, so without this the slot is detached and the edits above are
    // lost. This is the same inline arming the error-dirty arm below does.
    s.resumePending = true;
    ctx.pending.requeueForResume(s, ctx.userPrompt);
    return { result: "error", resumeCause: "rate-limit" };
  }

  // An API-billed claude run cut off at its per-run `--max-budget-usd` cap is a budget
  // handback, not a failed tick: the remaining daily budget is spent, so the run stopped with
  // its session and worktree edits intact. Keep both and let the next tick hand off over the
  // kept worktree (plans/agent-backends.md §7, part 7a/7); the cap is what keeps one runaway
  // run from overshooting the daily cap. `aborted` is the budget-handback result
  // (src/runner/runner-recovery.ts) and schedules the resume promptly.
  if (!pi.ok && ctx.role !== DIRECTOR_ROLE && pi.budgetCapped) {
    s.lastError = pi.errorMessage ?? "claude per-run budget cap reached";
    // Arm the resume here rather than in applyTickOutcome: the lease release reads
    // `resumePending` as soon as the tick returns (runTickInLeasePhase), before
    // applyTickOutcome runs, so without this the slot is detached and the edits are lost.
    s.resumePending = true;
    ctx.pending.requeueForResume(s, ctx.userPrompt);
    return { result: "aborted", resumeCause: "budget-capped" };
  }

  // A run the runner killed the moment its agent read an image its model cannot see
  // (plans/image-input.md "Failing the tick"): pi strips such an image from the request, so
  // the agent was about to answer about a picture it never saw. The run was deliberately
  // stopped before it could work on, so its half-done edits are discarded exactly as a
  // timed-out run's are — nothing to resume, and the prompt re-queues to run fresh on a
  // model that CAN see (part 4 adds the reroute arm here). The error backoff and streak apply
  // as for any error.
  if (pi.imageBlind) {
    // One hop only (plans/image-input.md "Rerunning on a model that can read images"): a
    // tick that ALREADY started on the image-capable target and still read blind is not
    // rerouted a second time — it fails, so a misreadable image cannot bounce the role
    // between tiers forever. Set at tick start by tickPhase when it routes a tick onto the
    // target (blind-read handoff or attachment preflight).
    if (s.imageRerouteActive) {
      s.lastError = pi.errorMessage ?? `read ${pi.imageBlind.path}, but the model cannot read images`;
      // No work was done (the run was killed at the first read): nothing to resume, and the
      // prompt re-queues to run fresh later like any other error. The error backoff/streak
      // apply as usual.
      ctx.pending.requeueUnfulfilled(ctx.userPrompt);
      return { result: "error" };
    }
    // Otherwise, when the role's tier has an image-capable reroute target, the failed work
    // is not discarded: the next tick starts directly on that target over the kept worktree.
    // The one-shot field carries the target seam plus the `from`/`path` facts the handoff
    // note needs; the tick ends `aborted` with the `image-reroute` resume cause, and
    // applyTickOutcome schedules it promptly (nextRunAt = now) while planTickStart hands the
    // kept worktree off to a FRESH session on the target.
    const regime = ctx.rerouteRegime ?? "primary";
    const target =
      ctx.config !== undefined ? imageReroute(ctx.config, ctx.role, regime, undefined, null, undefined, null, readPiListedModels(ctx.root))
        : null;
    if (target) {
      const from = ctx.runModel ?? target.config.model ?? "the model";
      s.imageReroute = {
        tier: target.tier,
        provider: target.config.provider,
        model: target.config.model,
        thinking: target.config.thinking,
        from,
        path: pi.imageBlind.path,
      };
      s.lastError = `read ${pi.imageBlind.path}, but ${from} cannot read images — rerouting to ${target.tier}`;
      ctx.pending.requeueForResume(s, ctx.userPrompt);
      logEventBestEffort(ctx.root, {
        source: ctx.role,
        type: "image_reroute",
        run: s.runs,
        from,
        to: target.config.model,
        tier: target.tier,
        preflight: false,
      });
      return { result: "aborted", resumeCause: "image-reroute" };
    }
    s.lastError = pi.errorMessage ?? `read ${pi.imageBlind.path}, but the model cannot read images`;
    ctx.pending.requeueUnfulfilled(ctx.userPrompt);
    return { result: "error" };
  }

  // A refusal is a decision, not a failure: even when pi's exit was abnormal, the sentinel
  // and any note it left are the run's verdict — classify what it left behind
  // (src/verdict/refusal.ts).
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
          root: ctx.root,
          mainBranch: ctx.mainBranch,
          turns: ctx.turns,
          modelLine: ctx.modelLine,
          merge: (w, sum) => ctx.merge(w, sum),
        },
        s,
        ctx.wt,
        pi,
      );
    }
  }

  const changed = await isDirty(ctx.wt);
  // A failed run that produced no assistant content of its own did nothing to the worktree: a
  // 4xx config error, an auth failure, or a dead backend ends on an assistant message_end with
  // empty `content` and stopReason "error" — one completed turn, zero content — so
  // `producedAssistantContent` stays false, while a run that did real work (tool calls, text)
  // before failing sets it true. On a resume the dirty files are the interrupted tick's
  // half-done edits, which the abort branch above deliberately refuses to commit; staging them
  // would ship unfinished work under a diff-derived subject and drop the resumable session
  // (BUGS.md 2026-10-06). Keep the worktree and session for the next resume.
  if (!pi.ok && (!changed || !pi.producedAssistantContent)) {
    s.lastError = pi.errorMessage ?? "the agent failed";
    // A dirty worktree on a run that added nothing of its own is a prior tick's work: arm the
    // resume so the next tick continues that session instead of resetting the edits. A role
    // runner re-queues through requeueForResume, so the resume reclaims exactly this prompt
    // rather than leaving a duplicate for a later fresh tick to run again (BUGS.md 2026-09-25);
    // the director never resumes, so its prompt always re-runs fresh. A clean worktree has
    // nothing to carry forward, so the plain re-queue still applies.
    if (changed && ctx.role !== DIRECTOR_ROLE) {
      s.resumePending = true;
      ctx.pending.requeueForResume(s, ctx.userPrompt);
    } else {
      // No work merged, so the request was not fulfilled: re-queue it. A no_change outcome
      // IS fulfillment (a question-type prompt answered without file changes) — never
      // re-queue that, or such prompts would loop forever.
      ctx.pending.requeueUnfulfilled(ctx.userPrompt);
    }
    return { result: "error" };
  }
  // A revision tick that declares nothing-to-do drops the rejected change (the revise-rejected plan
  // in PLANS.md): the author judged the objections show the change should not exist, so reset the
  // re-applied diff away, delete the rejected ref, and end no_change without staging anything.
  // Guarded on the tick's own revisionRound, not state.revision: a dirty user-request tick that
  // happens to leave a pending revision untouched must not drop it. Checked before the
  // clean-worktree branch because the re-applied diff can leave the worktree clean — an empty
  // cherry-pick range, or the author reverting the edits while deciding — and the author's
  // NOTHING_TO_DO must end the change anyway, or every later tick re-applies the same rejected
  // diff.
  if (ctx.revisionRound !== undefined && s.revision && pi.nothingToDo) {
    const { sha } = s.revision;
    s.revision = undefined;
    await resetWorktreeToMain(ctx.wt, ctx.mainBranch);
    await deleteRef(ctx.root, rejectedRefName(ctx.role));
    // The drop's durable effects — the worktree reset, the rejected ref's deletion, and the
    // cleared state — have all taken effect; the event is observability, so an unwritable feed must
    // not end the tick as an error and mask a change that really was dropped.
    logEventBestEffort(ctx.root, { source: ctx.role, type: "revision", action: "dropped", round: ctx.revisionRound, sha });
    return { result: "no_change" };
  }
  if (!changed) {
    // No sentinel anywhere in the reply is either non-compliance or truncation —
    // diagnoseNoChange (src/verdict/no-change.ts) tells which, so the warning event below is
    // diagnosable on its own.
    const diagnosis = diagnoseNoChange(pi);
    if (!pi.nothingToDo) {
      ctx.warn(
        `the agent finished without changes and without declaring nothing-to-do` +
          (diagnosis.notes.length ? ` (${diagnosis.notes.join(", ")})` : ""),
      );
    }
    // A cut-off run did real work and was NOT fulfilled: a director prompt goes back
    // to the inbox to rerun fresh; a role runner resumes the just-compacted session
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
    // A prompt-driven (director) tick that answers a question in prose ends `no_change` with
    // no SUMMARY block, so its reply would be lost — the dashboard reads a bare "No change"
    // and the feed carries nothing (BUGS.md 2026-10-14). Keep the prose above the sentinel as
    // the tick's summary so `lastSummary` and the run_end event show the answer where the
    // operator asked the question. A role runner's bare nothing-to-do stays summary-less.
    const summary =
      ctx.userPrompt !== null && !diagnosis.cutOff
        ? (extractNoChangeAnswer(pi.finalText) ?? undefined)
        : undefined;
    return { result: "no_change", cutOff: diagnosis.cutOff || undefined, summary };
  }
  return null;
}
