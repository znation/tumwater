import type { TumwaterConfig } from "../config/config-schema.js";
import type { TickOutcome, TickResult } from "../tick/tick-outcome.js";
import type { BackendFailureKind, PiRunOptions } from "../pi/pi.js";
import type { PiRunResult } from "../pi/pi-run-result.js";
import { loadLoopState, saveLoopState, zeroCounters, type LoopState } from "./loop-state.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";
import { baseRoleOf } from "../roles/loop-ids.js";
import { setRef, deleteRef, commitMessage, changeBaseRev } from "../git/git.js";
import { abortSync, ensureWorktree, resetWorktreeToMain } from "../git/worktree.js";
import { useWorktree } from "../git/worktree-use.js";
import { worktreePath } from "../paths.js";
import { logEvent, warnEvent } from "../events/events.js";
import { assembleTickPrompt } from "../tick/tick-prompt.js";
import {
  buildConflictDiscardNote,
  buildConflictHandbackNote,
  buildRevisionNote,
  buildRejectedReviewNote,
} from "../gates/gate-prompts.js";
import { LoopPi } from "./loop-pi.js";

import { configForRole, fallbackRoleConfig, modelSelectorField, reviewRunConfig, type ResolvedModelConfig } from "../config/config-views.js";
import { planTickStart, type TickStartPlan } from "../tick/tick-resume.js";
import { PendingPrompt } from "../inbox/pending-prompt.js";
import { stageTickLanding } from "../tick/tick-stage.js";
import { stageCheckFindings } from "../tick/stage-check.js";
import {
  modelFallbackActive,
  modelFallbackProbe,
  modelFallbackVerdict,
  providerFailureReason,
  recordModelFallback,
} from "./model-fallback.js";
import { clearBackoff } from "../scheduling/backoff.js";
import { finalizeTick } from "../tick/tick-finalize.js";
import { TickUsage } from "../tick/tick-usage.js";
import { recoverLeftover, type LeftoverRecovery } from "./leftover.js";
import { applyRevision, applyWithConflicts, REVISION_LIMIT } from "./revision.js";
import { mainCommitsTouching } from "../landing/landing-git.js";
import { bugfixMainRedNote, mainRedGate } from "../baseline/main-red.js";
import { mergeToMain } from "../landing/landing-merge.js";
import { resolveTickVerdict } from "../tick/tick-verdict.js";
import { extractFlow, type FlowResult } from "../verdict/reply-contract.js";
import { landingRefName, rejectedRefName } from "../paths.js";
import { errorMessage } from "../text/text.js";
import { shortSha } from "../text/format.js";

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

/** One role loop: owns a persistent worktree + branch and runs one tick at a time. */
export class LoopRunner {
  state: LoopState;
  /** The current tumwater.json config. Not readonly on purpose: the orchestrator pushes a
   * freshly loaded config in here every poll cycle (live-reload), and every downstream read
   * goes through this, so one assignment steers provider/model/thinking/instructions,
   * tick intervals, backoff, and role enablement for subsequent ticks. */
  config: TumwaterConfig;
  /** The 429 observation from this loop's usage accounting (TickUsage.lastRateLimit,
   * src/tick/tick-usage.ts): the orchestrator's fleet-wide hold wiring reads it through the
   * runner (src/fleet/fleet-polls.ts), so the field keeps its place on the runner's surface. */
  get lastRateLimit(): { at: number; retryAfterSeconds?: number } | undefined {
    return this.usage.lastRateLimit;
  }
  /** The backend-failure observation (TickUsage.lastBackendFailure, src/tick/tick-usage.ts): the
   * non-429 sibling of lastRateLimit above — the connection, timeout, server, and model-load
   * kinds the fleet-wide hold groups storms by (src/fleet/fleet-hold.ts). Same runner surface,
   * same consumer. */
  get lastBackendFailure(): { at: number; kind: BackendFailureKind } | undefined {
    return this.usage.lastBackendFailure;
  }
  /** Per-tick and lifetime usage accounting (src/tick/tick-usage.ts): the turns/cost windows the
   * commit trailer and tick_end event read, the lifetime totals folded into state, and the
   * observations above. Grown through foldUsage — the once-per-run choke point. */
  private readonly usage = new TickUsage();
  /** The dequeued user prompt a tick is executing and its requeue policy (src/inbox/pending-prompt.ts):
   * the raw director request is recorded at dequeue so an unfulfilled tick (abort, timeout, or
   * failure without changes) can re-queue it instead of losing the request. */
  private readonly pending: PendingPrompt;
  /** Per-tick abort controller, recreated at every tick start: `abortTick()` kills the
   * in-flight pi run without touching the harness shutdown signal (`this.signal`), which
   * would stop the whole fleet. */
  private tickAbort = new AbortController();
  /** Set by abortTick() when a user-initiated abort lands mid-tick: runTick's two abort
   * branches (author run, review gate) then diverge from shutdown semantics — worktree reset
   * to main, no director-prompt requeue, "user_aborted" result with normal backoff. Cleared
   * at the next tick start so a stale request can never leak into a later tick. */
  private userAborted = false;
  /** Set by handBackTick() when a budget-reopened handback lands mid-tick: it aborts the
   * tick WITHOUT the user-abort flag, so finishAbortedTick takes its shutdown branch (pi
   * session and worktree edits kept) and the tick ends `aborted` — but with a named resume
   * cause, so the resumed session's bridge prompt says the run moved back to the primary
   * model instead of claiming a harness restart. Cleared at the next tick start, like
   * userAborted. */
  private handedBack = false;
  /** The provider/model pair this tick's config resolved to at tick start (configForRole):
   * what the in-flight tick is running on. The orchestrator's budget-gate poll reads it via
   * tickModel() to hand fallback ticks back when the budget reopens (PLANS.md 2026-09-30); with
   * per-tier fallbacks (part 5c/8) the handback matches this pair against EVERY pair the tiers
   * resolve to, since different roles may run on different pairs.
   * Transient — never persisted — and captured fresh at every tick start. */
  private tickPair?: { provider?: string; model?: string };
  /** The loop-identity triple every tick-pipeline helper takes (root/role/mainBranch): the
   * constructor's readonly fields restated once, so finalizeTick, mergeToMain,
   * recoverLeftover, and resolveTickVerdict spread it instead of each retyping the pair of
   * this. accessors — one home for what "this loop" means to the tick pipeline. */
  private get loopCtx(): { root: string; role: string; mainBranch: string } {
    return { root: this.root, role: this.role, mainBranch: this.mainBranch };
  }

