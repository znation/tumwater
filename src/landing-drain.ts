import path from "node:path";
import type { TumwaterConfig } from "./config-schema.js";
import { DIRECTOR_ROLE } from "./roles.js";
import { LoopRunner } from "./loop.js";
import { deleteRef, isMergedInto } from "./git.js";
import { landBatch } from "./land-batch.js";
import {
  landQueuedEntry,
  landingUsage,
  readLandingMarker,
  writeLandingMarker,
  writeLandingOutcome,
  type LandingStage,
} from "./landing-slot.js";
import { dropLanding, headLanding, queuedLandingFiles, staleHeadFile } from "./land-queue.js";
import { warnEvent } from "./events.js";
import { removeQuiet } from "./files.js";
import { Semaphore } from "./semaphore.js";
import { landingRefName, landingStatePath } from "./paths.js";
import { errorMessage } from "./text.js";
import { saveLoopState } from "./state.js";
import type { TickResult } from "./types.js";

/** The semaphore tier a landing's pi runs acquire at, below every roleTier (0/1): committed
 * work whose author the interlock has already blocked jumps ahead of parked role waiters
 * rather than starving behind them (BUGS.md 2026-09-18). */
const LANDING_TIER = -1;

/** The single in-flight landing the drain owns (merge queue 3/5): its task, the controller
 * that aborts it (harness shutdown OR `tumwater abort --role` for any of its roles), and
 * whether the abort was a deliberate user stop — which decides what happens to the pinned
 * refs when it ends. Since merge queue 5/5 `roles` is every role the slot is landing: one for
 * the single path, up to landBatchMax for a batch. A batched role leaves it the moment its
 * change reaches a final Phase-A verdict and its entry drops: that role may tick again at
 * once, so an abort for its new tick must not kill the batch, and a user-aborted batch must
 * not discard the pin of the role's next change. */
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
   * landing that is aborted while parked still aborts (with its ref rules) once a slot frees. */
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
  const { root, mainBranch, signal, semaphore, runners, liveConfig, roleConfig, onSlotCleared } = ctx;

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

  // Resolve a landing entry's authoring runner: the live runner when the role is enabled
  // (runners are never removed from the array on disable — only a warning event fires); a
  // role disabled before this process started has no runner, so a throwaway one supplies
  // the same wiring (loop-pi.ts, runLandingPi, foldLandingUsage) and a disk-loaded state
  // to fold and save on. Both share the live config, like every runner — the director
  // keeps liveConfig (its budget-gate exemption), every other role takes roleConfig.
  const authorFor = (role: string): LoopRunner =>
    runners.find((r) => r.role === role) ??
    new LoopRunner(root, role, role === DIRECTOR_ROLE ? liveConfig : roleConfig, mainBranch, signal);

  let head = headLanding(root);
  if (!head) {
    // A torn head (a hard crash mid enqueueLanding write, or a foreign file) makes
    // headLanding read null forever — nothing else drops it, stranding every live entry
    // behind it and pinning their authors' ticks via the interlock. Drop it with one
    // warning; a healthy head surfacing behind it drains in the same poll. The crashed
    // entry's commit, if any, still rides its landing ref into next-tick leftover
    // recovery (BUGS.md 2026-09-17).
    const stale = staleHeadFile(root);
    if (stale) {
      dropLanding(stale);
      warnEvent(
        root,
        "harness",
        `land queue head ${path.basename(stale)} is unreadable (torn or foreign) — dropped so the queue can drain`,
      );
      head = headLanding(root);
    }
  }
  if (!head) return null;

  if (await isMergedInto(root, head.entry.sha, mainBranch)) {
    dropLanding(head.file);
    // A crash between the 4/5 marker write and its removal can leave a marker with
    // no live landing — this branch runs only when the slot is free, so a marker naming
    // this entry is stale; clear it so the idle fleet reads clean. (Any marker naming
    // another QUEUED entry cannot exist: that entry's landing would own the slot, and this
    // one is the queue head. One naming an entry no longer queued — a crash between a
    // batch's mid-batch drop and its marker re-point — never displays through the
    // snapshot cross-check, and the next landing overwrites it.)
    const marker = readLandingMarker(root);
    if (marker && marker.sha === head.entry.sha) removeQuiet(landingStatePath(root));
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
  // per-change review gates, one shared build check over the stacked tree, one
  // fast-forward. The 4/5 marker names the first batched entry still queued — the
  // queue head: batch[0] at the start, re-pointed when a final Phase-A verdict drops
  // the entry it names (the cross-check needs a queued entry to validate its sha
  // against); the other batched roles show their queued state in the queue itself.
  // Per-role wiring is resolved exactly as the single path resolves its author, and
  // usage accumulates per role (a reviewer's run charges to its change's authoring
  // role, like landQueuedEntry).
  const first = batch[0]!;
  return startLanding(
    batch.map((b) => b.entry.role),
    async (landing) => {
      const startedAt = Date.now();
      const markLanding = (b: (typeof batch)[number], stage: LandingStage): void =>
        writeLandingMarker(root, {
          role: b.entry.role,
          sha: b.entry.sha,
          summary: b.entry.summary,
          startedAt,
          stage,
        });
      markLanding(first, "merging"); // Phase A's checkout comes first; the head's gate advances it
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
      let marked: (typeof batch)[number] | undefined = first;
      // A final Phase-A verdict (rejected, strike-cap discard, uncheckable pin) needs
      // nothing more from the batch: write its outcome and drop its entry the moment it is
      // persisted, so the interlock frees its author on the next poll instead of holding the
      // role with the most urgent work until every other change has reviewed, checked, and
      // merged (BUGS.md 2026-09-23). Approved changes stay queued — their authors must not
      // tick on top of an unlanded change. The drop comes first and the marker re-point
      // after, as in landQueuedEntry: a crash between them leaves a marker naming a dropped
      // sha, which the snapshot cross-check never displays; a crash after the drop cannot
      // resurrect the entry, and the outcome it carried is already saved and logged.
      const onFinal = (i: number, result: TickResult): void => {
        writeBack(i, result, Date.now() - startedAt);
        // The role has left the batch (InFlightLanding.roles): it may tick again now.
        const at = landing.roles.indexOf(batch[i]!.entry.role);
        if (at >= 0) landing.roles.splice(at, 1);
        // The re-point keeps the batch's startedAt and the stage the marker already shows;
        // the new subject's own gate advances it from there (setLandingStage follows the
        // marker's role).
        if (batch[i] === marked) {
          marked = firstQueued();
          if (marked) markLanding(marked, readLandingMarker(root)?.stage ?? "merging");
          else removeQuiet(landingStatePath(root));
        }
      };
      try {
        const outcomes = await landBatch(
          { root, mainBranch, config: roleConfig, signal: () => landing.controller.signal, onFinal },
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
