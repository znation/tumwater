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
import { setLandingStage, type LandingChangeStatus } from "./landing-slot.js";
import type { TumwaterConfig } from "./config-schema.js";
import type { LoopState, PiRunResult, TickResult } from "./types.js";

/** How many Phase-A gates run at once. The gates are independent — each in its own role's
 * `_land-<role>` worktree, review session dir, pinned ref, pi log and LoopState — so a batch's
 * slot time is bounded by its slowest reviews rather than their sum (BUGS.md 2026-09-23: a
 * 40-minute batch was three reviews back to back). But every gate first runs the project's
 * FULL declared check on the one shared host, and the suite carries load-sensitive tests
 * (BUGS.md 2026-09-21: a live-orchestrator test failed and passed on the same sha two minutes
 * apart), so a wide fan-out would trade reviewer wait for false-red gate checks. Two overlaps
 * the dominant cost — the model review — while adding at most one concurrent suite. A
 * constant, not a knob: one sensible default first. */
export const PHASE_A_CONCURRENCY = 2;

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
  /** Called once per request whose Phase-A outcome is FINAL, the moment its own gate settles
   * (in whatever order the concurrent gates finish) — rejected or a
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
  /** Take one more backend permit for a concurrent Phase-A gate, resolving to its release.
   * The slot's own permit covers ONE gate; a landing's pi runs cost the backend what an
   * author run costs, so each gate running beside it holds a `maxConcurrent` permit of its
   * own (BUGS.md 2026-09-18 — the drain passes the shared semaphore at LANDING_TIER). The
   * grant may arrive after Phase A has finished without it (every permit was held all
   * along); runPhaseA then releases it at once. Absent (the unit tests' direct calls):
   * concurrent gates take no permit. */
  gatePermit?(): Promise<() => void>;
  /** Called as the batch reaches each change (by role — one change per role in a batch): the
   * slot starts working on it (`landing` — its gate, the stack, or its fallback landing), its
   * gate approves it into the stack (`approved`), or the batch is finished with it (`done`),
   * in whatever order the concurrent gates reach those points. The drain mirrors it into the
   * 4/5 marker's per-change records (setLandingChangeStatus) so each batched row reads its own
   * change's state; absent for callers with no marker to keep. */
  onChangeStatus?(role: string, status: LandingChangeStatus): void;
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

/** One Phase-A gate's verdict for its request: `stack` — approved or exempt, to land at `sha`
 * (the synced pin, or it + a build-fix commit); `result` — an outcome that keeps the change
 * out of the stack: rejected, review_error (`discarded` on a strike-cap discard), a lost-pin
 * "error", or aborted. */
type PhaseAVerdict = { kind: "stack"; sha: string } | { kind: "result"; result: TickResult; discarded?: true };

/** One request's Phase-A gate: check its pin out detached in the role's own lander worktree,
 * rebase it onto main's current tip — landChange's own pre-gate rebase (syncPinToMain), so the
 * head approved here is the head a landing starts from, and a conflict leaves the pin for the
 * gate exactly as there — and run the SAME review gate landChange runs, the verdict persisted
 * immediately by reviewPinnedChange (the drain's write-back of every non-final outcome happens
 * only in-process at batch completion, so a mid-batch crash must not lose what the batch
 * earned). The rebase touches only this role's worktree and ref, onto main itself, so two
 * gates rebasing at once cannot interfere. */
async function gateRequest(ctx: BatchContext, req: LandRequest, w: BatchRoleWiring): Promise<PhaseAVerdict> {
  let wt: string;
  try {
    wt = await ensureDetachedWorktree(ctx.root, landWorktreePath(ctx.root, req.role), req.sha);
  } catch (err) {
    // The queue entry outlived its pinned commit — the land queue outlives the ref by design
    // (a crash between pin and drop, or an outside gc), so a checkout of `req.sha` can fail
    // with the commit gone. Degrade to a terminal "error" for this request so the drain
    // drops its entry and the queue advances; the single path's landQueuedEntry catch-all
    // does exactly this. Without it the throw escapes to the drain, which keeps EVERY entry
    // — a lost head pin would then starve the healthy queue forever. It stops Phase A like a
    // review_error (stopsPhaseA): the unlaunched stay unattempted, entry + ref intact. The
    // error is on the state before the caller settles it, so the drain's write-back persists it.
    w.state.lastError = errorMessage(err);
    return { kind: "result", result: "error" };
  }
  const synced = await syncPinToMain(ctx, wt, req);
  const outcome = await reviewPinnedChange(ctx, synced, wt, w.state, w.foldUsage);
  return outcome.kind === "gate" ? { kind: "stack", sha: outcome.sha } : outcome;
}

/** Whether a Phase-A verdict is FINAL — settled for good the moment it is persisted, so the
 * drain may write it back and drop its entry mid-batch (BatchContext.onFinal): a rejection or
 * a strike-cap discard (verdict persisted, ref deleted), or an uncheckable pin's "error". */
