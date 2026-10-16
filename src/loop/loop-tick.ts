// vocabulary: plain
import type { TumwaterConfig } from "../config/config-schema.js";
import type { TickOutcome, TickResult } from "../tick/tick-outcome.js";
import type { PiRunResult } from "../pi/pi-run-result.js";
import type { LoopState } from "./loop-state.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";
import { branchExists, deleteRef, commitMessage, changeBaseRev, headOf } from "../git/git.js";
import { git, gitTry } from "../git/git-run.js";
import { abortSync, ensureWorktree, resetWorktreeToMain } from "../git/worktree.js";
import { leaseSlot } from "../git/worktree-pool.js";
import { slotCount } from "../config/config.js";
import { useWorktree } from "../git/worktree-use.js";
import { branchName, worktreePath, landingRefName, rejectedRefName } from "../paths.js";
import { logEventBestEffort } from "../events/events.js";
import {
  buildConflictDiscardNote,
  buildConflictHandbackNote,
  buildRevisionNote,
  buildRejectedReviewNote,
} from "../prompt/gate-prompts.js";
import type { LoopPi } from "./loop-pi.js";
import {
  modelSelectorField,
  reviewRunConfig,
  scheduleConfigForRole,
  seamHoldKey,
  withModelOverrides,
  type ResolvedModelConfig,
} from "../config/config-views.js";
import { fallbackRoleConfig } from "../config/config-fallbacks.js";
import { imageReroute, seamImageInput } from "../agent/image-input.js";
import { piModelsPath, readPiProviders } from "../pi/pi-models.js";
import { peekPrompt, peekRolePrompt } from "../inbox/inbox.js";
import { planTickStart, type TickStartPlan } from "../tick/tick-resume.js";
import { DEFAULT_AGENT } from "../agent/agent-backend.js";
import type { PendingPrompt } from "../inbox/pending-prompt.js";
import { stageTickLanding, foldAgentCommitsSince } from "../tick/tick-stage.js";
import { stageCheckFindings } from "../tick/stage-check.js";
import { bootstrapStatus } from "../gates/bootstrap-gates.js";
import { modelFallbackActive, modelFallbackProbe } from "./model-fallback.js";
import { finalizeTick } from "../tick/tick-finalize.js";
import { errorMessage } from "../text/text.js";
import { appendPromptNote } from "../text/format.js";
import type { TickUsage } from "../tick/tick-usage.js";
import { recoverLeftover, type LeftoverRecovery } from "./leftover.js";
import { applyRevision, applyWithConflicts } from "./revision.js";
import { hasConflictMarkers, mainCommitsTouching } from "../landing/landing-git.js";
import { changedFiles } from "../git/git-diff.js";
import { mergeToMain } from "../landing/landing-merge.js";
import { bugfixMainRedNote, mainRedGate } from "../baseline/main-red.js";
import { resolveTickVerdict } from "../tick/tick-verdict.js";
import { extractFlow, type FlowResult } from "../verdict/reply-contract.js";

/** The model-fallback episode context a tick start resolves (src/loop/model-fallback.ts): the
 * tier's fallback pair (null when the feature is off), whether this tick is the due probe, and
 * the primary pair it returns to. */
export interface FallbackRunContext {
  fallback: ResolvedModelConfig | null;
  probe: boolean;
  primary: ResolvedModelConfig;
}

/** Everything the tick-pipeline phases need from their `LoopRunner` host. The runner builds one
 * per tick (before its `runTick` override point) from its readonly fields and live config, plus
 * bound callbacks back into the runner for the work whose body stays there (landing merge, the
 * recovery phases, the fallback fold). Splitting the pipeline out of the class keeps each phase
 * a plain function of this context. */
export interface LoopTickContext {
  root: string;
  role: string;
  mainBranch: string;
  /** This loop's base role (`feature-2` → `feature`) — the red-main gate reads it. */
  baseRole: string;
  config: TumwaterConfig;
  state: LoopState;
  usage: TickUsage;
  pending: PendingPrompt;
  pi: LoopPi;
  save(): void;
  warn(message: string): void;
  /** The signal a tick's pi runs watch: harness shutdown OR this tick's abort controller. */
  runSignal(): AbortSignal;
  tickPrompt(agent?: string): string | null;
  /** Which pair set an image reroute may look among (plans/image-input.md "Reroute target"
   * "Regime"): the free fallback pairs while the budget gate is on fallback or the role is
   * in a model-fallback episode, else the primary tiers. Delegates to the runner's rule. */
  rerouteRegime(now: number): "primary" | "fallback";
  /** The live value of the runner's recoveryFailure field (set by the recovery phase mid-run,
   * read at finalize time). */
  readonly recoveryFailure: string | undefined;
  setRecoveryFailure(message: string | undefined): void;
  setTickPair(pair: { provider?: string; model?: string } | undefined): void;
  setHandedBack(value: boolean): void;
  /** A fresh per-tick abort controller and a cleared user-abort flag. */
  resetTickAbort(): void;
  /** A tick's pipeline entry: the runner's `runTick` (test-overridable). */
  runTick(cfg: ResolvedModelConfig, fallbackCtx: FallbackRunContext): Promise<TickOutcome>;
  finishAbortedTick(userPrompt: string | null, wt: string): Promise<TickOutcome>;
  pinAndReset(wt: string, sha: string): Promise<boolean>;
  foldModelFallback(ctx: FallbackRunContext, pi: PiRunResult): void;
  finishRecoveryTick(
    recovered: Exclude<LeftoverRecovery, { kind: "discarded" } | { kind: "handback" }>,
    userPrompt: string | null,
    wt: string,
    priorLandingFailure: string | undefined,
  ): Promise<TickOutcome>;
}

