// vocabulary: plain
/** Two of the three halves of a merge (plans/merge-queue.md 5/5, PLANS.md land-queue speed
 * 2c): the per-change verify (verifyRequest) that merge-verify.ts's verify stage runs for every
 * queued change, and the merge (mergeApproved) its one merge slot runs over the approved ones — a
 * stack of two or more sharing a single build check, with a per-change fallback. The stack
 * merger mergeApproved drives (assemble → one shared check → ff, with re-stack and bisect) lives
 * beside it in merge-stack.ts. The shared review gate (reviewPinnedChange) and the
 * one-change merge (mergeApprovedChange) live beside both in merge-core.ts. */

import { leaseSlot, type SlotLeaseHandle } from "../git/worktree-pool.js";
import { slotCount } from "../config/config.js";
import { mergeWorktreePath } from "../paths.js";
import {
  mergeApprovedChange,
  reviewPinnedChange,
  syncPinToMain,
  type MergeRequest,
  type MergerContext,
  type MergeScopeContext,
} from "./merge-core.js";
import { attributeRedCheck } from "./merge-check-failures.js";
import { errorMessage } from "../text/text.js";
import type { MergeChangeStatus } from "./merge-slot.js";
import { mergeStack, type StackEntry, type StackOutcome } from "./merge-stack.js";
import type { TickResult } from "../tick/tick-outcome.js";
import type { GateRunsPi, PiRunWiring } from "../loop/loop-pi.js";
import type { LoopState } from "../loop/loop-state.js";

/** The identity a verify or a merge needs from the harness: root, main branch, live config, and
 * the task's abort signal. Deliberately thinner than MergerContext — no single `state` and no
 * `runPi`, because a merge spans N ROLES (invariant 3 caps a role at one in-flight change, so
 * a stack is N changes from N distinct roles) and each one carries its own wiring. */
export interface BatchContext extends GateRunsPi, MergeScopeContext {
  /** Called as the merge reaches each change (by role — one change per role in a merge): it
   * starts working on it (`merging` — the stack, or the change's own one-at-a-time merge),
   * hands it back to wait its turn in an abandoned stack's fallback (`approved`), or is finished
   * with it (`done`). The drain mirrors it into the 4/5 marker's per-change records
   * (setMergeChangeStatus) so each row reads its own change's state; absent for callers with
   * no marker to keep. */
  onChangeStatus?(role: string, status: MergeChangeStatus): void;
  /** Called once per change the moment its result is final, before the merge moves on to a
   * slower batch-mate. The drain settles each result here (write-back, drop the entry) so a
   * change already on main stops reading its stale pre-merge streak while a later change's
   * conflict resolver blocks (BUGS.md 2026-10-09). Absent for callers that settle the
   * returned array themselves. */
  onResult?(index: number, result: TickResult): void | Promise<void>;
}

/** One change's wiring, resolved by the drain from its authoring runner: the live state object
 * the gate updates and the drain folds the outcome into, this role's usage fold (reviewer spend
 * charges to the authoring role), and the role's shared pi wiring for mergeApprovedChange's
 * conflict resolver. */
export interface BatchRoleWiring extends PiRunWiring {
  state: LoopState;
}

/** One change's verify verdict: `stack` — approved or exempt, to merge at `sha` (the synced
 * pin, which the merge ref now names), with `verifiedHead` set when the gate's pre-check ran
 * green on exactly that head; `result` — an outcome that keeps the change out of the merge:
 * rejected, review_error (`discarded` on a strike-cap discard), main_red, a lost-pin "error",
 * or aborted. */
export type VerifyVerdict =
  | { kind: "stack"; sha: string; verifiedHead?: string }
  | { kind: "result"; result: TickResult; discarded?: true };

/** Verify one request — the whole of a verify-stage task: lease a pooled slot for the role, check
 * its pin out detached there, rebase it onto main's current tip (syncPinToMain — so the head
 * approved here is the head its merge starts from, and a conflict leaves the pin for the gate
 * and, at the merge, mergeToMain's resolver), and run the review gate, the verdict persisted
 * immediately by reviewPinnedChange (the drain's write-back of an approved change happens only
 * once it merges, so a crash must not lose what the verify earned). The lease is released in every
 * outcome (plans/worktree-pool.md, "Vets and merges"): the verify passes its result on through the
 * merge ref and ApprovedMerge, never through the slot, and every merge-side step re-ensures at
 * a commit. leaseSlot holds the slot through the disk-floor registry and resets it to the pin, so
 * two verifies rebasing at once — or one rebasing while a merge moves main — cannot interfere. */
