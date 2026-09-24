/** The two halves of a landing (plans/merge-queue.md 5/5, PLANS.md land-queue speed 2c): the
 * per-change vet (vetRequest) that landing-drain.ts's vetting stage runs for every queued change,
 * and the merge (landVetted) its one merge slot runs over the vetted ones — a stack of two or
 * more sharing a single build check, with a per-change fallback. The shared review gate
 * (reviewPinnedChange) and the one-change landing (landApprovedChange) live beside it in
 * lander.ts. */

import { COMMIT_IDENT, deleteRef, gitLines, gitTry, headOf } from "./git.js";
import { landWorktreePath, landingRefName } from "./paths.js";
import { ensureDetachedWorktree } from "./worktree.js";
import { ffStackToMain } from "./merge.js";
import { type BuildCheckOutcome, describeCheck, failureHeadline, runScopedBuildCheck } from "./build-check.js";
import type { BuildCheck } from "./build-check-detect.js";
import { checkMainBaseline, noteGreenBaseline } from "./main-baseline.js";
import { baselineCheckLogger } from "./main-red.js";
import { logEvent } from "./events.js";
import { saveLoopState } from "./state.js";
import { isExemptDiff } from "./exemptions.js";
import {
  landApprovedChange,
  reviewPinnedChange,
  syncPinToMain,
  type LandRequest,
  type LanderContext,
} from "./lander.js";
import { errorMessage, shortSha } from "./text.js";
import { setLandingStage, type LandingChangeStatus } from "./landing-slot.js";
import type { TumwaterConfig } from "./config-schema.js";
import type { LoopState, PiRunResult, TickResult } from "./types.js";

/** The identity a vet or a merge needs from the harness: root, main branch, live config, and
 * the task's abort signal. Deliberately thinner than LanderContext — no single `state` and no
 * `runPi`, because a merge spans N ROLES (invariant 3 caps a role at one in-flight change, so
 * a stack is N changes from N distinct roles) and each one carries its own wiring. */
