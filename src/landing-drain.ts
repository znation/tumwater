import fs from "node:fs";
import path from "node:path";
import type { TumwaterConfig } from "./config-schema.js";
import { DIRECTOR_ROLE } from "./roles.js";
import { LoopRunner } from "./loop.js";
import { deleteRef, isMergedInto } from "./git.js";
import { landBatch, landVetted, vetRequest, type BatchRoleWiring, type VetVerdict } from "./land-batch.js";
import {
  addLandingChange,
  landQueuedEntry,
  landingChanges,
  landingUsage,
  readLandingMarker,
  removeLandingChange,
  setLandingChangeStatus,
  writeBatchLandingMarker,
  writeLandingOutcome,
} from "./landing-slot.js";
import { dropLanding, headLanding, queuedLandingFiles, staleHeadFile } from "./land-queue.js";
import { warnEvent } from "./events.js";
import { removeQuiet } from "./files.js";
import { Semaphore } from "./semaphore.js";
import { landingRefName, landingStatePath } from "./paths.js";
import { errorMessage } from "./text.js";
import { saveLoopState } from "./state.js";
import type { AbortableLanding } from "./operator-requests.js";
import type { LandingEntry, PiRunResult, TickResult } from "./types.js";

/** The semaphore tier a landing's pi runs acquire at, below every roleTier (0/1): committed
 * work whose author the interlock has already blocked jumps ahead of parked role waiters
 * rather than starving behind them (BUGS.md 2026-09-18). */
const LANDING_TIER = -1;

/** One in-flight landing task the drain owns (merge queue 3/5): its task, the controller
 * that aborts it (harness shutdown OR `tumwater abort --role` for any of its roles), and
 * whether the abort was a deliberate user stop — which decides what happens to the pinned
 * refs when it ends. Since merge queue 5/5 `roles` is every role the slot is landing: one for
 * the single path, up to landBatchMax for a batch. A batched role leaves it the moment its
 * change reaches a final Phase-A verdict and its entry drops: that role may tick again at
 * once, so an abort for its new tick must not kill the batch, and a user-aborted batch must
 * not discard the pin of the role's next change. Since land-queue speed 2c the same record
 * also carries one vetting-stage task (its one role) and the merge slot's stack (every role
 * it is merging) — see LandingPipeline. */
export interface InFlightLanding {
  promise: Promise<void>;
  controller: AbortController;
  roles: string[];
  userAborted: boolean;
}

/** Discard the pinned landing refs of every role in a deliberately-aborted landing.
 * `tumwater abort --role` throws the committed work away, and the pin is what would otherwise
 * recover it, so the ref must go; a shutdown abort leaves `userAborted` unset and every ref
 * survives for recovery. Shared by the single-landing and batch-landing finally blocks so
 * their discard semantics cannot drift. A ref that is already gone is not an error. */
async function discardPinnedRefs(root: string, roles: string[]): Promise<void> {
  for (const role of roles) {
    try {
      await deleteRef(root, landingRefName(role));
    } catch {
      /* already gone */
    }
  }
}

/** Resolve a landing entry's authoring runner: the live runner when the role is enabled
 * (runners are never removed from the array on disable — only a warning event fires); a role
 * disabled before this process started has no runner, so a throwaway one supplies the same
 * wiring (loop-pi.ts, runLandingPi, foldLandingUsage) and a disk-loaded state to fold and save
 * on. Both share the live config, like every runner — the director keeps liveConfig (its
 * budget-gate exemption), every other role takes roleConfig. */
function resolveAuthor(ctx: LandingDrainContext | LandingPipelineContext, role: string): LoopRunner {
  const { root, mainBranch, signal, runners, liveConfig, roleConfig } = ctx;
  return (
    runners.find((r) => r.role === role) ??
    new LoopRunner(root, role, role === DIRECTOR_ROLE ? liveConfig : roleConfig, mainBranch, signal)
  );
}

