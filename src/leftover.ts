import { aheadOfMain, commitMessage, deleteRef, headOf, isMergedInto, refSha, setRef } from "./git.js";
import { parseCommitMetadata, type CommitMetadata } from "./commit-message.js";
import { logEvent, warnEvent } from "./events.js";
import { enqueueLanding, queuedLandings } from "./land-queue.js";
import { landingRefName } from "./paths.js";
import { shortSha } from "./text.js";
import type { LandingEntry } from "./types.js";

/** Salvaging a commit a previous tick left unlanded (plans/merge-queue.md). Since merge queue
 * 2/5 the role's branch is reset to main the moment its commit is pinned, so the leftover
 * normally lives in `refs/tumwater/landing/<role>`: recovery puts that sha back on the durable
 * land queue, so it lands through the SAME slot, gate, and strike cap a fresh tick's change
 * does — no crash or abort path smuggles unreviewed work into main (invariant 1), and main keeps
 * exactly one writer, the orchestrator's landing slot (an in-tick recovery landing used to race
 * the slot's batches into `merge_blocked`). A commit with NO pin — a crash in the window between
 * the tick's commit and its pin write, or a failed pin write itself — still sits on the branch
 * ahead of main; recovery adopts that tip into the pin scheme and queues it, so invariant 1
 * holds whether or not the pin survived. Split out of loop.ts — which keeps the tick lifecycle
 * around it — because this is a self-contained concern with its own entry condition and git
 * surface; the only things it borrows from the loop are identity, the tick number, and the
 * worktree (for the no-pin fallback). */

/** What recoverLeftover needs from its owning loop: identity, the current tick number, and the
 * role's worktree (needed only for the no-pin ahead-of-main fallback). */
export interface LeftoverContext {
  root: string;
  role: string;
  mainBranch: string;
  /** The current tick number — the queued landing's review and conflict-resolution sessions
   * are named by it, exactly as a fresh tick's are. */
  tick: number;
  /** The role's worktree — read for the no-pin fallback only. */
  wt: string;
}

/** What recovery did with a leftover, for the tick to end on:
 * - `enqueued`: the pin went onto the land queue and `land_queued` was logged — the tick ends
 *   `queued`, exactly like a fresh changed tick, and the land-queue interlock holds the role
 *   until the slot has landed it;
 * - `already_queued`: the role already has a landing on the queue (the interlock normally keeps
 *   such a role from ticking at all) — nothing is enqueued twice and no ref is touched;
 * - `unpinned`: the commit sits on the branch ahead of main and adopting it into the landing
 *   ref failed — a landing without a pin loses the ref lifecycle the queue depends on, so the
 *   commit stays on the branch for the next tick, like a fresh tick's failed pin. */
export type LeftoverRecovery =
  | { kind: "enqueued"; entry: LandingEntry }
  | { kind: "already_queued"; entry: LandingEntry }
  | { kind: "unpinned"; sha: string };

/** Queue a commit a previous tick left unlanded. Entry condition: the landing ref exists and
 * its sha is not yet contained in main — or, with no pin at all, the role's branch is ahead of
 * main (crash between the commit and the pin). A present-but-contained ref is stale — a crash
 * between the ff-merge and the ref deletion — and is deleted without queuing anything. Returns
 * null when there was nothing to salvage. The queued entry carries the pin's sha plus the
 * summary, body, and high-friction flag read back from its commit message, because the
 * authoring run that set them is gone; from there the landing slot keeps or deletes the ref per
 * the lander's usual policy. An unreadable ref or worktree reads as no leftover — only git-level
 * errors in the stale-pin cleanup propagate. */
export async function recoverLeftover(ctx: LeftoverContext): Promise<LeftoverRecovery | null> {
  // One landing ref per role, so at most one outstanding landing per role: a second entry beside
  // one the slot has yet to finish would share — and fight over — the same ref.
  const queued = queuedLandings(ctx.root).find((e) => e.role === ctx.role);
  if (queued) return { kind: "already_queued", entry: queued };
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
    // adoption is logged and leaves the commit on the branch (see `unpinned`).
    if (!(await setRef(ctx.root, ref, sha))) {
      warnEvent(ctx.root, ctx.role, `failed to adopt unpinned leftover ${shortSha(sha)} into its landing ref`);
      return { kind: "unpinned", sha };
    }
  }
  const meta = await recoveredMetadata(ctx.root, sha);
  const entry: LandingEntry = {
    role: ctx.role,
    sha,
    tick: ctx.tick,
    // Name what lands, not merely that a recovery happened: the recovered commit's own subject
    // rides the landing, so the failure digest's "Landed in the window" can correlate a
    // recovered merge with the work it names (BUGS.md 2026-09-21). Unreadable messages fall
    // back to the bare provenance label.
    summary: meta.subject
      ? `recovered leftover work from ${ctx.role}: ${meta.subject}`
      : `recovered leftover work from ${ctx.role}`,
    body: meta.body,
    highFriction: meta.highFriction || undefined,
    enqueuedAt: Date.now(),
  };
  enqueueLanding(ctx.root, entry);
  logEvent(ctx.root, { loop: ctx.role, type: "land_queued", commit: sha, summary: entry.summary });
  return { kind: "enqueued", entry };
}

/** The review-gate metadata a pinned leftover commit carries in its own message: its
 * subject, high-friction flag, and author's body, or an empty object when the commit
 * predates the contract or the message cannot be read. Recovery lands through the same gate
 * as a fresh tick, so it must present those fields the same way — otherwise a flagged change
 * is silently reviewed as routine (BUGS.md 2026-09-19), and the merged event names the
 * recovery but not the work (BUGS.md 2026-09-21). */
async function recoveredMetadata(root: string, sha: string): Promise<CommitMetadata> {
  const message = await commitMessage(root, sha);
  return message ? parseCommitMetadata(message) : {};
}
