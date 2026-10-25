import type { TumwaterConfig } from "../config/config-schema.js";
import type { RunOutcome } from "./run-outcome.js";
import type { PiRunResult } from "../pi/pi-run-result.js";
import type { RunnerState } from "../runner/runner-state.js";
import { commitAll, foldCommitsSince, headOf, isDirty } from "../git/git.js";
import { changedFiles } from "../git/git-diff.js";
import {
  buildCommitMessage,
  commitTrailer,
  extractCommitBody,
  extractSummary,
  summaryOverCap,
  fallbackSummary,
  formatCommitBody,
  appendSelfCheckNotes,
  stampedSubject,
} from "../git/commit-message.js";
import type { StagedDescription } from "../prompt/gate-prompts.js";
import { logEventBestEffort } from "../events/events.js";
import { enqueueMerge, entryRevisionFields, queuedMerges } from "../merge/merge-queue.js";
import type { PriorReview } from "../merge/merge-queue.js";
import { hasUnmergedPin } from "../runner/leftover.js";
import { plural } from "../text/phrases.js";
import { errorMessage, squash } from "../text/text.js";
import { recordFlow } from "./qa-coverage.js";
import { recordFiled } from "./feedback-filings.js";
import { INSTANCE_ROLES, baseRoleOf, configuredInstances } from "../roles/runner-ids.js";
import { stagedMovedEntries } from "../scheduling/claims.js";
import { entryKey } from "../backlog/backlog-parts.js";
import { assignedMovedFinding, heldMovedFinding } from "./stage-backlog-checks.js";
import { archiveNewFinishedEntries } from "../backlog/backlog-archive.js";

/** The most findings one self-check outcome event carries. */
const SELF_CHECK_LOGGED_FINDINGS = 12;
/** The cap on each logged finding's text. */
const SELF_CHECK_FINDING_CHARS = 300;

/** The findings as the outcome event records them: capped in count and in each text's length. */
function findingDigest(findings: readonly string[]): string[] {
  return findings.slice(0, SELF_CHECK_LOGGED_FINDINGS).map((f) => squash(f, SELF_CHECK_FINDING_CHARS));
}

/** The self-check's outcome warning. It bypasses `ctx.warn` because it carries fields beyond a
 * message (the finding texts, and those still open); the event shape is otherwise the same. */
function logSelfCheckOutcome(
  ctx: RunStageContext,
  message: string,
  findings: readonly string[],
  remaining: readonly string[] = [],
): void {
  logEventBestEffort(ctx.root, {
    source: ctx.role,
    type: "warning",
    message,
    findings: findingDigest(findings),
    ...(remaining.length > 0 ? { open: findingDigest(remaining) } : {}),
  });
}

/** The staged change's commit body, structurally mirroring commit-message.ts's module-private
 * CommitBody (which run-stage.ts works with structurally rather than naming). */
type StagedBody = {
  why?: string;
  risk?: string;
  verified?: string;
  objections?: { n: number; text: string }[];
} | null;

/** The staged change's commit description as it moves through the stages: the subject, the
 * extracted body, and whether no reply named the change so the subject was derived from paths. */
interface StagedCommitDescription {
  summary: string;
  body: StagedBody;
  summaryDerived: boolean;
}

/** The revision context a commit rides onto its queued merge: the round the run applied (and
 * so the NEXT rejection round), and the prior review that rejected the change, when either
 * exists. */
