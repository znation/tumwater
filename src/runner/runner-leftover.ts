import { aheadOfMain, commitExists, commitMessage, deleteRef, deleteRefIfAt, headOf, isMergedInto, refSha, setRef } from "../git/git.js";
import { commitRunOf, parseCommitMetadata, type CommitMetadata } from "../run/commit-message.js";
import { logEventBestEffort, warnEventBestEffort } from "../events/events.js";
import { mergePinSha } from "../merge/merge-pins.js";
import { queuedMerges, type MergeEntry } from "../merge/merge-queue.js";
import { mergeChanges, readMergeMarker, removeMergeChange } from "../merge/merge-slot.js";
import { mergeRefName, withdrawnRefName } from "../paths.js";
import { resetWorktreeToMain } from "../git/worktree.js";
import { stripEntryStamp } from "../backlog/backlog-md.js";
import { shortSha } from "../text/format.js";
import { conflictAttempts, type RunnerState } from "./runner-state.js";

/** Salvaging a commit a previous run left unmerged (plans/merge-queue.md). Since merge queue
 * 2/5 the role's branch is reset to main the moment its commit is pinned, so the leftover
 * normally lives in `refs/tumwater/landing/<role>`: recovery re-pins that sha — the pin is the
 * waiting state — and logs `merge_queued`, so the poll's drain merges it through the SAME slot,
 * gate, and strike cap a fresh run's change does — no queue file is written (part 3e/7 made a
 * fresh run's pin the waiting state; this recovery follows suit). No crash or abort path
 * smuggles unreviewed work into main (invariant 1), and main keeps exactly one writer, the
 * orchestrator's merge slot (an in-run recovery merge used to race the slot's batches into
 * `merge_blocked`). A commit with NO pin — a crash in the window between the run's commit and
 * its pin write, or a failed pin write itself — still sits on the branch ahead of main; recovery
 * adopts that tip into the pin, so invariant 1 holds whether or not the pin survived. Split out
 * of runner.ts — which keeps the run lifecycle around it — because this is a self-contained
 * concern with its own entry condition and git surface; the only things it borrows from the
 * runner are identity, the run number, the worktree (for the no-pin fallback), and two pieces of
 * the role's merge state: its conflict
 * streak and outstanding hand-back. */

/** Consecutive merges of one pinned sha that may end `merge_conflict` before recovery stops
 * re-pinning it (RunnerState.mergeConflicts). Each attempt costs a conflict-resolution run, and
 * a role holding a pin never authors: without a cap an unmergeable change would retry
 * forever, burning one resolution run per drain. At the cap the pin is handed back to its
 * author with the markers in place rather than discarded (PLANS.md "Robust conflict landing,
 * part 2/2"); a lineage already handed back once is discarded instead. */
export const MERGE_CONFLICT_LIMIT = 2;

/** Delete a pin main already contains — the work merged and a crash skipped its un-pinning —
 * so nothing re-merges what main holds. True when it was stale and is gone. Shared by the
 * author's recovery and the pipeline's retry (pinnedRetrySha). */
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

/** The sha of a role's kept pin when the merge pipeline may retry it itself: the pin exists,
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
  const sha = await mergePinSha(root, role);
  if (!sha) return null;
  if (await dropDanglingPin(root, role, ref, sha)) return null;
  if (await dropStalePin(root, ref, sha, mainBranch)) return null;
  if (conflictAttempts(state.mergeConflicts, sha) >= MERGE_CONFLICT_LIMIT) return null;
  return sha;
}

/** What recoverLeftover needs from its owning runner: identity, the current run number (the
 * recovery run itself — the `pinned` arm's session and `merge_queued` are named by it, exactly
 * as a fresh run's are), the role's worktree (needed only for the no-pin ahead-of-main
 * fallback), and the role's merge state — its conflict streak and outstanding hand-back. */
