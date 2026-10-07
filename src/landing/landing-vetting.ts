import fs from "node:fs";
import path from "node:path";
import { gateRoleConfig } from "../gates/budget-gates.js";
import { LoopRunner } from "../loop/loop.js";
import { branchHead, isMergedInto } from "../git/git.js";
import { addLandingChange, landingUsage, removeLandingChange, setLandingChangeStatus } from "./landing-slot.js";
import { dropLanding, queuedLandingFiles, staleHeadFile, type LandingEntry } from "./landing-queue.js";
import { warnEvent } from "../events/events.js";
import { errorMessage } from "../text/text.js";
import { vetRequest, type VetVerdict } from "./landing-batch.js";
import {
  abortOnShutdown,
  acquireUnlessAborted,
  discardPinnedRefs,
  liveRoles,
  settleLandingOutcome,
  type InFlightLanding,
  type LandingPipeline,
  type LandingPipelineContext,
} from "./landing-pipeline.js";

/** The semaphore tier a vet waits at, below every roleTier (0/1): committed work whose author
 * the interlock has already blocked jumps ahead of parked role waiters rather than starving
 * behind them (BUGS.md 2026-09-18). Exported for landing-drain.ts, whose merge tier sits one
 * below it. */
export const LANDING_TIER = -1;

/** How many vets may be in flight (parked or running) at once: every `maxConcurrent` permit but
 * one, so a deep land queue never takes the last slot from the roles that could author — at
 * least one, so `maxConcurrent` 1 still lands. The merge's short conflict-resolution run is not
 * counted: it is the one serial step every queued change waits on. */
export function vetLimit(maxConcurrent: number): number {
  return Math.max(1, maxConcurrent - 1);
}

/** Resolve a landing entry's authoring runner: the live runner when the role is enabled
 * (runners are never removed from the array on disable — only a warning event fires); a role
 * disabled before this process started has no runner, so a throwaway one supplies the same
 * wiring (loop-pi.ts, runLandingPi, foldLandingUsage) and a disk-loaded state to fold and save
 * on. Both share the live config, like every runner — the director keeps liveConfig (its
 * budget-gate exemption), every other role takes roleConfig (gateRoleConfig's single home
 * for the rule; the scheduler assigns the live runners by it every poll). */
function resolveAuthor(ctx: LandingPipelineContext, role: string): LoopRunner {
  const { root, mainBranch, signal, runners, liveConfig, roleConfig } = ctx;
  return (
    runners.find((r) => r.role === role) ??
    new LoopRunner(root, role, gateRoleConfig(role, liveConfig, roleConfig), mainBranch, signal)
  );
}

/** Drop a torn queue head. A torn head (a hard crash mid enqueueLanding write, or a foreign
 * file) makes headLanding read null forever — nothing else drops it, stranding every live entry
 * behind it and pinning their authors' ticks via the interlock. Drop it with one warning; the
 * healthy entries behind it are vetted in the same poll. The crashed entry's commit, if any,
 * still rides its landing ref into next-tick leftover recovery (BUGS.md 2026-09-17). */
function dropTornHead(root: string): void {
  const stale = staleHeadFile(root);
  if (!stale) return;
  dropLanding(stale);
  warnEvent(
    root,
    "harness",
    `land queue head ${path.basename(stale)} is unreadable (torn or foreign) — dropped so the queue can drain`,
  );
}

/** Already-merged verdicts cached per (root, sha) against the main head they were computed
 * against. drainVetting re-runs its dedupe against main every poll, but a queued entry's sha is
 * fixed and merge-base --is-ancestor against the same head always returns the same answer — the
 * verdict can only change when main itself moves (a landing's fast-forward). Serving the verdict
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
  if (hit && hit.head === head) return hit.merged;
  const merged = await isMergedInto(root, sha, mainBranch);
  if (mergedIntoMainCache.size >= MERGED_INTO_MAIN_CACHE_MAX && !mergedIntoMainCache.has(key)) {
    for (const [k, v] of mergedIntoMainCache) if (v.head !== head) mergedIntoMainCache.delete(k);
    if (mergedIntoMainCache.size >= MERGED_INTO_MAIN_CACHE_MAX) mergedIntoMainCache.clear();
  }
  mergedIntoMainCache.set(key, { head, merged });
  return merged;
}

/** Start a vet, in queue order, for every queued entry whose role the pipeline does not already
 * hold, up to vetLimit — the shared semaphore bounds how many of them run. The torn-head drop comes
 * first, and each entry is deduped against main before its vet starts: an entry whose sha main
 * already holds (a crash between the fast-forward and the drop) is dropped without a run, with
 * its marker record; a crash mid-vet leaves both entry and ref, so the entry is vetted again —
 * the established crash semantics. */