function revisionFields(ctx: RunStageContext): { revisionRound: number | undefined; priorReview: PriorReview | undefined } {
  const s = ctx.state;
  // A revision run carries the round it applied on its context (runner-run.ts): it rides onto the
  // queued merge so a rejection of this change records the NEXT round (plans/revise-rejected.md).
  // Undefined for a fresh change — including a user-request run that leaves a pending revision
  // untouched — so only the run that actually held the rejected diff is labeled a revision.
  const revisionRound = ctx.revisionRound;
  // A revision merge carries the review that rejected the change (plans/revise-rejected.md
  // part 2/2): the prior head, its numbered objections, and each objection's persistence count
  // ride the queued entry so the re-review can check each one against the interdiff and the next
  // rejection can resolve a `(prior N)` restatement (BUGS.md 2026-10-14). Only a run that
  // actually held the rejected diff attaches it; a fresh change — including a user-request run
  // that leaves a pending revision untouched — and a recovery merge carry none.
  const priorReview =
    revisionRound !== undefined && s.lastReview?.head
      ? {
          sha: s.lastReview.head,
          reasons: s.lastReview.reasons,
          ...(s.revision?.reasonCounts?.length ? { counts: s.revision.reasonCounts } : {}),
        }
      : undefined;
  return { revisionRound, priorReview };
}

/** Derive the commit's subject and body from the reply's SUMMARY block, running one bounded
 * follow-up turn when the reply left none or a SUMMARY the cap would cut mid-word. Returns the
 * aborted-run outcome when a follow-up aborts, otherwise the description. */
async function resolveCommitDescription(ctx: RunStageContext): Promise<StagedCommitDescription | RunOutcome> {
  const s = ctx.state;
  // The commit subject and body come from the reply's closing block. A run that changed files
  // without one — a cut-off final message, or plain non-compliance — gets one bounded follow-up
  // turn in its own session to produce it (the session still holds everything the run did);
  // only if that too yields nothing is the subject derived from the changed paths.
  let summary = extractSummary(ctx.finalText);
  let body = extractCommitBody(ctx.finalText);
  // True when no reply named the change, so the subject below is derived from its paths.
  let summaryDerived = false;
  if (summary === null) {
    const base = await headOf(ctx.wt, "HEAD");
    const followUp = await ctx.requestSummary(ctx.wt);
    await foldAgentCommitsSince(ctx, ctx.wt, base);
    if (followUp?.aborted) return ctx.finishAbortedRun();
    if (followUp) {
      summary = extractSummary(followUp.finalText);
      body = body ?? extractCommitBody(followUp.finalText);
    }
    if (summary === null) {
      summary = fallbackSummary(await changedFiles(ctx.wt), ctx.role, s.runs);
      summaryDerived = true;
    }
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
      if (followUp?.aborted) return ctx.finishAbortedRun();
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
  return { summary, body, summaryDerived };
}

/** Run the gate's deterministic backlog checks before the commit, giving the author's session
 * one bounded fix-up turn, and end the run `no_change` when the fix-up reverts the whole change
 * (leaving nothing to commit). Returns an outcome only when the run must end early; otherwise
 * mutates `desc.summary`/`desc.body` with any fix-up recovery, exactly as the inline block did. */
async function runStageSelfCheck(
  ctx: RunStageContext,
  desc: StagedCommitDescription,
): Promise<RunOutcome | undefined> {
  const s = ctx.state;
  // The gate's deterministic backlog checks run here, before the commit, while the authoring
  // session can still be continued: a finding that reaches review costs a queue slot,
  // a verification, and a rejection that discards the work. One bounded follow-up turn on the
  // author's own session gets to fix them; the gate still has the final say, and the change commits
  // and queues either way.
  // Claims made at staging (plans/parallel-work-instances.md "Claims", part 4/7): an
  // unassigned run of a MULTI-instance base whose diff moved a backlog entry out of its
  // actionable section records the claim so a sibling is not assigned it while this change
  // merges. A single-runner base has no sibling to hold the entry from, so it stages nothing
  // and is unchanged by claims. An assigned run that moved a DIFFERENT entry gets a finding,
  // so the one fix-up turn can put it back. So does an unassigned run that moved an entry a
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
    // the run and make a claim that did take effect look unapplied (logEventBestEffort).
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
    const fixUp = await ctx.requestStageFix(ctx.wt, findings, {
      summary: desc.summaryDerived ? null : desc.summary,
      body: desc.body ? formatCommitBody(desc.body) : "",
    });
    await foldAgentCommitsSince(ctx, ctx.wt, fixBase);
    if (fixUp?.aborted) return ctx.finishAbortedRun();
    if (fixUp) {
      // The fix-up reply answers the findings, not the change, so it never replaces the
      // change's description (BUGS.md 2026-10-21): its SUMMARY is taken only over a subject
      // derived from the paths, and its RISK/VERIFIED are appended as self-check notes.
      const fixSummary = desc.summaryDerived ? extractSummary(fixUp.finalText) : null;
      if (fixSummary !== null) desc.summary = fixSummary;
      desc.body = appendSelfCheckNotes(desc.body, extractCommitBody(fixUp.finalText));
    }
    // A fix-up turn may resolve its findings by reverting the whole change. With nothing left
    // in the worktree there is nothing to commit or queue: end the run no_change here instead
    // of handing a clean tree to commitAll. The worktree is left clean and no pin is taken.
    // isDirty, not changedFiles: a `git status` that fails must throw, not read as clean — on
    // 2026-10-21 a spawn failure here ended bugfix-2's 17-minute run no_change and released
    // its edits unpinned; thrown, the run ends unsettled and its next run gets them back.
    if (!(await isDirty(ctx.wt))) {
      logSelfCheckOutcome(
        ctx,
        "stage self-check: the follow-up turn left no change; nothing to land",
        findings,
      );
      return { result: "no_change" };
    }
    const remaining = await ctx.stageCheck(ctx.wt);
    logSelfCheckOutcome(
      ctx,
      remaining.length === 0
        ? `stage self-check: ${plural(before, "finding")} — fixed by the follow-up turn`
        : `stage self-check: ${plural(before, "finding")}; ${remaining.length} still open, queued for the gate`,
      findings,
      remaining,
    );
  }
  return undefined;
}

