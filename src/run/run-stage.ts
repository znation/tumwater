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
  appendSelfCheckNotes,
  formatCommitBody,
  stampedSubject,
} from "../git/commit-message.js";
import type { StagedDescription } from "../prompt/gate-prompts.js";
import { logEventBestEffort } from "../events/events.js";
import { queuedMerges } from "../merge/merge-queue.js";
import type { PriorReview } from "../merge/merge-queue.js";
import type { MergeClaim } from "../merge/merge-withdrawn.js";
import { hasUnmergedPin } from "../runner/runner-leftover.js";
import { plural } from "../text/phrases.js";
import { squash, errorMessage } from "../text/text.js";
import { formatDate } from "../text/datetime.js";
import { recordDismissedFiling, recordDismissedFlow, recordDismissedRemote } from "./run-dismiss.js";
import { INSTANCE_ROLES, baseRoleOf, configuredInstances } from "../roles/runner-ids.js";
import { stagedMovedEntries } from "../scheduling/claims.js";
import { entryKey } from "../backlog/backlog-parts.js";
import { assignedMovedFinding, heldMovedFinding } from "../stage/stage-backlog-checks.js";
import { archiveNewFinishedEntries } from "../backlog/backlog-archive.js";
import { fileBugsOnMain } from "../backlog/backlog-file-bugs.js";

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

/** The cap on a filed finding's title: enough to name a finding (a policy scan names its file
 * and line) while keeping the heading readable; the full finding text rides in the body. */
const SELF_CHECK_FILED_FINDING_CHARS = 120;

/** File one BUGS.md `## Open` entry per self-check finding the one-turn fix-up could not close
 * and reverted the whole change over (the run ends `no_change` flagged `selfCheckReverted`, with
 * the finding only in the warning event — nothing else surfaces it, so a recurring finding, one
 * of the four repo-wide policy scans say, re-burns the same authoring next run instead of
 * becoming bugfix work). Filed under the merge lock and deduped by the finding's text, so an
 * already-open finding reuses its heading instead of piling up duplicate entries. Best-effort
 * and never throws: a skipped or failed filing warns and keeps the finding in the warning
 * event. */
