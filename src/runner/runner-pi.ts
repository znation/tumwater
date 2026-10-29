import type { TumwaterConfig } from "../config/config-schema.js";
import type { PiRunResult } from "../pi/pi-run-result.js";
import { runPi, type PiRunKind, type PiRunOptions } from "../pi/pi.js";
import { backendSessionResumable } from "../agent/agent-backend.js";
import { HOLD_BASE_MS } from "../team/team-hold.js";
import { backendKindPhrase } from "../text/phrases.js";
import { configForRole, resolvedBackendConfig, seamHoldKey, seamPairName, type ResolvedModelConfig } from "../config/config-views.js";
import { buildSummaryRequestPrompt } from "../prompt/prompt-followup.js";
import { readClaudeAccount, subscriptionWindowRejected } from "../agent/claude/claude-account.js";
import { observeOpencodeRun, opencodeModelKey } from "../agent/opencode/opencode-catalog.js";
import { dailyCost, teamDailyCost, pairDailyCost } from "../budget/budget.js";
import { loadRunnerState } from "./runner-state-load.js";
import { baseRoleOf, runnerIds } from "../roles/runner-ids.js";
import { buildStageFixPrompt, type StagedDescription } from "../prompt/gate-prompts.js";
import { logBlindRead } from "../events/events.js";
import { nativeLogPath, piLogPath, roleNotesPath, sessionDir } from "../paths.js";
import { piModelsPath } from "../pi/pi-models.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";
import { cappedRequestTimeouts } from "../request-timeouts.js";

/** Upper bound on how long the transient retry waits out a provider's Retry-After hint
 * before re-attempting a rate-limited agent run. Honoring the hint is the point; capping it is
 * what keeps one generous hint from consuming the run's own agent run budget (the retry gets a
 * full fresh agent run budget, so a wait larger than the cap would spend the run waiting, not
 * working). */
const RATE_LIMIT_RETRY_AFTER_CAP_S = 120;

/** What a hint-less 429 waits before its one retry. With no Retry-After from the provider, the
 * team's own constants state the refill physics: team/team-hold.ts's base hold is one minute,
 * "the shortest pause that lets the bucket refill". Retrying sooner re-enters the same exhausted
 * per-minute bucket the first request just emptied and burns the run's only retry on a
 * near-certain second 429. A present hint always wins instead; the cap above still bounds
 * whatever the wait ends up being. */
const RATE_LIMIT_NO_HINT_RETRY_S = Math.round(HOLD_BASE_MS / 1000);

