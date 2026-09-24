import { deleteRef, headOf, setRef } from "./git.js";
import { landWorktreePath, landingRefName } from "./paths.js";
import { ensureDetachedWorktree } from "./worktree.js";
import { mergeToMain, rebaseOntoMain } from "./merge.js";
import { reviewAheadOfMain, type GateResult } from "./review.js";
import { saveLoopState } from "./state.js";
import { setLandingStage } from "./landing-slot.js";
import type { TumwaterConfig } from "./config-schema.js";
import type { LoopState, PiRunResult, TickResult } from "./types.js";

/** Reviewing and landing a pinned commit outside the author's worktree (plans/merge-queue.md,
 * entry 2/5). A tick commits in its role worktree, pins the sha by `refs/tumwater/landing/<role>`,
 * resets that worktree to main, and hands the sha here: landChange checks it out detached in the
 * role's own `_land-<role>` worktree and runs the SAME review gate and landing flow every other
 * path uses — so no diff reaches main unreviewed (invariant 1) and nothing is rebased inside a
 * role worktree any more. Since merge queue 3/5 the fresh-tick path calls this from the
 * ORCHESTRATOR's landing slot (its drain of the durable land queue, outside the author
 * semaphore), and leftover recovery re-queues its pin onto that same slot. This is harness code,
 * never a role: the only model runs it starts are the reviewer and
 * merge.ts's conflict resolver. */

/** One landing request: a pinned commit plus everything its gate and events need. `role` names
 * the owning loop (events, session naming, lander worktree) — the lander itself is not a role. */
export interface LandRequest {
  role: string;
  /** The pinned commit to land — checked out detached in this role's lander worktree. */
  sha: string;
  /** Current tick number, for the unique per-run session names (review + conflict resolution). */
  tick: number;
  summary: string;
  /** The author's claimed WHY/RISK/VERIFIED — the reviewer checks it against the diff. On a
   * recovery landing these are read back from the pinned commit's message (the authoring run
   * is gone); a hand-made or pre-contract commit has none. */
  body?: string;
  highFriction?: boolean;
  /** Suffix for the review session name — recovery landings pass "-recovery" so a tick's own
   * gate and its recovery re-review (both numbered by the same tick) never collide. */
  sessionSuffix?: string;
}

/** What landChange needs from its owning loop: identity, config, the live state object (the
 * gate updates it in place exactly as when it ran inside runTick), the loop's shared pi wiring
 * for merge.ts's conflict resolver — which folds usage internally — an explicit foldUsage for
 * the reviewer run (reviewAheadOfMain starts its own raw pi call and returns it as `gate.run`),
 * and the tick's abort signal, captured per call like the old in-loop gate did. */
export interface LanderContext {
  root: string;
  mainBranch: string;
  config: TumwaterConfig;
  state: LoopState;
  /** Run one pi run in `wt` with the loop's shared wiring and fold its usage into the tick. */
  runPi(wt: string, prompt: string, sessionName: string): Promise<PiRunResult>;
  /** Fold one pi run's usage into the tick's counters (the reviewer's run). */
  foldUsage(run: PiRunResult): void;
  /** The current tick's abort signal (harness shutdown or user abort), fresh per call. */
  signal(): AbortSignal;
}

/** A gate invocation's outcome: `gate` when the change is approved/exempt and may be landed
 * (`sha` is the head to land — the pin as the gate judged it), `result` when it is already terminal (aborted, rejected, or review_error).
 * `discarded` tells a strike-cap review_error (ref deleted — as final as a rejection) from an
 * under-cap one (ref kept for recovery): the batch reports only final verdicts to its drain
 * mid-batch (land-batch.ts, BatchContext.onFinal). */
type GateOutcome =
  | { kind: "gate"; gate: GateResult; sha: string }
  | { kind: "result"; result: TickResult; discarded?: true };

