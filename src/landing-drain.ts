import fs from "node:fs";
import path from "node:path";
import type { TumwaterConfig } from "./config-schema.js";
import { DIRECTOR_ROLE } from "./roles.js";
import { LoopRunner } from "./loop.js";
import { deleteRef, isMergedInto } from "./git.js";
import { landVetted, vetRequest, type BatchRoleWiring, type VetVerdict } from "./land-batch.js";
import {
  addLandingChange,
  landingUsage,
  removeLandingChange,
  setLandingChangeStatus,
  writeLandingOutcome,
} from "./landing-slot.js";
import { dropLanding, queuedLandingFiles, staleHeadFile } from "./land-queue.js";
import { warnEvent } from "./events.js";
import { Semaphore } from "./semaphore.js";
import { landingRefName } from "./paths.js";
import { errorMessage } from "./text.js";
import { saveLoopState } from "./state.js";
import type { AbortableLanding } from "./operator-requests.js";
import type { LandingEntry, PiRunResult, TickResult } from "./types.js";

/** The semaphore tier a vet waits at, below every roleTier (0/1): committed work whose author
 * the interlock has already blocked jumps ahead of parked role waiters rather than starving
 * behind them (BUGS.md 2026-09-18). */
const LANDING_TIER = -1;

/** The tier the merge slot's conflict-resolution runs wait at: ahead of any vet parked for a
 * permit, because the merge is the one serial step every queued change waits on. (Nothing that
 * holds a permit ever waits on the merge: no vet takes the merge lock, and the resolver runs
 * outside it — merge.ts's mergeToMain — so this cannot deadlock.) */
const MERGE_TIER = LANDING_TIER - 1;

/** One landing task the pipeline owns (merge queue 3/5, land-queue speed 2c) — a vet or the
 * merge: its task, the controller that aborts it (harness shutdown OR `tumwater abort --role`
 * for any of its roles), and whether the abort was a deliberate user stop — which decides what
 * happens to the pinned refs when it ends. `roles` is every role the task holds: one for a vet,
 * every change the merge is landing for the merge. */
export interface InFlightLanding {
  promise: Promise<void>;
  controller: AbortController;
  roles: string[];
  userAborted: boolean;
  /** True while a vet waits for its permit: it holds nothing and has started nothing, so it is
   * not in flight (landingTasks) and not abortable, it has no marker record, and its role reads
   * as plainly queued. */
  parked?: boolean;
}

/** Discard the pinned landing refs of every role in a deliberately-aborted landing.
 * `tumwater abort --role` throws the committed work away, and the pin is what would otherwise
 * recover it, so the ref must go; a shutdown abort leaves `userAborted` unset and every ref
 * survives for recovery. Shared by every task's settling code so their discard semantics
 * cannot drift. A ref that is already gone is not an error. */
async function discardPinnedRefs(root: string, roles: string[]): Promise<void> {
  for (const role of roles) {
    try {
      await deleteRef(root, landingRefName(role));
    } catch {
      /* already gone */
    }
  }
}

/** The per-poll state the pipeline reads from the scheduler, resolved once by the poll loop.
 * The scheduler keeps WHEN to drain (after the gates, never while a restart or a 429 hold is
 * pending); this module owns HOW — from the queue to each vet and the merge. */
export interface LandingPipelineContext {
  root: string;
  mainBranch: string;
  /** The combined caller+internal stop signal: harness shutdown aborts every landing task. */
  signal: AbortSignal;
  /** The shared maxConcurrent semaphore role ticks draw from. A landing's pi runs cost the
   * backend what an author run costs, so landings count as active work: every vet holds one
   * permit for its whole length, and the merge's conflict resolver takes one for its run
   * (BUGS.md 2026-09-18 — exempting the landing let total load float to maxConcurrent +
   * landing + director on a single-GPU backend, where the extra stream is what starves
   * sessions into the quiet watchdog's kills). The permits are all that bounds how many vets
   * run at once. Both landing tiers sit ahead of every role tick's, and a vet takes the slot
   * its author would have used: the interlock keeps that author from ticking until its change
   * lands. */
  semaphore: Semaphore;
  /** Live runners, searched first when resolving a landing's author. */
  runners: LoopRunner[];
  /** The live config: supplies `landBatchMax` and the director's budget-exempt config. */
  liveConfig: TumwaterConfig;
  /** The derived config non-director roles run under (the fallback view). */
  roleConfig: TumwaterConfig;
  /** The scheduler's start gate for new work (a pending restart, a 429 hold), re-checked the
   * moment a parked vet is granted its permit — the one moment it actually starts, exactly as a
   * parked role tick re-checks it (orchestrator.ts's runTimedRoleTick): a vet queued before the
   * hold must not start a reviewer mid-drain or into the storm. A held vet hands its permit
   * back and starts nothing; its entry stays queued for the next drain. */
  startHeld(): boolean;
}