/** The intent the author needs to resolve a handed-back change: the change's own commit message
 * and the main commits that touched its conflicted files since its merge-base. Mirrors what
 * resolveConflict gathers for the landing resolver (src/landing/landing-merge.ts) and feeds the
 * same prompt block through buildConflictHandbackNote. */
async function handbackIntent(
  wt: string,
  mainBranch: string,
  sha: string,
  conflicted: string[],
): Promise<{ change: string; main: Awaited<ReturnType<typeof mainCommitsTouching>>["commits"]; mainOmitted?: number }> {
  const change = (await commitMessage(wt, sha)) ?? "";
  const since = await changeBaseRev(wt, mainBranch, sha);
  const { commits, omitted } = await mainCommitsTouching(wt, since, mainBranch, conflicted);
  return { change, main: commits, ...(omitted > 0 ? { mainOmitted: omitted } : {}) };
}

/** The repo-relative paths in `wt` that currently carry conflict markers. The apply path knows
 * its conflicted set because applyWithConflicts reads the unmerged index; a handoff resumes that
 * already-applied worktree, where the mixed reset dropped the unmerged index entries and the
 * marker-bearing files remain as ordinary working-tree edits. Reads the same marker definition
 * (hasConflictMarkers) the stage check and review gate use, over the worktree's changed files. */
async function markerBearingFiles(wt: string): Promise<string[]> {
  const files = await changedFiles(wt);
  return files.filter((f) => hasConflictMarkers(wt, [f]));
}

/** Run one full tick of a role loop: resolve the config (including the model-fallback probe),
 * log the start, run the pipeline, then let finalizeTick schedule the next run. Never throws: a
 * failed tick is an "error" result, saved and logged like any other so the loop stays resumable
 * and observable. */