  /** The landing failure this tick's leftover recovery is retrying, if any (a retriable lander
   * outcome that kept the pin, which recovery re-queued): set in finishRecoveryTick and
   * attached to the returned TickOutcome so applyTickOutcome can feed it into the error streak
   * even though the tick itself ends `queued` (BUGS.md 2026-09-21). Reset at every tick start. */
  private recoveryFailure?: string;
  /** This loop's pi-run plumbing (src/loop/loop-pi.ts): shared per-run wiring, the transient
   * retry policy, and the SUMMARY follow-up. Host accessors are read live at every call, so
   * the orchestrator's config live-reload and the tick lifecycle need no notification path. */
  private readonly pi: LoopPi;
  /** This loop's base role: `feature-2` → `feature`. Every identity lookup that is ABOUT the
   * role (its catalog charter, model, tier, red-main class) reads this, while state, branch,
   * refs, inbox and notebook key the loop id. Equal to `role` until instances exist. */
  readonly baseRole: string;

  constructor(
    readonly root: string,
    readonly role: string,
    config: TumwaterConfig,
    readonly mainBranch: string,
    readonly signal?: AbortSignal,
    /** Injectable pause for the transient retry's wait (tests record instead of waiting). */
    readonly sleep?: (ms: number) => Promise<void>,
  ) {
    this.config = config;
    this.baseRole = baseRoleOf(role);
    this.pending = new PendingPrompt(root, role);
    this.state = loadLoopState(root, role);
    this.pi = new LoopPi({
      root: this.root,
      role: this.role,
      config: () => this.config,
      signal: this.signal,
      runSignal: () => this.runSignal(),
      warn: (message) => this.warn(message),
      foldUsage: (run) => this.foldUsage(run),
      foldLandingUsage: (run) => this.foldLandingUsage(run),
      tickNumber: () => this.state.ticks,
      sleep: this.sleep,
    });
    // A persisted running flag means the previous process died mid-tick WITHOUT the
    // graceful-abort bookkeeping (crash, kill -9, power loss). The interruption looks the
    // same on disk — pi session and worktree edits in place — so resume it the same way.
    if (this.state.running && role !== DIRECTOR_ROLE) this.state.resumePending = true;
    this.state.running = false;
    this.state.parkedSince = undefined;
  }

  private save(): void {
    saveLoopState(this.root, this.state);
  }

  /** Log one warning event for this loop — the single home of the warning-event shape, so every
   * warning site (pin failure, transient retry, error/quiet-kill streak, no-change diagnosis,
   * missing SUMMARY, high friction) stamps this loop and the "warning" type in one place. */
  private warn(message: string): void {
    warnEvent(this.root, this.role, message);
  }

  /** Zero the accumulated counters in memory and persist them. The orchestrator calls this
   * when it consumes a `tumwater reset-counters` request: without zeroing the in-memory copy,
   * the next tick's save would resurrect the pre-reset values on disk.
   * The zeroing mutates the EXISTING state object instead of replacing it: a tick may be in
   * flight when this runs (the documented use case is resetting a running fleet, where most
   * loops are mid-tick), and that tick holds its own reference to the same object — if we
   * swapped in a fresh copy here, the tick's end-of-save would write back the zeroed copy
   * instead of its bookkeeping, losing nextRunAt/backoff/lastResult and leaving running=true
   * on disk forever (the loop wedged until restart). In place, the in-flight tick's own
   * start/end saves stay authoritative over the same object. */
  resetCounters(): void {
    Object.assign(this.state, zeroCounters(this.state));
    this.save();
  }

