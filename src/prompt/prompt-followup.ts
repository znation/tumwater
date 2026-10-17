// vocabulary: plain
import { contextBudgetRule } from "./prompt.js";
import { dialectFor } from "./dialect.js";
import { NOTHING_TO_DO, REPLY_ENDINGS, SUMMARY_BLOCK } from "../verdict/reply-contract.js";

/** The prompts that pick a pi session back up where prompt.ts's builders start one: the resume
 * bridge sent into the SAME pi session as an interrupted tick, the summary-recovery follow-up
 * sent into a tick's own session when its reply lacked the closing block, and the cut-off note
 * that carries the same memory into a role's next FRESH tick prompt (assembled by tick-prompt.ts).
 * Split out of prompt.ts — which keeps the tick/director prompt assembly and the shared rule
 * fragments these builders quote verbatim — because a one-turn bridge into a running session is
 * a different concern from declaring a fresh run's full contract, and the tests already read them
 * apart (test/prompt-resume.test.ts, test/prompt-followup.test.ts). The shared fragments are
 * imported, not restated, so the closing contract cannot drift between a fresh prompt and a
 * follow-up. */

/** Why a tick is being resumed: a harness restart interrupted it, it ran out of context (the
 * harness resumes the compacted session — see LoopState.cutOffStreak), a watchdog or the tick
 * deadline killed a still-making-progress run, the budget gate reopened mid-run and the
 * tick was handed back from the fallback to the primary model (PLANS.md 2026-09-30), the
 * subscription usage window rejected the run and the team held claude seams until it reset
 * (plans/agent-backends.md §8, part 6e), the run hit its per-run budget cap and the worktree
 * hands off to the fallback seam (plans/agent-backends.md §7, part 7a/7), or the newest author
 * session belongs to another agent (plans/agent-backends.md "Sessions") — a handoff runs a
 * fresh session over the interrupted run's uncommitted worktree. */
export type ResumeCause = "restart" | "cut-off" | "hung-tool" | "timeout" | "budget-resumed" | "handoff" | "rate-limit" | "budget-capped" | "image-reroute";

/** The shared closing paragraph of the four resume bridges that hand the same task back
 * unchanged (restart, hung-tool, budget-resumed, rate-limit): finish or redo what you started
 * rather than picking a new one. Kept in one place so the wording cannot drift between causes —
 * the cut-off and timeout bridges deliberately phrase their own finish instructions instead. */
const CONTINUE_TASK_BRIDGE = `Continue the SAME task you were working on and finish it. If the work so far turns out to be
unusable, redo it — but stay on this task rather than picking a new one.`;

/** The follow-up prompt for resuming an interrupted tick. It is sent into the SAME pi session as
 * the interrupted run — which already carries the full original prompt, all rules, and the work
 * so far — so it only needs to bridge the gap. The bridge names the real cause: a run cut off at
 * the context ceiling needs to finish with the smallest change and read almost nothing more, not
 * to verify a half-finished tool call. The cut-off bridge carries a numeric re-reading budget
 * because the observed post-compaction behavior was the opposite of "read almost nothing": the
 * model re-read the whole tree and repeated identical reads of one file nine times. */
export function buildResumePrompt(roleId: string, cause: ResumeCause = "restart", agent?: string): string {
  const opening =
    cause === "cut-off"
      ? `Your previous run as the "${roleId}" role ran out of context before it could finish, so
tumwater compacted the session and is continuing it now. Your worktree is exactly as you left it;
what you did so far is summarized above. Do NOT re-read the codebase: trust the summary and
re-check only what you must, in ranges — at most ~10 tool calls of re-reading, and never the same
file twice. Finish the SAME task with the smallest change that completes it. If it cannot be
finished within a fraction of the window, scope it down to what is already complete and coherent,
leave the project working, and stop.`
      : cause === "hung-tool"
        ? `Tumwater killed your previous run as the "${roleId}" role because it made no progress long enough to trip its hang watchdog — almost always one tool call that hung (a command waiting on input, or a scan far wider than intended). That tool call is dead: do not re-run it unchanged. Your worktree is exactly as you left it, and this session carries everything you did so far — verify the effect of anything the killed call was supposed to produce before relying on it, and bound any long-running command (a time limit, a scoped path).

${CONTINUE_TASK_BRIDGE}`
        : cause === "timeout"
          ? `Your previous run as the "${roleId}" role reached tumwater's run time limit while
it was still making progress — a slow run, not a failed one — so tumwater preserved your
worktree and this session and is continuing them now. Finish the SAME task, but budget against
that same limit: make the smallest change that completes the task coherently, verify it, and
stop. Do not restart broad exploration the first run already finished; trust the work so far
and build on it.`
          : cause === "budget-resumed"
            ? `The team's daily budget has reopened, and your previous run as the "${roleId}" role
started on the fallback model — tumwater has moved this session back to the primary model and
is continuing it now. Your worktree is exactly as you left it, and this session carries everything
you did so far.

${CONTINUE_TASK_BRIDGE}`
            : cause === "rate-limit"
              ? `The claude.ai subscription usage window rejected your previous run as the "${roleId}"
role before it could finish, so tumwater held every subscription claude model job until the window
reset. Your worktree is exactly as you left it, and this session carries everything you did so
far. The window has since reset, and tumwater is continuing this session now.

${CONTINUE_TASK_BRIDGE}`
              : `Tumwater was restarted while you (the "${roleId}" role) were mid-run. Your worktree
is exactly as you left it, and this session carries everything you did so far. A tool call that
was executing when the restart hit may not have finished — verify its effect before relying on it.

${CONTINUE_TASK_BRIDGE}`;
  return `${opening} All the original rules
still apply, in particular:
- Do exactly ONE focused task, then stop.
${contextBudgetRule(dialectFor(agent))}
- Never create, amend, or revert git commits — tumwater handles all git operations.
- Your last message is plain text — never a tool call or an announcement of a next step.
${REPLY_ENDINGS}`;
}