/** The identity every gate invocation needs from whichever landing path calls it. The
 * single-change path's LanderContext and the batch's BatchContext both satisfy this, so one
 * positional call shape serves both — the two paths no longer hand-assemble the same
 * nine-field argument object, keeping it in sync by hand. */
interface ReviewGateContext {
  root: string;
  mainBranch: string;
  config: TumwaterConfig;
  signal(): AbortSignal;
}

/** Rebase a pinned change's lander worktree `wt` (checked out detached at `req.sha`) onto
 * main's CURRENT head before its review gate, and return the request that gate must judge.
 * The gate must review main's current tree, not the main the author started from: when main
 * moved after the pin (the common queued-landing case), a pre-check against the stale tree
 * fails on a failure main already fixed and every queued landing rejects in a cascade — and a
 * reviewer whose checkout is behind main reads main's newer commits as the change deleting
 * them (BUGS.md 2026-09-23: d13cf2e, a sound feature, rejected for "reverting" five commits
 * that landed after its pin). A no-op when main has not moved; on a clean rebase the ref and
 * the request track the synced head so the strike-cap tell and the landing ref name the tree
 * that can actually land. On a conflict rebaseOntoMain has already aborted and restored the
 * detached pin — the gate reviews the pinned tree and mergeToMain's resolver lands it. Both
 * gate callers run it (landChange, and the batch's Phase A), so a gate never judges a stale
 * pin; each call rebases only its own worktree, onto main itself — never onto another queued
 * change — so concurrent gates in distinct lander worktrees cannot interfere. */
export async function syncPinToMain(
  ctx: Pick<ReviewGateContext, "root" | "mainBranch">,
  wt: string,
  req: LandRequest,
): Promise<LandRequest> {
  if (!(await rebaseOntoMain(wt, ctx.mainBranch))) return req;
  const syncedHead = await headOf(wt, "HEAD");
  if (syncedHead === req.sha) return req;
  await setRef(ctx.root, landingRefName(req.role), syncedHead);
  return { ...req, sha: syncedHead };
}

/** Run one pinned change through the review gate in its lander worktree `wt` and handle the
 * immediate bookkeeping both landing paths otherwise copy — the single-change path (landChange)
 * and the batch's Phase A. Persists the verdict at once, folds the reviewer's usage, and routes
 * the three terminal outcomes: aborted (ref kept — fail closed, the next tick re-lands it),
 * rejected (ref deleted — final for this sha), and failed (a strike-cap discard — the gate
 * reports it as `discarded` — deletes the ref; an under-cap failure, a red main's included,
 * keeps it for the next re-land). Returns
 * the gate result only when the change may be landed, alongside the head to land it at. An
 * abort that has already fired is observed HERE, before the gate starts, not only by the
 * gate's pi runs: a gate that short-circuits on an already-approved head (a re-drained batch's)
 * runs no pi at all, and one that does still spends its build pre-check first — so a stopping
 * landing (a restart hand-off past its deadline, BUGS.md 2026-09-23) would otherwise sail
 * through those gates into their checks and merges. */
