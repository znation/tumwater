import { openQuestions } from "./backlog.js";
import { logEvent } from "./events.js";
import { headOf } from "./git.js";
import { aheadOfMainFiles } from "./git-diff.js";
import {
  conflictedFiles,
  continueRebase,
  ffMainTo,
  hasConflictMarkers,
  rebaseOntoMain,
  rebaseOntoMainLeaveConflicts,
} from "./landing-git.js";
import { abortSync } from "./worktree.js";
import { type BuildCheckOutcome, runScopedBuildCheck } from "./build-check.js";
import { type BuildCheck, gateCommandOf } from "./build-check-detect.js";
import { noteGreenBaseline } from "./main-baseline.js";
import { isExemptDiff } from "./exemptions.js";
import { falseFixReason } from "./fix-claim.js";
import { backlogStructureReason } from "./backlog-structure.js";
import { warnEvent } from "./events.js";
import { withLock } from "./lock.js";
import { buildConflictPrompt } from "./gate-prompts.js";
import { mergeLockDir } from "./paths.js";
import { syncRootInstall } from "./dep-install.js";
import type { TumwaterConfig } from "./config-schema.js";
import type { TickResult } from "./tick-outcome.js";
import type { RunsPi } from "./loop-pi.js";

/** Landing a change on main: rebase onto main (keeping history linear), re-verify the rebased
 * tree with the project's declared check when main moved under it, fast-forward, and —
 * when the rebase conflicts — one pi-driven resolution attempt before giving up. The landing is
 * worktree-parameterized: whatever `wt` holds at its HEAD after the rebase is what lands — a role
 * branch (whose ref tracks its own tip through the rebase) or a detached lander worktree pinned
 * at a bare sha (which does not move when git rebase rewrites it, so fast-forwarding to the
 * original pin would fail whenever main moved between commit and landing). Split out of loop.ts —
 * which keeps the tick lifecycle around it — because this is a self-contained concern with its own
 * flow (lock → rebase → ff-merge → conflict retry) and its own git surface; the only things it
 * borrows from the loop are identity (root/mainBranch), `role` for events and session naming only,
 * the current tick number for session naming, and the loop's shared pi wiring so a
 * conflict-resolution run folds into the same tick counters as an authoring run. */

/** What mergeToMain needs from its owning loop: identity (root, main branch), the role for
 * events and session naming only — the landing code never re-derives it into a branch — plus the
 * tick number that names the conflict-resolution session, and the loop's shared pi runner (role
 * config, session dir, raw log, transient-timeout retry) with usage folded into the tick counters
 * — every pi run of a tick lands there exactly once. */
export interface MergeContext extends RunsPi {
  root: string;
  role: string;
  mainBranch: string;
  /** The live config — the in-lock re-check detects the project's declared check through
   * it (plans/portability.md §6/7), exactly as the review gate's pre-check does. */
  config: TumwaterConfig;
  /** The review gate's exemption patterns (config.review.exemptPaths) — the in-lock re-check
   * skips doc-only deltas with exactly the same test the gate applies. */
  exemptPaths: string[];
  /** The current tick number (names the conflict-resolution pi session). */
  tick: number;
  /** Told when the in-lock check went red on the rebased tree — the one merge_blocked cause
   * that is the change's own (landing-core.ts counts it toward LANDING_CHECK_FAILURE_LIMIT); a failed
   * fast-forward or a false fix never calls it. */
  onLandingCheckRed?(check: BuildCheck, outcome: BuildCheckOutcome): void;
}

/** Land the worktree branch on main under the shared merge lock: rebase it onto main (keeping
 * history linear), verify the rebased tree when it differs from what was reviewed, and
 * fast-forward. On conflict, makes one pi-driven resolution attempt
 * (outside the lock) before giving up. A routine conflict is normal operation, not a warning:
 * success lands as an ordinary `merged` event and failure surfaces via the tick's merge_conflict
 * result — no separate log line for the hand-off itself. A merged diff that adds entries under
 * QUESTIONS.md's ## Open also emits one `question_posted` per new heading alongside the `merged`
 * event, so `tumwater logs` shows what the fleet is asking for (plans/questions-outbox.md).
 * `verifiedHead` is the head the review gate's pre-check just ran green on
 * (GateResult.verifiedHead) — when the rebase turns out to be a no-op it names the exact tree
 * about to land, so the in-lock re-check can both skip and seed the baseline from it; pass
 * undefined when no fresh green observation was made (exempt diff, review disabled,
 * already-approved early return). */
