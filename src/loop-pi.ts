import type { TumwaterConfig } from "./config/config-schema.js";
import type { PiRunResult } from "./pi/pi-run-result.js";
import { hasResumableSession, runPi, type PiRunOptions } from "./pi/pi.js";
import { HOLD_BASE_MS } from "./fleet-hold.js";
import { backendKindPhrase } from "./phrases.js";
import { configForRole, type ResolvedModelConfig } from "./config/config-views.js";
import { buildSummaryRequestPrompt } from "./prompt-followup.js";
import { piLogPath, sessionDir } from "./paths.js";
import { cappedRequestTimeouts } from "./request-timeouts.js";

/** Upper bound on how long the transient retry waits out a provider's Retry-After hint
 * before re-attempting a rate-limited run. Honouring the hint is the point; capping it is
 * what keeps one generous hint from consuming the tick's own run budget (the retry gets a
 * full fresh run budget, so a wait larger than the cap would spend the tick waiting, not
 * working). */
const RATE_LIMIT_RETRY_AFTER_CAP_S = 120;

/** What a hint-less 429 waits before its one retry. With no Retry-After from the provider, the
 * fleet's own constants state the refill physics: fleet-hold.ts's base hold is one minute,
 * "the shortest pause that lets the bucket refill". Retrying sooner re-enters the same exhausted
 * per-minute bucket the first request just emptied and burns the tick's only retry on a
 * near-certain second 429. A present hint always wins instead; the cap above still bounds
 * whatever the wait ends up being. */
const RATE_LIMIT_NO_HINT_RETRY_S = Math.round(HOLD_BASE_MS / 1000);