export async function tickPhase(ctx: LoopTickContext): Promise<TickOutcome> {
  const s = ctx.state;
  // This role's view of the config (per-role provider/model/thinking + minRunIntervalSeconds
  // overrides): resolved once so every interval-based scheduling branch honors a slow
  // clock (e.g. the steward's ~6 h) and a live-reloaded config applies from this tick on.
  // New-project bootstrap (plans/work-ratio.md, part 2/2): while active, plan schedules on the
  // global min-tick gap rather than its 3600 s default. The shared verdict below is the same
  // one the gate and isEligible read, and scheduleConfigForRole is the one home of the rule,
  // so the scheduler that admits plan and the nextRunAt this tick writes cannot disagree.
  const bootstrapActive = bootstrapStatus(ctx.root, ctx.config)?.active === true;
  const primaryCfg = scheduleConfigForRole(ctx.config, ctx.role, bootstrapActive);
  // Model-fallback episode (src/loop/model-fallback.ts): while one is active the tick runs
  // on the role's tier fallback pair, and once the cooldown elapses it runs on the primary
  // as the probe. Resolved at tick start so the authoring run below and the end-of-tick fold
  // agree on which pair ran. Null fallback (the tier resolves to pause) keeps the feature off.
  const now = Date.now();
  const fallback = fallbackRoleConfig(ctx.config, ctx.role);
  const probing = fallback !== null && modelFallbackProbe(s.modelFallback, now);
  const onFallback = fallback !== null && modelFallbackActive(s.modelFallback, now);
  // The fallback pair keeps primaryCfg's gap (they resolve the same one outside bootstrap),
  // so a plan on its model fallback during bootstrap still schedules on the global clock.
  let cfg =
    onFallback && fallback !== null
      ? { ...fallback, minRunIntervalSeconds: primaryCfg.minRunIntervalSeconds }
      : primaryCfg;
  // Image-input reroute (plans/image-input.md part 4/5). A pending one-shot marker means
  // THIS tick is the blind-read reroute: start directly on the image-capable target the
  // prior tick recorded, over the kept worktree, in a fresh session. The marker is consumed
  // (cleared) here so it does not route a later tick; imageRerouteActive stays true for the
  // whole tick so the verdict's one-hop guard fails a second blind read instead of
  // rerouting again. A preflight (below) sets the same active flag without a marker.
  s.imageRerouteActive = false;
  let preflightBlocked = false;
  if (s.imageReroute) {
    const r = s.imageReroute;
    cfg = withModelOverrides(ctx.config, r.tier, {
      provider: r.provider,
      model: r.model,
      thinking: r.thinking,
    });
    // The marker is NOT cleared here: planTickStart reads its `from`/`path` when it builds
    // the handoff note (and clears it then), so a tick skipped before the plan (an empty
    // inbox) leaves the reroute pending for the next eligible tick.
    s.imageRerouteActive = true;
  } else {
    // Preflight (plans/image-input.md "Attachments"): a queued prompt carrying an
    // `[image attached: …]` line needs a model that can read images BEFORE any run starts,
    // so a text-only tick hops straight to the target instead of spending a failed tick
    // learning it; with no target the tick errors without spawning pi.
    const nextPrompt =
      ctx.role === DIRECTOR_ROLE ? peekPrompt(ctx.root) : peekRolePrompt(ctx.root, ctx.role);
    const carriesImages = nextPrompt !== null && /^\[image attached: .+\]$/m.test(nextPrompt);
    if (carriesImages) {
      const providers = readPiProviders(piModelsPath());
      if (seamImageInput(cfg, providers) !== true) {
        const target = imageReroute(ctx.config, ctx.role, ctx.rerouteRegime(now));
        if (target !== null) {
          cfg = target.config;
          s.imageRerouteActive = true;
          logEventBestEffort(ctx.root, {
            loop: ctx.role,
            type: "image_reroute",
            run: s.ticks + 1,
            from: primaryCfg.model,
            to: target.config.model,
            tier: target.tier,
            preflight: true,
          });
        } else {
          preflightBlocked = true;
          s.lastError =
            `an inbox message for ${ctx.role} attaches an image, but no configured tier can read it`;
        }
      }
    }
  }
  // Capture what this tick runs on (the orchestrator's budget handback matches it against
  // the fallback pair) and clear any stale handback flag: an abort request that lands while
  // the loop is idle must not name a later tick's resume.
  // The pair is keyed by the seam that ran (seamHoldKey), not the pi provider: a claude
  // fallback tick carries `claude`, matching the configured fallback pair that tickOnPair
  // (src/gates/budget-gates.ts) compares against, so a tick on a claude fallback is handed
  // back when the budget gate reopens (PLANS.md "Mixed claude + pi fleets, part 2/4").
  ctx.setTickPair({ provider: seamHoldKey(cfg), model: cfg.model });
  ctx.setHandedBack(false);
  s.ticks += 1;
  // gen / peak ctx are per-tick windows, not lifetime totals (user decision 2026-08-25):
  // reset before the start-of-tick save so a working loop's columns grow live from 0 and
  // an idle loop's show its last completed tick. The loop's pi plumbing accumulates every pi
  // run of this tick (main + transient-timeout retry + conflict resolution) into them, and the
  // end-of-tick save persists the finished run's totals.
  s.generatedTokens = 0;
  s.peakContextTokens = 0;
  ctx.usage.reset();
  ctx.setRecoveryFailure(undefined);
  // A fresh per-tick abort controller and a cleared user-abort flag: an abort request that
  // lands while the loop is idle must not leak into the next tick.
  ctx.resetTickAbort();
  s.running = true;
  s.lastTickStartedAt = Date.now();
  const tick = s.ticks;
  const tickStartedAt = s.lastTickStartedAt;
  ctx.save();
  // The selector this tick's runs start on (plans/model-tiers.md "Observability"): with
  // the budget fallback active the config already names the fallback pair, so the logged
  // string is what the runs actually use. Omitted when no model is configured (pi's own
  // default), so old logs and old configs render unchanged.
  logEventBestEffort(ctx.root, {
    loop: ctx.role,
    type: "run_start",
    run: tick,
    // A tick routed onto the image-capable target — a blind-read handoff or an attachment
    // preflight — is stamped so the feed shows the reroute and the model it landed on.
    ...(s.imageRerouteActive ? { reroute: "image" } : {}),
    ...modelSelectorField(cfg),
  });

  let outcome: TickOutcome;
  try {
    // The preflight can end the tick before any pi spawns: a text-only loop with an image
    // attachment and no image-capable target has nothing to run, so it errors without
    // spending a model call. Everything else runs the pipeline as usual.
    outcome = preflightBlocked
      ? { result: "error" }
      : await ctx.runTick(cfg, { fallback, probe: probing, primary: primaryCfg });
  } catch (err) {
    outcome = { result: "error" };
    s.lastError = errorMessage(err);
    // An exception between the dequeue/reclaim and the pi run leaves the request only in
    // the pending field — memory this failed tick is about to drop, with no outcome handler
    // left to re-queue it (the handlers run inside runTick, after the pi run). The queue is
    // the durable store, so the catch re-queues whatever is still pending, like every
    // unfulfilled outcome does; it is always null once a pi run has been accounted for.
    ctx.pending.requeuePendingUnfulfilled();
  }
  // The tick that owned the dequeued request is over: remove its image files unless an
  // unfulfilled outcome handed the request back to the queue (settleImages). Runs after the
  // catch above, which is the last point a requeue can happen.
  ctx.pending.settleImages();
  // Everything after the pi run — the outcome folds, the main-head read, next-run
  // scheduling, the episode warnings, and the run_end event — is the tick's per-result
  // bookkeeping policy, not runner lifecycle: it lives in src/tick/tick-finalize.ts, which owns
  // the ordering (the folds land on state before the schedule, the head read happens while
  // `running` is still true) and the per-episode warning crossings. The tick number and
  // start time are passed through as captured above: both must describe the tick run_start
  // announced, not whatever resetCounters (a documented mid-tick operation) may have left
  // on the shared state by finalize time.
  const finalizeResult = await finalizeTick({
    root: ctx.root,
    role: ctx.role,
    mainBranch: ctx.mainBranch,
    config: cfg,
    state: s,
    outcome,
    tick,
    tickStartedAt,
    usage: ctx.usage,
    recoveryFailure: ctx.recoveryFailure,
  });
  // The tick is over: the captured pair must not outlive it (a later poll must never match
  // an idle loop's stale pair against a resumed fallback).
  ctx.setTickPair(undefined);
  return finalizeResult;
}

