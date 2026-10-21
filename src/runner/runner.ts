import type { TumwaterConfig } from "../config/config-schema.js";
import type { RunOutcome } from "../run/run-outcome.js";
import type { BackendFailureKind, PiRunOptions } from "../pi/pi.js";
import type { PiRunResult } from "../pi/pi-run-result.js";
import { saveRunnerState, saveRunnerStateBestEffort, zeroCounters, type RunnerState } from "./runner-state.js";
import { loadRunnerState } from "./runner-state-load.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";
import { baseRoleOf } from "../roles/runner-ids.js";
import { logEventBestEffort, warnEventBestEffort } from "../events/events.js";
import { promptPreview } from "../inbox/inbox.js";
import { assembleRunPrompt } from "../run/run-prompt.js";
import { RunnerPi } from "./runner-pi.js";
import {
  configForRole,
  seamHoldKey,
  withModelOverrides,
  type ResolvedModelConfig,
} from "../config/config-views.js";
import { fallbackRoleConfig } from "../config/config-fallbacks.js";
import { PendingPrompt } from "../inbox/pending-prompt.js";
import { modelFallbackActive } from "./model-fallback.js";
import { clearBackoff } from "../scheduling/backoff.js";
import { RunUsage } from "../run/run-usage.js";
import {
  runOncePhase,
  runPhase,
  type FallbackRunContext,
  type RunnerRunContext,
} from "./runner-run.js";
import {
  finishAbortedRunPhase,
  finishRecoveryRunPhase,
  pinAndResetPhase,
} from "./runner-recovery.js";
import { foldModelFallbackPhase } from "./runner-fallback.js";
import type { LeftoverRecovery } from "./leftover.js";

