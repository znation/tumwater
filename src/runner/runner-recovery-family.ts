import { logEventBestEffort } from "../events/events.js";
import { recoverLeftover, setAsideWithdrawnWork } from "./runner-leftover.js";
import { resetWorktreeToMain } from "../git/worktree.js";
import { appendPromptNote } from "../text/format.js";
import { buildConflictDiscardNote, buildMainKnownRedNote } from "../prompt/gate-notes.js";
import { mainRedHealNote, namedFailures } from "../baseline/main-red.js";
import { remoteCiBlockFor } from "../observer/remote-ci.js";
import { watchedBaseline } from "../baseline/main-baseline.js";
import type { RunnerRunContext } from "./runner-run.js";
import type { RunStartPlan } from "../run/run-resume.js";
import type { RunOutcome } from "../run/run-outcome.js";
import type { LeftoverRecovery } from "./runner-leftover.js";
import type { RunnerState } from "./runner-state.js";

/** How does a run recover a leftover? A previous run may have left a commit unmerged
 * (runner-leftover.ts): recovery re-pins it, so it merges through the
 * orchestrator's merge pipeline — the same gate as a fresh run's change, and main keeps exactly
 * one writer (an in-run recovery merge raced the slot's batches into `merge_blocked`). A
 * salvaged leftover ENDS the run: the role holds one merge ref, and the leftover owns it until
 * its merge resolves. With nothing to salvage the branch holds nothing either, so a reset below
 * leaves pristine main. Returns `null` for the promptless skipped ends, `"end"` carrying the
 * outcome for every non-`already_queued` recovery, and `"continue"` carrying the prompt the run
 * authors on (with any discard or red-main note appended). */
export async function recoverLeftoversForRun(
  ctx: RunnerRunContext,
  plan: RunStartPlan,
  wt: string,
): Promise<{ action: "end"; outcome: RunOutcome } | { action: "continue"; prompt: string } | null> {
  const s = ctx.state;
  // A withdrawn claim's interrupted run may have committed or pinned work that carries no claim
  // for the merge to check: set it aside first, so the recovery below has nothing of it to queue.
  await setAsideWithdrawnWork({ root: ctx.root, role: ctx.role, mainBranch: ctx.mainBranch, wt }, s);
  const recovered = await recoverLeftover({
    root: ctx.root,
    role: ctx.role,
    mainBranch: ctx.mainBranch,
    runNumber: s.runs,
    wt,
    mergeConflicts: s.mergeConflicts,
    conflictHandback: s.conflictHandback,
    queuedSummary: s.queuedSummary,
  });
  const settled = await handleRecoveredLeftover(ctx, plan, wt, s, recovered);
  if (settled === null) return null;
  if (settled.action === "end") return settled;
  await resetWorktreeToMain(wt, ctx.mainBranch);
  // A promptless recovery run found nothing to salvage (or deleted a stale pin): it authors
  // nothing, so it ends here rather than reach the authoring run with a null prompt.
  if (plan.prompt === null) return null;
  return { action: "continue", prompt: await recoveryNotesForRun(ctx, wt, settled.prompt) };
}

/** How does a run settle the leftover it recovered? A promptless hand-back has no authoring run
 * to hand the pin back to, so it leaves the pin and the conflict state exactly as they are (the
 * one hand-back the lineage is owed happens on the director's next prompt-driven run) and returns
 * `null` for the skipped end. A conflict hand-back keeps the pin, records the hand-back in state
 * and logs the `conflict_handback` `queued` event, then falls through to author the resolution on
 * current main. A discarded pin clears both conflict fields, records `s.conflictDiscard` and
 * appends the discard note. Every other recovery except `already_queued` ends the run through
 * `ctx.finishRecoveryRun`; `already_queued` and an absent recovery fall through as `continue`
 * with the prompt unchanged, so the reset and red-main notes happen back in the caller. */