/** Drop a torn queue head. A torn head (a hard crash mid enqueueLanding write, or a foreign
 * file) makes headLanding read null forever — nothing else drops it, stranding every live entry
 * behind it and pinning their authors' ticks via the interlock. Drop it with one warning; a
 * healthy head surfacing behind it drains in the same poll. The crashed entry's commit, if any,
 * still rides its landing ref into next-tick leftover recovery (BUGS.md 2026-09-17). Both drains
 * run it first — the single landing slot and the vetting stage. */
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

/** The per-poll state the drain reads from the scheduler: everything the queue-head dedupe
 * and the two landing paths need, resolved once by the poll loop. The scheduler keeps WHEN to
 * drain (after the gates, once the slot is free and no restart is pending); this module owns
 * HOW — from `headLanding` to the slot's running task. */
export interface LandingDrainContext {
  root: string;
  mainBranch: string;
  /** The combined caller+internal stop signal: harness shutdown aborts an in-flight landing. */
  signal: AbortSignal;
  /** The landing's pi runs — a reviewer, or a batch's per-change gates — cost the backend
   * what an author run costs, so they take the same maxConcurrent permit role ticks do
   * (BUGS.md 2026-09-18). Exempting them let total load float to maxConcurrent + landing +
   * director on a single-GPU backend, where the extra stream is what starves sessions into the
   * quiet watchdog's kills. The landing's wait is bounded by one in-flight tick, and a queued
   * landing that is aborted while parked still aborts (with its ref rules) once a slot frees.
   * A batch's concurrent Phase-A gates take one permit EACH: the slot's covers the first, and
   * every gate beside it waits for its own at the same tier (landBatch's gatePermit) — so two
   * reviewers at once never ride one permit, and at a full semaphore the gates simply run one
   * after another on the slot's. */
  semaphore: Semaphore;
  /** Live runners, searched first when resolving a landing's author. */
  runners: LoopRunner[];
  /** The live config: supplies `landBatchMax` and the director's budget-exempt config. */
  liveConfig: TumwaterConfig;
  /** The derived config non-director roles run under (the fallback view). */
  roleConfig: TumwaterConfig;
  /** Runs when the slot's landing ends, so the scheduler can clear its in-flight record. */
  onSlotCleared: () => void;
}

/** Drain the durable land queue onto the single landing slot (merge queue 3/5). Returns the
 * landing just started for the caller to store as its in-flight record — null when nothing
 * was started this poll (no slot, no queue head, or the head is already merged into main).
 * A queued landing is COMMITTED work awaiting completion, not a new tick, so the budget and
 * user-pause gates deliberately do not hold it (pausing it would leave main behind while
 * the interlock below blocks that role's next tick forever); the caller DOES suppress it
 * while `holdForRestart`, like ticks — a landing started now would only lengthen the restart's
 * hand-off (whose wait on the one already in flight is bounded — orchestrator.ts's
 * awaitLandingForHandoff), and the entry drains on the next start (a pending-restart break
 * precedes this). One landing at a time: the promise is stored, never awaited in the poll
 * loop, and cleared on completion — authors keep ticking behind it, which is the entire
 * point. The head is deduped against main first: a crash
 * between the ff-merge and the entry drop leaves an entry whose sha main already holds, and
 * that is dropped without a landing run (leftover.ts's stale-pin idiom); a crash mid-review
 * leaves both entry and ref, so the drain re-runs landChange — re-reviews — the established
 * crash semantics. */
