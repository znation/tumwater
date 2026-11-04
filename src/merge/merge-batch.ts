/** The per-change verify (verifyRequest) that merge-verify.ts's verify stage runs for every
 * queued change before it may merge. The stack merger mergeApproved once lived here (a stack of
 * two or more sharing a single scope-`batch` build check with a largest-passing-prefix bisect,
 * in merge-stack.ts) — it is gone: a merge is a rebase and a fast-forward, one change at a time
 * through mergeApprovedChange (merge-core.ts), so this module holds only the still-alive
 * pre-merge verify gate. The shared review gate (reviewPinnedChange) and the one-change merge
 * (mergeApprovedChange) live beside it in merge-core.ts. */

import { leaseSlot, type SlotLeaseHandle } from "../git/worktree-pool.js";
import { slotCount } from "../config/config.js";
import {
  reviewQueuedChange,
  type MergeRequest,
  type MergeScopeContext,
} from "./merge-core.js";
import { errorMessage } from "../text/text.js";
import { dropWithdrawnPin, withdrawnPinReason } from "./merge-withdrawn.js";
import type { MergeChangeStatus } from "./merge-slot.js";
import type { RunResult } from "../run/run-outcome.js";
import type { GateRunsPi, PiRunWiring } from "../runner/runner-pi.js";
import type { RunnerState } from "../runner/runner-state.js";

/** The identity a verify needs from the harness: root, main branch, live config, and the task's
 * abort signal. Deliberately thinner than MergerContext — no single `state` and no `runPi`. */
export interface BatchContext extends GateRunsPi, MergeScopeContext {
  /** Called as the merge reaches each change (by role — one change per role in a merge): the
   * drain mirrors it into the 4/5 marker's per-change records (setMergeChangeStatus) so each row
   * reads its own change's state; absent for callers with no marker to keep. */
  onChangeStatus?(role: string, status: MergeChangeStatus): void;
  /** Called once per change the moment its result is final. Absent for callers that settle the
   * returned array themselves. */
  onResult?(index: number, result: RunResult): void | Promise<void>;
}

/** One change's wiring, resolved by the drain from its authoring runner: the live state object
 * the gate updates and the drain folds the outcome into, this role's usage fold (reviewer spend
 * charges to the authoring role), and the role's shared pi wiring. */
export interface BatchRoleWiring extends PiRunWiring {
  state: RunnerState;
}

/** One change's verify verdict: `approved` — the gate cleared (approved or exempt), so the
 * change merges at `sha` (the synced pin, which the merge ref now names), with `verifiedHead`
 * set when the gate's pre-check ran green on exactly that head; `result` — an outcome that
 * keeps the change out of the merge: rejected, review_error (`discarded` on a strike-cap
 * discard), a lost-pin "error", or aborted. */
export type VerifyVerdict =
  | { kind: "approved"; sha: string; verifiedHead?: string }
  | { kind: "result"; result: RunResult; discarded?: true };

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
  // A change whose backlog entry main no longer lists never merges (merge-withdrawn.ts). Asked
  // before the slot lease and syncPinToMain's rebase, while the pin's merge-base with main still
  // lists every entry the change moved: the rebase would carry its base past the removal.
  const withdrawn = await withdrawnPinReason(ctx.root, ctx.mainBranch, req, req.sha);
  if (withdrawn !== null) {
    await dropWithdrawnPin(ctx.root, req.role, w.state, withdrawn);
    return { kind: "result", result: "withdrawn" };
  }
  let lease: SlotLeaseHandle;
  try {
    lease = await leaseSlot(ctx.root, {
      role: req.role,
      purpose: "verify",
      ref: req.sha,
      signal: ctx.signal(),
      // The live view's pool budget, same rule as the run path: a broken tumwater.json
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
  const outcome = await reviewQueuedChange(ctx, req, wt, w.state, w.foldUsage);
  if (outcome.kind === "result") return outcome;
  // The gate's green pre-check names the head it ran on; it rides to the merge, which seeds the
  // red-main baseline with it when nothing moved in between (mergeToMain).
  const { verifiedHead } = outcome.gate;
  return verifiedHead === outcome.sha
    ? { kind: "approved", sha: outcome.sha, verifiedHead }
    : { kind: "approved", sha: outcome.sha };
}