export async function verifyRequest(ctx: BatchContext, req: MergeRequest, w: BatchRoleWiring): Promise<VerifyVerdict> {
  let lease: SlotLeaseHandle;
  try {
    lease = await leaseSlot(ctx.root, {
      role: req.role,
      purpose: "verify",
      ref: req.sha,
      signal: ctx.signal(),
      // The live view's pool budget, same rule as the tick path: a broken tumwater.json
      // must not error the verify before its reviewer runs.
      slotBudget: slotCount(ctx.config),
    });
  } catch (err) {
    // An abort while waiting for a free slot is the verify never starting — the same terminal
    // "aborted" reviewPinnedChange returns when it observes an already-fired signal.
    if (err instanceof Error && err.name === "AbortError") return { kind: "result", result: "aborted" };
    // The queue entry outlived its pinned commit — the merge queue outlives the ref by design
    // (a crash between pin and drop, or an outside gc), so a checkout of `req.sha` can fail
    // with the commit gone. Degrade to a terminal "error" for this request so the drain drops
    // its entry and the queue advances; a throw would keep the entry, and a lost pin would then
    // re-fail every poll with its author interlocked forever. The error is on the state before
    // the caller settles it, so the drain's write-back persists it.
    w.state.lastError = errorMessage(err);
    return { kind: "result", result: "error" };
  }
  try {
    return await verifyRequestIn(ctx, req, w, lease.dir);
  } finally {
    lease.release();
  }
}

async function verifyRequestIn(ctx: BatchContext, req: MergeRequest, w: BatchRoleWiring, wt: string): Promise<VerifyVerdict> {
  const synced = await syncPinToMain(ctx, wt, req);
  const outcome = await reviewPinnedChange(ctx, synced, wt, w.state, w.foldUsage);
  if (outcome.kind === "result") return outcome;
  // The gate's green pre-check names the head it ran on; it rides to the merge, whose in-lock
  // re-check seeds the red-main baseline with it when nothing moved in between (mergeToMain).
  const { verifiedHead } = outcome.gate;
  return verifiedHead === outcome.sha ? { kind: "stack", sha: outcome.sha, verifiedHead } : { kind: "stack", sha: outcome.sha };
}

/** Merge changes whose own verify already approved them — the merge slot's whole task
 * (merge-drain.ts, land-queue speed 2c), over every approved entry up to mergeBatchMax. `approved`
 * is in queue order, each request at the head its verify approved (the synced pin its merge ref
 * names); none is gated again, so no model review runs here (an adversarial review of a stack would
 * blur which change a criticism applies to, so each change was reviewed alone). The flow:
 *
 * One change — merge it through mergeApprovedChange: git + ff, plus an in-lock scope-`merge`
 * re-check whenever main moved since its verify (and a seeded baseline when it did not and its
 * verify's pre-check ran green on exactly that head).
 *
 * Two or more — assemble the stack in the shared `_merge` checkout, checked out detached at
 * main's CURRENT tip, then cherry-pick each change's full range from that tip to its head to merge,
 * in queue order — `base..sha`, every commit ahead of main (normally one), capturing each
 * post-pick tip — and run ONE scope-`batch` runScopedBuildCheck over the combined tree: the
 * expensive, deterministic half the stack shares. null (no declared check) → merge directly;
 * "failed" (a red tree or a timeout remapped to a reject — the tree is unverified) → bisect;
 * "skipped" (no npm / broken toolchain — the helper already warned) → proceed, never
 * fail-closed; "passed" → green. Green: under the merge lock, ffStackToMain ff's main through the
 * stack in ONE fast-forward, emits one `merged` event per change, and — only when the check
 * PASSED on exactly that tip — seeds noteGreenBaseline with the stacked tip. ff failure (main
 * moved while the check ran: the window is the whole check, and main still has writers outside the
 * merge queue) → RE-STACK: assemble the same changes afresh on main's new tip and go round again,
 * up to BATCH_RESTACK_ATTEMPTS times, stopping before any attempt on an abort. A re-stacked tree
 * that differs from the last tree a check ran on only in review-exempt paths goes straight to the
 * ff; any other re-stack pays one more check. Only a race lost on every attempt leaves each change
 * not yet merged its ref with "merge_blocked", nothing seeded, for leftover recovery.
 *
 * Red → MERGE THE LARGEST PASSING PREFIX: bisect in queue order, each
 * step the same assemble → check → ff (mergeStack) over a prefix of the changes not yet merged
 * — the first half of the ones the last red check ran over — so every prefix that merges, merges
 * on its own green check with nothing rewritten before its ff. A green prefix merges and the rest
 * of the red run is bisected next; a red one is halved. The one change a red check ran over alone
 * is attributed through main's own baseline (merge-check-failures.ts's attributeRedCheck): main
 * green → rejected with the check's reasons, no pi run; main red → "main_red", pin kept. Its
 * red is the second one observed with it in the tree, so a single flaky run never rejects a change.
 * The changes after it stay unattempted for the next merge. A stack of N with one broken change
 * costs about log2(N) + 1 extra checks, never a second model review.
 *
 * Un-assemblable (a cherry-pick conflict, on the first stack or any prefix) → ABANDON the changes
 * not yet merged to one-at-a-time, in queue order, stopping at the first non-terminal outcome, each
 * through mergeApprovedChange — no second gate and no model run but mergeToMain's conflict
 * resolver. main is never left red: the only bytes this path ff's are a checked tip or per-change
 * merges re-verified in-lock whenever they differ from what their verify judged.
 *
 * An abort is observed between steps, not only by the pi runs it kills: before each
 * assembly-and-check attempt and before each one-change or fallback merge, so a stopping merge
 * ends at its next step boundary (BUGS.md 2026-09-23). A shared check that has already run is
 * followed through: its fast-forward is the merge's bounded commit point.
 *
 * Returns one result per request in order; `undefined` means unattempted (behind a bisect's
 * attributed change, or a fallback early stop) — entry and ref kept for the next merge. On an
 * abort every request without a result reads "aborted" (refs kept). `wiringFor` must return the
 * same wiring for a role on every call (its usage accumulator is the merge's). Never throws for a
 * failed merge — per-change mergeApprovedChange failures degrade to "error", and so does a throw
 * from any bisect step after the first stack attempt, on the change at the front of that step (a
 * prefix may already be on main, and a throw would lose its "changed"); only the first stack
 * attempt's git plumbing propagates, and the merge slot then keeps every entry. */