/** Resolve a landing entry's authoring runner: the live runner when the role is enabled
 * (runners are never removed from the array on disable — only a warning event fires); a role
 * disabled before this process started has no runner, so a throwaway one supplies the same
 * wiring (loop-pi.ts, runLandingPi, foldLandingUsage) and a disk-loaded state to fold and save
 * on. Both share the live config, like every runner — the director keeps liveConfig (its
 * budget-gate exemption), every other role takes roleConfig. */
function resolveAuthor(ctx: LandingPipelineContext, role: string): LoopRunner {
  const { root, mainBranch, signal, runners, liveConfig, roleConfig } = ctx;
  return (
    runners.find((r) => r.role === role) ??
    new LoopRunner(root, role, role === DIRECTOR_ROLE ? liveConfig : roleConfig, mainBranch, signal)
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
  /** `sha` again when the gate's pre-check ran green on exactly it (VetVerdict). */
  verifiedHead?: string;
  /** When its vet started: its landed/land_failed event's durationMs runs from here. */
  startedAt: number;
  /** The authoring runner its vet ran with — reused by its merge, so both fold into one state. */
  author: LoopRunner;
  /** The landing's own spend so far (its reviewer), and the fold that adds to it. */
  usage: { tokens: number; cost: number };
  foldUsage(run: PiRunResult): void;
}

/** The scheduler's landing state across polls (land-queue speed 2c), in three parts:
 * - `vetting`: one task per queued change, in queue order, each in its own `_land-<role>`
 *   worktree — checkout, rebase onto main, gate check and review (vetRequest) — on a shared
 *   permit (a vet still waiting for its permit is `parked`). Any verdict but an approval writes
 *   its outcome at once and frees its author.
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
}

export function newLandingPipeline(): LandingPipeline {
  return { vetting: new Map(), vetted: new Map(), merge: null };
}

/** Every landing task in flight — each vet holding its permit, and the merge — for the shutdown
 * and restart waits. A parked vet is not one of them: it has started nothing, and a shutdown
 * (its controller) or a closed start gate (at its grant) settles it without a run. */
export function landingTasks(p: LandingPipeline): InFlightLanding[] {
  return [...[...p.vetting.values()].filter((v) => !v.parked), ...(p.merge ? [p.merge] : [])];
}

/** Everything `tumwater abort --role` can reach: every task in flight, plus each vetted change
 * waiting with no task of its own. A parked vet is out of reach, as a plainly queued entry
 * always was: its change has not started landing. */
export function abortableLandings(p: LandingPipeline): AbortableLanding[] {
  return [...landingTasks(p), ...p.vetted.values()];
}

/** Wire harness shutdown to one task's own controller — at once when it has already fired,
 * since a listener added after the event never runs. */
function abortOnShutdown(signal: AbortSignal, controller: AbortController): void {
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", () => controller.abort(), { once: true });
}

/** Take a permit at `tier` unless `signal` fires first: resolves to its release, or to null
 * when the signal won — a grant that arrives after that is handed straight back (a hop, never
 * a leak), so a parked vet that a shutdown settles holds nothing. */
async function acquireUnlessAborted(
  semaphore: Semaphore,
  tier: number,
  signal: AbortSignal,
): Promise<(() => void) | null> {
  if (signal.aborted) return null;
  const granted = semaphore.acquire(tier).then(() => true as const);
  const stopped = new Promise<false>((resolve) => signal.addEventListener("abort", () => resolve(false), { once: true }));
  if (await Promise.race([granted, stopped])) return () => semaphore.release();
  void granted.then(() => semaphore.release());
  return null;
}

/** The roles the pipeline holds right now — vetting (parked or not), vetted, or merging. */
function liveRoles(p: LandingPipeline): Set<string> {
  return new Set([...p.vetting.keys(), ...p.vetted.keys(), ...(p.merge?.roles ?? [])]);
}

/** One poll of the land queue (the scheduler's WHEN: after the gates, never while a restart or
 * a 429 hold is pending): start a vet for every queued change the pipeline does not already
 * hold (drainVetting), and start the merge when the slot is free and something is vetted
 * (drainMerge). A queued landing is COMMITTED work awaiting completion, not a new tick, so the
 * budget and user-pause gates deliberately do not hold it (pausing it would leave main behind
 * while the interlock blocks that role's next tick forever). Starts tasks and returns; never
 * awaits them — authors keep ticking behind them, which is the entire point. */
export async function drainLandings(ctx: LandingPipelineContext, p: LandingPipeline): Promise<void> {
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

/** How many vets may be in flight (parked or running) at once: every `maxConcurrent` permit but
 * one, so a deep land queue never takes the last slot from the roles that could author — at
 * least one, so `maxConcurrent` 1 still lands. The merge's short conflict-resolution run is not
 * counted: it is the one serial step every queued change waits on. */
export function vetLimit(maxConcurrent: number): number {
  return Math.max(1, maxConcurrent - 1);
}

/** Start a vet, in queue order, for every queued entry whose role the pipeline does not already
 * hold, up to vetLimit — the shared semaphore bounds how many of them run. The torn-head drop comes
 * first, and each entry is deduped against main before its vet starts: an entry whose sha main
 * already holds (a crash between the fast-forward and the drop) is dropped without a run, with
 * its marker record; a crash mid-vet leaves both entry and ref, so the entry is vetted again —
 * the established crash semantics. */
async function drainVetting(ctx: LandingPipelineContext, p: LandingPipeline): Promise<void> {
  dropTornHead(ctx.root);
  for (const { entry, file } of queuedLandingFiles(ctx.root)) {
    if (p.vetting.size >= vetLimit(ctx.semaphore.limit)) return;
    if (liveRoles(p).has(entry.role)) continue;
    if (await isMergedInto(ctx.root, entry.sha, ctx.mainBranch)) {
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
 * "error" outcome. Exported, with drainMerge, for test/util.ts's landHead, which lands one queue
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
        release(); // stopping, or a restart / 429 hold closed the gate while it waited
        return;
      }
      const { usage, foldUsage } = landingUsage(author);
      let verdict: VetVerdict;
      const startedAt = Date.now();
      try {
        addLandingChange(root, entry, liveRoles(p));
        verdict = await vetRequest(
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
        writeLandingOutcome(root, entry, author.state, result, Date.now() - startedAt, usage, file);
        removeLandingChange(root, role);
        if (vet.userAborted) await discardPinnedRefs(root, [role]);
      }
    } finally {
      p.vetting.delete(role);
    }
  })();
}

/** Start the merge when the slot is free and something is vetted: every vetted change, up to
 * landBatchMax, in queue order among the vetted — an unvetted entry ahead of them in the queue
 * (a slow review) does not hold them back. A vetted change whose queue entry is gone is
 * forgotten (nothing in-process drops one; defensive). */
export function drainMerge(ctx: LandingPipelineContext, p: LandingPipeline): void {
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
}

/** The merge task — main's one writer in the pipeline: land `picks` through landVetted on
 * main's current tip — one change through landApprovedChange, two or more as one stack with one
 * scope-`batch` check, one fast-forward, and 3d's largest-passing-prefix bisect — with no second
 * review. A vetted change whose main moved since its vet is re-checked on the tree that lands
 * (the in-lock re-check, or the stack's check), so an approval that outlived its base never
 * lands unverified. Each defined result is written back and its entry dropped; an unattempted
 * change (behind a bisect's attributed one) goes back to `vetted` for the next merge. A plumbing
 * throw keeps every entry queued, but un-vetted: each is vetted afresh from its pin next poll. A
 * user abort of any merged role stops the whole stack, and every change it had not landed ends
 * "aborted" with its pin discarded; a shutdown keeps the pins. The task takes no permit of its
 * own — its only model run is mergeToMain's conflict resolver, which takes a shared permit at
 * MERGE_TIER for the run's length, outside the merge lock. */
function startMerge(ctx: LandingPipelineContext, p: LandingPipeline, picks: VettedLanding[]): InFlightLanding {
  const { root, mainBranch, signal, roleConfig, semaphore } = ctx;
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
          await semaphore.acquire(MERGE_TIER);
          try {
            return await v.author.runLandingPi(w, prompt, s);
          } finally {
            semaphore.release();
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
          onChangeStatus: (role, status) => setLandingChangeStatus(root, role, status),
        },
        picks.map((v) => ({
          role: v.entry.role,
          sha: v.sha,
          tick: v.entry.tick,
          summary: v.entry.summary,
          body: v.entry.body,
          highFriction: v.entry.highFriction,
          ...(v.verifiedHead !== undefined ? { verifiedHead: v.verifiedHead } : {}),
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
