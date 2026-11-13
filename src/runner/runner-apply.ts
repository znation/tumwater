/** The change-apply half of a run, split out of runner-run.ts (2026-11-11, which shed its
 * leftover-recovery half into runner-leftover-recovery.ts): the pre-author steps that re-apply a
 * change over current main — `applyConflictHandback` re-applies a handed-back change with its
 * conflict markers left in place, `applyRevisionOrReject` re-applies a rejected diff for revision,
 * and `resendHandoffNote` re-sends a hand-off's hand-back note to its fresh session. Each appends
 * its note to the prompt `runWithWorktreePhase` authors; they run before the author run and after
 * recovery. (The run's own post-kill abort/reset phases live in runner-recovery.ts, a different
 * thing — this module applies a change, that one settles a killed run.) */
import { DIRECTOR_ROLE } from "../roles/roles.js";
import { deleteRef, commitMessage, changeBaseRev } from "../git/git.js";
import { mergeRefName, rejectedRefName } from "../paths.js";
import { logEventBestEffort } from "../events/events.js";
import { applyRevision, applyWithConflicts } from "./runner-revision.js";
import { conflictedFileHunks, hasConflictMarkers, mainCommitsTouching } from "../merge/merge-git.js";
import { changedFiles } from "../git/git-diff.js";
import { appendPromptNote, prependPromptNote } from "../text/format.js";
import { buildConflictHandbackNote } from "../prompt/gate-prompts.js";
import { buildRevisionNote, buildRejectedReviewNote } from "../prompt/gate-notes.js";
import type { RunnerRunContext } from "./runner-run.js";
import type { RunStartPlan } from "../run/run-resume.js";
import type { ConflictIntent } from "../prompt/gate-prompts.js";

/** The intent the author needs to resolve a handed-back change: the change's own commit message
 * and the main commits that touched its conflicted files since its merge-base. Mirrors what
 * resolveConflict gathers for the merge resolver (src/merge/merge-to-main.ts) and feeds the
 * same prompt block through buildConflictHandbackNote. */
async function handbackIntent(wt: string, mainBranch: string, sha: string, conflicted: readonly string[]): Promise<ConflictIntent> {
  const change = (await commitMessage(wt, sha)) ?? "";
  const since = await changeBaseRev(wt, mainBranch, sha);
  const { commits, omitted } = await mainCommitsTouching(wt, since, mainBranch, conflicted as string[]);
  return { change, main: commits, ...(omitted > 0 ? { mainOmitted: omitted } : {}) };
}

/** Build the conflict-handback note for a change re-applied over current main: derive the
 * author intent from the change's own commit and the main commits touching its conflicted
 * files, then append the handback note built from that intent, the same reason and each file's
 * conflict hunk ranges as they sit in `wt` now. All three handback-note sites (merge apply,
 * revision apply, handoff resume) share this so the intent and the note never drift apart. */
async function appendHandbackNote(
  prompt: string,
  wt: string,
  mainBranch: string,
  sha: string,
  reason: "merge" | "revision",
  conflicted: readonly string[],
): Promise<string> {
  const intent = await handbackIntent(wt, mainBranch, sha, conflicted);
  return appendPromptNote(prompt, buildConflictHandbackNote(reason, conflictedFileHunks(wt, conflicted), intent));
}

/** The repo-relative paths in `wt` that currently carry conflict markers. The apply path knows
 * its conflicted set because applyWithConflicts reads the unmerged index; a handoff resumes that
 * already-applied worktree, where the mixed reset dropped the unmerged index entries and the
 * marker-bearing files remain as ordinary working-tree edits. Reads the same marker definition
 * (hasConflictMarkers) the stage check and review gate use, over the worktree's changed files. */
async function markerBearingFiles(wt: string): Promise<string[]> {
  const files = await changedFiles(wt);
  return files.filter((f) => hasConflictMarkers(wt, [f]));
}

/** How does a conflict hand-back get re-applied? A change handed back after its merges kept
 * conflicting — or a persisted hand-back the author's run has not applied yet — is re-applied
 * over current main with the conflict markers left as ordinary uncommitted edits so this run
 * resolves them (PLANS.md "Robust conflict landing, part 2/2"). The merge ref is deleted once
 * the diff is in the worktree. Runs before the revision branch, which applies a revision
 * hand-back itself. A resume or handoff keeps the interrupted worktree as-is, so re-applying
 * here would cherry-pick onto those kept edits; both skip it, exactly as before this feature
 * for a resume. */
export async function applyConflictHandback(
  ctx: RunnerRunContext,
  plan: RunStartPlan,
  wt: string,
  prompt: string,
): Promise<{ prompt: string }> {
  const s = ctx.state;
  const { resuming, handoff, userPrompt } = plan;
  if (
    s.conflictHandback &&
    !s.conflictHandback.applied &&
    ctx.role !== DIRECTOR_ROLE &&
    userPrompt === null &&
    !resuming &&
    !handoff
  ) {
    const hb = s.conflictHandback;
    const applied = await applyWithConflicts(wt, ctx.mainBranch, hb.sha);
    if (applied.applied) {
      s.conflictHandback = { ...hb, applied: true };
      await deleteRef(ctx.root, mergeRefName(ctx.role));
      logEventBestEffort(ctx.root, {
        source: ctx.role,
        type: "conflict_handback",
        action: "applied",
        sha: hb.sha,
        reason: hb.reason,
        conflicted: applied.conflicted,
      });
      prompt = await appendHandbackNote(prompt, wt, ctx.mainBranch, hb.sha, hb.reason, applied.conflicted);
    } else {
      // The object is gone or the apply failed for a non-conflict reason: drop the hand-back
      // so the author starts fresh rather than retrying it every run.
      s.conflictHandback = undefined;
      await deleteRef(ctx.root, mergeRefName(ctx.role));
      logEventBestEffort(ctx.root, { source: ctx.role, type: "conflict_handback", action: "failed", sha: hb.sha, reason: hb.reason });
    }
  }
  return { prompt };
}

