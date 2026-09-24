/** The batched landing path (plans/merge-queue.md, entry 5/5): land a whole drain of queued
 * changes as one stack, sharing a single build check, with a per-change fallback to the
 * single path. The single-landing path (landChange) and the shared review gate
 * (reviewPinnedChange) live beside it in lander.ts; this module owns only the batch drain. */

import { COMMIT_IDENT, deleteRef, gitLines, gitTry, headOf } from "./git.js";
import { landWorktreePath, landingRefName } from "./paths.js";
import { ensureDetachedWorktree } from "./worktree.js";
import { ffStackToMain } from "./merge.js";
import { runScopedBuildCheck } from "./build-check.js";
import { noteGreenBaseline } from "./main-baseline.js";
import { isExemptDiff } from "./exemptions.js";
import {
  landApprovedChange,
  reviewPinnedChange,
  syncPinToMain,
  type LandRequest,
  type LanderContext,
} from "./lander.js";
import { errorMessage } from "./text.js";
import { setLandingStage } from "./landing-slot.js";
import type { TumwaterConfig } from "./config-schema.js";
import type { LoopState, PiRunResult, TickResult } from "./types.js";

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
  /** Called once per request whose Phase-A outcome is FINAL, the moment it is — rejected or a
   * strike-cap review_error discard (verdict persisted, ref deleted), or an "error" for a pin
   * that cannot even be checked out — with its index into `requests`. Nothing later in the
   * batch can change that outcome, so the drain writes it back and drops the entry right
   * away: the author can start its fix tick instead of waiting out every other review, the
   * stack check, and the fast-forward (BUGS.md 2026-09-23). The returned array still carries
   * the result. Never called for an approved/exempt change (its author must not tick on top
   * of an unlanded change, so it stays queued until the stack lands or fails), an under-cap
   * review_error (its kept ref is the next tick's leftover recovery, which must not race this
   * batch's fast-forward), or "aborted". */
  onFinal?(index: number, result: TickResult): void;
}

/** One batched change's wiring, resolved by the drain exactly as the landed drain resolves
 * its author: the live state object the gate updates and the drain folds the outcome into,
 * this role's usage fold (reviewer spend charges to the authoring role), and the role's
 * shared pi wiring for landApprovedChange's conflict resolver on the one-at-a-time paths. */
export interface BatchRoleWiring {
  state: LoopState;
  /** Fold one pi run's usage into this role's landing counters (the reviewer's run). */
  foldUsage(run: PiRunResult): void;
  /** Run one pi run in `wt` with this role's shared wiring (the fallback landings' conflict resolver). */
  runPi(wt: string, prompt: string, sessionName: string): Promise<PiRunResult>;
}

/** How many times a batch whose fast-forward lost the race to a moved main re-stacks onto the
 * new tip and goes round again before handing every change to leftover recovery as
 * `merge_blocked`. The race window is the whole batch check, and main still has writers
 * outside the land queue (a role's in-tick leftover-recovery landing, a human commit), so a
 * lost race is routine and one re-stack almost always wins it — the second is headroom for a
 * busy stretch. The bound keeps a main that moves faster than a check completes from holding
 * the single landing slot (and every queued landing behind it) indefinitely: each re-stack
 * whose new tree is not doc-only pays one more full check. Past it the per-change path takes
 * over, whose in-lock re-check another harness landing cannot race. */
export const BATCH_RESTACK_ATTEMPTS = 2;

/** One stacked change as the fast-forward lands it: its role, its post-pick sha, its summary. */
type StackEntry = { role: string; sha: string; summary: string };

/** Assemble a batch's stack in `wtPath` (S[0]'s lander worktree) on main's CURRENT tip, once
 * per attempt — a re-stack after a lost fast-forward race is the same assembly on the tip that
 * won. `entries` carry each change's head to land (pin, or pin + build fix); the result
 * carries each one's captured post-pick sha instead, in queue order — the stack ffStackToMain
 * lands. Returns null when the stack cannot be assembled on this tip: main is unreadable, or a
 * pick conflicts (or applies nothing — the crash-window re-drain); the caller abandons to
 * one-at-a-time. */