export async function drainLandingQueue(ctx: LandingDrainContext): Promise<InFlightLanding | null> {
  const { root, mainBranch, signal, semaphore, liveConfig, roleConfig, onSlotCleared } = ctx;

  const withLandingSlot = async <T>(run: () => Promise<T>): Promise<T> => {
    await semaphore.acquire(LANDING_TIER);
    try {
      return await run();
    } finally {
      semaphore.release();
    }
  };

  /** Start one in-flight landing: build the slot's record (its roles, its own abort controller,
   * the `userAborted` flag), wire harness shutdown to abort it, run `body` on the single landing
   * slot, and tear the record down — clearing the pinned refs when the abort was a deliberate
   * `tumwater abort` (a shutdown leaves them for recovery) and freeing the slot. Both drain
   * paths (the single landing and the coalesced batch) share this frame; they differ only in the
   * body, which holds the per-role wiring, and the batch adds its own marker cleanup.
   * Returns the record for the caller to store in its in-flight slot. */
  const startLanding = (
    roles: string[],
    body: (landing: InFlightLanding) => Promise<void>,
  ): InFlightLanding => {
    const landing: InFlightLanding = {
      promise: Promise.resolve(), // Replaced below; the placeholder satisfies the type.
      controller: new AbortController(),
      roles,
      userAborted: false,
    };
    // Harness shutdown aborts the landing through the per-landing controller (the lander
    // watches it); `tumwater abort --role` for any of its roles aborts it too, flagged
    // userAborted — the two differ only in what happens to the pinned refs after.
    signal.addEventListener("abort", () => landing.controller.abort(), { once: true });
    landing.promise = withLandingSlot(async () => {
      try {
        await body(landing);
      } finally {
        if (landing.userAborted) await discardPinnedRefs(root, landing.roles);
        onSlotCleared();
      }
    });
    return landing;
  };

  const authorFor = (role: string): LoopRunner => resolveAuthor(ctx, role);

  dropTornHead(root);
  const head = headLanding(root);
  if (!head) return null;

  if (await isMergedInto(root, head.entry.sha, mainBranch)) {
    dropLanding(head.file);
    // A crash between the 4/5 marker write and its removal can leave a marker with
    // no live landing — this branch runs only when the slot is free, so a marker naming
    // this entry is stale; clear it so the idle fleet reads clean. A batch marker names
    // this entry in any of its per-change records, not only at its top level (which
    // follows whichever change was in flight). (Any marker naming another QUEUED entry
    // cannot exist: that entry's landing would own the slot, and this one is the queue
    // head. Records naming entries no longer queued — a batch's mid-batch drops — never
    // display through the snapshot cross-check, and the next landing overwrites them.)
    const marker = readLandingMarker(root);
    if (marker && landingChanges(marker).some((c) => c.sha === head.entry.sha)) {
      removeQuiet(landingStatePath(root));
    }
    return null;
  }

  // Merge queue 5/5 — read the whole batch the slot will land: the queue head plus
  // up to landBatchMax-1 more entries in queue order. Length 1 IS today's single
  // path (the slice agrees with `head` — the only entry dropper is this arm's own
  // write-back, which runs while the slot is busy, and this arm runs only when it
  // is free); length >= 2 is the coalesced batch through landBatch.
  const batch = queuedLandingFiles(root).slice(0, liveConfig.landBatchMax);
  if (batch.length === 0) {
    // The head's file vanished between the two queue reads (no in-process writer
    // does that — defensive): nothing to land this poll.
    return null;
  }
  if (batch.length === 1) {
    const author = authorFor(head.entry.role);
    return startLanding([head.entry.role], async (landing) => {
      await landQueuedEntry(root, head.entry, head.file, author, author.config, mainBranch, landing.controller.signal);
    });
  }
  // The batch slot: land `batch` as ONE stack through the shared landBatch —
  // per-change review gates (up to PHASE_A_CONCURRENCY at once, each beyond the
  // first on a permit of its own), one shared build check over the stacked tree, one
  // fast-forward. The 4/5 marker carries one record per batched change, each advanced
  // by landBatch's status hook as the batch reaches it (waiting → landing → approved /
  // done, in whatever order the concurrent gates get there, with the change's own
  // start stamped when the slot reaches it) and staged by its own gate
  // (setLandingStage), so every batched row shows what the slot is doing with ITS
  // change — each one being gated reads `landing <its elapsed> · <stage>`, the rest
  // `queued in batch` or `approved, awaiting batch`, and a change the batch is done
  // with shows nothing (BUGS.md 2026-09-23: a single head-only marker kept a
  // long-rejected head reading `landing 29m` while the change under review showed no
  // landing). The snapshot cross-checks each record against its still-queued entry,
  // so a change a final verdict dropped mid-batch never displays. Per-role wiring is
  // resolved exactly as the single path resolves its author, and usage accumulates
  // per role (a reviewer's run charges to its change's authoring role, like
  // landQueuedEntry).
  const first = batch[0]!;
  return startLanding(
    batch.map((b) => b.entry.role),
    async (landing) => {
      const startedAt = Date.now();
      writeBatchLandingMarker(root, batch.map((b) => b.entry), startedAt);
      const authors = new Map(batch.map((b) => [b.entry.role, authorFor(b.entry.role)]));
      const usages = new Map<string, { tokens: number; cost: number }>();
      // The batch indices whose outcome is already written back and entry dropped, so no
      // outcome is applied, logged, or dropped twice: a final Phase-A verdict writes back
      // mid-batch (onFinal below), and the end-of-batch write-back skips it.
      const written = new Set<number>();
      const writeBack = (i: number, result: TickResult, durationMs: number): void => {
        if (written.has(i)) return;
        written.add(i);
        const b = batch[i]!;
        writeLandingOutcome(
          root,
          b.entry,
          authors.get(b.entry.role)!.state,
          result,
          durationMs,
          usages.get(b.entry.role) ?? { tokens: 0, cost: 0 },
          b.file,
        );
      };
      // The first batched entry still queued — the queue head while the slot is busy.
      const firstQueued = () => batch.find((_, i) => !written.has(i));
      // A final Phase-A verdict (rejected, strike-cap discard, uncheckable pin) needs
      // nothing more from the batch: write its outcome and drop its entry the moment it is
      // persisted, so the interlock frees its author on the next poll instead of holding the
      // role with the most urgent work until every other change has reviewed, checked, and
      // merged (BUGS.md 2026-09-23). Approved changes stay queued — their authors must not
      // tick on top of an unlanded change. The marker needs nothing here: landBatch has
      // already reported the change `done`, and once its entry is gone the snapshot
      // cross-check drops its record whatever it last said — a crash after the drop cannot
      // resurrect the entry, and the outcome it carried is already saved and logged.
      const onFinal = (i: number, result: TickResult): void => {
        writeBack(i, result, Date.now() - startedAt);
        // The role has left the batch (InFlightLanding.roles): it may tick again now.
        const at = landing.roles.indexOf(batch[i]!.entry.role);
        if (at >= 0) landing.roles.splice(at, 1);
      };
      try {
        const outcomes = await landBatch(
          {
            root,
            mainBranch,
            config: roleConfig,
            signal: () => landing.controller.signal,
            onFinal,
            onChangeStatus: (role, status) => setLandingChangeStatus(root, role, status),
            gatePermit: async () => {
              await semaphore.acquire(LANDING_TIER);
              return () => semaphore.release();
            },
          },
          batch.map((b) => ({
            role: b.entry.role,
            sha: b.entry.sha,
            tick: b.entry.tick,
            summary: b.entry.summary,
            body: b.entry.body,
            highFriction: b.entry.highFriction,
          })),
          (role) => {
            const author = authors.get(role)!;
            const { usage, foldUsage } = landingUsage(author);
            usages.set(role, usage);
            return {
              state: author.state,
              foldUsage,
              runPi: (w, p, s) => author.runLandingPi(w, p, s),
            };
          },
        );
        // One slot unit landed: the batch's wall time is the durationMs of every
        // change still queued (a final Phase-A verdict already wrote its own, up to
        // its verdict), each change's event carries its own role's spend. A
        // `result === undefined` means unattempted (an early stop ran before it)
        // — its entry and ref stay queued, so the write-back skips it.
        const durationMs = Date.now() - startedAt;
        outcomes.forEach((outcome, i) => {
          if (outcome.result !== undefined) writeBack(i, outcome.result, durationMs);
        });
      } catch (err) {
        // An unexpected throw escapes the batch (git plumbing — landBatch degrades
        // failed LANDINGS to results): the 3/5 semantics keep every entry still
        // queued for re-drain (only the final Phase-A verdicts already left through
        // onFinal — the rest write back after landBatch returns), with the error on
        // the queue head's role state. Re-drain is bounded and self-terminating: the
        // gate short-circuits an already-approved head that Phase A's re-sync leaves
        // unchanged (a pin already on main's tip — its persisted verdict), a stale pin
        // re-syncs to a fresh sha and is reviewed once more, and a fast-forward that
        // already happened re-lands as no-ops through each change's own gate + in-lock
        // check.
        const author = authors.get((firstQueued() ?? first).entry.role)!;
        author.state.lastError = errorMessage(err);
        saveLoopState(root, author.state);
      } finally {
        removeQuiet(landingStatePath(root));
      }
    },
  );
}