/** How is a rejected diff revised? A rejected change owes a revision (plans/revise-rejected.md):
 * re-apply its diff to current main as uncommitted edits so this run revises it instead of
 * authoring from scratch, and append the revision note the prompt skipped. `revisionRound`
 * records that THIS run holds the rejected diff — set only when the revision is applied here,
 * or a resume carries the prior attempt's already-applied edits — so the post-run handlers read
 * the run rather than `state.revision`, which a per-role user-request run leaves set by design.
 * A conflict (or a gone object) clears the revision, deletes the rejected ref, and falls back to
 * the plain rejection note. */
export async function applyRevisionOrReject(
  ctx: RunnerRunContext,
  plan: RunStartPlan,
  wt: string,
  prompt: string,
): Promise<{ prompt: string; revisionRound: number | undefined }> {
  const s = ctx.state;
  const { resuming, handoff, userPrompt } = plan;
  let revisionRound: number | undefined;
  if (s.revision && ctx.role !== DIRECTOR_ROLE && userPrompt === null) {
    const { sha, round } = s.revision;
    // The prompt's rejected/revision notes read the runner's most recent rejection; an absent
    // one (a fresh runner or a hand-edited state) reads the empty reasons list. Computed once
    // for the three revision-append sites and the rejected-note fallback below, so the
    // get-or-default idiom cannot drift between them.
    const lastReviewOrEmpty = s.lastReview ?? { reasons: [] };
    const revisionNote = buildRevisionNote(lastReviewOrEmpty, round);
    if (resuming || handoff) {
      // The interrupted revision run's applied edits are still in the worktree (both the
      // resume and the cross-agent handoff keep uncommitted work), so this run still owns
      // the revision. A handoff runs the revision in a fresh session rather than
      // re-cherry-picking it onto the already-dirty worktree.
      revisionRound = round;
      if (handoff) {
        // A handoff is a FRESH session: it has none of the interrupted run's context, and
        // run-prompt.ts suppresses the rejected-review note whenever state.revision is set,
        // so without this the fresh run would see neither the objections nor the revision
        // instructions. A resume keeps its session context and must not see the note twice.
        prompt = prependPromptNote(prompt, revisionNote);
      }
    } else if (await applyRevision(wt, ctx.mainBranch, sha)) {
      revisionRound = round;
      logEventBestEffort(ctx.root, { source: ctx.role, type: "revision", action: "applied", round, sha });
      prompt = prependPromptNote(prompt, revisionNote);
    } else {
      // The clean re-apply conflicted: re-apply with the markers left in place so the author
      // resolves them rather than losing the revision (PLANS.md "Robust conflict landing, part
      // 2/2"). Only a non-conflict failure falls back to the plain rejection note.
      const withConflicts = await applyWithConflicts(wt, ctx.mainBranch, sha);
      if (withConflicts.applied) {
        revisionRound = round;
        s.conflictHandback = {
          sha,
          at: Date.now(),
          reason: "revision",
          round,
          applied: true,
        };
        logEventBestEffort(ctx.root, { source: ctx.role, type: "revision", action: "applied", round, sha });
        logEventBestEffort(ctx.root, {
          source: ctx.role,
          type: "conflict_handback",
          action: "applied",
          sha,
          reason: "revision",
          conflicted: withConflicts.conflicted,
        });
        prompt = prependPromptNote(prompt, revisionNote);
        prompt = await appendHandbackNote(prompt, wt, ctx.mainBranch, sha, "revision", withConflicts.conflicted);
      } else {
        s.revision = undefined;
        await deleteRef(ctx.root, rejectedRefName(ctx.role));
        logEventBestEffort(ctx.root, { source: ctx.role, type: "revision", action: "conflict", round, sha });
        prompt = prependPromptNote(prompt, buildRejectedReviewNote(lastReviewOrEmpty, ctx.role));
        prompt = appendPromptNote(prompt, "The rejected diff no longer applies to current main.");
      }
    }
  }
  return { prompt, revisionRound };
}

/** How does a handoff re-send its conflict note? A handoff runs a FRESH session over the
 * interrupted run's kept worktree. When that run had already applied a conflict hand-back, the
 * marker-bearing files are still there but the fresh run has none of the interrupted session's
 * context explaining them, so re-send the hand-back note (a resume keeps its session context and
 * must not see the note twice). The revision block above covers a revision hand-back's own note;
 * this covers every hand-back reason, including a merge hand-back with no revision. Unlike the
 * apply path there is no index to read, so the conflicted set comes from the worktree's current
 * marker-bearing files. */
export async function resendHandoffNote(
  ctx: RunnerRunContext,
  plan: RunStartPlan,
  wt: string,
  prompt: string,
): Promise<{ prompt: string }> {
  const s = ctx.state;
  if (plan.handoff && s.conflictHandback?.applied) {
    const hb = s.conflictHandback;
    const conflicted = await markerBearingFiles(wt);
    prompt = await appendHandbackNote(prompt, wt, ctx.mainBranch, hb.sha, hb.reason, conflicted);
  }
  return { prompt };
}