  /** Clear this loop's backoff in memory and persist. The orchestrator calls this when it
   * consumes a `tumwater wake` request: eligibility is read from the IN-MEMORY state, so
   * without clearing the copy here the loop would keep sleeping until the original backoff
   * expired and the next save would resurrect the pre-wake schedule on disk.
   * As with resetCounters the mutation is in place on the EXISTING state object: a tick may
   * be in flight when this runs and holds its own reference to the same object — the
   * in-flight tick's own start/end saves stay authoritative over it. */
  wake(): void {
    Object.assign(this.state, clearBackoff(this.state, Date.now()));
    this.save();
  }

  /** Kill this loop's in-flight tick on user request (`tumwater abort --role <id>`). No-op
   * when no tick is running — the orchestrator checks `state.running` before calling, and a
   * direct call must not arm a stale flag. Otherwise set the userAborted flag and abort the
   * per-tick controller: runPi terminates the in-flight pi child (SIGTERM → SIGKILL
   * escalation) exactly like a harness shutdown, but only this loop's run dies — the fleet
   * keeps running. */
  abortTick(): void {
    if (!this.state.running) return;
    this.userAborted = true;
    this.tickAbort.abort();
  }

  /** Hand this loop's in-flight tick back to the primary model after the budget gate reopens
   * (PLANS.md 2026-09-30): abort the per-tick controller WITHOUT the user-abort flag, so
   * finishAbortedTick takes its shutdown branch — pi session and worktree edits kept — and
   * the tick ends `aborted`, which applyTickOutcome schedules to resume promptly. The
   * orchestrator calls this on every runner whose tickModel() still matches the fallback
   * pair the gate just left; a tick started on the primary (and the director) keeps running.
   * No-op when no tick is running, like abortTick. */
  handBackTick(): void {
    if (!this.state.running) return;
    this.handedBack = true;
    this.tickAbort.abort();
  }

  /** The provider/model pair the in-flight tick is running on (null when idle): the
   * orchestrator's budget handback matches this against the fallback pair it just left. */
  tickModel(): { provider?: string; model?: string } | null {
    return this.state.running ? (this.tickPair ?? null) : null;
  }

  /** The config this role's NEXT tick will run on, from the live config and the persisted
   * model-fallback episode: the tier fallback pair while the episode is active (a due probe
   * runs the primary), else the role's own resolved config — which the budget gate may
   * already have switched to its fallback pair. The orchestrator derives both the
   * per-provider failure hold's observation provider and the start pass's budget-breaker pair
   * from this, so a role mid-episode is keyed by the provider it will actually use, not the
   * primary it abandoned. Pure read of config + state + the caller's clock. */
  runConfig(now: number): ResolvedModelConfig {
    const fallback = fallbackRoleConfig(this.config, this.role);
    if (fallback !== null && modelFallbackActive(this.state.modelFallback, now)) return fallback;
    return configForRole(this.config, this.role);
  }

  /** The provider `runConfig(now)` resolves to; the hold and start passes read only this. */
  runProvider(now: number): string | undefined {
    return this.runConfig(now).provider;
  }

  /** The signal every pi run of the current tick watches: harness shutdown OR a per-tick user
   * abort (Node ≥ 20's AbortSignal.any). */
  private runSignal(): AbortSignal {
    return this.signal ? AbortSignal.any([this.signal, this.tickAbort.signal]) : this.tickAbort.signal;
  }