/** The retry's pause on the real clock; tests inject host.sleep and never reach this. */
function sleepFor(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** What the extracted pi-run plumbing needs from its owning loop. The loop supplies live
 * accessors, not copies: `config()` and `tickNumber()` are read at every call so the
 * orchestrator's live-reload (which swaps the config object under the loop) and the tick
 * lifecycle stay authoritative without any notification path. */
interface LoopPiHost {
  readonly root: string;
  readonly role: string;
  config(): TumwaterConfig;
  /** The harness shutdown signal (may be undefined — PiRunOptions.signal is optional). */
  readonly signal?: AbortSignal;
  /** The signal a tick's own runs watch: harness shutdown OR per-tick user abort. */
  runSignal(): AbortSignal;
  warn(message: string): void;
  foldUsage(run: PiRunResult): void;
  tickNumber(): number;
  /** The transient retry's pause before re-running, injectable so tests record the wait
   * instead of living through it (a hint-less 429 waits a real minute). Unset means the
   * real clock via sleepFor. */
  sleep?(ms: number): Promise<void>;
}

/** The pi-invocation plumbing of one role loop, extracted from LoopRunner (src/loop.ts):
 * the shared per-loop wiring for every run (role config, session dir, raw log, abort
 * signal), the one bounded transient-failure retry all runs share, the landing slot's
 * run (which watches only the shutdown signal), and the tick's SUMMARY follow-up turn.
 * It owns HOW a loop talks to pi; the LoopRunner tick state machine owns WHAT runs happen
 * and folds every run's spend back through the host's foldUsage. */
export class LoopPi {
  constructor(private readonly host: LoopPiHost) {}

  /** The shared per-loop wiring for every pi run this tick makes in worktree `wt`: the
   * role-resolved config, this loop's session dir and raw log, and the per-tick abort signal.
   * One place for those derivations — a new PiRunOptions field touches only here instead of
   * drifting between the author run and the SUMMARY follow-up. Callers override what differs
   * (the follow-up's capped timeouts, the landing's shutdown-only signal). */
  private loopPiOpts(
    wt: string,
    prompt: string,
    sessionName: string,
    resume = false,
    config?: ResolvedModelConfig,
  ): PiRunOptions {
    return {
      cwd: wt,
      prompt,
      // A caller-supplied config (the landing conflict resolver's strong-tier one,
      // plans/model-tiers.md part 4/8) replaces the role's own for that one run; the role's
      // config is the default for every other caller.
      config: config ?? configForRole(this.host.config(), this.host.role),
      sessionDir: sessionDir(this.host.root, this.host.role),
      sessionName,
      continueSession: resume,
      rawLogFile: piLogPath(this.host.root, this.host.role),
      signal: this.host.runSignal(),
      // A tool call silent for the configured stall threshold names itself in the event feed
      // while the quiet watchdog still counts down (BUGS.md 2026-09-13 sibling): before this,
      // a hung command was invisible until the kill. The dashboards derive their own flag from
      // the raw log, so only the harness event needs wiring here.
      onToolCallStalled: (message) => this.host.warn(message),
    };
  }

  /** Run the orchestrator's landing slot's pi (merge queue 3/5): the shared per-loop wiring
   * of runRolePi — role config, session dir, raw log, transient-failure retry — with usage
   * folded into the authoring loop's counters, but watching ONLY the harness shutdown signal
   * (which may be undefined — PiRunOptions.signal is optional): a landing is outside any
   * tick, so `tumwater abort --role` (which targets a tick's per-tick abort controller) must
   * never reach it, and the stale per-tick controller of a finished tick must not abort it
   * either. Session naming is the caller's (the reviewer composes its own from
   * ReviewContext.tick; landing-merge.ts keeps its conflict-resolver naming through LanderContext.runPi).
   */
  async runLandingPi(wt: string, prompt: string, sessionName: string): Promise<PiRunResult> {
    return this.runWithTransientRetry({
      ...this.loopPiOpts(wt, prompt, sessionName),
      signal: this.host.signal,
    });
  }

  /** The landing gate's reviewer runs (review.ts's review run and verdict follow-up): the
   * same shared transient-retry wiring — a 429 in the gate waits its hint out and retries
   * once, exactly like an authoring run (BUGS.md 2026-10-01) — with one folding difference:
   * the FINAL run's usage is folded by the gate's caller (landing-core's foldUsage of
   * gate.run / gate.followUpRun), so only a RETRIED first attempt is folded here. That fold
   * is not optional: it stamps the fleet-wide rate-limit hold's input before the wait, and
   * it is the only record the failed attempt's spend would ever get.
   * Takes full PiRunOptions because the gate's two runs differ in everything but the loop
   * they charge (config, session dir and name, label, tool-call callbacks, signal).
   */
  async runGatePi(opts: PiRunOptions): Promise<PiRunResult> {
    return this.runWithTransientRetry(opts, { foldFinal: false });
  }

  /** The one bounded transient-failure retry shared by EVERY pi run this loop makes
   * (runRolePi, runLandingPi, and runGatePi): two transient failures of the world (not of the session)
   * earn exactly one retry that continues the same session — the model server timing out an
   * idle predict stream, the provider severing that stream outright (undici's bare
   * "terminated", the stream-severed backend kind), the provider accepting a request and
   * then failing to answer it in time (its own "Request timed out.", the timeout backend
   * kind), pi itself crashing on a torn server chunk (a JSON.parse failure on its stderr),
   * and the provider rate-limiting the request with
   * HTTP 429 (where the
   * provider's Retry-After hint, when sent, is waited out first — capped, so one provider's
   * generosity cannot eat the tick's own run budget). A harness-killed or quiet-killed run
   * never takes the transient-retry path:
   * its session is intact but resuming it would just re-hit whatever hung, burning another
   * full quiet timeout. Extracted verbatim from runRolePi so the rule lives in one place
   * (574a14c's loopPiOpts move was the wiring half of the same single-source-of-truth).
   */
  private async runWithTransientRetry(
    opts: PiRunOptions,
    /** runGatePi only: skip folding the FINAL returned run (the caller folds it), while a
     * retried first attempt still folds — its spend and its rate-limit hold stamp must not
     * vanish just because the gate routes its own folding. Default folds everything, the
     * authoring and landing behavior. */
    { foldFinal = true }: { foldFinal?: boolean } = {},
  ): Promise<PiRunResult> {
    const pi = await runPi(opts);
    if (
      !pi.aborted &&
      !pi.timedOut &&
      !pi.quietKilled &&
      (pi.transientServerTimeout ||
        pi.transientPiCrash ||
        pi.transientRateLimit ||
        (pi.transientBackend &&
          (pi.backendKind === "stream-severed" || pi.backendKind === "timeout"))) &&
      !pi.ok
    ) {
      this.host.warn(
        pi.transientPiCrash
          ? `pi crashed on malformed JSON (${pi.errorMessage ?? "no detail"}) — resuming the session once`
          : pi.transientRateLimit
            ? `provider rate-limited the request (429${pi.retryAfterSeconds ? `, retry after ${pi.retryAfterSeconds}s` : `, no hint — waiting ${RATE_LIMIT_NO_HINT_RETRY_S}s`}) — retrying the pi run once`
            : pi.backendKind === "stream-severed"
              ? "provider severed the in-flight stream (terminated) — retrying the pi run once"
              : pi.backendKind === "timeout"
                ? "provider request timed out after accepting the connection — retrying the pi run once"
                : "model server timed out an idle predict stream (e.g. machine sleep) — retrying the pi run once",
      );
      // The failed attempt folds NOW, before the wait and the retry: a 429 it ended on is the
      // fleet-wide rate-limit hold's input (LoopRunner.lastRateLimit, stamped at fold time), and
      // folding after a retry that ran on for an hour would report the storm an hour late.
      this.host.foldUsage(pi);
      // The pause is the rate-limit branch's, plus the timeout kind's: a server timeout or
      // pi crash is a failure of the local path, retried at once, while a 429 must wait its
      // per-minute bucket out. A hint-less 429 defaults to that minute-scale refill pause
      // instead of 0 — an immediate retry lands in the same exhausted bucket and burns the
      // tick's only retry (BUGS.md 2026-09-25). A present hint wins; the cap bounds either.
      // A hint of 0 (or any non-positive value) is no usable hint — "retry now" is exactly
      // the burned-retry bug a hint-less 429 causes — so it falls back to the refill pause
      // just like a missing hint, keeping the warning text and the actual wait in agreement.
      // The timeout kind (BUGS.md 2026-09-30) takes that same minute-scale pause: the
      // provider accepted the request and failed to answer it, an overload shape — an
      // immediate re-request lands at the back of the same queue and burns the tick's only
      // retry, so the retry waits the refill pause out first.
      const hintS =
        pi.retryAfterSeconds && pi.retryAfterSeconds > 0 ? pi.retryAfterSeconds : RATE_LIMIT_NO_HINT_RETRY_S;
      const waitS = pi.transientRateLimit
        ? Math.min(hintS, RATE_LIMIT_RETRY_AFTER_CAP_S)
        : pi.backendKind === "timeout"
          ? RATE_LIMIT_NO_HINT_RETRY_S
          : 0;
      if (waitS > 0) await (this.host.sleep?.(waitS * 1000) ?? sleepFor(waitS * 1000));
      // Within-run continuity only: resume the session the first attempt created, so its
      // partial progress is not re-done. The next tick still starts fresh.
      const retry = await runPi({ ...opts, continueSession: true });
      if (foldFinal) this.host.foldUsage(retry);
      return retry;
    }
    // The backend-kind floor (BUGS.md 2026-09-29): a failed run of a backend kind the retry
    // does not cover (connection down, 5xx, model load) still warns — parity with the 429
    // branch above, so any episode is visible from the feed alone instead of living only in
    // per-tick error events an operator must aggregate by hand. The fleet-wide hold
    // (src/fleet-hold.ts) and the storm alarms judge the spread; this line is the per-run
    // floor under them, not a retry: a dead backend is not something an immediate re-run beats.
    if (
      !pi.ok &&
      !pi.aborted &&
      !pi.timedOut &&
      !pi.quietKilled &&
      pi.transientBackend
    ) {
      this.host.warn(
        `provider backend failure (${backendKindPhrase(pi.backendKind)}) — the transient retry does not cover this kind; the fleet-wide hold watches for a storm`,
      );
    }
    if (foldFinal) this.host.foldUsage(pi);
    return pi;
  }

  /** Run pi for this loop's authoring run in worktree `wt`: the shared per-loop wiring and
   * the transient-failure retry, with usage folded into the tick's counters. Every run starts
   * a FRESH pi session: context never accumulates across ticks, so ticks start cheap
   * (small prefill), never inherit a near-full window, and durable knowledge lives where
   * the prompt makes pi read it — README/PLANS/BUGS and the code itself.
   * `resume` continues the role's most recent session instead — used only when picking up
   * a tick that a harness shutdown interrupted. */
  async runRolePi(
    wt: string,
    prompt: string,
    sessionName: string,
    resume = false,
    config?: ResolvedModelConfig,
  ): Promise<PiRunResult> {
    return this.runWithTransientRetry(this.loopPiOpts(wt, prompt, sessionName, resume, config));
  }

  /** Hard caps on the SUMMARY follow-up turn: it should take one short reply on a warm session,
   * so it never gets the authoring run's hours-long budget. */
  private static readonly SUMMARY_REQUEST_TIMEOUT_S = 900;
  private static readonly SUMMARY_REQUEST_QUIET_S = 300;

  /** Ask the tick's own pi session (--continue) for the missing SUMMARY block: one tightly
   * bounded turn, folded into the tick's usage like every other run. Null when there is no
   * session to continue (pi never wrote one) — the caller then derives a subject itself. The
   * run is returned even when it failed so the caller can honor a shutdown abort. */
  async requestSummary(wt: string): Promise<PiRunResult | null> {
    if (!hasResumableSession(sessionDir(this.host.root, this.host.role))) return null;
    const cfg = configForRole(this.host.config(), this.host.role);
    // The shared per-loop wiring (loopPiOpts) with the follow-up's hard caps overriding the
    // authoring run's budget: one short reply on a warm session. The run takes the loop's
    // SHARED transient-failure retry (BUGS.md 2026-10-01): a 429 on the follow-up turn waits
    // its Retry-After hint out and retries once on the same session, exactly like the
    // authoring run, the landing slot's run, and the gate's reviewer runs it mirrors —
    // before this it called bare runPi, so a rate-limited follow-up failed the tick's
    // SUMMARY on first contact with no warning and no fleet-wide rate-limit hold stamp.
    // The caps bound BOTH attempts (the retry inherits this capped config), so a flaky
    // provider cannot stretch the follow-up past its budget by more than one capped turn.
    // The wiring folds every attempt (the failed 429 before the wait), and the returned
    // final run is folded here by the wiring itself — no second fold at the call site.
    return this.runWithTransientRetry({
      ...this.loopPiOpts(wt, buildSummaryRequestPrompt(), `tumwater-${this.host.role}-${this.host.tickNumber()}-summary`, true),
      config: {
        ...cfg,
        ...cappedRequestTimeouts(cfg, LoopPi.SUMMARY_REQUEST_TIMEOUT_S, LoopPi.SUMMARY_REQUEST_QUIET_S),
      },
    });
  }
}

/** The loop's shared pi wiring as landing code reaches it, split into the two halves the
 * landing contexts need. `RunsPi` is one pi run in `wt` through the loop's shared wiring
 * (role config, session dir, raw log, transient-failure retry — src/loop-pi.ts); `FoldsUsage`
 * adds one run's spend to the owning loop's counters exactly once (the reviewer and
 * conflict-resolution runs charge to the authoring role). Declared once here so the contract
 * — and its wording — cannot drift apart across the four contexts that restate it:
 * LanderContext and BatchRoleWiring carry all three halves (PiRunWiring), MergeContext only
 * the resolver's runner (its runPi folds usage internally), and VettedLanding only the fold.
 *
 * `runPi`'s optional fourth argument is the config that ONE run executes on (plans/
 * model-tiers.md part 4/8): the conflict resolver passes the strong tier's config there while
 * the authoring runs keep the role's own. The loop's wiring forwards it to runRolePi; a run
 * without it rides the role's config unchanged. */
export interface RunsPi {
  runPi(wt: string, prompt: string, sessionName: string, config?: ResolvedModelConfig): Promise<PiRunResult>;
}

/** The landing gate's reviewer runs through the loop's shared transient-retry wiring
 * (src/loop-pi.ts's runGatePi). Separate from RunsPi because the conflict resolver never
 * needs it and the gate never needs the three-arg resolver shape. */
export interface GateRunsPi {
  runGatePi(opts: PiRunOptions): Promise<PiRunResult>;
}

/** One run's spend folded into the owning loop's usage counters exactly once — the
 * reviewer's and conflict-resolution's runs charge to the authoring role, so the folding
 * belongs to the loop, not to the run itself (src/loop.ts's runPi). */
export interface FoldsUsage {
  foldUsage(run: PiRunResult): void;
}

/** A landing context that runs pi through the loop's shared wiring and folds each run's
 * usage: both halves (RunsPi + FoldsUsage). LanderContext and BatchRoleWiring extend this;
 * contexts needing only one half extend that half instead (MergeContext, VettedLanding). */
export interface PiRunWiring extends RunsPi, GateRunsPi, FoldsUsage {}
