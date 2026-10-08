import { openQuestions } from "../backlog/backlog.js";
import { logEvent, warnEvent } from "../events/events.js";
import { changeBaseRev, commitMessage, headOf } from "../git/git.js";
import { aheadOfMainFiles } from "../git/git-diff.js";
import { resolvedDiffDiverges } from "./landing-diff.js";
import {
  conflictedFiles,
  continueRebase,
  ffMainTo,
  hasConflictMarkers,
  mainCommitsTouching,
  rebaseOntoMain,
  rebaseOntoMainLeaveConflicts,
} from "./landing-git.js";
import { resolveBacklogInsertConflicts } from "./backlog-conflicts.js";
import { abortSync } from "../git/worktree.js";
import type { BuildCheckOutcome } from "../build/build-check.js";
import { runScopedBuildCheck } from "../build/build-check-scoped.js";
import { type BuildCheck, detectBuildCheck, gateCommandOf } from "../build/build-check-detect.js";
import { noteGreenBaseline } from "../baseline/main-baseline.js";
import { isExemptDiff } from "../review/exemptions.js";
import { falseFixReason } from "../verdict/fix-claim.js";
import { backlogStructureReason } from "../backlog/backlog-structure.js";
import { withLock } from "../concurrency/lock.js";
import { buildConflictPrompt } from "../gates/gate-prompts.js";
import { mergeLockDir } from "../paths.js";
import { logNewQuestions } from "./landing-questions.js";
import { checkWaitStage, setLandingStage } from "./landing-slot.js";
import { syncRootInstall } from "../build/dep-install.js";
import type { TumwaterConfig } from "../config/config-schema.js";
import { resolverConfig } from "../config/config-views.js";
import type { TickResult } from "../tick/tick-outcome.js";
import type { RunsPi } from "../loop/loop-pi.js";

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
   * that is the change's own (landing-check-failures.ts counts it toward LANDING_CHECK_FAILURE_LIMIT); a failed
   * fast-forward or a false fix never calls it. */
  onLandingCheckRed?(check: BuildCheck, outcome: BuildCheckOutcome): void;
  /** Told when verifyLanding blocks the landing for a reason that is not a red check — the
   * exempt arm's fix-claim or backlog-structure cross-checks (a conflict resolution's tree can
   * trip either). The lander puts the reason in lastError; the warning event itself is emitted
   * here in landing-merge.ts, so a blocked resolution reads on the dashboards (BUGS.md
   * 2026-10-02: the block used to be silent). */
  onLandingBlocked?(reason: string): void;
  /** The gate, re-run over a conflict resolution's tree: a resolution whose diff ahead of main
   * is not a subset of the diff the reviewer approved has authored bytes the reviewer never
   * judged (BUGS.md 2026-10-01: a resolver restored code main had deliberately reverted, and
   * the build check alone waved it onto main). mergeToMain calls this once, only on the conflict
   * path, only when the resolved diff diverges, with the worktree sitting on the resolved head;
   * an "approved" verdict (with the head the re-review's pre-check ran green on, when it ran
   * one) proceeds to the landing — whose in-lock re-check then skips the redundant build check
   * the re-review just ran; "rejected" is terminal for the pin (the closure owns the ref and
   * the reject bookkeeping); "retry" keeps the ref for recovery's re-land (an aborted or
   * under-cap-failed reviewer is not a verdict about the tree). Optional: without it a
   * resolution lands on the in-lock build check alone (the pre-fix behavior, and what tests
   * exercise). */
  recheckResolved?(wt: string): Promise<{
    verdict: "approved" | "rejected" | "retry";
    verifiedHead?: string;
  }>;
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
  if (!(await resolveConflict(ctx, wt, preMergeHead))) return "merge_conflict";
  // A resolution whose diff ahead of main introduces lines the reviewed change never added, or
  // removes lines the reviewed change never removed, has left the reviewer's scope: those bytes
  // were never judged, and the in-lock build check cannot judge intent (BUGS.md 2026-10-01: a
  // resolver restored 158 lines main had deliberately reverted). Re-run the gate over the
  // resolved tree before anything lands; a resolution that stays inside the reviewed change's
  // lines — including one that drops branch edits main superseded — re-lands with no extra run.
  if (ctx.recheckResolved && (await resolvedDiffDiverges(ctx, wt, preMergeHead))) {
    const recheck = await ctx.recheckResolved(wt);
    if (recheck.verdict === "rejected") return "rejected";
    if (recheck.verdict === "retry") return "merge_conflict";
    return tryMerge(ctx, wt, summary, preMergeHead, recheck.verifiedHead ?? verifiedHead);
  }
  return tryMerge(ctx, wt, summary, preMergeHead, verifiedHead);
}