  /** Assemble this tick's prompt via src/tick/tick-prompt.ts (the prompt-content concern lives
   * there); the dequeued user request — the director's, or a per-role one — rides back so the
   * runner records it as pending — re-queued if the tick ends without fulfilling it. Null when
   * the loop has nothing to run (an empty director inbox); a role loop's assembly never
   * returns null. */
  private tickPrompt(): string | null {
    const assembled = assembleTickPrompt({ root: this.root, config: this.config, role: this.role, state: this.state });
    if (assembled === null) return null;
    this.pending.record(assembled.userPrompt);
    return assembled.prompt;
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
   * completes normally and the abort had no effect; re-issuing is the remedy. */
  private async finishAbortedTick(userPrompt: string | null, wt: string): Promise<TickOutcome> {
    if (this.userAborted) {
      // An explicit abort discards the request itself too: clear the dequeued prompt here —
      // required on the author-run path (whose early return skips runTick's shared clearing),
      // a no-op on the review-gate path (already cleared after the author run).
      this.pending.clear();
      await resetWorktreeToMain(wt, this.mainBranch);
      return { result: "user_aborted" };
    }
    // Shutdown mid-run: fail closed — a director prompt goes back to the inbox like any other
    // unfulfilled abort (mid-review the commit stays on the branch for re-review; mid-author-
    // run its half-done edits are discarded by the next tick's reset). A role's re-queued
    // prompt rides the resume that follows (mid-review the fresh recovery dequeues it like any
    // other tick instead — the flag is cleared and never reclaimed there).
    this.pending.requeueForResume(this.state, userPrompt);
    // A budget handback is an interruption with a named cause: the resumed session's bridge
    // prompt says the run was moved back to the primary model, not that the harness restarted.
    return this.handedBack ? { result: "aborted", resumeCause: "budget-resumed" } : { result: "aborted" };
  }

  /** Land the worktree branch on main (see src/landing/landing-merge.ts for the rebase → verify → ff-merge →
   * conflict-retry flow): delegates with this loop's identity, tick number, and shared pi wiring
   * so a conflict-resolution run folds into this tick's counters like any other pi run. Since
   * merge queue 2/5 only the refusal-note landing (src/verdict/refusal.ts) still uses it — reviewed
   * changes land through the landing pipeline's leased vet slot instead; md-only notes are
   * review-exempt by construction, so they keep this branch path (plans/merge-queue.md 2/5). */
  private async merge(wt: string, summary: string): Promise<TickResult> {
    return mergeToMain(
      {
        ...this.loopCtx,
        exemptPaths: this.config.review.exemptPaths,
        config: this.config,
        tick: this.state.ticks,
        runPi: (w, prompt, sessionName, config) => this.pi.runRolePi(w, prompt, sessionName, false, config),
      },
      wt,
      summary,
    );
  }

  /** Pin `sha` by this role's landing ref and free the worktree (plans/merge-queue.md invariant
   * 4): the pin must exist BEFORE resetWorktreeToMain moves the branch, or the commit is
   * orphaned. Returns false when the pin write failed — the caller then leaves the commit on its
   * branch (no reset) and defers to next-tick recovery, which adopts it into the pin scheme.
   * After a successful pin the review gate and the rebase run in the vet's leased pool slot —
   * never in this worktree (merge queue 2/5). */
  private async pinAndReset(wt: string, sha: string): Promise<boolean> {
    const pinned = await setRef(this.root, landingRefName(this.role), sha);
    if (!pinned) {
      this.warn(
        `failed to pin ${shortSha(sha)} by its landing ref — leaving the commit on the branch for next-tick recovery`,
      );
      return false;
    }
    await resetWorktreeToMain(wt, this.mainBranch);
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
  private async finishRecoveryTick(
    recovered: Exclude<LeftoverRecovery, { kind: "discarded" } | { kind: "handback" }>,
    userPrompt: string | null,
    wt: string,
    priorLandingFailure: string | undefined,
  ): Promise<TickOutcome> {
    this.pending.clear();
    this.pending.requeueUnfulfilled(userPrompt);
    if (recovered.kind === "unpinned") {
      this.state.lastError = `failed to pin leftover ${shortSha(recovered.sha)} by its landing ref; left for next-tick recovery`;
      return { result: "error", summary: this.state.lastError, recoveredLeftover: true };
    }
    if (recovered.kind === "held") {
      // A permanent reviewer configuration error holds the pin: do not re-queue (and pay
      // another gate check) until the model config changes. Ending `error` schedules the error
      // ladder, so the hold is re-checked at backoff pace rather than at suite speed
      // (BUGS.md 2026-10-06).
      this.state.lastError = recovered.message;
      return { result: "error", summary: recovered.message, recoveredLeftover: true };
    }
    const { entry } = recovered;
    if (recovered.kind === "enqueued") {
      this.recoveryFailure = priorLandingFailure;
      await resetWorktreeToMain(wt, this.mainBranch);
    }
    return {
      result: "queued",
      summary: entry.summary,
      commit: entry.sha,
      highFriction: entry.highFriction,
      recoveredLeftover: true,
    };
  }

  /** Fold one pi run's usage into the tick's counters and the lifetime totals — the
   * accounting itself lives in TickUsage.fold (src/tick/tick-usage.ts); this keeps the once-per-run
   * choke point and the foldLandingUsage face on the runner, where LoopPi and the landing
   * wiring (src/landing/landing-slot.ts) reach them. */
  private foldUsage(run: PiRunResult): void {
    this.usage.fold(this.state, run);
  }

  /** Run pi for the orchestrator's landing slot (merge queue 3/5): the shared per-loop wiring
   * of runRolePi — role config, session dir, raw log, transient-failure retry — with usage
   * folded into this loop's counters, but watching ONLY the harness shutdown signal
   * (`this.signal`, which may be undefined — PiRunOptions.signal is optional): a landing is
   * outside any tick, so `tumwater abort --role` (which targets a tick's per-tick abort
   * controller) must never reach it, and the stale per-tick controller of a finished tick must
   * not abort it either. Session naming is the caller's (the reviewer composes its own from
   * ReviewContext.tick; landing-merge.ts keeps its conflict-resolver naming through LanderContext.runPi).
   * The plumbing itself lives in src/loop/loop-pi.ts; this is the landing slot's public face. */
  async runLandingPi(wt: string, prompt: string, sessionName: string, config?: ResolvedModelConfig): Promise<PiRunResult> {
    return this.pi.runLandingPi(wt, prompt, sessionName, config);
  }

  /** Run pi for the landing gate's reviewer (the review run and its verdict follow-up) through
   * the loop's shared transient-retry wiring — the same retry an authoring run gets, so a 429
   * in the gate is waited out and retried once instead of failing the review on first contact
   * (BUGS.md 2026-10-01). A retried first attempt is folded here at retry time (the fleet-wide
   * rate-limit hold's input); the FINAL run's usage is folded by the gate's caller, exactly as
   * before — the plumbing lives in src/loop/loop-pi.ts; this is the landing wiring's public face. */
  async runGatePi(opts: PiRunOptions): Promise<PiRunResult> {
    return this.pi.runGatePi(opts);
  }

  /** Public face of foldUsage for the orchestrator's landing wiring: folds a landing pi run
   * (reviewer, conflict resolution) into the AUTHORING role's counters, so the fleet's daily
   * cost and the per-role usage windows attribute that spend to the role that authored the
   * work — no new counter semantics, just the same fold loop.ts applies to its tick runs. */
  foldLandingUsage(run: PiRunResult): void {
    // authoring=false: a landing/review run's usage counts toward cost and prompt tokens, but
    // never toward the tick's pre-edit counter (src/tick/tick-usage.ts fold).
    this.usage.fold(this.state, run, false);
  }

  /** Run one full tick of this role loop: build (or resume) the prompt, run pi in the
   * worktree, commit and merge any changes it made, then schedule the next run from the
   * outcome — changed/skipped/cut-off ticks wait at least the minimum interval, an aborted
   * one resumes promptly on restart, an unproductive one backs off on the idle ladder, and
   * a failed one on the shorter error ladder (tick-apply.ts). Never throws: a failed tick
   * is an "error" result, saved and logged like any other so the loop stays resumable and
   * observable. */
  async tick(): Promise<TickOutcome> {
    const s = this.state;
    // This role's view of the config (per-role provider/model/thinking + minTickIntervalSeconds
    // overrides): resolved once so every interval-based scheduling branch below honors a slow
    // clock (e.g. the steward's ~6 h) and a live-reloaded config applies from this tick on.
    const primaryCfg = configForRole(this.config, this.role);
    // Model-fallback episode (src/loop/model-fallback.ts): while one is active the tick runs
    // on the role's tier fallback pair, and once the cooldown elapses it runs on the primary
    // as the probe. Resolved at tick start so the authoring run below and the end-of-tick fold
    // agree on which pair ran. Null fallback (the tier resolves to pause) keeps the feature off.
    const now = Date.now();
    const fallback = fallbackRoleConfig(this.config, this.role);
    const probing = fallback !== null && modelFallbackProbe(s.modelFallback, now);
    const onFallback = fallback !== null && modelFallbackActive(s.modelFallback, now);
    const cfg = onFallback && fallback !== null ? fallback : primaryCfg;
    // Capture what this tick runs on (the orchestrator's budget handback matches it against
    // the fallback pair) and clear any stale handback flag: an abort request that lands while
    // the loop is idle must not name a later tick's resume.
    this.tickPair = { provider: cfg.provider, model: cfg.model };
    this.handedBack = false;
    s.ticks += 1;
    // gen / peak ctx are per-tick windows, not lifetime totals (user decision 2026-08-25):
    // reset before the start-of-tick save so a working loop's columns grow live from 0 and
    // an idle loop's show its last completed tick. The loop's pi plumbing accumulates every pi
    // run of this tick (main + transient-timeout retry + conflict resolution) into them, and the
    // end-of-tick save persists the finished run's totals.
    s.generatedTokens = 0;
    s.peakContextTokens = 0;
    this.usage.reset();
    this.recoveryFailure = undefined;
    // A fresh per-tick abort controller and a cleared user-abort flag: an abort request that
    // lands while the loop is idle must not leak into the next tick.
    this.tickAbort = new AbortController();
    this.userAborted = false;
    s.running = true;
    s.lastTickStartedAt = Date.now();
    const tick = s.ticks;
    const tickStartedAt = s.lastTickStartedAt;
    this.save();
    // The selector this tick's runs start on (plans/model-tiers.md "Observability"): with
    // the budget fallback active the config already names the fallback pair, so the logged
    // string is what the runs actually use. Omitted when no model is configured (pi's own
    // default), so old logs and old configs render unchanged.
    logEvent(this.root, {
      loop: this.role,
      type: "tick_start",
      tick,
      ...modelSelectorField(cfg),
    });

    let outcome: TickOutcome;
    try {
      outcome = await this.runTick(cfg, { fallback, probe: probing, primary: primaryCfg });
    } catch (err) {
      outcome = { result: "error" };
      s.lastError = errorMessage(err);
      // An exception between the dequeue/reclaim and the pi run leaves the request only in
      // the pending field — memory this failed tick is about to drop, with no outcome handler
      // left to re-queue it (the handlers run inside runTick, after the pi run). The queue is
      // the durable store, so the catch re-queues whatever is still pending, like every
      // unfulfilled outcome does; it is always null once a pi run has been accounted for.
      this.pending.requeuePendingUnfulfilled();
    }
    // Everything after the pi run — the outcome folds, the main-head read, next-run
    // scheduling, the episode warnings, and the tick_end event — is the tick's per-result
    // bookkeeping policy, not runner lifecycle: it lives in src/tick/tick-finalize.ts, which owns
    // the ordering (the folds land on state before the schedule, the head read happens while
    // `running` is still true) and the per-episode warning crossings. The tick number and
    // start time are passed through as captured above: both must describe the tick tick_start
    // announced, not whatever resetCounters (a documented mid-tick operation) may have left
    // on the shared state by finalize time.
    const finalizeResult = await finalizeTick({
      ...this.loopCtx,
      config: cfg,
      state: s,
      outcome,
      tick,
      tickStartedAt,
      usage: this.usage,
      recoveryFailure: this.recoveryFailure,
    });
    // The tick is over: the captured pair must not outlive it (a later poll must never match
    // an idle loop's stale pair against a resumed fallback).
    this.tickPair = undefined;
    return finalizeResult;
  }

  /** Fold one AUTHORING run's verdict into the role's model-fallback state
   * (src/loop/model-fallback.ts) and emit the episode's started/ended events. Only the run
   * that actually happened is evidence: a tick that never invoked pi (a skipped director
   * inbox, a recovered leftover, a red-main block) returns from runTick before this is
   * reached, and modelFallbackVerdict reports an aborted/killed/timed-out run as
   * inconclusive — so neither can end an episode without the primary having answered.
   * A role whose tier resolves to no fallback pair never trips, and an episode persisted from a
   * config that HAD a pair is cleared when a live edit removes it (or sets it to "pause"), so a
   * stale "on fallback" mark cannot outlive the config that created it. Persists on any state
   * change; the tick's own finalize save carries it too. */
  private foldModelFallback(
    ctx: { fallback: ResolvedModelConfig | null; probe: boolean; primary: ResolvedModelConfig },
    pi: PiRunResult,
  ): void {
    const s = this.state;
    const prior = s.modelFallback;
    const now = Date.now();
    const verdict = modelFallbackVerdict(pi);
    const reason = providerFailureReason(pi.transientRateLimit, pi.backendKind);
    const wasIn = prior !== undefined && prior.since > 0;
    if (ctx.fallback === null) {
      // No fallback pair resolves any more: the feature is off for this role. End a persisted
      // episode (the primary just ran, so this tick IS the return), and drop any pre-trip count
      // so a later config starts from zero. A killed/aborted/timed-out run is no verdict, so it
      // leaves the episode in place exactly as it does on a configured fallback.
      if (prior === undefined) return;
      if (wasIn && verdict === "inconclusive") return;
      this.emitFallbackEnded(prior, ctx.primary, now, wasIn);
      s.modelFallback = undefined;
      this.save();
      return;
    }
    const next = recordModelFallback(prior, { verdict, probe: ctx.probe, now, reason });
    const willBeIn = next !== undefined && next.since > 0;
    if (!wasIn && willBeIn) {
      logEvent(this.root, {
        loop: this.role,
        type: "model_fallback_started",
        provider: ctx.fallback.provider,
        model: ctx.fallback.model,
        reason: next?.reason,
      });
    } else if (wasIn && !willBeIn) {
      logEvent(this.root, {
        loop: this.role,
        type: "model_fallback_ended",
        provider: ctx.primary.provider,
        model: ctx.primary.model,
        durationMs: now - (prior?.since ?? now),
      });
    }
    if (next !== prior) {
      s.modelFallback = next;
      this.save();
    }
  }

  /** Log the model_fallback_ended event for an episode that was active. Split out so the two
   * ending paths — a successful probe and a config that dropped the pair — name the primary
   * pair and duration the same way. A pre-trip state (no episode) has no ended event. */
  private emitFallbackEnded(
    prior: NonNullable<LoopState["modelFallback"]>,
    primary: ResolvedModelConfig,
    now: number,
    wasIn: boolean,
  ): void {
    if (!wasIn) return;
    logEvent(this.root, {
      loop: this.role,
      type: "model_fallback_ended",
      provider: primary.provider,
      model: primary.model,
      durationMs: now - (prior.since || now),
    });
  }

  private async runTick(
    cfg: ResolvedModelConfig,
    fallbackCtx: { fallback: ResolvedModelConfig | null; probe: boolean; primary: ResolvedModelConfig },
  ): Promise<TickOutcome> {
    const s = this.state;
    // How this tick starts — resume the interrupted session or run fresh, and which prompt —
    // is the resume policy, not runner mechanics: it lives in src/tick/tick-resume.ts, which also
    // consumes the resume flags and reclaims the interrupted tick's re-queued prompt. A null
    // plan means the loop has nothing to run.
    const plan = planTickStart({
      root: this.root,
      role: this.role,
      state: s,
      pending: this.pending,
      tickPrompt: () => this.tickPrompt(),
    });
    if (plan === null) return { result: "skipped" };
    // Hold the worktree from before ensureWorktree — creating or resetting it is part of the
    // use — to the tick's end (plans/disk-floor.md, part 2/4), so a concurrent pressure
    // reclaim never cleans a tree this tick is creating or working in.
    return useWorktree(this.root, worktreePath(this.root, this.role), () =>
      this.tickWithWorktree(plan, cfg, fallbackCtx),
    );
  }

  private async tickWithWorktree(
    plan: TickStartPlan,
    cfg: ResolvedModelConfig,
    fallbackCtx: { fallback: ResolvedModelConfig | null; probe: boolean; primary: ResolvedModelConfig },
  ): Promise<TickOutcome> {
    const s = this.state;
    const { priorLandingFailure, resuming, resumeCause, userPrompt } = plan;
    let prompt = plan.prompt;

    const wt = await ensureWorktree(this.root, this.role, this.mainBranch);
    if (resuming) {
      // Keep the interrupted run's uncommitted edits; clear only stray merge/rebase state.
      await abortSync(wt);
      logEvent(this.root, { loop: this.role, type: "resume", cause: resumeCause });
    } else {
      // Salvage a commit a previous tick left unlanded (src/loop/leftover.ts): recovery puts it back
      // on the land queue, so it lands through the orchestrator's landing pipeline — the same
      // gate as a fresh tick's change, and main keeps exactly one writer (an in-tick recovery
      // landing raced the slot's batches into `merge_blocked`). A salvaged leftover ENDS the
      // tick: the role holds one landing ref, and the leftover owns it until its landing
      // resolves. With nothing to salvage the branch holds nothing either, so the reset below
      // leaves pristine main for the red-main gate.
      // A permanent reviewer config error -- held from re-queueing -- clears once the resolved
      // reviewer selector changes, so fixing the model config recovers the pin automatically
      // (BUGS.md 2026-10-06).
      const reviewSelector = modelSelectorField(reviewRunConfig(this.config)).model;
      if (s.landingReviewError && s.landingReviewError.selector !== reviewSelector) s.landingReviewError = undefined;
      const recovered = await recoverLeftover({
        ...this.loopCtx,
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
          reason: "landing",
          applied: false,
        };
        logEvent(this.root, { loop: this.role, type: "conflict_handback", action: "queued", sha: recovered.sha, reason: "landing" });
      } else if (recovered?.kind === "discarded") {
        // The pin hit the conflict cap and is gone: nothing holds the role any more, so this
        // tick authors on a fresh main like any other — told what was dropped and why.
        s.mergeConflicts = undefined;
        s.conflictHandback = undefined;
        s.conflictDiscard = { sha: recovered.sha, summary: recovered.summary, attempts: recovered.attempts, at: Date.now() };
        prompt += `\n\n${buildConflictDiscardNote(recovered.summary, recovered.attempts)}`;
      } else if (recovered) return this.finishRecoveryTick(recovered, userPrompt, wt, priorLandingFailure);
      await resetWorktreeToMain(wt, this.mainBranch);
      // Red-main baseline gate (src/baseline/main-red.ts): the worktree is pristine main right now —
      // verify main's own suite before spending an authoring run on top of it. Only roles whose
      // diff can carry code changes are blocked; resume ticks skip this by construction (their
      // worktree is not pristine main). The `bugfix` healer is exempt because its fix is the
      // fleet's only way back to green, so instead of blocking it we hand it the failure (PLANS.md
      // "Red-main handoff"): the same check runs, but a red main appends a <main-red> note to
      // this tick's prompt so it reproduces and fixes that failure rather than hunting blind.
      if (this.baseRole === "bugfix") {
        const note = await bugfixMainRedNote(this.root, this.role, wt);
        if (note) prompt += `\n\n${note}`;
      } else {
        const blocked = await mainRedGate(this.root, this.role, wt);
        if (blocked) {
          // The dequeued prompt never ran: put it back in its queue before returning, so it is
          // not lost to a restart (the pending field is memory-only) or dropped by the next
          // tick's outcome handling — the queue is the durable store, and once main is green
          // the next tick dequeues it again (PLANS.md "Per-role prompts 1/2" criterion b).
          this.pending.requeueUnfulfilled(userPrompt);
          this.pending.clear();
          return blocked;
        }
      }
    }

    // A change handed back after its landings kept conflicting — or a persisted hand-back the
    // author's tick has not applied yet — is re-applied over current main with the conflict
    // markers left as ordinary uncommitted edits so this tick resolves them (PLANS.md "Robust
    // conflict landing, part 2/2"). The landing ref is deleted once the diff is in the worktree.
    // Runs before the revision branch, which applies a revision hand-back itself.
    if (
      s.conflictHandback &&
      !s.conflictHandback.applied &&
      this.role !== DIRECTOR_ROLE &&
      userPrompt === null &&
      !resuming
    ) {
      const hb = s.conflictHandback;
      const applied = await applyWithConflicts(wt, this.mainBranch, hb.sha);
      if (applied.applied) {
        s.conflictHandback = { ...hb, applied: true };
        await deleteRef(this.root, landingRefName(this.role));
        logEvent(this.root, {
          loop: this.role,
          type: "conflict_handback",
          action: "applied",
          sha: hb.sha,
          reason: hb.reason,
          conflicted: applied.conflicted,
        });
        const intent = await handbackIntent(wt, this.mainBranch, hb.sha, applied.conflicted);
        prompt += `\n\n${buildConflictHandbackNote(hb.reason, applied.conflicted, intent)}`;
      } else {
        // The object is gone or the apply failed for a non-conflict reason: drop the hand-back
        // so the author starts fresh rather than retrying it every tick.
        s.conflictHandback = undefined;
        await deleteRef(this.root, landingRefName(this.role));
        logEvent(this.root, { loop: this.role, type: "conflict_handback", action: "failed", sha: hb.sha, reason: hb.reason });
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
    if (s.revision && this.role !== DIRECTOR_ROLE && userPrompt === null) {
      const { sha, round } = s.revision;
      if (resuming) {
        // The interrupted revision run's applied edits are still in the worktree (the resume
        // path keeps uncommitted work), so this tick still owns the revision.
        revisionRound = round;
      } else if (await applyRevision(wt, this.mainBranch, sha)) {
        revisionRound = round;
        logEvent(this.root, { loop: this.role, type: "revision", action: "applied", round, sha });
        prompt += `\n\n${buildRevisionNote(s.lastReview ?? { reasons: [] }, round, REVISION_LIMIT)}`;
      } else {
        // The clean re-apply conflicted: re-apply with the markers left in place so the author
        // resolves them rather than losing the revision (PLANS.md "Robust conflict landing, part
        // 2/2"). Only a non-conflict failure falls back to the plain rejection note.
        const withConflicts = await applyWithConflicts(wt, this.mainBranch, sha);
        if (withConflicts.applied) {
          revisionRound = round;
          s.conflictHandback = {
            sha,
            at: Date.now(),
            reason: "revision",
            round,
            applied: true,
          };
          logEvent(this.root, { loop: this.role, type: "revision", action: "applied", round, sha });
          logEvent(this.root, {
            loop: this.role,
            type: "conflict_handback",
            action: "applied",
            sha,
            reason: "revision",
            conflicted: withConflicts.conflicted,
          });
          prompt += `\n\n${buildRevisionNote(s.lastReview ?? { reasons: [] }, round, REVISION_LIMIT)}`;
          const intent = await handbackIntent(wt, this.mainBranch, sha, withConflicts.conflicted);
          prompt += `\n\n${buildConflictHandbackNote("revision", withConflicts.conflicted, intent)}`;
        } else {
          s.revision = undefined;
          await deleteRef(this.root, rejectedRefName(this.role));
          logEvent(this.root, { loop: this.role, type: "revision", action: "conflict", round, sha });
          prompt += `\n\n${buildRejectedReviewNote(s.lastReview ?? { reasons: [] }, this.role)}`;
          prompt += `\n\nThe rejected diff no longer applies to current main.`;
        }
      }
    }
    const pi = await this.pi.runAuthoringPi(wt, prompt, `tumwater-${this.role}-${s.ticks}`, resuming, cfg);
    // Fold the authoring run's verdict into the role's model-fallback episode NOW, before the
    // post-run handlers spend any more pi runs: only this run is evidence about the primary.
    this.foldModelFallback(fallbackCtx, pi);
    // The `qa` observer's reply ends with a result-carrying `FLOW:` line (plans/observer-roles.md
    // 2/2). Extracted once here, recorded only at the success returns below — an interrupted or
    // failed tick must not advance the rotation. The harness records it, never pi.
    const flow = this.baseRole === "qa" ? extractFlow(pi.finalText) : null;

    return this.handlePiResult(pi, userPrompt, revisionRound, wt, flow, piStartedAt, cfg);
  }

  /** Turn a finished pi run into its TickOutcome: the post-run half of runTick, split off so
   * each half reads on its own screen — the setup above ends at the pi return. The verdict
   * classification (abort, config request, quiet kill, timeout, refusal, failure, no-change)
   * lives in resolveTickVerdict (src/tick/tick-verdict.ts), and the fulfillable path — staging —
   * stays here. `userPrompt` is the raw director prompt this tick is executing (null for role
   * loops) so unfulfilled outcomes can re-queue it; `revisionRound` is the revision this tick
   * holds (undefined when it is not a revision); `flow` is the qa observer's FLOW line
   * (null for every other role). */
  private async handlePiResult(
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
      ...this.loopCtx,
      state: this.state,
      pending: this.pending,
      turns: this.usage.turns,
      userPrompt,
      revisionRound,
      wt,
      pi,
      flow,
      warn: (message) => this.warn(message),
      merge: (w, sum) => this.merge(w, sum),
      finishAbortedTick: () => this.finishAbortedTick(userPrompt, wt),
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
    // landed/land_failed; a non-terminal outcome keeps the pin for next-tick leftover recovery.
    // `commits` was NOT incremented above: it counts landed changes only.
    return stageTickLanding({
      root: this.root,
      role: this.role,
      state: this.state,
      config: this.config,
      tickTurns: this.usage.turns,
      userPrompt,
      revisionRound,
      mainBranch: this.mainBranch,
      wt,
      finalText: pi.finalText,
      flow,
      piStartedAt,
      warn: (message) => this.warn(message),
      requestSummary: (w) => this.pi.requestSummary(w, cfg),
      stageCheck: (w) => stageCheckFindings(w, this.mainBranch, this.config.review.exemptPaths),
      requestStageFix: (w, findings) => this.pi.requestStageFix(w, findings, cfg),
      pinAndReset: (w, sha) => this.pinAndReset(w, sha),
      finishAbortedTick: () => this.finishAbortedTick(userPrompt, wt),
    });
  }
}
