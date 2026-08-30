import { logEvent } from "./events.js";
import {
  abortSync,
  conflictedFiles,
  continueRebase,
  ffMergeToMain,
  hasConflictMarkers,
  headOf,
  rebaseOntoMain,
  rebaseOntoMainLeaveConflicts,
} from "./git.js";
import { withLock } from "./lock.js";
import { buildConflictPrompt } from "./prompt.js";
import { mergeLockDir } from "./paths.js";
import type { PiRunResult, TickResult } from "./types.js";

/** Landing a tick's worktree branch on main: rebase onto main (keeping history linear),
 * fast-forward, and — when the rebase conflicts — one pi-driven resolution attempt before
 * giving up. Split out of loop.ts — which keeps the tick lifecycle around it — because this is
 * a self-contained concern with its own flow (lock → rebase → ff-merge → conflict retry) and
 * its own git surface; the only things it borrows from the loop are identity (root/role/branch),
 * the current tick number for session naming, and the loop's shared pi wiring so a
 * conflict-resolution run folds into the same tick counters as an authoring run. */

/** What mergeToMain needs from its owning loop: identity, the tick number that names the
 * conflict-resolution session, and the loop's shared pi runner (role config, session dir, raw
 * log, transient-timeout retry) with usage folded into the tick counters — every pi run of a
 * tick lands there exactly once. */
export interface MergeContext {
  root: string;
  role: string;
  mainBranch: string;
  /** The current tick number (names the conflict-resolution pi session). */
  tick: number;
  /** Run one pi run in `wt` with the loop's shared wiring and fold its usage into the tick. */
  runPi(wt: string, prompt: string, sessionName: string): Promise<PiRunResult>;
}

/** Land the worktree branch on main under the shared merge lock: rebase it onto main (keeping
 * history linear) and fast-forward. On conflict, makes one pi-driven resolution attempt
 * (outside the lock) before giving up. A routine conflict is normal operation, not a warning:
 * success lands as an ordinary `merged` event and failure surfaces via the tick's merge_conflict
 * result — no separate log line for the hand-off itself. */
export async function mergeToMain(ctx: MergeContext, wt: string, summary: string): Promise<TickResult> {
  const first = await tryMerge(ctx, wt, summary);
  if (first !== "merge_conflict") return first;
  if (!(await resolveConflict(ctx, wt))) return "merge_conflict";
  return tryMerge(ctx, wt, summary);
}

async function tryMerge(ctx: MergeContext, wt: string, summary: string): Promise<TickResult> {
  return withLock(mergeLockDir(ctx.root), async () => {
    if (!(await rebaseOntoMain(wt, ctx.mainBranch))) return "merge_conflict";
    if (!(await ffMergeToMain(ctx.root, ctx.role, ctx.mainBranch))) return "merge_blocked";
    const commit = await headOf(ctx.root, ctx.mainBranch);
    logEvent(ctx.root, { loop: ctx.role, type: "merged", commit, summary });
    return "changed";
  });
}

/** Re-run the conflicting rebase leaving markers in place, let pi resolve them, and continue
 * the rebase. Returns true when the branch now sits cleanly on top of main. */
async function resolveConflict(ctx: MergeContext, wt: string): Promise<boolean> {
  const state = await rebaseOntoMainLeaveConflicts(wt, ctx.mainBranch);
  if (state === "clean") return true;
  if (state === "failed") return false;
  const files = await conflictedFiles(wt);
  const pi = await ctx.runPi(
    wt,
    buildConflictPrompt(ctx.role, files),
    `tumwater-${ctx.role}-${ctx.tick}-conflict`,
  );
  if (!pi.ok || hasConflictMarkers(wt, files)) {
    await abortSync(wt);
    return false;
  }
  try {
    await continueRebase(wt);
  } catch {
    // The rebase stopped again — a second conflict, only possible when pi itself authored extra
    // commits during the tick. One resolution attempt per tick.
    await abortSync(wt);
    return false;
  }
  return true;
}
