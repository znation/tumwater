import type { TumwaterConfig } from "./config-schema.js";
import type { TickOutcome } from "./types.js";
import type { PiRunResult } from "./pi.js";
import type { LoopState } from "./loop-state.js";
import { commitAll } from "./git.js";
import { changedFiles } from "./git-diff.js";
import {
  buildCommitMessage,
  commitTrailer,
  extractCommitBody,
  extractSummary,
  fallbackSummary,
  formatCommitBody,
} from "./commit-message.js";
import { logEvent } from "./events.js";
import { enqueueLanding } from "./landing-queue.js";
import { recordFlow } from "./qa-coverage.js";

/** The pi reply's qa flow record, as extracted by reply-contract.ts's extractFlow (its type is
 * module-private there; this mirrors it so the tick staging needs no export from it). */
interface TickFlow {
  flow: string;
  result: "passed" | "bug";
}

/** The shared loop wiring a changed worktree's staging needs (src/loop.ts): the per-tick
 * authoring-run counters as a snapshot, plus the callbacks that touch the loop — warnings,
 * the summary follow-up run, the landing-ref pin, and the abort finalizer. Mirrors the
 * context-object shapes of leftover.ts, refusal.ts, and lander.ts. */
interface TickStageContext {
  root: string;
  role: string;
  state: LoopState;
  config: TumwaterConfig;
  /** Authoring turns folded so far this tick, captured before the commit (friction artifact). */
  tickTurns: number;
  /** The raw user prompt a director tick is executing (null for role loops), so an aborted
   * summary follow-up can finalize through the loop's requeue path. */
  userPrompt: string | null;
  wt: string;
  /** The pi run's final reply text, the summary's source. */
  finalText: string;
  /** When the tick's main authoring run started (runTick's pre-pi capture): the friction
   * measurement's wall-clock base. */
  piStartedAt: number;
  /** The `qa` observer's FLOW record, or null for every other role. */
  flow: TickFlow | null;
  warn(message: string): void;
  /** One bounded follow-up turn in the still-open session, to produce a missing SUMMARY. */
  requestSummary(wt: string): Promise<PiRunResult | null>;
  /** Pin the commit by the role's landing ref, then free the worktree. */
  pinAndReset(wt: string, sha: string): Promise<boolean>;
  /** Finalize an aborted follow-up run through the loop (requeue + worktree reset). */
  finishAbortedTick(): Promise<TickOutcome>;
}

/** Stage a changed worktree for the land queue: derive the commit message from the reply's
 * SUMMARY block (one bounded follow-up turn when the run left none), flag high-friction ticks,
 * commit, pin the commit by the role's landing ref, and enqueue the landing. Extracted from
 * LoopRunner.runTick so the tick's own method stays the outcome classifier and this module is
 * the commit-staging layer — the only place a fresh tick's work becomes a queued landing.
 * Returns the tick's outcome; a failed pin or an aborted follow-up returns an error/aborted
 * outcome without anything queued. */
