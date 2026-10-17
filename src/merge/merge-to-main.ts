// vocabulary: plain
import { openQuestions } from "../backlog/backlog.js";
import { logEventBestEffort, warnEventBestEffort } from "../events/events.js";
import { changeBaseRev, commitMessage, headOf } from "../git/git.js";
import { aheadOfMainFiles, treeDiffFiles } from "../git/git-diff.js";
import { resolvedDiffDiverges } from "./merge-diff.js";
import {
  conflictedFiles,
  continueRebase,
  ffMainToOrWhy,
  hasConflictMarkers,
  mainCommitsTouching,
  rebaseOntoMain,
  rebaseOntoMainLeaveConflicts,
} from "./merge-git.js";
import { resolveBacklogInsertConflicts } from "./backlog-conflicts.js";
import { abortSync } from "../git/worktree.js";
import type { BuildCheckOutcome } from "../build/build-check.js";
import { runScopedBuildCheck } from "../build/build-check-scoped.js";
import { type BuildCheck, detectBuildCheck, gateCommandOf } from "../build/build-check-detect.js";
import { noteGreenBaseline, noteInheritedGreen } from "../baseline/main-baseline.js";
import { isExemptDiff } from "../review/exemptions.js";
import { falseFixReason } from "../verdict/fix-claim.js";
import { backlogStructureReason } from "../backlog/backlog-structure.js";
import { withLock } from "../concurrency/lock.js";
import { buildConflictPrompt } from "../prompt/gate-prompts.js";
import { mergeLockDir } from "../paths.js";
import { logNewQuestions } from "./merge-questions.js";
import { checkWaitStage, setMergeStage } from "./merge-slot.js";
import { syncRootInstall } from "../build/dep-install.js";
import type { TumwaterConfig } from "../config/config-schema.js";
import { resolverConfig } from "../config/config-views.js";
import type { TickResult } from "../tick/tick-outcome.js";
import type { RunsPi } from "../loop/loop-pi.js";
import type { PiRunResult } from "../pi/pi-run-result.js";

/** Merge a change on main: rebase onto main (keeping history linear), re-verify the rebased tree
 * with the project's declared check when main moved under it, fast-forward, and — when the rebase
 * conflicts — one pi-driven resolution attempt before giving up. The merge is
 * worktree-parameterized: whatever `wt` holds at its HEAD after the rebase is what merges — a role
 * branch (whose ref tracks its own tip through the rebase) or a detached merger worktree pinned at
 * a bare sha (which does not move when git rebase rewrites it, so fast-forwarding to the original
 * pin would fail whenever main moved between commit and merge). Split out of loop.ts — which
 * keeps the tick lifecycle around it — because this is a self-contained concern with its own flow
 * (lock → rebase → ff-merge → conflict retry) and its own git surface; the only things it
 * borrows from the loop are identity (root/mainBranch), `role` for events and session naming only,
 * the current tick number for session naming, the live config and its review-exemption patterns
 * (the in-lock re-check), and the loop's shared pi wiring so a conflict-resolution run folds into
 * the same tick counters as an authoring run. */

/** MergeContext: what mergeToMain needs from its owning loop (merge-core.ts's MergerContext is
 * the merger's, a different shape): identity (root, main branch), the role for events
 * and session naming only — the merge code never re-derives it into a branch — plus the tick
 * number that names the conflict-resolution session, the live config and its review-exemption
 * patterns (the in-lock re-check), and the loop's shared pi runner (role config, session dir,
 * raw log, transient-timeout retry) with usage folded into the tick counters — every pi run of a
 * tick merges there exactly once. */
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
   * that is the change's own (merge-check-failures.ts counts it toward
   * MERGE_CHECK_FAILURE_LIMIT); a failed fast-forward or a false fix never calls it. */
  onMergeCheckRed?(check: BuildCheck, outcome: BuildCheckOutcome): void;
  /** Told when verifyMerge blocks the merge for a reason that is not a red check — the
   * exempt arm's fix-claim or backlog-structure cross-checks (a conflict resolution's tree can
   * trip either). The merger puts the reason in lastError; the warning event itself is emitted
   * here in merge-to-main.ts, so a blocked resolution reads on the dashboards (BUGS.md
   * 2026-10-02: the block used to be silent). */
  onMergeBlocked?(reason: string): void;
  /** The gate, re-run over a conflict resolution's tree: a resolution whose diff ahead of main
   * is not a subset of the diff the reviewer approved has authored bytes the reviewer never
   * judged (BUGS.md 2026-10-01: a resolver restored code main had deliberately reverted, and
   * the build check alone waved it onto main). mergeToMain calls this once, only on the conflict
   * path, only when the resolved diff diverges, with the worktree sitting on the resolved head;
   * an "approved" verdict (with the head the re-review's pre-check ran green on, when it ran
   * one) proceeds to the merge — whose in-lock re-check then skips the redundant build check
   * the re-review just ran; "rejected" is terminal for the pin (the closure owns the ref and
   * the reject bookkeeping); "retry" keeps the ref for recovery's re-merge (an aborted or
   * under-cap-failed reviewer is not a verdict about the tree). Optional: without it a
   * resolution merges on the in-lock build check alone (the pre-fix behavior, and what tests
   * exercise). */
  recheckResolved?(wt: string): Promise<{
    verdict: "approved" | "rejected" | "retry";
    verifiedHead?: string;
  }>;
}