/** The tick pipeline's start half: resume-or-fresh policy, then run in the director's own
 * worktree or on a leased pool slot. Returns the setup's outcome; a null plan means nothing to
 * run. */
export async function runTickPhase(
  ctx: LoopTickContext,
  cfg: ResolvedModelConfig,
  fallbackCtx: FallbackRunContext,
): Promise<TickOutcome> {
  const s = ctx.state;
  // How this tick starts — resume the interrupted session or run fresh, and which prompt —
  // is the resume policy, not runner mechanics: it lives in src/tick/tick-resume.ts, which also
  // consumes the resume flags and reclaims the interrupted tick's re-queued prompt. A null
  // plan means the loop has nothing to run.
  const plan = planTickStart({
    root: ctx.root,
    role: ctx.role,
    state: s,
    pending: ctx.pending,
    tickPrompt: (agent) => ctx.tickPrompt(agent),
    agent: cfg.agent ?? DEFAULT_AGENT,
  });
  if (plan === null) return { result: "skipped" };
  if (ctx.role === DIRECTOR_ROLE) {
    // The image-reroute one-shot marker routes exactly ONE tick onto the image-capable
    // target (plans/image-input.md part 4/5, INV-J2): for a role loop, planTickStart consumes
    // it after reading its handoff-note facts. The director never resumes, so planTickStart's
    // image-reroute branch never runs for it and the marker would otherwise linger and
    // re-route every later director tick off its own tier. It is cleared here — after this
    // tick is confirmed to run (an empty-inbox skip above returns before this, leaving the
    // reroute pending for the next eligible tick) — so the rerouted director prompt is
    // delivered exactly once and the director is back on its own tier next.
    s.imageReroute = undefined;
    // The director keeps its dedicated worktree (it runs outside the permit, consumes its
    // config-request file at that exact path, and never resumes). Hold it from before
    // ensureWorktree — creating or resetting it is part of the use — to the tick's end
    // (plans/disk-floor.md, part 2/4), so a concurrent pressure reclaim never cleans a tree
    // this tick is creating or working in.
    return useWorktree(ctx.root, worktreePath(ctx.root, ctx.role), () =>
      tickWithWorktreePhase(ctx, plan, cfg, fallbackCtx),
    );
  }
  return runTickInLeasePhase(ctx, plan, cfg, fallbackCtx);
}

/** Whether a finished role tick's leased slot must stay pinned for the next tick's resume —
 * the resume flag a verdict armed inside the tick (`resumePending`), an abort or quiet kill,
 * or a context cut-off. Exported so a test can evaluate the exact condition the lease release
 * uses: a resume flag set only later, by applyTickOutcome, is too late to keep the worktree. A
 * user abort discards its work and is never pinned. */
export function slotPinnedForResume(
  state: Pick<LoopState, "resumePending">,
  outcome: TickOutcome | undefined,
): boolean {
  return (
    state.resumePending === true ||
    outcome?.result === "aborted" ||
    outcome?.result === "quiet_killed" ||
    outcome?.cutOff === true
  );
}

/** A non-director tick's whole life on a pooled slot (plans/worktree-pool.md, "Role ticks
 * lease slots"): lease, author on the role's branch, release. The release pins the slot for
 * a tick whose next run resumes (aborted, quiet-killed, cut off, or a failed dirty run),
 * keeping the branch checked out and the uncommitted edits in the same cwd pi's `--continue`
 * needs; every other release detaches first so the branch is free for whichever slot the role
 * leases next. */