export async function mergeApproved(
  ctx: BatchContext,
  approved: MergeRequest[],
  wiringFor: (role: string) => BatchRoleWiring,
): Promise<Array<TickResult | undefined>> {
  const results: Array<TickResult | undefined> = approved.map(() => undefined);
  const report = (s: number, status: MergeChangeStatus): void => ctx.onChangeStatus?.(approved[s]!.role, status);
  const mergerCtx = (w: BatchRoleWiring): MergerContext => ({
    root: ctx.root,
    mainBranch: ctx.mainBranch,
    config: ctx.config,
    state: w.state,
    runPi: w.runPi,
    runGatePi: (opts) => w.runGatePi(opts),
    foldUsage: w.foldUsage,
    signal: ctx.signal,
  });
  let aborted = false;
  // Every finalized result goes through here: record it, then hand it to the caller's
  // onResult (the drain's per-change write-back) so settling does not wait behind a slower
  // batch-mate's conflict resolver (BUGS.md 2026-10-09).
  const emit = async (s: number, result: TickResult): Promise<void> => {
    results[s] = result;
    await ctx.onResult?.(s, result);
  };
  const finish = (): Array<TickResult | undefined> =>
    aborted ? results.map((r) => r ?? "aborted") : results;
  // The merge step the degenerate case and the abandon fallback share: merge one request
  // through mergeApprovedChange on its role's wiring, and degrade a throw to "error" on that
  // change (its ref kept for recovery) with the reason on the role's state — a throw means
  // this change's plumbing failed, never that an earlier one is lost (see the catches below
  // and test/merger-errors.test.ts, which pins the degradation).
  const mergeOne = async (s: number, req: MergeRequest): Promise<void> => {
    try {
      await emit(s, await mergeApprovedChange(mergerCtx(wiringFor(req.role)), req));
    } catch (err) {
      wiringFor(req.role).state.lastError = errorMessage(err);
      await emit(s, "error");
    }
  };

  // ── The degenerate case: one approved change merges on its own ──────────────────────────
  if (approved.length === 1) {
    const req = approved[0]!;
    report(0, "merging");
    await mergeOne(0, req);
    return results;
  }

  // ── Assemble the stack in the shared `_merge` checkout: ONE check over the whole tree, and
  // on a red one, the largest passing prefix
  // The shared `_merge` checkout hosts every assembly and the attribution's baseline check:
  // the drain is serial, so one checkout is enough, and no verify runs for a role while its
  // change is being merged (plans/worktree-pool.md, part 2c).
  const wtPath = mergeWorktreePath(ctx.root);
  const entries: StackEntry[] = approved.map((req) => ({ role: req.role, sha: req.sha, summary: req.summary }));
  let abandon = false;
  // Every stacked change is merging now: they share the assembly, the check, and the ff.
  for (let s = 0; s < approved.length; s++) report(s, "merging");
  // Stack positions [0, mergeDoneCount) are on main. `suspect` is how many of the rest, from the
  // front, the last red check ran over — the prefix that still holds what broke it; null when
  // no red check stands against the rest, which are then tried together.
  let mergeDoneCount = 0;
  let suspect: number | null = null;
  while (mergeDoneCount < entries.length) {
    const front = mergeDoneCount;
    const size: number = suspect === null ? entries.length - front : suspect === 1 ? 1 : Math.floor(suspect / 2);
    const firstAttempt = front === 0 && suspect === null;
    let outcome: StackOutcome;
    try {
      outcome = await mergeStack(ctx, wtPath, entries.slice(front, front + size));
      if (outcome.kind === "red" && size === 1) {
        // The one change this red check ran over alone: attribute it, and leave every change
        // after it unattempted for the next drain.
        const { state } = wiringFor(entries[front]!.role);
        const entry = entries[front]!;
        await emit(front, await attributeRedCheck(ctx, entry.role, entry.sha, "merge check", outcome, state));
        report(front, "done");
        break;
      }
    } catch (err) {
      // The first attempt's plumbing propagates, as it always has — nothing has merged. A
      // later step's degrades to "error" on the change at its front (ref kept for recovery),
      // the rest unattempted, so the prefixes already on main keep their "changed".
      if (firstAttempt) throw err;
      wiringFor(entries[front]!.role).state.lastError = errorMessage(err);
      await emit(front, "error");
      report(front, "done");
      break;
    }
    if (outcome.kind === "landed") { // vocabulary-ok: persisted state value or event type, renamed by a later series
      for (let s = front; s < front + size; s++) {
        await emit(s, "changed");
        report(s, "done");
      }
      mergeDoneCount += size;
      // The shared `_merge` checkout persists across merges, so a merged stack leaves it.
      // What broke the red run is still in its remainder, unless this prefix WAS that run —
      // then the red did not reproduce, and the rest are tried together.
      suspect = suspect !== null && suspect > size ? suspect - size : null;
    } else if (outcome.kind === "red") {
      suspect = size; // what broke it is in this prefix: halve it next
    } else if (outcome.kind === "conflict") {
      abandon = true; // main unreadable or a pick conflicted: one-at-a-time from here
      break;
    } else if (outcome.kind === "blocked") {
      // The race was lost on every attempt — main is moving faster than a check completes.
      // Every change not yet merged keeps its ref with "merge_blocked": leftover recovery
      // re-merges each through its own gate + tryMerge, whose in-lock check cannot lose it.
      for (let s = front; s < entries.length; s++) await emit(s, "merge_blocked");
      break;
    } else {
      aborted = true; // every result still undefined reads "aborted" (finish), refs kept
      break;
    }
  }
  if (abandon) {
    // One-at-a-time through mergeApprovedChange, queue order, stopping at the first non-terminal
    // outcome (the rest keep entry + ref for the next merge). Each request merges its approved
    // head (the synced pin its verify judged, not the bare pin) — no second gate, so no model run:
    // re-gating would rebase onto the main the earlier entries just moved, and the rewritten
    // sha misses the approved short-circuit. main is never left red — mergeToMain's in-lock
    // rebase + verifyMerge re-check every change whose tree differs from the one its verify
    // judged. Only the change being merged reads `merging`; the rest are back to awaiting
    // their turn, and each one merged is done.
    for (let s = mergeDoneCount; s < approved.length; s++) report(s, "approved");
    for (let s = mergeDoneCount; s < approved.length; s++) {
      const req = approved[s]!;
      report(s, "merging");
      await mergeOne(s, req);
      if (results[s] === "aborted") aborted = true;
      report(s, "done");
      if (results[s] !== "changed") break;
    }
  }
  // A change the merge stopped short of is out of it (its entry and ref wait for the next
  // merge, or an abort's write-back), so it must not keep a live row meanwhile.
  for (let s = 0; s < approved.length; s++) {
    if (results[s] === undefined) report(s, "done");
  }
  // An abort settles every change without a result as "aborted" here, through onResult, so a
  // stopping merge writes each one back before it returns rather than leaving it to the
  // caller's end-of-batch loop.
  if (aborted) {
    for (let s = 0; s < results.length; s++) {
      if (results[s] === undefined) await emit(s, "aborted");
    }
  }
  return finish();
}
