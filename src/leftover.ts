import { aheadOfMain } from "./git.js";
import { logEvent } from "./events.js";
import type { GateResult } from "./review.js";
import type { PiRunResult, TickResult } from "./types.js";

/** Salvaging commits left on a branch by a previous run whose merge never landed. Split out of
 * loop.ts — which keeps the tick lifecycle around it — because this is a self-contained concern
 * with its own flow (ahead check → recovery review → merge or warn) and its own git surface;
 * the only things it borrows from the loop are identity, the shared review-gate wiring, usage
 * folding into the tick counters, and the loop's shared merge landing so a recovery run folds
 * in like any other pi run. */

/** What recoverLeftover needs from its owning loop: identity, the loop's shared review gate
 * (so a recovery review folds into the same tick counters as an authoring run), usage folding,
 * and the loop's shared merge landing. */
export interface LeftoverContext {
  root: string;
  role: string;
  mainBranch: string;
  /** Run the review gate over everything ahead of main in `wt` (the recovery session). */
  reviewGate(wt: string): Promise<GateResult>;
  /** Fold one pi run's usage into the tick's counters. */
  foldUsage(run: PiRunResult): void;
  /** Land the worktree branch on main with the loop's shared wiring. */
  merge(wt: string, summary: string): Promise<TickResult>;
}

/** Salvage commits left on the branch by a previous run whose merge never landed. Leftovers
 * route through the SAME review gate as fresh ticks — every path that can move a commit into
 * main reviews the full ahead-of-main diff first, so no crash or abort path smuggles
 * unreviewed work in (see src/review.ts). Returns true when the leftover was deliberately
 * left on the branch for re-review (a failed review under the strike cap) so the caller keeps
 * it instead of resetting to main. */
export async function recoverLeftover(ctx: LeftoverContext, wt: string): Promise<boolean> {
  const ahead = await aheadOfMain(wt, ctx.mainBranch).catch(() => 0);
  if (ahead <= 0) return false;
  const gate = await ctx.reviewGate(wt);
  if (gate.run) ctx.foldUsage(gate.run);
  // Shutdown mid-review: fail closed — the commit stays for next time. A reject already reset
  // to main inside the gate; a failure below the strike cap leaves the commit on purpose.
  if (gate.aborted) return true;
  if (gate.decision === "rejected") return false;
  if (gate.decision === "failed") {
    // At/over the strike cap the gate already discarded the leftover — nothing left to keep.
    return (await aheadOfMain(wt, ctx.mainBranch).catch(() => 0)) > 0;
  }
  const result = await ctx.merge(wt, `recovered leftover work from ${ctx.role}`);
  if (result !== "changed") {
    logEvent(ctx.root, {
      loop: ctx.role,
      type: "warning",
      message: `discarding ${ahead} unmergeable leftover commit(s) (${result})`,
    });
  }
  return false; // merged or warned-and-left-to-the-reset: caller resets to main as usual
}
