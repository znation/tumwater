/** The review gate's bounded follow-up turns on the reviewer's own session — split out of
 * review.ts so the gate keeps its decision logic and the session-continuation plumbing lives
 * here. Both turns resume the just-finished review's session with tightly capped budgets and
 * return the run even when it failed, so the caller can honor a shutdown abort and fold the
 * spend; null means there was no session to continue. */
import type { PiRunResult } from "./pi-run-result.js";
import { hasResumableSession } from "./pi.js";
import { reviewRunConfig } from "./config-views.js";
import { warnEvent } from "./events.js";
import { piLogPath, reviewSessionDir } from "./paths.js";
import { buildNoRerunPrompt, buildVerdictRequestPrompt } from "./gate-prompts.js";
import { type ToolCallStart } from "./suite-rerun.js";
import { cappedRequestTimeouts } from "./request-timeouts.js";
import type { ReviewContext } from "./review.js";

/** Hard caps on the VERDICT follow-up turn: it should take one short reply on a warm session,
 * so it never gets the review run's own budget (mirrors LoopPi's SUMMARY-request caps). */
const VERDICT_REQUEST_TIMEOUT_S = 900;
const VERDICT_REQUEST_QUIET_S = 300;

/** One bounded follow-up turn on the reviewer's just-finished session: the shared session
 * guard, capped budgets, and runGatePi wiring behind requestVerdict and requestNoRerun —
 * exactly two call sites, differing only in prompt, session name, label, and (the nudge only)
 * a started-tool-call collector. Null when there is no session to continue. */
async function runFollowupTurn(
  ctx: ReviewContext,
  opts: {
    prompt: string;
    sessionName: string;
    label: string;
    onToolCallStart?: (toolName: string, args: unknown) => void;
  },
): Promise<PiRunResult | null> {
  const sessionDir = reviewSessionDir(ctx.root, ctx.role);
  if (!hasResumableSession(sessionDir)) return null;
  const cfg = reviewRunConfig(ctx.config);
  return ctx.runGatePi({
    cwd: ctx.wt,
    prompt: opts.prompt,
    config: {
      ...cfg,
      ...cappedRequestTimeouts(cfg, VERDICT_REQUEST_TIMEOUT_S, VERDICT_REQUEST_QUIET_S),
    },
    sessionDir,
    // The whole point: continue the just-finished review's session, which already holds
    // everything the reviewer read and concluded.
    continueSession: true,
    sessionName: opts.sessionName,
    rawLogFile: piLogPath(ctx.root, ctx.role),
    label: opts.label,
    signal: ctx.signal,
    onToolCallStalled: (message) => warnEvent(ctx.root, ctx.role, message),
    ...(opts.onToolCallStart ? { onToolCallStart: opts.onToolCallStart } : {}),
  });
}

/** Ask the reviewer's own session (--continue) for the missing VERDICT line: one tightly
 * bounded turn on the just-finished review's session, mirroring LoopPi.requestSummary on the
 * author side (BUGS.md 2026-09-29). Null when there is no session to continue — the caller
 * then counts the strike exactly as before. The run is returned even when it failed so the
 * caller can honor a shutdown abort and fold the spend. */
export async function requestVerdict(ctx: ReviewContext): Promise<PiRunResult | null> {
  return runFollowupTurn(ctx, {
    prompt: buildVerdictRequestPrompt(),
    sessionName: `tumwater-review-${ctx.role}-${ctx.tick}-verdict`,
    label: "review-verdict",
  });
}

/** The suite-rerun nudge (BUGS.md 2026-10-02): the reviewer broke the no-re-run rule, so one
 * tightly bounded turn on the just-finished review's session names the exact tool call and
 * asks it to finish without re-running. Mirrors requestVerdict (same caps); `calls` collects
 * the nudge turn's own started tool calls so the caller can detect a repeat. Null when there
 * is no session to continue — the caller then has no repeat evidence, only the warning. The
 * run is returned even when it failed so the caller can honor a shutdown abort and fold the
 * spend. */
export async function requestNoRerun(
  ctx: ReviewContext,
  rerun: string,
  calls: ToolCallStart[],
): Promise<PiRunResult | null> {
  return runFollowupTurn(ctx, {
    prompt: buildNoRerunPrompt(rerun),
    sessionName: `tumwater-review-${ctx.role}-${ctx.tick}-rerun`,
    label: "review-rerun",
    // Collected unconditionally: a nudge only runs after a detected rerun, so the no-re-run
    // rule stood and the repeat check below needs every call the nudge started.
    onToolCallStart: (toolName, args) => {
      calls.push({ toolName, args });
    },
  });
}