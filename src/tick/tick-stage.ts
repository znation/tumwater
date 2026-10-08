import type { TumwaterConfig } from "../config/config-schema.js";
import type { TickOutcome } from "./tick-outcome.js";
import type { PiRunResult } from "../pi/pi-run-result.js";
import type { LoopState } from "../loop/loop-state.js";
import { commitAll } from "../git/git.js";
import { changedFiles } from "../git/git-diff.js";
import {
  buildCommitMessage,
  commitTrailer,
  extractCommitBody,
  extractSummary,
  fallbackSummary,
  formatCommitBody,
  mergeCommitBody,
  stampedSubject,
} from "../git/commit-message.js";
import { logEvent } from "../events/events.js";
import { enqueueLanding } from "../landing/landing-queue.js";
import { plural } from "../text/phrases.js";
import { recordFlow } from "./qa-coverage.js";
import { INSTANCE_ROLES, baseRoleOf, configuredInstances } from "../roles/loop-ids.js";
import { stagedMovedEntries } from "../scheduling/claims.js";
import { assignedMovedFinding } from "./stage-check.js";

/** The pi reply's qa flow record, as extracted by reply-contract.ts's extractFlow (its type is
 * module-private there; this mirrors it so the tick staging needs no export from it). */
interface TickFlow {
  flow: string;
  result: "passed" | "bug";
}