// ── Land-queue speed 2c: a parallel vetting stage and a serial merge slot ────────────────────

/** The tier the merge slot's conflict-resolution runs take the vetting cap at: ahead of any
 * vet parked for a permit, because the merge is the one serial step every queued change waits
 * on. (A vet never waits on the merge — no vet takes the merge lock — so this cannot deadlock.) */
const MERGE_TIER = LANDING_TIER - 1;

/** A change the vetting stage approved (or found exempt), waiting for the merge slot: still
 * queued — its author stays interlocked until it lands — with the head its gate approved in
 * its landing ref (`sha`) and the approval's patch-id in its state (2a). In memory only: after a
 * restart the entry is vetted again, and its review carries over through the patch-id while
 * its check runs once more. It holds no task, so `tumwater abort --role` only flags it
 * (AbortableLanding); the next drain settles it as "aborted" and discards its pin. */
export interface VettedLanding extends AbortableLanding {
  entry: LandingEntry;
  /** The queue file to drop once its outcome is written. */
  file: string;
  /** The head its gate approved — the synced pin its landing ref names. */
  sha: string;
  /** When its vet started: its landed/land_failed event's durationMs runs from here. */
  startedAt: number;
  /** The authoring runner its vet ran with — reused by its merge, so both fold into one state. */
  author: LoopRunner;
  /** The landing's own spend so far (its reviewer), and the fold that adds to it. */
  usage: { tokens: number; cost: number };
  foldUsage(run: PiRunResult): void;
}