/** Merge the worktree branch on main under the shared merge lock: rebase it onto main (keeping
 * history linear), verify the rebased tree when it differs from what was reviewed, and
 * fast-forward. On conflict, makes one pi-driven resolution attempt
 * (outside the lock) before giving up. A routine conflict is normal operation, not a warning:
 * success merges as an ordinary `merged` event and failure surfaces via the tick's merge_conflict
 * result — no separate log line for the hand-off itself. A merged diff that adds entries under
 * QUESTIONS.md's ## Open also emits one `question_posted` per new heading alongside the `merged`
 * event, so `tumwater logs` shows what the team is asking for (plans/questions-outbox.md).
 * `verifiedHead` is the head the review gate's pre-check just ran green on
 * (GateResult.verifiedHead) — when the rebase turns out to be a no-op it names the exact tree
 * about to merge, so the in-lock re-check can both skip and seed the baseline from it; pass
 * undefined when no fresh green observation was made (exempt diff, review disabled,
 * already-approved early return). */
export async function mergeToMain(
  ctx: MergeContext,
  wt: string,
  summary: string,
  verifiedHead?: string,
): Promise<TickResult> {
  // The branch tip before ANY rebase of this merge. Captured once here — not per tryMerge —
  // because the conflict-retry path rebases twice: after pi resolves, the second attempt's
  // rebase is a no-op even though its tree (the resolution) was never checked.
  const preMergeHead = await headOf(wt, "HEAD");
  const first = await tryMerge(ctx, wt, summary, verifiedHead);
  if (first !== "merge_conflict") return first;
  if (!(await resolveConflict(ctx, wt, preMergeHead))) return "merge_conflict";
  // A resolution whose diff ahead of main introduces lines the reviewed change never added, or
  // removes lines the reviewed change never removed, has left the reviewer's scope: those bytes
  // were never judged, and the in-lock build check cannot judge intent (BUGS.md 2026-10-01: a
  // resolver restored 158 lines main had deliberately reverted). Re-run the gate over the
  // resolved tree before anything merges; a resolution that stays inside the reviewed change's
  // lines — including one that drops branch edits main superseded — re-merges with no extra run.
  if (ctx.recheckResolved && (await resolvedDiffDiverges(ctx, wt, preMergeHead))) {
    const recheck = await ctx.recheckResolved(wt);
    if (recheck.verdict === "rejected") return "rejected";
    if (recheck.verdict === "retry") return "merge_conflict";
    return tryMerge(ctx, wt, summary, recheck.verifiedHead ?? verifiedHead);
  }
  return tryMerge(ctx, wt, summary, verifiedHead);
}

/** Emit one `question_posted` event per entry QUESTIONS.md's ## Open gained since `before`,
 * recorded by merge-questions.ts's logNewQuestions alongside this module's `merged` event. */
