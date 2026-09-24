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
 * resets that worktree to main, and queues the sha for the ORCHESTRATOR's landing pipeline
 * (landing-drain.ts, merge queue 3/5 and land-queue speed 2c), which checks it out detached in
 * the role's own `_land-<role>` worktree and runs it through the review gate here
 * (reviewPinnedChange, from land-batch.ts's vetRequest) and then the landing
 * (landApprovedChange, from its merge) — so no diff reaches main unreviewed (invariant 1) and
 * nothing is rebased inside a role worktree any more. Leftover recovery re-queues its pin onto
 * that same pipeline. This is harness code, never a role: the only model runs it starts are the
 * reviewer and merge.ts's conflict resolver. */

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
  /** The head its vet's gate pre-check ran green on, when it ran one on exactly `sha`
   * (GateResult.verifiedHead, carried by land-batch.ts's VetVerdict) — so a landing whose
   * in-lock rebase is a no-op seeds the red-main baseline with the SHA that becomes main. */
  verifiedHead?: string;
}

/** What a landing needs from its owning loop: identity, config, the live state object (the
 * gate updates it in place exactly as when it ran inside runTick), the loop's shared pi wiring
 * for merge.ts's conflict resolver — which folds usage internally — an explicit foldUsage for
 * the reviewer run (reviewAheadOfMain starts its own raw pi call and returns it as `gate.run`),
 * and the landing's abort signal, captured per call. */
export interface LanderContext {
  root: string;
  mainBranch: string;
  config: TumwaterConfig;
  state: LoopState;
  /** Run one pi run in `wt` with the loop's shared wiring and fold its usage into the tick. */
  runPi(wt: string, prompt: string, sessionName: string): Promise<PiRunResult>;
  /** Fold one pi run's usage into the tick's counters (the reviewer's run). */
  foldUsage(run: PiRunResult): void;
  /** The landing's abort signal (harness shutdown or user abort), fresh per call. */
  signal(): AbortSignal;
}

/** A gate invocation's outcome: `gate` when the change is approved/exempt and may be landed
 * (`sha` is the head to land — the pin as the gate judged it), `result` when it is already terminal (aborted, rejected, or review_error).
 * `discarded` tells a strike-cap review_error (ref deleted — as final as a rejection) from an
 * under-cap one (ref kept for recovery). */
type GateOutcome =
  | { kind: "gate"; gate: GateResult; sha: string }
  | { kind: "result"; result: TickResult; discarded?: true };

/** The identity every gate invocation needs from its caller — land-batch.ts's BatchContext
 * (and LanderContext) satisfies it, so the gate never hand-assembles a nine-field argument
 * object. */
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
 * detached pin — the gate reviews the pinned tree and mergeToMain's resolver lands it. Every
 * vet runs it before its gate (land-batch.ts's vetRequest), so a gate never judges a stale
 * pin; each call rebases only its own worktree, onto main itself — never onto another queued
 * change — so concurrent vets in distinct lander worktrees cannot interfere. */
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
 * immediate bookkeeping — the heart of every vet (land-batch.ts's vetRequest). Persists the
 * verdict at once, folds the reviewer's usage, and routes
 * the three terminal outcomes: aborted (ref kept — fail closed, the next tick re-lands it),
 * rejected (ref deleted — final for this sha), and failed (a strike-cap discard — the gate
 * reports it as `discarded` — deletes the ref; an under-cap failure, a red main's included,
 * keeps it for the next re-land). Returns
 * the gate result only when the change may be landed, alongside the head to land it at. An
 * abort that has already fired is observed HERE, before the gate starts, not only by the
 * gate's pi runs: a gate that short-circuits on an already-approved head (a re-vetted change's)
 * runs no pi at all, and one that does still spends its build pre-check first — so a stopping
 * landing (a restart hand-off past its deadline, BUGS.md 2026-09-23) would otherwise sail
 * through its gate into the check. */
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
  // outside a queued landing). What follows is the wait for the merge, and a finished
  // reviewer's last turns left in the cell would accrue a false `no pi output` flag for as long
  // as the change waits.
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
 * failure, or a merge that could not be rebased/landed. They are exactly a landing's
 * non-terminal failures (`rejected` is final and deletes the pin; `aborted` is a shutdown;
 * `changed` landed), so a run of them on the leftover-recovery path is what feeds the error
 * streak — a dead reviewer backend raises the alarm instead of resetting it every tick
 * (BUGS.md 2026-09-21). */
export const RETRIABLE_LANDING_RESULTS: ReadonlySet<TickResult> = new Set([
  "review_error",
  "merge_conflict",
  "merge_blocked",
]);

/** Land a head that already passed its OWN gate in its vet — the merge slot's one-change landing
 * and each landing of an abandoned stack's one-at-a-time fallback (land-batch.ts's landVetted)
 * — without a second gate. Re-gating would rebase first, and by then main has usually moved (a
 * fallback's earlier entries just landed): the rebase rewrites the approved sha, the gate's
 * exact-sha `lastApprovedHead` short-circuit misses, and every such landing paid a second build
 * check and model review of a change it had already approved (BUGS.md 2026-09-23). Here a clean
 * rebase of the approved head is accepted as-is: mergeToMain's own in-lock rebase moves it onto
 * main's tip, and because the pre-merge head it captures is the approved `req.sha`,
 * verifyLanding runs one bounded scope-`landing` check whenever that rebase rewrote anything
 * (and skips only for the exact bytes the gate judged, seeding the red-main baseline when
 * `req.verifiedHead` names them). A conflicting rebase gets mergeToMain's resolver — the rule for
 * a pin whose pre-gate rebase conflicted. `lastApprovedHead` is neither read nor widened: the
 * caller vouches for `req.sha` (only approved/exempt changes are vetted). Owns the landing ref's
 * lifecycle from here: deleted on landing, KEPT on every non-terminal outcome (aborted,
 * merge_conflict, merge_blocked) for the next tick's leftover recovery. An abort that has
 * already fired returns "aborted" before anything starts, ref kept — the merge's step-boundary
 * stop (BUGS.md 2026-09-23): with no gate here, nothing else on this path would notice it
 * before the in-lock check and the merge. Never throws for a failed landing: git-level failures
 * propagate like any other failure. */
export async function landApprovedChange(ctx: LanderContext, req: LandRequest): Promise<TickResult> {
  if (ctx.signal().aborted) return "aborted";
  const wt = await ensureDetachedWorktree(ctx.root, landWorktreePath(ctx.root, req.role), req.sha);
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
    req.verifiedHead,
  );
  if (result === "changed") {
    await deleteRef(ctx.root, landingRefName(req.role)); // landed: the pin has done its job
  } else {
    // merge_conflict / merge_blocked: keep the ref — the next tick's recovery re-lands it.
    ctx.state.lastError = `merge failed: ${result}`;
  }
  return result;
}