/** The scheduler's landing state across polls (land-queue speed 2c). With
 * `maxConcurrentLandings` 1 it is today's single landing slot and nothing else: `merge` holds
 * the one landing — a single change or a batch through landBatch, review and merge in one
 * task — with `single` set. Above 1 the slot splits in two:
 * - `vetting`: up to maxConcurrentLandings tasks, one per change, in queue order, each in its
 *   own `_land-<role>` worktree — checkout, rebase onto main, gate check and review
 *   (vetRequest). Any verdict but an approval writes its outcome at once and frees its author.
 * - `vetted`: the approved changes waiting to merge, still queued.
 * - `merge`: the one task that writes main — every vetted change up to landBatchMax, in queue
 *   order, through landVetted (a stack of two or more shares one check and one fast-forward).
 *   It never waits for an unvetted queue head.
 * A role is in at most one of them: its one queued change is vetted, then waits, then merges, so
 * a vet and a merge never touch the same worktree or ref. */
export interface LandingPipeline {
  vetting: Map<string, InFlightLanding>;
  vetted: Map<string, VettedLanding>;
  merge: InFlightLanding | null;
  /** True while `merge` is the single landing slot's landing (maxConcurrentLandings 1). */
  single: boolean;
}

export function newLandingPipeline(): LandingPipeline {
  return { vetting: new Map(), vetted: new Map(), merge: null, single: false };
}

/** Every landing task in flight — each vet and the merge (or the single slot's landing) — for
 * the shutdown and restart waits. */
export function landingTasks(p: LandingPipeline): InFlightLanding[] {
  return [...p.vetting.values(), ...(p.merge ? [p.merge] : [])];
}

/** Everything `tumwater abort --role` can reach: every task, plus each vetted change waiting
 * with no task of its own. */
export function abortableLandings(p: LandingPipeline): AbortableLanding[] {
  return [...landingTasks(p), ...p.vetted.values()];
}