/** Compute the run's friction signal over this run's pre-commit authoring runs: minutes of wall
 * clock and authoring turns, flagged high-friction when BOTH exceed their thresholds. */
function frictionSnapshot(ctx: RunStageContext): { minutes: number; authoringTurns: number; highFriction: boolean } {
  // Friction as a signal (plans/refusal-and-thrash.md): a changed run that burned BOTH more
  // than thrashTurns turns and thrashMinutes of wall clock is flagged high-friction —
  // difficulty suggests the work may not fit, so it goes to review marked and leaves a warning
  // event. Requiring both (not either) keeps the absolute turn count from measuring model
  // speed: a fast model emits 40+ turns in a few minutes, which is ordinary work, not
  // difficulty (BUGS.md 2026-09-19). Measured over this run's main authoring run (a transient
  // retry included via runAuthoringPi), like the trailer; conflict-resolution runs happen later
  // inside merge().
  const minutes = (Date.now() - ctx.piStartedAt) / 60_000;
  // Friction is measured over this run's authoring runs only — the review gate folds its
  // run into runTurns AFTER the commit, so every friction artifact (flag, warning event,
  // trailer line, final summary) reads this pre-gate snapshot instead of the live counter.
  const authoringTurns = ctx.runTurns;
  const highFriction =
    authoringTurns > ctx.config.thrashTurns && minutes > ctx.config.thrashMinutes;
  if (highFriction) {
    ctx.warn(
      `high-friction run: ${authoringTurns} turns in ${Math.round(minutes)} min ` +
        `(thresholds: ${ctx.config.thrashTurns} turns / ${ctx.config.thrashMinutes} min)`,
    );
  }
  return { minutes, authoringTurns, highFriction };
}

/** Build the commit message from the staged description and the friction snapshot: the stamped
 * subject, the body, and the harness-stamped trailer with the run's revision and model seam. */
function stagedCommitMessage(
  ctx: RunStageContext,
  desc: StagedCommitDescription,
  revisionRound: number | undefined,
  friction: ReturnType<typeof frictionSnapshot>,
): string {
  const s = ctx.state;
  // The trailer is harness-stamped truth: turns and peak ctx over this run's pre-commit
  // runs only (conflict-resolution and review runs fold after the commit). A high-friction
  // run appends its Friction line here — both values are already computed above.
  return buildCommitMessage(
    stampedSubject(baseRoleOf(ctx.role), desc.summary),
    desc.body,
    commitTrailer(
      ctx.role,
      s.runs,
      friction.authoringTurns,
      s.peakContextTokens,
      friction.highFriction ? friction.minutes : undefined,
      revisionRound,
      ctx.modelLine,
    ),
  );
}

