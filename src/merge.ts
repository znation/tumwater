import fs from "node:fs";
import path from "node:path";
import { openQuestions } from "./backlog.js";
import { logEvent } from "./events.js";
import {
  COMMIT_IDENT,
  aheadOfMainFiles,
  currentBranch,
  git,
  gitTry,
  headOf,
  runGit,
  unquotePorcelainPath,
} from "./git.js";
import { abortSync } from "./worktree.js";
import {
  BUILD_CHECK_TIMEOUT_MS,
  detectBuildCheck,
  noteGreenBaseline,
  runBuildCheck,
} from "./build-check.js";
import { isExemptDiff } from "./exemptions.js";
import { withLock } from "./lock.js";
import { buildConflictPrompt } from "./prompt.js";
import { mergeLockDir } from "./paths.js";
import type { PiRunResult, TickResult } from "./types.js";

/** Landing a change on main: rebase onto main (keeping history linear), re-verify the rebased
 * tree with the project's declared check when main moved under it, fast-forward, and —
 * when the rebase conflicts — one pi-driven resolution attempt before giving up. The landing is
 * worktree- and ref-parameterized — `MergeContext.ref` names what to land instead of deriving it
 * from the role, so loop.ts passes its own worktree and branch exactly as before, and later plans
 * (merge queue 2/5) pass a pinned sha from a lander worktree. Split out of loop.ts — which keeps
 * the tick lifecycle around it — because this is a self-contained concern with its own flow
 * (lock → rebase → ff-merge → conflict retry) and its own git surface; the only things it borrows
 * from the loop are identity (root/ref/mainBranch), `role` for events and session naming only,
 * the current tick number for session naming, and the loop's shared pi wiring so a
 * conflict-resolution run folds into the same tick counters as an authoring run. */

/** What mergeToMain needs from its owning loop: identity (root, the ref to land, main branch),
 * the role for events and session naming only — the landing code never re-derives it into a
 * branch — plus the tick number that names the conflict-resolution session, and the loop's shared
 * pi runner (role config, session dir, raw log, transient-timeout retry) with usage folded into
 * the tick counters — every pi run of a tick lands there exactly once. */
export interface MergeContext {
  root: string;
  /** The ref to land on main: anything `git rev-parse` accepts (the role's branch today; a bare
   * sha from merge queue 2/5 onward). */
  ref: string;
  role: string;
  mainBranch: string;
  /** The review gate's exemption patterns (config.review.exemptPaths) — the in-lock re-check
   * skips doc-only deltas with exactly the same test the gate applies. */
  exemptPaths: string[];
  /** The current tick number (names the conflict-resolution pi session). */
  tick: number;
  /** Run one pi run in `wt` with the loop's shared wiring and fold its usage into the tick. */
  runPi(wt: string, prompt: string, sessionName: string): Promise<PiRunResult>;
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
    if (!(await ffMainTo(ctx.root, ctx.ref, ctx.mainBranch))) return "merge_blocked";
    const commit = await headOf(ctx.root, ctx.mainBranch);
    logEvent(ctx.root, { loop: ctx.role, type: "merged", commit, summary });
    for (const question of openQuestions(ctx.root)) {
      if (!before.includes(question)) {
        logEvent(ctx.root, { loop: ctx.role, type: "question_posted", question });
      }
    }
    return "changed";
  });
}

/** Verify the exact tree about to land on main — the post-rebase head (BUGS.md 2026-09-08: the
 * gate's pre-check ran outside this lock against a head the rebase may have rewritten, so the
 * bytes that become main were never run through a check). Returns false only when the project's
 * declared check FAILS on the rebased tree; every other outcome lands. Skips:
 * - no-op rebase (`rebasedHead === preMergeHead`): main did not move under us, so the landing
 *   tree is byte-identical to what this gate invocation already checked (or to a tree nothing
 *   checks — exempt diff / review disabled). When `verifiedHead` names it, seed the red-main
 *   baseline with the SHA that becomes main: every role's next fresh tick then hits the cache
 *   instead of re-running the full suite on an already-verified tree.
 * - doc-only delta ahead of main (the gate's own exemption test): cannot break the build.
 * - no declared check at all: nothing to run, exactly like the gate skipping its pre-check.
 * An environmental skip (timeout / no npm) warns and proceeds — deliberately NOT fail-closed,
 * so a hung build script cannot wedge every landing behind the merge lock. */
