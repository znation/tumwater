import type { TumwaterConfig } from "../config/config-schema.js";
import type { TickOutcome } from "../tick/tick-outcome.js";
import type { BackendFailureKind, PiRunOptions } from "../pi/pi.js";
import type { PiRunResult } from "../pi/pi-run-result.js";
import { loadLoopState, saveLoopState, zeroCounters, type LoopState } from "./loop-state.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";
import { baseRoleOf } from "../roles/loop-ids.js";
import { warnEventBestEffort } from "../events/events.js";
import { assembleTickPrompt } from "../tick/tick-prompt.js";
import { LoopPi } from "./loop-pi.js";
import {
  configForRole,
  fallbackRoleConfig,
  type ResolvedModelConfig,
} from "../config/config-views.js";
import { PendingPrompt } from "../inbox/pending-prompt.js";
import { modelFallbackActive } from "./model-fallback.js";
import { clearBackoff } from "../scheduling/backoff.js";
import { TickUsage } from "../tick/tick-usage.js";
import {
  runTickPhase,
  tickPhase,
  type FallbackRunContext,
  type LoopTickContext,
} from "./loop-tick.js";
import {
  finishAbortedTickPhase,
  finishRecoveryTickPhase,
  pinAndResetPhase,
} from "./loop-recovery.js";
import { foldModelFallbackPhase } from "./loop-fallback.js";
import type { LeftoverRecovery } from "./leftover.js";

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
  /** The dequeued user prompt a tick is executing and its requeue policy
   * (src/inbox/pending-prompt.ts): the raw director request is recorded at dequeue so an
   * unfulfilled tick (abort, timeout, or failure without changes) can re-queue it instead of
   * losing the request. */
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
    warnEventBestEffort(this.root, this.role, message);
  }

  /** Zero the accumulated counters in memory and persist them (the orchestrator's
   * `tumwater reset-counters` request). Mutating the EXISTING state object keeps an in-flight
   * tick's own start/end saves authoritative over the same reference; swapping in a fresh copy
   * would lose its nextRunAt/backoff/lastResult and leave running=true on disk. */
  resetCounters(): void {
    Object.assign(this.state, zeroCounters(this.state));
    this.save();
  }

  /** Clear this loop's backoff in memory and persist (the orchestrator's `tumwater wake`
   * request). Eligibility reads the IN-MEMORY state; the mutation is in place on the EXISTING
   * object, as with resetCounters, so an in-flight tick's saves stay authoritative. */
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

  /** The config this role's NEXT tick will run on: the tier fallback pair while the episode is
   * active (a due probe runs the primary), else the role's own resolved config. The hold and
   * start passes read this so a role mid-episode is keyed by the provider it will actually use.
   * Pure read of config + state + the caller's clock. */
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

  /** Thin delegate to finishAbortedTickPhase (src/loop/loop-recovery.ts). */
  private async finishAbortedTick(userPrompt: string | null, wt: string): Promise<TickOutcome> {
    return finishAbortedTickPhase(this.tickContext(), userPrompt, wt, this.userAborted, this.handedBack);
  }

  /** Thin delegate to pinAndResetPhase (src/loop/loop-recovery.ts). */
  private async pinAndReset(wt: string, sha: string): Promise<boolean> {
    return pinAndResetPhase(this.tickContext(), wt, sha);
  }

  /** Thin delegate to finishRecoveryTickPhase (src/loop/loop-recovery.ts). */
  private async finishRecoveryTick(
    recovered: Exclude<LeftoverRecovery, { kind: "discarded" } | { kind: "handback" }>,
    userPrompt: string | null,
    wt: string,
    priorLandingFailure: string | undefined,
  ): Promise<TickOutcome> {
    return finishRecoveryTickPhase(this.tickContext(), recovered, userPrompt, wt, priorLandingFailure);
  }

  /** Fold one pi run's usage into the tick's counters and the lifetime totals — the
   * accounting itself lives in TickUsage.fold (src/tick/tick-usage.ts); this keeps the once-per-run
   * choke point and the foldLandingUsage face on the runner, where LoopPi and the landing
   * wiring (src/landing/landing-slot.ts) reach them. */
  private foldUsage(run: PiRunResult): void {
    this.usage.fold(this.state, run);
  }

  /** Run pi for the orchestrator's landing slot (merge queue 3/5): runRolePi's shared wiring
   * with usage folded into this loop's counters, watching ONLY the harness shutdown signal
   * (`this.signal`) — a landing is outside any tick, so `tumwater abort --role` must never
   * reach it. The plumbing lives in src/loop/loop-pi.ts; this is the landing slot's public
   * face. */
  async runLandingPi(wt: string, prompt: string, sessionName: string, config?: ResolvedModelConfig): Promise<PiRunResult> {
    return this.pi.runLandingPi(wt, prompt, sessionName, config);
  }

  /** Run pi for the landing gate's reviewer (the review run and its verdict follow-up)
   * through the loop's shared transient-retry wiring — the same retry an authoring run gets,
   * so a 429 in the gate is waited out and retried once instead of failing the review on
   * first contact (BUGS.md 2026-10-01). A retried first attempt is folded here at retry time
   * (the fleet-wide rate-limit hold's input); the FINAL run's usage is folded by the gate's
   * caller, exactly as before — the plumbing lives in src/loop/loop-pi.ts; this is the
   * landing wiring's public face. */
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

  /** Run one full tick of this role loop (the pipeline lives in src/loop/loop-tick.ts):
   * `tickPhase` resolves the config and fallback episode, logs tick_start, runs the pipeline,
   * and finalizes. Never throws: a failed tick is an "error" result, saved and logged. */
  async tick(): Promise<TickOutcome> {
    return tickPhase(this.tickContext());
  }

  /** Thin delegate to foldModelFallbackPhase (src/loop/loop-fallback.ts). */
  private foldModelFallback(fallbackCtx: FallbackRunContext, pi: PiRunResult): void {
    foldModelFallbackPhase(this.tickContext(), fallbackCtx, pi);
  }

  /** The tick pipeline's entry (src/loop/loop-tick.ts): a thin delegate so `tick` assembles the
   * phase context once and tests can still override `runTick` to bypass the pipeline. */
  private async runTick(
    cfg: ResolvedModelConfig,
    fallbackCtx: FallbackRunContext,
  ): Promise<TickOutcome> {
    return runTickPhase(this.tickContext(), cfg, fallbackCtx);
  }

  /** Assemble the tick pipeline's host context (src/loop/loop-tick.ts) from this runner's
   * fields. `config` and `recoveryFailure` are live getters, so a mid-tick change is seen as
   * the pre-split methods saw it; every callback is bound to this runner. */
  private tickContext(): LoopTickContext {
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
      save: () => this.save(),
      warn: (message) => this.warn(message),
      runSignal: () => this.runSignal(),
      tickPrompt: () => this.tickPrompt(),
      get recoveryFailure() {
        return self.recoveryFailure;
      },
      setRecoveryFailure: (message) => {
        self.recoveryFailure = message;
      },
      runTick: (cfg, fallbackCtx) => this.runTick(cfg, fallbackCtx),
      setTickPair: (pair) => {
        self.tickPair = pair;
      },
      setHandedBack: (value) => {
        self.handedBack = value;
      },
      resetTickAbort: () => {
        self.tickAbort = new AbortController();
        self.userAborted = false;
      },
      finishAbortedTick: (userPrompt, wt) => this.finishAbortedTick(userPrompt, wt),
      pinAndReset: (wt, sha) => this.pinAndReset(wt, sha),
      foldModelFallback: (fallbackCtx, pi) => this.foldModelFallback(fallbackCtx, pi),
      finishRecoveryTick: (recovered, userPrompt, wt, priorLandingFailure) =>
        this.finishRecoveryTick(recovered, userPrompt, wt, priorLandingFailure),
    };
  }
}
