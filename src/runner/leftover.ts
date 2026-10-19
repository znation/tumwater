// vocabulary: plain
import { aheadOfMain, commitMessage, deleteRef, headOf, isMergedInto, refSha, setRef } from "../git/git.js";
import { parseCommitMetadata, type CommitMetadata } from "../git/commit-message.js";
import { logEventBestEffort, warnEventBestEffort } from "../events/events.js";
import { enqueueMerge, queuedMerges, type MergeEntry } from "../merge/merge-queue.js";
import { mergeRefName } from "../paths.js";
import { shortSha } from "../text/format.js";
import type { RunnerState } from "./runner-state.js";

/** Salvaging a commit a previous tick left unmerged (plans/merge-queue.md). Since merge queue
 * 2/5 the role's branch is reset to main the moment its commit is pinned, so the leftover
 * normally lives in `refs/tumwater/landing/<role>`: recovery puts that sha back on the durable
 * merge queue, so it merges through the SAME slot, gate, and strike cap a fresh tick's change
 * does — no crash or abort path smuggles unreviewed work into main (invariant 1), and main keeps
 * exactly one writer, the orchestrator's merge slot (an in-tick recovery merge used to race
 * the slot's batches into `merge_blocked`). A commit with NO pin — a crash in the window between
 * the tick's commit and its pin write, or a failed pin write itself — still sits on the branch
 * ahead of main; recovery adopts that tip into the pin scheme and queues it, so invariant 1
 * holds whether or not the pin survived. Split out of runner.ts — which keeps the tick lifecycle
 * around it — because this is a self-contained concern with its own entry condition and git
 * surface; the only things it borrows from the runner are identity, the tick number, the
 * worktree (for the no-pin fallback), and three pieces of the role's merge state: its
 * conflict streak, outstanding hand-back, and permanent-reviewer hold. */

/** Consecutive merges of one pinned sha that may end `merge_conflict` before recovery stops
 * re-queuing it (RunnerState.mergeConflicts). Each attempt costs a conflict-resolution run, and
 * a role holding a pin never authors: without a cap an unmergeable change would re-queue
 * forever, burning one resolution run per drain. At the cap the pin is handed back to its
 * author with the markers in place rather than discarded (PLANS.md "Robust conflict landing,
 * part 2/2"); a lineage already handed back once is discarded instead. */
export const MERGE_CONFLICT_LIMIT = 2;

/** What recoverLeftover needs from its owning runner: identity, the current tick number, the
 * role's worktree (needed only for the no-pin ahead-of-main fallback), and the role's merge
 * state — its conflict streak, outstanding hand-back, and permanent-reviewer hold. */
export interface LeftoverContext {
  root: string;
  role: string;
  mainBranch: string;
  /** The current tick number — the queued merge's review and conflict-resolution sessions
   * are named by it, exactly as a fresh tick's are. */
  tick: number;
  /** The role's worktree — read for the no-pin fallback only. */
  wt: string;
  /** The role's conflict streak (RunnerState.mergeConflicts): a pin at MERGE_CONFLICT_LIMIT is
   * handed back to its author (or discarded, when a hand-back already happened). */
  mergeConflicts?: RunnerState["mergeConflicts"];
  /** The role's outstanding hand-back (RunnerState.conflictHandback): when one exists, a pin at
   * the cap means this lineage already used its one hand-back, so it is discarded. */
  conflictHandback?: RunnerState["conflictHandback"];
  /** The role's permanent-reviewer-config hold (RunnerState.mergeReviewError): while it names
   * this pin's sha, recovery returns `held` instead of re-queueing, so a 4xx config error is
   * not retried at suite speed (BUGS.md 2026-10-06). */
  mergeReviewError?: RunnerState["mergeReviewError"];
}

