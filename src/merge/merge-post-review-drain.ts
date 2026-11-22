import { withRunPermit } from "../concurrency/run-permit.js";
import type { SemaphoreLease } from "../concurrency/semaphore.js";
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
  type PostReviewOutcome,
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
import { escalatedHoldMs } from "../team/team-hold.js";
import { seamHoldKey, seamPairName } from "../config/config-views.js";
import { saveRunnerStateBestEffort, type RunnerState } from "../runner/runner-state.js";
import type { RoleRunner } from "../runner/runner.js";
import type { RunResult } from "../run/run-outcome.js";

/** Distinguishes this task's `merged` event from another merge for the same role: a role's queued
 * change (or another fix) logs `merged` under the same `source` while this fix's merge finishes. */
let postReviewMergeSeq = 0;

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
 * never back 1a/6). An entry still inside its transient-failure backoff (`notBeforeMs` in the
 * future) is not reviewable yet either: the last review run ended on a provider failure and the
 * team is re-probing the wall on a schedule, not every poll (BUGS.md 2026-11-16), so the drain
 * skips it until the deadline passes and picks the next due entry — a later entry's review still
 * runs, only the wall-fed one waits. */
function unreviewed(e: PostReview): boolean {
  if (e.rejected !== undefined || e.fixed !== undefined) return false;
  if (e.notBeforeMs !== undefined && e.notBeforeMs > Date.now()) return false;
  return true;
}

/** The backoff a run that ended on a transient provider failure schedules, in ms: the longest
 * of the team-hold base (provider rate limits meter in per-minute buckets, so a minute is the
 * shortest pause that lets one refill) doubled with the entry's consecutive transient failures
 * and the run's own retry-after, capped at the team-hold cap — the same escalation the team hold
 * uses, so a wall that outlasts every re-probe re-probes a few times an hour instead of parking
 * the review forever and never hammering the provider every poll (BUGS.md 2026-11-16).
 * `escalation` is how many consecutive transient failures the entry carried BEFORE this run, so
 * it is 0 on the first failure and the first pause is the one-minute base, doubling on each
 * repeat until the cap. The run's retry-after (a 429's hint) wins over the escalated base when it
 * outlasts it, since the provider asked for more than our backoff would wait; a shorter hint is
 * floored up to the base. The doubling-and-cap itself is the team hold's ladder — one
 * `escalatedHoldMs` in src/team/team-hold.ts, the module that owns the base and cap constants —
 * so the two waits cannot drift apart. */
export function reviewBackoffMs(
  escalation: number,
  retryAfterSeconds: number | undefined,
): number {
  const retryAfterMs =
    retryAfterSeconds && retryAfterSeconds > 0 ? Math.max(0, retryAfterSeconds * 1000) : 0;
  return escalatedHoldMs(escalation, retryAfterMs);
}

/** Whether a parked review is admitted to run at all, once the team permit is held: it clears
 * `task.parked` (no longer waiting on the permit) and hands the lease straight back — and returns
 * false — when the shutdown signal fired while parked (a late grant is released by the acquire
 * race, so the lease is null and there is nothing to release here); when a restart or team hold
 * closed the start gate meanwhile; or when the entry was settled (`tumwater review --accept`) or
 * re-reviewed meanwhile and so no longer `unreviewed`. True only when the gate is open and the
 * entry still awaits its review. The check is synchronous (no `await` in its body) so the
 * IIFE's `if (!admitPostReview(...)) return;` gate is synchronous too, exactly as the pre-split
 * `if (stale)` was: a review never starts under a closed gate or over a settled entry. The IIFE
 * releases the lease again in its `finally` after the run, but the semaphore's release is
 * idempotent, so a not-admitted path's release is a no-op there, and the IIFE's `task.parked`
 * and slot cleanup still run on every path. */
