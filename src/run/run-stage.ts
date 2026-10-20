// vocabulary: plain
import type { TumwaterConfig } from "../config/config-schema.js";
import type { TickOutcome } from "./run-outcome.js";
import type { PiRunResult } from "../pi/pi-run-result.js";
import type { RunnerState } from "../runner/runner-state.js";
import { commitAll, foldCommitsSince, headOf } from "../git/git.js";
import { changedFiles } from "../git/git-diff.js";
import {
  buildCommitMessage,
  commitTrailer,
  extractCommitBody,
  extractSummary,
  summaryOverCap,
  fallbackSummary,
  formatCommitBody,
  mergeCommitBody,
  stampedSubject,
} from "../git/commit-message.js";
import { logEventBestEffort } from "../events/events.js";
import { enqueueMerge, entryRevisionFields } from "../merge/merge-queue.js";
import { plural } from "../text/phrases.js";
import { recordFlow } from "./qa-coverage.js";
import { INSTANCE_ROLES, baseRoleOf, configuredInstances } from "../roles/runner-ids.js";
import { stagedMovedEntries } from "../scheduling/claims.js";
import { entryKey } from "../backlog/backlog-eligibility.js";
import { assignedMovedFinding, heldMovedFinding } from "./stage-check.js";
import { archiveNewFinishedEntries } from "../backlog/backlog-archive.js";

/** The pi reply's qa flow record, as extracted by reply-contract.ts's extractFlow (its type is
 * module-private there; this mirrors it so the tick staging needs no export from it). */
interface TickFlow {
  flow: string;
  result: "passed" | "bug";
}

/** The shared role wiring a changed worktree's staging needs (src/runner/runner-run.ts):
 * the per-tick authoring-run counters as a snapshot, plus the callbacks that touch the
 * role — warnings, the summary follow-up run, the pre-queue self-check with its fix-up
 * run, the merge-ref pin, and the abort finalizer. Mirrors the context-object shapes of
 * leftover.ts, refusal.ts, and merge-core.ts. */
interface TickStageContext {
  /** The trailer's Model line for the seam this tick's authoring run started on; transient
   * retries reuse the same seam. */
  modelLine?: string;
  root: string;
  role: string;
  state: RunnerState;
  config: TumwaterConfig;
  /** Authoring turns folded so far this tick, captured before the commit (friction artifact). */
  tickTurns: number;
  /** The raw user prompt a director tick is executing (null for role runners), so an aborted
   * summary follow-up can finalize through the role's requeue path. */
  userPrompt: string | null;
  /** The revision round this tick holds the rejected diff for (plans/revise-rejected.md), or
   * undefined when the tick is not a revision. Set by runner-run.ts only when the revision was
   * applied this tick (or a resume carried its already-applied edits), never read from
   * `state.revision`: a per-role user-request tick leaves that field set by design. */
  revisionRound?: number;
  /** The branch main's name, for the merge-base of the staged-moved-entry comparison (part 4/7)
   * and of the backlog archive's commit-time sweep. Optional so callers that never staged a
   * backlog move (and older tests) keep compiling; runner-run.ts always supplies it. */
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
  requestSummary(wt: string, overLength?: number): Promise<PiRunResult | null>;
  /** The merge gate's deterministic backlog checks over the uncommitted change. */
  stageCheck(wt: string): Promise<string[]>;
  /** One bounded follow-up turn in the still-open session, to fix the self-check's findings. */
  requestStageFix(wt: string, findings: string[]): Promise<PiRunResult | null>;
  /** Pin the commit by the role's merge ref, then free the worktree. */
  pinAndReset(wt: string, sha: string): Promise<boolean>;
  /** Finalize an aborted follow-up run through the role (requeue + worktree reset). */
  finishAbortedTick(): Promise<TickOutcome>;
}

/** Fold commits an agent run made since `base` into the tick's tree, keeping the harness commit
 * the tick's only one (INV-H1); warns when any were folded. The one home of the fold-and-warn
 * policy and its wording, shared by the two fold sites — the authoring run (runner-run.ts) and
 * this module's follow-up turns — so they cannot drift. */
export async function foldAgentCommitsSince(
  ctx: { warn(msg: string): void },
  wt: string,
  base: string,
): Promise<void> {
  const folded = await foldCommitsSince(wt, base);
  if (folded > 0) ctx.warn(`agent made ${plural(folded, "commit")} during the run; folded into tumwater's commit`);
}