async function tryMerge(
  ctx: MergeContext,
  wt: string,
  summary: string,
  verifiedHead?: string,
): Promise<TickResult> {
  return withLock(mergeLockDir(ctx.root), async () => {
    // Capture the Open questions before the rebase so a merged diff that posts new ones can
    // emit one question_posted per entry. The lock keeps no other merge between capture
    // and compare, so the diff is exact; on the conflict path only the second tryMerge call ever
    // reaches the post-ff code, so nothing double-emits.
    const before = openQuestions(ctx.root);
    if (!(await rebaseOntoMain(wt, ctx.mainBranch))) return "merge_conflict";
    // The gate's pre-check ran OUTSIDE this lock against the head as it stood then; a rebase
    // that rewrote anything means the tree about to merge is new bytes (BUGS.md 2026-09-08).
    // Re-verify exactly what will become main before fast-forwarding.
    // The worktree's POST-REBASE HEAD: fetched once and used for both the re-check and the
    // fast-forward. A branch ref tracks its own tip through the rebase (so this is
    // behavior-preserving for role branches), but a pinned bare sha does not move when git
    // rebase rewrites it — ff'ing main to the original pin would fail as merge_blocked whenever
    // main moved between commit and merge, which under concurrency is the common case (review
    // runs outside this lock).
    const target = await headOf(wt, "HEAD");
    if (!(await verifyMerge(ctx, wt, target, verifiedHead)))
      return "merge_blocked";
    const mainBefore = await headOf(ctx.root, ctx.mainBranch);
    const ffFailure = await ffMainToOrWhy(ctx.root, target, ctx.mainBranch);
    if (ffFailure !== null) {
      warnEventBestEffort(ctx.root, ctx.role, `merge blocked: ${ffFailure}`);
      return "merge_blocked";
    }
    const commit = await headOf(ctx.root, ctx.mainBranch);
    // A fast-forward to a commit main already contains is a no-op ("Already up to date"): the
    // change is already an ancestor of main (a leftover-recovery re-merge of an entry main
    // holds), so main's head is some later commit that did not produce this summary. Logging a
    // `merged` event there would count the already-counted merge a second time and pair the
    // change's summary with the wrong commit (BUGS.md 2026-10-10). Only a fast-forward that
    // moved main records a merge.
    // Best-effort: main has already fast-forwarded, so an unwritable events feed must not turn
    // a completed merge into a rejected one and skip syncRootInstall below — the same
    // no-torn-feed policy as the orchestrator's other post-effect logging.
    if (commit !== mainBefore)
      logEventBestEffort(ctx.root, { source: ctx.role, type: "merged", commit, summary });
    logNewQuestions(ctx.root, before, ctx.role);
    // Still under the lock: a merge that moved main's lockfile re-syncs the root install
    // every worktree resolves through before the next merge's check runs (BUGS.md 2026-10-01).
    await syncRootInstall(ctx.root, ctx.role);
    return "changed";
  });
}

/** The backlog-structure cross-check both verifyMerge paths run (exempt and code diffs
 * alike): when the tree ahead of main duplicates or drops a `## ` section heading, warn on the
 * role's feed with the one "merge blocked:" phrasing and return the reason (null when the
 * headings are intact). Shared so the wording and the block action cannot drift between the
 * paths. */
async function structureBlocked(
  ctx: { root: string; role: string; mainBranch: string },
  wt: string,
  files: string[],
): Promise<string | null> {
  const structure = await backlogStructureReason(wt, ctx.mainBranch, files);
  if (!structure) return null;
  warnEventBestEffort(ctx.root, ctx.role, `merge blocked: ${structure}`);
  return structure;
}