/** The bridge for a `handoff` resume (plans/agent-backends.md "Sessions"): the newest session
 * in the worktree's session dir belongs to another agent, so this tick runs a FRESH session —
 * the full assembled tick prompt, plus the one fact a fresh session cannot know: an interrupted
 * run's uncommitted edits are sitting in the worktree. The worktree is NOT reset for a handoff,
 * so the bridge must send the new run to `git diff` before it starts its own work. */
export function buildHandoffPrompt(
  roleId: string,
  tickPrompt: string,
  cause: ResumeCause = "handoff",
  /** Named facts an image-reroute handoff note needs that the cause alone cannot carry: the
   * model the blind run was on and the image file it read. */
  imageReroute?: { from: string; path: string },
): string {
  const note =
    cause === "budget-capped"
      ? `An earlier API-billed claude run of the "${roleId}" role hit its per-run budget cap before it
could finish; its uncommitted edits are in your worktree — review \`git diff\`, then finish or
discard them. This run starts on the model job the daily budget left you.`
      : cause === "image-reroute"
        ? `An earlier run of the "${roleId}" role on ${imageReroute?.from ?? "another model"} stopped
when it read ${imageReroute?.path ?? "an image"}, because that model cannot read images; its
uncommitted edits are in your worktree — review \`git diff\`, then finish or discard them. This
run is on a model that CAN read images, so read the image again.`
        : `An earlier run of the "${roleId}" role on another model was interrupted; its
uncommitted edits are in your worktree — review \`git diff\`, then finish or discard them.`;
  return `${tickPrompt}\n\n${note}`;
}

/** The one-turn follow-up sent into a tick's OWN session (--continue) when the run changed files
 * but its reply carried no SUMMARY line — 73 of the first 670 commits landed as "<role> tick N"
 * because of that, most of them the largest diffs in the repo. The session still holds everything
 * the run did, so one short reply recovers the subject and body the commit deserves; the caller
 * bounds the run tightly and falls back to a diff-derived subject if this too yields nothing. */
export function buildSummaryRequestPrompt(overLength?: number): string {
  if (overLength !== undefined) {
    return `Your final reply's SUMMARY line is ${overLength} characters; the commit subject holds at most 72,
so tumwater would cut it mid-word. Reply now with ONLY the closing block, with the SUMMARY
restated in at most 72 characters — no tool calls, no other text, one line each:
${SUMMARY_BLOCK}`;
  }
  return `Your run changed files in the worktree, but your final reply
did not include the required closing block, so tumwater cannot describe the commit it is about
to make. Reply now with ONLY that block — no tool calls, no other text, one line each:
${SUMMARY_BLOCK}`;
}

/** The note injected into a role's next FRESH tick prompt after its previous run(s) were cut
 * off at the context ceiling without landing anything (the loop gave up resuming — see
 * tick-apply.ts's CUT_OFF_RESUME_LIMIT — or a cut-off director prompt is re-running). The only
 * cross-tick memory that the last attempt was too big for the window. */
export function buildCutOffNote(streak: number): string {
  const runs = streak === 1 ? "run" : `${streak} runs`;
  return `Your previous ${runs} as this role ran out of context before merging anything. Pick a
smaller, more targeted task this time and budget your reading: grep first, read in ranges, cap
command output. If the smallest useful task still needs most of the codebase in view, reply
${NOTHING_TO_DO} instead of starting it.`;
}