export async function drainVetting(ctx: LandingPipelineContext, p: LandingPipeline): Promise<void> {
  dropTornHead(ctx.root);
  const queue = queuedLandingFiles(ctx.root);
  // One main-head read per poll with a non-empty queue (branchHead's ref-file fast path — no
  // spawn), serving every entry's cached dedupe verdict below.
  const mainHead = queue.length === 0 ? "" : ((await branchHead(ctx.root, ctx.mainBranch)) ?? "");
  for (const { entry, file } of queue) {
    if (p.vetting.size >= vetLimit(ctx.semaphore.limit)) return;
    if (liveRoles(p).has(entry.role)) continue;
    if (await mergedIntoMain(ctx.root, entry.sha, ctx.mainBranch, mainHead)) {
      dropLanding(file);
      removeLandingChange(ctx.root, entry.role);
      continue;
    }
    // The dedupe awaited git: a task that settled meanwhile may have dropped this very entry
    // (its role was busy when the queue was listed) or claimed its role. Start nothing for it.
    if (!fs.existsSync(file) || liveRoles(p).has(entry.role)) continue;
    startVet(ctx, p, entry, file);
  }
}

/** Start one vet task and record it in `p.vetting`: parked until a shared permit comes, at
 * LANDING_TIER (a shutdown settles a parked vet at once, and one granted while the start gate
 * is closed hands its permit back — either way nothing ran, and its entry and pin stay queued
 * with no outcome written), then, holding the permit for its whole length: open the change's
 * marker record and vet it — checkout at the pin, rebase onto main, gate check, review
 * (vetRequest), the verdict persisted by the gate. An approval moves it to `vetted` (record
 * `vetted, awaiting merge`). Any other verdict — rejected, a review_error of either kind,
 * main_red, a lost pin's "error", aborted — is final for this queue entry, so its outcome is
 * written at once and its entry dropped, which frees its author on the next poll while the
 * other vets run on (BUGS.md 2026-09-23's early-rejection rule). A user-aborted vet discards its
 * pin; a shutdown keeps it. Never rejects for a failed landing: an unexpected throw becomes an
 * "error" outcome. Exported for test/orchestrator-fixtures.ts's landHead, which lands one queue
 * entry through the pipeline without draining the rest of the queue. */
export function startVet(ctx: LandingPipelineContext, p: LandingPipeline, entry: LandingEntry, file: string): void {
  const { root, mainBranch, signal, semaphore } = ctx;
  const { role } = entry;
  const author = resolveAuthor(ctx, role);
  const vet: InFlightLanding = {
    promise: Promise.resolve(), // Replaced below; the placeholder satisfies the type.
    controller: new AbortController(),
    roles: [role],
    userAborted: false,
    parked: true,
  };
  abortOnShutdown(signal, vet.controller);
  p.vetting.set(role, vet);
  vet.promise = (async () => {
    try {
      const release = await acquireUnlessAborted(semaphore, LANDING_TIER, vet.controller.signal);
      vet.parked = false;
      if (release === null) return; // a shutdown while parked
      if (vet.controller.signal.aborted || ctx.startHeld()) {
        release(); // stopping, or a restart / fleet hold closed the gate while it waited
        return;
      }
      const { usage, foldUsage } = landingUsage(author);
      let verdict: VetVerdict;
      const startedAt = Date.now();
      try {
        addLandingChange(root, entry, liveRoles(p));
        verdict = await vetRequest(
          { root, mainBranch, config: author.config, signal: () => vet.controller.signal, runGatePi: (opts) => author.runGatePi(opts) },
          {
            role,
            sha: entry.sha,
            tick: entry.tick,
            summary: entry.summary,
            body: entry.body,
            highFriction: entry.highFriction,
            ...(entry.revisionRound !== undefined ? { revisionRound: entry.revisionRound } : {}),
            ...(entry.priorReview !== undefined ? { priorReview: entry.priorReview } : {}),
          },
          { state: author.state, foldUsage, runPi: (w, prompt, s, cfg) => author.runLandingPi(w, prompt, s, cfg), runGatePi: (opts) => author.runGatePi(opts) },
        );
      } catch (err) {
        verdict = { kind: "result", result: "error" };
        author.state.lastError = errorMessage(err);
      } finally {
        release();
      }
      if (verdict.kind === "stack" && !vet.userAborted) {
        p.vetted.set(role, {
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
        setLandingChangeStatus(root, role, "vetted");
      } else {
        const result = verdict.kind === "stack" ? "aborted" : verdict.result;
        await settleLandingOutcome(root, entry, author.state, result, Date.now() - startedAt, usage, file);
        if (vet.userAborted) await discardPinnedRefs(root, [role]);
      }
    } finally {
      p.vetting.delete(role);
    }
  })();
}