export async function reviewPinnedChange(
  ctx: ReviewGateContext,
  req: LandRequest,
  wt: string,
  state: LoopState,
  foldUsage: (run: PiRunResult) => void,
): Promise<GateOutcome> {
  const { root, mainBranch, config } = ctx;
  const { role } = req;
  const ref = landingRefName(role);
  // Already stopping: the gate never starts, so nothing is persisted or folded — the ref stays
  // (fail closed) exactly as for an abort mid-review below.
  if (ctx.signal().aborted) return { kind: "result", result: "aborted" };
  const gate = await reviewAheadOfMain(
    { root, role, wt, mainBranch, config, tick: req.tick, sessionSuffix: req.sessionSuffix, signal: ctx.signal() },
    state,
    req.summary,
    req.body,
    req.highFriction,
  );
  // The gate is over, whatever it decided: move the landing cell off the gate's stages (a no-op
  // outside a queued landing). What follows is the merge, or — mid-batch — the other changes'
  // gates, and a finished reviewer's last turns left in the cell would accrue a false
  // `no pi output` flag for as long as the batch runs on.
  setLandingStage(root, role, "merging");
  // Persist the verdict immediately, not at the tick's end save: the gate's bookkeeping is
  // cross-tick memory (a persisted "reject" injects a "your previous change was rejected"
  // note into the next prompt), and this tick's tail — the landing plus the still-to-come
  // authoring run — can outlive a sudden death by hours. A mid-run crash (power loss,
  // kill -9) would otherwise roll the state file back to the last tick-boundary snapshot
  // and re-inject a superseded rejection even though its replacement is already on main.
  saveLoopState(root, state);
  if (gate.run) foldUsage(gate.run);

  // Shutdown/user abort mid-review: fail closed — the ref stays and the next tick re-lands it.
  // The caller routes "aborted" through its own abort handling (which discards the pin too when
  // the abort was a deliberate user stop).
  if (gate.aborted) return { kind: "result", result: "aborted" };

  if (gate.decision === "rejected") {
    // The gate already reset this worktree to main; the verdict is final for this sha.
    await deleteRef(root, ref);
    return { kind: "result", result: "rejected" };
  }

  if (gate.decision === "failed" && gate.mainRed) {
    // Main is red at its tip: nothing judged this diff and nothing is wrong with the reviewer,
    // so it is main_red, not review_error — the pin stays for a re-land once main is green.
    state.lastError = `gate check failed: ${gate.detail}`;
    return { kind: "result", result: "main_red" };
  }

  if (gate.decision === "failed") {
    state.lastError = `review failed: ${gate.detail}`;
    // Strike-cap discard: the gate says so directly (it reset the worktree off the pin) — the
    // commit is gone and the ref goes too. An under-cap failure — a dead reviewer — keeps the
    // pin as it is: the gate never commits, so the pin still names the tree the next re-land
    // reviews.
    if (gate.discarded) {
      await deleteRef(root, ref);
      return { kind: "result", result: "review_error", discarded: true };
    }
    return { kind: "result", result: "review_error" };
  }

  // Approved or exempt: track the pin to the head the verdict judged, so a merge that cannot
  // finish (conflict/blocked) leaves recovery re-landing that tree, not a stale pin.
  // verifiedHead carries it when the pre-check ran green; otherwise the worktree head does. An
  // unreadable head keeps the old pin (fail closed).
  const sha = gate.verifiedHead ?? (await headOf(wt, "HEAD").catch(() => req.sha));
  if (sha !== req.sha) {
    await setRef(root, ref, sha);
    req = { ...req, sha };
  }
  return { kind: "gate", gate, sha };
}

/** The failed landing outcomes that KEEP the pin for another attempt: an under-cap review
 * failure, or a merge that could not be rebased/landed. They are exactly landChange's
 * non-terminal failures (`rejected` is final and deletes the pin; `aborted` is a shutdown;
 * `changed` landed), so a run of them on the leftover-recovery path is what feeds the error
 * streak — a dead reviewer backend raises the alarm instead of resetting it every tick
 * (BUGS.md 2026-09-21). */
export const RETRIABLE_LANDING_RESULTS: ReadonlySet<TickResult> = new Set([
  "review_error",
  "merge_conflict",
  "merge_blocked",
]);

/** Review and land `req.sha` in this role's lander worktree, returning the same TickResult
 * values a tick returns today — so state.ts, the dashboards, and the event feed need no change.
 * Owns the landing ref's full lifecycle: deleted on every terminal outcome (landed, rejected,
 * strike-cap discard) and deliberately KEPT on every non-terminal one (aborted, under-cap
 * review_error, merge_conflict, merge_blocked) — those are exactly what the next tick's leftover
 * recovery re-lands through this same gate. Never throws for a failed landing: git-level
 * failures propagate as errors like any other tick failure. */