/** What the pipeline drain reads from the scheduler: the single-slot drain's context (whose
 * shared `semaphore` the single slot keeps using) plus the vetting stage's own cap and how wide
 * it may run this poll. */
export interface LandingPipelineContext extends Omit<LandingDrainContext, "onSlotCleared"> {
  /** The vetting stage's own cap (maxConcurrentLandings permits, resized by the scheduler):
   * above 1 the vets and the merge slot's conflict-resolution runs draw from it instead of the
   * shared maxConcurrent semaphore, so they add exactly that many streams to the provider. */
  vetSemaphore: Semaphore;
  /** How many changes may be vetted at once: the live maxConcurrentLandings, which the
   * scheduler clamps to 1 while the budget gate is on its fallback model (a local backend has
   * no spare streams). 1 keeps the single landing slot. */
  maxConcurrentLandings: number;
}

/** Wire harness shutdown to one task's own controller — at once when it has already fired,
 * since a listener added after the event never runs. */
function abortOnShutdown(signal: AbortSignal, controller: AbortController): void {
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", () => controller.abort(), { once: true });
}

/** The roles the pipeline holds right now — vetting, vetted, or merging. */
function liveRoles(p: LandingPipeline): Set<string> {
  return new Set([...p.vetting.keys(), ...p.vetted.keys(), ...(p.merge?.roles ?? [])]);
}

/** One poll of the land queue (the scheduler's WHEN is unchanged: after the gates, never while
 * a restart or a 429 hold is pending). At maxConcurrentLandings 1 this is drainLandingQueue
 * exactly — the single slot, its shared permit at LANDING_TIER, its batches — started once
 * the slot is free and no vet from a wider setting is still running. A change such a setting
 * left vetted goes back to plainly queued: the slot re-lands it through its own gate, where the
 * approval carries over (2a) and its check runs again. Above 1: start vets up to the limit
 * (drainVetting), and start the merge when the slot is free and something is vetted
 * (drainMerge) — but nothing new while the single slot's landing from a narrower setting still
 * owns its batch. Starts tasks and returns; never awaits them. */
export async function drainLandings(ctx: LandingPipelineContext, p: LandingPipeline): Promise<void> {
  if (ctx.maxConcurrentLandings <= 1) {
    if (p.merge !== null || p.vetting.size > 0) return;
    for (const role of p.vetted.keys()) removeLandingChange(ctx.root, role);
    p.vetted.clear();
    const landing = await drainLandingQueue({
      ...ctx,
      onSlotCleared: () => {
        p.merge = null;
        p.single = false;
      },
    });
    if (landing) {
      p.merge = landing;
      p.single = true;
    }
    return;
  }
  if (p.merge !== null && p.single) return;
  await drainVetting(ctx, p);
  drainMerge(ctx, p);
}

/** Settle every vetted change `tumwater abort --role` flagged (consumeAbortRequests over
 * abortableLandings): it has no task to stop, so it ends here exactly as an aborted landing
 * does — "aborted" written back, entry dropped, pin discarded (the deliberate stop throws the
 * committed work away). The scheduler runs it every poll right after consuming the requests,
 * held or not: a restart hold that skipped it would hand the flagged change, pin intact, to
 * the next generation to land. */
export async function settleAbortedVetted(root: string, p: LandingPipeline): Promise<void> {
  for (const [role, v] of [...p.vetted]) {
    if (!v.userAborted) continue;
    p.vetted.delete(role);
    writeLandingOutcome(root, v.entry, v.author.state, "aborted", Date.now() - v.startedAt, v.usage, v.file);
    removeLandingChange(root, role);
    await discardPinnedRefs(root, [role]);
  }
}

/** Start vets, in queue order, while fewer than maxConcurrentLandings run: every queued entry
 * whose role the pipeline does not already hold. The torn-head drop and the dedupe against main
 * are the single slot's, applied to each entry about to be vetted rather than only the head: an
 * entry whose sha main already holds (a crash between the fast-forward and the drop) is dropped
 * without a run, with its marker record. */
