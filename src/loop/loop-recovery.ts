import type { TickOutcome } from "../tick/tick-outcome.js";
import type { LoopState } from "./loop-state.js";
import type { PendingPrompt } from "../inbox/pending-prompt.js";
import { setRef } from "../git/git.js";
import { resetWorktreeToMain } from "../git/worktree.js";
import { landingRefName } from "../paths.js";
import { shortSha } from "../text/format.js";
import type { LeftoverRecovery } from "./leftover.js";

/** What the recovery phases need from their `LoopRunner` host. `setRecoveryFailure` writes the
 * landing failure back to the runner's field (which `tick` reads at finalize time) instead of
 * the phase reaching into a runner instance. */
interface RecoveryContext {
  root: string;
  role: string;
  mainBranch: string;
  state: LoopState;
  pending: PendingPrompt;
  warn(message: string): void;
  setRecoveryFailure(message: string | undefined): void;
}

/** Finish a tick whose pi run was killed mid-flight — shared by the author-run and review-
 * gate abort branches, which have identical semantics; only what the kill left behind
 * differs (half-done edits vs. the fully committed change under review), and
 * resetWorktreeToMain discards both. A user-initiated abort is a decision, not an
 * interruption: discard the work AND do NOT requeue a director prompt (the explicit stop IS
 * the answer to that request; shutdowns still requeue), backing off normally instead of
 * resuming promptly. Known limitation: if the marker was consumed while this tick sat in its
 * short git-only commit/merge window (no pi run in flight), the flag takes effect at the next
 * model-run boundary within the tick — or, for a tick that reaches no further pi run,
 * completes normally and the abort had no effect; re-issuing is the remedy.
 * `userAborted`/`handedBack` are read from the runner's live flags: an explicit abort discards
 * the request; a budget handback names its resume cause; a plain shutdown requeues the prompt. */
export async function finishAbortedTickPhase(
  ctx: RecoveryContext,
  userPrompt: string | null,
  wt: string,
  userAborted: boolean,
  handedBack: boolean,
): Promise<TickOutcome> {
  if (userAborted) {
    // An explicit abort discards the request itself too: clear the dequeued prompt here —
    // required on the author-run path (whose early return skips runTick's shared clearing),
    // a no-op on the review-gate path (already cleared after the author run).
    ctx.pending.clear();
    await resetWorktreeToMain(wt, ctx.mainBranch);
    return { result: "user_aborted" };
  }
  // Shutdown mid-run: fail closed — a director prompt goes back to the inbox like any other
  // unfulfilled abort (mid-review the commit stays on the branch for re-review; mid-author-
  // run its half-done edits are discarded by the next tick's reset). A role's re-queued
  // prompt rides the resume that follows (mid-review the fresh recovery dequeues it like any
  // other tick instead — the flag is cleared and never reclaimed there).
  ctx.pending.requeueForResume(ctx.state, userPrompt);
  // A budget handback is an interruption with a named cause: the resumed session's bridge
  // prompt says the run was moved back to the primary model, not that the harness restarted.
  return handedBack ? { result: "aborted", resumeCause: "budget-resumed" } : { result: "aborted" };
}

/** Pin `sha` by this role's landing ref and free the worktree (plans/merge-queue.md invariant
 * 4): the pin must exist BEFORE resetWorktreeToMain moves the branch, or the commit is
 * orphaned. Returns false when the pin write failed — the caller then leaves the commit on its
 * branch (no reset) and defers to next-tick recovery, which adopts it into the pin scheme.
 * After a successful pin the review gate and the rebase run in the vet's leased pool slot —
 * never in this worktree (merge queue 2/5). */
export async function pinAndResetPhase(ctx: RecoveryContext, wt: string, sha: string): Promise<boolean> {
  const pinned = await setRef(ctx.root, landingRefName(ctx.role), sha);
  if (!pinned) {
    ctx.warn(
      `failed to pin ${shortSha(sha)} by its landing ref — leaving the commit on the branch for next-tick recovery`,
    );
    return false;
  }
  await resetWorktreeToMain(wt, ctx.mainBranch);
  return true;
}

/** End a tick whose leftover recovery found work to salvage (src/loop/leftover.ts) without an
 * authoring run — the leftover owns the role's one landing ref until its landing resolves. A
 * tick's dequeued user prompt goes back to its queue, since nothing ran it. A pin put on
 * the land queue ends the tick `queued` exactly like a fresh changed tick (the land-queue
 * interlock then holds the role until the slot lands it) and frees the worktree, the pin now
 * holding the commit. When the pin is left over from a landing that failed non-terminally
 * (`priorLandingFailure`), re-queuing it is a retry of a PERSISTENT failure the `queued` result
 * cannot express, so it rides the outcome's recoveryFailure into the error streak and the
 * warning that names the stuck gate (BUGS.md 2026-09-21). A role whose landing is still queued
 * ends `queued` on that entry — nothing enqueued twice, nothing reset. A leftover that could
 * not be pinned stays on the branch and the tick fails like a fresh tick's failed pin. Every
 * arm is `recoveredLeftover`: no model ran, so the tick is no evidence about the backend. */
export async function finishRecoveryTickPhase(
  ctx: RecoveryContext,
  recovered: Exclude<LeftoverRecovery, { kind: "discarded" } | { kind: "handback" }>,
  userPrompt: string | null,
  wt: string,
  priorLandingFailure: string | undefined,
): Promise<TickOutcome> {
  ctx.pending.clear();
  ctx.pending.requeueUnfulfilled(userPrompt);
  if (recovered.kind === "unpinned") {
    ctx.state.lastError = `failed to pin leftover ${shortSha(recovered.sha)} by its landing ref; left for next-tick recovery`;
    return { result: "error", summary: ctx.state.lastError, recoveredLeftover: true };
  }
  if (recovered.kind === "held") {
    // A permanent reviewer configuration error holds the pin: do not re-queue (and pay
    // another gate check) until the model config changes. Ending `error` schedules the error
    // ladder, so the hold is re-checked at backoff pace rather than at suite speed
    // (BUGS.md 2026-10-06).
    ctx.state.lastError = recovered.message;
    return { result: "error", summary: recovered.message, recoveredLeftover: true };
  }
  const { entry } = recovered;
  if (recovered.kind === "enqueued") {
    ctx.setRecoveryFailure(priorLandingFailure);
    await resetWorktreeToMain(wt, ctx.mainBranch);
  }
  return {
    result: "queued",
    summary: entry.summary,
    commit: entry.sha,
    highFriction: entry.highFriction,
    recoveredLeftover: true,
  };
}