export interface LeftoverContext {
  root: string;
  role: string;
  mainBranch: string;
  /** The current run number — the recovered commit's review and conflict-resolution sessions
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
  /** The queued entry this run's slot stashed (RunnerState.queuedSummary): under the conflict
   * cap, a pin whose sha the stash names is the role's own pending change, and reads as
   * `already_queued` rather than `pinned` in the live-pin arm (BUGS.md 2026-11-15 recovery-spin;
   * the 2026-11-16 refinement 61a0e509: match by the pinned sha, not by a set entry). A pin the
   * stash does not name reads as `pinned` — a crashed run left it (no stash), a merge failure
   * cleared the stash, or a dropped pin left a stale stash naming another sha. */
  queuedSummary?: RunnerState["queuedSummary"];
}

/** What recovery did with a leftover, for the run to end on:
 * - `pinned`: recovery re-pinned the recovered commit (or adopted the unpinned tip into the
 *   pin) and logged `merge_queued` — the pin is the waiting state and no queue file is written;
 *   the run ends `queued` exactly like a fresh changed run (part 3e/7) and the poll's drain
 *   merges the pin;
 * - `already_queued`: the role already has a live change the drain settles on its own — either
 *   a legacy queue entry (the interlock relief admits it — runner-leftover-recovery.ts's
 *   `already_queued` arm falls through to author for every role) or, since 2026-11-16 (BUGS.md
 *   2026-11-15 recovery-spin), a pre-existing pin ahead of main whose sha the role's stash names
 *   under the conflict cap: the pin is left untouched and no ref is re-pinned, so the run authors
 *   on its normal schedule while the merge takes the pin (a commit held beside that pin diverts
 *   this arm to `relief_wait`). Neither kind is enqueued twice; a kept pin at the cap is a
 *   distinct `handback`/`discarded` outcome.
 * - `relief_wait`: the role already has a merge waiting — a legacy queue entry, or a live pin
 *   its own stash names — AND its branch holds a second commit ahead of main staged unpinned by
 *   a prior relief run (plans/interlock-relief.md part 1/4; beside a live pin since 2026-11-16,
 *   read by `heldBesidePin`) — neither re-queued nor reset, left on the branch for the run after
 *   the waiting merge drains. A held tail that CONTAINS the pinned commit is the exception: it is
 *   the pin plus the role's own later work, so it rejoins the pin (`pinned`, see
 *   `joinHeldTailIntoPin`) instead of waiting beside it;
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
export type LeftoverRecovery =
  | { kind: "pinned"; entry: MergeEntry }
  | { kind: "already_queued"; entry: MergeEntry }
  | { kind: "relief_wait"; entry: MergeEntry }
  | { kind: "unpinned"; sha: string }
  | { kind: "handback"; sha: string; summary: string; attempts: number }
  | { kind: "discarded"; sha: string; summary: string; attempts: number };

/** The recovery arms that end the run through the recovery-finishing phase (runner-recovery.ts
 * `finishRecoveryRunPhase`): `pinned`, `relief_wait`, and `unpinned`. The other
 * three arms never reach it — `handback` and `discarded` are resolved inline before the phase
 * (runner-leftover-recovery.ts), and `already_queued` falls through to authoring — so their
 * exclusion from the parameter type is stated once here and shared by the three
 * `finishRecoveryRun` declarations. */
export type FinishableRecovery = Exclude<
  LeftoverRecovery,
  { kind: "discarded" } | { kind: "handback" } | { kind: "already_queued" }
>;

/** Whether the role's branch holds a commit no pin holds: the branch is ahead of main and its
 * tip is not the pinned sha. An unreadable worktree reads as held: skipping one run is safe,
 * and resetting a branch that may hold work is not. */
async function heldBesidePin(wt: string, mainBranch: string, pinSha: string): Promise<boolean> {
  const ahead = await aheadOfMain(wt, mainBranch).catch(() => null);
  if (ahead === null) return true;
  if (ahead <= 0) return false;
  const tip = await headOf(wt, "HEAD").catch(() => null);
  return tip !== pinSha;
}