async function runTickInLeasePhase(
  ctx: LoopTickContext,
  plan: TickStartPlan,
  cfg: ResolvedModelConfig,
  fallbackCtx: FallbackRunContext,
): Promise<TickOutcome> {
  const lease = await leaseSlot(ctx.root, {
    role: ctx.role,
    purpose: "tick", // vocabulary-ok: lease purpose "tick" is a persisted state value until the state rename
    ref: ctx.mainBranch,
    keep: plan.resuming || plan.handoff,
    signal: ctx.runSignal(),
    // The live view's pool budget: this read must not depend on tumwater.json being
    // readable right now (a broken file must not error the tick before its pi run).
    slotBudget: slotCount(ctx.config),
  });
  let outcome: TickOutcome | undefined;
  try {
    if (!lease.preserved) await checkoutRoleBranchPhase(ctx, lease.dir);
    outcome = await tickWithWorktreePhase(ctx, plan, cfg, fallbackCtx, lease.dir);
    return outcome;
  } finally {
    // The slot is pinned for the next tick's resume when the verdict armed `resumePending`
    // inside the tick (the error-dirty and rate-limit arms in src/tick/tick-verdict.ts), or
    // when the outcome is an abort, quiet kill, or context cut-off. applyTickOutcome sets
    // `resumePending` for the other outcomes only after runTick returns, so those are read off
    // the outcome here instead.
    const pin = slotPinnedForResume(ctx.state, outcome);
    // Detach is best-effort so it can never mask the tick's own outcome or error; the release
    // still runs, and the next lease's checkout recovers an undetached branch either way.
    if (!pin) await gitTry(lease.dir, "checkout", "--detach");
    lease.release({ pin });
  }
}

/** Put `tumwater/<role>` on the leased slot before authoring. An existing branch is checked
 * out, never reset — `-B` would discard the unlanded commit it durably holds; an absent one
 * is created from main. `--ignore-other-worktrees` lets the slot take the branch while a
 * legacy `.tumwater/worktrees/<role>` still holds it (the ordering that lands this part
 * before part 4c, which retires those directories); the stale checkout is never used again.
 * Untracked files are cleaned so the checkout is pristine. */
async function checkoutRoleBranchPhase(ctx: LoopTickContext, dir: string): Promise<void> {
  const branch = branchName(ctx.role);
  if (await branchExists(ctx.root, branch)) {
    await git(dir, "checkout", "-f", "--ignore-other-worktrees", branch);
  } else {
    await git(dir, "checkout", "-f", "-b", branch, ctx.mainBranch);
  }
  await git(dir, "clean", "-fd");
}