function isFinal(v: PhaseAVerdict): boolean {
  return v.kind === "result" && (v.result === "rejected" || v.result === "error" || v.discarded === true);
}

/** Whether a verdict stops Phase A from LAUNCHING further gates. A rejection is a verdict
 * about one change, so the batch carries on. A failed review (a suspect reviewer backend
 * would fail the rest the same way), a lost pin, and an abort (a shutdown, a user stop, or a
 * quiet-killed reviewer run) stop it: the gates not yet launched stay unattempted — entry +
 * ref intact, re-drained next poll. Gates already in flight run to their verdict, which is
 * persisted work; an approval among them still stacks. */
function stopsPhaseA(v: PhaseAVerdict): boolean {
  return v.kind === "result" && v.result !== "rejected";
}

/** Phase A's scheduler: launch `gate` for each request index in queue order, at most
 * PHASE_A_CONCURRENCY at once, and return every request's verdict by queue index —
 * `undefined` means never launched. Completion order never reaches the caller's stack: it
 * folds this array in queue order, so the stack is deterministic however the reviews race.
 *
 * Lane 0 runs under the landing slot's own permit and always makes progress, so Phase A can
 * never deadlock on a full semaphore. Each further lane first takes a permit through
 * `gatePermit`, then pulls from the same cursor. A lane still waiting for its permit when the
 * cursor runs out is not waited for: its late grant finds nothing to launch and is released
 * at once — a hop, never a leak. The early stop (stopsPhaseA) stops only launching: this
 * returns once every LAUNCHED gate has settled, never with a reviewer still running behind the
 * slot's back. A gate that throws (git plumbing — a failed checkout is already a verdict)
 * stops launching too, and is rethrown once the rest settle, so it still propagates to the
 * drain as before. Two gates never share a worktree, ref, state, session dir or pi log: a
 * batch is N distinct roles (invariant 3), and each of those is per-role. */
async function runPhaseA(
  count: number,
  gate: (i: number) => Promise<PhaseAVerdict>,
  gatePermit: BatchContext["gatePermit"],
): Promise<Array<PhaseAVerdict | undefined>> {
  const verdicts: Array<PhaseAVerdict | undefined> = Array.from({ length: count }, () => undefined);
  let next = 0;
  let stopped = false;
  let thrown: { err: unknown } | undefined;
  const launchable = (): boolean => !stopped && next < count;
  // Launch the next request in queue order and record its verdict. Never rejects.
  const runNext = async (): Promise<void> => {
    const i = next++;
    try {
      const v = await gate(i);
      verdicts[i] = v;
      if (stopsPhaseA(v)) stopped = true;
    } catch (err) {
      thrown ??= { err };
      stopped = true;
    }
  };
  // The gates the permit-holding lanes launched, awaited once lane 0 runs out of work.
  const inFlight = new Set<Promise<void>>();
  for (let lane = 1; lane < Math.min(PHASE_A_CONCURRENCY, count); lane++) {
    void (async () => {
      let release = (): void => {};
      if (gatePermit) {
        try {
          release = await gatePermit();
        } catch {
          return; // no permit, no lane: lane 0 still runs every gate
        }
      }
      try {
        while (launchable()) {
          const run = runNext();
          inFlight.add(run);
          await run;
          inFlight.delete(run);
        }
      } finally {
        release();
      }
    })();
  }
  while (launchable()) await runNext();
  // Lane 0 is out of work, so nothing launches any more (the cursor only advances and the
  // stop only latches): every gate still running is in `inFlight`.
  await Promise.all(inFlight);
  if (thrown) throw thrown.err;
  return verdicts;
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
 * Phase A — for each request, the SAME review gate landChange runs, in that role's own
 * `_land-<role>` worktree, on the pin rebased onto main's current tip exactly as landChange
 * rebases it (syncPinToMain — a reviewer whose checkout sits behind main reads main's newer
 * commits as reverts), with the verdict persisted right after (a mid-batch crash must not
 * lose what the batch earned). Up to PHASE_A_CONCURRENCY gates run at once, launched in queue
 * order (runPhaseA), so a batch's slot time is its slowest reviews plus the check rather than
 * the sum of every review; the verdicts fold back in queue order however the reviews race.
 * approved/exempt → into the stack S (each entry recorded with the head its gate judged — the
 * synced pin, or it + a build-fix commit); rejected → terminal (ref deleted), keep launching;
 * failed → this request "review_error" (a strike-cap discard deletes the ref, an under-cap
 * failure keeps it tracking any build-fix commit) and STOP LAUNCHING: gates already in flight
 * finish and their verdicts stand (an approval still stacks), the unlaunched stay unattempted;
 * a rejection, a strike-cap discard, and an uncheckable pin are FINAL and reach the drain
 * through `ctx.onFinal` the moment their own gate settles, in whatever order the gates finish;
 * aborted (a shutdown mid-gate or a quiet-killed reviewer run) → stop launching likewise, and
 * every request without a terminal outcome reads "aborted" and keeps its ref. |S| == 0 means
 * nothing was approved — all results are already defined (or unattempted after an early
 * stop) and there is nothing to land: return as-is.
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
 * drain keeps that queue entry" (never launched after a Phase-A early stop, or a fallback
 * early stop), and a
 * defined result drops its entry through the drain's write-back (for the results `ctx.onFinal`
 * already reported, done mid-batch — the drain skips them here). Never throws for a failed
 * landing: per-change landApprovedChange failures degrade to "error" results, and a Phase-A checkout
 * that cannot resolve the pinned sha (the queue entry outlived its commit) also degrades to
 * a terminal "error" so the drain drops that entry and the queue advances — exactly the
 * single path's catch-all (landQueuedEntry). Remaining git-level failures from a gate's or the
 * assembly/ff plumbing still propagate like any other tick failure — a gate's only once every
 * other launched gate has settled — and the drain's catch keeps every entry for re-drain. */