/** Can the held tail and the pin be joined, and at what sha? The tip qualifies when it CONTAINS
 * the pinned commit — the tail is then the pin plus the role's own later commits, so merging the
 * tip merges both — and the merge pipeline holds no live record for this role (invariant 3: a
 * change already mid-merge must never have its sha re-pointed under the slot). A tip that does
 * NOT contain the pin — a reset or rebase left the pinned commit a sibling of the tail — never
 * joins: adopting it would orphan the pinned commit, the very loss `relief_wait` exists to
 * prevent. An unreadable tip or containment read joins nothing, which keeps today's wait. The
 * marker read is total (`readJsonFile` turns a torn file into null), so it needs no guard. */
async function joinableHeldTail(ctx: LeftoverContext, pinSha: string): Promise<string | null> {
  const marker = readMergeMarker(ctx.root);
  if (marker && mergeChanges(marker).some((c) => c.role === ctx.role && c.status !== "done")) return null;
  const tip = await headOf(ctx.wt, "HEAD").catch(() => null);
  if (!tip || tip === pinSha) return null;
  return (await isMergedInto(ctx.root, pinSha, tip).catch(() => false)) ? tip : null;
}

/** Re-point the role's waiting pin to its own branch tip, so the drain gates and merges the
 * joined lineage as ONE change and the held tail stops being held (BUGS.md 2026-11-23 held
 * relief commit). The ref moves first — the commit is only safe once a ref holds it — and a
 * failed ref write leaves the old pin exactly where it was, so the caller falls back to
 * `relief_wait`. The join names a NEW sha, so its `merge_queued` is a fresh enqueue, logged once
 * like the `pinned` arm's. `mergeConflicts` is deliberately untouched: `relief_wait` is not a
 * conflict, and inflating the streak could push the cap to discard the healer's work; a later
 * merge outcome re-keys the streak to the sha it settled (applyMergeOutcome). */
async function joinHeldTailIntoPin(ctx: LeftoverContext, pinSha: string): Promise<LeftoverRecovery | null> {
  const tip = await joinableHeldTail(ctx, pinSha);
  if (!tip) return null;
  if (!(await setRef(ctx.root, mergeRefName(ctx.role), tip))) {
    warnEventBestEffort(
      ctx.root,
      ctx.role,
      `failed to re-point the waiting pin ${shortSha(pinSha)} to the branch tip ${shortSha(tip)} — the held commit waits beside it`,
    );
    return null;
  }
  const entry = recoveredMergeEntry(ctx.role, tip, await recoveredMetadata(ctx.root, tip), ctx.runNumber);
  logEventBestEffort(ctx.root, { source: ctx.role, type: "merge_queued", commit: tip, summary: entry.summary });
  return { kind: "pinned", entry };
}

/** Whether the role holds a kept merge pin — the ref `recoverLeftover` reads. Ref presence is the
 * whole answer: a pin main already holds is left to `recoverLeftover`, which deletes it. */
export async function hasUnmergedPin(root: string, role: string): Promise<boolean> {
  return (await mergePinSha(root, role)) !== null;
}

/** Re-pin a commit a previous run left unmerged and log it for the drain. Entry condition: the
 * merge ref exists and its sha is not yet contained in main — or, with no pin at all, the role's
 * branch is ahead of main (crash between the commit and the pin). A present-but-contained ref is
 * stale — a crash between the ff-merge and the ref deletion — and is deleted without pinning
 * anything, and so is a pin whose commit is missing from the repository (with a warning — it can
 * never merge). Returns null when there was nothing to salvage. Under the conflict cap, a pin
 * whose sha the role's stash (queuedSummary) names is its own pending change: recovery no-ops
 * (already_queued, or relief_wait when a commit is held beside the pin) and the run authors on
 * its normal schedule (BUGS.md 2026-11-15 recovery-spin). The `pinned` arm re-pins every other
 * live pin — one a crashed run left (no stash), one whose last merge failed (any merge outcome
 * clears the stash), and one a dropped pin left a stale stash naming another sha — and carries
 * the recovered sha plus the summary, body, and high-friction flag read back from its commit
 * message (the authoring run that set them is gone). `merge_queued` is logged exactly once: the
 * pin is the waiting state and no queue file is written (part 3e/7), so the poll's drain merges
 * it. From there the merge slot keeps or deletes the ref per the merger's usual policy. An
 * unreadable ref or worktree reads as no leftover — only git-level errors in the stale-pin
 * cleanup propagate. */
