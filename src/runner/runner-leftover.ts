import { aheadOfMain, commitExists, commitMessage, deleteRef, deleteRefIfAt, headOf, isMergedInto, refSha, setRef } from "../git/git.js";
import { commitRunOf, parseCommitMetadata, type CommitMetadata } from "../git/commit-message.js";
import { logEventBestEffort, warnEventBestEffort } from "../events/events.js";
import { enqueueMerge, queuedMerges, type MergeEntry } from "../merge/merge-queue.js";
import { mergeRefName, withdrawnRefName } from "../paths.js";
import { resetWorktreeToMain } from "../git/worktree.js";
import { stripEntryStamp } from "../backlog/backlog-structure.js";
import { shortSha } from "../text/format.js";
import type { RunnerState } from "./runner-state.js";

/** Salvaging a commit a previous run left unmerged (plans/merge-queue.md). Since merge queue
 * 2/5 the role's branch is reset to main the moment its commit is pinned, so the leftover
 * normally lives in `refs/tumwater/landing/<role>`: recovery puts that sha back on the durable
 * merge queue, so it merges through the SAME slot, gate, and strike cap a fresh run's change
 * does — no crash or abort path smuggles unreviewed work into main (invariant 1), and main keeps
 * exactly one writer, the orchestrator's merge slot (an in-run recovery merge used to race
 * the slot's batches into `merge_blocked`). A commit with NO pin — a crash in the window between
 * the run's commit and its pin write, or a failed pin write itself — still sits on the branch
 * ahead of main; recovery adopts that tip into the pin scheme and queues it, so invariant 1
 * holds whether or not the pin survived. Split out of runner.ts — which keeps the run lifecycle
 * around it — because this is a self-contained concern with its own entry condition and git
 * surface; the only things it borrows from the runner are identity, the run number, the
 * worktree (for the no-pin fallback), and two pieces of the role's merge state: its conflict
 * streak and outstanding hand-back. */

/** Consecutive merges of one pinned sha that may end `merge_conflict` before recovery stops
 * re-queuing it (RunnerState.mergeConflicts). Each attempt costs a conflict-resolution run, and
 * a role holding a pin never authors: without a cap an unmergeable change would re-queue
 * forever, burning one resolution run per drain. At the cap the pin is handed back to its
 * author with the markers in place rather than discarded (PLANS.md "Robust conflict landing,
 * part 2/2"); a lineage already handed back once is discarded instead. */
export const MERGE_CONFLICT_LIMIT = 2;

/** Delete a pin main already contains — the work merged and a crash skipped its un-pinning —
 * so nothing re-merges what main holds. True when it was stale and is gone. Shared by the
 * author's recovery and the pipeline's re-queue (pinnedRetrySha). */
async function dropStalePin(root: string, ref: string, sha: string, mainBranch: string): Promise<boolean> {
  if (!(await isMergedInto(root, sha, mainBranch))) return false;
  await deleteRef(root, ref);
  return true;
}

/** Delete a pin whose commit is missing from the repository, with a warning: it can never merge,
 * and re-queuing it would end every run on an error. True when it was dangling and is gone. */
async function dropDanglingPin(root: string, role: string, ref: string, sha: string): Promise<boolean> {
  if (await commitExists(root, sha)) return false;
  await deleteRefIfAt(root, ref, sha);
  warnEventBestEffort(
    root,
    role,
    `dropped merge pin ${shortSha(sha)}: its commit is missing from the repository, so it can never merge`,
  );
  return true;
}

/** Consecutive conflict-ended merges of `sha` (0 when the streak names another sha). */
function conflictAttempts(streak: RunnerState["mergeConflicts"], sha: string): number {
  return streak?.sha === sha ? streak.count : 0;
}

/** The sha of a role's kept pin when the merge pipeline may re-queue it itself: the pin exists,
 * main does not already contain it (a stale pin is deleted, as recovery does), and its conflict
 * streak is under MERGE_CONFLICT_LIMIT. Null otherwise — a pin at the limit is the author's
 * conflict hand-back, and it stays with recoverLeftover. */
export async function pinnedRetrySha(
  root: string,
  role: string,
  mainBranch: string,
  state: Pick<RunnerState, "mergeConflicts">,
): Promise<string | null> {
  const ref = mergeRefName(role);
  const sha = await refSha(root, ref).catch(() => null);
  if (!sha) return null;
  if (await dropDanglingPin(root, role, ref, sha)) return null;
  if (await dropStalePin(root, ref, sha, mainBranch)) return null;
  if (conflictAttempts(state.mergeConflicts, sha) >= MERGE_CONFLICT_LIMIT) return null;
  return sha;
}