async function tickWithWorktreePhase(
  ctx: LoopTickContext,
  plan: TickStartPlan,
  cfg: ResolvedModelConfig,
  fallbackCtx: FallbackRunContext,
  /** The leased slot the tick runs in; omitted by the director, which ensures its own. */
  leasedDir?: string,
): Promise<TickOutcome> {
  const s = ctx.state;
  const { priorLandingFailure, resuming, handoff, resumeCause, userPrompt } = plan;
  let prompt = plan.prompt;

  const wt = leasedDir ?? (await ensureWorktree(ctx.root, ctx.role, ctx.mainBranch));
  if (resuming || handoff) {
    // Keep the interrupted run's uncommitted edits; clear only stray merge/rebase state. A
    // handoff resumes a FRESH session over those same edits (the newest author session belongs
    // to another agent), so it preserves the worktree exactly as a resume does.
    await abortSync(wt);
    logEventBestEffort(ctx.root, { loop: ctx.role, type: "resume", cause: resumeCause });
  } else {
    // Salvage a commit a previous tick left unlanded (src/loop/leftover.ts): recovery puts it
    // back on the land queue, so it lands through the orchestrator's landing pipeline — the
    // same gate as a fresh tick's change, and main keeps exactly one writer (an in-tick
    // recovery landing raced the slot's batches into `merge_blocked`). A salvaged leftover
    // ENDS the tick: the role holds one landing ref, and the leftover owns it until its
    // landing resolves. With nothing to salvage the branch holds nothing either, so the reset
    // below leaves pristine main for the red-main gate.
    // A permanent reviewer config error — held from re-queueing — clears once the resolved
    // reviewer selector changes, so fixing the model config recovers the pin automatically
    // (BUGS.md 2026-10-06).
    const reviewSelector = modelSelectorField(reviewRunConfig(ctx.config)).model;
    if (s.landingReviewError && s.landingReviewError.selector !== reviewSelector) s.landingReviewError = undefined;
    const recovered = await recoverLeftover({
      root: ctx.root,
      role: ctx.role,
      mainBranch: ctx.mainBranch,
      tick: s.ticks,
      wt,
      mergeConflicts: s.mergeConflicts,
      conflictHandback: s.conflictHandback,
      landingReviewError: s.landingReviewError,
    });
    if (recovered?.kind === "handback") {
      // The pin hit the conflict cap and its lineage has not been handed back yet: keep the
      // pin, record the hand-back, and fall through to author the resolution on current main.
      // The apply happens below, beside the revision branch.
      s.mergeConflicts = undefined;
      s.conflictHandback = {
        sha: recovered.sha,
        at: Date.now(),
        reason: "landing", // vocabulary-ok: "landing" is a persisted state value until the state rename
        applied: false,
      };
      logEventBestEffort(ctx.root, { loop: ctx.role, type: "conflict_handback", action: "queued", sha: recovered.sha, reason: "landing" }); // vocabulary-ok: "landing" is a persisted state value until the state rename
    } else if (recovered?.kind === "discarded") {
      // The pin hit the conflict cap and is gone: nothing holds the role any more, so this
      // tick authors on a fresh main like any other — told what was dropped and why.
      s.mergeConflicts = undefined;
      s.conflictHandback = undefined;
      s.conflictDiscard = { sha: recovered.sha, summary: recovered.summary, attempts: recovered.attempts, at: Date.now() };
      prompt = appendPromptNote(prompt, buildConflictDiscardNote(recovered.summary, recovered.attempts));
    } else if (recovered) return ctx.finishRecoveryTick(recovered, userPrompt, wt, priorLandingFailure);
    await resetWorktreeToMain(wt, ctx.mainBranch);
    // Red-main baseline gate (src/baseline/main-red.ts): the worktree is pristine main right
    // now — verify main's own suite before spending an authoring run on top of it. Only roles
    // whose diff can carry code changes are blocked; resume ticks skip this by construction
    // (their worktree is not pristine main). The `bugfix` healer is exempt because its fix is
    // the fleet's only way back to green, so instead of blocking it we hand it the failure
    //the same check runs, but a red main appends a <main-red>
    // note to this tick's prompt so it reproduces and fixes that failure rather than hunting
    // blind.
    if (ctx.baseRole === "bugfix") {
      const note = await bugfixMainRedNote(ctx.root, ctx.role, wt);
      if (note) prompt = appendPromptNote(prompt, note);
    } else {
      const blocked = await mainRedGate(ctx.root, ctx.role, wt);
      if (blocked) {
        // The dequeued prompt never ran: put it back in its queue before returning, so it is
        // not lost to a restart (the pending field is memory-only) or dropped by the next
        // tick's outcome handling — the queue is the durable store, and once main is green
        // the next tick dequeues it again (criterion b).
        ctx.pending.requeueUnfulfilled(userPrompt);
        ctx.pending.clear();
        return blocked;
      }
    }
  }

  // A change handed back after its landings kept conflicting — or a persisted hand-back the
  // author's tick has not applied yet — is re-applied over current main with the conflict
  // markers left as ordinary uncommitted edits so this tick resolves them (PLANS.md "Robust
  // conflict landing, part 2/2"). The landing ref is deleted once the diff is in the worktree.
  // Runs before the revision branch, which applies a revision hand-back itself. A resume or
  // handoff keeps the interrupted worktree as-is, so re-applying here would cherry-pick onto
  // those kept edits; both skip it, exactly as before this feature for a resume.
  if (
    s.conflictHandback &&
    !s.conflictHandback.applied &&
    ctx.role !== DIRECTOR_ROLE &&
    userPrompt === null &&
    !resuming &&
    !handoff
  ) {
    const hb = s.conflictHandback;
    const applied = await applyWithConflicts(wt, ctx.mainBranch, hb.sha);
    if (applied.applied) {
      s.conflictHandback = { ...hb, applied: true };
      await deleteRef(ctx.root, landingRefName(ctx.role));
      logEventBestEffort(ctx.root, {
        loop: ctx.role,
        type: "conflict_handback",
        action: "applied",
        sha: hb.sha,
        reason: hb.reason,
        conflicted: applied.conflicted,
      });
      const intent = await handbackIntent(wt, ctx.mainBranch, hb.sha, applied.conflicted);
      prompt = appendPromptNote(prompt, buildConflictHandbackNote(hb.reason, applied.conflicted, intent));
    } else {
      // The object is gone or the apply failed for a non-conflict reason: drop the hand-back
      // so the author starts fresh rather than retrying it every tick.
      s.conflictHandback = undefined;
      await deleteRef(ctx.root, landingRefName(ctx.role));
      logEventBestEffort(ctx.root, { loop: ctx.role, type: "conflict_handback", action: "failed", sha: hb.sha, reason: hb.reason });
    }
  }

  const piStartedAt = Date.now();
  // A rejected change owes a revision (plans/revise-rejected.md): re-apply its diff to current
  // main as uncommitted edits so this tick revises it instead of authoring from scratch, and
  // append the revision note the prompt skipped. `revisionRound` records that THIS tick holds
  // the rejected diff — set only when the revision is applied here, or a resume carries the
  // prior attempt's already-applied edits — so the post-run handlers read the tick rather than
  // `state.revision`, which a per-role user-request tick leaves set by design. A conflict (or a
  // gone object) clears the revision, deletes the rejected ref, and falls back to the plain
  // rejection note.
  let revisionRound: number | undefined;
  if (s.revision && ctx.role !== DIRECTOR_ROLE && userPrompt === null) {
    const { sha, round } = s.revision;
    // The prompt's rejected/revision notes read the loop's most recent rejection; an absent
    // one (a fresh loop or a hand-edited state) reads the empty reasons list. Computed once
    // for the three revision-append sites and the rejected-note fallback below, so the
    // get-or-default idiom cannot drift between them.
    const lastReviewOrEmpty = s.lastReview ?? { reasons: [] };
    const revisionNote = buildRevisionNote(lastReviewOrEmpty, round);
    if (resuming || handoff) {
      // The interrupted revision run's applied edits are still in the worktree (both the
      // resume and the cross-agent handoff keep uncommitted work), so this tick still owns
      // the revision. A handoff runs the revision in a fresh session rather than
      // re-cherry-picking it onto the already-dirty worktree.
      revisionRound = round;
      if (handoff) {
        // A handoff is a FRESH session: it has none of the interrupted run's context, and
        // tick-prompt.ts suppresses the rejected-review note whenever state.revision is set,
        // so without this the fresh run would see neither the objections nor the revision
        // instructions. A resume keeps its session context and must not see the note twice.
        prompt = appendPromptNote(prompt, revisionNote);
      }
    } else if (await applyRevision(wt, ctx.mainBranch, sha)) {
      revisionRound = round;
      logEventBestEffort(ctx.root, { loop: ctx.role, type: "revision", action: "applied", round, sha });
      prompt = appendPromptNote(prompt, revisionNote);
    } else {
      // The clean re-apply conflicted: re-apply with the markers left in place so the author
      // resolves them rather than losing the revision (PLANS.md "Robust conflict landing, part
      // 2/2"). Only a non-conflict failure falls back to the plain rejection note.
      const withConflicts = await applyWithConflicts(wt, ctx.mainBranch, sha);
      if (withConflicts.applied) {
        revisionRound = round;
        s.conflictHandback = {
          sha,
          at: Date.now(),
          reason: "revision",
          round,
          applied: true,
        };
        logEventBestEffort(ctx.root, { loop: ctx.role, type: "revision", action: "applied", round, sha });
        logEventBestEffort(ctx.root, {
          loop: ctx.role,
          type: "conflict_handback",
          action: "applied",
          sha,
          reason: "revision",
          conflicted: withConflicts.conflicted,
        });
        prompt = appendPromptNote(prompt, revisionNote);
        const intent = await handbackIntent(wt, ctx.mainBranch, sha, withConflicts.conflicted);
        prompt = appendPromptNote(prompt, buildConflictHandbackNote("revision", withConflicts.conflicted, intent));
      } else {
        s.revision = undefined;
        await deleteRef(ctx.root, rejectedRefName(ctx.role));
        logEventBestEffort(ctx.root, { loop: ctx.role, type: "revision", action: "conflict", round, sha });
        prompt = appendPromptNote(prompt, buildRejectedReviewNote(lastReviewOrEmpty, ctx.role));
        prompt = appendPromptNote(prompt, "The rejected diff no longer applies to current main.");
      }
    }
  }
  // A handoff runs a FRESH session over the interrupted tick's kept worktree. When that tick had
  // already applied a conflict hand-back, the marker-bearing files are still there but the fresh
  // run has none of the interrupted session's context explaining them, so re-send the hand-back
  // note (a resume keeps its session context and must not see the note twice). The revision
  // block above covers a revision hand-back's own note; this covers every hand-back reason,
  // including a landing hand-back with no revision. Unlike the apply path there is no index to
  // read, so the conflicted set comes from the worktree's current marker-bearing files.
  if (handoff && s.conflictHandback?.applied) {
    const hb = s.conflictHandback;
    const conflicted = await markerBearingFiles(wt);
    const intent = await handbackIntent(wt, ctx.mainBranch, hb.sha, conflicted);
    prompt = appendPromptNote(prompt, buildConflictHandbackNote(hb.reason, conflicted, intent));
  }

  const tickBase = await headOf(wt, "HEAD");
  const pi = await ctx.pi.runAuthoringPi(wt, prompt, `tumwater-${ctx.role}-${s.ticks}`, resuming, cfg);
  // The harness owns every commit (INV-H1): fold any the agent made into the tick's one commit.
  await foldAgentCommitsSince(ctx, wt, tickBase);
  // Fold the authoring run's verdict into the role's model-fallback episode NOW, before the
  // post-run handlers spend any more pi runs: only this run is evidence about the primary.
  ctx.foldModelFallback(fallbackCtx, pi);
  // The `qa` observer's reply ends with a result-carrying `FLOW:` line (plans/observer-roles.md
  // 2/2). Extracted once here, recorded only at the success returns below — an interrupted or
  // failed tick must not advance the rotation. The harness records it, never pi.
  const flow = ctx.baseRole === "qa" ? extractFlow(pi.finalText) : null;

  return handlePiResultPhase(ctx, pi, userPrompt, revisionRound, wt, flow, piStartedAt, cfg);
}