async function fileUnclosedSelfCheckFindings(ctx: RunStageContext, findings: readonly string[]): Promise<void> {
  const date = formatDate(new Date());
  const entries = findings.map((finding) => {
    const quoted = `"${squash(finding, SELF_CHECK_FILED_FINDING_CHARS)}"`;
    return {
      title: `the stage self-check finding ${quoted} was not closed by the fix-up turn and re-fires each run (filed by tumwater ${date})`,
      body: [
        `- **Symptom:** the pre-queue self-check raised this finding on the run's change; the one-turn fix-up could not close it and reverted the whole change instead, so the run ended \`no_change\` (\`selfCheckReverted\`) and the finding lived only in the run's warning event.`,
        `- **Finding:** \`${squash(finding, SELF_CHECK_FINDING_CHARS)}\``,
        `- **Reproduce:** author a change that trips a pre-queue self-check finding the fix-up resolves by reverting the whole change (clean tree); the run ends \`no_change\` with only the self-check warning carrying the finding.`,
        `- **Cause:** a finding the fix-up could not close was never filed to BUGS.md, so the same finding re-burned the same authoring each run instead of becoming bugfix work.`,
        `- **Fix sketch:** fix the finding's cause — the file and line it names, or the check that raised it — and move this entry to Fixed with a Fix paragraph showing the finding gone.`,
      ].join("\n"),
      ifOpen: (open: string[]) => open.find((t) => t.includes(quoted)),
    };
  });
  try {
    const outcome = await fileBugsOnMain(
      ctx.root,
      entries,
      (appended) => `File ${plural(appended, "stage self-check finding", "stage self-check findings")} in BUGS.md`,
    );
    if (outcome.status === "skipped") {
      ctx.warn(`the stage self-check finding was not filed in BUGS.md (${outcome.reason})`);
    }
  } catch (err) {
    ctx.warn(`the stage self-check finding was not filed in BUGS.md: ${errorMessage(err)}`);
  }
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
  // actually held the rejected diff attaches it from state; a fresh change — including a
  // user-request run that leaves a pending revision untouched — and a recovery whose commit
  // stamps no Prior-review trailer carry none.
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

/** The commit description while `resolveCommitDescription` still has to recover its summary:
 * `summary` stays null until a recovery path fills it. */
interface PendingCommitDescription {
  summary: string | null;
  body: StagedBody;
  summaryDerived: boolean;
}

/** The result of the shared summary follow-up: the aborted-run outcome to return, or the
 * follow-up run (null when the run had no session to continue). */
type SummaryFollowUp = { aborted: RunOutcome } | { followUp: PiRunResult | null };

/** The bounded follow-up turn both recovery paths share: fold the follow-up's commits past the
 * head it started from, and end the run aborted (returning the outcome to surface) when the
 * follow-up aborted, else hand back the follow-up run. */
async function requestSummaryFollowUp(ctx: RunStageContext, over?: number): Promise<SummaryFollowUp> {
  const base = await headOf(ctx.wt, "HEAD");
  const followUp = await ctx.requestSummary(ctx.wt, over);
  await foldAgentCommitsSince(ctx, ctx.wt, base);
  if (followUp?.aborted) return { aborted: await ctx.finishAbortedRun() };
  return { followUp };
}

/** Recover a summary when the reply left none: take the shared follow-up turn, refill `pending`
 * from it, fall back to the changed paths when it still yields none, and warn about the recovery.
 * Returns an outcome only when the follow-up aborted, else `undefined`. */
async function recoverMissingSummary(
  ctx: RunStageContext,
  pending: PendingCommitDescription,
): Promise<RunOutcome | undefined> {
  const result = await requestSummaryFollowUp(ctx);
  if ("aborted" in result) return result.aborted;
  const followUp = result.followUp;
  if (followUp) {
    pending.summary = extractSummary(followUp.finalText);
    pending.body = pending.body ?? extractCommitBody(followUp.finalText);
  }
  if (pending.summary === null) {
    pending.summary = fallbackSummary(await changedFiles(ctx.wt), ctx.role, ctx.state.runs);
    pending.summaryDerived = true;
  }
  ctx.warn(missingSummaryWarning(followUp, pending.summary));
  return undefined;
}

/** The missing-SUMMARY warning's four-way wording: "recovered it with a follow-up turn", or the
 * derived-subject variants naming the follow-up's failure or absence. */
function missingSummaryWarning(followUp: PiRunResult | null, summary: string): string {
  return (
    `reply had no SUMMARY line — ` +
    (followUp && extractSummary(followUp.finalText) !== null
      ? "recovered it with a follow-up turn"
      : followUp && !followUp.ok
        ? `the follow-up run failed (${followUp.errorMessage || "no error message"}); ` +
          `subject derived from the changed files: "${summary}"`
        : followUp
          ? `follow-up gave none; subject derived from the changed files: "${summary}"`
          : `no follow-up session was available; subject derived from the changed files: "${summary}"`)
  );
}

/** Shorten a SUMMARY the cap would cut mid-word: take the shared follow-up turn asking for it
 * restated short, keep the restated subject when it fits, and warn. Returns an outcome only when
 * the follow-up aborted, else `undefined`. */
async function shortenOverCapSummary(
  ctx: RunStageContext,
  pending: PendingCommitDescription,
): Promise<RunOutcome | undefined> {
  const over = summaryOverCap(ctx.finalText);
  if (over === null) return undefined;
  // A SUMMARY the cap would cut mid-word gets one follow-up turn asking for it restated short.
  const result = await requestSummaryFollowUp(ctx, over);
  if ("aborted" in result) return result.aborted;
  const followUp = result.followUp;
  const short = followUp && summaryOverCap(followUp.finalText) === null ? extractSummary(followUp.finalText) : null;
  if (short !== null) {
    pending.summary = short;
    pending.body = pending.body ?? extractCommitBody(followUp!.finalText);
  }
  ctx.warn(
    short !== null
      ? `SUMMARY was ${over} characters — shortened with a follow-up turn`
      : `SUMMARY was ${over} characters — follow-up gave no shorter one; subject truncated`,
  );
  return undefined;
}

/** Derive the commit's subject and body from the reply's SUMMARY block, running one bounded
 * follow-up turn when the reply left none or a SUMMARY the cap would cut mid-word. Returns the
 * aborted-run outcome when a follow-up aborts, otherwise the description. */
async function resolveCommitDescription(ctx: RunStageContext): Promise<StagedCommitDescription | RunOutcome> {
  // The commit subject and body come from the reply's closing block. A run that changed files
  // without one — a cut-off final message, or plain non-compliance — gets one bounded follow-up
  // turn in its own session to produce it (the session still holds everything the run did);
  // only if that too yields nothing is the subject derived from the changed paths.
  const pending: PendingCommitDescription = {
    summary: extractSummary(ctx.finalText),
    body: extractCommitBody(ctx.finalText),
    // True when no reply named the change, so the subject below is derived from its paths.
    summaryDerived: false,
  };
  const outcome =
    pending.summary === null
      ? await recoverMissingSummary(ctx, pending)
      : await shortenOverCapSummary(ctx, pending);
  if (outcome) return outcome;
  return { summary: pending.summary!, body: pending.body, summaryDerived: pending.summaryDerived };
}

/** Run the gate's remaining checks before the commit, giving the author's session
 * one bounded fix-up turn, and end the run `no_change` (flagged `selfCheckReverted`) when the
 * fix-up reverts the whole change (leaving nothing to commit). Returns an outcome only when the
 * run must end early; otherwise mutates `desc.summary`/`desc.body` with any fix-up recovery,
 * exactly as the inline block did. */
async function runStageSelfCheck(
  ctx: RunStageContext,
  desc: StagedCommitDescription,
): Promise<RunOutcome | undefined> {
  // The gate's remaining checks (a protected edit, a leaked credential) run here, before the
  // commit, while the authoring session can still be continued: a finding that reaches review
  // costs a queue slot, a verification, and a rejection that discards the work. One bounded
  // follow-up turn on the author's own session gets to fix them, and the change commits and
  // queues either way.
  const moved = await stagedBacklogMoves(ctx);
  const movedFindings = recordStagedClaims(ctx, moved);
  const findings = await ctx.stageCheck(ctx.wt);
  findings.push(...movedFindings);
  if (findings.length === 0) return undefined;
  return applyStageFixUp(ctx, desc, findings);
}

/** Decide whether this is a claim-staging run and, if so, read the backlog entries its diff moved
 * out of their actionable section (plans/parallel-work-instances.md "Claims", part 4/7). Returns
 * `[]` for every non-claim-staging run and on any unreadable file or git hiccup. */
async function stagedBacklogMoves(ctx: RunStageContext): Promise<
  { file: "PLANS.md" | "BUGS.md"; key: string; title: string }[]
> {
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
  return moved;
}

/** Record the run's staged claim for the first claimable moved entry (when it has none yet) and
 * return the moved-entry findings in the order the inline body pushed them: `assignedMoved`
 * first, then `heldMoved`. */
function recordStagedClaims(
  ctx: RunStageContext,
  moved: readonly { file: "PLANS.md" | "BUGS.md"; key: string; title: string }[],
): string[] {
  const s = ctx.state;
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
  const findings: string[] = [];
  if (assignedMoved) findings.push(assignedMoved);
  if (heldMoved) findings.push(heldMoved);
  return findings;
}

/** Run the author's one bounded fix-up turn over the stage findings, fold its commits, recover
 * `desc.summary`/`desc.body` from the reply, and end the run `no_change` flagged
 * `selfCheckReverted` when the follow-up left the worktree clean; otherwise stage-check again and
 * log the outcome warning. Returns an outcome only when it ends the run early, else `undefined`. */
async function applyStageFixUp(
  ctx: RunStageContext,
  desc: StagedCommitDescription,
  findings: string[],
): Promise<RunOutcome | undefined> {
  const before = findings.length;
  const fixBase = await headOf(ctx.wt, "HEAD");
  const fixUp = await ctx.requestStageFix(ctx.wt, findings, {
    summary: desc.summaryDerived ? null : desc.summary,
    body: desc.body ? formatCommitBody(desc.body) : "",
  });
  await foldAgentCommitsSince(ctx, ctx.wt, fixBase);
  if (fixUp) {
    if (fixUp.aborted) return ctx.finishAbortedRun();
    // The fix-up reply answers the findings, not the change, so it never replaces the
    // change's description (BUGS.md 2026-10-21): its SUMMARY is taken only over a subject
    // derived from the paths, and its RISK/VERIFIED are appended as self-check notes.
    const fixSummary = desc.summaryDerived ? extractSummary(fixUp.finalText) : null;
    if (fixSummary !== null) desc.summary = fixSummary;
    desc.body = appendSelfCheckNotes(desc.body, extractCommitBody(fixUp.finalText));
  }
  // A fix-up turn may resolve its findings by reverting the whole change. With nothing left
  // in the worktree there is nothing to commit or queue: end the run no_change here instead
  // of handing a clean tree to commitAll. The worktree is left clean and no pin is taken, and
  // the outcome is flagged selfCheckReverted so the digest prices the discarded authoring
  // as its own loss cause rather than a quiet idle (BUGS.md 2026-11-08).
  // isDirty, not changedFiles: a `git status` that fails must throw, not read as clean — on
  // 2026-10-21 a spawn failure here ended bugfix-2's 17-minute run no_change and released
  // its edits unpinned; thrown, the run ends unsettled and its next run gets them back.
  if (!(await isDirty(ctx.wt))) {
    logSelfCheckOutcome(
      ctx,
      "stage self-check: the follow-up turn left no change; nothing to land",
      findings,
    );
    // A finding the one-turn fix-up could not close would otherwise live only in the warning
    // event above, so it never reaches BUGS.md and re-burns the same authoring next run
    // (BUGS.md 2026-11-08). File it as open work before the no_change ends the run.
    await fileUnclosedSelfCheckFindings(ctx, findings);
    return { result: "no_change", selfCheckReverted: true };
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
 * subject, the body, and the harness-stamped trailer with the run's revision, claim, prior
 * review and model seam. */
function stagedCommitMessage(
  ctx: RunStageContext,
  desc: StagedCommitDescription,
  revisionRound: number | undefined,
  friction: ReturnType<typeof frictionSnapshot>,
  priorReview: PriorReview | undefined,
  claim: MergeClaim | undefined,
): string {
  const s = ctx.state;
  // The trailer is harness-stamped truth: turns and peak ctx over this run's pre-commit
  // runs only (conflict-resolution and review runs fold after the commit). A high-friction
  // run appends its Friction line here — both values are already computed above. The claim and
  // prior-review trailers ride the same line (commitTrailer) so a pin-only merge can read them
  // back off the commit; each is absent-when-unset, so a routine commit's trailer is unchanged.
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
      claim,
      priorReview,
    ),
  );
}

/** Pin the commit by the role's merge ref and end the run `queued`, or hold the commit on the
 * branch when the role already holds a waiting change (interlock relief). The pin alone is the
 * waiting state — the poll's merge drain (merge-drain.ts) gates and merges it, and its commit
 * trailers (run-stage's commitTrailer, part 3j/7) carry the claim and prior review a pin-only
 * merge reads back — so a changed fresh run writes no queue file; a queue file an older build
 * left is legacy input the same drain merges. Returns
 * `{ heldOnBranch }` when the run may finish queued; an error outcome when the pin fails. */
async function pinAndEnqueueChange(
  ctx: RunStageContext,
  change: { commit: string; summary: string; revisionRound: number | undefined },
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
    // Pin the commit by its merge ref BEFORE freeing the worktree (invariant 4): the pin is the
    // change's whole waiting state, and a failed pin defers to next-run recovery — merge without
    // a pin would lose the ref lifecycle this whole flow depends on. The commit's trailers
    // (the claim and prior review, part 3j/7) are all the poll's drain needs to merge it.
    if (!(await ctx.pinAndReset(ctx.wt, change.commit))) {
      s.lastError = "failed to pin the merge ref; left for the next run's recovery";
      return { result: "error", summary: s.lastError };
    }

    // The revision this run applied is now in flight: its round and prior review ride the
    // commit's trailers (part 3j/7), and the rejected ref's lifecycle continues in the merger
    // (merge-core.ts). A user-request run that left a pending revision for a later run does not
    // apply one here (revisionRound undefined) and keeps it untouched.
    if (change.revisionRound !== undefined) {
      s.revision = undefined;
    }
    // The commit is pinned and the pin is the waiting state; the event is observability, so an
    // unwritable feed must not reject a run whose work is already queued.
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
    recordDismissedFlow(
      ctx,
      ctx.root,
      ctx.flow.flow,
      ctx.flow.result,
      ctx.flow.result === "bug" ? summary : undefined,
    );
  }
  // A feedback run that somehow changed the tree still records its filing, exactly as the
  // qa flow does above — a filing is a result independent of the run leaving files behind.
  if (ctx.filed) {
    recordDismissedFiling(ctx, ctx.root, ctx.filed);
  }
  // No ci parity is recorded here. qa flow and feedback filings above are durable books of
  // their own result, which is why a changed run still files them; but a parity entry says
  // "this main tip is green", and a run that changed the tree has not verified main — its
  // work is not on main until the queued merge lands. Writing it now (with the model-named
  // tip and the pre-merge lock hash) would leave a false `current` if the fix never lands,
  // making the next ci run skip the full suite while main still fails it. The sole recorder
  // of parity is resolveRunVerdict's no_change path, which runs only when main actually
  // passed and nothing needed changing.
  // The remote-CI record IS filed here too: it records what GitHub reported on a pushed sha
  // (plans/remote-ci.md "The ledger"), a fact the run's own diff cannot make false — so a run
  // that committed a fix for a remote red still advances the ledger, stopping the next run
  // from re-fixing the same remote red while this fix waits to merge (recorded on both the
  // no-change and the changed path, unlike parity).
  if (ctx.remote) {
    recordDismissedRemote(ctx, ctx.root, ctx.remote);
  }
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

/** The pi reply's remote-CI record, as extracted by reply-contract.ts's extractRemoteResult
 * and tagged with the target repo (plans/remote-ci.md "The ledger"); mirrored here so the
 * run staging needs no export from reply-contract. */
interface RunRemote {
  repo?: string;
  result: "passed" | "failed" | "pending" | "unavailable";
  sha?: string;
  reason?: string;
}

/** The shared role wiring a changed worktree's staging needs (src/runner/runner-outcome.ts):
 * the per-run authoring-run counters as a snapshot, plus the callbacks that touch the
 * role — warnings, the summary follow-up run, the pre-queue self-check with its fix-up
 * run, the merge-ref pin, and the abort finalizer. Mirrors the context-object shapes of
 * runner-leftover.ts, refusal.ts, and merge-core.ts. */
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
  /** The `ci` observer's REMOTE record, or null for every other role and for a ci run whose
   * prompt carried no Remote CI block (plans/remote-ci.md "The ledger"). Recorded on the
   * changed path too — the record is what GitHub reported on a pushed sha, which the run's
   * own diff cannot make false — so a run that fixes a remote red still advances the ledger. */
  remote: RunRemote | null;
  warn(message: string): void;
  /** One bounded follow-up turn in the still-open session, to produce a missing SUMMARY. */
  requestSummary(wt: string, overLength?: number): Promise<PiRunResult | null>;
  /** The merge gate's remaining checks over the uncommitted change. */
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
  // The backlog entry this run worked rides the commit trailer (the queue entry used to hold it;
  // a user-request run works something else and stamps none) — part 3e/7's pin-only merge reads
  // it back off the commit.
  const claim =
    ctx.state.claim !== undefined && ctx.userPrompt === null
      ? { file: ctx.state.claim.file, key: ctx.state.claim.key, title: ctx.state.claim.title }
      : undefined;
  const message = stagedCommitMessage(ctx, desc, revisionRound, friction, priorReview, claim);
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
    revisionRound,
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