export async function stageTickLanding(ctx: TickStageContext): Promise<TickOutcome> {
  const s = ctx.state;
  // The commit subject and body come from the reply's closing block. A run that changed files
  // without one — a cut-off final message, or plain non-compliance — gets one bounded follow-up
  // turn in its own session to produce it (the session still holds everything the run did);
  // only if that too yields nothing is the subject derived from the changed paths.
  let summary = extractSummary(ctx.finalText);
  let body = extractCommitBody(ctx.finalText);
  if (summary === null) {
    const followUp = await ctx.requestSummary(ctx.wt);
    if (followUp?.aborted) return ctx.finishAbortedTick();
    if (followUp) {
      summary = extractSummary(followUp.finalText);
      body = body ?? extractCommitBody(followUp.finalText);
    }
    if (summary === null) summary = fallbackSummary(await changedFiles(ctx.wt), ctx.role, s.ticks);
    ctx.warn(
      `reply had no SUMMARY line — ` +
        (followUp && extractSummary(followUp.finalText) !== null
          ? "recovered it with a follow-up turn"
          : `follow-up gave none; subject derived from the changed files: "${summary}"`),
    );
  }

  // Friction as a signal (plans/refusal-and-thrash.md): a changed tick that burned BOTH more
  // than thrashTurns turns and thrashMinutes of wall clock is flagged high-friction —
  // difficulty suggests the work may not fit, so it goes to review marked and leaves a warning
  // event. Requiring both (not either) keeps the absolute turn count from measuring model
  // speed: a fast model emits 40+ turns in a few minutes, which is ordinary work, not
  // difficulty (BUGS.md 2026-09-19). Measured over this tick's main authoring run (a transient
  // retry included via runRolePi), like the trailer; conflict-resolution runs happen later
  // inside merge().
  const minutes = (Date.now() - ctx.piStartedAt) / 60_000;
  // Friction is measured over this tick's authoring runs only — the review gate folds its
  // run into tickTurns AFTER the commit, so every friction artifact (flag, warning event,
  // trailer line, final summary) reads this pre-gate snapshot instead of the live counter.
  const authoringTurns = ctx.tickTurns;
  const highFriction =
    authoringTurns > ctx.config.thrashTurns && minutes > ctx.config.thrashMinutes;
  if (highFriction) {
    ctx.warn(
      `high-friction tick: ${authoringTurns} turns in ${Math.round(minutes)} min ` +
        `(thresholds: ${ctx.config.thrashTurns} turns / ${ctx.config.thrashMinutes} min)`,
    );
  }
  // The trailer is harness-stamped truth: turns and peak ctx over this tick's pre-commit
  // runs only (conflict-resolution and review runs fold after the commit). A high-friction
  // tick appends its Friction line here — both values are already computed above.
  const message = buildCommitMessage(
    `tumwater(${ctx.role}): ${summary}`,
    body,
    commitTrailer(ctx.role, s.ticks, authoringTurns, s.peakContextTokens, highFriction ? minutes : undefined),
  );
  const commit = await commitAll(ctx.wt, message);

  // Pin the commit by its landing ref BEFORE freeing the worktree (invariant 4), then hand it
  // to the land queue: from here on the review gate and the rebase run in _land-<role>, never
  // in this worktree (plans/merge-queue.md 2/5). A failed pin defers to next-tick recovery —
  // landing without a pin would lose the ref lifecycle this whole flow depends on. The
  // reviewer checks the author's claimed WHY/VERIFIED against the actual diff; no diff reaches
  // main unreviewed.
  if (!(await ctx.pinAndReset(ctx.wt, commit))) {
    s.lastError = "failed to pin the landing ref; left for next-tick recovery";
    return { result: "error", summary: s.lastError };
  }

  // The commit is pinned and the worktree is free: enqueue the landing and END the tick — the
  // orchestrator drains the queue on its single landing slot, outside the author semaphore, so
  // this slot is free the moment the work is committed (plans/merge-queue.md 3/5). The landing
  // runs the same gate + landing flow through runLandingPi/foldLandingUsage on this same state
  // object — recording the commit count, the outcome, and the reviewer spend into it — and logs
  // landed/land_failed; a non-terminal outcome keeps the pin for next-tick leftover recovery.
  // `commits` was NOT incremented above: it counts landed changes only.
  enqueueLanding(ctx.root, {
    role: ctx.role,
    sha: commit,
    tick: s.ticks,
    summary,
    body: body ? formatCommitBody(body) : undefined,
    highFriction: highFriction || undefined,
    enqueuedAt: Date.now(),
  });
  logEvent(ctx.root, { loop: ctx.role, type: "land_queued", commit, summary });
  // The flag's durable record is the Friction trailer line stamped on the commit above;
  // lastSummary and the tick_end event carry it too for dashboards and logs.
  const finalSummary = highFriction
    ? `${summary} (high friction: ${authoringTurns} turns / ${Math.round(minutes)}m)`
    : summary;
  if (ctx.flow)
    recordFlow(
      ctx.root,
      ctx.flow.flow,
      ctx.flow.result,
      ctx.flow.result === "bug" ? summary : undefined,
    );
  return { result: "queued", summary: finalSummary, commit, highFriction };
}