export async function landBatch(
  ctx: BatchContext,
  requests: LandRequest[],
  wiringFor: (role: string) => BatchRoleWiring,
): Promise<Array<{ req: LandRequest; result?: TickResult }>> {
  const results = requests.map((req) => ({ req, result: undefined as TickResult | undefined }));
  const report = (i: number, status: LandingChangeStatus): void => ctx.onChangeStatus?.(requests[i]!.role, status);
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

  // ── Phase A: the per-change review gates, concurrently (runPhaseA) ─────────────────────
  const verdicts = await runPhaseA(
    requests.length,
    async (i) => {
      report(i, "landing"); // the slot is on this change now — its gate, from the checkout on
      const v = await gateRequest(ctx, requests[i]!, wiringForRole(requests[i]!.role));
      // Its gate is over: an approval waits for the rest of Phase A before the stack lands;
      // anything else is out of this batch, and its row must not keep a live label while the
      // other gates run on.
      report(i, v.kind === "stack" ? "approved" : "done");
      // A FINAL outcome reaches the drain the moment its own gate settles — whatever order
      // the concurrent gates finish in — not when the whole of Phase A does.
      if (v.kind === "result" && isFinal(v)) settleFinal(i, v.result);
      return v;
    },
    ctx.gatePermit,
  );
  // Fold the verdicts in QUEUE order, whatever order the gates finished in: the stack — and
  // with it the cherry-picks, the ff and the merged events — follows the queue deterministically.
  const stack: number[] = []; // request indices of the approved/exempt changes, queue order
  const stackSha: string[] = []; // each stack entry's head to land (pin, or pin + build fix)
  verdicts.forEach((v, i) => {
    if (v === undefined) return; // never launched: the drain keeps its entry, the ref stays
    if (v.kind === "stack") {
      stack.push(i); // approved or exempt
      stackSha.push(v.sha);
    } else if (v.result === "aborted") {
      aborted = true; // every request without a terminal outcome reads "aborted"; refs kept
    } else if (!isFinal(v)) {
      // An under-cap review_error keeps its ref for recovery, so it waits for the batch's own
      // write-back. (A final outcome — "rejected", a strike-cap discard, a lost pin's
      // "error" — was already recorded and reported by settleFinal as its gate settled.)
      results[i]!.result = v.result;
    }
  });
  finishAborted();
  if (aborted || stack.length === 0) return results;
  // The stack lands on: a change an early stop never launched is out of this batch (its entry
  // and ref wait for the next drain), so it must not read `queued in batch` meanwhile.
  verdicts.forEach((v, i) => {
    if (v === undefined) report(i, "done");
  });

  // ── The degenerate case: one approved change IS 2/5's single path ────────────────────
  if (stack.length === 1) {
    const i = stack[0]!;
    const req = { ...requests[i]!, sha: stackSha[0]! };
    report(i, "landing");
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
  // Every stacked change is landing now: they share the assembly, the check, and the ff.
  for (const i of stack) report(i, "landing");
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
      // or the one-at-a-time fallback — on every stacked change's own record.
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
    // re-check every change whose tree differs from the one its gate judged. Only the change
    // being landed reads `landing`; the rest are back to awaiting their turn, and each one
    // landed is done.
    for (const i of stack) report(i, "approved");
    for (let s = 0; s < stack.length; s++) {
      const i = stack[s]!;
      const req = { ...requests[i]!, sha: stackSha[s]! };
      report(i, "landing");
      try {
        const result = await landApprovedChange(landerCtx(wiringForRole(req.role)), req);
        results[i]!.result = result;
        if (result === "aborted") aborted = true;
      } catch (err) {
        results[i]!.result = "error";
        wiringForRole(req.role).state.lastError = errorMessage(err);
      }
      report(i, "done");
      if (results[i]!.result !== "changed") break;
    }
  }
  finishAborted();
  return results;
}
