import path from "node:path";
import type { TumwaterConfig } from "../config/config-schema.js";
import type { HandBackCause, RunOutcome } from "../run/run-outcome.js";
import type { RunnerState } from "./runner-state.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";
import { branchExists, headOf } from "../git/git.js";
import { git, gitTry } from "../git/git-run.js";
import { abortSync, ensureWorktree } from "../git/worktree.js";
import { leaseSlot } from "../git/worktree-pool.js";
import { slotCount } from "../config/config.js";
import { useWorktree } from "../git/worktree-use.js";
import { readPiListedModels } from "../pi/pi-listed-models.js";
import { branchName, worktreePath } from "../paths.js";
import { logEventBestEffort } from "../events/events.js";
import { buildSalvageRestoreNote } from "../prompt/gate-prompts.js";
import type { RunnerPi } from "./runner-pi.js";
import {
  modelSelectorField,
  resolvedBackendConfig,
  scheduleConfigForRole,
  seamHoldKey,
  type ResolvedModelConfig,
} from "../config/config-views.js";
import { imageReroute, rerouteSeamConfig, seamImageInput } from "../agent/image-input.js";
import { piModelsPath, readPiProviders } from "../pi/pi-models.js";
import { peekPrompt, peekRolePrompt } from "../inbox/inbox.js";
import { planRunStart, planWithSalvagedWork, takesSalvagedWork, type RunStartPlan } from "../run/run-resume.js";
import { keepSalvagedWorkForOperator, restoreSalvagedWork } from "../git/slot-salvage.js";
import { DEFAULT_BACKEND } from "../agent/agent-backend.js";
import type { PendingPrompt } from "../inbox/pending-prompt.js";
import { foldAgentCommitsSince } from "../run/run-summary-recovery.js";
import { planBacklogFull } from "../scheduling/claims.js";
import { refreshPendingPlans } from "../backlog/backlog-pending.js";
import { baseRoleOf } from "../roles/runner-ids.js";
import { finalizeRun } from "../run/run-finalize.js";
import { errorMessage } from "../text/text.js";

import type { RunUsage } from "../run/run-usage.js";
import { pinnedRetrySha, type FinishableRecovery } from "./runner-leftover.js";
import { conflictedFileHunks } from "../merge/merge-git.js";
import { changedFiles } from "../git/git-diff.js";
import { handlePiResultPhase } from "./runner-outcome.js";
import {
  extractCiResult,
  extractFlow,
  extractFiled,
  extractRemoteResult,
  type CiResult,
  type FiledResult,
  type FlowResult,
  type RemoteResult,
} from "../verdict/reply-contract.js";
import { remoteCiTarget } from "../observer/remote-ci.js";
import { recoverLeftoversForRun } from "./runner-recovery-family.js";
import { applyConflictHandback, applyRevisionOrReject, resendHandoffNote } from "./runner-apply-family.js";
import type { PiRunResult } from "../pi/pi-run-result.js";

/** Everything the run-pipeline phases need from their `RoleRunner` host. The runner builds one
 * per run (before its `runOnce` override point) from its readonly fields and live config, plus
 * bound callbacks back into the runner for the work whose body stays there (the merge and
 * recovery phases). Splitting the pipeline out of the class keeps each phase a plain function
 * of this context. */
export interface RunnerRunContext {
  root: string;
  role: string;
  mainBranch: string;
  /** This runner's base role (`feature-2` → `feature`) — the ci healer's red-main hand-off and
   * the run's outcome/flow handling read it. */
  baseRole: string;
  config: TumwaterConfig;
  state: RunnerState;
  usage: RunUsage;
  pending: PendingPrompt;
  pi: RunnerPi;
  /** Best-effort: a failed write warns under the role's id and returns; the end-of-run save
   * persists the same state later. */
  save(): void;
  warn(message: string): void;
  /** The signal a run's pi runs watch: harness shutdown OR this run's abort controller. */
  runSignal(): AbortSignal;
  runPrompt(backend?: string): string | null;
  /** Which pair set an image reroute may look among (plans/image-input.md "Reroute target"
   * "Regime"): the free fallback pairs while the budget gate is on fallback, else the primary
   * tiers. Delegates to the runner's rule. */
  rerouteRegime(): "primary" | "fallback";
  /** The live value of the runner's recoveryFailure field (set by the recovery phase mid-run,
   * read at finalize time). */
  readonly recoveryFailure: string | undefined;
  setRecoveryFailure(message: string | undefined): void;
  setRunPair(pair: { provider?: string; model?: string } | undefined): void;
  setHandedBack(cause: HandBackCause | undefined): void;
  /** A fresh per-run abort controller and a cleared user-abort flag. */
  resetRunAbort(): void;
  /** A run's pipeline entry: the runner's `runOnce` (test-overridable). */
  runOnce(cfg: ResolvedModelConfig): Promise<RunOutcome>;
  finishAbortedRun(userPrompt: string | null, wt: string): Promise<RunOutcome>;
  pinAndReset(wt: string, sha: string): Promise<boolean>;
  finishRecoveryRun(
    recovered: FinishableRecovery,
    userPrompt: string | null,
    wt: string,
    priorMergeFailure: string | undefined,
  ): Promise<RunOutcome>;
}