export async function mergeToMain(
  ctx: MergeContext,
  wt: string,
  summary: string,
  verifiedHead?: string,
): Promise<TickResult> {
  // The branch tip before ANY rebase of this landing. Captured once here — not per tryMerge —
  // because the conflict-retry path rebases twice: after pi resolves, the second attempt's
  // rebase is a no-op even though its tree (the resolution) was never checked.
  const preMergeHead = await headOf(wt, "HEAD");
  const first = await tryMerge(ctx, wt, summary, preMergeHead, verifiedHead);
  if (first !== "merge_conflict") return first;
  if (!(await resolveConflict(ctx, wt))) return "merge_conflict";
  return tryMerge(ctx, wt, summary, preMergeHead, verifiedHead);
}

/** Emit one `question_posted` event per entry QUESTIONS.md's ## Open gained since `before` —
 * the capture-and-diff both merge paths record alongside their `merged` events (tryMerge and
 * ffStackToMain). The capture (`openQuestions(root)` under the merge lock, before the ff) stays
 * with the callers: the lock window is theirs to define, and the diff is only exact while the
 * capture and this call share it. */
function logNewQuestions(root: string, before: string[], role: string): void {
  for (const question of openQuestions(root)) {
    if (!before.includes(question)) {
      logEvent(root, { loop: role, type: "question_posted", question });
    }
  }
}

async function tryMerge(
  ctx: MergeContext,
  wt: string,
  summary: string,
  preMergeHead: string,
  verifiedHead?: string,
): Promise<TickResult> {
  return withLock(mergeLockDir(ctx.root), async () => {
    // Capture the Open questions before the rebase so a merged diff that posts new ones can
    // emit one question_posted per entry. The lock keeps no other merge landing between capture
    // and compare, so the diff is exact; on the conflict path only the second tryMerge call ever
    // reaches the post-ff code, so nothing double-emits.
    const before = openQuestions(ctx.root);
    if (!(await rebaseOntoMain(wt, ctx.mainBranch))) return "merge_conflict";
    // The gate's pre-check ran OUTSIDE this lock against the head as it stood then; a rebase
    // that rewrote anything means the tree about to land is new bytes (BUGS.md 2026-09-08).
    // Re-verify exactly what will become main before fast-forwarding.
    if (!(await verifyLanding(ctx, wt, await headOf(wt, "HEAD"), preMergeHead, verifiedHead)))
      return "merge_blocked";
    // Fast-forward to the worktree's POST-REBASE HEAD, not a ref captured before it: a branch
    // ref tracks its own tip through the rebase (so this is behavior-preserving for role
    // branches), but a pinned bare sha does not move when git rebase rewrites it — ff'ing main
    // to the original pin would fail as merge_blocked whenever main moved between commit and
    // landing, which under concurrency is the common case (review runs outside this lock).
    if (!(await ffMainTo(ctx.root, await headOf(wt, "HEAD"), ctx.mainBranch))) return "merge_blocked";
    const commit = await headOf(ctx.root, ctx.mainBranch);
    logEvent(ctx.root, { loop: ctx.role, type: "merged", commit, summary });
    logNewQuestions(ctx.root, before, ctx.role);
    // Still under the lock: a landing that moved main's lockfile re-syncs the root install
    // every worktree resolves through before the next landing's check runs (BUGS.md 2026-10-01).
    await syncRootInstall(ctx.root, ctx.role);
    return "changed";
  });
}

/** The backlog-structure cross-check both verifyLanding paths run (exempt and code diffs
 * alike): when the tree ahead of main duplicates or drops a `## ` section heading, warn on the
 * role's feed with the one "landing blocked:" phrasing and return the reason (null when the
 * headings are intact). Shared so the wording and the block action cannot drift between the
 * paths. */
async function structureBlocked(
  ctx: { root: string; role: string; mainBranch: string },
  wt: string,
  files: string[],
): Promise<string | null> {
  const structure = await backlogStructureReason(wt, ctx.mainBranch, files);
  if (!structure) return null;
  warnEvent(ctx.root, ctx.role, `landing blocked: ${structure}`);
  return structure;
}

/** The exempt arm's full cross-check — backlog structure, then fix-claim — shared by
 * verifyLanding and landing-batch.ts's stack skip: an md-only tree delta that skips the build
 * check must not wave through an edit the gate would have rejected. Returns the first blocking
 * reason (a structure reason already warned as "landing blocked: ..."), or null when the skip
 * may proceed. */
