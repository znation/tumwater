import { COMMIT_IDENT, deleteRef, gitTry, headOf } from "./git.js";
import { landWorktreePath, landingRefName } from "./paths.js";
import { ensureDetachedWorktree } from "./worktree.js";
import { ffStackToMain, mergeToMain } from "./merge.js";
import { reviewAheadOfMain, type GateResult } from "./review.js";
import { runScopedBuildCheck } from "./build-check.js";
import { noteGreenBaseline } from "./main-baseline.js";
import { saveLoopState } from "./state.js";
import { errorMessage } from "./text.js";
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

/** A gate invocation's outcome: `gate` when the change is approved/exempt and may be landed,
 * `result` when it is already terminal (aborted, rejected, or review_error). */
type GateOutcome = { kind: "gate"; gate: GateResult } | { kind: "result"; result: TickResult };

/** Run one pinned change through the review gate in its lander worktree `wt` and handle the
 * immediate bookkeeping both landing paths otherwise copy — the single-change path (landChange)
 * and the batch's Phase A. Persists the verdict at once, folds the reviewer's usage, and routes
 * the three terminal outcomes: aborted (ref kept — fail closed, the next tick re-lands it),
 * rejected (ref deleted — final for this sha), and failed (ref kept under the failure cap; past
 * the cap the gate reset the worktree off the pin, so a HEAD that moved away from `req.sha`
 * means the commit was discarded and the ref goes too — an unreadable head keeps it). Returns
 * the gate result only when the change may be landed. */
