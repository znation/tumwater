/** The stack lander — the merge-half machinery of a multi-change batch (extracted from
 * landing-batch.ts, whose header scopes that file to the vet and merge halves): assemble the
 * vetted changes as a cherry-picked stack on main's current tip, run ONE scope-`batch` build
 * check over the combined tree, and fast-forward main through the captured shas — with the
 * re-stack loop for a main that moves mid-check, the doc-only exemption and its cross-checks,
 * and the per-attempt abort observation. The bisect over a red stack (landVetted, in
 * landing-batch.ts) drives this file's landStack one prefix at a time. */

import { COMMIT_IDENT, deleteRef, gitLines, gitTry, headOf } from "./git.js";
import { landingRefName } from "./paths.js";
import { ensureDetachedWorktree } from "./worktree.js";
import { exemptSkipBlockReason, logNewQuestions } from "./landing-merge.js";
import { openQuestions } from "./backlog.js";
import { logEvent } from "./events.js";
import { ffMainTo } from "./landing-git.js";
import { syncRootInstall } from "./dep-install.js";
import { withLock } from "./lock.js";
import { mergeLockDir } from "./paths.js";
import { type BuildCheckOutcome } from "./build-check.js";
import { runScopedBuildCheck } from "./build-check-scoped.js";
import type { BuildCheck } from "./build-check-detect.js";
import { noteGreenBaseline } from "./main-baseline.js";
import { isExemptDiff } from "./exemptions.js";
import { checkWaitStage, setLandingStage } from "./landing-slot.js";
import type { TumwaterConfig } from "./config-schema.js";

/** What landStack needs from its caller (landing-batch.ts's BatchContext): the repo, main,
 * the live config, and the task's abort signal — deliberately thinner than BatchContext. */
interface StackContext {
  root: string;
  mainBranch: string;
  config: TumwaterConfig;
  signal(): AbortSignal;
}

/** How many times a batch whose fast-forward lost the race to a moved main re-stacks onto the
 * new tip and goes round again before handing every change to leftover recovery as
 * `merge_blocked`. The race window is the whole batch check, and main still has writers
 * outside the land queue (a human commit, or a second fleet on the same repo), so a
 * lost race is routine and one re-stack almost always wins it — the second is headroom for a
 * busy stretch. The bound keeps a main that moves faster than a check completes from holding
 * the merge slot (and every vetted landing behind it) indefinitely: each re-stack
 * whose new tree is not doc-only pays one more full check. Past it the per-change path takes
 * over, whose in-lock re-check another harness landing cannot race. */
export const BATCH_RESTACK_ATTEMPTS = 2;

/** One stacked change as the fast-forward lands it: its role, its post-pick sha, its summary. */
export type StackEntry = { role: string; sha: string; summary: string };

/** Assemble a batch's stack in `wtPath` (S[0]'s lander worktree) on main's CURRENT tip, once
 * per attempt — a re-stack after a lost fast-forward race is the same assembly on the tip that
 * won. `entries` carry each change's head to land (its synced pin); the result carries that
 * base (`base` — the tip the stack's own delta is measured against) plus each change's
 * captured post-pick sha, in queue order — the stack ffStackToMain lands. Returns null when
 * the stack cannot be assembled on this tip: main is unreadable, or a pick conflicts (or
 * applies nothing — the crash-window re-drain); the caller abandons to one-at-a-time. */
async function assembleStack(
  root: string,
  mainBranch: string,
  wtPath: string,
  entries: readonly StackEntry[],
): Promise<{ base: string; landed: StackEntry[] } | null> {
  // Base the stack on main's CURRENT tip and cherry-pick every change onto it — the head
  // included. A later batch of a longer drain (5 queued, cap 3) holds pins based on the
  // main the FIRST batch already moved; stacking from S[0].sha there would put the ff
  // against diverged history on every attempt. When main hasn't moved since the pins were
  // created (the common single-batch case) the picks reconstruct the same tree and the ff
  // lands the same tip. Every entry — the head included — carries its captured post-pick sha
  // into the ff and the per-change merged events.
  const base = await gitTry(root, "rev-parse", mainBranch);
  if (base === null) return null; // main unreadable: cannot stack
  // One idempotent ensure at the fresh base covers the worktree-a-moment-ago case (the
  // change's vet, or the previous attempt's assembly).
  const wt = await ensureDetachedWorktree(root, wtPath, base);
  const landed: StackEntry[] = [];
  for (const entry of entries) {
    // Cherry-pick the whole RANGE from main's tip to the entry's head to land — `base..sha`,
    // every commit ahead of main, in queue order. A pin is normally one commit, so the range is
    // that commit; picking the range rather than the head alone keeps a pin that carries more
    // from landing only its last diff and orphaning the work beneath it. (Not a
    // rebase: after 2/5 the role branches sit at main and each landing lives only in its
    // pinned ref — there is nothing to rebase.)
    const pick = await gitTry(wt, ...COMMIT_IDENT, "cherry-pick", `${base}..${entry.sha}`);
    if (pick === null) {
      // A conflict (or an already-applied patch — the crash-window re-drain): abort the
      // pick and abandon to one-at-a-time. The worktree may be left mid-state; its next
      // ensureDetachedWorktree hard-resets it.
      await gitTry(wt, "cherry-pick", "--abort");
      return null;
    }
    landed.push({ role: entry.role, sha: await headOf(wt, "HEAD"), summary: entry.summary });
  }
  return { base, landed };
}