/** What recoverLeftover needs from its owning runner: identity, the current run number, the
 * role's worktree (needed only for the no-pin ahead-of-main fallback), and the role's merge
 * state — its conflict streak and outstanding hand-back. */
export interface LeftoverContext {
  root: string;
  role: string;
  mainBranch: string;
  /** The current run number — the queued merge's review and conflict-resolution sessions
   * are named by it, exactly as a fresh run's are. */
  runNumber: number;
  /** The role's worktree — read for the no-pin fallback only. */
  wt: string;
  /** The role's conflict streak (RunnerState.mergeConflicts): a pin at MERGE_CONFLICT_LIMIT is
   * handed back to its author (or discarded, when a hand-back already happened). */
  mergeConflicts?: RunnerState["mergeConflicts"];
  /** The role's outstanding hand-back (RunnerState.conflictHandback): when one exists, a pin at
   * the cap means this lineage already used its one hand-back, so it is discarded. */
  conflictHandback?: RunnerState["conflictHandback"];
}

/** What recovery did with a leftover, for the run to end on:
 * - `enqueued`: the pin went onto the merge queue and `merge_queued` was logged — the run ends
 *   `queued`, exactly like a fresh changed run, and the merge-queue interlock holds the role
 *   until the slot has merged it;
 * - `already_queued`: the role already has a merge on the queue (the interlock relief admits
 *   it — runner-run.ts's `already_queued` arm falls through to author for every role) —
 *   nothing is enqueued twice and no ref is touched;
 * - `relief_wait`: the role already has a merge on the queue AND its branch holds a second
 *   commit ahead of main staged unpinned by a prior relief run (plans/interlock-relief.md
 *   part 1/4) — neither re-queued nor reset, left on the branch for the run after the queued
 *   entry drains;
 * - `unpinned`: the commit sits on the branch ahead of main and adopting it into the merge
 *   ref failed — a merge without a pin loses the ref lifecycle the queue depends on, so the
 *   commit stays on the branch for the next run, like a fresh run's failed pin;
 * - `discarded`: the pin's last MERGE_CONFLICT_LIMIT merges all ended in a conflict the
 *   resolver could not settle — the ref is deleted with a warning and nothing is queued, so the
 *   run goes on to author on a fresh main and the prompt says what was dropped;
 * - `handback`: the pin's last MERGE_CONFLICT_LIMIT merges all ended in a conflict and its
 *   lineage has not been handed back yet — the ref stays, and the run re-applies the diff over
 *   current main with the markers in place so the author resolves them; the run logs a
 *   `conflict_handback` `queued` event. */
type LeftoverRecovery =
  | { kind: "enqueued"; entry: MergeEntry }
  | { kind: "already_queued"; entry: MergeEntry }
  | { kind: "relief_wait"; entry: MergeEntry }
  | { kind: "unpinned"; sha: string }
  | { kind: "handback"; sha: string; summary: string; attempts: number }
  | { kind: "discarded"; sha: string; summary: string; attempts: number };

/** The recovery arms that end the run through the recovery-finishing phase (runner-recovery.ts
 * `finishRecoveryRunPhase`): `enqueued`, `relief_wait`, and `unpinned`. The other
 * three arms never reach it — `handback` and `discarded` are resolved inline before the phase
 * (runner-run.ts), and `already_queued` falls through to authoring — so their exclusion from the
 * parameter type is stated once here and shared by the three `finishRecoveryRun` declarations. */
export type FinishableRecovery = Exclude<
  LeftoverRecovery,
  { kind: "discarded" } | { kind: "handback" } | { kind: "already_queued" }
>;

/** Whether the role holds a kept merge pin — the ref `recoverLeftover` reads. Ref presence is the
 * whole answer: a pin main already holds is left to `recoverLeftover`, which deletes it. */
export async function hasUnmergedPin(root: string, role: string): Promise<boolean> {
  return (await refSha(root, mergeRefName(role)).catch(() => null)) !== null;
}