function admitPostReview(
  root: string,
  lease: SemaphoreLease | null,
  task: InFlightMerge,
  ctx: MergePipelineContext,
  entry: PostReview,
): boolean {
  task.parked = false;
  if (lease === null) return false; // a shutdown while parked: the entry stays for the next generation
  // A busy team's wait can be long. A restart or team hold that closed the gate meanwhile, or
  // an entry settled meanwhile (`tumwater review --accept`), hands the permit straight back.
  const stale =
    task.controller.signal.aborted ||
    ctx.startHeld() ||
    !readPostReviews(root).some((e) => e.commit === entry.commit && unreviewed(e));
  if (stale) {
    lease.release();
    return false;
  }
  return true;
}

/** Settle a review's verdict, one arm per `PostReviewOutcome` shape: `approve` clears the entry
 * (`settlePostReview(null)`), `reject` keeps it with the reviewer's recorded reasons, `fixed`
 * routes through `mergeReviewerFix` (lands the fix or keeps the entry on a failed landing),
 * `exhausted` clears it with no reviewer fix, a transient `infrastructure` failure warns and keeps
 * the entry WITHOUT counting it toward `POST_REVIEW_FAILURE_LIMIT` or filing a bug, and a plain
 * `failed` warns and either files-and-drops at the limit or keeps it with the incremented count.
 * The `aborted` flag is read once by the caller, at the point the ladder read it, so a shutdown
 * between the run and this settles nothing. */
async function settlePostReviewOutcome(
  root: string,
  ctx: MergePipelineContext,
  entry: PostReview,
  outcome: PostReviewOutcome,
  author: RoleRunner,
  aborted: boolean,
): Promise<void> {
  // A shutdown or a restart's abort: the entry stays queued for the next generation, and its
  // review session is kept so the next attempt continues it (as a progressing timeout's does)
  // instead of throwing away every turn the aborted run had read (BUGS.md 2026-11-21). Only an
  // entry still awaiting its review is rewritten: one `tumwater review --accept` settled during
  // the run stays settled (INV-BT4).
  if (aborted) {
    if (readPostReviews(root).some((e) => e.commit === entry.commit && unreviewed(e))) {
      settlePostReview(root, entry.commit, { ...entry, resume: true });
    }
    return;
  }
  if (outcome.kind === "approve") settlePostReview(root, entry.commit, null);
  else if (outcome.kind === "reject") settlePostReview(root, entry.commit, { ...entry, rejected: outcome.reasons, resume: undefined });
  else if (outcome.kind === "fixed") await mergeReviewerFix(ctx, entry, outcome.fix, outcome.reasons, author.state);
  else if (outcome.kind === "exhausted") {
    // A self-fix chain at the backstop: reviewMergedCommit has already recorded the surviving
    // findings; the entry is cleared so nothing re-reviews it (Forward never back 2/6).
    settlePostReview(root, entry.commit, null);
  } else if (outcome.kind === "failed" && outcome.infrastructure) {
    // The run ended on a transient provider failure (a 429 or quota wall, a backend
    // failure): a world failure, not a review content failure. Keep the entry queued
    // WITHOUT counting it toward POST_REVIEW_FAILURE_LIMIT and without filing a product
    // bug — a multi-hour provider quota wall must not generate one "never reached a
    // verdict" BUGS.md entry per commit (BUGS.md 2026-11-09). A bare keep-without-count
    // is not a brake: the next poll (a couple of seconds later) re-selects the same
    // unchanged entry and re-runs the review, opening a fresh agent session every poll
    // for as long as the wall holds (BUGS.md 2026-11-16). So the entry also gets a
    // backoff deadline — the escalated pause, floored to the run's own retry-after when it
    // outlasts it, and capped at the team-hold cap — and the drain skips it until that passes,
    // so the team re-probes the wall on a schedule (a few times an hour at the cap) instead of
    // on every poll, while a later entry's review still runs now.
    warnEventBestEffort(root, entry.role, `the post-merge review of ${shortSha(entry.commit)} failed on a transient provider failure (${outcome.detail}); keeping it queued — not counted, not filed — and re-tried only once the wait clears`);
    // Each transient failure bumps the counter (persisted for the next re-probe) and sets the
    // backoff from the PRIOR count, so the first failure rests the team-hold base (one minute,
    // so a per-minute rate-limit bucket refills) and each subsequent one doubles it until the
    // cap — a still-parked wall that the provider keeps refusing re-arms from a higher base.
    const consecutiveTransientFailures = (entry.consecutiveTransientFailures ?? 0) + 1;
    settlePostReview(root, entry.commit, {
      ...entry,
      consecutiveTransientFailures,
      notBeforeMs: Date.now() + reviewBackoffMs(entry.consecutiveTransientFailures ?? 0, outcome.retryAfterSeconds),
    });
  } else {
    const failures = (entry.failures ?? 0) + 1;
    warnEventBestEffort(root, entry.role, `the post-merge review of ${shortSha(entry.commit)} failed (${outcome.detail})`);
    if (failures >= POST_REVIEW_FAILURE_LIMIT) {
      warnEventBestEffort(root, entry.role, `dropping the post-merge review of ${shortSha(entry.commit)} after ${failures} failed runs; it stays on main unreviewed`);
      await fileDroppedReview(ctx, entry, outcome.detail);
      settlePostReview(root, entry.commit, null);
    } else {
      // The count still brakes a review that never finishes; a progressing timeout's kept session
      // lets each attempt continue the last instead of restarting (BUGS.md 2026-11-18).
      const resume = outcome.resumable === true ? true : undefined;
      settlePostReview(root, entry.commit, { ...entry, failures, lastFailure: outcome.detail, consecutiveTransientFailures: 0, resume });
    }
  }
}

