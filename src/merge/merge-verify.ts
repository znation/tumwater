// vocabulary: plain
import fs from "node:fs";
import path from "node:path";
import { gateRoleConfig } from "../gates/budget-gates.js";
import { reviewRunConfig, seamConcurrencyKey } from "../config/config-views.js";
import { providerWaitStage } from "./merge-slot.js";
import { withProviderLease } from "../concurrency/provider-lease.js";
import { LoopRunner } from "../loop/loop.js";
import { branchHead, isMergedInto } from "../git/git.js";
import { addMergeChange, mergeUsage, removeMergeChange, setMergeChangeStatus } from "./merge-slot.js";
import { dropMerge, entryRevisionFields, queuedMergeFiles, staleHeadFile, type MergeEntry } from "./merge-queue.js";
import { warnEventBestEffort, TUMWATER_SOURCE } from "../events/events.js";
import { errorMessage } from "../text/text.js";
import { verifyRequest, type VerifyVerdict } from "./merge-batch.js";
import {
  abortOnShutdown,
  acquireUnlessAborted,
  discardPinnedRefs,
  guardMergeTask,
  liveRoles,
  settleMergeOutcome,
  type InFlightMerge,
  type MergePipeline,
  type MergePipelineContext,
} from "./merge-pipeline.js";

/** The semaphore tier a verification waits at, below every roleTier (0/1): committed work whose
 * author the interlock has already blocked jumps ahead of parked role waiters rather than starving
 * behind them (BUGS.md 2026-09-18). Exported for merge-drain.ts, whose merge tier sits one
 * below it. */
export const VERIFY_TIER = -1;

/** How many verifications may be in flight (parked or running) at once: every `maxConcurrent`
 * permit but one, so a deep merge queue never takes the last slot from the roles that could
 * author — at least one, so `maxConcurrent` 1 still merges. The merge's short conflict-resolution
 * run is not counted: it is the one serial step every queued change waits on. */
export function verifyLimit(maxConcurrent: number): number {
  return Math.max(1, maxConcurrent - 1);
}

/** Resolve a merge entry's authoring runner: the live runner when the role is enabled
 * (runners are never removed from the array on disable — only a warning event fires); a role
 * disabled before this process started has no runner, so a throwaway one supplies the same
 * wiring (loop-pi.ts, runMergePi, foldMergeUsage) and a disk-loaded state to fold and save
 * on. Both share the live config, like every runner — the director takes directorConfig (the live
 * config, its budget-gate exemption, unless a used-up window moved it), every other role takes
 * roleConfig (gateRoleConfig's single home for the rule; the scheduler assigns the live runners
 * by it every poll). */
function resolveAuthor(ctx: MergePipelineContext, role: string): LoopRunner {
  const { root, mainBranch, signal, runners, liveConfig, roleConfig, directorConfig } = ctx;
  return (
    runners.find((r) => r.role === role) ??
    new LoopRunner(root, role, gateRoleConfig(role, liveConfig, roleConfig, directorConfig), mainBranch, signal)
  );
}

/** Drop a torn queue head. A torn head (torn or foreign — a partial write an older build left,
 * a hand-placed file) makes headMerge read null forever — nothing else drops it, stranding
 * every live entry behind it and pinning their authors' ticks via the interlock. Drop it with
 * one warning; the healthy entries behind it are verified in the same poll. The crashed
 * entry's commit, if any, still rides its merge ref into next-tick leftover recovery
 * (BUGS.md 2026-09-17). */
function dropTornHead(root: string): void {
  const stale = staleHeadFile(root);
  if (!stale) return;
  dropMerge(stale);
  warnEventBestEffort(
    root,
    TUMWATER_SOURCE,
    `merge queue head ${path.basename(stale)} is unreadable (torn or foreign) — dropped so the queue keeps moving`,
  );
}