async function reviewPinnedChange(args: {
  root: string;
  mainBranch: string;
  config: TumwaterConfig;
  role: string;
  wt: string;
  req: LandRequest;
  state: LoopState;
  signal: AbortSignal;
  foldUsage(run: PiRunResult): void;
}): Promise<GateOutcome> {
  const { root, mainBranch, config, role, wt, req, state, signal, foldUsage } = args;
  const ref = landingRefName(role);
  const gate = await reviewAheadOfMain(
    { root, role, wt, mainBranch, config, tick: req.tick, sessionSuffix: req.sessionSuffix, signal },
    state,
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

  if (gate.decision === "failed") {
    state.lastError = `review failed: ${gate.detail}`;
    // Strike-cap discard is invisible in GateResult — the same shape as an under-cap failure.
    // The tell is the worktree itself: past REVIEW_FAILURE_LIMIT the gate reset it off the pin,
    // so a HEAD that moved away from req.sha means the commit was discarded and the ref goes too.
    // An unreadable head keeps the ref (fail closed): the next tick re-lands through this gate.
    const head = await headOf(wt, "HEAD").catch(() => null);
    if (head !== null && head !== req.sha) await deleteRef(root, ref);
    return { kind: "result", result: "review_error" };
  }

  return { kind: "gate", gate };
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

  const outcome = await reviewPinnedChange({
    root: ctx.root,
    mainBranch: ctx.mainBranch,
    config: ctx.config,
    role: req.role,
    wt,
    req,
    state: ctx.state,
    signal: ctx.signal(),
    foldUsage: ctx.foldUsage,
  });
  // A terminal outcome (aborted / rejected / review_error) is already handled: the helper kept
  // or deleted the ref per policy. The caller routes "aborted" through its own abort handling
  // (which discards the pin too when the abort was a deliberate user stop).
  if (outcome.kind === "result") return outcome.result;
  const gate = outcome.gate;

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

/** The identity a batch needs from the harness: root, main branch, live config, and the
 * slot's abort signal. Deliberately thinner than LanderContext — no single `state` and no
 * `runPi`, because a batch spans N ROLES (invariant 3 caps a role at one in-flight change, so
 * a stack is N changes from N distinct roles) and each one carries its own wiring. */
export interface BatchContext {
  root: string;
  mainBranch: string;
  config: TumwaterConfig;
  /** The slot's abort signal (harness shutdown or a deliberate `abort --role` for any
   * batched role), fresh per call. */
  signal(): AbortSignal;
}

/** One batched change's wiring, resolved by the drain exactly as the landed drain resolves
 * its author: the live state object the gate updates and the drain folds the outcome into,
 * this role's usage fold (reviewer spend charges to the authoring role), and the role's
 * shared pi wiring for landChange's conflict resolver on the one-at-a-time paths. */
export interface BatchRoleWiring {
  state: LoopState;
  /** Fold one pi run's usage into this role's landing counters (the reviewer's run). */
  foldUsage(run: PiRunResult): void;
  /** Run one pi run in `wt` with this role's shared wiring (the fallback landings' conflict resolver). */
  runPi(wt: string, prompt: string, sessionName: string): Promise<PiRunResult>;
}

/** Land a whole batch of queued changes (plans/merge-queue.md, entry 5/5): stop paying one
 * full build check per landing when several are queued. The flow:
 *
 * Phase A — for each request in queue order, the SAME review gate landChange runs, in that
 * role's own `_land-<role>` worktree, with the verdict persisted right after (a mid-batch
 * crash must not lose what the batch earned). approved/exempt → into the stack S; rejected →
 * terminal (ref deleted), continue; failed → stop (this request "review_error", the ref goes
 * only on landChange's strike-cap tell, the rest stay unattempted); aborted (a shutdown
 * mid-gate or a quiet-killed reviewer run) → every request without a terminal outcome reads
 * "aborted" and keeps its ref. |S| == 0 means nothing was approved — all results are already
 * defined (or unattempted after an early stop) and there is nothing to land: return as-is.
 *
 * |S| == 1 — land it through landChange (the gate short-circuits the already-approved head,
 * so this costs git + ff only): the degenerate case is 2/5's single path byte-for-byte, which
 * is what makes landBatchMax=1 reproduce 3/5 exactly.
 *
 * |S| >= 2 — assemble the stack in S[0]'s lander worktree, checked out detached at main's
 * CURRENT tip, then cherry-pick every S sha in queue order onto it (head included),
 * capturing each post-pick sha — one check over the combined tree, one fast-forward through
 * those captured shas. ONE scope-`batch` runScopedBuildCheck over the combined tree
 * — the expensive, deterministic half the batch shares (the model review already ran per
 * change in Phase A, because an adversarial review of a stack would blur which change a
 * criticism applies to). null (no declared check) → land directly; "failed" (a red tree or a
 * timeout remapped to a reject — the tree is unverified) → abandon; "skipped" (no npm /
 * broken toolchain — the helper already warned) → proceed, never fail-closed; "passed" → green. Green: under the merge lock, ffStackToMain ff's
 * main through the stack in ONE fast-forward, emits one `merged` event per change, and —
 * only when the check PASSED — the lander seeds noteGreenBaseline with the stacked tip (the
 * exact future main head). ff failure → every S change keeps its ref with "merge_blocked"
 * and nothing is seeded: leftover recovery re-lands each one through its own gate + tryMerge,
 * which carries the in-lock check.
 *
 * Red or un-assemblable (a cherry-pick conflict) → ABANDON to one-at-a-time, not
 * blame-the-batch: every approved change lands through landChange in queue order, stopping
 * at the first non-terminal outcome (the rest keep entry + ref and re-drain). Each fallback
 * gate short-circuits on `state.lastApprovedHead === head` — the short-circuit covers only
 * APPROVED heads, so a fallback for a change Phase A never approved would re-review (that
 * cannot happen inside one batch: only approved/exempt changes enter S); a fallback whose
 * base moved under it since its Phase A gate pays one bounded scope-`landing` check in-lock.
 * main is never left red: the only bytes this path ff's are the checked tip or per-change
 * landings re-verified by their own gate.
 *
 * One entry per request comes back in order; `result === undefined` means "unattempted — the
 * drain keeps that queue entry" (a failed Phase-A gate or a fallback early stop), and a
 * defined result drops its entry through the drain's write-back. Never throws for a failed
 * landing: per-change landChange failures degrade to "error" results; git-level failures
 * from the assembly/ff plumbing propagate like any other tick failure (the drain's catch
 * keeps every entry for re-drain). */
export async function landBatch(
  ctx: BatchContext,
  requests: LandRequest[],
  wiringFor: (role: string) => BatchRoleWiring,
): Promise<Array<{ req: LandRequest; result?: TickResult }>> {
  const results = requests.map((req) => ({ req, result: undefined as TickResult | undefined }));
  const wiringCache = new Map<string, BatchRoleWiring>();
  const wiringForRole = (role: string): BatchRoleWiring => {
    let w = wiringCache.get(role);
    if (!w) {
      w = wiringFor(role);
      wiringCache.set(role, w);
    }
    return w;
  };
  const landerCtx = (w: BatchRoleWiring): LanderContext => ({
    root: ctx.root,
    mainBranch: ctx.mainBranch,
    config: ctx.config,
    state: w.state,
    runPi: w.runPi,
    foldUsage: w.foldUsage,
    signal: ctx.signal,
  });
  // An abort anywhere in the batch (Phase A or the fallback) routes every request without a
  // terminal outcome to "aborted" — refs kept, entries dropped by the drain — at the end.
  let aborted = false;
  const finishAborted = (): void => {
    if (aborted) {
      for (const r of results) {
        if (r.result === undefined) r.result = "aborted";
      }
    }
  };

  // ── Phase A: the per-change review gate, in queue order ────────────────────────────────
  const stack: number[] = []; // request indices of the approved/exempt changes, queue order
  for (let i = 0; i < requests.length; i++) {
    const req = requests[i]!;
    const w = wiringForRole(req.role);
    const wt = await ensureDetachedWorktree(ctx.root, landWorktreePath(ctx.root, req.role), req.sha);
    // The shared gate, verdict persisted immediately (the drain's write-back happens only
    // in-process at batch completion, so a mid-batch crash must not lose what the batch earned).
    const outcome = await reviewPinnedChange({
      root: ctx.root,
      mainBranch: ctx.mainBranch,
      config: ctx.config,
      role: req.role,
      wt,
      req,
      state: w.state,
      signal: ctx.signal(),
      foldUsage: w.foldUsage,
    });
    if (outcome.kind === "gate") {
      stack.push(i); // approved or exempt
      continue;
    }
    if (outcome.result === "aborted") {
      aborted = true;
      break; // the rest get "aborted" via finishAborted; refs kept
    }
    results[i]!.result = outcome.result;
    if (outcome.result === "review_error") break; // stop: the unattempted keep entry + ref
    // "rejected": terminal for this sha — the gate already reset its worktree to main.
  }
  finishAborted();
  if (aborted || stack.length === 0) return results;

  // ── The degenerate case: one approved change IS 2/5's single path ────────────────────
  if (stack.length === 1) {
    const i = stack[0]!;
    const req = requests[i]!;
    try {
      results[i]!.result = await landChange(landerCtx(wiringForRole(req.role)), req);
    } catch (err) {
      results[i]!.result = "error";
      wiringForRole(req.role).state.lastError = errorMessage(err);
    }
    if (results[i]!.result === "aborted") aborted = true;
    finishAborted();
    return results;
  }

  // ── Assemble the stack in S[0]'s lander worktree, then ONE check over the tree ───────
  const headReq = requests[stack[0]!]!;
  // Base the stack on main's CURRENT tip and cherry-pick every change onto it — the head
  // included. A later batch of a longer drain (5 queued, cap 3) holds pins based on the
  // main the FIRST batch already moved; stacking from S[0].sha there would put the ff
  // against diverged history (merge_blocked, then the whole batch re-lands one at a time
  // through recovery). When main hasn't moved since the pins were created (the common
  // single-batch case) the picks reconstruct the same tree and the ff lands the same tip.
  // Every entry — the head included — carries its captured post-pick sha into the ff and
  // the per-change merged events.
  const base = await gitTry(ctx.root, "rev-parse", ctx.mainBranch);
  const landed: { role: string; sha: string; summary: string }[] = [];
  let abandon = base === null; // main unreadable: cannot stack — fall through to one-at-a-time
  let wt: string | null = null;
  if (base !== null) {
    // S[0]'s lander worktree hosts the assembly (its Phase A gate used it too); one
    // idempotent ensure at the fresh base covers the worktree-a-moment-ago case.
    wt = await ensureDetachedWorktree(ctx.root, landWorktreePath(ctx.root, headReq.role), base);
    for (const i of stack) {
      const req = requests[i]!;
      // Cherry-pick, not rebase: after 2/5 the role branches sit at main and each landing
      // lives only in its pinned ref as a single commit — there is nothing to rebase.
      const pick = await gitTry(wt, ...COMMIT_IDENT, "cherry-pick", req.sha);
      if (pick === null) {
        // A conflict (or an already-applied patch — the crash-window re-drain): abort the
        // pick and abandon to one-at-a-time. The worktree may be left mid-state; its next
        // ensureDetachedWorktree hard-resets it.
        await gitTry(wt, "cherry-pick", "--abort");
        abandon = true;
        break;
      }
      landed.push({ role: req.role, sha: await headOf(wt, "HEAD"), summary: req.summary });
    }
  }
  if (!abandon) {
    // The expensive deterministic half, shared: ONE run over the combined tree. Outcome
    // routing — null: no declared check, land directly; "failed": red or a merge-scope
    // timeout, abandon; "skipped": no npm / broken toolchain (the helper warned), proceed —
    // never fail-closed; "passed": green.
    const check = await runScopedBuildCheck(ctx.root, headReq.role, "batch", wt!);
    abandon = check !== null && check.outcome.status === "failed";
    if (!abandon) {
      const outcome = await ffStackToMain(ctx.root, ctx.mainBranch, landed);
      if (outcome === "changed") {
        // A PASSED stack check ran on exactly the future main tip — seed the red-main
        // baseline after (not before) the successful ff, so a merge_blocked stack seeds
        // nothing; a skipped check seeds nothing either (skips never seed).
        if (check !== null && check.outcome.status === "passed") {
          noteGreenBaseline(landed.at(-1)!.sha);
        }
        for (const i of stack) {
          await deleteRef(ctx.root, landingRefName(requests[i]!.role));
          results[i]!.result = "changed";
        }
      } else {
        // Main moved under the batch (a human commit or a non-batched role's recovery
        // landing): diverged history, ff failed. Every S change keeps its ref with
        // "merge_blocked" — leftover recovery re-lands each through its own gate +
        // tryMerge, which carries the in-lock check.
        for (const i of stack) results[i]!.result = "merge_blocked";
      }
    }
  }
  if (abandon) {
    // One-at-a-time through the existing single path, queue order, stopping at the first
    // non-terminal outcome (the rest keep entry + ref and re-drain). The already-approved
    // gate short-circuits, so each fallback burns no model run; main is never left red —
    // the single path's own gate + in-lock re-check cover every change.
    for (const i of stack) {
      const req = requests[i]!;
      try {
        const result = await landChange(landerCtx(wiringForRole(req.role)), req);
        results[i]!.result = result;
        if (result === "aborted") aborted = true;
      } catch (err) {
        results[i]!.result = "error";
        wiringForRole(req.role).state.lastError = errorMessage(err);
      }
      if (results[i]!.result !== "changed") break;
    }
  }
  finishAborted();
  return results;
}