/** Queue a commit a previous run left unmerged. Entry condition: the merge ref exists and
 * its sha is not yet contained in main — or, with no pin at all, the role's branch is ahead of
 * main (crash between the commit and the pin). A present-but-contained ref is stale — a crash
 * between the ff-merge and the ref deletion — and is deleted without queuing anything, and so is
 * a pin whose commit is missing from the repository (with a warning — it can never merge).
 * Returns null when there was nothing to salvage. The queued entry carries the pin's sha plus the
 * summary, body, and high-friction flag read back from its commit message, because the
 * authoring run that set them is gone; from there the merge slot keeps or deletes the ref per
 * the merger's usual policy. An unreadable ref or worktree reads as no leftover — only git-level
 * errors in the stale-pin cleanup propagate. */
export async function recoverLeftover(ctx: LeftoverContext): Promise<LeftoverRecovery | null> {
  // One merge ref per role, so at most one outstanding merge per role: a second entry beside
  // one the slot has yet to finish would share — and fight over — the same ref.
  const queued = queuedMerges(ctx.root).find((e) => e.role === ctx.role);
  if (queued) {
    // A role with a queued entry whose branch is still ahead of main holds a second commit
    // staged unpinned by a prior relief run (plans/interlock-relief.md part 1/4). Neither
    // re-queue it (the one-entry-per-role queue gate owns that spot) nor touch the branch:
    // `relief_wait` ends the run and leaves the commit for the run after the entry drains.
    if ((await aheadOfMain(ctx.wt, ctx.mainBranch).catch(() => 0)) > 0) {
      return { kind: "relief_wait", entry: queued };
    }
    return { kind: "already_queued", entry: queued };
  }
  const ref = mergeRefName(ctx.role);
  let sha = await refSha(ctx.root, ref).catch(() => null);
  if (sha) {
    if (await dropDanglingPin(ctx.root, ctx.role, ref, sha)) return null;
    if (await dropStalePin(ctx.root, ref, sha, ctx.mainBranch)) return null;
  } else {
    // No pin: either nothing was left behind, or a crash hit the commit→pin window (or
    // the pin write failed) and the commit still sits on the branch ahead of main. Recover that
    // tip too — invariant 1 must hold whether or not the pin survived. An unreadable worktree
    // reads as "no leftover", exactly like a failed ref read: never propagate into the run.
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
  const attempts = conflictAttempts(ctx.mergeConflicts, sha);
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
  const entry = recoveredMergeEntry(ctx.role, sha, meta, ctx.runNumber);
  enqueueMerge(ctx.root, entry);
  logEventBestEffort(ctx.root, { source: ctx.role, type: "merge_queued", commit: sha, summary: entry.summary });
  return { kind: "enqueued", entry };
}

/** Set aside the unmerged work a withdrawn claim's interrupted run left, before leftover
 * recovery can queue it (the poll dropped the run's resume and left `state.withdrawn`,
 * claims.ts dropWithdrawnWork). Such work carries no claim the merge could check: an agent
 * commit on the role's branch, or a merge pin that no queue entry holds (a crash between pin and
 * enqueue, a conflict hand-back). Each is kept under a backup ref
 * (withdrawnRefName), the pin is deleted and the branch in `wt` reset to main, and one warning
 * names the refs. A pin with a queue entry is left to the merge's own withdrawn check, which reads
 * the entry's recorded claim. Clears the marker. Returns the backup refs, [] when there was
 * nothing to set aside. Throws when a backup ref cannot be written, keeping the work and the
 * marker for the next run: the work must never be dropped unkept, nor left for recovery. */
export async function setAsideWithdrawnWork(
  ctx: Pick<LeftoverContext, "root" | "role" | "mainBranch" | "wt">,
  state: RunnerState,
): Promise<string[]> {
  const withdrawn = state.withdrawn;
  if (withdrawn === undefined) return [];
  const backups: string[] = [];
  const keep = async (sha: string): Promise<void> => {
    const ref = withdrawnRefName(ctx.role, sha);
    if (backups.includes(ref)) return;
    if (!(await setRef(ctx.root, ref, sha))) throw new Error(`could not set withdrawn work ${shortSha(sha)} aside as ${ref}`);
    backups.push(ref);
  };
  const pinRef = mergeRefName(ctx.role);
  const pin = await refSha(ctx.root, pinRef);
  const queued = queuedMerges(ctx.root).some((e) => e.role === ctx.role);
  if (pin !== null && !queued && !(await isMergedInto(ctx.root, pin, ctx.mainBranch))) {
    await keep(pin);
    await deleteRef(ctx.root, pinRef);
    // The pin's merge history goes with it: no hand-back re-applies it.
    state.mergeConflicts = undefined;
    state.conflictHandback = undefined;
  }
  if ((await aheadOfMain(ctx.wt, ctx.mainBranch)) > 0) {
    await keep(await headOf(ctx.wt, "HEAD"));
    await resetWorktreeToMain(ctx.wt, ctx.mainBranch);
  }
  state.withdrawn = undefined;
  if (backups.length > 0) {
    warnEventBestEffort(
      ctx.root,
      ctx.role,
      `set aside the unmerged work on the withdrawn "${stripEntryStamp(withdrawn.title)}" as ${backups.join(", ")}: ${withdrawn.file} on main no longer lists it, so leftover recovery will not merge it; the role takes its next entry`,
    );
  }
  return backups;
}

/** The review-gate metadata a pinned leftover commit carries in its own message: its subject,
 * high-friction flag, author's body, and the revision round, claim, and prior review stamped as
 * trailers — or an empty object when the commit predates the contract or the message cannot be
 * read. Recovery merges through the same gate as a fresh run, so it must present those fields the
 * same way — otherwise a flagged change is silently reviewed as routine (BUGS.md 2026-09-19), and
 * the merged event names the recovery but not the work (BUGS.md 2026-09-21). The merge drain's
 * torn-head step (dropTornHead) reads it too, so a change it re-queues keeps exactly this shape. */
export async function recoveredMetadata(root: string, sha: string): Promise<CommitMetadata> {
  const message = await commitMessage(root, sha);
  return message ? parseCommitMetadata(message) : {};
}

/** The queue entry leftover recovery builds for a recovered commit: the pinned sha plus the
 * summary, body, and high-friction flag read back from its commit message, the revision round
 * from its Revision trailer, and — when the commit stamps them — the Claim and Prior-review
 * trailers, so a recovered pin carries the two merge-only fields a queue entry used to hold
 * (the backlog entry the run worked and the review a revision answers). Also the exact shape the
 * merge drain's torn-head step (dropTornHead, merge-head.ts) re-queues through — so a torn file
 * whose change is re-queued keeps the flag/round/claim/review its authoring run stamped and is
 * never silently reviewed as routine (BUGS.md 2026-09-19). A recovery never re-derives
 * `priorReview` from the run's state (run-stage fills it only from RunnerState.lastReview on a
 * run that held the rejected diff; a recovery's author is gone) — it reads it back only if the
 * commit's own Prior-review trailer names it. */
export function recoveredMergeEntry(role: string, sha: string, meta: CommitMetadata, run: number): MergeEntry {
  return {
    role,
    sha,
    run,
    // Name what merges, not merely that a recovery happened: the recovered commit's own subject
    // rides the merge, so the failure digest's "Merged in the window" can correlate a
    // recovered merge with the work it names (BUGS.md 2026-09-21). Unreadable messages fall
    // back to the bare provenance label.
    summary: meta.subject
      ? `recovered leftover work from ${role}: ${meta.subject}`
      : `recovered leftover work from ${role}`,
    body: meta.body,
    highFriction: meta.highFriction || undefined,
    // A retriable revision keeps its round from the commit's Revision trailer, so its next
    // rejection records the following round (not round 1 again) and a recovered merge still
    // deletes the rejected ref (plans/revise-rejected.md). Absent on a fresh change.
    ...(meta.revisionRound !== undefined ? { revisionRound: meta.revisionRound } : {}),
    // The two merge-only fields the durable queue entry used to hold, read back off the commit's
    // trailers when its authoring run stamped them (a commit predating the contract stamps
    // neither, so the recovered entry simply carries none, as today).
    ...(meta.claim !== undefined ? { claim: meta.claim } : {}),
    ...(meta.priorReview !== undefined ? { priorReview: meta.priorReview } : {}),
    enqueuedAt: Date.now(),
  };
}

/** The queue entry the merge drain builds for a kept pin with no queue file (merge-drain.ts's
 * pin scan, and dropTornHead's re-queue in merge-head.ts): the pin's sha plus the summary,
 * body, and high-friction flag read back from its commit message (recoveredMetadata) and the
 * authoring run from its `Run:` trailer — the drain has no run number of its own, so session
 * naming keeps the authoring run; a hand-made commit with no trailer falls back to the zero
 * slot. The one pin-to-entry builder, so the drain and the torn-head re-queue cannot drift. */
export async function pinnedMergeEntry(root: string, role: string, sha: string): Promise<MergeEntry> {
  const meta = await recoveredMetadata(root, sha);
  const message = await commitMessage(root, sha);
  const run = message === null ? 0 : (commitRunOf(message) ?? 0);
  return recoveredMergeEntry(role, sha, meta, run);
}