async function assembleStack(
  root: string,
  mainBranch: string,
  wtPath: string,
  entries: readonly StackEntry[],
): Promise<StackEntry[] | null> {
  // Base the stack on main's CURRENT tip and cherry-pick every change onto it — the head
  // included. A later batch of a longer drain (5 queued, cap 3) holds pins based on the
  // main the FIRST batch already moved; stacking from S[0].sha there would put the ff
  // against diverged history on every attempt. When main hasn't moved since the pins were
  // created (the common single-batch case) the picks reconstruct the same tree and the ff
  // lands the same tip. Every entry — the head included — carries its captured post-pick sha
  // into the ff and the per-change merged events.
  const base = await gitTry(root, "rev-parse", mainBranch);
  if (base === null) return null; // main unreadable: cannot stack
  // One idempotent ensure at the fresh base covers the worktree-a-moment-ago case (Phase A's
  // gate, or the previous attempt's assembly).
  const wt = await ensureDetachedWorktree(root, wtPath, base);
  const landed: StackEntry[] = [];
  for (const entry of entries) {
    // Cherry-pick the whole RANGE from main's tip to the entry's head to land — not just
    // that head's own diff. A gate build-fix run commits on top of the work commit and the
    // pin moves to the fixed head, whose own diff is only the fix: picking the single head
    // would land the fix without the work it fixes and orphan the work commit. `base..sha`
    // picks every commit ahead of main, in queue order — one commit normally, work + fix
    // after a build-fix run. (Not a rebase: after 2/5 the role branches sit at main and
    // each landing lives only in its pinned ref — there is nothing to rebase.)
    const pick = await gitTry(wt, ...COMMIT_IDENT, "cherry-pick", `${base}..${entry.sha}`);
    if (pick === null) {
      // A conflict (or an already-applied patch — the crash-window re-drain): abort the
      // pick and abandon to one-at-a-time. The worktree may be left mid-state; its next
      // ensureDetachedWorktree hard-resets it.
      await gitTry(wt, "cherry-pick", "--abort");
      return null;
    }
    landed.push({ role: entry.role, sha: await headOf(wt, "HEAD"), summary: entry.summary });
  }
  return landed;
}

/** True when the tree at `to` differs from the tree at `from` only in review-exempt paths —
 * the gate's own doc-only test (isExemptDiff over config.review.exemptPaths). A re-stack whose
 * new commits from main were doc-only rebuilds the checked tree with nothing but doc bytes
 * changed, and a doc-only delta cannot break the build: the reasoning verifyLanding
 * (src/merge.ts) applies when it skips its in-lock re-check for a moved doc-only landing. Its
 * false-fix cross-check has no counterpart here — the delta is commits main already landed
 * through their own gate, not a claim this batch makes. --no-renames so a rename out of a
 * code path lists the deleted source, not only its exempt destination. An unreadable diff is
 * not exempt: the caller runs the check. */
async function exemptTreeDelta(
  root: string,
  from: string,
  to: string,
  exemptPaths: string[],
): Promise<boolean> {
  const out = await gitTry(root, "diff", "--no-renames", "--name-only", from, to);
  return out !== null && isExemptDiff(gitLines(out), exemptPaths);
}

