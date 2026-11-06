import { withRunPermit } from "../concurrency/run-permit.js";
import { subscribeEvents, warnEventBestEffort, TUMWATER_SOURCE, logEventBestEffort } from "../events/events.js";
import { deleteRef, headOf, subjectOfCommit } from "../git/git.js";
import { ensureDetachedWorktree } from "../git/worktree.js";
import { useWorktree } from "../git/worktree-use.js";
import { postReviewWorktreePath, reviewFixRef, reviewRunSessionDir } from "../paths.js";
import {
  POST_REVIEW_FAILURE_LIMIT,
  addPostReview,
  readPostReviews,
  reviewMergedCommit,
  settlePostReview,
  type PostReview,
} from "../review/post-merge-review.js";
import { shortSha } from "../text/format.js";
import { formatDate } from "../text/datetime.js";
import { collapseWhitespace, errorMessage } from "../text/text.js";
import { fileBugsOnMain } from "../backlog/backlog-file-bugs.js";
import { abortOnShutdown, acquireUnlessAborted, guardMergeTask, type InFlightMerge, type MergePipeline, type MergePipelineContext } from "./merge-pipeline.js";
import { resolveWaitStage } from "./merge-slot.js";
import { mergeToMain } from "./merge-to-main.js";
import { MERGE_TIER, resolveAuthor, VERIFY_TIER } from "./merge-author.js";
import { gateBuildPrecheck } from "../review/review-precheck.js";
import { reviewAheadOfMain } from "../review/review.js";
import { setupFailureResult } from "../agent/agent-settle.js";
import { recordReview } from "../run/run-apply.js";
import { firstReason } from "../text/phrases.js";
import { saveRunnerStateBestEffort, type RunnerState } from "../runner/runner-state.js";
import type { RunResult } from "../run/run-outcome.js";

/** One poll of the post-merge reviews: a rejected commit is answered by the reviewer's own fix
 * (Forward, never back 1/6) — never by a revert — and a fix its pre-check rejects leaves that
 * entry rejected with no landed fix; an unverified (host-sleep) tree is also withheld, but that
 * entry stays queued for another review. Either way the next unreviewed commit starts its review
 * task. One review at a time, parked or running; starts a task and returns. */
export function drainPostReviews(ctx: MergePipelineContext, p: MergePipeline): void {
  const pending = readPostReviews(ctx.root);
  if (pending.length === 0) return;
  if (p.postReview !== null || ctx.startHeld()) return;
  const next = pending.find(unreviewed);
  if (next) startPostReview(ctx, p, next);
}

/** Whether an entry still awaits its review. A `fixed` entry is a settled record naming both shas
 * (the reviewed commit and its landed fix); a rejected one is terminal too — the reviewer proposed
 * no fix, or its pre-check withheld the one it proposed — so neither is ever re-reviewed (Forward
 * never back 1a/6). */
function unreviewed(e: PostReview): boolean {
  return e.rejected === undefined && e.fixed === undefined;
}

/** Start one review task and record it in `p.postReview` until it settles. It parks for a team
 * permit at VERIFY_TIER, ahead of every queued role run, as a pre-merge verification does. It
 * used to start only when a permit was free at the poll and never queue, and the peek's
 * synchronous return cleared `p.postReview` before the drain stored the task, leaving a settled
 * task in the slot. On 2026-11-03 that stopped every review until the next restart: 2 reviews
 * against 81 merges, 68 commits waiting. */