/** Land the worktree branch on main (see src/landing/landing-merge.ts for the
 * rebase → verify → ff-merge → conflict-retry flow): delegates with the loop identity, tick
 * number, and shared pi wiring so a conflict-resolution run folds into this tick's counters
 * like any other pi run. Only the refusal-note landing (src/verdict/refusal.ts) still uses it —
 * reviewed changes land through the landing pipeline's leased vet slot instead; md-only notes
 * are review-exempt by construction, so they keep this branch path (plans/merge-queue.md 2/5). */
async function mergePhase(ctx: LoopTickContext, wt: string, summary: string): Promise<TickResult> {
  return mergeToMain(
    {
      root: ctx.root,
      role: ctx.role,
      mainBranch: ctx.mainBranch,
      exemptPaths: ctx.config.review.exemptPaths,
      config: ctx.config,
      tick: ctx.state.ticks,
      runPi: (w, prompt, sessionName, config) => ctx.pi.runRolePi(w, prompt, sessionName, false, config),
    },
    wt,
    summary,
  );
}

/** Turn a finished pi run into its TickOutcome: the post-run half of runTick, split off so each
 * half reads on its own screen — the setup above ends at the pi return. The verdict
 * classification (abort, config request, quiet kill, timeout, refusal, failure, no-change) lives
 * in resolveTickVerdict (src/tick/tick-verdict.ts), and the fulfillable path — staging —
 * stays here. `userPrompt` is the raw director prompt this tick is executing (null for role
 * loops) so unfulfilled outcomes can re-queue it; `revisionRound` is the revision this tick holds
 * (undefined when it is not a revision); `flow` is the qa observer's FLOW line (null for every
 * other role). */