/** The exempt arm's full cross-check — backlog structure, then fix-claim — shared by
 * verifyMerge and merge-batch.ts's stack skip: an md-only tree delta that skips the build
 * check must not wave through an edit the gate would have rejected. Returns the first blocking
 * reason (a structure reason already warned as "merge blocked: ..."), or null when the skip
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
  if (fix) warnEventBestEffort(ctx.root, ctx.role, `merge blocked: ${fix}`);
  return fix ?? null;
}

/** Verify the exact tree about to reach main — the post-rebase head (BUGS.md 2026-09-08: the
 * gate's pre-check ran outside this lock against a head the rebase may have rewritten, so the
 * bytes that become main were never run through a check). Returns false when the tree is
 * structurally unsound (backlogStructureReason: a duplicated or dropped `## ` section heading,
 * with a warning event so a broken conflict resolution shows on the dashboards) or when the
 * project's declared check FAILS on the rebased tree; every other outcome merges. Skips:
 * - a no-op rebase whose exact tree the gate verified (`rebasedHead === verifiedHead`): main
 *   did not move under us, so the merge tree is byte-identical to what the gate's pre-check
 *   already ran green. Seed the red-main baseline with the SHA that becomes main: every role's
 *   next fresh tick then hits the cache instead of re-running the full suite on an
 *   already-verified tree. A no-op rebase the gate did NOT verify — its pre-check was skipped
 *   (a timeout, a killed run) — falls through and runs the merge-scope check, which fails
 *   closed on the same timeout; an exempt diff or a project with no declared check falls
 *   through to its own arm below. Not taken when a `check.gateCommand` is configured: the gate
 *   then ran only that, not the full check.
 * - doc-only delta ahead of main (the gate's own exemption test): cannot break the build.
 * - a code change whose rebased tree differs from the gate-verified one only in exempt paths
 *   (onlyExemptDriftFromVerified): main moved under the review by doc commits alone, so the
 *   bytes about to merge are the verified ones plus a delta that same rule exempts.
 * - no declared check at all: nothing to run, exactly like the gate skipping its pre-check.
 * An environmental skip (no npm / broken toolchain) warns and proceeds — deliberately NOT
 * fail-closed, so a broken toolchain that would fail every check regardless of the tree
 * (BUGS.md 2026-09-15) cannot wedge every merge behind the merge lock. A TIMEOUT is not
 * environmental here: the tree is unverified, so runScopedBuildCheck remaps it to a failed
 * check and the merge rejects (BUGS.md: an unverified merge must not reach main). */
async function verifyMerge(
  ctx: MergeContext,
  wt: string,
  rebasedHead: string,
  verifiedHead?: string,
): Promise<boolean> {
  // Trust only the tree the gate actually verified. The identity means the in-lock rebase was
  // a no-op on exactly the head the pre-check ran green on (a real conflict resolution's
  // re-review sets verifiedHead to the resolved head, and that second rebase is then a no-op).
  // A no-op rebase the gate never verified — its pre-check timed out or was killed and left
  // GateResult.verifiedHead undefined — falls through and runs the merge-scope check, which
  // fails closed on the same timeout. With a check.gateCommand configured the gate ran only
  // that cheaper check, so even a verified no-op rebase must run the full check here: the
  // merge scope is what verifies a single change (and each change of an abandoned stack),
  // and a gateCommand green must never seed the baseline.
  if (rebasedHead === verifiedHead && gateCommandOf(ctx.config) === undefined) {
    noteGreenBaseline(rebasedHead);
    return true;
  }
  const files = await aheadOfMainFiles(wt, ctx.mainBranch);
  if (isExemptDiff(files, ctx.exemptPaths)) {
    // Same cross-checks as the gate (fix-claim.ts, backlog-structure.ts): the in-lock re-check
    // must not wave through an md-only edit the gate would have rejected — and this is the
    // site that catches what the gate cannot see: a conflict resolution happens AFTER the
    // gate, inside this lock, so a resolution that kept both sides of a `## Done` conflict and
    // duplicated the heading merges here or not at all (PLANS.md 2026-09-25, 9eaae5ac).
    const reason = await exemptSkipBlockReason(ctx, wt, files);
    if (reason !== null) {
      ctx.onMergeBlocked?.(reason);
      return false;
    }
    return true;
  }
  // The heading check for code diffs too, before the build check: a conflict resolution that
  // broke backlog structure reads as an explained block on the dashboards, not as an
  // unexplained red check run on a tree that could never merge.
  const structure = await structureBlocked(ctx, wt, files);
  if (structure) {
    ctx.onMergeBlocked?.(structure);
    return false;
  }
  if (await onlyExemptDriftFromVerified(ctx, wt, rebasedHead, verifiedHead)) return true;
  // The run itself (build_check event, environmental-skip warning) lives in
  // runScopedBuildCheck, shared with the review gate's pre-check. The merge cell names the
  // check (or its wait for a permit) while it runs, then the merge again for the ff.
  setMergeStage(ctx.root, ctx.role, "build-check");
  const check = await runScopedBuildCheck(
    ctx.root,
    ctx.role,
    "merge",
    wt,
    ctx.config,
    undefined,
    undefined,
    undefined,
    checkWaitStage(ctx.root, [ctx.role]),
  );
  setMergeStage(ctx.root, ctx.role, "merging");
  if (!check) return true; // No declared check: nothing to run, exactly like the gate skipping its pre-check.
  if (check.outcome.status === "failed") {
    ctx.onMergeCheckRed?.(check.check, check.outcome);
    return false;
  }
  if (check.outcome.status === "skipped") return true; // No npm / broken toolchain — the helper already warned.
  // Green on exactly the tree that becomes main: seed it so the next tick's red-main baseline
  // check is a cache hit instead of one redundant full-suite run.
  noteGreenBaseline(rebasedHead);
  return true;
}