export interface BatchContext {
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
export interface BatchRoleWiring {
  state: LoopState;
  /** Fold one pi run's usage into this role's landing counters (the reviewer's run). */
  foldUsage(run: PiRunResult): void;
  /** Run one pi run in `wt` with this role's shared wiring (the conflict resolver). */
  runPi(wt: string, prompt: string, sessionName: string): Promise<PiRunResult>;
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

/** How many times a batch whose fast-forward lost the race to a moved main re-stacks onto the
 * new tip and goes round again before handing every change to leftover recovery as
 * `merge_blocked`. The race window is the whole batch check, and main still has writers
 * outside the land queue (a role's in-tick leftover-recovery landing, a human commit), so a
 * lost race is routine and one re-stack almost always wins it — the second is headroom for a
 * busy stretch. The bound keeps a main that moves faster than a check completes from holding
 * the merge slot (and every vetted landing behind it) indefinitely: each re-stack
 * whose new tree is not doc-only pays one more full check. Past it the per-change path takes
 * over, whose in-lock re-check another harness landing cannot race. */
export const BATCH_RESTACK_ATTEMPTS = 2;

/** One stacked change as the fast-forward lands it: its role, its post-pick sha, its summary. */
type StackEntry = { role: string; sha: string; summary: string };

/** Assemble a batch's stack in `wtPath` (S[0]'s lander worktree) on main's CURRENT tip, once
 * per attempt — a re-stack after a lost fast-forward race is the same assembly on the tip that
 * won. `entries` carry each change's head to land (its synced pin); the result
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
  // One idempotent ensure at the fresh base covers the worktree-a-moment-ago case (the
  // change's vet, or the previous attempt's assembly).
  const wt = await ensureDetachedWorktree(root, wtPath, base);
  const landed: StackEntry[] = [];
  for (const entry of entries) {
    // Cherry-pick the whole RANGE from main's tip to the entry's head to land — `base..sha`,
    // every commit ahead of main, in queue order. A pin is normally one commit, so the range is
    // that commit; picking the range rather than the head alone keeps a pin that carries more
    // from landing only its last diff and orphaning the work beneath it. (Not a
    // rebase: after 2/5 the role branches sit at main and each landing lives only in its
    // pinned ref — there is nothing to rebase.)
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

/** What one landStack call came to: `landed` — main fast-forwarded through every entry;
 * `red` — the check over the stacked tree failed (the check and its outcome, for the reasons);
 * `conflict` — the stack cannot be assembled on main's tip; `blocked` — the fast-forward lost
 * the race to a moved main on every attempt; `aborted` — a stop arrived before an attempt. */
type StackOutcome =
  | { kind: "landed" }
  | { kind: "red"; check: BuildCheck; outcome: BuildCheckOutcome }
  | { kind: "conflict" | "blocked" | "aborted" };

/** Land `entries` — the whole stack, or one bisect prefix of it — as ONE fast-forward on its
 * own green check: assemble them on main's current tip in `wtPath`, run ONE scope-`batch`
 * check over the combined tree, and ff main through the captured shas (ffStackToMain) with
 * nothing rewritten in between — the in-lock invariant. A lost race re-stacks on the tip that
 * won, up to BATCH_RESTACK_ATTEMPTS times, and a re-stack whose tree is the checked tree plus
 * doc-only commits skips its re-check (exemptTreeDelta). On `landed` every entry's ref is
 * deleted and the red-main baseline is seeded with the tip when a check PASSED on exactly it.
 * The check's events log under the first entry's role. */
async function landStack(ctx: BatchContext, wtPath: string, entries: readonly StackEntry[]): Promise<StackOutcome> {
  // The last stacked tip a build check actually ran on: a re-stack whose tree differs from it
  // only in doc-only paths lands on that run's verdict instead of paying another.
  let checkedTip: string | null = null;
  const exemptPaths = ctx.config.review.exemptPaths;
  for (let attempt = 0; attempt <= BATCH_RESTACK_ATTEMPTS; attempt++) {
    // A shutdown (or a user stop for any batched role) before an attempt — the first one
    // included, so a stop that arrived after the last gate (a restart hand-off past its
    // deadline, BUGS.md 2026-09-23) never starts the batch's one expensive shared step.
    if (ctx.signal().aborted) return { kind: "aborted" };
    const landed = await assembleStack(ctx.root, ctx.mainBranch, wtPath, entries);
    if (landed === null) return { kind: "conflict" }; // main unreadable or a pick conflicted
    const tip = landed.at(-1)!.sha;
    // The expensive deterministic half, shared: ONE run over the combined tree. Outcome
    // routing — null: no declared check, land directly; "failed": red or a merge-scope
    // timeout, the caller bisects; "skipped": no npm / broken toolchain (the helper warned),
    // proceed — never fail-closed; "passed": green. A re-stack skips the run only when its
    // tree is the checked tree plus doc-only changes (exemptTreeDelta).
    let seed: string | undefined; // the tip a PASSED check ran on exactly, seeded after the ff
    const docOnlyRestack = checkedTip !== null && (await exemptTreeDelta(ctx.root, checkedTip, tip, exemptPaths));
    if (!docOnlyRestack) {
      // The landing cell names the check while it runs, then the merge steps after it — the ff
      // or what the caller does next — on every stacked change's own record.
      for (const e of entries) setLandingStage(ctx.root, e.role, "build-check");
      const check = await runScopedBuildCheck(ctx.root, entries[0]!.role, "batch", wtPath, ctx.config);
      for (const e of entries) setLandingStage(ctx.root, e.role, "merging");
      if (check !== null && check.outcome.status === "failed") return { kind: "red", ...check };
      checkedTip = tip;
      if (check !== null && check.outcome.status === "passed") seed = tip;
    }
    if ((await ffStackToMain(ctx.root, ctx.mainBranch, landed)) === "changed") {
      // A PASSED stack check ran on exactly the future main tip — seed the red-main
      // baseline after (not before) the successful ff, so a merge_blocked stack seeds
      // nothing; a skipped check seeds nothing either (skips never seed), and neither does
      // a doc-only re-stack (like verifyLanding's exempt arm: nothing ran on this tip).
      if (seed !== undefined) noteGreenBaseline(seed);
      for (const e of entries) await deleteRef(ctx.root, landingRefName(e.role));
      return { kind: "landed" };
    }
    // Main moved under the batch while the check ran (a role's in-tick leftover-recovery
    // landing, or a human commit): diverged history, ff failed. Re-stack on the tip that won.
  }
  return { kind: "blocked" };
}

/** A red check's machine-generated reasons, in the gate pre-check's shape (review.ts): the
 * headline — failureHeadline's first line that is not a stack frame — joined to the rest of
 * the clipped tail, so the compiler error sits right after it in the author's next-tick note. */
function checkFailureReasons(check: BuildCheck, outcome: BuildCheckOutcome): string[] {
  const tail = outcome.outputTail ?? [];
  const headline = failureHeadline(tail);
  const what = describeCheck(check);
  return headline !== undefined
    ? [`build check failed (${what}): ${headline}`, ...tail.filter((l) => l !== headline)]
    : [`build check failed (${what})`];
}

/** Attribute a red check that ran over ONE change alone on main's tip — the bisect's last
 * step — by the gate's rule (PLANS.md land-queue 1/3): ask main's own baseline at its current
 * tip, checked out pristine in `wtPath` (usually a cache hit: every landing seeds the SHA it
 * moved main to, the bisect's own prefix landings included). Main green → the change broke
 * the check: reject it exactly as the gate's deterministic reject does — reasons in
 * lastReview for the author's next tick, the strike count reset, ref deleted,
 * review_rejected logged, no pi run. Main red → not this change's failure: "main_red" with
 * the ref kept and unreviewFailures untouched, so recovery re-lands it once main-red.ts's
 * repair turns main green. Baseline unavailable (an environmental skip, or main unreadable)
 * → reject, the safe default, and the reasons say so. Returns the change's result; the
 * verdict is persisted before it returns. */
async function attributeRedChange(
  ctx: BatchContext,
  wtPath: string,
  entry: StackEntry,
  red: { check: BuildCheck; outcome: BuildCheckOutcome },
  state: LoopState,
): Promise<TickResult> {
  const tip = await gitTry(ctx.root, "rev-parse", ctx.mainBranch);
  let baseline: Awaited<ReturnType<typeof checkMainBaseline>> = { baseline: null };
  if (tip !== null) {
    await ensureDetachedWorktree(ctx.root, wtPath, tip);
    baseline = await checkMainBaseline(wtPath, ctx.config, baselineCheckLogger(ctx.root, entry.role));
  }
  if (baseline.baseline?.status === "red") {
    state.lastError = `batch check failed: main ${shortSha(tip)} is red — not this change's failure`;
    saveLoopState(ctx.root, state);
    return "main_red";
  }
  const reasons = checkFailureReasons(red.check, red.outcome);
  if (baseline.baseline === null) {
    const why =
      tip === null
        ? "main is unreadable"
        : baseline.skipReason
          ? `its check was skipped: ${baseline.skipReason}`
          : "no declared check";
    reasons.push(`main's own baseline was unavailable (${why}), so the red check is attributed to this change`);
  }
  state.lastReview = { verdict: "reject", reasons, head: entry.sha, at: Date.now() };
  state.unreviewFailures = 0;
  saveLoopState(ctx.root, state);
  await deleteRef(ctx.root, landingRefName(entry.role));
  logEvent(ctx.root, { loop: entry.role, type: "review_rejected", head: entry.sha, reasons });
  return "rejected";
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
 * is attributed through main's own baseline (attributeRedChange): main green → rejected with the
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
    foldUsage: w.foldUsage,
    signal: ctx.signal,
  });
  let aborted = false;
  const finish = (): Array<TickResult | undefined> =>
    aborted ? results.map((r) => r ?? "aborted") : results;

  // ── The degenerate case: one vetted change lands on its own ──────────────────────────
  if (vetted.length === 1) {
    const req = vetted[0]!;
    report(0, "landing");
    try {
      results[0] = await landApprovedChange(landerCtx(wiringFor(req.role)), req);
    } catch (err) {
      results[0] = "error";
      wiringFor(req.role).state.lastError = errorMessage(err);
    }
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
        results[front] = await attributeRedChange(ctx, wtPath, entries[front]!, outcome, state);
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
      try {
        const result = await landApprovedChange(landerCtx(wiringFor(req.role)), req);
        results[s] = result;
        if (result === "aborted") aborted = true;
      } catch (err) {
        results[s] = "error";
        wiringFor(req.role).state.lastError = errorMessage(err);
      }
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