async function verifyLanding(
  ctx: MergeContext,
  wt: string,
  rebasedHead: string,
  preMergeHead: string,
  verifiedHead?: string,
): Promise<boolean> {
  if (rebasedHead === preMergeHead) {
    if (rebasedHead === verifiedHead) noteGreenBaseline(rebasedHead);
    return true;
  }
  const files = await aheadOfMainFiles(wt, ctx.mainBranch);
  if (isExemptDiff(files, ctx.exemptPaths)) return true;
  const check = detectBuildCheck(wt);
  if (!check) return true;
  const startedAt = Date.now();
  const outcome = await runBuildCheck(wt, check);
  logEvent(ctx.root, {
    loop: ctx.role,
    type: "build_check",
    scope: "landing",
    status: outcome.status,
    script: check.script,
    durationMs: Date.now() - startedAt,
  });
  if (outcome.status === "failed") return false;
  if (outcome.status === "skipped") {
    logEvent(ctx.root, {
      loop: ctx.role,
      type: "warning",
      message:
        outcome.skipReason === "no-npm"
          ? "no npm on PATH; skipping landing build check"
          : `landing build check timed out after ${BUILD_CHECK_TIMEOUT_MS / 1000}s; proceeding to merge`,
    });
    return true;
  }
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

// ── Git helpers for the landing flow ───────────────────────────────────────────────────────
// Moved here from git.ts (organize tick 78): every one of them is used only by this module —
// they are the rebase/ff-merge surface of landing, not general git plumbing. git.ts keeps
// the shared primitives they build on (git/runGit/gitTry, COMMIT_IDENT, headOf) and exports
// runGit + unquotePorcelainPath for them.

/** Paths currently in conflict (unmerged) in the worktree. C-quoted names are decoded to
 * real paths — a non-ASCII conflicted file arrives as `"h\303\251llo.ts"` (core.quotePath is on
 * by default), and undecoded it does not exist on disk: hasConflictMarkers could never read
 * it, so an unresolved conflict in such a file passed the marker check and continueRebase
 * committed its markers to main. */
export async function conflictedFiles(wt: string): Promise<string[]> {
  const out = await gitTry(wt, "diff", "--name-only", "--diff-filter=U");
  return out ? out.split("\n").filter(Boolean).map(unquotePorcelainPath) : [];
}

/** Attempt to rebase the worktree branch onto main and classify the outcome WITHOUT
 * cleaning up: "rebased" (including already up to date), "conflict" (the rebase stopped on
 * unmerged paths, which remain in the worktree for a resolver), or "other" (any other
 * failure). Shared by the two rebase wrappers below, which differ only in cleanup policy.
 * Rebase — not merge — keeps main's history linear: each tick lands as its own commit on top
 * of whatever main holds. */
async function attemptRebase(
  wt: string,
  mainBranch: string,
): Promise<"rebased" | "conflict" | "other"> {
  try {
    // The -c ident is needed for the rewritten committer identity.
    await runGit(wt, [...COMMIT_IDENT, "rebase", mainBranch]);
    return "rebased";
  } catch {
    return (await conflictedFiles(wt)).length > 0 ? "conflict" : "other";
  }
}

/** Rebase the worktree branch onto main (main may have advanced during the tick).
 * Returns false and aborts the rebase on conflict. */
export async function rebaseOntoMain(wt: string, mainBranch: string): Promise<boolean> {
  const state = await attemptRebase(wt, mainBranch);
  if (state !== "rebased") await gitTry(wt, "rebase", "--abort");
  return state === "rebased";
}

/** Rebase the worktree branch onto main, leaving conflict markers in place for a
 * resolver to work on. "clean" = rebased (or already up to date); "conflict" = the rebase
 * stopped on conflicts and the worktree holds them mid-rebase; "failed" = anything else
 * (aborted and cleaned up). */
export async function rebaseOntoMainLeaveConflicts(
  wt: string,
  mainBranch: string,
): Promise<"clean" | "conflict" | "failed"> {
  const state = await attemptRebase(wt, mainBranch);
  if (state === "other") await gitTry(wt, "rebase", "--abort");
  return state === "rebased" ? "clean" : state === "conflict" ? "conflict" : "failed";
}

/** True if any of the given files still contains a git conflict marker.
 * A deleted file counts as resolved (the resolver chose the deletion). */
export function hasConflictMarkers(wt: string, files: string[]): boolean {
  // Only start/end markers are checked: every real conflict block carries them, while a bare
  // `=======` line is legitimate content (a markdown setext or RST underline of exactly seven
  // characters), and flagging it would reject clean resolutions forever. A resolver that
  // leaves only a separator line behind is treated as resolved; its stray line is content the
  // project's own tests can catch.
  const marker = /^(<{7}|>{7})( |$)/m;
  return files.some((f) => {
    const p = path.join(wt, f);
    try {
      return marker.test(fs.readFileSync(p, "utf8"));
    } catch {
      return false;
    }
  });
}

/** Conclude an in-progress rebase with everything in the worktree as the resolution.
 * GIT_EDITOR=true so `rebase --continue` can never block on a commit-message prompt. A
 * resolution that leaves no unique content (the branch's change was fully superseded by
 * main) is skipped automatically by git, finishing the rebase cleanly. Throws when the
 * rebase stops again — e.g. on a second conflict from an extra commit pi authored during
 * the tick; the caller aborts and reports merge_conflict. */
export async function continueRebase(wt: string): Promise<string> {
  await git(wt, "add", "-A");
  await runGit(wt, [...COMMIT_IDENT, "rebase", "--continue"], { GIT_EDITOR: "true" });
  return headOf(wt, "HEAD");
}

/** Fast-forward main to `ref`, without touching any remote. `ref` is anything `git rev-parse`
 * accepts — a branch name today, a bare sha from merge queue 2/5 onward; both arms already accept
 * either form (`merge --ff-only <sha>` and `push . <sha>:<main>`). Uses a working-tree merge when
 * the primary checkout is on main (so its files update), otherwise a local ref push. Returns true
 * on success. */
export async function ffMainTo(root: string, ref: string, mainBranch: string): Promise<boolean> {
  const primaryBranch = await currentBranch(root);
  if (primaryBranch === mainBranch) {
    return (await gitTry(root, "merge", "--ff-only", ref)) !== null;
  }
  return (await gitTry(root, "push", ".", `${ref}:${mainBranch}`)) !== null;
}