/** Start one review task and record it in `p.postReview` until it settles. It parks for a team
 * permit at VERIFY_TIER, ahead of every queued role run, as a pre-merge verification does. It
 * used to start only when a permit was free at the poll and never queue, and the peek's
 * synchronous return cleared `p.postReview` before the drain stored the task, leaving a settled
 * task in the slot. On 2026-11-03 that stopped every review until the next restart: 2 reviews
 * against 81 merges, 68 commits waiting. */
function startPostReview(ctx: MergePipelineContext, p: MergePipeline, entry: PostReview): void {
  const { root, semaphore } = ctx;
  // The review names its commit's author role, so the restart and shutdown wording says what it
  // waits on and `tumwater abort --role <author>` reaches it (BUGS.md 2026-11-19).
  const task: InFlightMerge = { promise: Promise.resolve(), controller: new AbortController(), roles: [entry.role], userAborted: false, parked: true, review: true };
  p.postReview = task;
  const detach = abortOnShutdown(ctx.signal, task.controller);
  const author = resolveAuthor(ctx, entry.role);
  const run = (async () => {
    try {
      const lease = await acquireUnlessAborted(semaphore, VERIFY_TIER, task.controller.signal);
      if (!admitPostReview(root, lease, task, ctx, entry)) return;
      let outcome;
      try {
        // The reviewer's final run is folded into the AUTHORING role here (foldMergeUsage on the
        // run's own seam — exactly the reviewer seam the run executed on), exactly as the pre-merge
        // gate folds its final reviewer run (merge-core's reviewPinnedChange folds gate.run).
        // runGatePi folds only a RETRIED first attempt, never the final run, so this is the final
        // run's one fold — not a double count. Without it a post-merge review's cost and its 429
        // / backend stamps never reach the author (BUGS.md 2026-11-16). The retried fold inside
        // runGatePi already stamps the hold before any wait; this stamps the outcome it ends on.
        outcome = await reviewMergedCommit(
          root,
          ctx.liveConfig,
          entry,
          (opts) =>
            author
              .runGatePi(opts)
              .then((pi) => {
                author.foldMergeUsage(pi, seamHoldKey(opts.config), seamPairName(opts.config));
                return pi;
              }),
          task.controller.signal,
        );
      } finally {
        lease?.release(); // lease is non-null once admission passed; the `?.` keeps the guard honest
      }
      await settlePostReviewOutcome(root, ctx, entry, outcome, author, task.controller.signal.aborted);
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
async function fileDroppedReview(ctx: MergePipelineContext, entry: PostReview, failure: string, finding?: string[]): Promise<void> {
  const root = ctx.root;
  // The machine-readable record of the drop: the warning names the commit by short SHA only, so a
  // reader cannot select or match it. Logged before the filing, so a filing failure keeps it too.
  logEventBestEffort(root, { source: entry.role, type: "review_dropped", commit: entry.commit, summary: entry.summary, reason: failure });
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
          // A review that got as far as a finding names it too: the reviewer's objection is what a
          // role acting on this entry needs, and a withheld fix used to be all the entry carried.
          body: collapseWhitespace(
            `The post-merge review of commit \`${entry.commit}\` (${entry.summary}) never reached a verdict: ${failure}.` +
              (finding && finding.length > 0
                ? ` The reviewer's finding on the reviewed change: ${finding.join("; ")}.`
                : "") +
              ` It stays on main as ordinary unreviewed backlog work. ${DROPPED_REVIEW_CLOSE}`,
          ),
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

/** Land a reviewer's fix commit on main, in four named phases: the deterministic pre-check that
 * may withhold the fix, the guarded merge onto main that names the sha that actually landed, the
 * landed-fix settle and requeue, and the failed-merge settle with its drop-at-the-limit path.
 * Each phase reads from one helper below; this body only orders them, with no behavior change.
 * Throws when git could not start; a failed merge itself returns a non-terminal RunResult and
 * is never a throw. */
async function mergeReviewerFix(ctx: MergePipelineContext, entry: PostReview, fix: string, finding: string[], state: RunnerState): Promise<void> {
  const author = resolveAuthor(ctx, entry.role);
  if (!(await precheckReviewerFix(ctx, entry, fix, finding, state))) return;
  const outcome = await mergeReviewerFixCommit(ctx, entry, fix, author);
  if (outcome.result === "changed") {
    await settleMergedReviewerFix(ctx, entry, outcome.merged);
    return;
  }
  await settleFailedReviewerFix(ctx, entry, outcome.result);
}

/** The deterministic pre-check that withholds a reviewer's fix before main moves. A reviewer's
 * fix is reviewer-authored bytes main has never checked: since part 4l/3 mergeToMain is a bare
 * rebase and fast-forward with no check of its own, the fix tree runs through the same
 * deterministic gate check a queued change gets (review-precheck.ts) BEFORE the write path
 * touches main (BUGS.md 2026-11-04: a broken repair landed unchecked and main sat red ~20 h). It
 * runs OUTSIDE the merge lock, over the fix tree as pinned: a passing check or a failure main
 * already carries lands as before (a conflict still hands the tree to the resolver path below),
 * while a reproduced failure that is the fix's — or a check that could not be run at all — is
 * withheld without touching main. It is deterministic: no model run, so no reviewer budget is
 * consumed. A withholding never throws.
 * Returns false when the pre-check resolved `rejected` or `failed` — the fix must not land — and
 * true otherwise. */
async function precheckReviewerFix(ctx: MergePipelineContext, entry: PostReview, fix: string, finding: string[], state: RunnerState): Promise<boolean> {
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
      // record the rejection for the role's next runs, name the fix commit in a review_rejected
      // event, and keep the reviewed entry OPEN with the pre-check as the review's
      // failure. Settling
      // it `rejected` here was the bug (BUGS.md 2026-11-21): a settled entry is terminal, so a fix
      // one mechanical rewrap would repair became the review's last word, and the reviewer's
      // finding — the only thing worth acting on — was overwritten by the lint failure's text. The
      // finding rides the entry (`finding`) so the next attempt, `tumwater reviews`, and the filing
      // at the limit all name it. The author's rejection record carries the finding alongside the
      // pre-check reason, so a role is never handed a rejection naming only a lint line on a commit
      // it can no longer revise. Its `fixed` stays unset — no repair landed on main — so the entry
      // reads as a failing review, not as a landed fix (PostReview.fixed names the fix commit that
      // merged). The broken fix commit stays pinned at the review-fix ref so the withheld commit
      // remains reachable for a reader.
      recordReview(state, "reject", [...finding, ...reasons], fix);
      saveRunnerStateBestEffort(ctx.root, state);
      // The withholding is not a verdict on the author's commit, so the event must not read as
      // one: `head` stays the reviewed commit (the one on main a reader can act on), the withheld
      // sha rides as `withheldFix` — the discriminator every observer reads (event-read.ts
      // eventWithheldFix) — and the reviewer's `finding` rides beside the pre-check's
      // `reasons`, so
      // the digest can name what the reviewer found instead of only the lint line that held its
      // repair back. Counted as an author rejection, this event made the digest print its never-
      // re-reviewed footer over a review that is still open and re-runs (INV-BT8), and spent the
      // doctor's post-merge churn warn on lint in reviewer-authored bytes (BUGS.md 2026-11-22).
      logEventBestEffort(ctx.root, {
        source: entry.role,
        type: "review_rejected",
        head: entry.commit,
        reasons,
        ...(finding.length > 0 ? { finding } : {}),
        withheldFix: fix,
        afterMerge: true,
      });
      warnEventBestEffort(ctx.root, entry.role, `the post-merge fix of ${shortSha(entry.commit)} failed its pre-check and was withheld: ${firstReason(reasons)}`);
      await settleWithheldReviewerFix(ctx, entry, finding, reasons);
      return { decision: "rejected" as const, detail: firstReason(reasons) };
    },
  );
  // `verifiedHead` (a passing check) and `knownMainFailures` (main's own failures, not the
  // fix's) both land: the known-failure excuse is the gate's own and the main watch re-checks
  // the tip after it lands. An unverified (host-sleep) tree is also a `failed` the pre-check
  // attributes to nothing — it stays out of main for the next poll's retry, as the `rejected`
  // withholding below already covers the fix that must not land.
  if (pre.resolved && (pre.resolved.decision === "rejected" || pre.resolved.decision === "failed")) return false;
  return true;
}

/** Land the withheld fix through the merge's own write path while naming the sha that actually
 * merged. The fix merge's conflict resolver rides the same team permit the merge slot's resolver
 * does (merge-drain.ts startMerge): the MERGE_TIER lease is acquired on the one team total and
 * rides in the run-permit store, so a conflict resolution counts against maxConcurrent like any
 * other strong-tier run. mergeToMain fast-forwards main under the shared mergeLockDir mutex, so
 * a fix landing and the ordinary merge slot serialize on main's one writer either way — but from
 * the DEDICATED post-review worktree (which already holds the fix commit), NOT the shared
 * `_merge` checkout that belongs to the merge slot. That removes the race the merge slot's
 * mergeApprovedChangeIn has: each resets and merges its own worktree, so a fix landing can never
 * reset or merge the shared `_merge` worktree concurrently with the merge slot (both could start
 * in one poll), while main's writes stay serialized by the real mergeLockDir mutex. Hold the
 * worktree from before ensureDetachedWorktree through the merge (plans/disk-floor.md part 2/4);
 * this task is the only user of the post-review worktree while p.postReview is held, so the
 * reset-and-merge cannot collide with a fresh review.
 * Resolves `merged` to the commit that actually landed — from our own `merged` event (not the
 * pre-rebase `fix`), falling back to main's head — and unsubscribes in `finally`. A failed merge
 * returns a non-terminal RunResult and names no merged commit, so it never reads main's head. */
async function mergeReviewerFixCommit(
  ctx: MergePipelineContext,
  entry: PostReview,
  fix: string,
  author: ReturnType<typeof resolveAuthor>,
): Promise<{ result: "changed"; merged: string } | { result: Exclude<RunResult, "changed">; merged: null }> {
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
  // The commit that actually merges, from our own `merged` event (not the pre-rebase `fix`):
  // mergeToMain rebases `fix` onto main's tip, so when main moved under the review the landed
  // commit is a different sha — and `fixed` must name a commit that is provably on main.
  // Subscribing mirrors the merge slot's startMerge, so a concurrent merge landing after ours
  // cannot overwrite the sha we record. Only this fix merge's own tagged event counts: another
  // merge for the same role logs `merged` under the same source.
  const mergedTag = `post-review-${++postReviewMergeSeq}`;
  const mergedMine = new Map<string, string>();
  const unsubscribe = subscribeEvents((e) => {
    if (e.type === "merged" && e.mergedTag === mergedTag && e.source === entry.role && typeof e.commit === "string") {
      mergedMine.set(e.source, e.commit);
    }
  });
  let result: RunResult;
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
          mergedTag,
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
    return { result, merged };
  }
  return { result, merged: null };
}

/** Settle a fix that landed on main as `fixed`: delete the fix ref, settle the entry naming the
 * landed sha, and re-queue it as a post-review entry. The fix is on main, so the ref has done its
 * job; a landed fix is a new post-review entry (Forward never back 2/6) — re-queue it so the next
 * iteration reviews it like any unreviewed commit, counting its round toward the same
 * REVISION_BACKSTOP — the round lives on the fix commit's `Revision:` trailer. */
async function settleMergedReviewerFix(ctx: MergePipelineContext, entry: PostReview, merged: string): Promise<void> {
  await deleteRef(ctx.root, reviewFixRef(entry.commit)); // the fix is on main; the ref has done its job
  settlePostReview(ctx.root, entry.commit, { ...entry, fixed: merged }); // the entry names the landed fix
  addPostReview(ctx.root, { commit: merged, role: entry.role, summary: entry.summary });
}

/** Settle a review whose reviewer's fix was withheld by its own pre-check: the entry stays open,
 * counted as one failed review run, with the pre-check's reason as `lastFailure` and the reviewer's
 * finding kept in `finding` (BUGS.md 2026-11-21 — the old `rejected` settle ended the review and
 * buried the finding). The count is the brake: at POST_REVIEW_FAILURE_LIMIT the entry is
 * dropped and
 * filed like any other abandoned review, the ref deleted so it pins nothing forever. */
async function settleWithheldReviewerFix(
  ctx: MergePipelineContext,
  entry: PostReview,
  finding: string[],
  reasons: string[],
): Promise<void> {
  const failures = (entry.failures ?? 0) + 1;
  const detail = `fix pre-check withheld the repair: ${firstReason(reasons)}`;
  if (failures >= POST_REVIEW_FAILURE_LIMIT) {
    warnEventBestEffort(ctx.root, entry.role, `dropping the post-merge review of ${shortSha(entry.commit)} after ${failures} withheld fix runs; it stays on main unreviewed`);
    await deleteRef(ctx.root, reviewFixRef(entry.commit));
    await fileDroppedReview(ctx, entry, detail, finding);
    settlePostReview(ctx.root, entry.commit, null);
    return;
  }
  warnEventBestEffort(ctx.root, entry.role, `the post-merge review of ${shortSha(entry.commit)} keeps its finding after a withheld fix; the next poll reviews it again`);
  settlePostReview(ctx.root, entry.commit, {
    ...entry,
    failures,
    lastFailure: detail,
    ...(finding.length > 0 ? { finding } : {}),
    consecutiveTransientFailures: 0,
    resume: undefined,
  });
}

/** Settle a fix whose merge failed: main is unmoved and the fix ref survives. Count the failure
 * against the drop limit — keeping the entry (with the failure recorded) so the next poll retries
 * the review, but dropping it once the limit is reached, so the reviewer is not re-run
 * unboundedly. At the limit, warn, delete the ref, file the bug, and settle the entry away. */
async function settleFailedReviewerFix(ctx: MergePipelineContext, entry: PostReview, result: RunResult): Promise<void> {
  const failures = (entry.failures ?? 0) + 1;
  if (failures >= POST_REVIEW_FAILURE_LIMIT) {
    warnEventBestEffort(ctx.root, entry.role, `dropping the post-merge review of ${shortSha(entry.commit)} after ${failures} failed fix merges; the fix stays unreviewed`);
    await deleteRef(ctx.root, reviewFixRef(entry.commit)); // the merge gave up on the fix; the ref must not pin it forever
    await fileDroppedReview(ctx, entry, `fix did not merge: ${result}`);
    settlePostReview(ctx.root, entry.commit, null);
    return;
  }
  warnEventBestEffort(ctx.root, entry.role, `the post-merge fix of ${shortSha(entry.commit)} could not merge (${result}); it stays queued for the next poll`);
  settlePostReview(ctx.root, entry.commit, { ...entry, failures, lastFailure: `fix did not merge: ${result}`, resume: undefined });
}