function startPostReview(ctx: MergePipelineContext, p: MergePipeline, entry: PostReview): void {
  const { root, semaphore } = ctx;
  const task: InFlightMerge = { promise: Promise.resolve(), controller: new AbortController(), roles: [], userAborted: false, parked: true };
  p.postReview = task;
  const detach = abortOnShutdown(ctx.signal, task.controller);
  const author = resolveAuthor(ctx, entry.role);
  const run = (async () => {
    try {
      const lease = await acquireUnlessAborted(semaphore, VERIFY_TIER, task.controller.signal);
      task.parked = false;
      if (lease === null) return; // a shutdown while parked: the entry stays for the next generation
      // A busy team's wait can be long. A restart or team hold that closed the gate meanwhile, or
      // an entry settled meanwhile (`tumwater review --accept`), hands the permit straight back.
      const stale = task.controller.signal.aborted || ctx.startHeld() ||
        !readPostReviews(root).some((e) => e.commit === entry.commit && unreviewed(e));
      if (stale) {
        lease.release();
        return;
      }
      let outcome;
      try {
        outcome = await reviewMergedCommit(root, ctx.liveConfig, entry, (opts) => author.runGatePi(opts), task.controller.signal);
      } finally {
        lease.release();
      }
      if (task.controller.signal.aborted) return; // a shutdown: the entry stays for the next generation
      if (outcome.kind === "approve") settlePostReview(root, entry.commit, null);
      else if (outcome.kind === "reject") settlePostReview(root, entry.commit, { ...entry, rejected: outcome.reasons });
      else if (outcome.kind === "fixed") await mergeReviewerFix(ctx, entry, outcome.fix, author.state);
      else if (outcome.kind === "exhausted") {
        // A self-fix chain at the backstop: reviewMergedCommit has already recorded the surviving
        // findings; the entry is cleared so nothing re-reviews it (Forward never back 2/6).
        settlePostReview(root, entry.commit, null);
      } else {
        const failures = (entry.failures ?? 0) + 1;
        warnEventBestEffort(root, entry.role, `the post-merge review of ${shortSha(entry.commit)} failed (${outcome.detail})`);
        if (failures >= POST_REVIEW_FAILURE_LIMIT) {
          warnEventBestEffort(root, entry.role, `dropping the post-merge review of ${shortSha(entry.commit)} after ${failures} failed runs; it stays on main unreviewed`);
          await fileDroppedReview(ctx, entry, outcome.detail);
          settlePostReview(root, entry.commit, null);
        } else settlePostReview(root, entry.commit, { ...entry, failures, lastFailure: outcome.detail });
      }
    } catch (err) {
      warnEventBestEffort(root, TUMWATER_SOURCE, `the post-merge review of ${shortSha(entry.commit)} could not run: ${errorMessage(err)}`);
    } finally {
      detach();
      if (p.postReview === task) p.postReview = null;
    }
  })();
  task.promise = guardMergeTask(root, `post-merge review of ${shortSha(entry.commit)}`, run);
}

/** How a dropped review's BUGS.md entry is settled, written into the entry itself. The drain
 * settles the review, so it never runs again and no later failure can lift a bugfix
 * wait-for-the-next-failure note: on 2026-10-29/30 seven entries were parked that way after
 * their commits had been checked, and every open bug ended up held. */
const DROPPED_REVIEW_CLOSE =
  "To settle it, read the commit's diff on main: fix what is wrong, or move this entry to Fixed with a Fix paragraph " +
  "naming what you checked. Do not park it with a Needs review note: the review never runs again, so nothing would " +
  "lift the note.";

/** File a post-merge review that is being dropped at POST_REVIEW_FAILURE_LIMIT (its commit stays
 * on main, so it becomes ordinary backlog work a role can pick up) as one BUGS.md `## Open`
 * entry in a best-effort `tumwater(operator):` commit. A skipped filing (off-base checkout or a
 * BUGS.md with uncommitted changes) or a throw logs one warning and returns, so a filing problem
 * never prevents the entry from being dropped and never throws out of the drain. */
async function fileDroppedReview(ctx: MergePipelineContext, entry: PostReview, failure: string): Promise<void> {
  const root = ctx.root;
  try {
    const outcome = await fileBugsOnMain(
      root,
      [
        {
          title: `post-merge review of ${shortSha(entry.commit)} never reached a verdict (found by the review role ${formatDate(new Date())})`,
          // The failure text is untrusted and can carry newlines (a backend/stderr trace) or a
          // `## `/code-fence line that would make appendBugEntryLocked call fail() and exit the
          // whole drain; folding it to one line keeps the body structurally sound, so a hostile
          // failure skips the filing via the ordinary throw path instead of killing the process.
          body: collapseWhitespace(`The post-merge review of commit \`${entry.commit}\` (${entry.summary}) never reached a verdict: ${failure}. It stays on main as ordinary unreviewed backlog work. ${DROPPED_REVIEW_CLOSE}`),
        },
      ],
      () => "File an unreviewed post-merge commit in BUGS.md",
    );
    if (outcome.status === "skipped") {
      warnEventBestEffort(root, entry.role, `could not file the dropped post-merge review of ${shortSha(entry.commit)} in BUGS.md (${outcome.reason})`);
    }
  } catch (err) {
    warnEventBestEffort(root, entry.role, `could not file the dropped post-merge review of ${shortSha(entry.commit)} in BUGS.md: ${errorMessage(err)}`);
  }
}