/** True, after seeding the red-main baseline, when the tree about to merge differs from the tree
 * the gate's pre-check ran green on (`verifiedHead`) only in review-exempt paths. That is the usual
 * shape of "main moved under the review" here: 43% of main's commits are doc-only (plan, readme
 * and qa merge them all day), and 165 of 750 in-lock checks over 2026-10-02..12 re-ran the full
 * suite, holding the merge lock, for a tree that differed from its verified one by markdown
 * alone. The exempt-diff rule above already lets such a delta merge with no check at all, so the
 * same rule covers drift on top of a verified tree. An identical tree (empty drift, a rebase
 * that only rewrote SHAs) is the verified bytes themselves and seeds an observed green. Any
 * other drift seeds an inherited one, which attribution re-checks before trusting
 * (main-baseline.ts's observedOnly). Not taken without a verified head (the pre-check was skipped
 * or never ran) or with a `check.gateCommand`, for the same reasons the no-op skip above is not.
 * A git failure means "not proven" and the check runs. */
async function onlyExemptDriftFromVerified(
  ctx: MergeContext,
  wt: string,
  rebasedHead: string,
  verifiedHead: string | undefined,
): Promise<boolean> {
  if (verifiedHead === undefined || gateCommandOf(ctx.config) !== undefined) return false;
  const drift = await treeDiffFiles(wt, verifiedHead, rebasedHead);
  if (drift === null || !isExemptDiff(drift, ctx.exemptPaths)) return false;
  if (drift.length === 0) noteGreenBaseline(rebasedHead);
  else noteInheritedGreen(rebasedHead, verifiedHead);
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
  // conflicts in the backlog markdown — two merges pasting different entries as the first
  // under ## Done — carry no authored bytes, so they are settled without a model run. Only the
  // files it could not resolve (code, or a same-entry edit) reach the resolver below.
  const remaining = await resolveBacklogInsertConflicts(wt, files);
  if (remaining.length === 0) {
    // A second stop is only possible when the branch holds more than the one insert-only
    // commit. One attempt per tick.
    return continueOrAbortRebase(wt);
  }
  // The prompt names the project's own check, detected the way the in-lock re-check detects it,
  // as the one verifyMerge runs on the resolution — so the resolver neither guesses a runner
  // (BUGS.md 2026-10-05) nor re-runs the check itself while the merge slot waits on it.
  const check = detectBuildCheck(wt, ctx.config) ?? undefined;
  // Show both sides' intent: the change's own commit message and the main commits that touched
  // a conflicted file since the merge-base. The
  // markers alone never said why either side made the edit.
  const since = await changeBaseRev(wt, ctx.mainBranch, preMergeHead);
  const change = (await commitMessage(wt, preMergeHead)) ?? "";
  const { commits, omitted } = await mainCommitsTouching(wt, since, ctx.mainBranch, remaining);
  // The merge cell names the resolver run, not "merging" (a no-op outside a queued merge):
  // the run holds the merge slot, and every queued merge waits on it. Back to `merging` once it
  // ends, whatever happened — the merge's git steps come next, or the merge ends.
  setMergeStage(ctx.root, ctx.role, "resolving");
  let pi: PiRunResult;
  try {
    pi = await ctx.runPi(
      wt,
      buildConflictPrompt(ctx.role, remaining, check, { change, main: commits, mainOmitted: omitted }),
      `tumwater-${ctx.role}-${ctx.tick}-conflict`,
      // The resolver rides the strong tier (plans/model-tiers.md part 4/8): resolution is rare,
      // tolerant of latency, and edits code inside merge. Its spend still folds into the
      // authoring role's usage — the fold belongs to the loop's wiring, not to the config.
      resolverConfig(ctx.config),
    );
  } finally {
    setMergeStage(ctx.root, ctx.role, "merging");
  }
  if (!pi.ok || hasConflictMarkers(wt, remaining)) {
    await abortSync(wt);
    return false;
  }
  // A second stop is only possible when pi itself authored extra commits during the tick.
  // One resolution attempt per tick.
  return continueOrAbortRebase(wt);
}