/** What recovery did with a leftover, for the tick to end on:
 * - `enqueued`: the pin went onto the merge queue and `merge_queued` was logged — the tick ends
 *   `queued`, exactly like a fresh changed tick, and the merge-queue interlock holds the role
 *   until the slot has merged it;
 * - `already_queued`: the role already has a merge on the queue (the interlock normally keeps
 *   such a role from ticking at all) — nothing is enqueued twice and no ref is touched;
 * - `unpinned`: the commit sits on the branch ahead of main and adopting it into the merge
 *   ref failed — a merge without a pin loses the ref lifecycle the queue depends on, so the
 *   commit stays on the branch for the next tick, like a fresh tick's failed pin;
 * - `discarded`: the pin's last MERGE_CONFLICT_LIMIT merges all ended in a conflict the
 *   resolver could not settle — the ref is deleted with a warning and nothing is queued, so the
 *   tick goes on to author on a fresh main and the prompt says what was dropped;
 * - `handback`: the pin's last MERGE_CONFLICT_LIMIT merges all ended in a conflict and its
 *   lineage has not been handed back yet — the ref stays, and the tick re-applies the diff over
 *   current main with the markers in place so the author resolves them; the tick logs a
 *   `conflict_handback` `queued` event;
 * - `held`: a merge failed on a permanent reviewer configuration error and the model config
 *   is unchanged — the pin stays, nothing is queued, and the tick ends on the error ladder
 *   instead of re-paying a gate check at suite speed (BUGS.md 2026-10-06). */
export type LeftoverRecovery =
  | { kind: "enqueued"; entry: MergeEntry }
  | { kind: "already_queued"; entry: MergeEntry }
  | { kind: "unpinned"; sha: string }
  | { kind: "held"; sha: string; message: string }
  | { kind: "handback"; sha: string; summary: string; attempts: number }
  | { kind: "discarded"; sha: string; summary: string; attempts: number };

/** Whether the role holds a kept merge pin — the ref `recoverLeftover` reads. Ref presence is the
 * whole answer: a pin main already holds is left to `recoverLeftover`, which deletes it. */
export async function hasUnmergedPin(root: string, role: string): Promise<boolean> {
  return (await refSha(root, mergeRefName(role)).catch(() => null)) !== null;
}

/** Queue a commit a previous tick left unmerged. Entry condition: the merge ref exists and
 * its sha is not yet contained in main — or, with no pin at all, the role's branch is ahead of
 * main (crash between the commit and the pin). A present-but-contained ref is stale — a crash
 * between the ff-merge and the ref deletion — and is deleted without queuing anything. Returns
 * null when there was nothing to salvage. The queued entry carries the pin's sha plus the
 * summary, body, and high-friction flag read back from its commit message, because the
 * authoring run that set them is gone; from there the merge slot keeps or deletes the ref per
 * the merger's usual policy. An unreadable ref or worktree reads as no leftover — only git-level
 * errors in the stale-pin cleanup propagate. */
