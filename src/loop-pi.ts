import type { TumwaterConfig, PiRunResult } from "./types.js";
import { hasResumableSession, runPi, type PiRunOptions } from "./pi.js";
import { configForRole } from "./config.js";
import { buildSummaryRequestPrompt } from "./prompt.js";
import { piLogPath, sessionDir } from "./paths.js";

/** Upper bound on how long the transient retry waits out a provider's Retry-After hint
 * before re-attempting a rate-limited run. Honouring the hint is the point; capping it is
 * what keeps one generous hint from consuming the tick's own run budget (the retry gets a
 * full fresh run budget, so a wait larger than the cap would spend the tick waiting, not
 * working). */
const RATE_LIMIT_RETRY_AFTER_CAP_S = 120;

/** What the extracted pi-run plumbing needs from its owning loop. The loop supplies live
 * accessors, not copies: `config()` and `tickNumber()` are read at every call so the
 * orchestrator's live-reload (which swaps the config object under the loop) and the tick
 * lifecycle stay authoritative without any notification path. */
export interface LoopPiHost {
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
  private loopPiOpts(wt: string, prompt: string, sessionName: string, resume = false): PiRunOptions {
    return {
      cwd: wt,
      prompt,
      config: configForRole(this.host.config(), this.host.role),
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
   * ReviewContext.tick; merge.ts keeps its conflict-resolver naming through LanderContext.runPi).
   */
  async runLandingPi(wt: string, prompt: string, sessionName: string): Promise<PiRunResult> {
    return this.runWithTransientRetry({
      ...this.loopPiOpts(wt, prompt, sessionName),
      signal: this.host.signal,
    });
  }

  /** The one bounded transient-failure retry shared by EVERY pi run this loop makes
   * (runRolePi and runLandingPi): two transient failures of the world (not of the session)
   * earn exactly one retry that continues the same session — the model server timing out an
   * idle predict stream, pi itself crashing on a torn server chunk (a JSON.parse failure
   * on its stderr), and the provider rate-limiting the request with HTTP 429 (where the
   * provider's Retry-After hint, when sent, is waited out first — capped, so one provider's
   * generosity cannot eat the tick's own run budget). A harness-killed or quiet-killed run
   * never takes the transient-retry path:
   * its session is intact but resuming it would just re-hit whatever hung, burning another
   * full quiet timeout. Extracted verbatim from runRolePi so the rule lives in one place
   * (574a14c's loopPiOpts move was the wiring half of the same single-source-of-truth).
   */
  private async runWithTransientRetry(opts: PiRunOptions): Promise<PiRunResult> {
    const pi = await runPi(opts);
    if (
      !pi.aborted &&
      !pi.timedOut &&
      !pi.quietKilled &&
      (pi.transientServerTimeout || pi.transientPiCrash || pi.transientRateLimit) &&
      !pi.ok
    ) {
      this.host.warn(
        pi.transientPiCrash
          ? `pi crashed on malformed JSON (${pi.errorMessage ?? "no detail"}) — resuming the session once`
          : pi.transientRateLimit
            ? `provider rate-limited the request (429${pi.retryAfterSeconds ? `, retry after ${pi.retryAfterSeconds}s` : ""}) — retrying the pi run once`
            : "model server timed out an idle predict stream (e.g. machine sleep) — retrying the pi run once",
      );
      // Honour the provider's Retry-After hint when it sent one, so the retry does not
      // re-hit the same limit immediately; capped so a huge hint cannot consume the tick.
      const waitS = Math.min(pi.retryAfterSeconds ?? 0, RATE_LIMIT_RETRY_AFTER_CAP_S);
      if (waitS > 0) await new Promise((r) => setTimeout(r, waitS * 1000));
      // Within-run continuity only: resume the session the first attempt created, so its
      // partial progress is not re-done. The next tick still starts fresh.
      const retry = await runPi({ ...opts, continueSession: true });
      this.host.foldUsage(pi);
      this.host.foldUsage(retry);
      return retry;
    }
    this.host.foldUsage(pi);
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
  ): Promise<PiRunResult> {
    return this.runWithTransientRetry(this.loopPiOpts(wt, prompt, sessionName, resume));
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
    // authoring run's budget: one short reply on a warm session.
    const run = await runPi({
      ...this.loopPiOpts(wt, buildSummaryRequestPrompt(), `tumwater-${this.host.role}-${this.host.tickNumber()}-summary`, true),
      config: {
        ...cfg,
        tickTimeoutSeconds: Math.min(cfg.tickTimeoutSeconds, LoopPi.SUMMARY_REQUEST_TIMEOUT_S),
        quietTimeoutSeconds:
          cfg.quietTimeoutSeconds > 0
            ? Math.min(cfg.quietTimeoutSeconds, LoopPi.SUMMARY_REQUEST_QUIET_S)
            : LoopPi.SUMMARY_REQUEST_QUIET_S,
      },
    });
    this.host.foldUsage(run);
    return run;
  }
}
