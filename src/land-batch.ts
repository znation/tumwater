/** The batched landing path (plans/merge-queue.md, entry 5/5): land a whole drain of queued
 * changes as one stack, sharing a single build check, with a per-change fallback to the
 * single path. The single-landing path (landChange) and the shared review gate
 * (reviewPinnedChange) live beside it in lander.ts; this module owns only the batch drain. */

import { COMMIT_IDENT, deleteRef, gitTry, headOf } from "./git.js";
import { landWorktreePath, landingRefName } from "./paths.js";
import { ensureDetachedWorktree } from "./worktree.js";
import { ffStackToMain } from "./merge.js";
import { runScopedBuildCheck } from "./build-check.js";
import { noteGreenBaseline } from "./main-baseline.js";
import { landChange, reviewPinnedChange, type LandRequest, type LanderContext } from "./lander.js";
import { errorMessage } from "./text.js";
import type { LoopState, PiRunResult, TickResult, TumwaterConfig } from "./types.js";

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
 * crash must not lose what the batch earned). approved/exempt → into the stack S (each entry
 * recorded with the head its gate judged — pin, or pin + build-fix commit); rejected →
 * terminal (ref deleted), continue; failed → stop (this request "review_error": a strike-cap
 * discard deletes the ref, an under-cap failure keeps it tracking any build-fix commit; the
 * rest stay unattempted); aborted (a shutdown
 * mid-gate or a quiet-killed reviewer run) → every request without a terminal outcome reads
 * "aborted" and keeps its ref. |S| == 0 means nothing was approved — all results are already
 * defined (or unattempted after an early stop) and there is nothing to land: return as-is.
 *
 * |S| == 1 — land it through landChange (the gate short-circuits the already-approved head,
 * so this costs git + ff only): the degenerate case is 2/5's single path byte-for-byte, which
 * is what makes landBatchMax=1 reproduce 3/5 exactly.
 *
 * |S| >= 2 — assemble the stack in S[0]'s lander worktree, checked out detached at main's
 * CURRENT tip, then cherry-pick each S entry's full range from that tip to its head to land,
 * in queue order — `base..sha`, every commit ahead of main (one normally; work + build fix
 * after a gate fix run), capturing each post-pick tip — one check over the combined tree, one
 * fast-forward through those captured shas. ONE scope-`batch` runScopedBuildCheck over the combined tree
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
 * landing: per-change landChange failures degrade to "error" results, and a Phase-A checkout
 * that cannot resolve the pinned sha (the queue entry outlived its commit) also degrades to
 * a terminal "error" so the drain drops that entry and the queue advances — exactly the
 * single path's catch-all (landQueuedEntry). Remaining git-level failures from the
 * assembly/ff plumbing still propagate like any other tick failure (the drain's catch keeps
 * every entry for re-drain). */
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
  const stackSha: string[] = []; // each stack entry's head to land (pin, or pin + build fix)
  for (let i = 0; i < requests.length; i++) {
    const req = requests[i]!;
    const w = wiringForRole(req.role);
    let wt: string;
    try {
      wt = await ensureDetachedWorktree(ctx.root, landWorktreePath(ctx.root, req.role), req.sha);
    } catch (err) {
      // The queue entry outlived its pinned commit — the land queue outlives the ref by design
      // (a crash between pin and drop, or an outside gc), so a checkout of `req.sha` can fail
      // with the commit gone. Degrade to a terminal "error" for this request so the drain
      // drops its entry and the queue advances; the single path's landQueuedEntry catch-all
      // does exactly this. Without it the throw escapes to the drain, which keeps EVERY entry
      // — a lost head pin would then starve the healthy queue forever. The rest stay
      // unattempted (entry + ref intact), like a mid-batch review_error.
      results[i]!.result = "error";
      w.state.lastError = errorMessage(err);
      break;
    }
    // The shared gate, verdict persisted immediately (the drain's write-back happens only
    // in-process at batch completion, so a mid-batch crash must not lose what the batch earned).
    const outcome = await reviewPinnedChange(ctx, req, wt, w.state, w.foldUsage);
    if (outcome.kind === "gate") {
      stack.push(i); // approved or exempt
      stackSha.push(outcome.sha);
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
    const req = { ...requests[i]!, sha: stackSha[0]! };
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
    for (let s = 0; s < stack.length; s++) {
      const i = stack[s]!;
      const req = requests[i]!;
      // Cherry-pick the whole RANGE from main's tip to the entry's head to land — not just
      // that head's own diff. A gate build-fix run commits on top of the work commit and the
      // pin moves to the fixed head, whose own diff is only the fix: picking the single head
      // would land the fix without the work it fixes and orphan the work commit. `base..sha`
      // picks every commit ahead of main, in queue order — one commit normally, work + fix
      // after a build-fix run. (Not a rebase: after 2/5 the role branches sit at main and
      // each landing lives only in its pinned ref — there is nothing to rebase.)
      const pick = await gitTry(wt, ...COMMIT_IDENT, "cherry-pick", `${base}..${stackSha[s]!}`);
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
    const check = await runScopedBuildCheck(ctx.root, headReq.role, "batch", wt!, ctx.config);
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
    // non-terminal outcome (the rest keep entry + ref and re-drain). Each request lands its
    // Phase-A head to land (pin + build fix, not the bare pin) — its lander worktree then
    // holds the exact tree its gate approved. The already-approved gate short-circuits, so
    // each fallback burns no model run; main is never left red — the single path's own gate
    // + in-lock re-check cover every change.
    for (let s = 0; s < stack.length; s++) {
      const i = stack[s]!;
      const req = { ...requests[i]!, sha: stackSha[s]! };
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