export async function exemptSkipBlockReason(
  ctx: { root: string; role: string; mainBranch: string },
  wt: string,
  files: string[],
): Promise<string | null> {
  const structure = await structureBlocked(ctx, wt, files);
  if (structure) return structure;
  return (await falseFixReason(wt, ctx.mainBranch, files)) ?? null;
}

/** Verify the exact tree about to land on main — the post-rebase head (BUGS.md 2026-09-08: the
 * gate's pre-check ran outside this lock against a head the rebase may have rewritten, so the
 * bytes that become main were never run through a check). Returns false when the tree is
 * structurally unsound (backlogStructureReason: a duplicated or dropped `## ` section heading,
 * with a warning event so a broken conflict resolution shows on the dashboards) or when the
 * project's declared check FAILS on the rebased tree; every other outcome lands. Skips:
 * - no-op rebase (`rebasedHead === preMergeHead`): main did not move under us, so the landing
 *   tree is byte-identical to what this gate invocation already checked (or to a tree nothing
 *   checks — exempt diff / review disabled). When `verifiedHead` names it, seed the red-main
 *   baseline with the SHA that becomes main: every role's next fresh tick then hits the cache
 *   instead of re-running the full suite on an already-verified tree. Not taken when a
 *   `check.gateCommand` is configured: the gate then ran only that, not the full check.
 * - doc-only delta ahead of main (the gate's own exemption test): cannot break the build.
 * - no declared check at all: nothing to run, exactly like the gate skipping its pre-check.
 * An environmental skip (no npm / broken toolchain) warns and proceeds — deliberately NOT
 * fail-closed, so a broken toolchain that would fail every check regardless of the tree
 * (BUGS.md 2026-09-15) cannot wedge every landing behind the merge lock. A TIMEOUT is not
 * environmental here: the tree is unverified, so runScopedBuildCheck remaps it to a failed
 * check and the landing rejects (BUGS.md: an unverified landing must not reach main). */
async function verifyLanding(
  ctx: MergeContext,
  wt: string,
  rebasedHead: string,
  preMergeHead: string,
  verifiedHead?: string,
): Promise<boolean> {
  // With a check.gateCommand configured the gate ran only that cheaper check, so a no-op
  // rebase's tree has never been through the full check: fall through and run it here, once —
  // the landing scope is what verifies a single change (and each change of an abandoned
  // stack), and a gateCommand green must never seed the baseline (PLANS.md Land-queue speed 3e).
  if (rebasedHead === preMergeHead && gateCommandOf(ctx.config) === undefined) {
    if (rebasedHead === verifiedHead) noteGreenBaseline(rebasedHead);
    return true;
  }
  const files = await aheadOfMainFiles(wt, ctx.mainBranch);
  if (isExemptDiff(files, ctx.exemptPaths)) {
    // Same cross-checks as the gate (fix-claim.ts, backlog-structure.ts): the in-lock re-check
    // must not wave through an md-only edit the gate would have rejected — and this is the
    // site that catches what the gate cannot see: a conflict resolution happens AFTER the
    // gate, inside this lock, so a resolution that kept both sides of a `## Done` conflict and
    // duplicated the heading lands here or not at all (PLANS.md 2026-09-25, 9eaae5ac).
    return (await exemptSkipBlockReason(ctx, wt, files)) === null;
  }
  // The heading check for code diffs too, before the build check: a conflict resolution that
  // broke backlog structure reads as an explained block on the dashboards, not as an
  // unexplained red check run on a tree that could never land.
  if (await structureBlocked(ctx, wt, files)) return false;
  // The run itself (build_check event, environmental-skip warning) lives in
  // runScopedBuildCheck, shared with the review gate's pre-check.
  const check = await runScopedBuildCheck(ctx.root, ctx.role, "landing", wt, ctx.config);
  if (!check) return true; // No declared check: nothing to run, exactly like the gate skipping its pre-check.
  if (check.outcome.status === "failed") {
    ctx.onLandingCheckRed?.(check.check, check.outcome);
    return false;
  }
  if (check.outcome.status === "skipped") return true; // No npm / broken toolchain — the helper already warned.
  // Green on exactly the tree that becomes main: seed it so the next tick's red-main baseline
  // check is a cache hit instead of one redundant full-suite run.
  noteGreenBaseline(rebasedHead);
  return true;
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
 * landing-stack.ts's BATCH_RESTACK_ATTEMPTS), and only a race lost on every attempt keeps every
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

