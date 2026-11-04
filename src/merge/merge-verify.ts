import fs from "node:fs";
import path from "node:path";
import { withRunPermit } from "../concurrency/run-permit.js";
import { branchHead } from "../git/git.js";
import { addMergeChange, mergeUsage, removeMergeChange, setMergeChangeStatus } from "./merge-slot.js";
import { dropMerge, entryRevisionFields, queuedMergeFiles, type MergeEntry } from "./merge-queue.js";
import { warnEventBestEffort, TUMWATER_SOURCE } from "../events/events.js";
import { errorMessage } from "../text/text.js";
import { verifyRequest, type VerifyVerdict } from "./merge-batch.js";
import { dropTornHead, mergedIntoMain } from "./merge-head.js";
import { VERIFY_TIER, resolveAuthor } from "./merge-author.js";
import { verifyLimit } from "./merge-tiers.js";
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

/** Start a verification, in queue order, for every queued entry whose role the pipeline does not
 * already hold, up to verifyLimit — the shared semaphore bounds how many of them run. The torn-head
 * drop comes first, and each entry is deduped against main before its verification starts: an entry
 * whose sha main already holds (a crash between the fast-forward and the drop) is dropped without a
 * run, with its marker record; a crash mid-verification leaves both entry and ref, so the entry is
 * verified again — the established crash semantics. */
export async function drainVerify(ctx: MergePipelineContext, p: MergePipeline): Promise<void> {
  await dropTornHead(ctx.root);
  const queue = queuedMergeFiles(ctx.root);
  // One main-head read per poll with a non-empty queue (branchHead's ref-file fast path — no
  // spawn), serving every entry's cached dedupe verdict below.
  const mainHead = queue.length === 0 ? "" : ((await branchHead(ctx.root, ctx.mainBranch)) ?? "");
  for (const { entry, file } of queue) {
    if (p.verifying.size >= verifyLimit(ctx.semaphore.limit)) return;
    if (liveRoles(p).has(entry.role)) continue;
    // A re-queued review_error waits out its delay; the entry stays queued and holds its author.
    if (entry.notBefore !== undefined && Date.now() < entry.notBefore) continue;
    if (await mergedIntoMain(ctx.root, entry.sha, ctx.mainBranch, mainHead)) {
      // The drop can throw (a queue file that is a directory or locked fails fs.rmSync, the
      // shape an ENOSPC or immutable queue file takes); this runs in the poll body with nothing
      // to guard it — report it and leave the entry for the next poll, as dropTornHead and
      // settleAbortedApproved guard their own drops.
      try {
        dropMerge(file);
      } catch (err) {
        warnEventBestEffort(ctx.root, TUMWATER_SOURCE, `merge queue entry ${path.basename(file)} could not be dropped: ${errorMessage(err)}`);
      }
      removeMergeChange(ctx.root, entry.role);
      continue;
    }
    // The dedupe awaited git: a task that settled meanwhile may have dropped this very entry
    // (its role was busy when the queue was listed) or claimed its role. Start nothing for it.
    if (!fs.existsSync(file) || liveRoles(p).has(entry.role)) continue;
    // A reviewer hold parks no named entry — every entry keeps draining (no verify, start or
    // landing waits on the reviewer); only a restart or disk hold (the start gate's other legs)
    // parks it here, and a parked verification re-checks the gate when its permit comes. The
    // start gate decides.
    if (ctx.startHeld(entry.role)) continue;
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
      const lease = await acquireUnlessAborted(semaphore, VERIFY_TIER, verify.controller.signal);
      verify.parked = false;
      if (lease === null) return; // a shutdown while parked
      if (verify.controller.signal.aborted || ctx.startHeld(role)) {
        lease.release(); // stopping, or a restart / team hold closed the gate while it waited
        return;
      }
      const { usage, foldUsage } = mergeUsage(author, root);
      let verdict: VerifyVerdict;
      const startedAt = Date.now();
      try {
        addMergeChange(root, entry, liveRoles(p));
        // The verification's lease rides in the run-permit store for the verification's body,
        // so an idle pause inside it (a failed review's in-place retry) re-takes the same
        // team permit; its slot wait hands the permit back too.
        verdict = await withRunPermit(
          lease,
          () =>
            verifyRequest(
              { root, mainBranch, config: author.config, signal: () => verify.controller.signal, runGatePi: (opts) => author.runGatePi(opts), reviewHeld: () => ctx.startHeld() },
              {
                role,
                sha: entry.sha,
                runNumber: entry.run,
                summary: entry.summary,
                body: entry.body,
                highFriction: entry.highFriction,
                ...entryRevisionFields(entry),
                ...(entry.claim !== undefined ? { claim: entry.claim } : {}),
              },
              { state: author.state, foldUsage, runPi: (w, prompt, s, cfg) => author.runMergePi(w, prompt, s, cfg), runGatePi: (opts) => author.runGatePi(opts) },
            ),
        );
      } catch (err) {
        verdict = { kind: "result", result: "error" };
        author.state.lastError = errorMessage(err);
      } finally {
        lease.release();
      }
      if (verdict.kind === "approved" && !verify.userAborted) {
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
        const result = verdict.kind === "approved" ? "aborted" : verdict.result;
        await settleMergeOutcome(root, entry, author.state, result, Date.now() - startedAt, usage, file, mainBranch);
        if (verify.userAborted) await discardPinnedRefs(root, [role]);
      }
    } finally {
      detachShutdown();
      p.verifying.delete(role);
    }
  })();
  verify.promise = guardMergeTask(root, role, task);
}
