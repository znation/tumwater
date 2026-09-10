import { changedFiles, commitPathsAndDiscardRest } from "./git.js";
import { resetWorktreeToMain } from "./worktree.js";
import { buildCommitMessage, commitTrailer } from "./commit-message.js";
import type { LoopState, PiRunResult, TickOutcome, TickResult } from "./types.js";

/** Handling a refused tick (plans/refusal-and-thrash.md): the run declined its work and ended
 * with TUMWATER_REFUSED. Only the markdown objection note may land — it is the durable record
 * that blocks the entry for later ticks; any non-markdown half-work is discarded, tracked edits
 * via reset --hard and untracked files via clean -fd (the committed note is safe at HEAD by
 * then). A refusal with no note left resets the worktree cleanly and lets the reason live in
 * the event + lastSummary only. The note commit merges directly: md-only diffs are review-exempt
 * by construction under the gate's exemption patterns, so routing it through the gate would burn
 * nothing but add a failure mode for a record that is not code. Split out of loop.ts — which
 * keeps the tick lifecycle around it — because this is a self-contained concern with its own
 * policy and its own git surface (commit-only-the-notes / reset); the only things it borrows
 * from the loop are identity, the pre-commit counters for the trailer, and the loop's shared
 * merge wiring. */

/** What handleRefusal needs from its owning loop: identity, this tick's assistant-turn count
 * (deliberately not on LoopState — see loop.ts), and the loop's shared merge landing so a
 * conflict-resolution run folds into the same tick counters as an authoring run. */
export interface RefusalContext {
  role: string;
  mainBranch: string;
  /** Assistant turns folded into this tick so far (main + transient retry) — the same field
   * the friction flag reads. */
  turns: number;
  /** Land the worktree branch on main with the loop's shared wiring. */
  merge(wt: string, summary: string): Promise<TickResult>;
}

/** Handle a refused tick and return its outcome. Never throws: a failed note merge is recorded
 * in `state.lastError` and reported through the "refused" result like any other non-landing. */
export async function handleRefusal(
  ctx: RefusalContext,
  state: LoopState,
  wt: string,
  pi: PiRunResult,
): Promise<TickOutcome> {
  const reason = (pi.refusedReason ?? "").trim() || "no reason given";
  const notes = (await changedFiles(wt)).filter((f) => f.toLowerCase().endsWith(".md"));
  let commit: string | undefined;
  if (notes.length > 0) {
    // Subject + trailer only — a refusal carries no WHY/RISK/VERIFIED body; the reason is
    // the subject, and the trailer's turn count is the same field the friction flag reads.
    const message = buildCommitMessage(
      `tumwater(${ctx.role}): refuse — ${reason}`,
      null,
      commitTrailer(ctx.role, state.ticks, ctx.turns, state.peakContextTokens),
    );
    commit = (await commitPathsAndDiscardRest(wt, message, notes)) ?? undefined;
  }
  if (!commit) {
    // No note landed (none left, or nothing stageable): reset and keep the reason in the
    // event + lastSummary only.
    await resetWorktreeToMain(wt, ctx.mainBranch);
    return { result: "refused", summary: reason };
  }
  const result = await ctx.merge(wt, `refused: ${reason}`);
  if (result !== "changed") state.lastError = `refusal note merge failed: ${result}`;
  return { result: "refused", summary: reason, commit };
}