async function drainVetting(ctx: LandingPipelineContext, p: LandingPipeline): Promise<void> {
  dropTornHead(ctx.root);
  for (const { entry, file } of queuedLandingFiles(ctx.root)) {
    if (p.vetting.size >= ctx.maxConcurrentLandings) return;
    if (liveRoles(p).has(entry.role)) continue;
    if (await isMergedInto(ctx.root, entry.sha, ctx.mainBranch)) {
      dropLanding(file);
      removeLandingChange(ctx.root, entry.role);
      continue;
    }
    // The dedupe awaited git: a task that settled meanwhile may have dropped this very entry
    // (its role was busy when the queue was listed) or claimed its role. Start nothing for it.
    if (!fs.existsSync(file) || liveRoles(p).has(entry.role)) continue;
    p.vetting.set(entry.role, startVet(ctx, p, entry, file));
  }
}

/** One vet task: on a vetting permit (the shutdown signal and a user abort both reach it
 * through its own controller), open the change's marker record, and vet it — checkout at the
 * pin, rebase onto main, gate check, review (vetRequest), the verdict persisted by the gate. An
 * approval moves it to `vetted` (record `vetted, awaiting merge`). Any other verdict — rejected,
 * a review_error of either kind, main_red, a lost pin's "error", aborted — is final for this
 * queue entry, so its outcome is written at once and its entry dropped, which frees its author
 * on the next poll while the other vets run on (BUGS.md 2026-09-23's early-rejection fix, now
 * for every change). A user-aborted vet discards its pin; a shutdown keeps it. Never rejects
 * for a failed landing: an unexpected throw becomes an "error" outcome, like landQueuedEntry. */