export async function handlePiResultPhase(
  ctx: LoopTickContext,
  pi: PiRunResult,
  userPrompt: string | null,
  revisionRound: number | undefined,
  wt: string,
  flow: FlowResult | null,
  piStartedAt: number,
  cfg: ResolvedModelConfig,
): Promise<TickOutcome> {
  // Everything that decides the run left nothing landable — abort, config request,
  // quiet kill, timeout, refusal, failure without changes, no change — lives in
  // resolveTickVerdict (src/tick/tick-verdict.ts); null means the run IS fulfillable.
  const verdict = await resolveTickVerdict({
    root: ctx.root,
    role: ctx.role,
    mainBranch: ctx.mainBranch,
    state: ctx.state,
    pending: ctx.pending,
    turns: ctx.usage.turns,
    userPrompt,
    revisionRound,
    wt,
    pi,
    flow,
    // The image-reroute arm resolves its target from the live config and the current
    // regime, and names the model this tick ran on as the handoff's `from`.
    config: ctx.config,
    rerouteRegime: ctx.rerouteRegime(piStartedAt),
    runModel: cfg.model,
    warn: (message) => ctx.warn(message),
    merge: (w, sum) => mergePhase(ctx, w, sum),
    finishAbortedTick: () => ctx.finishAbortedTick(userPrompt, wt),
  });
  if (verdict) return verdict;

  // The commit is pinned and the worktree is free (src/tick/tick-stage.ts): stage it for the
  // land queue and END the tick — the orchestrator drains the queue on its single landing
  // slot, outside the author semaphore, so this slot is free the moment the work is
  // committed (plans/merge-queue.md 3/5). Staging derives the commit message from the reply's
  // SUMMARY block (one bounded follow-up turn when the run left none), flags high-friction
  // ticks, pins the commit by the role's landing ref BEFORE freeing the worktree (invariant
  // 4 — a failed pin defers to next-tick recovery), and enqueues the landing, which runs the
  // same gate + landing flow through runLandingPi/foldLandingUsage on this same state object
  // — recording the commit count, the outcome, and the reviewer spend into it — and logs
  // merge_done/merge_failed; a non-terminal outcome keeps the pin for next-tick leftover recovery.
  // `commits` was NOT incremented above: it counts landed changes only.
  return stageTickLanding({
    root: ctx.root,
    role: ctx.role,
    state: ctx.state,
    config: ctx.config,
    tickTurns: ctx.usage.turns,
    userPrompt,
    revisionRound,
    mainBranch: ctx.mainBranch,
    wt,
    finalText: pi.finalText,
    flow,
    piStartedAt,
    warn: (message) => ctx.warn(message),
    requestSummary: (w, n) => ctx.pi.requestSummary(w, cfg, n),
    stageCheck: (w) => stageCheckFindings(w, ctx.mainBranch, ctx.config.review.exemptPaths, ctx.role),
    requestStageFix: (w, findings) => ctx.pi.requestStageFix(w, findings, cfg),
    pinAndReset: (w, sha) => ctx.pinAndReset(w, sha),
    finishAbortedTick: () => ctx.finishAbortedTick(userPrompt, wt),
  });
}