/** Already-merged verdicts cached per (root, sha) against the main head they were computed
 * against. drainVerify re-runs its dedupe against main every poll, but a queued entry's sha is
 * fixed and merge-base --is-ancestor against the same head always returns the same answer — the
 * verdict can only change when main itself moves (a merge's fast-forward). Serving the verdict
 * from this cache makes a poll whose queue is waiting on busy authors or the merge slot cost one
 * branchHead ref-file read instead of one git spawn per entry, and a moved main recomputes each
 * entry's verdict once (the new head misses the cache). Bounded: verdicts computed against an
 * older head are stale falses no future poll can reuse, so they are the first pruned. */
const mergedIntoMainCache = new Map<string, { head: string; merged: boolean }>();
const MERGED_INTO_MAIN_CACHE_MAX = 128;

/** The cached dedupe verdict for `sha` against main at `head`, computing it through
 * isMergedInto on a cache miss. `head` is the caller's already-resolved main head ("" when main
 * does not exist yet — isMergedInto then fails and reads false, a verdict worth caching like any
 * other since the key matches). */
async function mergedIntoMain(root: string, sha: string, mainBranch: string, head: string): Promise<boolean> {
  const key = `${root}\u0000${sha}`;
  const hit = mergedIntoMainCache.get(key);
  if (hit?.head === head) return hit.merged;
  const merged = await isMergedInto(root, sha, mainBranch);
  if (mergedIntoMainCache.size >= MERGED_INTO_MAIN_CACHE_MAX && !mergedIntoMainCache.has(key)) {
    for (const [k, v] of mergedIntoMainCache) if (v.head !== head) mergedIntoMainCache.delete(k);
    if (mergedIntoMainCache.size >= MERGED_INTO_MAIN_CACHE_MAX) mergedIntoMainCache.clear();
  }
  mergedIntoMainCache.set(key, { head, merged });
  return merged;
}

/** Start a verification, in queue order, for every queued entry whose role the pipeline does not
 * already hold, up to verifyLimit — the shared semaphore bounds how many of them run. The torn-head
 * drop comes first, and each entry is deduped against main before its verification starts: an entry
 * whose sha main already holds (a crash between the fast-forward and the drop) is dropped without a
 * run, with its marker record; a crash mid-verification leaves both entry and ref, so the entry is
 * verified again — the established crash semantics. */
export async function drainVerify(ctx: MergePipelineContext, p: MergePipeline): Promise<void> {
  dropTornHead(ctx.root);
  const queue = queuedMergeFiles(ctx.root);
  // One main-head read per poll with a non-empty queue (branchHead's ref-file fast path — no
  // spawn), serving every entry's cached dedupe verdict below.
  const mainHead = queue.length === 0 ? "" : ((await branchHead(ctx.root, ctx.mainBranch)) ?? "");
  for (const { entry, file } of queue) {
    if (p.verifying.size >= verifyLimit(ctx.semaphore.limit)) return;
    if (liveRoles(p).has(entry.role)) continue;
    if (await mergedIntoMain(ctx.root, entry.sha, ctx.mainBranch, mainHead)) {
      dropMerge(file);
      removeMergeChange(ctx.root, entry.role);
      continue;
    }
    // The dedupe awaited git: a task that settled meanwhile may have dropped this very entry
    // (its role was busy when the queue was listed) or claimed its role. Start nothing for it.
    if (!fs.existsSync(file) || liveRoles(p).has(entry.role)) continue;
    startVerify(ctx, p, entry, file);
  }
}

/** Start one verification task and record it in `p.verifying`: parked until a shared permit comes,
 * at VERIFY_TIER (a shutdown settles a parked verification at once, and one granted while the start
 * gate is closed hands its permit back — either way nothing ran, and its entry and pin stay queued
 * with no outcome written), then, holding the permit for its whole length: open the change's
 * marker record and verify it — checkout at the pin, rebase onto main, gate check, review
 * (verifyRequest), the verdict persisted by the gate. An approval moves it to `approved` (record
 * `approved, awaiting merge`). Any other verdict — rejected, a review_error of either kind,
 * main_red, a lost pin's "error", aborted — is final for this queue entry, so its outcome is
 * written at once and its entry dropped, which frees its author on the next poll while the
 * other verifications run on (BUGS.md 2026-09-23's early-rejection rule). A user-aborted
 * verification discards its pin; a shutdown keeps it. Never rejects for a failed merge: an
 * unexpected throw becomes an "error" outcome. Exported for
 * test/fixtures/orchestrator-fixtures.ts's mergeHead, which merges one queue entry through the
 * pipeline without draining the rest of the queue. */