/** Emit one `question_posted` event per entry QUESTIONS.md's ## Open gained since `before`,
 * recorded by landing-questions.ts's logNewQuestions alongside this module's `merged` event. */
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
  const fix = await falseFixReason(wt, ctx.mainBranch, files);
  // Warn like structureBlocked does: a fix-claim block that used to be silent read as five
  // unexplained merge_blocked retries on the feed (BUGS.md 2026-10-02). The batch stack-skip
  // caller may warn twice for one change (here, then again when the fallback's exempt arm
  // blocks it) — a duplicated line is harmless next to a silent block.
  if (fix) warnEvent(ctx.root, ctx.role, `landing blocked: ${fix}`);
  return fix ?? null;
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
  // The verifiedHead arm covers a conflict resolution the re-review gate just judged: the
  // in-lock rebase is then a no-op, so the tree is byte-identical to what that pre-check ran
  // green on, and the same trust (and the same gateCommand caveat) applies.
  if (
    (rebasedHead === preMergeHead || (verifiedHead !== undefined && rebasedHead === verifiedHead)) &&
    gateCommandOf(ctx.config) === undefined
  ) {
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
    const reason = await exemptSkipBlockReason(ctx, wt, files);
    if (reason !== null) {
      ctx.onLandingBlocked?.(reason);
      return false;
    }
    return true;
  }
  // The heading check for code diffs too, before the build check: a conflict resolution that
  // broke backlog structure reads as an explained block on the dashboards, not as an
  // unexplained red check run on a tree that could never land.
  const structure = await structureBlocked(ctx, wt, files);
  if (structure) {
    ctx.onLandingBlocked?.(structure);
    return false;
  }
  // The run itself (build_check event, environmental-skip warning) lives in
  // runScopedBuildCheck, shared with the review gate's pre-check. The landing cell names the
  // check (or its wait for a permit) while it runs, then the merge again for the ff.
  setLandingStage(ctx.root, ctx.role, "build-check");
  const check = await runScopedBuildCheck(
    ctx.root,
    ctx.role,
    "landing",
    wt,
    ctx.config,
    undefined,
    undefined,
    undefined,
    checkWaitStage(ctx.root, [ctx.role]),
  );
  setLandingStage(ctx.root, ctx.role, "merging");
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

/** Continue a stopped rebase, aborting it when it stops again on a second conflict, and
 * report whether the branch now sits cleanly on top of main. resolveConflict reaches this
 * from two points — the deterministic insert-only pass and the pi resolver — and both owe
 * the same abort-on-failure discipline, so it lives here once. */
async function continueOrAbortRebase(wt: string): Promise<boolean> {
  try {
    await continueRebase(wt);
    return true;
  } catch {
    await abortSync(wt);
    return false;
  }
}

/** Re-run the conflicting rebase leaving markers in place, settle insert-only backlog
 * conflicts deterministically, hand the rest to pi, and continue the rebase. Returns true
 * when the branch now sits cleanly on top of main. */
async function resolveConflict(ctx: MergeContext, wt: string, preMergeHead: string): Promise<boolean> {
  const state = await rebaseOntoMainLeaveConflicts(wt, ctx.mainBranch);
  if (state === "clean") return true;
  if (state === "failed") return false;
  const files = await conflictedFiles(wt);
  // Deterministic first pass (plans/parallel-work-instances.md, part 3/7): insert-only
  // conflicts in the backlog markdown — two landings pasting different entries as the first
  // under ## Done — carry no authored bytes, so they are settled without a model run. Only the
  // files it could not resolve (code, or a same-entry edit) reach the resolver below.
  const remaining = await resolveBacklogInsertConflicts(wt, files);
  if (remaining.length === 0) {
    // A second stop is only possible when the branch holds more than the one insert-only
    // commit. One attempt per tick.
    return continueOrAbortRebase(wt);
  }
  // The prompt names the project's own check, detected the way the in-lock re-check detects it,
  // so the resolver verifies with that instead of guessing a runner (BUGS.md 2026-10-05).
  const check = detectBuildCheck(wt, ctx.config) ?? undefined;
  // Show both sides' intent: the change's own commit message and the main commits that touched
  // a conflicted file since the merge-base (PLANS.md, Robust conflict landing part 1/2). The markers
  // alone never said why either side made the edit.
  const since = await changeBaseRev(wt, ctx.mainBranch, preMergeHead);
  const change = (await commitMessage(wt, preMergeHead)) ?? "";
  const { commits, omitted } = await mainCommitsTouching(wt, since, ctx.mainBranch, remaining);
  const pi = await ctx.runPi(
    wt,
    buildConflictPrompt(ctx.role, remaining, check, { change, main: commits, mainOmitted: omitted }),
    `tumwater-${ctx.role}-${ctx.tick}-conflict`,
    // The resolver rides the strong tier (plans/model-tiers.md part 4/8): resolution is rare,
    // tolerant of latency, and edits code inside landing. Its spend still folds into the
    // authoring role's usage — the fold belongs to the loop's wiring, not to the config.
    resolverConfig(ctx.config),
  );
  if (!pi.ok || hasConflictMarkers(wt, remaining)) {
    await abortSync(wt);
    return false;
  }
  // A second stop is only possible when pi itself authored extra commits during the tick.
  // One resolution attempt per tick.
  return continueOrAbortRebase(wt);
}