/** True when the tree at `to` differs from the tree at `from` only in review-exempt paths —
 * the gate's own doc-only test (isExemptDiff over config.review.exemptPaths). A re-stack whose
 * new commits from main were doc-only rebuilds the checked tree with nothing but doc bytes
 * changed, and a doc-only delta cannot break the build: the reasoning verifyLanding
 * (src/landing-merge.ts) applies when it skips its in-lock re-check for a moved doc-only landing. Its
 * false-fix cross-check has no counterpart here — the delta is commits main already landed
 * through their own gate, not a claim this batch makes. --no-renames so a rename out of a
 * code path lists the deleted source, not only its exempt destination. An unreadable diff is
 * not exempt: the caller runs the check. */
async function exemptTreeDelta(
  root: string,
  from: string,
  to: string,
  exemptPaths: string[],
): Promise<boolean> {
  const out = await gitTry(root, "diff", "--no-renames", "--name-only", from, to);
  return out !== null && isExemptDiff(gitLines(out), exemptPaths);
}

/** What one landStack call came to: `landed` — main fast-forwarded through every entry;
 * `red` — the check over the stacked tree failed (the check and its outcome, for the reasons);
 * `conflict` — the stack cannot be assembled on main's tip, or cannot be landed as a stack (a
 * doc-only stack that failed a cross-check: the one-at-a-time fallback lands its changes
 * through verifyLanding's exempt arm, which blocks or rejects with the proper handling);
 * `blocked` — the fast-forward lost
 * the race to a moved main on every attempt; `aborted` — a stop arrived before an attempt. */
export type StackOutcome =
  | { kind: "landed" }
  | { kind: "red"; check: BuildCheck; outcome: BuildCheckOutcome }
  | { kind: "conflict" | "blocked" | "aborted" };

/** Land `entries` — the whole stack, or one bisect prefix of it — as ONE fast-forward on its
 * own green check: assemble them on main's current tip in `wtPath`, run ONE scope-`batch`
 * check over the combined tree, and ff main through the captured shas (ffStackToMain) with
 * nothing rewritten in between — the in-lock invariant. A lost race re-stacks on the tip that
 * won, up to BATCH_RESTACK_ATTEMPTS times, and a re-stack whose tree is the checked tree plus
 * doc-only commits skips its re-check (exemptTreeDelta). A stack whose whole delta ahead of
 * its assembly base is review-exempt skips the check too — a doc-only delta cannot break the
 * build (the reasoning verifyLanding's exempt arm applies) — and runs the same cross-checks
 * that arm runs, the backlog heading structure and the false-fix claim; one that fails either
 * returns `conflict`, so the per-change fallback applies the gate's own verdict per change.
 * On `landed` every entry's ref is deleted and the red-main baseline is seeded with the tip
 * when a check PASSED on exactly it — a skipped check seeds nothing, like verifyLanding's
 * exempt arm. The check's events log under the first entry's role. */
