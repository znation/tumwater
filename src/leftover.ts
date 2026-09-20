import { aheadOfMain, commitMessage, deleteRef, headOf, isMergedInto, refSha, setRef } from "./git.js";
import { parseCommitMetadata, type CommitMetadata } from "./commit-message.js";
import { logEvent } from "./events.js";
import { landingRefName } from "./paths.js";
import { shortSha } from "./text.js";
import type { TickResult } from "./types.js";

/** Salvaging a commit a previous tick left unlanded (plans/merge-queue.md). Since merge queue
 * 2/5 the role's branch is reset to main the moment its commit is pinned, so the leftover
 * normally lives in `refs/tumwater/landing/<role>`: recovery re-lands that sha through the SAME
 * lander a fresh tick uses (same review gate, same strike cap), so no crash or abort path
 * smuggles unreviewed work into main (invariant 1). A commit with NO pin — a crash in the window
 * between the tick's commit and its pin write, or a failed pin write itself — still sits on the
 * branch ahead of main; recovery adopts that tip into the pin scheme and re-lands it, so
 * invariant 1 holds whether or not the pin survived. Split out of loop.ts — which keeps the
 * tick lifecycle around it — because this is a self-contained concern with its own entry
 * condition and git surface; the only things it borrows from the loop are identity, the
 * worktree (for the no-pin fallback), and the lander wiring so a recovery run folds into the
 * same tick counters as an authoring run. */

/** What recoverLeftover needs from its owning loop: identity, the role's worktree (needed only
 * for the no-pin ahead-of-main fallback), and the lander closure that re-lands a sha through the
 * full gate + landing flow (loop.ts wires it to landChange with the "-recovery" session suffix). */
export interface LeftoverContext {
  root: string;
  role: string;
  mainBranch: string;
  /** The role's worktree — read for the no-pin fallback only. */
  wt: string;
  /** Land `sha` through the shared lander (review gate, rebase, ff-merge). `meta` carries the
   * recovered commit's body + high-friction flag, read back from its message because the
   * authoring run that set them is gone. */
  land(sha: string, meta: CommitMetadata): Promise<TickResult>;
}

/** Re-land a commit a previous tick left unlanded. Entry condition: the landing ref exists and
 * its sha is not yet contained in main — or, with no pin at all, the role's branch is ahead of
 * main (crash between the commit and the pin). A present-but-contained ref is stale — a crash
 * between the ff-merge and the ref deletion — and is deleted without any landing run. Returns
 * null when there was nothing to salvage, otherwise the lander's outcome: the caller discards
 * the pin on a user-aborted recovery (a deliberate stop must not be resurrected by the next
 * tick). Whatever lands or fails, nothing is left on the role's branch — the commit lives in
 * its ref (kept by landChange on every non-terminal outcome) or, unpinned, on the branch until
 * it lands. Never throws for a failed landing — only git-level errors propagate. */
export async function recoverLeftover(ctx: LeftoverContext): Promise<TickResult | null> {
  const ref = landingRefName(ctx.role);
  let sha = await refSha(ctx.root, ref).catch(() => null);
  if (sha) {
    if (await isMergedInto(ctx.root, sha, ctx.mainBranch)) {
      // Stale pin: the work already landed and a crash skipped its un-pinning. Clean it up so
      // the next tick does not re-land what main already holds.
      await deleteRef(ctx.root, ref);
      return null;
    }
  } else {
    // No pin: either nothing was left behind, or a crash landed in the commit→pin window (or
    // the pin write failed) and the commit still sits on the branch ahead of main. Recover that
    // tip too — invariant 1 must hold whether or not the pin survived. An unreadable worktree
    // reads as "no leftover", exactly like a failed ref read: never propagate into the tick.
    const ahead = await aheadOfMain(ctx.wt, ctx.mainBranch).catch(() => 0);
    if (ahead <= 0) return null;
    sha = await headOf(ctx.wt, "HEAD").catch(() => null);
    if (!sha) return null;
    // Adopt the unpinned commit into the pin scheme so every downstream outcome — kept on an
    // under-cap review failure (the strike cap's retry), deleted on reject/land/discard,
    // discarded on a user abort — behaves exactly as for a normally pinned one. A failed
    // adoption is logged and harmless: the landing proceeds anyway, with the branch still
    // holding the commit until the caller's post-recovery reset.
    if (!(await setRef(ctx.root, ref, sha))) {
      logEvent(ctx.root, {
        loop: ctx.role,
        type: "warning",
        message: `failed to adopt unpinned leftover ${shortSha(sha)} into its landing ref`,
      });
    }
  }
  return await ctx.land(sha, await recoveredMetadata(ctx.root, sha));
}

/** The review-gate metadata a pinned leftover commit carries in its own message: its
 * high-friction flag and author's body, or an empty object when the commit predates the
 * contract or the message cannot be read. Recovery lands through the same gate as a fresh
 * tick, so it must present those fields the same way — otherwise a flagged change is silently
 * reviewed as routine (BUGS.md 2026-09-19). */
async function recoveredMetadata(root: string, sha: string): Promise<CommitMetadata> {
  const message = await commitMessage(root, sha);
  return message ? parseCommitMetadata(message) : {};
}