/** This run's effective config, resolved from the role's own primaryCfg: a pending blind-read
 * image-reroute marker hops straight to the recorded target, otherwise a queued image
 * attachment is preflighted before any run starts. A preflight with no vision target blocks
 * the run (preflightBlocked true, lastError set) so it errors without spawning pi. */
function resolveRunConfig(
  ctx: RunnerRunContext,
  primaryCfg: ResolvedModelConfig,
): { cfg: ResolvedModelConfig; preflightBlocked: boolean } {
  const s = ctx.state;
  let cfg = primaryCfg;
  // Image-input reroute (plans/image-input.md part 4/5). A pending one-shot marker means
  // THIS run is the blind-read reroute: start directly on the image-capable target the
  // prior run recorded, over the kept worktree, in a fresh session. The marker is consumed
  // (cleared) here so it does not route a later run; imageRerouteActive stays true for the
  // whole run so the verdict's one-hop guard fails a second blind read instead of
  // rerouting again. A preflight (below) sets the same active flag without a marker.
  s.imageRerouteActive = false;
  let preflightBlocked = false;
  if (s.imageReroute) {
    cfg = rerouteSeamConfig(ctx.config, s.imageReroute);
    // The marker is NOT cleared here: planRunStart reads its `from`/`path` when it builds
    // the handoff note (and clears it then), so a run skipped before the plan (an empty
    // inbox) leaves the reroute pending for the next eligible run.
    s.imageRerouteActive = true;
  } else {
    // Preflight (plans/image-input.md "Attachments"): a queued prompt carrying an
    // `[image attached: …]` line needs a model that can read images BEFORE any run starts,
    // so a text-only run hops straight to the target instead of spending a failed run
    // learning it; with no target the run errors without spawning pi.
    const nextPrompt =
      ctx.role === DIRECTOR_ROLE ? peekPrompt(ctx.root) : peekRolePrompt(ctx.root, ctx.role);
    const carriesImages = nextPrompt !== null && /^\[image attached: .+\]$/m.test(nextPrompt);
    if (carriesImages) {
      const providers = readPiProviders(piModelsPath());
      const listed = readPiListedModels(ctx.root);
      if (seamImageInput(cfg, providers, listed) !== true) {
        const target = imageReroute(
          ctx.config, ctx.role, ctx.rerouteRegime(), undefined, null, null, listed,
        );
        if (target !== null) {
          cfg = target.config;
          s.imageRerouteActive = true;
          logEventBestEffort(ctx.root, {
            source: ctx.role,
            type: "image_reroute",
            run: s.runs + 1,
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
  return { cfg, preflightBlocked };
}

/** The per-run start bookkeeping for the config that run executes on: the run pair the budget
 * handback matches, the counters reset to a fresh per-run window, the abort controller and
 * running flags, the save, and the announced run_start event. Returns the run number and start
 * time the finalize stage must describe. */
function beginRun(
  ctx: RunnerRunContext,
  cfg: ResolvedModelConfig,
): { runNumber: number; runStartedAt: number } {
  const s = ctx.state;
  // Capture what this run runs on (the orchestrator's budget handback matches it against
  // the fallback pair) and clear any stale handback flag: an abort request that lands while
  // the runner is idle must not name a later run's resume.
  // The pair is keyed by the seam that ran (seamHoldKey), not the pi provider: a claude
  // fallback run carries `claude`, matching the configured fallback pair that runOnPair
  // (src/gates/budget-gates.ts) compares against, so a run on a claude fallback is handed
  // back when the budget gate reopens (PLANS.md "Mixed claude + pi fleets, part 2/4").
  ctx.setRunPair({ provider: seamHoldKey(cfg), model: cfg.model });
  ctx.setHandedBack(undefined);
  s.runs += 1;
  // gen / peak ctx are per-run windows, not lifetime totals (user decision 2026-08-25):
  // reset before the start-of-run save so a working runner's columns grow live from 0 and
  // an idle runner's show its last completed run. The runner's pi plumbing accumulates every pi
  // run of this run (main + transient-timeout retry + conflict resolution) into them, and the
  // end-of-run save persists the finished run's totals.
  s.generatedTokens = 0;
  s.peakContextTokens = 0;
  ctx.usage.reset();
  ctx.setRecoveryFailure(undefined);
  // A fresh per-run abort controller and a cleared user-abort flag: an abort request that
  // lands while the runner is idle must not leak into the next run.
  ctx.resetRunAbort();
  s.running = true;
  s.lastRunStartedAt = Date.now();
  const runNumber = s.runs;
  const runStartedAt = s.lastRunStartedAt;
  ctx.save();
  // The selector this run's runs start on (plans/model-tiers.md "Observability"): with
  // the budget fallback active the config already names the fallback pair, so the logged
  // string is what the runs actually use. Omitted when no model is configured (pi's own
  // default), so old logs and old configs render unchanged.
  logEventBestEffort(ctx.root, {
    source: ctx.role,
    type: "run_start",
    run: runNumber,
    // A run routed onto the image-capable target — a blind-read handoff or an attachment
    // preflight — is stamped so the feed shows the reroute and the model it landed on.
    ...(s.imageRerouteActive ? { reroute: "image" } : {}),
    ...modelSelectorField(cfg),
  });
  return { runNumber, runStartedAt };
}

/** Run one full run of a role runner: resolve the config, log the start, run the pipeline, then
 * let finalizeRun schedule the next run. Never throws: a failed run is an "error" result,
 * saved and logged like any other so the runner stays resumable and observable. */
export async function runPhase(ctx: RunnerRunContext): Promise<RunOutcome> {
  const s = ctx.state;
  // This role's view of the config (per-role provider/model/thinking + minRunIntervalSeconds
  // overrides): resolved once so every interval-based scheduling branch honors a slow
  // clock (e.g. the steward's ~6 h) and a live-reloaded config applies from this run on.
  // While PLANS.md still has planning room (planBacklogFull false), plan schedules with a zero
  // gap so a productive plan run reruns on the next poll; an unproductive run drops to the
  // idle backoff, and once the target is met the plans-full deferral holds the run. The shared
  // verdict below is the same one the gate and isEligible read, and scheduleConfigForRole is
  // the one home of the rule, so the scheduler that admits plan and the nextRunAt this run
  // writes cannot disagree. The projection refresh precedes the count so a run admitted
  // right after a pin is written sees that pin (plans/duplicate-plans.md "Decision" 1). Only
  // plan reads the verdict, so only plan pays the refresh: any other role leases its slot
  // without waiting on git reads first (each orchestrator poll refreshes it for other readers).
  const isPlan = baseRoleOf(ctx.role) === "plan";
  if (isPlan) await refreshPendingPlans(ctx.root, ctx.mainBranch);
  const planBacklogOpen = isPlan && !planBacklogFull(ctx.root, ctx.config);
  // This run's effective config: the role's own resolved config (a run always resolves its
  // role's own config — the model-fallback episode is gone, Subtract part 5o/6) unless an image
  // reroute below moves it. The budget gate's fallback pair, when a cap episode is active, is
  // installed into the live config itself, so the config here already names the pair the run
  // uses.
  const primaryCfg = scheduleConfigForRole(ctx.config, ctx.role, planBacklogOpen);
  // This run's config (with any image-input reroute or preflight applied) and the run-start
  // bookkeeping: both stages run before the pi pipeline so the run below only passes their
  // resolved pieces on to finalizeRun.
  const { cfg, preflightBlocked } = resolveRunConfig(ctx, primaryCfg);
  const { runNumber, runStartedAt } = beginRun(ctx, cfg);

  let outcome: RunOutcome;
  try {
    // The preflight can end the run before any pi spawns: a text-only runner with an image
    // attachment and no image-capable target has nothing to run, so it errors without
    // spending a model call. Everything else runs the pipeline as usual.
    outcome = preflightBlocked ? { result: "error" } : await ctx.runOnce(cfg);
  } catch (err) {
    outcome = { result: "error" };
    s.lastError = errorMessage(err);
    // An exception between the dequeue/reclaim and the pi run leaves the request only in
    // the pending field — memory this failed run is about to drop, with no outcome handler
    // left to re-queue it (the handlers run inside runOnce, after the pi run). The queue is
    // the durable store, so the catch re-queues whatever is still pending, like every
    // unfulfilled outcome does; it is always null once a pi run has been accounted for.
    ctx.pending.requeuePendingUnfulfilled();
  }
  // The run that owned the dequeued request is over: remove its image files unless an
  // unfulfilled outcome handed the request back to the queue (settleImages). Runs after the
  // catch above, which is the last point a requeue can happen.
  ctx.pending.settleImages();
  // Everything after the pi run — the outcome folds, the main-head read, next-run
  // scheduling, the episode warnings, and the run_end event — is the run's per-result
  // bookkeeping policy, not runner lifecycle: it lives in src/run/run-finalize.ts, which owns
  // the ordering (the folds land on state before the schedule, the head read happens while
  // `running` is still true) and the per-episode warning crossings. The run number and
  // start time are passed through as captured above: both must describe the run run_start
  // announced, not whatever resetCounters (a documented mid-run operation) may have left
  // on the shared state by finalize time.
  const finalizeResult = await finalizeRun({
    root: ctx.root,
    role: ctx.role,
    mainBranch: ctx.mainBranch,
    config: cfg,
    state: s,
    outcome,
    runNumber,
    runStartedAt: runStartedAt,
    usage: ctx.usage,
    recoveryFailure: ctx.recoveryFailure,
  });
  // The run is over: the captured pair must not outlive it (a later poll must never match
  // an idle runner's stale pair against a resumed fallback).
  ctx.setRunPair(undefined);
  return finalizeResult;
}

/** The run pipeline's start half: resume-or-fresh policy, then run in the director's own
 * worktree or on a leased pool slot. Returns the setup's outcome; a null plan means nothing to
 * run. */
export async function runOncePhase(
  ctx: RunnerRunContext,
  cfg: ResolvedModelConfig,
): Promise<RunOutcome> {
  const s = ctx.state;
  // How this run starts — resume the interrupted session or run fresh, and which prompt —
  // is the resume policy, not runner mechanics: it lives in src/run/run-resume.ts, which also
  // consumes the resume flags and reclaims the interrupted run's re-queued prompt. A null
  // plan means the runner has nothing to run.
  const plan = planRunStart({
    root: ctx.root,
    role: ctx.role,
    state: s,
    pending: ctx.pending,
    runPrompt: (backend) => ctx.runPrompt(backend),
    agent: cfg.agent ?? DEFAULT_BACKEND,
    // The team's configured claude config dir, so planRunStart's claude resume guard looks
    // under the same dir the run's env writes its transcript to (note 4/4). Unset → undefined.
    claudeConfigDir: resolvedBackendConfig(cfg, "claude").configDir,
    // A director with a kept merge pin that recovery will END on (the `pinned` arm — a live pin
    // under the conflict cap, which `pinnedRetrySha` returns) still goes through the run, for its
    // recovery. The run then declines to dequeue any queued user prompt (run-resume.ts
    // `buildRunStartPrompt`), because the ending recovery would re-queue it unrun in a
    // starvation churn while the pin cannot clear (BUGS.md 2026-11-11). A pin at the cap is
    // instead handed back or discarded — those arms AUTHOR with the run's prompt — so
    // `pinnedRetrySha` (null at the cap) keeps recoveryOnly false there and the prompt is served.
    recoveryOnly:
      ctx.role === DIRECTOR_ROLE &&
      ctx.pending.get() === null &&
      (await pinnedRetrySha(ctx.root, ctx.role, ctx.mainBranch, ctx.state)) !== null,
  });
  if (plan === null) return { result: "skipped" };
  if (ctx.role === DIRECTOR_ROLE) {
    // The image-reroute one-shot marker routes exactly ONE run onto the image-capable
    // target (plans/image-input.md part 4/5, INV-J2): for a role runner, planRunStart consumes
    // it after reading its handoff-note facts. The director never resumes, so planRunStart's
    // image-reroute branch never runs for it and the marker would otherwise linger and
    // re-route every later director run off its own tier. It is cleared here — after this
    // run is confirmed to run (an empty-inbox skip above returns before this, leaving the
    // reroute pending for the next eligible run) — so the rerouted director prompt is
    // delivered exactly once and the director is back on its own tier next.
    // A promptless recovery run delivers no prompt, so it leaves a pending reroute for the next.
    if (plan.prompt !== null) s.imageReroute = undefined;
    // The director keeps its dedicated worktree (it runs outside the permit, consumes its
    // config-request file at that exact path, and never resumes). Hold it from before
    // ensureWorktree — creating or resetting it is part of the use — to the run's end
    // (plans/disk-floor.md, part 2/4), so a concurrent pressure reclaim never cleans a tree
    // this run is creating or working in.
    return useWorktree(ctx.root, worktreePath(ctx.root, ctx.role), () =>
      runWithWorktreePhase(ctx, plan, cfg),
    );
  }
  return runOnceInLeasePhase(ctx, plan, cfg);
}

/** Whether a finished role run's leased slot must stay pinned for the next run's resume —
 * the resume flag a verdict armed inside the run (`resumePending`), an abort or quiet kill,
 * or a context cut-off. Exported so a test can evaluate the exact condition the lease release
 * uses: a resume flag set only later, by applyRunOutcome, is too late to keep the worktree. A
 * user abort discards its work and is never pinned. */
export function slotPinnedForResume(
  state: Pick<RunnerState, "resumePending">,
  outcome: RunOutcome | undefined,
): boolean {
  return (
    state.resumePending === true ||
    outcome?.result === "aborted" ||
    outcome?.result === "quiet_killed" ||
    outcome?.cutOff === true
  );
}

/** A non-director run's whole life on a pooled slot (plans/worktree-pool.md, "Role runs
 * lease slots"): lease, author on the role's branch, release. The release pins the slot for
 * a run whose next run resumes (aborted, quiet-killed, cut off, or a failed dirty run),
 * keeping the branch checked out and the uncommitted edits in the same cwd pi's `--continue`
 * needs; every other release detaches first so the branch is free for whichever slot the role
 * leases next. A run an exception ends releases its slot unsettled, so edits it leaves there
 * are saved for the role's next run, and a run on a fresh checkout first takes back any such
 * work an earlier run of the role left (restoreSalvagedPhase). */
async function runOnceInLeasePhase(
  ctx: RunnerRunContext,
  plan: RunStartPlan,
  cfg: ResolvedModelConfig,
): Promise<RunOutcome> {
  const lease = await leaseSlot(ctx.root, {
    role: ctx.role,
    purpose: "run",
    ref: ctx.mainBranch,
    keep: plan.resuming || plan.handoff,
    signal: ctx.runSignal(),
    // The live view's pool budget: this read must not depend on tumwater.json being
    // readable right now (a broken file must not error the run before its pi run).
    slotBudget: slotCount(ctx.config),
  });
  let outcome: RunOutcome | undefined;
  try {
    let run = plan;
    if (!lease.preserved) {
      await checkoutRoleBranchPhase(ctx, lease.dir);
      run = await restoreSalvagedPhase(ctx, plan, lease.dir);
    }
    outcome = await runWithWorktreePhase(ctx, run, cfg, lease.dir);
    return outcome;
  } finally {
    // The slot is pinned for the next run's resume when the verdict armed `resumePending`
    // inside the run (the error-dirty and rate-limit arms in src/run/run-verdict.ts), or
    // when the outcome is an abort, quiet kill, or context cut-off. applyRunOutcome sets
    // `resumePending` for the other outcomes only after runOnce returns, so those are read off
    // the outcome here instead.
    const pin = slotPinnedForResume(ctx.state, outcome);
    // Detach is best-effort so it can never mask the run's own outcome or error; the release
    // still runs, and the next lease's checkout recovers an undetached branch either way.
    if (!pin) await gitTry(lease.dir, "checkout", "--detach");
    // An exception escaped the run (no outcome), so nothing settled the worktree — not even a
    // dirty check, when the exception was git itself failing (2026-10-21's spawn wedge): any
    // edits left in the slot are this role's unfinished work, saved for its next run.
    lease.release({ pin, unsettled: outcome === undefined });
  }
}

/** Give a run on a fresh checkout back the work an earlier run of its role left unsettled
 * (src/git/slot-salvage.ts): restore the newest waiting patch into `dir` and run over it as
 * planWithSalvagedWork says, told which files carry conflict markers and which hunks it must
 * place by hand when the branch moved under the patch. A run that does not take such work, or
 * has none waiting or cannot restore it now, keeps its plan. */
async function restoreSalvagedPhase(ctx: RunnerRunContext, plan: RunStartPlan, dir: string): Promise<RunStartPlan> {
  if (!takesSalvagedWork(plan)) return plan;
  // The waiting patch is a withdrawn claim's unfinished edits: kept for the operator, never
  // restored, so this run starts on its next entry like every other withdrawn run's successor.
  if (ctx.state.withdrawn !== undefined) {
    keepSalvagedWorkForOperator(ctx.root, ctx.role);
    return plan;
  }
  const restored = await restoreSalvagedWork(ctx.root, ctx.role, dir);
  if (restored === null) return plan;
  const note = buildSalvageRestoreNote(conflictedFileHunks(dir, restored.conflicted), restored.unplaced, restored.patch);
  return planWithSalvagedWork(ctx.role, plan, path.relative(ctx.root, restored.patch), note);
}

/** Put `tumwater/<role>` on the leased slot before authoring. An existing branch is checked
 * out, never reset — `-B` would discard the unmerged commit it durably holds; an absent one
 * is created from main. `--ignore-other-worktrees` lets the slot take the branch while a
 * legacy `.tumwater/worktrees/<role>` still holds it (the ordering that merges this part
 * before part 4c, which retires those directories); the stale checkout is never used again.
 * Untracked files are cleaned so the checkout is pristine. */
async function checkoutRoleBranchPhase(ctx: RunnerRunContext, dir: string): Promise<void> {
  const branch = branchName(ctx.role);
  if (await branchExists(ctx.root, branch)) {
    await git(dir, "checkout", "-f", "--ignore-other-worktrees", branch);
  } else {
    await git(dir, "checkout", "-f", "-b", branch, ctx.mainBranch);
  }
  await git(dir, "clean", "-fd");
}

async function runWithWorktreePhase(
  ctx: RunnerRunContext,
  plan: RunStartPlan,
  cfg: ResolvedModelConfig,
  /** The leased slot the run runs in; omitted by the director, which ensures its own. */
  leasedDir?: string,
): Promise<RunOutcome> {
  const { resuming } = plan;
  // Empty only for a promptless recovery run, which ends before any use of it (see below).
  let prompt = plan.prompt ?? "";

  const wt = leasedDir ?? (await ensureWorktree(ctx.root, ctx.role, ctx.mainBranch));

  if (resuming || plan.handoff) {
    // Keep the interrupted run's uncommitted edits; clear only stray merge/rebase state. A
    // handoff resumes a FRESH session over those same edits (the newest author session belongs
    // to another agent), so it preserves the worktree exactly as a resume does.
    await abortSync(wt);
    logEventBestEffort(ctx.root, {
      source: ctx.role,
      type: "resume",
      cause: plan.resumeCause,
      ...(plan.restored !== undefined ? { restored: plan.restored } : {}),
    });
  } else {
    const recovery = await recoverLeftoversForRun(ctx, plan, wt);
    if (recovery === null) return { result: "skipped" };
    if (recovery.action === "end") return recovery.outcome;
    prompt = recovery.prompt;
  }

  prompt = (await applyConflictHandback(ctx, plan, wt, prompt)).prompt;

  const piStartedAt = Date.now();

  const revision = await applyRevisionOrReject(ctx, plan, wt, prompt);
  prompt = revision.prompt;
  const revisionRound = revision.revisionRound;

  prompt = (await resendHandoffNote(ctx, plan, wt, prompt)).prompt;

  const { pi, flow, filed, ci, remote } = await authorRun(ctx, plan, cfg, wt, prompt);

  return handlePiResultPhase(ctx, pi, plan.userPrompt, revisionRound, wt, flow, filed, ci, remote, piStartedAt, cfg);
}

/** How does the run's pi session author? Run the authoring session over the prepared worktree
 * and prompt, fold any commit the agent made into the run's one commit (INV-H1), warn about a
 * stray write that landed in the primary checkout, and read the result-carrying reply lines the
 * observer roles end with. Returns everything the post-PI `handlePiResultPhase` needs, so the
 * caller hands off unchanged. */
async function authorRun(
  ctx: RunnerRunContext,
  plan: RunStartPlan,
  cfg: ResolvedModelConfig,
  wt: string,
  prompt: string,
): Promise<{
  pi: PiRunResult;
  flow: FlowResult | null;
  filed: FiledResult | null;
  ci: CiResult | null;
  remote: RemoteResult | null;
}> {
  const s = ctx.state;
  const runBase = await headOf(wt, "HEAD");
  // The stray-write warning only reports, so a `git status` that fails on either side skips it.
  const primaryBefore = await changedFiles(ctx.root).catch(() => null);
  const pi = await ctx.pi.runAuthoringPi(wt, prompt, `tumwater-${ctx.role}-${s.runs}`, plan.resuming, cfg);
  // The harness owns every commit (INV-H1): fold any the agent made into the run's one commit.
  await foldAgentCommitsSince(ctx, wt, runBase);
  // A write that landed in the primary checkout never reaches the worktree's commit, so the run
  // can read as no_change with its work orphaned (BUGS.md, 2026-10-20). The before/after diff
  // cannot attribute paths to this run when roles overlap, so only warn: the verdict and
  // resume handling below stay as they were.
  const primaryAfter = primaryBefore === null ? null : await changedFiles(ctx.root).catch(() => null);
  const strayed = primaryAfter === null ? [] : primaryAfter.filter((f) => !primaryBefore!.includes(f));
  if (strayed.length > 0 && !pi.aborted) {
    const shown = strayed.slice(0, 10).join(", ") + (strayed.length > 10 ? `, … (${strayed.length} paths)` : "");
    ctx.warn(`wrote outside the worktree (possibly another writer's): ${shown}`);
  }
  // The `qa` observer's reply ends with a result-carrying `FLOW:` line (plans/observer-roles.md
  // 2/2). Extracted once here, recorded only at the success returns below — an interrupted or
  // failed run must not advance the rotation. The harness records it, never pi.
  const flow = ctx.baseRole === "qa" ? extractFlow(pi.finalText) : null;
  // The `feedback` observer's reply ends with a result-carrying `FILED: #<n> — <title>` line
  // (plans/feedback-role.md 2/2). Extracted once here, recorded only at the success returns
  // below — an interrupted or failed run must not record a filing it never declared. The
  // harness records it, never pi.
  const filed = ctx.baseRole === "feedback" ? extractFiled(pi.finalText) : null;
  // The `ci` observer's reply ends with a result-carrying `CI: <sha> — <passed|failed>` line
  // (plans, part 3/3). Extracted once here, recorded only at the success returns below — an
  // interrupted or failed run must not record a coverage it never declared. The harness
  // records it, never pi.
  const ci = ctx.baseRole === "ci" ? extractCiResult(pi.finalText) : null;
  // The `ci` observer's reply also ends with a result-carrying `REMOTE:` line (plans/remote-
  // ci.md "The line"). It records only when the run's own prompt carried the Remote CI block:
  // if re-resolving the target below merely became non-null during the run (a workflow file or
  // remote landing on main), a stray REMOTE line in a block-less reply still records nothing.
  // The harness records it, never pi.
  const promptCarriedRemoteBlock = prompt.includes("Remote CI (GitHub Actions on ");
  let remote: RemoteResult | null = null;
  if (ctx.baseRole === "ci" && promptCarriedRemoteBlock) {
    const line = extractRemoteResult(pi.finalText);
    if (line) {
      let target: { repo: string; branch: string } | null = null;
      try {
        target = await remoteCiTarget(ctx.root, ctx.config);
      } catch {
        target = null; // a detection failure records nothing
      }
      if (target) remote = { repo: target.repo, ...line };
    }
  }
  return { pi, flow, filed, ci, remote };
}
