/** Two of the three halves of a landing (plans/merge-queue.md 5/5, PLANS.md land-queue speed
 * 2c): the per-change vet (vetRequest) that landing-vetting.ts's vetting stage runs for every
 * queued change, and the merge (landVetted) its one merge slot runs over the vetted ones — a
 * stack of two or more sharing a single build check, with a per-change fallback. The stack
 * lander landVetted drives (assemble → one shared check → ff, with re-stack and bisect) lives
 * beside it in landing-stack.ts. The shared review gate (reviewPinnedChange) and the
 * one-change landing (landApprovedChange) live beside both in landing-core.ts. */

import { ensureDetachedWorktree } from "../worktree.js";
import { removeLandWorktree } from "../git/git.js";
import { landWorktreePath } from "../paths.js";
import {
  landApprovedChange,
  reviewPinnedChange,
  syncPinToMain,
  type LandRequest,
  type LanderContext,
} from "./landing-core.js";
import { attributeRedCheck } from "./landing-check-failures.js";
import { errorMessage } from "../text/text.js";
import { type LandingChangeStatus } from "./landing-slot.js";
import { landStack, type StackEntry, type StackOutcome } from "./landing-stack.js";
import type { TumwaterConfig } from "../config/config-schema.js";
import type { TickResult } from "../tick/tick-outcome.js";
import type { GateRunsPi, PiRunWiring } from "../loop/loop-pi.js";
import type { LoopState } from "../loop/loop-state.js";

/** The identity a vet or a merge needs from the harness: root, main branch, live config, and
 * the task's abort signal. Deliberately thinner than LanderContext — no single `state` and no
 * `runPi`, because a merge spans N ROLES (invariant 3 caps a role at one in-flight change, so
 * a stack is N changes from N distinct roles) and each one carries its own wiring. */
export interface BatchContext extends GateRunsPi {
  root: string;
  mainBranch: string;
  config: TumwaterConfig;
  /** The task's abort signal (harness shutdown or a deliberate `abort --role` for any of its
   * roles), fresh per call. */
  signal(): AbortSignal;
  /** Called as the merge reaches each change (by role — one change per role in a merge): it
   * starts working on it (`landing` — the stack, or the change's own one-at-a-time landing),
   * hands it back to wait its turn in an abandoned stack's fallback (`vetted`), or is finished
   * with it (`done`). The drain mirrors it into the 4/5 marker's per-change records
   * (setLandingChangeStatus) so each row reads its own change's state; absent for callers with
   * no marker to keep. */
  onChangeStatus?(role: string, status: LandingChangeStatus): void;
}

/** One change's wiring, resolved by the drain from its authoring runner: the live state object
 * the gate updates and the drain folds the outcome into, this role's usage fold (reviewer spend
 * charges to the authoring role), and the role's shared pi wiring for landApprovedChange's
 * conflict resolver. */
export interface BatchRoleWiring extends PiRunWiring {
  state: LoopState;
}

/** One change's vetting verdict: `stack` — approved or exempt, to land at `sha` (the synced
 * pin, which the landing ref now names), with `verifiedHead` set when the gate's pre-check ran
 * green on exactly that head; `result` — an outcome that keeps the change out of the merge:
 * rejected, review_error (`discarded` on a strike-cap discard), main_red, a lost-pin "error",
 * or aborted. */
export type VetVerdict =
  | { kind: "stack"; sha: string; verifiedHead?: string }
  | { kind: "result"; result: TickResult; discarded?: true };

/** Vet one request — the whole of a vetting-stage task: check its pin out detached in the
 * role's own lander worktree, rebase it onto main's current tip (syncPinToMain — so the head
 * approved here is the head its merge starts from, and a conflict leaves the pin for the gate
 * and, at the merge, mergeToMain's resolver), and run the review gate, the verdict persisted
 * immediately by reviewPinnedChange (the drain's write-back of an approved change happens only
 * once it lands, so a crash must not lose what the vet earned). The rebase touches only this
 * role's worktree and ref, onto main itself, so two vets rebasing at once — or one rebasing
 * while a merge moves main — cannot interfere. */
export async function vetRequest(ctx: BatchContext, req: LandRequest, w: BatchRoleWiring): Promise<VetVerdict> {
  let wt: string;
  try {
    wt = await ensureDetachedWorktree(ctx.root, landWorktreePath(ctx.root, req.role), req.sha);
  } catch (err) {
    // The queue entry outlived its pinned commit — the land queue outlives the ref by design
    // (a crash between pin and drop, or an outside gc), so a checkout of `req.sha` can fail
    // with the commit gone. Degrade to a terminal "error" for this request so the drain drops
    // its entry and the queue advances; a throw would keep the entry, and a lost pin would then
    // re-fail every poll with its author interlocked forever. The error is on the state before
    // the caller settles it, so the drain's write-back persists it.
    w.state.lastError = errorMessage(err);
    return { kind: "result", result: "error" };
  }
  const synced = await syncPinToMain(ctx, wt, req);
  const outcome = await reviewPinnedChange(ctx, synced, wt, w.state, w.foldUsage);
  if (outcome.kind === "result") return outcome;
  // The gate's green pre-check names the head it ran on; it rides to the merge, whose in-lock
  // re-check seeds the red-main baseline with it when nothing moved in between (mergeToMain).
  const { verifiedHead } = outcome.gate;
  return verifiedHead === outcome.sha ? { kind: "stack", sha: outcome.sha, verifiedHead } : { kind: "stack", sha: outcome.sha };
}