export async function landChange(ctx: LanderContext, req: LandRequest): Promise<TickResult> {
  // The role's own worktree is already clean at main (its caller pinned the sha and reset it);
  // this detached checkout holds exactly the pinned tree for review and rebase.
  const wt = await ensureDetachedWorktree(ctx.root, landWorktreePath(ctx.root, req.role), req.sha);
  req = await syncPinToMain(ctx, wt, req);

  const outcome = await reviewPinnedChange(ctx, req, wt, ctx.state, ctx.foldUsage);
  // A terminal outcome (aborted / rejected / review_error) is already handled: the helper kept
  // or deleted the ref per policy. The caller routes "aborted" through its own abort handling
  // (which discards the pin too when the abort was a deliberate user stop).
  if (outcome.kind === "result") return outcome.result;

  // Approved or exempt: land it. verifiedHead is the tree this gate's pre-check just ran green
  // on — when the rebase turns out to be a no-op it names the exact tree about to land, so the
  // in-lock re-check skips and seeds the red-main baseline with the SHA that becomes main; when
  // main moved under the landing, verifyLanding runs one bounded scope-`landing` check instead.
  return landOnMain(ctx, wt, req, outcome.gate.verifiedHead);
}

/** Land a head that already passed its OWN gate earlier in the same batch — landBatch's
 * stack entries, on its one-change path and its one-at-a-time fallback — without a second
 * gate. landChange would rebase first, and by then main has usually moved (the fallback's
 * earlier entries just landed): the rebase rewrites the approved sha, the gate's exact-sha
 * `lastApprovedHead` short-circuit misses, and every fallback paid a second build check and
 * model review of a change it had already approved (BUGS.md 2026-09-23). Here a clean rebase
 * of the approved head is accepted as-is: mergeToMain's own in-lock rebase moves it onto
 * main's tip, and because the pre-merge head it captures is the approved `req.sha`,
 * verifyLanding runs one bounded scope-`landing` check whenever that rebase rewrote anything
 * (and skips only for the exact bytes the gate judged). A conflicting rebase gets
 * mergeToMain's resolver — what landChange does for a pin whose pre-gate rebase conflicted.
 * `lastApprovedHead` is neither read nor widened: the caller vouches for `req.sha` (only
 * approved/exempt changes enter a batch's stack). Same ref lifecycle and TickResults as
 * landChange's landing half. An abort that has already fired returns "aborted" before anything
 * starts, ref kept — the batch's step-boundary stop (BUGS.md 2026-09-23): with no gate here,
 * nothing else on this path would notice it before the in-lock check and the merge. */
export async function landApprovedChange(ctx: LanderContext, req: LandRequest): Promise<TickResult> {
  if (ctx.signal().aborted) return "aborted";
  const wt = await ensureDetachedWorktree(ctx.root, landWorktreePath(ctx.root, req.role), req.sha);
  return landOnMain(ctx, wt, req);
}

/** The landing half shared by landChange and landApprovedChange once a head may land:
 * mergeToMain from the lander worktree, then the ref lifecycle — deleted on landing, KEPT on
 * merge_conflict / merge_blocked (with lastError) so the next tick's recovery re-lands it.
 * `verifiedHead` is the head a gate pre-check just ran green on, if any (see mergeToMain). */
async function landOnMain(
  ctx: LanderContext,
  wt: string,
  req: LandRequest,
  verifiedHead?: string,
): Promise<TickResult> {
  const result = await mergeToMain(
    {
      root: ctx.root,
      role: req.role,
      mainBranch: ctx.mainBranch,
      exemptPaths: ctx.config.review.exemptPaths,
      config: ctx.config,
      tick: req.tick,
      runPi: ctx.runPi,
    },
    wt,
    req.summary,
    verifiedHead,
  );
  if (result === "changed") {
    await deleteRef(ctx.root, landingRefName(req.role)); // landed: the pin has done its job
  } else {
    // merge_conflict / merge_blocked: keep the ref — the next tick's recovery re-lands it.
    ctx.state.lastError = `merge failed: ${result}`;
  }
  return result;
}