/** Pin the commit by the role's merge ref and enqueue the merge, or hold it on the branch when
 * the role already has a queued change or an unmerged pin (interlock relief). Returns
 * `{ heldOnBranch }` when the run may finish queued; an error outcome when the pin fails. */
async function pinAndEnqueueChange(
  ctx: RunStageContext,
  change: {
    commit: string;
    summary: string;
    body: StagedBody;
    highFriction: boolean;
    revisionRound: number | undefined;
    priorReview: PriorReview | undefined;
  },
): Promise<{ heldOnBranch: boolean } | RunOutcome> {
  const s = ctx.state;
  // Interlock relief (plans/interlock-relief.md "The decision"): a role the scheduler admitted
  // while it already has a queued change (parts 3/4) or an unmerged pin holds its new commit on
  // the branch instead of queueing it — the queue's one-entry-per-role cap must hold, and a
  // second pin would share (and fight over) the same merge ref. Pin nothing, enqueue nothing,
  // leave the commit on the branch. The run still ends `queued` — its span, streaks, and the
  // _run_end_ event all behave like any queued run's — but marks `heldOnBranch` so its run_end
  // never joins the earlier change's queued-row verdict (history-queued.ts's resolveQueuedResult
  // returns null on the flag). The commit message, flow/filed records, and friction are
  // unchanged; only the pin/enqueue block is skipped.
  const heldOnBranch =
    queuedMerges(ctx.root).some((e) => e.role === ctx.role) ||
    (await hasUnmergedPin(ctx.root, ctx.role));

  if (!heldOnBranch) {
    // Pin the commit by its merge ref BEFORE freeing the worktree (invariant 4), then hand it
    // to the merge queue: from here on the review gate and the rebase run in a verification's
    // leased pool slot, never in this worktree (plans/merge-queue.md 2/5). A failed pin defers
    // to next-run recovery — merge without a pin would lose the ref lifecycle this whole flow
    // depends on. The reviewer checks the author's claimed WHY/VERIFIED against the actual diff;
    // no diff reaches main unreviewed.
    if (!(await ctx.pinAndReset(ctx.wt, change.commit))) {
      s.lastError = "failed to pin the merge ref; left for the next run's recovery";
      return { result: "error", summary: s.lastError };
    }

    // The commit is pinned and the worktree is free: enqueue the merge and END the run — the
    // orchestrator drains the queue on its single merge slot, outside the author semaphore, so
    // this slot is free the moment the work is committed (plans/merge-queue.md 3/5). The merge
    // runs the same gate + merge flow through runMergePi/foldMergeUsage on this same state
    // object — recording the commit count, the outcome, and the reviewer spend into it — and
    // logs merge_done/merge_failed; a non-terminal outcome keeps the pin for next-run leftover
    // recovery. `commits` was NOT incremented above: it counts merged changes only.
    enqueueMerge(ctx.root, {
      role: ctx.role,
      sha: change.commit,
      run: s.runs,
      summary: change.summary,
      body: change.body ? formatCommitBody(change.body) : undefined,
      highFriction: change.highFriction || undefined,
      ...entryRevisionFields({ revisionRound: change.revisionRound, priorReview: change.priorReview }),
      enqueuedAt: Date.now(),
    });
    // The revision is now in flight: the rejected ref's lifecycle continues in the merger
    // (merge-core.ts), which deletes it when this merge merges and repoints it on a rejection.
    // The round is also stamped on the commit's Revision trailer above, so leftover recovery can
    // rebuild a retriable revision's merge entry with its round when the queue marker is lost.
    if (change.revisionRound !== undefined) {
      s.revision = undefined;
    }
    // The merge sits in the durable queue above and the commit is pinned; the event is
    // observability, so an unwritable feed must not reject a run whose work is already queued.
    logEventBestEffort(ctx.root, {
      source: ctx.role,
      type: "merge_queued",
      commit: change.commit,
      summary: change.summary,
    });
  }
  return { heldOnBranch };
}

