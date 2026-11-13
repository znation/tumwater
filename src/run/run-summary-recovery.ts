/** The SUMMARY-recovery layer of a changed run's staging: the reply's closing SUMMARY
 * block, the one bounded follow-up turn that re-asks for a missing or over-cap SUMMARY,
 * and the fold of agent-made commits past it (INV-H1). Its interface to the commit-staging
 * pipeline in run-stage.ts is `resolveCommitDescription` (which returns a
 * `StagedCommitDescription`) and `foldAgentCommitsSince` (the shared fold-and-warn step the
 * authoring run reuses). Everything else in this file is module-private to the recovery
 * paths.
 */
import type { RunOutcome } from "./run-outcome.js";
import type { PiRunResult } from "../pi/pi-run-result.js";
import { headOf, foldCommitsSince } from "../git/git.js";
import { changedFiles } from "../git/git-diff.js";
import {
  extractCommitBody,
  extractSummary,
  summaryOverCap,
  fallbackSummary,
} from "../git/commit-message.js";
import { plural } from "../text/phrases.js";
import type { RunStageContext } from "./run-stage.js";

/** The staged change's commit body, structurally mirroring commit-message.ts's module-private
 * CommitBody (which run-summary-recovery.ts works with structurally rather than naming). */
type StagedBody = {
  why?: string;
  risk?: string;
  verified?: string;
  objections?: { n: number; text: string }[];
} | null;

/** The staged change's commit description as it moves through the stages: the subject, the
 * extracted body, and whether no reply named the change so the subject was derived from paths. */
export interface StagedCommitDescription {
  summary: string;
  body: StagedBody;
  summaryDerived: boolean;
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
export async function resolveCommitDescription(ctx: RunStageContext): Promise<StagedCommitDescription | RunOutcome> {
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