/** The retry's pause on the real clock; tests inject host.sleep and never reach this. */
function sleepFor(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** The `--max-budget-usd` cap for one API-billed claude authoring run (plans/agent-backends.md
 * §7): the remaining team budget (`maxDailyCostUsd` − today's team spend), lowered to the
 * base role's own remaining cap when `maxDailyCostUsdPerRole` names it. The cap map and its
 * spend are keyed by BASE role, exactly as the scheduler's role-cap gate reads them
 * (src/gates/role-cap-gates.ts: `baseRoleOf` groups `feature`/`feature-2` and sums the
 * group's spend), so instance runner ids share their base's cap instead of silently falling
 * through to the team budget. Returns undefined — no cap — for the director, a non-claude
 * seam, an account that is not API-billed, a disabled cap (0), or no remaining budget at all
 * (a non-positive cap is dropped by the argv builder). Spend is read from the persisted runner
 * states: each role's daily window is what the budget gate and the dashboards sum, and this
 * runs before the authoring run records its own cost. A pair with a step cap of its own (a
 * priced fallback step, `fallbackStepCaps`) is also held to that step's remaining budget. */
function authoringBudgetCap(
  root: string,
  role: string,
  cfg: TumwaterConfig,
  agent: string,
  pair: string,
): number | undefined {
  if (role === DIRECTOR_ROLE || agent !== "claude") return undefined;
  if (readClaudeAccount(root)?.billing !== "api") return undefined;
  const now = Date.now();
  const states = runnerIds(cfg).map((r) => loadRunnerState(root, r));
  let cap = cfg.maxDailyCostUsd - teamDailyCost(states, now);
  const base = baseRoleOf(role);
  const perRole = cfg.maxDailyCostUsdPerRole?.[base];
  if (perRole !== undefined && perRole > 0) {
    const members = states.filter((s) => baseRoleOf(s.role) === base);
    const spent =
      members.length > 0
        ? members.reduce((sum, s) => sum + dailyCost(s, now), 0)
        : dailyCost(loadRunnerState(root, role), now);
    cap = Math.min(cap, perRole - spent);
  }
  // A fallback step with its own cap (applyFallbackModel's fallbackStepCaps, set only on the
  // derived view) lowers the agent run to what is left of the step's budget for the day.
  const stepCap = cfg.fallbackStepCaps?.[pair];
  if (stepCap !== undefined) cap = Math.min(cap, stepCap - pairDailyCost(states, pair, now));
  // Round the subtraction's floating-point residue off so the argv carries a clean number.
  cap = Math.round(cap * 1e6) / 1e6;
  return cap > 0 ? cap : undefined;
}

/** What the extracted pi-run plumbing needs from its owning runner. The runner supplies live
 * accessors, not copies: `config()` and `runNumber()` are read at every call so the
 * orchestrator's live-reload (which swaps the config object under the runner) and the run
 * lifecycle stay authoritative without any notification path. */
interface RunnerPiHost {
  readonly root: string;
  readonly role: string;
  config(): TumwaterConfig;
  /** The harness shutdown signal (may be undefined — PiRunOptions.signal is optional). */
  readonly signal?: AbortSignal;
  /** The signal a run's own agent runs watch: harness shutdown OR per-run user abort. */
  runSignal(): AbortSignal;
  warn(message: string): void;
  /** Fold an authoring run's usage. `provider` is that agent run's seam hold key
   * (seamHoldKey of the agent run's config), which the fold stamps onto the team-hold's rate-limit
   * and backend-failure observations so a storm is blamed on the backend that actually failed
   * (PLANS.md "Mixed claude + pi fleets, part 2/4"). */
  foldUsage(run: PiRunResult, provider?: string, pair?: string): void;
  /** Fold a merge/review agent run's usage into the authoring role's counters WITHOUT touching
   * the run's pre-edit prefix (RunUsage.fold's authoring=false): the reviewer's and conflict
   * resolver's context is not the authoring run's pre-edit search. `provider` is the review
   * seam's hold key — a 429 storm on a claude reviewer must hold `claude`, not the pi author's
   * provider. */
  foldMergeUsage(run: PiRunResult, provider?: string, pair?: string): void;
  runNumber(): number;
  /** The transient retry's pause before re-running, injectable so tests record the wait
   * instead of living through it (a hint-less 429 waits a real minute). Unset means the
   * real clock via sleepFor. */
  sleep?(ms: number): Promise<void>;
}

/** The pi-invocation plumbing of one role's runner, extracted from RoleRunner
 * (src/runner/runner.ts): the shared per-runner wiring for every agent run (role config, session
 * dir, raw log, abort signal), the one bounded transient-failure retry all agent runs share, the
 * merge slot's agent run (which watches only the shutdown signal), and the run's SUMMARY follow-up
 * turn. It owns HOW a runner talks to pi; the RoleRunner state machine owns WHAT agent runs happen
 * and folds every agent run's spend back through the host's foldUsage (authoring) or
 * foldMergeUsage (merge/review). */
export class RunnerPi {
  constructor(private readonly host: RunnerPiHost) {}

  /** The shared per-runner wiring for every agent run this run makes in worktree `wt`: the
   * role-resolved config, this runner's session dir and raw log, and the per-run abort signal.
   * One place for those derivations — a new PiRunOptions field touches only here instead of
   * drifting between the author run and the SUMMARY follow-up. Callers override what differs
   * (the follow-up's capped timeouts, the merge's shutdown-only signal). */
  private runnerPiOpts(
    wt: string,
    prompt: string,
    sessionName: string,
    kind: PiRunKind,
    resume = false,
    config?: ResolvedModelConfig,
    notesPath?: string,
  ): PiRunOptions {
    // A caller-supplied config (the merge conflict resolver's strong-tier one,
    // plans/model-tiers.md part 4/8) replaces the role's own for that one agent run; the role's
    // config is the default for every other caller. Resolved once here so the native-log path
    // names the agent that run actually uses.
    const resolved = config ?? configForRole(this.host.config(), this.host.role);
    const maxBudgetUsd =
      kind === "author"
        ? authoringBudgetCap(this.host.root, this.host.role, this.host.config(), resolved.agent ?? "pi", seamPairName(resolved))
        : undefined;
    return {
      cwd: wt,
      prompt,
      ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
      // Every agent run names its kind explicitly; the marker it writes is the dashboards' demux
      // key, so parts 2/5 and 4/5 may put author and gate runs in the same worktree.
      kind,
      config: resolved,
      sessionDir: sessionDir(this.host.root, this.host.role),
      sessionName,
      continueSession: resume,
      rawLogFile: piLogPath(this.host.root, this.host.role),
      nativeLogFile: nativeLogPath(this.host.root, this.host.role, resolved.agent ?? "pi"),
      signal: this.host.runSignal(),
      // Only runAuthoringPi and its SUMMARY/stage-fix follow-ups pass this; a merge,
      // review, or conflict-resolution run has no notes, and neither does the director.
      notesPath,
      // A tool call silent for the configured stall threshold names itself in the event feed
      // while the quiet watchdog still counts down (BUGS.md 2026-09-13 sibling): before this,
      // a hung command was invisible until the kill. A model request unanswered that long does
      // the same (BUGS.md 2026-10-29). The dashboards derive their own flags from the raw log,
      // so only the harness event needs wiring here.
      onStallWarning: (message) => this.host.warn(message),
      onLeftoversSwept: (message) => this.host.warn(message),
      // The translator's unmapped-native-type and cost_unknown warnings reach the event feed
      // as their own warning events, once per agent run.
      onAgentWarning: (warning) => this.host.warn(`agent_unknown_event: ${warning}`),
      // An agent run that read an image its model cannot see (plans/image-input.md "Detecting a
      // blind read"): the runner killed the authoring run (action "fail") or a gate run
      // merely recorded it ("logged") — each logged here with this runner's identity so the
      // feed names who, on which run, read which file on which blind model.
      onBlindRead: (path, action) =>
        logBlindRead(this.host.root, this.host.role, this.host.runNumber(), path, resolved.model, action),
    };
  }

  /** Run the orchestrator's merge slot's pi (merge queue 3/5): the shared per-runner wiring
   * of runRolePi — role config, session dir, raw log, transient-failure retry — with usage
   * folded into the authoring runner's counters, but watching ONLY the harness shutdown signal
   * (which may be undefined — PiRunOptions.signal is optional): a merge is outside any
   * run, so `tumwater abort --role` (which targets a run's per-run abort controller) must
   * never reach it, and the stale per-run controller of a finished run must not abort it
   * either. Session naming is the caller's (the reviewer composes its own from
   * ReviewContext.runNumber; merge-to-main.ts keeps its conflict-resolver naming through
   * MergerContext.runPi).
   */
  async runMergePi(
    wt: string,
    prompt: string,
    sessionName: string,
    config?: ResolvedModelConfig,
  ): Promise<PiRunResult> {
    return this.runWithTransientRetry(
      {
        ...this.runnerPiOpts(wt, prompt, sessionName, "gate", false, config),
        signal: this.host.signal,
      },
      { authoring: false },
    );
  }

  /** The merge gate's reviewer runs (review.ts's review run and verdict follow-up): the
   * same shared transient-retry wiring — a 429 in the gate waits its hint out and retries
   * once, exactly like an authoring run (BUGS.md 2026-10-01) — with one folding difference:
   * the FINAL agent run's usage is folded by the gate's caller (merge-core's foldUsage of
   * gate.run / gate.followUpRun), so only a RETRIED first attempt is folded here. That fold
   * is not optional: it stamps the team-wide rate-limit hold's input before the wait, and
   * it is the only record the failed attempt's spend would ever get.
   * Takes full PiRunOptions because the gate's two agent runs differ in everything but the runner
   * they charge (config, session dir and name, label, tool-call callbacks, signal).
   */
  async runGatePi(opts: PiRunOptions): Promise<PiRunResult> {
    return this.runWithTransientRetry(opts, { foldFinal: false, authoring: false });
  }

  /** The one bounded transient-failure retry shared by EVERY pi run this runner makes
   * (runRolePi, runMergePi, and runGatePi): two transient failures of the world (not of
   * the session) earn exactly one retry that continues the same session — the model server
   * timing out an idle predict stream, the provider severing that stream outright (undici's
   * bare "terminated", the stream-severed backend kind), the provider accepting a request
   * and then failing to answer it in time (its own "Request timed out.", the timeout backend
   * kind), pi itself crashing on a torn server chunk (a JSON.parse failure on its stderr),
   * and the provider rate-limiting the request with HTTP 429 (where the provider's
   * Retry-After hint, when sent, is waited out first — capped, so one provider's generosity
   * cannot eat the run's own agent run budget). A harness-killed or quiet-killed agent run never
   * takes the transient-retry path: its session is intact but resuming it would just re-hit
   * whatever hung, burning another full quiet timeout. An agent run whose `--resume` target the
   * backend no longer holds (`PiRunResult.resumeMissing`) is not retried here: continuing is
   * impossible and this layer has no fresh run prompt to hand a new session, so the failed
   * agent run is returned and its kept worktree resumes as a `handoff` on the next run
   * (src/run/run-resume.ts).
   * Extracted verbatim from runRolePi so the rule lives in one place
   * (574a14c's runnerPiOpts move was the wiring half of the same single-source-of-truth).
   */
  /** Part 6c/7: demote a catalog-free opencode model the first time an agent run bills it. Observed
   * here — the fold chokepoint every agent run of the runner passes through — because it is the one
   * place that has the agent run's resolved model (opts.config) and its cost (the agent run)
   * together, and it holds the runner's root and role for the cache and the event feed. pi and
   * claude agent runs have no opencode catalog entry and no-op. Best-effort like
   * observeClaudeAccount: an unwritable cache or event feed must not fail the agent run that
   * observed it. */
  private observeFreeModelCost(run: PiRunResult, config: ResolvedModelConfig): void {
    if (config.agent !== "opencode") return;
    try {
      observeOpencodeRun(
        this.host.root,
        { model: opencodeModelKey(config.model ?? ""), costUsd: run.costUsd },
        { source: this.host.role },
      );
    } catch {
      // The next priced run demotes it; nothing this agent run depends on is lost.
    }
  }

  private async runWithTransientRetry(
    opts: PiRunOptions,
    /** runGatePi only: skip folding the FINAL returned agent run (the caller folds it), while a
     * retried first attempt still folds — its spend and its rate-limit hold stamp must not
     * vanish just because the gate routes its own folding. Default folds everything, the
     * authoring and merge behavior. */
    { foldFinal = true, authoring = true }: { foldFinal?: boolean; authoring?: boolean } = {},
  ): Promise<PiRunResult> {
    // The fold every attempt takes: an authoring run charges the runner's run counters
    // (foldUsage); a merge, reviewer, or conflict-resolution run charges the same cost and
    // prompt-token totals but never the run's pre-edit prefix (foldMergeUsage).
    // The seam this agent run actually ran on, as the team hold keys it (seamHoldKey): the fold
    // stamps the rate-limit and backend-failure observations with it, so a storm on a claude
    // reviewer holds `claude` and a pi author on a different provider stays open. opts.config
    // is always the agent run's own resolved seam (reviewRunConfig for the reviewer, the role's
    // config or fallback pair for the author), so this names the backend that failed.
    const provider = seamHoldKey(opts.config);
    // The agent run's model pair name, the key of the per-step daily spend
    // (RunnerState.dayCostByPair).
    const pair = seamPairName(opts.config);
    // Names the seam in per-run provider warnings; omitted when pi picks its own default model.
    const on = opts.config.model !== undefined ? ` on ${pair}` : "";
    const fold = (run: PiRunResult): void =>
      authoring ? this.host.foldUsage(run, provider, pair) : this.host.foldMergeUsage(run, provider, pair);
    const pi = await runPi(opts);
    this.warnFallbackClone(pi);
    this.observeFreeModelCost(pi, opts.config);
    if (this.transientRetryAdmits(pi)) {
      this.host.warn(this.transientRetryWarning(pi, on));
      // The failed attempt folds NOW, before the wait and the retry: a 429 it ended on is the
      // team-wide rate-limit hold's input (RoleRunner.lastRateLimit, stamped at fold time), and
      // folding after a retry that ran on for an hour would report the storm an hour late.
      fold(pi);
      const waitS = this.transientRetryWaitSeconds(pi);
      if (waitS > 0) await (this.host.sleep?.(waitS * 1000) ?? sleepFor(waitS * 1000));
      return this.retryContinuingSession(opts, on, foldFinal, fold);
    }
    this.warnBackendKindFloor(pi, on);
    if (foldFinal) fold(pi);
    return pi;
  }

  /** The retry's admission predicate: whether this run qualifies for the one bounded transient
   * retry — not cleanly ended or killed, but ended on a transient server condition (a server
   * timeout, a pi crash, a 429, or a backend kind the retry covers) and not a subscription
   * usage-window rejection. */
  private transientRetryAdmits(run: PiRunResult): boolean {
    return (
      !run.aborted &&
      !run.timedOut &&
      !run.quietKilled &&
      (run.transientServerTimeout ||
        run.transientPiCrash ||
        run.transientRateLimit ||
        this.retryCoversBackendKind(run)) &&
      !run.ok &&
      // A subscription claude usage-window rejection is not the 429 the retry's minute-scale
      // wait beats: the window resets hours out, so a within-run retry is guaranteed to fail
      // after burning up to RATE_LIMIT_RETRY_AFTER_CAP_S. The run ends and the kept session
      // resumes once the team hold lifts (plans/agent-backends.md §8, part 6e).
      !subscriptionWindowRejected(run)
    );
  }

  /** The per-run retry warning text, keyed off which transient condition the first attempt
   * ended on. */
  private transientRetryWarning(run: PiRunResult, on: string): string {
    return run.transientPiCrash
      ? `pi crashed on malformed JSON (${run.errorMessage ?? "no detail"})${on} — resuming the session once`
      : run.transientRateLimit
        ? `provider rate-limited the request (429${run.retryAfterSeconds ? `, retry after ${run.retryAfterSeconds}s` : `, no hint — waiting ${RATE_LIMIT_NO_HINT_RETRY_S}s`})${on} — retrying the agent run once`
        : run.backendKind === "stream-severed"
          ? `provider severed the in-flight stream (terminated)${on} — retrying the agent run once`
          : run.backendKind === "timeout"
            ? `provider request timed out after accepting the connection${on} — retrying the agent run once`
            : `model server timed out an idle predict stream (e.g. machine sleep)${on} — retrying the agent run once`;
  }

  /** The seconds to wait before the bounded retry, the pause taken from the moved wait ladder;
   * the sleep itself stays in the caller. */
  private transientRetryWaitSeconds(run: PiRunResult): number {
    // The pause is the rate-limit branch's, plus the timeout kind's: a server timeout or
    // pi crash is a failure of the local path, retried at once, while a 429 must wait its
    // per-minute bucket out. A hint-less 429 defaults to that minute-scale refill pause
    // instead of 0 — an immediate retry lands in the same exhausted bucket and burns the
    // run's only retry (BUGS.md 2026-09-25). A present hint wins; the cap bounds either.
    // A hint of 0 (or any non-positive value) is no usable hint — "retry now" is exactly
    // the burned-retry bug a hint-less 429 causes — so it falls back to the refill pause
    // just like a missing hint, keeping the warning text and the actual wait in agreement.
    // The timeout kind (BUGS.md 2026-09-30) takes that same minute-scale pause: the
    // provider accepted the request and failed to answer it, an overload shape — an
    // immediate re-request lands at the back of the same queue and burns the run's only
    // retry, so the retry waits the refill pause out first.
    const hintS =
      run.retryAfterSeconds && run.retryAfterSeconds > 0 ? run.retryAfterSeconds : RATE_LIMIT_NO_HINT_RETRY_S;
    return run.transientRateLimit
      ? Math.min(hintS, RATE_LIMIT_RETRY_AFTER_CAP_S)
      : run.backendKind === "timeout"
        ? RATE_LIMIT_NO_HINT_RETRY_S
        : 0;
  }

  /** The one bounded retry: resume the session the first attempt created on the same opts, so
   * its partial progress is not re-done (the next run still starts fresh), folding the retried
   * run when foldFinal is set and warning the backend-kind floor for its returned agent run. */
  private async retryContinuingSession(
    opts: PiRunOptions,
    on: string,
    foldFinal: boolean,
    fold: (run: PiRunResult) => void,
  ): Promise<PiRunResult> {
    // Within-run continuity only: resume the session the first attempt created, so its
    // partial progress is not re-done. The next run still starts fresh.
    const retry = await runPi({ ...opts, continueSession: true });
    this.warnFallbackClone(retry);
    this.observeFreeModelCost(retry, opts.config);
    if (foldFinal) fold(retry);
    this.warnBackendKindFloor(retry, on);
    return retry;
  }

  /** The backend-kind floor (BUGS.md 2026-09-29): a failed agent run that ended on a
   * provider-backend failure (connection down, 5xx, model load) still warns — parity with
   * the 429 branch above, so any episode is visible from the feed alone instead of living
   * only in per-run error events an operator must aggregate by hand. The team-wide hold
   * (src/team/team-hold.ts) and the storm alarms judge the spread; this line is the per-run
   * floor under them, not a retry: a dead backend is not something an immediate agent re-run beats.
   * Applied to whichever agent run is returned (BUGS.md 2026-10-09): the retry's returned agent run
   * is a second, independent agent run the retry predicate was never applied to, so a retry that
   * dies on an uncovered kind must warn exactly as a first attempt does. An agent run the retry
   * predicate DID admit on a backend kind (stream-severed/timeout) is excluded, so the warning's
   * "does not cover this kind" stays true and a retry failing on a covered kind emits no such line
   * (BUGS.md 2026-10-09 review). The line names the seam's provider/model pair (`on`,
   * empty with no model). */
  private warnBackendKindFloor(run: PiRunResult, on: string): void {
    if (
      !run.ok &&
      !run.aborted &&
      !run.timedOut &&
      !run.quietKilled &&
      run.transientBackend &&
      !this.retryCoversBackendKind(run)
    ) {
      this.host.warn(
        `provider backend failure (${backendKindPhrase(run.backendKind)})${on} — the transient retry does not cover this kind; the team-wide wait watches for a storm`,
      );
    }
  }

  /** Whether the one bounded transient retry admits `run` on its backend-kind alone: the
   * stream-severed and request-timeout kinds, whose first-attempt warning says "retrying the
   * pi run once". The floor's other backend kinds (connection/5xx/model-load) are exactly the
   * ones this excludes. Shared by the retry predicate above and the floor, so the two cannot
   * drift on which kinds the retry covers. */
  private retryCoversBackendKind(run: PiRunResult): boolean {
    return run.transientBackend && (run.backendKind === "stream-severed" || run.backendKind === "timeout");
  }

  /** One warning per agent run whose model id pi could not resolve exactly (BUGS.md 2026-10-06):
   * pi cloned the provider's default model, so the agent run is priced and windowed as that default
   * while the operator's config says otherwise — unconditionally visible from the feed alone.
   * A no-op for the ordinary agent run that printed no such stderr line. */
  private warnFallbackClone(run: PiRunResult): void {
    if (!run.fallbackClone) return;
    this.host.warn(
      `pi could not resolve the model id exactly (${run.fallbackClone}) — the run uses the provider default's price and context window; add an exact entry to ${piModelsPath()}`,
    );
  }

  /** Run pi for this runner's authoring run in worktree `wt`: the shared per-runner wiring and
   * the transient-failure retry, with usage folded into the run's counters. It is the ONE
   * entry point that carries the role notes (TUMWATER_NOTES_PATH,
   * read by the `tumwater-notes` command): every other agent run (runRolePi's merge/conflict path,
   * runMergePi, runGatePi) leaves it unset, and the director is excluded because its work is
   * the operator's prompt, not a recurring search.
   *
   * Every agent run starts a FRESH pi session: context never accumulates across runs, so runs start
   * cheap (small prefill), never inherit a near-full window, and durable knowledge lives where
   * the prompt makes pi read it — README/PLANS/BUGS, the code itself, and the role's own note.
   * `resume` continues the role's most recent session instead — used only when picking up
   * a run that a harness shutdown interrupted. */
  async runAuthoringPi(
    wt: string,
    prompt: string,
    sessionName: string,
    resume = false,
    config?: ResolvedModelConfig,
  ): Promise<PiRunResult> {
    return this.runWithTransientRetry(
      this.runnerPiOpts(wt, prompt, sessionName, "author", resume, config, this.authorNotesPath()),
    );
  }

  /** The notes path an authoring run carries: the role's note file, or undefined for the
   * director, which has no notes. The SUMMARY/stage-fix follow-ups share the authoring
   * run's session and must carry the same notes wiring — every invocation reads the path
   * from TUMWATER_NOTES_PATH in the environment, so the follow-up re-passes the same path. */
  private authorNotesPath(): string | undefined {
    return this.host.role === DIRECTOR_ROLE
      ? undefined
      : roleNotesPath(this.host.root, this.host.role);
  }

  /** The shared authoring/conflict agent run wiring WITHOUT the role notes. The merge pipeline's
   * conflict resolver reaches pi through this (plans/merge-queue.md), and a conflict resolution
   * is not the role's recurring search: it must not carry the notes tool or rewrite the note.
   * An authoring agent run goes through runAuthoringPi above, which is the only notes-carrying
   * path. */
  async runRolePi(
    wt: string,
    prompt: string,
    sessionName: string,
    resume = false,
    config?: ResolvedModelConfig,
  ): Promise<PiRunResult> {
    // The refusal-note merge (runner.ts's merge) reaches pi here, in the ROLE's own worktree,
    // so its agent runs demux as author — exactly the verdict the pre-part-1/5 cwd test gave them.
    // The shared-worktree conflict resolver goes through runMergePi and demuxes as gate.
    return this.runWithTransientRetry(
      this.runnerPiOpts(wt, prompt, sessionName, "author", resume, config),
    );
  }

  /** Hard caps on the SUMMARY follow-up turn: it should take one short reply on a warm session,
   * so it never gets the authoring run's hours-long budget. */
  private static readonly SUMMARY_REQUEST_TIMEOUT_S = 900;
  private static readonly SUMMARY_REQUEST_QUIET_S = 300;

  /** Hard cap on the stage self-check's fix-up turn: one correction on a warm session, never
   * the authoring run's budget. The quiet watchdog shares the SUMMARY follow-up's value — both
   * are short replies to a session that already holds the work. */
  private static readonly STAGE_FIX_TIMEOUT_S = 600;

  /** The shared body of the two `--continue` follow-up turns (requestSummary and
   * requestStageFix): guard on a resumable session, resolve the run's effective config, and
   * run one capped turn on the runner's shared transient-retry wiring. Both follow-ups must keep
   * the same session guard and capped-config discipline, so the two read one assembly here;
   * `suffix` names the turn in its session name and `timeoutS` is its hard cap, while both
   * share the quiet watchdog value (SUMMARY_REQUEST_QUIET_S). Null when there is no session to
   * continue; the agent run is returned even when it failed so the caller can honor a shutdown
   * abort.
   *
   * The follow-up continues this run's own session, so it must run on the same pair that
   * session ran on: the caller passes the run's effective config (a budget cap's fallback
   * pair while a cap episode is active). A caller without one rides the role's own config. The
   * shared per-runner wiring (runnerPiOpts) takes the follow-up's hard caps overriding the
   * authoring run's budget: one short reply on a warm session. The agent run takes the runner's
   * SHARED transient-failure retry (BUGS.md 2026-10-01): a 429 on the follow-up turn waits its
   * Retry-After hint out and retries once on the same session, exactly like the authoring run,
   * the merge slot's agent run, and the gate's reviewer agent runs it mirrors. The caps bound BOTH
   * attempts (the retry inherits this capped config), so a flaky provider cannot stretch the
   * follow-up past its budget by more than one capped turn. The wiring folds every attempt
   * (the failed 429 before the wait), and the returned final agent run is folded here by the wiring
   * itself — no second fold at the call site. */
  private async requestFollowUp(
    wt: string,
    prompt: string,
    suffix: string,
    timeoutS: number,
    config?: ResolvedModelConfig,
  ): Promise<PiRunResult | null> {
    const cfg = config ?? configForRole(this.host.config(), this.host.role);
    const dir = sessionDir(this.host.root, this.host.role);
    // The follow-up continues THIS run's author session. The backend's own resumable rule
    // keeps it honest: pi would reach the newest file, claude its recorded id, so a conflict
    // resolver's gate run in the same dir cannot be mistaken for this run's session. The
    // claude config dir rides along so a claude team's resume looks under its own dir.
    if (
      !backendSessionResumable(
        dir,
        { kind: "author", agent: cfg.agent ?? "pi" },
        resolvedBackendConfig(cfg, "claude").configDir,
      )
    ) {
      return null;
    }
    return this.runWithTransientRetry({
      ...this.runnerPiOpts(
        wt,
        prompt,
        `tumwater-${this.host.role}-${this.host.runNumber()}-${suffix}`,
        "author",
        true,
        cfg,
        this.authorNotesPath(),
      ),
      config: {
        ...cfg,
        ...cappedRequestTimeouts(cfg, timeoutS, RunnerPi.SUMMARY_REQUEST_QUIET_S),
      },
    });
  }

  /** Ask the run's own pi session (--continue) for the missing SUMMARY block: one tightly
   * bounded turn, folded into the run's usage like every other agent run. Null when there is no
   * session to continue (pi never wrote one) — the caller then derives a subject itself. The
   * agent run is returned even when it failed so the caller can honor a shutdown abort. */
  async requestSummary(wt: string, config?: ResolvedModelConfig, overLength?: number): Promise<PiRunResult | null> {
    return this.requestFollowUp(
      wt,
      buildSummaryRequestPrompt(overLength),
      "summary",
      RunnerPi.SUMMARY_REQUEST_TIMEOUT_S,
      config,
    );
  }

  /** Ask the run's own pi session (--continue) to fix the pre-queue self-check's findings:
   * one bounded turn, folded into the run's usage like every other agent run. `change` is the
   * change's description so far, shown so the turn does not restate it. Null when there is no
   * session to continue — the caller then warns and lets the gate judge. The agent run is returned
   * even when it failed so the caller can honor a shutdown abort. */
  async requestStageFix(
    wt: string,
    findings: string[],
    change: StagedDescription,
    config?: ResolvedModelConfig,
  ): Promise<PiRunResult | null> {
    return this.requestFollowUp(
      wt,
      buildStageFixPrompt(findings, change),
      "stagefix",
      RunnerPi.STAGE_FIX_TIMEOUT_S,
      config,
    );
  }
}


/** The runner's shared pi wiring as merge code reaches it, split into the two halves the
 * merge contexts need. `RunsPi` is one pi run in `wt` through the runner's shared wiring
 * (role config, session dir, raw log, transient-failure retry — src/runner/runner-pi.ts);
 * `FoldsUsage` adds one agent run's spend to the owning runner's counters exactly once (the
 * reviewer and conflict-resolution runs charge to the authoring role). Declared once here so the
 * contract — and its wording — cannot drift apart across the four contexts that restate it:
 * MergerContext and BatchRoleWiring carry all three halves (PiRunWiring), MergeContext only
 * the resolver's runner (its runPi folds usage internally), and ApprovedMerge only the fold.
 *
 * `runPi`'s optional fourth argument is the config that ONE agent run executes on (plans/
 * model-tiers.md part 4/8): the conflict resolver passes the strong tier's config there while
 * the authoring runs keep the role's own. The runner's wiring forwards it to runRolePi; an agent
 * run without it rides the role's config unchanged. */
export interface RunsPi {
  runPi(wt: string, prompt: string, sessionName: string, config?: ResolvedModelConfig): Promise<PiRunResult>;
}

/** The merge gate's reviewer runs through the runner's shared transient-retry wiring
 * (src/runner/runner-pi.ts's runGatePi). Separate from RunsPi because the conflict resolver never
 * needs it and the gate never needs the three-arg resolver shape. */
export interface GateRunsPi {
  runGatePi(opts: PiRunOptions): Promise<PiRunResult>;
}

/** One agent run's spend folded into the owning runner's usage counters exactly once — the
 * reviewer's and conflict-resolution's runs charge to the authoring role, so the folding
 * belongs to the runner, not to the agent run itself (the runner's runPi wiring,
 * src/runner/runner-run.ts). */
export interface FoldsUsage {
  foldUsage(run: PiRunResult): void;
}

/** A merge context that runs pi through the runner's shared wiring and folds each agent run's
 * usage: both halves (RunsPi + FoldsUsage). MergerContext and BatchRoleWiring extend this;
 * contexts needing only one half extend that half instead (MergeContext, ApprovedMerge). */
export interface PiRunWiring extends RunsPi, GateRunsPi, FoldsUsage {}