/** Land changes whose own vet already approved them — the merge slot's whole task
 * (landing-drain.ts, land-queue speed 2c), over every vetted entry up to landBatchMax. `vetted`
 * is in queue order, each request at the head its vet approved (the synced pin its landing ref
 * names); none is gated again, so no model review runs here (an adversarial review of a stack
 * would blur which change a criticism applies to, so each change was reviewed alone). The flow:
 *
 * One change — land it through landApprovedChange: git + ff, plus an in-lock scope-`landing`
 * re-check whenever main moved since its vet (and a seeded baseline when it did not and its vet's
 * pre-check ran green on exactly that head).
 *
 * Two or more — assemble the stack in S[0]'s lander worktree, checked out detached at main's
 * CURRENT tip, then cherry-pick each change's full range from that tip to its head to land, in
 * queue order — `base..sha`, every commit ahead of main (normally one), capturing each
 * post-pick tip — and run ONE scope-`batch` runScopedBuildCheck over the combined tree: the
 * expensive, deterministic half the stack shares. null (no declared check) → land directly;
 * "failed" (a red tree or a timeout remapped to a reject — the tree is unverified) → bisect;
 * "skipped" (no npm / broken toolchain — the helper already warned) → proceed, never
 * fail-closed; "passed" → green. Green: under the merge lock, ffStackToMain ff's main through
 * the stack in ONE fast-forward, emits one `merged` event per change, and — only when the check
 * PASSED on exactly that tip — seeds noteGreenBaseline with the stacked tip. ff failure (main
 * moved while the check ran: the window is the whole check, and main still has writers outside
 * the land queue) → RE-STACK: assemble the same changes afresh on main's new tip and go round
 * again, up to BATCH_RESTACK_ATTEMPTS times, stopping before any attempt on an abort. A
 * re-stacked tree that differs from the last tree a check ran on only in review-exempt paths
 * goes straight to the ff; any other re-stack pays one more check. Only a race lost on every
 * attempt leaves each change not yet landed its ref with "merge_blocked", nothing seeded, for
 * leftover recovery.
 *
 * Red → LAND THE LARGEST PASSING PREFIX (PLANS.md land-queue 3d): bisect in queue order, each
 * step the same assemble → check → ff (landStack) over a prefix of the changes not yet landed —
 * the first half of the ones the last red check ran over — so every prefix that lands, lands on
 * its own green check with nothing rewritten before its ff. A green prefix lands and the rest of
 * the red run is bisected next; a red one is halved. The one change a red check ran over alone
 * is attributed through main's own baseline (landing-check-failures.ts's attributeRedCheck): main green → rejected with the
 * check's reasons, no pi run; main red → "main_red", pin kept. Its red is the second one observed
 * with it in the tree, so a single flaky run never rejects a change. The changes after it stay
 * unattempted for the next merge. A stack of N with one broken change costs about log2(N) + 1
 * extra checks, never a second model review.
 *
 * Un-assemblable (a cherry-pick conflict, on the first stack or any prefix) → ABANDON the changes
 * not yet landed to one-at-a-time, in queue order, stopping at the first non-terminal outcome,
 * each through landApprovedChange — no second gate and no model run but mergeToMain's conflict
 * resolver. main is never left red: the only bytes this path ff's are a checked tip or
 * per-change landings re-verified in-lock whenever they differ from what their vet judged.
 *
 * An abort is observed between steps, not only by the pi runs it kills: before each
 * assembly-and-check attempt and before each one-change or fallback landing, so a stopping merge
 * ends at its next step boundary (BUGS.md 2026-09-23). A shared check that has already run is
 * followed through: its fast-forward is the merge's bounded commit point.
 *
 * Returns one result per request in order; `undefined` means unattempted (behind a bisect's
 * attributed change, or a fallback early stop) — entry and ref kept for the next merge. On an
 * abort every request without a result reads "aborted" (refs kept). `wiringFor` must return
 * the same wiring for a role on every call (its usage accumulator is the landing's). Never
 * throws for a failed landing — per-change landApprovedChange failures degrade to "error", and
 * so does a throw from any bisect step after the first stack attempt, on the change at the front
 * of that step (a prefix may already be on main, and a throw would lose its "changed"); only the
 * first stack attempt's git plumbing propagates, and the merge slot then keeps every entry. */