export async function recoverLeftover(ctx: LeftoverContext): Promise<LeftoverRecovery | null> {
  // One merge ref per role, so at most one outstanding merge per role: a second entry beside
  // one the slot has yet to finish would share — and fight over — the same ref.
  const queued = queuedMerges(ctx.root).find((e) => e.role === ctx.role);
  if (queued) return { kind: "already_queued", entry: queued };
  const ref = mergeRefName(ctx.role);
  let sha = await refSha(ctx.root, ref).catch(() => null);
  if (sha) {
    if (await isMergedInto(ctx.root, sha, ctx.mainBranch)) {
      // Stale pin: the work already merged and a crash skipped its un-pinning. Clean it up so
      // the next tick does not re-merge what main already holds.
      await deleteRef(ctx.root, ref);
      return null;
    }
  } else {
    // No pin: either nothing was left behind, or a crash hit the commit→pin window (or
    // the pin write failed) and the commit still sits on the branch ahead of main. Recover that
    // tip too — invariant 1 must hold whether or not the pin survived. An unreadable worktree
    // reads as "no leftover", exactly like a failed ref read: never propagate into the tick.
    const ahead = await aheadOfMain(ctx.wt, ctx.mainBranch).catch(() => 0);
    if (ahead <= 0) return null;
    sha = await headOf(ctx.wt, "HEAD").catch(() => null);
    if (!sha) return null;
    // Adopt the unpinned commit into the pin scheme so every downstream outcome — kept on an
    // under-cap review failure (the strike cap's retry), deleted on reject/merge/discard,
    // discarded on a user abort — behaves exactly as for a normally pinned one. A failed
    // adoption is logged and leaves the commit on the branch (see `unpinned`).
    if (!(await setRef(ctx.root, ref, sha))) {
      warnEventBestEffort(
        ctx.root,
        ctx.role,
        `failed to adopt unpinned leftover ${shortSha(sha)} into its merge ref`,
      );
      return { kind: "unpinned", sha };
    }
  }
  const meta = await recoveredMetadata(ctx.root, sha);
  // A permanent reviewer configuration error holds the pin: re-queuing it would pay another
  // full gate check for a request that can never succeed until the model config changes. The
  // caller clears the hold (and re-queues) once the resolved reviewer selector differs, so a
  // fixed config recovers automatically (BUGS.md 2026-10-06).
  const held = ctx.mergeReviewError;
  if (held?.sha === sha) return { kind: "held", sha, message: held.message };
  const attempts = ctx.mergeConflicts?.sha === sha ? ctx.mergeConflicts.count : 0;
  if (attempts >= MERGE_CONFLICT_LIMIT) {
    const summary = meta.subject ?? `leftover ${shortSha(sha)}`;
    if (ctx.conflictHandback) {
      // This lineage already used its one hand-back and still conflicts at the cap: drop the
      // pin (the warning names its sha and both attempts) and let the author start over.
      await deleteRef(ctx.root, ref);
      warnEventBestEffort(
        ctx.root,
        ctx.role,
        `discarding leftover ${shortSha(sha)} after ${attempts} merges ended in unresolved conflicts with main, even after sending it back to the role to resolve`,
      );
      return { kind: "discarded", sha, summary, attempts };
    }
    // Main has moved too far under this change for the resolver to reconcile it: keep the pin
    // and hand it back to its author, who re-applies it over current main with the markers in
    // place and resolves them. The runner's next step logs the conflict_handback event and sets
    // RunnerState.conflictHandback (the pin survives until that re-apply).
    return { kind: "handback", sha, summary, attempts };
  }
  const entry: MergeEntry = {
    role: ctx.role,
    sha,
    run: ctx.tick,
    // Name what merges, not merely that a recovery happened: the recovered commit's own subject
    // rides the merge, so the failure digest's "Merged in the window" can correlate a
    // recovered merge with the work it names (BUGS.md 2026-09-21). Unreadable messages fall
    // back to the bare provenance label.
    summary: meta.subject
      ? `recovered leftover work from ${ctx.role}: ${meta.subject}`
      : `recovered leftover work from ${ctx.role}`,
    body: meta.body,
    highFriction: meta.highFriction || undefined,
    // A retriable revision keeps its round from the commit's Revision trailer, so its next
    // rejection records the following round (not round 1 again) and a recovered merge still
    // deletes the rejected ref (plans/revise-rejected.md). Absent on a fresh change.
    ...(meta.revisionRound !== undefined ? { revisionRound: meta.revisionRound } : {}),
    enqueuedAt: Date.now(),
  };
  enqueueMerge(ctx.root, entry);
  logEventBestEffort(ctx.root, { source: ctx.role, type: "merge_queued", commit: sha, summary: entry.summary });
  return { kind: "enqueued", entry };
}

/** The review-gate metadata a pinned leftover commit carries in its own message: its
 * subject, high-friction flag, and author's body, or an empty object when the commit
 * predates the contract or the message cannot be read. Recovery merges through the same gate
 * as a fresh tick, so it must present those fields the same way — otherwise a flagged change
 * is silently reviewed as routine (BUGS.md 2026-09-19), and the merged event names the
 * recovery but not the work (BUGS.md 2026-09-21). */
async function recoveredMetadata(root: string, sha: string): Promise<CommitMetadata> {
  const message = await commitMessage(root, sha);
  return message ? parseCommitMetadata(message) : {};
}