export async function recoverLeftover(ctx: LeftoverContext): Promise<LeftoverRecovery | null> {
  // One merge ref per role, so at most one outstanding merge per role: a second entry beside
  // one the slot has yet to finish would share — and fight over — the same ref. This arm reads
  // the queue directory, not the live pin: a role with a KEPT pin is the `pinned` arm's case
  // (recover its unmerged work), so a pin read here would collapse `pinned` into `already_queued`
  // and strand the pin. The `queued` arm and the `pinned` arm are mutually exclusive by
  // construction — one is a queue file, the other a pin — and the shared pin-view reader
  // (readMergePins) serves the observer surfaces, not this arm.
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
  let sha = await mergePinSha(ctx.root, ctx.role);
  if (sha) {
    if (await dropDanglingPin(ctx.root, ctx.role, ref, sha)) {
      // The pin's in-flight marker names a merge no process is running (the drain that left
      // the residue is gone, or it never started): clear it here, as the drain does on its own
      // drop, so the observer surfaces never show a phantom merge for a pin nobody will touch.
      removeMergeChange(ctx.root, ctx.role);
      return null;
    }
    if (await dropStalePin(ctx.root, ref, sha, ctx.mainBranch)) {
      // The pin's in-flight marker names a merge no process is running (a merge that landed
      // its commit but a crash skipped releasing its slot): clear it here, as the drain does on
      // its own drop, so the observer surfaces never show a phantom merge.
      removeMergeChange(ctx.root, ctx.role);
      return null;
    }
    // BUGS.md 2026-11-15 recovery-spin: a pin whose sha the role's stash names is the role's
    // OWN change still waiting for the merge, not leftover work. A queued run stashes its
    // summary under the sha it pinned (run-apply), the stash survives the role's later runs,
    // and only a merge outcome clears it (applyMergeOutcome). Re-pinning that pin ended the run
    // `queued` and reset the role to its minimum interval, so the role spun a ~0.2 s no-op
    // "recovered leftover work" run every poll until the merge settled (build 72a0b257: ~800
    // such runs). Instead recovery leaves the pin to the drain and the run authors on its
    // normal interval: the merge queue is not a scheduling gate (docs/how-it-works.md "No merge
    // interlock"; the 2026-11-16 drainingGate, which deferred the role instead, was reverted).
    // Every other live pin still takes the `pinned` arm once: one a crashed run left (no
    // stash), and one whose last merge failed and cleared the stash, whose re-pin feeds the
    // failure into the error streak (finishRecoveryRun). That run stashes the sha, so the runs
    // after it no-op. A pin at the conflict cap falls through to `handback`/`discarded`.
    if (ctx.queuedSummary?.sha === sha && conflictAttempts(ctx.mergeConflicts, sha) < MERGE_CONFLICT_LIMIT) {
      const entry = recoveredMergeEntry(ctx.role, sha, await recoveredMetadata(ctx.root, sha), ctx.runNumber);
      // A run admitted while this pin waits holds its new commit on the branch (heldOnBranch,
      // run-stage.ts). The `already_queued` fall-through resets the branch to main before it
      // authors, which would lose that commit, so the run waits it out instead.
      if (await heldBesidePin(ctx.wt, ctx.mainBranch, sha)) {
        // The held tail may BE the pin plus this role's own later commits: fold it into the pin
        // rather than hold both and end the run. The tip merges both commits, the role keeps its
        // ONE merge ref, and nothing is discarded — so the healer's next fix reaches the gate
        // instead of waiting beside a pin that cannot drain while main stays red, which ended
        // every run of the blocked role before authoring (BUGS.md 2026-11-23 held relief
        // commit). The tail that does not contain the pin still takes `relief_wait` below.
        const joined = await joinHeldTailIntoPin(ctx, sha);
        if (joined) return joined;
        return { kind: "relief_wait", entry };
      }
      return { kind: "already_queued", entry };
    }
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
  // The pin is the waiting state: recovery re-pins the recovered commit (or adopts the unpinned
  // tip into the pin, above) and writes no queue file — part 3e/7 made a fresh run's pin its
  // waiting state, and this recovery follows suit. `merge_queued` is logged exactly once, for
  // the drain to merge; the role holds its one merge ref until the slot merges the pin. A
  // recovery that re-pins the SAME sha the previous cycle already logged is the waiting state,
  // not a new enqueue — the pin's continued existence is why it re-runs — so it logs nothing;
  // otherwise the event log accumulates one identical `merge_queued` per recovery cycle
  // (BUGS.md duplicate merge_queued spam).
  if (ctx.queuedSummary?.sha !== sha) {
    logEventBestEffort(ctx.root, { source: ctx.role, type: "merge_queued", commit: sha, summary: entry.summary });
  }
  return { kind: "pinned", entry };
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
  // Queue-file read, deliberately not a pin read: `!queued` here gates the keep-pin backup below,
  // so a pin read (which is `pin !== null`) would collapse the condition to a dead `pin !== null
  // && pin === null` and never back up an unmerged pin. No production queue-file writer exists
  // since part 1c, so this serves only legacy queue files; it goes with the queue module in
  // part 5/5.
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
 * the merged event names the recovery but not the work (BUGS.md 2026-09-21). */
export async function recoveredMetadata(root: string, sha: string): Promise<CommitMetadata> {
  const message = await commitMessage(root, sha);
  return message ? parseCommitMetadata(message) : {};
}

/** The queue entry leftover recovery builds for a recovered commit: the pinned sha plus the
 * summary, body, and high-friction flag read back from its commit message, the revision round
 * from its Revision trailer, and — when the commit stamps them — the Claim and Prior-review
 * trailers, so a recovered pin carries the two merge-only fields a queue entry used to hold
 * (the backlog entry the run worked and the review a revision answers). A recovery never re-derives
 * `priorReview` from the run's state (run-stage fills it only from RunnerState.lastReview on a
 * run that held the rejected diff; a recovery's author is gone) — it reads it back only if the
 * commit's own Prior-review trailer names it. */
function recoveredMergeEntry(role: string, sha: string, meta: CommitMetadata, run: number): MergeEntry {
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

/** The queue entry the merge drain builds for a kept pin (merge-drain.ts's pin scan): the
 * pin's sha plus the summary,
 * body, and high-friction flag read back from its commit message (recoveredMetadata) and the
 * authoring run from its `Run:` trailer — the drain has no run number of its own, so session
 * naming keeps the authoring run; a hand-made commit with no trailer falls back to the zero
 * slot. The one pin-to-entry builder, so the drain and recovery cannot drift.
 * A changed fresh run is a pin-only writer now (part 3e/7), not a recovery: the drain passes
 * the runner's current run number, so a pin its commit's Run trailer attributes to that run
 * keeps its own subject as the summary instead of being labelled recovered leftover work.
 * A pin from an earlier run (a leftover recovery re-pin) keeps the recovered label, and a
 * hand-made commit with no `Run:` trailer
 * (its run reads 0, never a real current run). */
export async function pinnedMergeEntry(
  root: string,
  role: string,
  sha: string,
  opts: { currentRun?: number } = {},
): Promise<MergeEntry> {
  const meta = await recoveredMetadata(root, sha);
  const message = await commitMessage(root, sha);
  const run = message === null ? 0 : (commitRunOf(message) ?? 0);
  const entry = recoveredMergeEntry(role, sha, meta, run);
  // A fresh pin is the caller's own current run's change (part 3e/7): merge it under its own
  // subject, not labelled recovered leftover work. A pin the commit's Run trailer attributes to
  // an earlier run — leftover recovery re-pinning what the prior run left behind (part 3i/7) —
  // keeps the recovered label, and a pin the commit's Run trailer attributes to an earlier
  // run does the same. A
  // hand-made commit with no Run trailer reads run 0, which no real run number uses, so it is
  // never fresh even before the role's first run. Same run-vs-current comparison the drain's
  // pin-claim withdrawal already relies on.
  const isFresh = opts.currentRun !== undefined && run !== 0 && run === opts.currentRun;
  return isFresh && meta.subject !== undefined ? { ...entry, summary: meta.subject } : entry;
}