/** Stage a changed worktree for the merge queue: derive the commit message from the reply's
 * SUMMARY block (one bounded follow-up turn when the run left none), flag high-friction ticks,
 * commit, pin the commit by the role's merge ref, and enqueue the merge. Extracted from
 * RoleRunner.runTick so the tick's own method stays the outcome classifier and this module is
 * the commit-staging layer — the only place a fresh tick's work becomes a queued merge.
 * Returns the tick's outcome; a failed pin or an aborted follow-up returns an error/aborted
 * outcome without anything queued. */
export async function stageTickMerge(ctx: TickStageContext): Promise<TickOutcome> {
  const s = ctx.state;
  // A revision tick carries the round it applied on its context (runner-run.ts): it rides onto the
  // queued merge so a rejection of this change records the NEXT round (plans/revise-rejected.md).
  // Undefined for a fresh change — including a user-request tick that leaves a pending revision
  // untouched — so only the tick that actually held the rejected diff is labeled a revision.
  const revisionRound = ctx.revisionRound;
  // A revision merge carries the review that rejected the change (plans/revise-rejected.md
  // part 2/2): the prior head, its numbered objections, and each objection's persistence count
  // ride the queued entry so the re-review can check each one against the interdiff and the next
  // rejection can resolve a `(prior N)` restatement (BUGS.md 2026-10-14). Only a tick that
  // actually held the rejected diff attaches it; a fresh change — including a user-request tick
  // that leaves a pending revision untouched — and a recovery merge carry none.
  const priorReview =
    revisionRound !== undefined && s.lastReview?.head
      ? {
          sha: s.lastReview.head,
          reasons: s.lastReview.reasons,
          ...(s.revision?.reasonCounts?.length ? { counts: s.revision.reasonCounts } : {}),
        }
      : undefined;
  // The commit subject and body come from the reply's closing block. A run that changed files
  // without one — a cut-off final message, or plain non-compliance — gets one bounded follow-up
  // turn in its own session to produce it (the session still holds everything the run did);
  // only if that too yields nothing is the subject derived from the changed paths.
  let summary = extractSummary(ctx.finalText);
  let body = extractCommitBody(ctx.finalText);
  if (summary === null) {
    const base = await headOf(ctx.wt, "HEAD");
    const followUp = await ctx.requestSummary(ctx.wt);
    await foldAgentCommitsSince(ctx, ctx.wt, base);
    if (followUp?.aborted) return ctx.finishAbortedTick();
    if (followUp) {
      summary = extractSummary(followUp.finalText);
      body = body ?? extractCommitBody(followUp.finalText);
    }
    if (summary === null) summary = fallbackSummary(await changedFiles(ctx.wt), ctx.role, s.runs);
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
  } else {
    // A SUMMARY the cap would cut mid-word gets one follow-up turn asking for it restated short.
    const over = summaryOverCap(ctx.finalText);
    if (over !== null) {
      const base = await headOf(ctx.wt, "HEAD");
      const followUp = await ctx.requestSummary(ctx.wt, over);
      await foldAgentCommitsSince(ctx, ctx.wt, base);
      if (followUp?.aborted) return ctx.finishAbortedTick();
      const short = followUp && summaryOverCap(followUp.finalText) === null ? extractSummary(followUp.finalText) : null;
      if (short !== null) {
        summary = short;
        body = body ?? extractCommitBody(followUp!.finalText);
      }
      ctx.warn(
        short !== null
          ? `SUMMARY was ${over} characters — shortened with a follow-up turn`
          : `SUMMARY was ${over} characters — follow-up gave no shorter one; subject truncated`,
      );
    }
  }

  // The gate's deterministic backlog checks run here, before the commit, while the authoring
  // session can still be continued: a finding that reaches review costs a queue slot,
  // a verification, and a rejection that discards the work. One bounded follow-up turn on the
  // author's own session gets to fix them; the gate still has the final say, and the change commits
  // and queues either way.
  // Claims made at staging (plans/parallel-work-instances.md "Claims", part 4/7): an
  // unassigned tick of a MULTI-instance base whose diff moved a backlog entry out of its
  // actionable section records the claim so a sibling is not assigned it while this change
  // merges. A single-runner base has no sibling to hold the entry from, so it stages nothing
  // and is unchanged by claims. An assigned tick that moved a DIFFERENT entry gets a finding,
  // so the one fix-up turn can put it back. So does an unassigned tick that moved an entry a
  // sibling holds (the poll's heldElsewhere, which its prompt listed as off-limits): that entry
  // is never claimed a second time, and the fix-up turn is asked to drop the duplicate work
  // (BUGS.md 2026-10-12). An unreadable file or git hiccup yields no move and no finding.
  const moved =
    ctx.mainBranch &&
    INSTANCE_ROLES.has(baseRoleOf(ctx.role)) &&
    configuredInstances(ctx.config, ctx.role) > 1
      ? await stagedMovedEntries(ctx.wt, ctx.mainBranch, ctx.role).catch(() => [])
      : [];
  const heldBySiblings = new Set(s.claim === undefined ? (s.heldElsewhere ?? []).map(entryKey) : []);
  const heldMoved = heldMovedFinding(heldBySiblings, moved);
  const claimable = moved.filter((m) => !heldBySiblings.has(m.key));
  if (claimable.length > 0 && s.claim === undefined) {
    const first = claimable[0]!;
    s.claim = { file: first.file, key: first.key, title: first.title, at: Date.now(), source: "staged" };
    // The assignment is durable in state before this event; an unwritable feed must not reject
    // the tick and make a claim that did take effect look unapplied (logEventBestEffort).
    logEventBestEffort(ctx.root, {
      source: ctx.role,
      type: "claim",
      action: "assigned",
      key: first.key,
      title: first.title,
      origin: "staged",
    });
  }
  const assignedMoved = s.claim ? assignedMovedFinding(s.claim.key, moved) : undefined;

  const findings = await ctx.stageCheck(ctx.wt);
  if (assignedMoved) findings.push(assignedMoved);
  if (heldMoved) findings.push(heldMoved);
  if (findings.length > 0) {
    const before = findings.length;
    const fixBase = await headOf(ctx.wt, "HEAD");
    const fixUp = await ctx.requestStageFix(ctx.wt, findings);
    await foldAgentCommitsSince(ctx, ctx.wt, fixBase);
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
      `high-friction run: ${authoringTurns} turns in ${Math.round(minutes)} min ` +
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
      s.runs,
      authoringTurns,
      s.peakContextTokens,
      highFriction ? minutes : undefined,
      revisionRound,
      ctx.modelLine,
    ),
  );
  // The backlog archive (plans/backlog-archive.md): an entry this change pasted under PLANS.md's
  // ## Done or BUGS.md's ## Fixed moves to the top of PLANS-DONE.md or BUGS-FIXED.md now, after
  // the self-check and its fix-up turn worked on the tree the author wrote and before the
  // commit, so the review and the merge see the archived form and the live files keep only
  // open work. A failed sweep leaves the entry where the author put it; nothing reads it lost.
  if (ctx.mainBranch) await archiveNewFinishedEntries(ctx.wt, ctx.mainBranch).catch(() => []);
  const commit = await commitAll(ctx.wt, message);

  // Pin the commit by its merge ref BEFORE freeing the worktree (invariant 4), then hand it
  // to the merge queue: from here on the review gate and the rebase run in a verification's
  // leased pool slot, never in this worktree (plans/merge-queue.md 2/5). A failed pin defers to
  // next-tick recovery — merge without a pin would lose the ref lifecycle this whole flow depends
  // on. The reviewer checks the author's claimed WHY/VERIFIED against the actual diff; no diff
  // reaches main unreviewed.
  if (!(await ctx.pinAndReset(ctx.wt, commit))) {
    s.lastError = "failed to pin the merge ref; left for the next run's recovery";
    return { result: "error", summary: s.lastError };
  }

  // The commit is pinned and the worktree is free: enqueue the merge and END the tick — the
  // orchestrator drains the queue on its single merge slot, outside the author semaphore, so
  // this slot is free the moment the work is committed (plans/merge-queue.md 3/5). The merge
  // runs the same gate + merge flow through runMergePi/foldMergeUsage on this same state
  // object — recording the commit count, the outcome, and the reviewer spend into it — and logs
  // merge_done/merge_failed; a non-terminal outcome keeps the pin for next-tick leftover recovery.
  // `commits` was NOT incremented above: it counts merged changes only.
  enqueueMerge(ctx.root, {
    role: ctx.role,
    sha: commit,
    run: s.runs,
    summary,
    body: body ? formatCommitBody(body) : undefined,
    highFriction: highFriction || undefined,
    ...entryRevisionFields({ revisionRound, priorReview }),
    enqueuedAt: Date.now(),
  });
  // The revision is now in flight: the rejected ref's lifecycle continues in the merger
  // (merge-core.ts), which deletes it when this merge merges and repoints it on a rejection.
  // The round is also stamped on the commit's Revision trailer above, so leftover recovery can
  // rebuild a retriable revision's merge entry with its round when the queue marker is lost.
  if (revisionRound !== undefined) s.revision = undefined;
  // The merge sits in the durable queue above and the commit is pinned; the event is
  // observability, so an unwritable feed must not reject a tick whose work is already queued.
  logEventBestEffort(ctx.root, { source: ctx.role, type: "merge_queued", commit, summary });
  // The flag's durable record is the Friction trailer line stamped on the commit above;
  // lastSummary and the run_end event carry it too for dashboards and logs.
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