/** Land a whole batch of queued changes (plans/merge-queue.md, entry 5/5): stop paying one
 * full build check per landing when several are queued. The flow:
 *
 * Phase A — for each request in queue order, the SAME review gate landChange runs, in that
 * role's own `_land-<role>` worktree, on the pin rebased onto main's current tip exactly as
 * landChange rebases it (syncPinToMain — a reviewer whose checkout sits behind main reads
 * main's newer commits as reverts), with the verdict persisted right after (a mid-batch
 * crash must not lose what the batch earned). approved/exempt → into the stack S (each entry
 * recorded with the head its gate judged — the synced pin, or it + a build-fix commit); rejected →
 * terminal (ref deleted), continue; failed → stop (this request "review_error": a strike-cap
 * discard deletes the ref, an under-cap failure keeps it tracking any build-fix commit; the
 * rest stay unattempted); a rejection, a strike-cap discard, and an uncheckable pin are FINAL
 * and reach the drain at once through `ctx.onFinal`; aborted (a shutdown
 * mid-gate or a quiet-killed reviewer run) → every request without a terminal outcome reads
 * "aborted" and keeps its ref. |S| == 0 means nothing was approved — all results are already
 * defined (or unattempted after an early stop) and there is nothing to land: return as-is.
 *
 * |S| == 1 — land it through landApprovedChange (no second gate, so this costs git + ff
 * only, plus an in-lock re-check if main moved since Phase A judged it): the degenerate case
 * lands the same bytes 2/5's single path would, with the same events and ref lifecycle.
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
 * only when the check PASSED on exactly that tip — the lander seeds noteGreenBaseline with
 * the stacked tip (the exact future main head). ff failure (main moved while the check ran:
 * the window is the whole check, and a role's in-tick leftover-recovery landing still writes
 * main outside the land queue) → RE-STACK: assemble the same S afresh on main's new tip and
 * go round again, up to BATCH_RESTACK_ATTEMPTS times, stopping before any attempt on an abort.
 * A re-stacked tree that differs from the last tree a check ran on only in review-exempt
 * paths (the gate's doc-only test, which verifyLanding applies to a moved landing too) goes
 * straight to the ff; any other re-stack pays one more scope-`batch` check. A re-stack
 * conflict or a red re-check abandons to one-at-a-time exactly like the first assembly; only
 * a race lost on every attempt leaves each S change its ref with "merge_blocked", nothing
 * seeded, for leftover recovery to re-land through its own gate + tryMerge (in-lock check).
 *
 * Red or un-assemblable (a cherry-pick conflict) → ABANDON to one-at-a-time, not
 * blame-the-batch: every approved change lands on its own in queue order, stopping at the
 * first non-terminal outcome (the rest keep entry + ref and re-drain), each through
 * landApprovedChange: no second gate and no model run, because only approved/exempt changes
 * enter S. landChange would re-gate instead: its pre-gate rebase onto the main the earlier
 * entries just moved rewrites the approved sha, so the exact-sha `lastApprovedHead`
 * short-circuit misses and every fallback paid a second build check and review (BUGS.md
 * 2026-09-23). A fallback whose base moved under it since its Phase A gate pays one bounded
 * scope-`landing` check in-lock instead. main is never left red: the only bytes this path
 * ff's are the checked tip or per-change landings re-verified in-lock whenever they differ
 * from what their gate judged.
 *
 * An abort is observed between steps, not only by the pi runs it kills: before every Phase A
 * gate (reviewPinnedChange), before each assembly-and-check attempt, and before each
 * one-change or fallback landing (landApprovedChange), so a stopping batch ends at its next
 * step boundary instead of walking its remaining gates, checks and merges (BUGS.md
 * 2026-09-23). A shared check that has already run is followed through: its fast-forward is
 * the batch's bounded commit point.
 *
 * One entry per request comes back in order; `result === undefined` means "unattempted — the
 * drain keeps that queue entry" (a failed Phase-A gate or a fallback early stop), and a
 * defined result drops its entry through the drain's write-back (for the results `ctx.onFinal`
 * already reported, done mid-batch — the drain skips them here). Never throws for a failed
 * landing: per-change landApprovedChange failures degrade to "error" results, and a Phase-A checkout
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

  // A FINAL Phase-A outcome is settled for good the moment it is persisted: record it and
  // hand it to the drain at once, so that request's entry drops and its author is free to
  // tick while the rest of the batch runs on.
  const settleFinal = (i: number, result: TickResult): void => {
    results[i]!.result = result;
    ctx.onFinal?.(i, result);
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
      // unattempted (entry + ref intact), like a mid-batch review_error. The error is on the
      // state before the settle, so the drain's write-back persists it.
      w.state.lastError = errorMessage(err);
      settleFinal(i, "error");
      break;
    }
    // The shared gate over the pin rebased onto main's current tip — landChange's own
    // pre-gate rebase, so the head approved here is the head a landing starts from, and a
    // conflict leaves the pin for the gate exactly as there — with the verdict persisted
    // immediately (the drain's write-back of every non-final outcome happens only
    // in-process at batch completion, so a mid-batch crash must not lose what the batch
    // earned).
    const synced = await syncPinToMain(ctx, wt, req);
    const outcome = await reviewPinnedChange(ctx, synced, wt, w.state, w.foldUsage);
    if (outcome.kind === "gate") {
      stack.push(i); // approved or exempt
      stackSha.push(outcome.sha);
      continue;
    }
    if (outcome.result === "aborted") {
      aborted = true;
      break; // the rest get "aborted" via finishAborted; refs kept
    }
    // "rejected": terminal for this sha — the gate already reset its worktree to main and
    // deleted the ref; a strike-cap discard deleted it too. Both are final. An under-cap
    // review_error keeps its ref for recovery, so it waits for the batch's own write-back.
    if (outcome.result === "rejected" || outcome.discarded) settleFinal(i, outcome.result);
    else results[i]!.result = outcome.result;
    if (outcome.result === "review_error") break; // stop: the unattempted keep entry + ref
  }
  finishAborted();
  if (aborted || stack.length === 0) return results;

  // ── The degenerate case: one approved change IS 2/5's single path ────────────────────
  if (stack.length === 1) {
    const i = stack[0]!;
    const req = { ...requests[i]!, sha: stackSha[0]! };
    try {
      results[i]!.result = await landApprovedChange(landerCtx(wiringForRole(req.role)), req);
    } catch (err) {
      results[i]!.result = "error";
      wiringForRole(req.role).state.lastError = errorMessage(err);
    }
    if (results[i]!.result === "aborted") aborted = true;
    finishAborted();
    return results;
  }

  // ── Assemble the stack in S[0]'s lander worktree, then ONE check over the tree per attempt
  const headReq = requests[stack[0]!]!;
  // S[0]'s lander worktree hosts the assembly (its Phase A gate used it too).
  const wtPath = landWorktreePath(ctx.root, headReq.role);
  const entries: StackEntry[] = stack.map((i, s) => ({
    role: requests[i]!.role,
    sha: stackSha[s]!,
    summary: requests[i]!.summary,
  }));
  let abandon = false;
  let merged = false;
  // The last stacked tip a build check actually ran on: a re-stack whose tree differs from it
  // only in doc-only paths lands on that run's verdict instead of paying another.
  let checkedTip: string | null = null;
  const exemptPaths = ctx.config.review.exemptPaths;
  for (let attempt = 0; attempt <= BATCH_RESTACK_ATTEMPTS; attempt++) {
    // A shutdown (or a user stop for any batched role) before an attempt — the first one
    // included, so a stop that arrived after the last gate (a restart hand-off past its
    // deadline, BUGS.md 2026-09-23) never starts the batch's one expensive shared step: stop
    // here. Every S result is still undefined, so finishAborted reads them "aborted", refs kept.
    if (ctx.signal().aborted) {
      aborted = true;
      break;
    }
    const landed = await assembleStack(ctx.root, ctx.mainBranch, wtPath, entries);
    if (landed === null) {
      abandon = true; // main unreadable or a pick conflicted: one-at-a-time
      break;
    }
    const tip = landed.at(-1)!.sha;
    // The expensive deterministic half, shared: ONE run over the combined tree. Outcome
    // routing — null: no declared check, land directly; "failed": red or a merge-scope
    // timeout, abandon; "skipped": no npm / broken toolchain (the helper warned), proceed —
    // never fail-closed; "passed": green. A re-stack skips the run only when its tree is the
    // checked tree plus doc-only changes (exemptTreeDelta).
    let seed: string | undefined; // the tip a PASSED check ran on exactly, seeded after the ff
    const docOnlyRestack = checkedTip !== null && (await exemptTreeDelta(ctx.root, checkedTip, tip, exemptPaths));
    if (!docOnlyRestack) {
      // The landing cell names the check while it runs, then the merge steps after it — the ff
      // or the one-at-a-time fallback (setLandingStage is a no-op for every stacked role but
      // the one the marker names).
      for (const i of stack) setLandingStage(ctx.root, requests[i]!.role, "build-check");
      const check = await runScopedBuildCheck(ctx.root, headReq.role, "batch", wtPath, ctx.config);
      for (const i of stack) setLandingStage(ctx.root, requests[i]!.role, "merging");
      if (check !== null && check.outcome.status === "failed") {
        abandon = true;
        break;
      }
      checkedTip = tip;
      if (check !== null && check.outcome.status === "passed") seed = tip;
    }
    if ((await ffStackToMain(ctx.root, ctx.mainBranch, landed)) === "changed") {
      // A PASSED stack check ran on exactly the future main tip — seed the red-main
      // baseline after (not before) the successful ff, so a merge_blocked stack seeds
      // nothing; a skipped check seeds nothing either (skips never seed), and neither does
      // a doc-only re-stack (like verifyLanding's exempt arm: nothing ran on this tip).
      if (seed !== undefined) noteGreenBaseline(seed);
      for (const i of stack) {
        await deleteRef(ctx.root, landingRefName(requests[i]!.role));
        results[i]!.result = "changed";
      }
      merged = true;
      break;
    }
    // Main moved under the batch while the check ran (a role's in-tick leftover-recovery
    // landing, or a human commit): diverged history, ff failed. Re-stack on the tip that won.
  }
  if (!merged && !abandon && !aborted) {
    // The race was lost on every attempt — main is moving faster than a check completes.
    // Every S change keeps its ref with "merge_blocked": leftover recovery re-lands each
    // through its own gate + tryMerge, whose in-lock check cannot lose this race.
    for (const i of stack) results[i]!.result = "merge_blocked";
  }
  if (abandon) {
    // One-at-a-time through the single path's landing half, queue order, stopping at the first
    // non-terminal outcome (the rest keep entry + ref and re-drain). Each request lands its
    // Phase-A head to land (the synced pin + any build fix, not the bare pin) through
    // landApprovedChange — no second gate, so no model run: re-gating would rebase onto the
    // main the earlier entries just moved, and the rewritten sha misses the approved
    // short-circuit. main is never left red — mergeToMain's in-lock rebase + verifyLanding
    // re-check every change whose tree differs from the one its gate judged.
    for (let s = 0; s < stack.length; s++) {
      const i = stack[s]!;
      const req = { ...requests[i]!, sha: stackSha[s]! };
      try {
        const result = await landApprovedChange(landerCtx(wiringForRole(req.role)), req);
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
