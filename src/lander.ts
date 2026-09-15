import { deleteRef, headOf } from "./git.js";
import { landWorktreePath, landingRefName } from "./paths.js";
import { ensureDetachedWorktree } from "./worktree.js";
import { mergeToMain } from "./merge.js";
import { reviewAheadOfMain } from "./review.js";
import { saveLoopState } from "./state.js";
import type { LoopState, PiRunResult, TickResult, TumwaterConfig } from "./types.js";

/** Reviewing and landing a pinned commit outside the author's worktree (plans/merge-queue.md,
 * entry 2/5). A tick commits in its role worktree, pins the sha by `refs/tumwater/landing/<role>`,
 * resets that worktree to main, and hands the sha here: landChange checks it out detached in the
 * role's own `_land-<role>` worktree and runs the SAME review gate and landing flow every other
 * path uses — so no diff reaches main unreviewed (invariant 1) and nothing is rebased inside a
 * role worktree any more. Since merge queue 3/5 the fresh-tick path calls this from the
 * ORCHESTRATOR's landing slot (its drain of the durable land queue, outside the author
 * semaphore); the leftover-recovery path still calls it inside the tick. This is harness code,
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
  /** The author's claimed WHY/RISK/VERIFIED — the reviewer checks it against the diff. Absent
   * on recovery landings: the original run is gone. */
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

/** Review and land `req.sha` in this role's lander worktree, returning the same TickResult
 * values a tick returns today — so state.ts, the dashboards, and the event feed need no change.
 * Owns the landing ref's full lifecycle: deleted on every terminal outcome (landed, rejected,
 * strike-cap discard) and deliberately KEPT on every non-terminal one (aborted, under-cap
 * review_error, merge_conflict, merge_blocked) — those are exactly what the next tick's leftover
 * recovery re-lands through this same gate. Never throws for a failed landing: git-level
 * failures propagate as errors like any other tick failure. */
export async function landChange(ctx: LanderContext, req: LandRequest): Promise<TickResult> {
  const ref = landingRefName(req.role);
  // The role's own worktree is already clean at main (its caller pinned the sha and reset it);
  // this detached checkout holds exactly the pinned tree for review and rebase.
  const wt = await ensureDetachedWorktree(ctx.root, landWorktreePath(ctx.root, req.role), req.sha);

  const gate = await reviewAheadOfMain(
    {
      root: ctx.root,
      role: req.role,
      wt,
      mainBranch: ctx.mainBranch,
      config: ctx.config,
      tick: req.tick,
      sessionSuffix: req.sessionSuffix,
      signal: ctx.signal(),
    },
    ctx.state,
    req.summary,
    req.body,
    req.highFriction,
  );
  // Persist the verdict immediately, not at the tick's end save: the gate's bookkeeping is
  // cross-tick memory (a persisted "reject" injects a "your previous change was rejected"
  // note into the next prompt), and this tick's tail — the landing plus the still-to-come
  // authoring run — can outlive a sudden death by hours. A mid-run crash (power loss,
  // kill -9) would otherwise roll the state file back to the last tick-boundary snapshot
  // and re-inject a superseded rejection even though its replacement is already on main.
  saveLoopState(ctx.root, ctx.state);
  if (gate.run) ctx.foldUsage(gate.run);

  // Shutdown/user abort mid-review: fail closed — the ref stays and the next tick re-lands it.
  // The caller routes "aborted" through its own abort handling (which discards the pin too when
  // the abort was a deliberate user stop).
  if (gate.aborted) return "aborted";

  if (gate.decision === "rejected") {
    // The gate already reset this worktree to main; the verdict is final for this sha.
    await deleteRef(ctx.root, ref);
    return "rejected";
  }

  if (gate.decision === "failed") {
    ctx.state.lastError = `review failed: ${gate.detail}`;
    // Strike-cap discard is invisible in GateResult — the same shape as an under-cap failure.
    // The tell is the worktree itself: past REVIEW_FAILURE_LIMIT the gate reset it off the pin,
    // so a HEAD that moved away from req.sha means the commit was discarded and the ref goes too.
    // An unreadable head keeps the ref (fail closed): the next tick re-lands through this gate.
    const head = await headOf(wt, "HEAD").catch(() => null);
    if (head !== null && head !== req.sha) await deleteRef(ctx.root, ref);
    return "review_error";
  }

  // Approved or exempt: land it. verifiedHead is the tree this gate's pre-check just ran green
  // on — when the rebase turns out to be a no-op it names the exact tree about to land, so the
  // in-lock re-check skips and seeds the red-main baseline with the SHA that becomes main; when
  // main moved under the landing, verifyLanding runs one bounded scope-`landing` check instead.
  const result = await mergeToMain(
    {
      root: ctx.root,
      role: req.role,
      mainBranch: ctx.mainBranch,
      exemptPaths: ctx.config.review.exemptPaths,
      tick: req.tick,
      runPi: ctx.runPi,
    },
    wt,
    req.summary,
    gate.verifiedHead,
  );
  if (result === "changed") {
    await deleteRef(ctx.root, ref); // landed: the pin has done its job
  } else {
    // merge_conflict / merge_blocked: keep the ref — the next tick's recovery re-lands it.
    ctx.state.lastError = `merge failed: ${result}`;
  }
  return result;
}