/** Record the qa flow and feedback filing the run carried, each warned on a failed write (never
 * failing a run whose work is already queued), and return the final summary for the outcome. */
function recordStageRecords(
  ctx: RunStageContext,
  summary: string,
  friction: ReturnType<typeof frictionSnapshot>,
): string {
  // The flag's durable record is the Friction trailer line stamped on the commit above;
  // lastSummary and the run_end event carry it too for dashboards and logs.
  const finalSummary = friction.highFriction
    ? `${summary} (high friction: ${friction.authoringTurns} turns / ${Math.round(friction.minutes)}m)`
    : summary;
  if (ctx.flow) {
    // The merge is already queued and the ledger only orders the qa menu, so a failed write
    // warns rather than failing the run.
    try {
      recordFlow(
        ctx.root,
        ctx.flow.flow,
        ctx.flow.result,
        ctx.flow.result === "bug" ? summary : undefined,
      );
    } catch (err) {
      ctx.warn(`qa flow "${ctx.flow.flow}" not recorded: ${errorMessage(err)}`);
    }
  }
  // A feedback run that somehow changed the tree still records its filing, exactly as the
  // qa flow does above — a filing is a result independent of the run leaving files behind.
  if (ctx.filed) {
    logEventBestEffort(ctx.root, {
      source: ctx.role,
      type: "issue_filed",
      issue: ctx.filed.issue,
      title: ctx.filed.title,
    });
    try {
      recordFiled(ctx.root, ctx.filed.issue, ctx.filed.title);
    } catch (err) {
      ctx.warn(`feedback filing #${ctx.filed.issue} not recorded: ${errorMessage(err)}`);
    }
  }
  // No ci parity is recorded here. qa flow and feedback filings above are durable books of
  // their own result, which is why a changed run still files them; but a parity entry says
  // "this main tip is green", and a run that changed the tree has not verified main — its
  // work is not on main until the queued merge lands. Writing it now (with the model-named
  // tip and the pre-merge lock hash) would leave a false `current` if the fix never lands,
  // making the next ci run skip the full suite while main still fails it. The sole recorder
  // of parity is resolveRunVerdict's no_change path, which runs only when main actually
  // passed and nothing needed changing.
  return finalSummary;
}

/** The pi reply's qa flow record, as extracted by reply-contract.ts's extractFlow (its type is
 * module-private there; this mirrors it so the run staging needs no export from it). */
interface RunFlow {
  flow: string;
  result: "passed" | "bug";
}

/** The pi reply's feedback filing record, as extracted by reply-contract.ts's extractFiled
 * (its type is module-private there; this mirrors it so the run staging needs no export). */
interface RunFiled {
  issue: number;
  title: string;
}

/** The shared role wiring a changed worktree's staging needs (src/runner/runner-outcome.ts):
 * the per-run authoring-run counters as a snapshot, plus the callbacks that touch the
 * role — warnings, the summary follow-up run, the pre-queue self-check with its fix-up
 * run, the merge-ref pin, and the abort finalizer. Mirrors the context-object shapes of
 * leftover.ts, refusal.ts, and merge-core.ts. */