export async function landVetted(
  ctx: BatchContext,
  vetted: LandRequest[],
  wiringFor: (role: string) => BatchRoleWiring,
): Promise<Array<TickResult | undefined>> {
  const results: Array<TickResult | undefined> = vetted.map(() => undefined);
  const report = (s: number, status: LandingChangeStatus): void => ctx.onChangeStatus?.(vetted[s]!.role, status);
  const landerCtx = (w: BatchRoleWiring): LanderContext => ({
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
  const finish = (): Array<TickResult | undefined> =>
    aborted ? results.map((r) => r ?? "aborted") : results;
  // The landing step the degenerate case and the abandon fallback share: land one request
  // through landApprovedChange on its role's wiring, and degrade a throw to "error" on that
  // change (its ref kept for recovery) with the reason on the role's state — a throw means
  // this change's plumbing failed, never that an earlier one is lost (see the catches below
  // and test/lander-errors.test.ts, which pins the degradation).
  const landOne = async (s: number, req: LandRequest): Promise<void> => {
    try {
      results[s] = await landApprovedChange(landerCtx(wiringFor(req.role)), req);
    } catch (err) {
      results[s] = "error";
      wiringFor(req.role).state.lastError = errorMessage(err);
    }
  };

  // ── The degenerate case: one vetted change lands on its own ──────────────────────────
  if (vetted.length === 1) {
    const req = vetted[0]!;
    report(0, "landing");
    await landOne(0, req);
    return results;
  }

  // ── Assemble the stack in S[0]'s lander worktree: ONE check over the whole tree, and on a
  // red one, the largest passing prefix
  // S[0]'s lander worktree hosts every assembly (its vet used it too) and the attribution's
  // baseline check: the merge owns it for the whole stack — no vet runs for a role while its
  // change is being merged.
  const wtPath = landWorktreePath(ctx.root, vetted[0]!.role);
  const entries: StackEntry[] = vetted.map((req) => ({ role: req.role, sha: req.sha, summary: req.summary }));
  let abandon = false;
  // Every stacked change is landing now: they share the assembly, the check, and the ff.
  for (let s = 0; s < vetted.length; s++) report(s, "landing");
  // Stack positions [0, landedCount) are on main. `suspect` is how many of the rest, from the
  // front, the last red check ran over — the prefix that still holds what broke it; null when
  // no red check stands against the rest, which are then tried together.
  let landedCount = 0;
  let suspect: number | null = null;
  while (landedCount < entries.length) {
    const front = landedCount;
    const size: number = suspect === null ? entries.length - front : suspect === 1 ? 1 : Math.floor(suspect / 2);
    const firstAttempt = front === 0 && suspect === null;
    let outcome: StackOutcome;
    try {
      outcome = await landStack(ctx, wtPath, entries.slice(front, front + size));
      if (outcome.kind === "red" && size === 1) {
        // The one change this red check ran over alone: attribute it, and leave every change
        // after it unattempted for the next drain.
        const { state } = wiringFor(entries[front]!.role);
        const entry = entries[front]!;
        results[front] = await attributeRedCheck(ctx, entry.role, entry.sha, "batch check", outcome, state, wtPath);
        report(front, "done");
        break;
      }
    } catch (err) {
      // The first attempt's plumbing propagates, as it always has — nothing has landed. A
      // later step's degrades to "error" on the change at its front (ref kept for recovery),
      // the rest unattempted, so the prefixes already on main keep their "changed".
      if (firstAttempt) throw err;
      results[front] = "error";
      wiringFor(entries[front]!.role).state.lastError = errorMessage(err);
      report(front, "done");
      break;
    }
    if (outcome.kind === "landed") {
      for (let s = front; s < front + size; s++) {
        results[s] = "changed";
        report(s, "done");
      }
      landedCount += size;
      // Terminal outcome once the whole stack is on main: release the shared lander worktree.
      if (front + size === entries.length) await removeLandWorktree(ctx.root, wtPath);
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
      // Every change not yet landed keeps its ref with "merge_blocked": leftover recovery
      // re-lands each through its own gate + tryMerge, whose in-lock check cannot lose it.
      for (let s = front; s < entries.length; s++) results[s] = "merge_blocked";
      break;
    } else {
      aborted = true; // every result still undefined reads "aborted" (finish), refs kept
      break;
    }
  }
  if (abandon) {
    // One-at-a-time through landApprovedChange, queue order, stopping at the first non-terminal
    // outcome (the rest keep entry + ref for the next merge). Each request lands its approved
    // head (the synced pin its vet judged, not the bare pin) — no second gate, so no model run:
    // re-gating would rebase onto the main the earlier entries just moved, and the rewritten
    // sha misses the approved short-circuit. main is never left red — mergeToMain's in-lock
    // rebase + verifyLanding re-check every change whose tree differs from the one its vet
    // judged. Only the change being landed reads `landing`; the rest are back to awaiting
    // their turn, and each one landed is done.
    for (let s = landedCount; s < vetted.length; s++) report(s, "vetted");
    for (let s = landedCount; s < vetted.length; s++) {
      const req = vetted[s]!;
      report(s, "landing");
      await landOne(s, req);
      if (results[s] === "aborted") aborted = true;
      report(s, "done");
      if (results[s] !== "changed") break;
    }
  }
  // A change the merge stopped short of is out of it (its entry and ref wait for the next
  // merge, or an abort's write-back), so it must not keep a live row meanwhile.
  for (let s = 0; s < vetted.length; s++) {
    if (results[s] === undefined) report(s, "done");
  }
  return finish();
}