export async function landStack(ctx: StackContext, wtPath: string, entries: readonly StackEntry[]): Promise<StackOutcome> {
  // The last stacked tip a build check actually ran on: a re-stack whose tree differs from it
  // only in doc-only paths lands on that run's verdict instead of paying another.
  let checkedTip: string | null = null;
  const exemptPaths = ctx.config.review.exemptPaths;
  for (let attempt = 0; attempt <= BATCH_RESTACK_ATTEMPTS; attempt++) {
    // A shutdown (or a user stop for any batched role) before an attempt — the first one
    // included, so a stop that arrived after the last gate (a restart hand-off past its
    // deadline, BUGS.md 2026-09-23) never starts the batch's one expensive shared step.
    if (ctx.signal().aborted) return { kind: "aborted" };
    const assembled = await assembleStack(ctx.root, ctx.mainBranch, wtPath, entries);
    if (assembled === null) return { kind: "conflict" }; // main unreadable or a pick conflicted
    const { base, landed } = assembled;
    const tip = landed.at(-1)!.sha;
    // The expensive deterministic half, shared: ONE run over the combined tree. Outcome
    // routing — null: no declared check, land directly; "failed": red or a merge-scope
    // timeout, the caller bisects; "skipped": no npm / broken toolchain (the helper warned),
    // proceed — never fail-closed; "passed": green. A re-stack skips the run only when its
    // tree is the checked tree plus doc-only changes (exemptTreeDelta).
    let seed: string | undefined; // the tip a PASSED check ran on exactly, seeded after the ff
    const docOnlyRestack = checkedTip !== null && (await exemptTreeDelta(ctx.root, checkedTip, tip, exemptPaths));
    if (!docOnlyRestack) {
      // The stack's own delta ahead of its assembly base — main here is the tip assembleStack
      // stacked on — decides like verifyLanding does: doc-only cannot break the build, so no
      // check runs (a doc-only stack, or a bisect's size-1 doc-only remainder, lands on the
      // exemption instead of paying a suite run no code change asked for).
      const stackDiff = await gitTry(ctx.root, "diff", "--no-renames", "--name-only", base, tip);
      const stackFiles = stackDiff === null ? null : gitLines(stackDiff);
      if (stackFiles !== null && isExemptDiff(stackFiles, exemptPaths)) {
        // The same cross-checks verifyLanding's exempt arm runs (landing-merge.ts's
        // exemptSkipBlockReason): the skip must not wave through an md-only edit the gate would
        // have rejected. A failure here cannot name a red check (none ran), so it hands the
        // stack to the one-at-a-time fallback, whose exempt arm blocks or rejects each change
        // with the proper handling. No baseline seeds — nothing ran on this tip.
        if (await exemptSkipBlockReason(
          { root: ctx.root, role: entries[0]!.role, mainBranch: ctx.mainBranch },
          wtPath,
          stackFiles,
        )) return { kind: "conflict" };
      } else {
        // The landing cell names the check while it runs, then the merge steps after it — the ff
        // or what the caller does next — on every stacked change's own record.
        const roles = entries.map((e) => e.role);
        for (const role of roles) setLandingStage(ctx.root, role, "build-check");
        const check = await runScopedBuildCheck(
          ctx.root,
          roles[0]!,
          "batch",
          wtPath,
          ctx.config,
          undefined,
          undefined,
          undefined,
          checkWaitStage(ctx.root, roles),
        );
        for (const e of entries) setLandingStage(ctx.root, e.role, "merging");
        if (check !== null && check.outcome.status === "failed") return { kind: "red", ...check };
        checkedTip = tip;
        if (check !== null && check.outcome.status === "passed") seed = tip;
      }
    }
    if ((await ffStackToMain(ctx.root, ctx.mainBranch, landed)) === "changed") {
      // A PASSED stack check ran on exactly the future main tip — seed the red-main
      // baseline after (not before) the successful ff, so a merge_blocked stack seeds
      // nothing; a skipped check seeds nothing either (skips never seed), and neither does
      // a doc-only re-stack (like verifyLanding's exempt arm: nothing ran on this tip).
      if (seed !== undefined) noteGreenBaseline(seed);
      for (const e of entries) await deleteRef(ctx.root, landingRefName(e.role));
      return { kind: "landed" };
    }
    // Main moved under the batch while the check ran (a human commit): diverged history, ff
    // failed. Re-stack on the tip that won.
  }
  return { kind: "blocked" };
}

/** Fast-forward main through a WHOLE batch of already-reviewed landings in one (merge queue
 * 5/5): `landed` is the stack in queue order, each entry the change's captured post-pick sha
 * plus its own role and summary. Under the merge lock: one `ffMainTo` to the stacked tip (the
 * LAST entry's sha — a single ff through N stacked commits), one `merged` event PER entry so
 * the report counts the batch as N commits, and the question_posted diff around that single ff
 * (one-shot, as tryMerge's). No rebase and no in-lock re-check inside this helper — that is
 * what makes the batch's one shared stack check sufficient (the design invariant): nothing
 * rewrites between the lander's green check and this ff, so a successful ff makes main
 * byte-identical to the checked tip (or, after a doc-only re-stack, to that tip plus the
 * doc-only commits main gained). `noteGreenBaseline` stays out of it too — the lander
 * seeds the stacked tip, because it alone knows whether its own check passed. A failed ff
 * (main moved under the batch — diverged history) returns "merge_blocked" with NO events and
 * no ref changes: the lander re-stacks onto the new tip and calls this again (bounded by
 * BATCH_RESTACK_ATTEMPTS), and only a race lost on every attempt keeps every
 * change's ref for one-at-a-time recovery, whose tryMerge carries the in-lock check. The
 * single-change path is untouched. */
export async function ffStackToMain(
  root: string,
  mainBranch: string,
  landed: Array<{ role: string; sha: string; summary: string }>,
): Promise<"changed" | "merge_blocked"> {
  const tip = landed.at(-1);
  if (!tip) return "changed"; // Empty stack: nothing to fast-forward (never called in production — the lander stacks at least one change).
  return withLock(mergeLockDir(root), async () => {
    const before = openQuestions(root);
    if (!(await ffMainTo(root, tip.sha, mainBranch))) return "merge_blocked";
    for (const entry of landed) {
      logEvent(root, { loop: entry.role, type: "merged", commit: entry.sha, summary: entry.summary });
    }
    logNewQuestions(root, before, landed[0]!.role);
    await syncRootInstall(root, tip.role); // As tryMerge: re-sync the root install under the lock.
    return "changed";
  });
}