/** One role runner: owns a persistent worktree + branch and runs one run at a time. */
export class RoleRunner {
  state: RunnerState;
  /** The current tumwater.json config. Not readonly on purpose: the orchestrator pushes a
   * freshly loaded config in here every poll cycle (live-reload), and every downstream read
   * goes through this, so one assignment steers provider/model/thinking/instructions,
   * run intervals, backoff, and role enablement for subsequent runs. */
  config: TumwaterConfig;
  /** The 429 observation from this runner's usage accounting (RunUsage.lastRateLimit,
   * src/run/run-usage.ts): the orchestrator's team-wide hold wiring reads it through the
   * runner (src/team/team-polls.ts), so the field keeps its place on the runner's surface. */
  get lastRateLimit(): { at: number; retryAfterSeconds?: number; provider?: string } | undefined {
    return this.usage.lastRateLimit;
  }
  /** The backend-failure observation (RunUsage.lastBackendFailure, src/run/run-usage.ts): the
   * non-429 sibling of lastRateLimit above — the connection, timeout, server, and model-load
   * kinds the team-wide hold groups storms by (src/team/team-hold.ts). Same runner surface,
   * same consumer. */
  get lastBackendFailure(): { at: number; kind: BackendFailureKind; provider?: string } | undefined {
    return this.usage.lastBackendFailure;
  }
  /** Per-run and lifetime usage accounting (src/run/run-usage.ts): the turns/cost windows the
   * commit trailer and run_end event read, the lifetime totals folded into state, and the
   * observations above. Grown through foldUsage — the once-per-run choke point. */
  private readonly usage = new RunUsage();
  /** The dequeued user prompt a run is executing and its requeue policy
   * (src/inbox/pending-prompt.ts): the raw director request is recorded at dequeue so an
   * unfulfilled run (abort, timeout, or failure without changes) can re-queue it instead of
   * losing the request. */
  private readonly pending: PendingPrompt;
  /** Per-run abort controller, recreated at every run start: `abortRun()` kills the
   * in-flight pi run without touching the harness shutdown signal (`this.signal`), which
   * would stop the whole team. */
  private runAbort = new AbortController();
  /** Set by abortRun() when a user-initiated abort lands mid-run: runOnce's two abort
   * branches (author run, review gate) then diverge from shutdown semantics — worktree reset
   * to main, no director-prompt requeue, "user_aborted" result with normal backoff. Cleared
   * at the next run start so a stale request can never leak into a later run. */
  private userAborted = false;
  /** Set by handBackRun() when a budget-reopened handback lands mid-run: it aborts the
   * run WITHOUT the user-abort flag, so finishAbortedRun takes its shutdown branch (pi
   * session and worktree edits kept) and the run ends `aborted` — but with a named resume
   * cause, so the resumed session's bridge prompt says the run moved back to the primary
   * model instead of claiming a harness restart. Cleared at the next run start, like
   * userAborted. */
  private handedBack = false;
  /** The provider/model pair this run's config resolved to at run start (configForRole):
   * what the in-flight run is running on. The orchestrator's budget-gate poll reads it via
   * runModelPair() to hand fallback runs back when the budget reopens (PLANS.md 2026-09-30); with
   * per-tier fallbacks (part 5c/8) the handback matches this pair against EVERY pair the tiers
   * resolve to, since different roles may run on different pairs.
   * Transient — never persisted — and captured fresh at every run start. */
  private runPair?: { provider?: string; model?: string };
  /** Whether the budget gate currently has the team on its free fallback pairs (src/gates/
   * budget-gates.ts onFallback, set alongside `config` by the orchestrator's poll): an
   * image reroute may then look only among the free fallback pairs, never a priced primary
   * (plans/image-input.md "Reroute target" "Regime"). Pure scheduler input, never whether
   * the runner itself is mid-fallback; defaults false, so standalone-runner tests stay on the
   * primary regime unless they set it. */
  budgetFallbackActive = false;
  /** The merge failure this run's leftover recovery is retrying, if any (a retriable merger
   * outcome that kept the pin, which recovery re-queued): set in finishRecoveryRun and
   * attached to the returned RunOutcome so applyRunOutcome can feed it into the error streak
   * even though the run itself ends `queued` (BUGS.md 2026-09-21). Reset at every run start. */
  private recoveryFailure?: string;
  /** This runner's pi-run plumbing (src/runner/runner-pi.ts): shared per-run wiring, the transient
   * retry policy, and the SUMMARY follow-up. Host accessors are read live at every call, so
   * the orchestrator's config live-reload and the run lifecycle need no notification path. */
  private readonly pi: RunnerPi;
  /** This runner's base role: `feature-2` → `feature`. Every identity lookup that is ABOUT the
   * role (its catalog charter, model, tier, red-main class) reads this, while state, branch,
   * refs, inbox and notes key the runner id. Equal to `role` until instances exist. */
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
    this.state = loadRunnerState(root, role);
    this.pi = new RunnerPi({
      root: this.root,
      role: this.role,
      config: () => this.config,
      signal: this.signal,
      runSignal: () => this.runSignal(),
      warn: (message) => this.warn(message),
      foldUsage: (run, provider, pair) => this.foldUsage(run, provider, pair),
      foldMergeUsage: (run, provider, pair) => this.foldMergeUsage(run, provider, pair),
      runNumber: () => this.state.runs,
      sleep: this.sleep,
    });
    // A persisted running flag means the previous process died mid-run WITHOUT the
    // graceful-abort bookkeeping (crash, kill -9, power loss). The interruption looks the
    // same on disk — pi session and worktree edits in place — so resume it the same way.
    if (this.state.running && role !== DIRECTOR_ROLE) this.state.resumePending = true;
    this.state.running = false;
    this.state.parkedSince = undefined;
    this.state.parkedOn = undefined;
  }

  private save(): void {
    saveRunnerState(this.root, this.state);
  }

  /** Log one warning event for this runner — the single home of the warning-event shape, so
   * every warning site (pin failure, transient retry, error/quiet-kill streak, no-change
   * diagnosis, missing SUMMARY, high friction) stamps this runner and the "warning" type in
   * one place. */
  private warn(message: string): void {
    warnEventBestEffort(this.root, this.role, message);
  }

  /** Zero the accumulated counters in memory and persist them (the orchestrator's
   * `tumwater reset-counters` request). Mutating the EXISTING state object keeps an in-flight
   * run's own start/end saves authoritative over the same reference; swapping in a fresh copy
   * would lose its nextRunAt/backoff/lastResult and leave running=true on disk. */
  resetCounters(): void {
    Object.assign(this.state, zeroCounters(this.state));
    this.save();
  }

  /** Clear this runner's backoff in memory and persist (the orchestrator's `tumwater wake`
   * request). Eligibility reads the IN-MEMORY state; the mutation is in place on the EXISTING
   * object, as with resetCounters, so an in-flight run's saves stay authoritative. */
  wake(): void {
    Object.assign(this.state, clearBackoff(this.state, Date.now()));
    this.save();
  }

  /** Kill this runner's in-flight run on user request (`tumwater abort --role <id>`). No-op
   * when no run is running — the orchestrator checks `state.running` before calling, and a
   * direct call must not arm a stale flag. Otherwise set the userAborted flag and abort the
   * per-run controller: runPi terminates the in-flight pi child (SIGTERM → SIGKILL
   * escalation) exactly like a harness shutdown, but only this runner's run dies — the team
   * keeps running. */
  abortRun(): void {
    if (!this.state.running) return;
    this.userAborted = true;
    this.runAbort.abort();
  }

  /** Hand this runner's in-flight run back to the primary model after the budget gate reopens
   * (PLANS.md 2026-09-30): abort the per-run controller WITHOUT the user-abort flag, so
   * finishAbortedRun takes its shutdown branch — pi session and worktree edits kept — and
   * the run ends `aborted`, which applyRunOutcome schedules to resume promptly. The
   * orchestrator calls this on every runner whose runModelPair() still matches the fallback
   * pair the gate just left; a run started on the primary (and the director) keeps running.
   * No-op when no run is running, like abortRun. */
  handBackRun(): void {
    if (!this.state.running) return;
    this.handedBack = true;
    this.runAbort.abort();
  }

  /** The provider/model pair the in-flight run is running on (null when idle): the
   * orchestrator's budget handback matches this against the fallback pair it just left. */
  runModelPair(): { provider?: string; model?: string } | null {
    return this.state.running ? (this.runPair ?? null) : null;
  }

  /** The config this role's NEXT run will run on: the tier fallback pair while the episode is
   * active (a due probe runs the primary), else the role's own resolved config. The hold and
   * start passes read this so a role mid-episode is keyed by the provider it will actually use.
   * Pure read of config + state + the caller's clock. */
  /** Which pair set an image reroute may look among (plans/image-input.md "Reroute target"
   * "Regime"): the free fallback pairs while the budget gate is on fallback OR the role is
   * in a model-fallback episode; otherwise the primary tiers. One home for the rule, shared
   * by the target-resolution sites (the verdict's reroute arm, the attachment preflight). */
  rerouteRegime(now: number): "primary" | "fallback" {
    if (this.budgetFallbackActive) return "fallback";
    if (modelFallbackActive(this.state.modelFallback, now)) return "fallback";
    return "primary";
  }

  runConfig(now: number): ResolvedModelConfig {
    // A pending image-input reroute (plans/image-input.md part 4/5) outranks the role's own
    // tier and its model fallback: the next run starts on the image-capable target the
    // blind-read run recorded, rebuilt from the stored seam over the live config.
    if (this.state.imageReroute) {
      const r = this.state.imageReroute;
      return withModelOverrides(this.config, r.tier, {
        backend: r.backend,
        provider: r.provider,
        model: r.model,
        thinking: r.thinking,
      });
    }
    const fallback = fallbackRoleConfig(this.config, this.role);
    if (fallback !== null && modelFallbackActive(this.state.modelFallback, now)) return fallback;
    return configForRole(this.config, this.role);
  }

  /** The seam key `runConfig(now)` resolves to (config-views.ts seamHoldKey): the agent id
   * for a non-pi backend (claude seams carry no pi provider), else the pi provider. The hold
   * and start passes read only this, so a claude seam is gated by a `claude` hold and pi's
   * default seams (undefined) are not. */
  runProvider(now: number): string | undefined {
    return seamHoldKey(this.runConfig(now));
  }

  /** The signal every pi run of the current run watches: harness shutdown OR a per-run user
   * abort (Node ≥ 20's AbortSignal.any). */
  private runSignal(): AbortSignal {
    return this.signal ? AbortSignal.any([this.signal, this.runAbort.signal]) : this.runAbort.signal;
  }

  /** Assemble this run's prompt via src/run/run-prompt.ts (the prompt-content concern lives
   * there); the dequeued user request — the director's, or a per-role one — rides back so the
   * runner records it as pending — re-queued if the run ends without fulfilling it. Null when
   * the runner has nothing to run (an empty director inbox); a role runner's assembly never
   * returns null. */
  private runPrompt(backend?: string): string | null {
    const assembled = assembleRunPrompt({ root: this.root, config: this.config, role: this.role, state: this.state, backend });
    if (assembled === null) return null;
    if (assembled.userPrompt !== null) {
      logEventBestEffort(this.root, { source: this.role, type: "prompt_taken", run: this.state.runs, preview: promptPreview(assembled.userPrompt) });
    }
    this.pending.record(assembled.userPrompt, assembled.userPromptFile);
    return assembled.prompt;
  }

  /** Thin delegate to finishAbortedRunPhase (src/runner/runner-recovery.ts). */
  private async finishAbortedRun(userPrompt: string | null, wt: string): Promise<RunOutcome> {
    return finishAbortedRunPhase(this.runContext(), userPrompt, wt, this.userAborted, this.handedBack);
  }

  /** Thin delegate to pinAndResetPhase (src/runner/runner-recovery.ts). */
  private async pinAndReset(wt: string, sha: string): Promise<boolean> {
    return pinAndResetPhase(this.runContext(), wt, sha);
  }

  /** Thin delegate to finishRecoveryRunPhase (src/runner/runner-recovery.ts). */
  private async finishRecoveryRun(
    recovered: Exclude<LeftoverRecovery, { kind: "discarded" } | { kind: "handback" }>,
    userPrompt: string | null,
    wt: string,
    priorMergeFailure: string | undefined,
  ): Promise<RunOutcome> {
    return finishRecoveryRunPhase(this.runContext(), recovered, userPrompt, wt, priorMergeFailure);
  }

  /** Fold one pi run's usage into the run's counters and the lifetime totals — the
   * accounting itself lives in RunUsage.fold (src/run/run-usage.ts); this keeps the once-per-run
   * choke point and the foldMergeUsage face on the runner, where RunnerPi and the merge
   * wiring (src/merge/merge-slot.ts) reach them. */
  private foldUsage(run: PiRunResult, provider?: string, pair?: string): void {
    this.usage.fold(this.state, run, true, provider, pair);
  }

  /** Run pi for the orchestrator's merge slot (merge queue 3/5): runRolePi's shared wiring
   * with usage folded into this runner's counters, watching ONLY the harness shutdown signal
   * (`this.signal`) — a merge is outside any run, so `tumwater abort --role` must never
   * reach it. The plumbing lives in src/runner/runner-pi.ts; this is the merge slot's public
   * face. */
  async runMergePi(wt: string, prompt: string, sessionName: string, config?: ResolvedModelConfig): Promise<PiRunResult> {
    return this.pi.runMergePi(wt, prompt, sessionName, config);
  }

  /** Run pi for the merge gate's reviewer (the review run and its verdict follow-up)
   * through the runner's shared transient-retry wiring — the same retry an authoring run gets,
   * so a 429 in the gate is waited out and retried once instead of failing the review on
   * first contact (BUGS.md 2026-10-01). A retried first attempt is folded here at retry time
   * (the team-wide rate-limit hold's input); the FINAL run's usage is folded by the gate's
   * caller, exactly as before — the plumbing lives in src/runner/runner-pi.ts; this is the
   * merge wiring's public face. */
  async runGatePi(opts: PiRunOptions): Promise<PiRunResult> {
    return this.pi.runGatePi(opts);
  }

  /** Public face of foldUsage for the orchestrator's merge wiring: folds a merge pi run
   * (reviewer, conflict resolution) into the AUTHORING role's counters, so the team's daily
   * cost and the per-role usage windows attribute that spend to the role that authored the
   * work — no new counter semantics, just the same fold runner.ts applies to its agent runs. */
  foldMergeUsage(run: PiRunResult, provider?: string, pair?: string): void {
    // authoring=false: a merge/review run's usage counts toward cost and prompt tokens, but
    // never toward the run's pre-edit counter (src/run/run-usage.ts fold).
    this.usage.fold(this.state, run, false, provider, pair);
  }

  /** Run one full run of this role runner (the pipeline lives in src/runner/runner-run.ts):
   * `runPhase` resolves the config and fallback episode, logs run_start, runs the pipeline,
   * and finalizes. Never throws: a failed run is an "error" result, saved and logged. */
  async run(): Promise<RunOutcome> {
    return runPhase(this.runContext());
  }

  /** Thin delegate to foldModelFallbackPhase (src/runner/runner-fallback.ts). */
  private foldModelFallback(fallbackCtx: FallbackRunContext, pi: PiRunResult): void {
    foldModelFallbackPhase(this.runContext(), fallbackCtx, pi);
  }

  /** The run pipeline's entry (src/runner/runner-run.ts): a thin delegate so `run` assembles
   * phase context once and tests can still override `runOnce` to bypass the pipeline. */
  private async runOnce(
    cfg: ResolvedModelConfig,
    fallbackCtx: FallbackRunContext,
  ): Promise<RunOutcome> {
    return runOncePhase(this.runContext(), cfg, fallbackCtx);
  }

  /** Assemble the run pipeline's host context (src/runner/runner-run.ts) from this runner's
   * fields. `config` and `recoveryFailure` are live getters, so a mid-run change is seen as
   * the pre-split methods saw it; every callback is bound to this runner. */
  private runContext(): RunnerRunContext {
    const self = this;
    return {
      root: this.root,
      role: this.role,
      mainBranch: this.mainBranch,
      baseRole: this.baseRole,
      get config() {
        return self.config;
      },
      state: this.state,
      usage: this.usage,
      pending: this.pending,
      pi: this.pi,
      save: () => saveRunnerStateBestEffort(this.root, this.state),
      warn: (message) => this.warn(message),
      runSignal: () => this.runSignal(),
      runPrompt: (backend) => this.runPrompt(backend),
      rerouteRegime: (now) => this.rerouteRegime(now),
      get recoveryFailure() {
        return self.recoveryFailure;
      },
      setRecoveryFailure: (message) => {
        self.recoveryFailure = message;
      },
      runOnce: (cfg, fallbackCtx) => this.runOnce(cfg, fallbackCtx),
      setRunPair: (pair) => {
        self.runPair = pair;
      },
      setHandedBack: (value) => {
        self.handedBack = value;
      },
      resetRunAbort: () => {
        self.runAbort = new AbortController();
        self.userAborted = false;
      },
      finishAbortedRun: (userPrompt, wt) => this.finishAbortedRun(userPrompt, wt),
      pinAndReset: (wt, sha) => this.pinAndReset(wt, sha),
      foldModelFallback: (fallbackCtx, pi) => this.foldModelFallback(fallbackCtx, pi),
      finishRecoveryRun: (recovered, userPrompt, wt, priorMergeFailure) =>
        this.finishRecoveryRun(recovered, userPrompt, wt, priorMergeFailure),
    };
  }
}