/** Land a reviewer's fix commit on main: first through the deterministic gate check (the same
 * scoped build pre-check a queued change's review gate runs), then through the ordinary write
 * path — mergeToMain, whose mergeLockDir lock serializes it with every other write to main — and
 * settle the entry `fixed` naming the landed fix. Since part 4l/3 mergeToMain is a bare rebase
 * and fast-forward with no check of its own, the pre-check is what verifies the fix tree (BUGS.md
 * 2026-11-04). A check that rejects the fix withholds it before main moves and records the finding
 * as the reviewed entry's rejection; an unverified (host-sleep) tree is also withheld, but that
 * entry stays queued for another review. A landing that fails (a conflict, a refused fast-forward)
 * leaves main at the reviewed commit and keeps the entry with its failure recorded for the next
 * poll's retry, exactly as a failed run is kept today — up to the same POST_REVIEW_FAILURE_LIMIT
 * the verdict-less-review path obeys, so the at-risk doctor row/alert's "one more failed run drops
 * it" stays true and the reviewer is not re-run forever; the review-fix ref survives so the
 * withheld commit remains reachable.
 * Throws when git could not start; a failed merge itself returns a non-terminal RunResult and
 * is never a throw. */
async function mergeReviewerFix(ctx: MergePipelineContext, entry: PostReview, fix: string, state: RunnerState): Promise<void> {
  const author = resolveAuthor(ctx, entry.role);
  // A reviewer's fix is reviewer-authored bytes main has never checked: since part 4l/3
  // mergeToMain is a bare rebase and fast-forward with no check of its own, the fix tree runs
  // through the same deterministic gate check a queued change gets (review-precheck.ts) BEFORE
  // the write path touches main (BUGS.md 2026-11-04: a broken repair landed unchecked and main
  // sat red ~20 h). It runs OUTSIDE the merge lock, over the fix tree as pinned: a passing
  // check or a failure main already carries lands as before (a conflict still hands the tree to
  // the resolver path below), while a reproduced failure that is the fix's — or a check that
  // could not be run at all — is withheld without touching main. It is deterministic: no model
  // run, so no reviewer budget is consumed. A withholding never throws.
  const wt = postReviewWorktreePath(ctx.root);
  const pre = await gateBuildPrecheck(
    {
      root: ctx.root,
      role: entry.role,
      wt,
      mainBranch: ctx.mainBranch,
      config: ctx.liveConfig,
      runNumber: state.runs,
      sessionDir: reviewRunSessionDir(ctx.root, entry.role, `post-${shortSha(fix)}`),
      signal: ctx.signal,
      // The fix's pre-check is deterministic and never runs a model; this stub exists only to
      // satisfy the ReviewContext the pre-check takes and is never invoked.
      runGatePi: async () => setupFailureResult("precheck", "the fix pre-check is deterministic; no reviewer run"),
    },
    state,
    fix,
    async (reasons) => {
      // The gate's shared reject path (review.ts's reject), shaped to the fix's bookkeeping:
      // record the rejection for the role's next runs, name the fix commit in a
      // review_rejected event, and settle the reviewed commit rejected with those reasons. Its
      // `fixed` stays unset — no repair landed on main — so the entry reads as rejected, not as
      // a landed fix (PostReview.fixed names the fix commit that merged). The broken fix commit
      // stays pinned at the review-fix ref so the withheld commit remains reachable.
      recordReview(state, "reject", reasons, fix);
      saveRunnerStateBestEffort(ctx.root, state);
      logEventBestEffort(ctx.root, { source: entry.role, type: "review_rejected", head: fix, reasons, afterMerge: true });
      warnEventBestEffort(ctx.root, entry.role, `the post-merge fix of ${shortSha(entry.commit)} failed its pre-check and was withheld: ${firstReason(reasons)}`);
      settlePostReview(ctx.root, entry.commit, { ...entry, rejected: reasons });
      return { decision: "rejected" as const, detail: firstReason(reasons) };
    },
  );
  if (pre.resolved && (pre.resolved.decision === "rejected" || pre.resolved.decision === "failed")) return;
  // `verifiedHead` (a passing check) and `knownMainFailures` (main's own failures, not the
  // fix's) both land: the known-failure excuse is the gate's own and the main watch re-checks
  // the tip after it lands. An unverified (host-sleep) tree is also a `failed` the pre-check
  // attributes to nothing — it stays out of main for the next poll's retry, as the line above
  // already withholds it.
  // The fix merge's conflict resolver rides the same team permit the merge slot's resolver
  // does (merge-drain.ts startMerge): the MERGE_TIER lease is acquired on the one team total
  // and rides in the run-permit store, so a conflict resolution counts against maxConcurrent
  // like any other strong-tier run.
  const runPi = async (wt: string, prompt: string, sessionName: string, config?: Parameters<typeof author.runMergePi>[3]) => {
    const hooks = resolveWaitStage(ctx.root, entry.role);
    if (!ctx.semaphore.canLeaseAtOnce(MERGE_TIER)) hooks.waiting();
    const lease = await ctx.semaphore.acquireLease(MERGE_TIER);
    hooks.granted();
    try {
      return await withRunPermit(
        lease,
        () => author.runMergePi(wt, prompt, sessionName, config),
      );
    } finally {
      lease.release();
    }
  };
  // Land through the merge's own write path — mergeToMain fast-forwards main under the shared
  // mergeLockDir mutex, so a fix landing and the ordinary merge slot serialize on main's one
  // writer either way — but from the DEDICATED post-review worktree (which already holds the fix
  // commit), NOT the shared `_merge` checkout that belongs to the merge slot. That removes the
  // race the merge slot's mergeApprovedChangeIn has: each resets and merges its own worktree, so
  // a fix landing can never reset or merge the shared `_merge` worktree concurrently with the
  // merge slot (both could start in one poll), while main's writes stay serialized by the real
  // mergeLockDir mutex. Hold the worktree from before ensureDetachedWorktree through the merge
  // (plans/disk-floor.md part 2/4); this task is the only user of the post-review worktree while
  // p.postReview is held, so the reset-and-merge cannot collide with a fresh review.
  let result: RunResult;
  // The commit that actually merges, from our own `merged` event (not the pre-rebase `fix`):
  // mergeToMain rebases `fix` onto main's tip, so when main moved under the review the landed
  // commit is a different sha — and `fixed` must name a commit that is provably on main.
  // Subscribing mirrors the merge slot's startMerge, so a concurrent merge of another role
  // landing after ours cannot overwrite the sha we record.
  const mergedMine = new Map<string, string>();
  const unsubscribe = subscribeEvents((e) => {
    if (e.type === "merged" && typeof e.commit === "string") mergedMine.set(e.source, e.commit);
  });
  try {
    result = await useWorktree(ctx.root, postReviewWorktreePath(ctx.root), async () => {
      const wt = await ensureDetachedWorktree(ctx.root, postReviewWorktreePath(ctx.root), fix);
      return mergeToMain(
        {
          root: ctx.root,
          role: entry.role,
          mainBranch: ctx.mainBranch,
          config: ctx.liveConfig,
          runNumber: author.state.runs,
          runPi,
          // A conflict resolution of the reviewer's fix is resolver-authored bytes the reviewer
          // never judged, so a resolved tree must not land silently on the fix's pre-check alone
          // (BUGS.md 2026-10-01: a resolver had restored code main deliberately reverted). But a
          // fix that CONFLICTS with main is also routine, and a sound resolution — one that
          // integrates main's concurrent edit and delivers the fix's intent — inherently diverges
          // from the fix-only diff (main's new wording is a line the fix, authored on the older
          // base, never carried). Discarding every such resolution by always retrying never lands
          // a conflicting fix and re-runs the whole review each retry (BUGS.md 2026-11-05). The
          // resolved tree is therefore re-reviewed by the same deterministic gate
          // mergeApprovedChange re-runs (review.ts's reviewAheadOfMain — no model reviewer since
          // part 3h/3): a resolution that passes — a green build with no brief/protected/secret
          // finding — merges as the fix landed against main; one the gate rejects is withheld and
          // the entry stays queued for the next poll's retry, the fix ref kept.
          recheckResolved: async (resolvedWt) => {
            const gate = await reviewAheadOfMain(
              {
                root: ctx.root,
                role: entry.role,
                wt: resolvedWt,
                mainBranch: ctx.mainBranch,
                config: ctx.liveConfig,
                runNumber: author.state.runs,
                sessionDir: reviewRunSessionDir(ctx.root, entry.role, `post-${shortSha(fix)}-resolved`),
                signal: ctx.signal,
                // The gate is deterministic (part 3h/3, no model reviewer); this stub exists only
                // to satisfy the ReviewContext the gate takes and is never invoked.
                runGatePi: async () => setupFailureResult("precheck", "the fix-resolution recheck is deterministic; no reviewer run"),
              },
              author.state,
            );
            // A rejected resolution is a verdict on the tree (a brief/protected/secret finding
            // or a reproduced build failure the resolution's own): the gate already reset the
            // worktree to main and recorded the review, so mergeToMain settles `rejected` and
            // the entry stays queued for the next poll's retry. A `failed` gate (dead check,
            // abort) is no verdict about the tree: retry like any non-verdict, keeping the fix
            // ref for the next poll.
            if (ctx.signal.aborted) return { verdict: "retry" };
            if (gate.decision === "rejected") return { verdict: "rejected" };
            if (gate.decision === "failed" || gate.aborted) return { verdict: "retry" };
            return { verdict: "approved" };
          },
        },
        wt,
        (await subjectOfCommit(wt, fix)) ?? `Fix ${shortSha(entry.commit)}`,
      );
    });
  } finally {
    unsubscribe();
  }
  if (result === "changed") {
    const merged = mergedMine.get(entry.role) ?? (await headOf(ctx.root, ctx.mainBranch));
    await deleteRef(ctx.root, reviewFixRef(entry.commit)); // the fix is on main; the ref has done its job
    settlePostReview(ctx.root, entry.commit, { ...entry, fixed: merged }); // the entry names the landed fix
    // A landed fix is a new post-review entry (Forward never back 2/6): re-queue it so the next
    // iteration reviews it like any unreviewed commit, counting its round toward the same
    // REVISION_BACKSTOP — the round lives on the fix commit's `Revision:` trailer.
    addPostReview(ctx.root, { commit: merged, role: entry.role, summary: entry.summary });
    return;
  }
  // A failed merge: main is unmoved, the fix ref survives. Count it against the drop limit -
  // keeping the entry (with the failure recorded) so the next poll retries the review, but
  // dropping it once the limit is reached, so the reviewer is not re-run unboundedly.
  const failures = (entry.failures ?? 0) + 1;
  if (failures >= POST_REVIEW_FAILURE_LIMIT) {
    warnEventBestEffort(ctx.root, entry.role, `dropping the post-merge review of ${shortSha(entry.commit)} after ${failures} failed fix merges; the fix stays unreviewed`);
    await deleteRef(ctx.root, reviewFixRef(entry.commit)); // the merge gave up on the fix; the ref must not pin it forever
    await fileDroppedReview(ctx, entry, `fix did not merge: ${result}`);
    settlePostReview(ctx.root, entry.commit, null);
    return;
  }
  warnEventBestEffort(ctx.root, entry.role, `the post-merge fix of ${shortSha(entry.commit)} could not merge (${result}); it stays queued for the next poll`);
  settlePostReview(ctx.root, entry.commit, { ...entry, failures, lastFailure: `fix did not merge: ${result}` });
}