export function startVerify(ctx: MergePipelineContext, p: MergePipeline, entry: MergeEntry, file: string): void {
  const { root, mainBranch, signal, semaphore } = ctx;
  const { role } = entry;
  const author = resolveAuthor(ctx, role);
  // The verification's provider key: the review seam's key for the author's role, so its reviewer
  // run counts toward the same provider cap as the roles that share it
  // (plans/provider-concurrency.md §4). The gate off runs no model, so then there is no key — the
  // verification is bounded by the team total alone.
  const reviewKey =
    ctx.liveConfig.review.enabled
      ? seamConcurrencyKey(reviewRunConfig(author.config), ctx.piDefault)
      : undefined;
  const verify: InFlightMerge = {
    promise: Promise.resolve(), // Replaced below; the placeholder satisfies the type.
    controller: new AbortController(),
    roles: [role],
    userAborted: false,
    parked: true,
  };
  const detachShutdown = abortOnShutdown(signal, verify.controller);
  p.verifying.set(role, verify);
  const task = (async () => {
    try {
      const lease = await acquireUnlessAborted(semaphore, VERIFY_TIER, verify.controller.signal, reviewKey);
      verify.parked = false;
      if (lease === null) return; // a shutdown while parked
      if (verify.controller.signal.aborted || ctx.startHeld()) {
        lease.release(); // stopping, or a restart / team hold closed the gate while it waited
        return;
      }
      const { usage, foldUsage } = mergeUsage(author, root);
      let verdict: VerifyVerdict;
      const startedAt = Date.now();
      try {
        addMergeChange(root, entry, liveRoles(p));
        // The verification's lease rides in the provider-lease store for the verification's body,
        // so a review run that lands on a different provider than the verification's review seam
        // re-keys it there, and a re-key park is shown by providerWaitStage; its slot wait drops
        // the key (pool-slot rule).
        verdict = await withProviderLease(
          lease,
          semaphore,
          () =>
            verifyRequest(
              { root, mainBranch, config: author.config, signal: () => verify.controller.signal, runGatePi: (opts) => author.runGatePi(opts) },
              {
                role,
                sha: entry.sha,
                tick: entry.run,
                summary: entry.summary,
                body: entry.body,
                highFriction: entry.highFriction,
                ...entryRevisionFields(entry),
              },
              { state: author.state, foldUsage, runPi: (w, prompt, s, cfg) => author.runMergePi(w, prompt, s, cfg), runGatePi: (opts) => author.runGatePi(opts) },
            ),
          { piDefault: ctx.piDefault, hooks: providerWaitStage(root, role) },
        );
      } catch (err) {
        verdict = { kind: "result", result: "error" };
        author.state.lastError = errorMessage(err);
      } finally {
        lease.release();
      }
      if (verdict.kind === "stack" && !verify.userAborted) {
        p.approved.set(role, {
          entry,
          file,
          sha: verdict.sha,
          ...(verdict.verifiedHead !== undefined ? { verifiedHead: verdict.verifiedHead } : {}),
          startedAt,
          author,
          usage,
          foldUsage,
          roles: [role],
          controller: new AbortController(),
          userAborted: false,
        });
        setMergeChangeStatus(root, role, "approved");
      } else {
        const result = verdict.kind === "stack" ? "aborted" : verdict.result;
        await settleMergeOutcome(root, entry, author.state, result, Date.now() - startedAt, usage, file);
        if (verify.userAborted) await discardPinnedRefs(root, [role]);
      }
    } finally {
      detachShutdown();
      p.verifying.delete(role);
    }
  })();
  verify.promise = guardMergeTask(root, role, task);
}