/** The shared loop wiring a changed worktree's staging needs (src/loop/loop.ts): the per-tick
 * authoring-run counters as a snapshot, plus the callbacks that touch the loop — warnings,
 * the summary follow-up run, the pre-queue self-check with its fix-up run, the landing-ref pin,
 * and the abort finalizer. Mirrors the context-object shapes of leftover.ts, refusal.ts, and
 * landing-core.ts. */
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
  /** The revision round this tick holds the rejected diff for (plans/revise-rejected.md), or
   * undefined when the tick is not a revision. Set by loop.ts only when the revision was applied
   * this tick (or a resume carried its already-applied edits), never read from `state.revision`:
   * a per-role user-request tick leaves that field set by design. */
  revisionRound?: number;
  /** The branch main's name, for the staged-moved-entry comparison's merge-base (part 4/7).
   * Optional so callers that never staged a backlog move (and older tests) keep compiling;
   * loop.ts always supplies it. */
  mainBranch?: string;
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
  /** The landing gate's deterministic backlog checks over the uncommitted change. */
  stageCheck(wt: string): Promise<string[]>;
  /** One bounded follow-up turn in the still-open session, to fix the self-check's findings. */
  requestStageFix(wt: string, findings: string[]): Promise<PiRunResult | null>;
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
  // A revision tick carries the round it applied on its context (loop.ts): it rides onto the
  // queued landing so a rejection of this change records the NEXT round (plans/revise-rejected.md).
  // Undefined for a fresh change — including a user-request tick that leaves a pending revision
  // untouched — so only the tick that actually held the rejected diff is labeled a revision.
  const revisionRound = ctx.revisionRound;
  // A revision landing carries the review that rejected the change (plans/revise-rejected.md
  // part 2/2): the prior head and its numbered objections ride the queued entry so the re-review
  // can check each one against the interdiff. Only a tick that actually held the rejected diff
  // attaches it; a fresh change — including a user-request tick that leaves a pending revision
  // untouched — and a recovery landing carry none.
  const priorReview =
    revisionRound !== undefined && s.lastReview?.head
      ? { sha: s.lastReview.head, reasons: s.lastReview.reasons }
      : undefined;
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
          : followUp && !followUp.ok
            ? `the follow-up run failed (${followUp.errorMessage || "no error message"}); ` +
              `subject derived from the changed files: "${summary}"`
            : followUp
              ? `follow-up gave none; subject derived from the changed files: "${summary}"`
              : `no follow-up session was available; subject derived from the changed files: "${summary}"`),
    );
  }

  // The gate's deterministic backlog checks run here, before the commit, while the authoring
  // session can still be continued: a finding that reaches review costs a queue slot, a vet,
  // and a rejection that discards the work. One bounded follow-up turn on the author's own
  // session gets to fix them; the gate still has the final say, and the change commits and
  // queues either way.
  // Claims made at staging (plans/parallel-work-instances.md "Claims", part 4/7): an
  // unassigned tick of a MULTI-instance base whose diff moved a backlog entry out of its
  // actionable section records the claim so a sibling is not assigned it while this change
  // lands. A single-runner base has no sibling to hold the entry from, so it stages nothing
  // and is unchanged by claims. An assigned tick that moved a DIFFERENT entry gets a finding,
  // so the one fix-up turn can put it back. An unreadable file or git hiccup yields no move
  // and no finding.
  const moved =
    ctx.mainBranch &&
    INSTANCE_ROLES.has(baseRoleOf(ctx.role)) &&
    configuredInstances(ctx.config, ctx.role) > 1
      ? await stagedMovedEntries(ctx.wt, ctx.mainBranch, ctx.role).catch(() => [])
      : [];
  if (moved.length > 0 && s.claim === undefined) {
    const first = moved[0]!;
    s.claim = { file: first.file, key: first.key, title: first.title, at: Date.now(), source: "staged" };
    logEvent(ctx.root, {
      loop: ctx.role,
      type: "claim",
      action: "assigned",
      key: first.key,
      title: first.title,
      source: "staged",
    });
  }
  const assignedMoved = s.claim ? assignedMovedFinding(s.claim.key, moved) : undefined;

  const findings = await ctx.stageCheck(ctx.wt);
  if (assignedMoved) findings.push(assignedMoved);
  if (findings.length > 0) {
    const before = findings.length;
    const fixUp = await ctx.requestStageFix(ctx.wt, findings);
    if (fixUp?.aborted) return ctx.finishAbortedTick();
    if (fixUp) {
      summary = extractSummary(fixUp.finalText) ?? summary;
      // Field-by-field: a fix-up reply need only restate the fields it changed, so the
      // authoring run's other WHY/RISK/VERIFIED lines survive it.
      body = mergeCommitBody(body, extractCommitBody(fixUp.finalText));
    }
    // A fix-up turn may resolve its findings by reverting the whole change. With nothing left
    // in the worktree there is nothing to commit or queue: end the tick no_change here instead
    // of handing a clean tree to commitAll. The worktree is left clean and no pin is taken.
    if ((await changedFiles(ctx.wt)).length === 0) {
      ctx.warn("stage self-check: the follow-up turn left no change; nothing to land");
      return { result: "no_change" };
    }
    const remaining = await ctx.stageCheck(ctx.wt);
    ctx.warn(
      remaining.length === 0
        ? `stage self-check: ${plural(before, "finding")} — fixed by the follow-up turn`
        : `stage self-check: ${plural(before, "finding")}; ${remaining.length} still open, queued for the gate`,
    );
  }

  // Friction as a signal (plans/refusal-and-thrash.md): a changed tick that burned BOTH more
  // than thrashTurns turns and thrashMinutes of wall clock is flagged high-friction —
  // difficulty suggests the work may not fit, so it goes to review marked and leaves a warning
  // event. Requiring both (not either) keeps the absolute turn count from measuring model
  // speed: a fast model emits 40+ turns in a few minutes, which is ordinary work, not
  // difficulty (BUGS.md 2026-09-19). Measured over this tick's main authoring run (a transient
  // retry included via runAuthoringPi), like the trailer; conflict-resolution runs happen later
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
    stampedSubject(baseRoleOf(ctx.role), summary),
    body,
    commitTrailer(
      ctx.role,
      s.ticks,
      authoringTurns,
      s.peakContextTokens,
      highFriction ? minutes : undefined,
      revisionRound,
    ),
  );
  const commit = await commitAll(ctx.wt, message);

  // Pin the commit by its landing ref BEFORE freeing the worktree (invariant 4), then hand it
  // to the land queue: from here on the review gate and the rebase run in a vet's leased pool
  // slot, never in this worktree (plans/merge-queue.md 2/5). A failed pin defers to next-tick
  // recovery — landing without a pin would lose the ref lifecycle this whole flow depends on.
  // The reviewer checks the author's claimed WHY/VERIFIED against the actual diff; no diff
  // reaches main unreviewed.
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
    ...(revisionRound !== undefined ? { revisionRound } : {}),
    ...(priorReview !== undefined ? { priorReview } : {}),
    enqueuedAt: Date.now(),
  });
  // The revision is now in flight: the rejected ref's lifecycle continues in the lander
  // (landing-core.ts), which deletes it when this landing lands and repoints it on a rejection.
  // The round is also stamped on the commit's Revision trailer above, so leftover recovery can
  // rebuild a retriable revision's landing entry with its round when the queue marker is lost.
  if (revisionRound !== undefined) s.revision = undefined;
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