interface RunStageContext {
  /** The trailer's Model line for the seam where this authoring run began; transient
   * retries reuse the same seam. */
  modelLine?: string;
  root: string;
  role: string;
  state: RunnerState;
  config: TumwaterConfig;
  /** Authoring turns folded so far this run, captured before the commit (friction artifact). */
  runTurns: number;
  /** The raw user prompt a director run is executing (null for role runners), so an aborted
   * summary follow-up can finalize through the role's requeue path. */
  userPrompt: string | null;
  /** The revision round this run holds the rejected diff for (plans/revise-rejected.md), or
   * undefined when the run is not a revision. Set by runner-run.ts only when the revision was
   * applied this run (or a resume carried its already-applied edits), never read from
   * `state.revision`: a per-role user-request run leaves that field set by design. */
  revisionRound?: number;
  /** The branch main's name, for the merge-base of the staged-moved-entry comparison (part 4/7)
   * and of the backlog archive's commit-time sweep. Optional so callers that never staged a
   * backlog move (and older tests) keep compiling; runner-run.ts always supplies it. */
  mainBranch?: string;
  wt: string;
  /** The pi run's final reply text, the summary's source. */
  finalText: string;
  /** When the run's main authoring run started (runOnce's pre-pi capture): the friction
   * measurement's wall-clock base. */
  piStartedAt: number;
  /** The `qa` observer's FLOW record, or null for every other role. */
  flow: RunFlow | null;
  /** The `feedback` observer's FILED record, or null for every other role. */
  filed: RunFiled | null;
  warn(message: string): void;
  /** One bounded follow-up turn in the still-open session, to produce a missing SUMMARY. */
  requestSummary(wt: string, overLength?: number): Promise<PiRunResult | null>;
  /** The merge gate's deterministic backlog checks over the uncommitted change. */
  stageCheck(wt: string): Promise<string[]>;
  /** One bounded follow-up turn in the still-open session, to fix the self-check's findings;
   * `change` is the change's description so far, which the turn is told to leave alone. */
  requestStageFix(wt: string, findings: string[], change: StagedDescription): Promise<PiRunResult | null>;
  /** Pin the commit by the role's merge ref, then free the worktree. */
  pinAndReset(wt: string, sha: string): Promise<boolean>;
  /** Finalize an aborted follow-up run through the role (requeue + worktree reset). */
  finishAbortedRun(): Promise<RunOutcome>;
}

/** Fold commits an agent run made since `base` into the run's tree, keeping the harness commit
 * the run's only one (INV-H1); warns when any were folded. The one home of the fold-and-warn
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
 * SUMMARY block (one bounded follow-up turn when the run left none), flag high-friction runs,
 * commit, pin the commit by the role's merge ref, and enqueue the merge. Extracted from
 * RoleRunner.runOnce so the run's own method stays the outcome classifier and this module is
 * the commit-staging layer — the only place a fresh run's work becomes a queued merge.
 * Returns the run's outcome; a failed pin or an aborted follow-up returns an error/aborted
 * outcome without anything queued. */
export async function stageRunMerge(ctx: RunStageContext): Promise<RunOutcome> {
  // A revision run's round and prior review ride the queued merge (revisionFields).
  const { revisionRound, priorReview } = revisionFields(ctx);
  const desc = await resolveCommitDescription(ctx);
  if ("result" in desc) return desc;
  const selfCheck = await runStageSelfCheck(ctx, desc);
  if (selfCheck) return selfCheck;
  const friction = frictionSnapshot(ctx);
  const message = stagedCommitMessage(ctx, desc, revisionRound, friction);
  // The backlog archive (plans/backlog-archive.md): an entry this change pasted under PLANS.md's
  // ## Done or BUGS.md's ## Fixed moves to the top of PLANS-DONE.md or BUGS-FIXED.md now, after
  // the self-check and its fix-up turn worked on the tree the author wrote and before the
  // commit, so the review and the merge see the archived form and the live files keep only
  // open work. A failed sweep leaves the entry where the author put it; nothing reads it lost.
  if (ctx.mainBranch) await archiveNewFinishedEntries(ctx.wt, ctx.mainBranch).catch(() => []);
  const commit = await commitAll(ctx.wt, message);
  const queued = await pinAndEnqueueChange(ctx, {
    commit,
    summary: desc.summary,
    body: desc.body,
    highFriction: friction.highFriction,
    revisionRound,
    priorReview,
  });
  if ("result" in queued) return queued;
  const finalSummary = recordStageRecords(ctx, desc.summary, friction);
  return {
    result: "queued",
    summary: finalSummary,
    commit,
    highFriction: friction.highFriction,
    ...(queued.heldOnBranch ? { heldOnBranch: true } : {}),
  };
}