function startVet(ctx: LandingPipelineContext, p: LandingPipeline, entry: LandingEntry, file: string): InFlightLanding {
  const { root, mainBranch, signal, vetSemaphore } = ctx;
  const { role } = entry;
  const author = resolveAuthor(ctx, role);
  const vet: InFlightLanding = {
    promise: Promise.resolve(), // Replaced below; the placeholder satisfies the type.
    controller: new AbortController(),
    roles: [role],
    userAborted: false,
  };
  abortOnShutdown(signal, vet.controller);
  vet.promise = (async () => {
    const { usage, foldUsage } = landingUsage(author);
    let verdict: VetVerdict;
    await vetSemaphore.acquire(LANDING_TIER);
    const startedAt = Date.now();
    try {
      addLandingChange(root, entry, liveRoles(p));
      verdict = vet.controller.signal.aborted
        ? { kind: "result", result: "aborted" }
        : await vetRequest(
            { root, mainBranch, config: author.config, signal: () => vet.controller.signal },
            {
              role,
              sha: entry.sha,
              tick: entry.tick,
              summary: entry.summary,
              body: entry.body,
              highFriction: entry.highFriction,
            },
            { state: author.state, foldUsage, runPi: (w, prompt, s) => author.runLandingPi(w, prompt, s) },
          );
    } catch (err) {
      verdict = { kind: "result", result: "error" };
      author.state.lastError = errorMessage(err);
    } finally {
      vetSemaphore.release();
    }
    try {
      if (verdict.kind === "stack" && !vet.userAborted) {
        p.vetted.set(role, {
          entry,
          file,
          sha: verdict.sha,
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
        writeLandingOutcome(root, entry, author.state, result, Date.now() - startedAt, usage, file);
        removeLandingChange(root, role);
        if (vet.userAborted) await discardPinnedRefs(root, [role]);
      }
    } finally {
      p.vetting.delete(role);
    }
  })();
  return vet;
}

/** Start the merge when the slot is free and something is vetted: every vetted change, up to
 * landBatchMax, in queue order among the vetted — an unvetted entry ahead of them in the queue
 * (a slow review) does not hold them back. A vetted change whose queue entry is gone is
 * forgotten (nothing in-process drops one; defensive). */
function drainMerge(ctx: LandingPipelineContext, p: LandingPipeline): void {
  if (p.merge !== null || p.vetted.size === 0) return;
  const queued = queuedLandingFiles(ctx.root);
  const files = new Set(queued.map((q) => q.file));
  for (const [role, v] of [...p.vetted]) {
    if (files.has(v.file)) continue;
    p.vetted.delete(role);
    removeLandingChange(ctx.root, role);
  }
  const picks = queued.flatMap((q) => {
    const v = p.vetted.get(q.entry.role);
    return v?.file === q.file ? [v] : [];
  });
  picks.splice(ctx.liveConfig.landBatchMax);
  if (picks.length === 0) return;
  for (const v of picks) p.vetted.delete(v.entry.role);
  p.merge = startMerge(ctx, p, picks);
  p.single = false;
}

/** The merge task: land `picks` through landVetted on main's current tip — one change through
 * landApprovedChange, two or more as one stack with one scope-`batch` check, one fast-forward,
 * and 3d's largest-passing-prefix bisect — with no second review. A vetted change whose main
 * moved since its vet is re-checked on the tree that lands (the in-lock re-check, or the stack's
 * check), so an approval that outlived its base never lands unverified. Each defined result is
 * written back and its entry dropped; an unattempted change (behind a bisect's attributed one)
 * goes back to `vetted` for the next merge. A plumbing throw keeps every entry queued, as the
 * batch slot's catch does, but un-vetted: each is vetted afresh from its pin next poll. A user
 * abort of any merged role stops the whole stack — the batch rule — and every change it had not
 * landed ends "aborted" with its pin discarded; a shutdown keeps the pins. The task takes no
 * permit of its own — its only model run is mergeToMain's conflict resolver, which takes a
 * vetting permit at MERGE_TIER for the run's length. */
function startMerge(ctx: LandingPipelineContext, p: LandingPipeline, picks: VettedLanding[]): InFlightLanding {
  const { root, mainBranch, signal, roleConfig, vetSemaphore } = ctx;
  const merge: InFlightLanding = {
    promise: Promise.resolve(), // Replaced below; the placeholder satisfies the type.
    controller: new AbortController(),
    roles: picks.map((v) => v.entry.role),
    userAborted: false,
  };
  abortOnShutdown(signal, merge.controller);
  const wiring = new Map<string, BatchRoleWiring>(
    picks.map((v) => [
      v.entry.role,
      {
        state: v.author.state,
        foldUsage: v.foldUsage,
        runPi: async (w, prompt, s) => {
          await vetSemaphore.acquire(MERGE_TIER);
          try {
            return await v.author.runLandingPi(w, prompt, s);
          } finally {
            vetSemaphore.release();
          }
        },
      },
    ]),
  );
  merge.promise = (async () => {
    let results: Array<TickResult | undefined>;
    let threw = false;
    try {
      results = await landVetted(
        {
          root,
          mainBranch,
          config: roleConfig,
          signal: () => merge.controller.signal,
          // A change the stack's fallback has not reached yet is back to waiting its turn.
          onChangeStatus: (role, status) => setLandingChangeStatus(root, role, status === "approved" ? "vetted" : status),
        },
        picks.map((v) => ({
          role: v.entry.role,
          sha: v.sha,
          tick: v.entry.tick,
          summary: v.entry.summary,
          body: v.entry.body,
          highFriction: v.entry.highFriction,
        })),
        (role) => wiring.get(role)!,
      );
    } catch (err) {
      threw = true;
      results = picks.map(() => undefined);
      const head = picks[0]!.author;
      head.state.lastError = errorMessage(err);
      saveLoopState(root, head.state);
    }
    try {
      picks.forEach((v, s) => {
        const { role } = v.entry;
        const result = results[s] ?? (merge.userAborted ? "aborted" : undefined);
        if (result === undefined && !threw) {
          p.vetted.set(role, v);
          setLandingChangeStatus(root, role, "vetted");
          return;
        }
        if (result !== undefined) {
          writeLandingOutcome(root, v.entry, v.author.state, result, Date.now() - v.startedAt, v.usage, v.file);
        }
        removeLandingChange(root, role);
      });
    } finally {
      if (merge.userAborted) await discardPinnedRefs(root, merge.roles);
      p.merge = null;
    }
  })();
  return merge;
}