async function handleRecoveredLeftover(
  ctx: RunnerRunContext,
  plan: RunStartPlan,
  wt: string,
  s: RunnerState,
  recovered: LeftoverRecovery | null,
): Promise<{ action: "end"; outcome: RunOutcome } | { action: "continue"; prompt: string } | null> {
  if (recovered?.kind === "handback" && plan.prompt === null) {
    // A promptless recovery run has no authoring run to hand the pin back to: leave the pin and
    // the conflict state exactly as they are, so the one hand-back the lineage is owed happens on
    // the director's next prompt-driven run.
    await resetWorktreeToMain(wt, ctx.mainBranch);
    return null;
  }
  let prompt = plan.prompt ?? "";
  if (recovered?.kind === "handback") {
    // The pin hit the conflict cap and its lineage has not been handed back yet: keep the
    // pin, record the hand-back, and fall through to author the resolution on current main.
    // The apply happens below, beside the revision branch.
    s.mergeConflicts = undefined;
    s.conflictHandback = {
      sha: recovered.sha,
      at: Date.now(),
      reason: "merge",
      applied: false,
    };
    logEventBestEffort(ctx.root, { source: ctx.role, type: "conflict_handback", action: "queued", sha: recovered.sha, reason: "merge" });
  } else if (recovered?.kind === "discarded") {
    // The pin hit the conflict cap and is gone: nothing holds the role any more, so this
    // run authors on a fresh main like any other — told what was dropped and why.
    s.mergeConflicts = undefined;
    s.conflictHandback = undefined;
    s.conflictDiscard = { sha: recovered.sha, summary: recovered.summary, attempts: recovered.attempts, at: Date.now() };
    prompt = appendPromptNote(prompt, buildConflictDiscardNote(recovered.summary, recovered.attempts));
  } else if (recovered && recovered.kind !== "already_queued") {
    // Every recovery kind ends the run here — EXCEPT `already_queued`, whose arm the
    // scheduler admits (the interlock relief applies team-wide) and whose branch is at main:
    // that one falls through to author below instead of ending. Every other kind,
    // `relief_wait` (a held commit ahead of main beside a queued entry) included, ends the
    // run.
    return {
      action: "end",
      outcome: await ctx.finishRecoveryRun(recovered, plan.userPrompt, wt, plan.priorMergeFailure),
    };
  }
  return { action: "continue", prompt };
}

/** What red-main note does a run's prompt carry? `ci` owns the repair: a red main appends a
 * `<main-red>` heal note (the worktree is pristine main right now, so the healer reproduces and
 * fixes that failure rather than hunting blind) and the Remote CI block rides this same ci-only
 * async hook (detection spawns git and the prompt builder is synchronous). Every other role
 * authors on the red main unblocked, told which tests already fail through the `<main-known-red>`
 * note — a pure read of the main watch's persisted verdict (watchedBaseline runs no check), so
 * the block appears only when a verdict names failures and a role's start pays nothing for it. */
async function recoveryNotesForRun(ctx: RunnerRunContext, wt: string, prompt: string): Promise<string> {
  // The `ci` healer's red-main hand-off (src/baseline/main-red.ts): the worktree is pristine
  // main right now, so a red main appends a <main-red> note to this run's prompt and the
  // healer reproduces and fixes that failure rather than hunting blind. Every other role
  // authors on the red main unblocked — the red-main authoring block came off with the
  // pre-merge blocks, parts 3g/3–3j/3 and 3d/3–3f/3.
  if (ctx.baseRole === "ci") {
    const note = await mainRedHealNote(ctx.root, ctx.role, wt);
    if (note) prompt = appendPromptNote(prompt, note);
    // The Remote CI block (plans/remote-ci.md "Shape"): detection spawns git, and the prompt
    // builder is synchronous, so the block rides this ci-only async hook beside the heal note.
    // It holds facts and one read-only command, never instructions; a throw appends nothing —
    // a detection failure must never fail the run (the same wrap policy the heal note gets).
    try {
      const block = await remoteCiBlockFor(ctx.root, ctx.config);
      if (block) prompt = appendPromptNote(prompt, block);
    } catch {
      // no block — the run proceeds without the remote check
    }
  } else {
    // Every other role proceeds on the red main, told which tests already fail (the
    // <main-known-red> note, restored 2026-10-25): a pure read of the main watch's persisted
    // verdict (watchedBaseline runs no check), so the block appears only when a verdict names
    // failures and a role's start pays nothing for it. `ci` owns the repair without
    // monopolizing it — a fix from any role lands like any other change.
    const baseline = await watchedBaseline(wt);
    const tests = baseline?.status === "red" ? namedFailures(baseline) : [];
    if (tests.length > 0) prompt = appendPromptNote(prompt, buildMainKnownRedNote(tests));
  }
  return prompt;
}
