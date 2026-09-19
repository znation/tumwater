import type { TumwaterConfig, LoopState, PiRunResult, TickOutcome, TickResult } from "./types.js";
import { customRole, DIRECTOR_ROLE, roleById } from "./roles.js";
import {
  branchHead,
  changedFiles,
  commitAll,
  deleteRef,
  isDirty,
  setRef,
} from "./git.js";
import { abortSync, ensureWorktree, resetWorktreeToMain } from "./worktree.js";
import { logEvent } from "./events.js";
import { hasResumableSession, runPi, type PiRunOptions } from "./pi.js";
import {
  buildCommitMessage,
  commitTrailer,
  extractCommitBody,
  extractSummary,
  fallbackSummary,
  formatCommitBody,
} from "./commit-message.js";
import {
  buildCutOffNote,
  buildDirectorPrompt,
  buildRejectedReviewNote,
  buildResumePrompt,
  buildSummaryRequestPrompt,
  buildTickPrompt,
  readPrinciples,
} from "./prompt.js";
import { readInitialPrompt } from "./readme.js";
import { telemetryDigest } from "./failure-report.js";
import { configForRole } from "./config.js";
import { landChange, type LandRequest } from "./lander.js";
import { enqueueLanding } from "./land-queue.js";
import { dequeuePrompt, enqueuePrompt } from "./inbox.js";
import { ERROR_STREAK_WARN, QUIET_KILL_RESUME_LIMIT, applyTickOutcome, clearBackoff, loadLoopState, saveLoopState, zeroCounters } from "./state.js";
import { recordDailyCost } from "./budget.js";
import { recoverLeftover } from "./leftover.js";
import { mainRedGate } from "./main-red.js";
import { mergeToMain } from "./merge.js";
import { diagnoseNoChange } from "./no-change.js";
import { handleRefusal } from "./refusal.js";
import { extractFlow } from "./reply-contract.js";
import { readQaCoverage, recordFlow, renderCoverageBlock } from "./qa-coverage.js";
import { landingRefName, piLogPath, sessionDir } from "./paths.js";
import { errorMessage, shortSha } from "./text.js";

/** One role loop: owns a persistent worktree + branch and runs one tick at a time. */
export class LoopRunner {
  state: LoopState;
  /** The current tumwater.json config. Not readonly on purpose: the orchestrator pushes a
   * freshly loaded config in here every poll cycle (live-reload), and every downstream read
   * goes through this, so one assignment steers provider/model/thinking/instructions,
   * tick intervals, backoff, and role enablement for subsequent ticks. */
  config: TumwaterConfig;
  /** The raw user prompt a director tick is executing, so an unfulfilled tick (abort,
   * timeout, or failure without changes) can re-queue it instead of losing the request. */
  private pendingUserPrompt: string | null = null;
  /** Assistant turns folded into THIS tick so far (non-persisted): reset at tick start,
   * grown in foldUsage. Read at commit time for the trailer, where it holds exactly the
   * pre-commit runs' total (main + transient retry) — conflict-resolution and review runs
   * fold after the commit and never inflate it. Deliberately not on LoopState: its only
   * consumer is the trailer stamped into the commit message itself, which is durable. */
  private tickTurns = 0;
  /** USD cost folded into THIS tick so far (non-persisted): reset at tick start alongside
   * tickTurns, grown in foldUsage. Deliberately not on LoopState — unlike generatedTokens,
   * no dashboard reads it mid-run; its only consumer is the tick_end event, which fires before
   * the next tick resets it (plans: per-tick usage in the event feed). */
  private tickCostUsd = 0;
  /** Per-tick abort controller, recreated at every tick start: `abortTick()` kills the
   * in-flight pi run without touching the harness shutdown signal (`this.signal`), which
   * would stop the whole fleet. */
  private tickAbort = new AbortController();
  /** Set by abortTick() when a user-initiated abort lands mid-tick: runTick's two abort
   * branches (author run, review gate) then diverge from shutdown semantics — worktree reset
   * to main, no director-prompt requeue, "user_aborted" result with normal backoff. Cleared
   * at the next tick start so a stale request can never leak into a later tick. */
  private userAborted = false;

  constructor(
    readonly root: string,
    readonly role: string,
    config: TumwaterConfig,
    readonly mainBranch: string,
    readonly signal?: AbortSignal,
  ) {
    this.config = config;
    this.state = loadLoopState(root, role);
    // A persisted running flag means the previous process died mid-tick WITHOUT the
    // graceful-abort bookkeeping (crash, kill -9, power loss). The interruption looks the
    // same on disk — pi session and worktree edits in place — so resume it the same way.
    if (this.state.running && role !== DIRECTOR_ROLE) this.state.resumePending = true;
    this.state.running = false;
  }

  private save(): void {
    saveLoopState(this.root, this.state);
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

  /** The signal every pi run of the current tick watches: harness shutdown OR a per-tick user
   * abort (Node ≥ 20's AbortSignal.any). */
  private runSignal(): AbortSignal {
    return this.signal ? AbortSignal.any([this.signal, this.tickAbort.signal]) : this.tickAbort.signal;
  }

  /** Decide the prompt for this tick, or null to skip (director with empty inbox). */
  private tickPrompt(): string | null {
    const initialPrompt = readInitialPrompt(this.root);
    // The project's design principles ride along in every prompt — tick and director alike — so
    // all loops share one standard of taste. Empty when the repo has no PRINCIPLES.md.
    const principles = readPrinciples(this.root);
    let prompt: string;
    if (this.role === DIRECTOR_ROLE) {
      const userPrompt = dequeuePrompt(this.root);
      if (!userPrompt) return null;
      this.pendingUserPrompt = userPrompt;
      prompt = buildDirectorPrompt(userPrompt, initialPrompt, principles);
    } else {
      // Catalog first, then user-defined loops (plans/user-defined-loops.md): a custom's task
      // is its entire find-something-to-do text and the title identifies it in the prompt.
      const custom = this.config.customLoops.find((c) => c.name === this.role);
      const role = roleById(this.role) ?? (custom ? customRole(custom.name, custom.task) : undefined);
      if (!role) throw new Error(`unknown role: ${this.role}`);
      // The telemetry role's evidence is the harness's own event log, one level outside this
      // worktree, so the report module renders it (telemetryDigest) and the tick injects it.
      const digest = this.role === "telemetry" ? telemetryDigest(this.root) : undefined;
      // The `qa` observer's flow rotation needs a memory of what it last exercised; every tick
      // is a fresh session, and a passing cheap check leaves nothing in the repo. The ledger is
      // runtime state, and a missing or unreadable one degrades to no block (plans/observer-roles.md 2/2).
      let coverage: string | undefined;
      if (this.role === "qa") {
        try {
          coverage = renderCoverageBlock(readQaCoverage(this.root));
        } catch {
          coverage = undefined;
        }
      }
      prompt = buildTickPrompt({
        role,
        initialPrompt,
        principles,
        digest,
        coverage,
        extraInstructions: this.config.roles[this.role]?.instructions,
      });
    }
    // A change rejected in review is the only cross-tick memory of what was built and why it
    // failed — every tick starts a fresh session, so the full reasons ride along on the next
    // prompt until the role's next reviewed change replaces them.
    if (this.state.lastReview?.verdict === "reject") {
      prompt += `\n\n${buildRejectedReviewNote(this.state.lastReview.reasons)}`;
    }
    // A fresh tick after the previous run(s) were cut off at the context ceiling (the loop
    // stopped resuming, or never resumed — the director re-runs its prompt fresh): the only
    // memory that the last attempt was too big for the window is this note.
    if ((this.state.cutOffStreak ?? 0) > 0) {
      prompt += `\n\n${buildCutOffNote(this.state.cutOffStreak ?? 0)}`;
    }
    return prompt;
  }

  /** Put an unfulfilled director prompt back in the inbox so the next tick retries it — the
   * one place that policy lives, shared by every outcome that leaves the request undone
   * (abort, timeout, failure without changes, review abort, context-ceiling cut-off). No-op
   * for role loops, which carry no pending user prompt. A fulfilled no_change never reaches
   * here: re-queueing it would loop the prompt forever. */
  private requeueUnfulfilledPrompt(userPrompt: string | null): void {
    if (userPrompt) enqueuePrompt(this.root, userPrompt);
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
      this.pendingUserPrompt = null;
      await resetWorktreeToMain(wt, this.mainBranch);
      return { result: "user_aborted" };
    }
    // Shutdown mid-run: fail closed — a director prompt goes back to the inbox like any other
    // unfulfilled abort (mid-review the commit stays on the branch for re-review; mid-author-
    // run its half-done edits are discarded by the next tick's reset).
    this.requeueUnfulfilledPrompt(userPrompt);
    return { result: "aborted" };
  }

  /** Land the worktree branch on main (see src/merge.ts for the rebase → verify → ff-merge →
   * conflict-retry flow): delegates with this loop's identity, tick number, and shared pi wiring
   * so a conflict-resolution run folds into this tick's counters like any other pi run. Since
   * merge queue 2/5 only the refusal-note landing (src/refusal.ts) still uses it — reviewed
   * changes land through the lander in _land-<role> instead; md-only notes are review-exempt by
   * construction, so they keep this branch path (plans/merge-queue.md 2/5). */
  private async merge(wt: string, summary: string): Promise<TickResult> {
    return mergeToMain(
      {
        root: this.root,
        role: this.role,
        mainBranch: this.mainBranch,
        exemptPaths: this.config.review.exemptPaths,
        tick: this.state.ticks,
        runPi: (w, prompt, sessionName) => this.runRolePi(w, prompt, sessionName),
      },
      wt,
      summary,
    );
  }

  /** Pin `sha` by this role's landing ref and free the worktree (plans/merge-queue.md invariant
   * 4): the pin must exist BEFORE resetWorktreeToMain moves the branch, or the commit is
   * orphaned. Returns false when the pin write failed — the caller then leaves the commit on its
   * branch (no reset) and defers to next-tick recovery, which adopts it into the pin scheme.
   * After a successful pin the review gate and the rebase run in _land-<role> — never in this
   * worktree (merge queue 2/5). */
  private async pinAndReset(wt: string, sha: string): Promise<boolean> {
    const pinned = await setRef(this.root, landingRefName(this.role), sha);
    if (!pinned) {
      logEvent(this.root, {
        loop: this.role,
        type: "warning",
        message: `failed to pin ${shortSha(sha)} by its landing ref — leaving the commit on the branch for next-tick recovery`,
      });
      return false;
    }
    await resetWorktreeToMain(wt, this.mainBranch);
    return true;
  }

  /** Review and land a pinned commit in this role's lander worktree (src/lander.ts) with this
   * loop's shared wiring: the reviewer run folds via foldUsage, merge.ts's conflict resolver
   * goes through runRolePi (which folds internally), and aborts ride on the tick's signal.
   * Since merge queue 3/5 this serves the leftover-recovery path only — a fresh tick's change
   * is ENQUEUED for the orchestrator's landing slot instead of landed inside the tick. Returns
   * the same TickResult values a tick returns. */
  private async land(req: LandRequest): Promise<TickResult> {
    return landChange(
      {
        root: this.root,
        mainBranch: this.mainBranch,
        config: this.config,
        state: this.state,
        runPi: (w, prompt, sessionName) => this.runRolePi(w, prompt, sessionName),
        foldUsage: (run) => this.foldUsage(run),
        signal: () => this.runSignal(),
      },
      req,
    );
  }

  /** Fold one pi run's usage into the tick's counters (gen / peak ctx / cost / turns). Every
   * pi run of a tick — main attempt, transient-timeout retry, conflict resolution — lands here
   * exactly once, so adding a usage field to PiRunResult touches this single place. Landing
   * runs fold through the same place via foldLandingUsage, so the authoring role is charged
   * for its reviewer and conflict-resolution spend too. */
  private foldUsage(run: PiRunResult): void {
    const s = this.state;
    s.generatedTokens += run.outputTokens;
    s.peakContextTokens = Math.max(s.peakContextTokens, run.peakContextTokens);
    s.totalCostUsd += run.costUsd;
    this.tickCostUsd += run.costUsd;
    // The daily cost budget window (plans/daily-cost-budget.md): every pi run of a tick folds
    // here exactly once, so the fleet's spend for the local day is complete at each tick end.
    recordDailyCost(s, run.costUsd);
    this.tickTurns += run.turns;
  }

  /** Run pi for this loop in worktree `wt` with the shared per-loop wiring (role config,
   * session dir, raw log) and fold the run's tokens/cost into the state. Every run starts
   * a FRESH pi session: context never accumulates across ticks, so ticks start cheap
   * (small prefill), never inherit a near-full window, and durable knowledge lives where
   * the prompt makes pi read it — README/PLANS/BUGS and the code itself.
   * A transient model-server timeout (e.g. the machine slept mid-run) gets exactly one
   * bounded retry: fresh requests succeed quickly after a wake.
   * `resume` continues the role's most recent session instead — used only when picking up
   * a tick that a harness shutdown interrupted. */
  /** The shared per-loop wiring for every pi run this tick makes in worktree `wt`: the
   * role-resolved config, this loop's session dir and raw log, and the per-tick abort signal.
   * One place for those derivations — a new PiRunOptions field touches only here instead of
   * drifting between the author run and the SUMMARY follow-up. Callers override what differs
   * (the follow-up's capped timeouts). */
  private loopPiOpts(wt: string, prompt: string, sessionName: string, resume = false): PiRunOptions {
    return {
      cwd: wt,
      prompt,
      config: configForRole(this.config, this.role),
      sessionDir: sessionDir(this.root, this.role),
      sessionName,
      continueSession: resume,
      rawLogFile: piLogPath(this.root, this.role),
      signal: this.runSignal(),
      // A tool call silent for the configured stall threshold names itself in the event feed
      // while the quiet watchdog still counts down (BUGS.md 2026-09-13 sibling): before this,
      // a hung command was invisible until the kill. The dashboards derive their own flag from
      // the raw log, so only the harness event needs wiring here.
      onToolCallStalled: (message) =>
        logEvent(this.root, { loop: this.role, type: "warning", message }),
    };
  }

  /** Run pi for the orchestrator's landing slot (merge queue 3/5): the shared per-loop wiring
   * of runRolePi — role config, session dir, raw log, transient-failure retry — with usage
   * folded into this loop's counters, but watching ONLY the harness shutdown signal
   * (`this.signal`, which may be undefined — PiRunOptions.signal is optional): a landing is
   * outside any tick, so `tumwater abort --role` (which targets a tick's per-tick abort
   * controller) must never reach it, and the stale per-tick controller of a finished tick must
   * not abort it either. Session naming is the caller's (the reviewer composes its own from
   * ReviewContext.tick; merge.ts keeps its conflict-resolver naming through LanderContext.runPi).
   */
  async runLandingPi(wt: string, prompt: string, sessionName: string): Promise<PiRunResult> {
    return this.runWithTransientRetry({
      ...this.loopPiOpts(wt, prompt, sessionName),
      signal: this.signal,
    });
  }

  /** Public face of foldUsage for the orchestrator's landing wiring: folds a landing pi run
   * (reviewer, conflict resolution) into the AUTHORING role's counters, so the fleet's daily
   * cost and the per-role usage windows attribute that spend to the role that authored the
   * work — no new counter semantics, just the same fold loop.ts applies to its tick runs. */
  foldLandingUsage(run: PiRunResult): void {
    this.foldUsage(run);
  }

  /** The one bounded transient-failure retry shared by EVERY pi run this loop makes
   * (runRolePi and runLandingPi): two transient failures of the world (not of the session)
   * earn exactly one retry that continues the same session — the model server timing out an
   * idle predict stream, and pi itself crashing on a torn server chunk (a JSON.parse failure
   * on its stderr). A harness-killed or quiet-killed run never takes the transient-retry path:
   * its session is intact but resuming it would just re-hit whatever hung, burning another
   * full quiet timeout. Extracted verbatim from runRolePi so the rule lives in one place
   * (574a14c's loopPiOpts move was the wiring half of the same single-source-of-truth).
   */
  private async runWithTransientRetry(opts: PiRunOptions): Promise<PiRunResult> {
    const pi = await runPi(opts);
    if (!pi.aborted && !pi.timedOut && !pi.quietKilled && (pi.transientServerTimeout || pi.transientPiCrash) && !pi.ok) {
      logEvent(this.root, {
        loop: this.role,
        type: "warning",
        message: pi.transientPiCrash
          ? `pi crashed on malformed JSON (${pi.errorMessage ?? "no detail"}) — resuming the session once`
          : "model server timed out an idle predict stream (e.g. machine sleep) — retrying the pi run once",
      });
      // Within-run continuity only: resume the session the first attempt created, so its
      // partial progress is not re-done. The next tick still starts fresh.
      const retry = await runPi({ ...opts, continueSession: true });
      this.foldUsage(pi);
      this.foldUsage(retry);
      return retry;
    }
    this.foldUsage(pi);
    return pi;
  }

  private async runRolePi(
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
  private async requestSummary(wt: string): Promise<PiRunResult | null> {
    if (!hasResumableSession(sessionDir(this.root, this.role))) return null;
    const cfg = configForRole(this.config, this.role);
    // The shared per-loop wiring (loopPiOpts) with the follow-up's hard caps overriding the
    // authoring run's budget: one short reply on a warm session.
    const run = await runPi({
      ...this.loopPiOpts(wt, buildSummaryRequestPrompt(), `tumwater-${this.role}-${this.state.ticks}-summary`, true),
      config: {
        ...cfg,
        tickTimeoutSeconds: Math.min(cfg.tickTimeoutSeconds, LoopRunner.SUMMARY_REQUEST_TIMEOUT_S),
        quietTimeoutSeconds:
          cfg.quietTimeoutSeconds > 0
            ? Math.min(cfg.quietTimeoutSeconds, LoopRunner.SUMMARY_REQUEST_QUIET_S)
            : LoopRunner.SUMMARY_REQUEST_QUIET_S,
      },
    });
    this.foldUsage(run);
    return run;
  }

  /** Run one full tick of this role loop: build (or resume) the prompt, run pi in the
   * worktree, commit and merge any changes it made, then schedule the next run from the
   * outcome — changed/skipped/cut-off ticks wait at least the minimum interval, an aborted
   * one resumes promptly on restart, an unproductive one backs off on the idle ladder, and
   * a failed one on the shorter error ladder (state.ts). Never throws: a failed tick
   * is an "error" result, saved and logged like any other so the loop stays resumable and
   * observable. */
  async tick(): Promise<TickOutcome> {
    const s = this.state;
    // This role's view of the config (per-role provider/model/thinking + minTickIntervalSeconds
    // overrides): resolved once so every interval-based scheduling branch below honors a slow
    // clock (e.g. the steward's ~6 h) and a live-reloaded config applies from this tick on.
    const cfg = configForRole(this.config, this.role);
    s.ticks += 1;
    // gen / peak ctx are per-tick windows, not lifetime totals (user decision 2026-08-25):
    // reset before the start-of-tick save so a working loop's columns grow live from 0 and
    // an idle loop's show its last completed tick. runRolePi accumulates every pi run of
    // this tick (main + transient-timeout retry + conflict resolution) into them, and the
    // end-of-tick save persists the finished run's totals.
    s.generatedTokens = 0;
    s.peakContextTokens = 0;
    this.tickTurns = 0;
    this.tickCostUsd = 0;
    // A fresh per-tick abort controller and a cleared user-abort flag: an abort request that
    // lands while the loop is idle must not leak into the next tick.
    this.tickAbort = new AbortController();
    this.userAborted = false;
    s.running = true;
    s.lastTickStartedAt = Date.now();
    const tick = s.ticks;
    this.save();
    logEvent(this.root, { loop: this.role, type: "tick_start", tick });

    let outcome: TickOutcome;
    try {
      outcome = await this.runTick();
    } catch (err) {
      outcome = { result: "error" };
      s.lastError = errorMessage(err);
    }

    // Read main's current head while this tick is still reserved (running=true): the
    // applyTickOutcome below clears running, and a poll landing between that clear and a later
    // head update would see a stale lastMainHead and wake the loop again on the very move
    // that triggered this tick — a duplicate wake event plus an extra tick for one world change.
    // branchHead reads the ref files first (microsecond-scale, like the orchestrator's per-poll
    // watch) and spawns `git rev-parse` only when they cannot resolve it; a null result keeps
    // the previous value rather than waking on "main moved" to nowhere.
    s.lastMainHead = (await branchHead(this.root, this.mainBranch)) ?? s.lastMainHead;
    // Record the outcome on state and schedule the next run (see src/state.ts for the
    // per-result policy: prompt retry, backoff, bounded cut-off resumes).
    applyTickOutcome(s, cfg, this.role, outcome);
    this.save();
    // One warning per error episode (BUGS.md 2026-09-15: every loop failing identically
    // looked like a quiet fleet). applyTickOutcome increments the streak on error and
    // resets it on any other result, so the streak equals the threshold exactly once per
    // episode — the crossing — and re-warns only after a healthy tick re-armed it.
    if ((s.consecutiveErrors ?? 0) === ERROR_STREAK_WARN) {
      logEvent(this.root, {
        loop: this.role,
        type: "warning",
        message: `${s.consecutiveErrors} consecutive tick failures: ${s.lastError ?? "unknown error"}`,
      });
    }
    // One warning per quiet-kill episode (BUGS.md 2026-09-18): a loop burning an hour per
    // tick with no output must not look like a sleeping loop. applyTickOutcome grows the
    // streak on each kill and resets it on any other result, so the crossing fires once;
    // the give-up (fresh session + backoff) follows on the next kill.
    if ((s.quietKillStreak ?? 0) === QUIET_KILL_RESUME_LIMIT) {
      logEvent(this.root, {
        loop: this.role,
        type: "warning",
        message: `${s.quietKillStreak} consecutive quiet kills (no progress): ${s.lastError ?? "unknown hang"}`,
      });
    }
    // Per-tick usage (PLANS.md, per-tick-usage plan): the event feed is where operators see
    // spend — this tick's tokens and cost ride on tick_end so a budget pause or a money-burning
    // no_change/error/rejected/refused tick shows what it spent without diffing status-table
    // snapshots. Both fields are per-tick windows (reset above, folded in foldUsage over every
    // pi run of the tick); they ride on HarnessEvent's index signature like other payloads and
    // are omitted when zero so skipped ticks render byte-identical to a pre-feature line.
    logEvent(this.root, {
      loop: this.role,
      type: "tick_end",
      tick,
      result: outcome.result,
      summary: outcome.summary,
      error: s.lastError,
      ...(s.generatedTokens > 0 ? { tokens: s.generatedTokens } : {}),
      ...(this.tickCostUsd > 0 ? { costUsd: this.tickCostUsd } : {}),
    });
    return outcome;
  }

  private async runTick(): Promise<TickOutcome> {
    const s = this.state;
    s.lastError = undefined;

    // A tick interrupted by a harness shutdown left its pi session and its worktree's
    // uncommitted edits in place: resume that session instead of starting fresh. The flag
    // is consumed here so a resume that fails falls back to a normal fresh tick; another
    // shutdown mid-resume sets it again. Nothing to resume (sessions pruned, or pi never
    // started) also falls back to fresh.
    const resumableSession = s.resumePending === true && hasResumableSession(sessionDir(this.root, this.role));
    // Captured before the flag is consumed below; a stale cause must not leak into a later resume.
    const pendingResumeCause = s.resumeCause;
    s.resumePending = false;
    s.resumeCause = undefined;
    // An interruption during the review gate leaves the author's work fully committed — there
    // is nothing left to finish in its session. Recover (and re-review) the leftover commits
    // via a fresh tick instead: continuing the author session would burn a run on finished
    // work, and any uncommitted edits are the reviewer's stray output, discarded by the fresh
    // path's reset below.
    const resuming = resumableSession && s.phase !== "review";

    // Why the resume: a named quiet-kill means the last run died on a stalled tool call (the
    // bridge then warns against re-running it unchanged); a cut-off streak means the last run
    // ran out of context and pi compacted the session (the bridge asks for the smallest finish);
    // otherwise a shutdown/crash.
    const resumeCause =
      pendingResumeCause === "hung-tool" ? "hung-tool" : (s.cutOffStreak ?? 0) > 0 ? "cut-off" : "restart";
    const prompt = resuming ? buildResumePrompt(this.role, resumeCause) : this.tickPrompt();
    if (prompt === null) return { result: "skipped" };
    // The raw user prompt a director tick is executing (null for role loops), so an
    // unfulfilled outcome below can re-queue it. Captured before the field is cleared.
    const userPrompt = this.pendingUserPrompt;

    const wt = await ensureWorktree(this.root, this.role, this.mainBranch);
    if (resuming) {
      // Keep the interrupted run's uncommitted edits; clear only stray merge/rebase state.
      await abortSync(wt);
      logEvent(this.root, { loop: this.role, type: "resume", cause: resumeCause });
    } else {
      // Salvage a commit a previous tick left unlanded (src/leftover.ts): it re-lands through
      // the same lander as fresh ticks, so no crash or abort path smuggles unreviewed work into
      // main. Whatever recovery does, nothing is left on this branch — the leftover lives in
      // its landing ref + _land-<role> (or, unpinned, on the branch until it lands) — so the
      // reset below always runs and the red-main gate sees pristine main.
      const recovered = await recoverLeftover({
        root: this.root,
        role: this.role,
        mainBranch: this.mainBranch,
        wt,
        land: (sha, meta) =>
          this.land({
            role: this.role,
            sha,
            tick: s.ticks,
            summary: `recovered leftover work from ${this.role}`,
            body: meta.body,
            highFriction: meta.highFriction,
            sessionSuffix: "-recovery",
          }),
      });
      if (recovered === "aborted" && this.userAborted) {
        // A deliberate stop during recovery discards the pinned work — exactly like the tick's
        // own landing path. Keeping it would let next-tick recovery resurrect what the operator
        // explicitly killed (`tumwater abort`: "work discarded"). Shutdowns keep it: fail-closed
        // re-review is the point.
        await deleteRef(this.root, landingRefName(this.role));
      }
      await resetWorktreeToMain(wt, this.mainBranch);
      // Red-main baseline gate (src/main-red.ts): the worktree is pristine main right now —
      // verify main's own suite before spending an authoring run on top of it. Only roles whose
      // diff can carry code changes are blocked; resume ticks skip this by construction (their
      // worktree is not pristine main).
      const blocked = await mainRedGate(this.root, this.role, wt);
      if (blocked) return blocked;
    }

    const piStartedAt = Date.now();
    const pi = await this.runRolePi(wt, prompt, `tumwater-${this.role}-${s.ticks}`, resuming);
    // The `qa` observer's reply ends with a result-carrying `FLOW:` line (plans/observer-roles.md
    // 2/2). Extracted once here, recorded only at the success returns below — an interrupted or
    // failed tick must not advance the rotation. The harness records it, never pi.
    const flow = this.role === "qa" ? extractFlow(pi.finalText) : null;

    // A killed run (shutdown or timeout) may leave half-done edits; never commit those.
    // The next tick's reset discards them.
    if (pi.aborted) return this.finishAbortedTick(userPrompt, wt);
    this.pendingUserPrompt = null;
    if (pi.quietKilled) {
      // A hung tool call, not a slow run: the session and the worktree's edits are intact.
      // Preserve both — applyTickOutcome resumes them promptly like an interruption instead of
      // leaving hours of work for the next tick's reset to discard. Director ticks never resume;
      // their prompt goes back to the inbox to run fresh, as on any other unfulfilled kill.
      s.lastError = pi.errorMessage ?? "killed as hung";
      this.requeueUnfulfilledPrompt(userPrompt);
      return { result: "quiet_killed" };
    }
    if (pi.timedOut) {
      s.lastError = pi.errorMessage ?? "timed out";
      // The request never ran to completion and no work landed: put it back so the next
      // tick retries it. (A killed run's half-done edits are discarded by the reset.)
      this.requeueUnfulfilledPrompt(userPrompt);
      return { result: "error" };
    }

    // A refusal is a decision, not a failure: even when pi's exit was abnormal, the sentinel
    // and any note it left are the run's verdict — classify what it left behind (src/refusal.ts).
    if (pi.refused)
      return handleRefusal(
        {
          role: this.role,
          mainBranch: this.mainBranch,
          turns: this.tickTurns,
          merge: (w, sum) => this.merge(w, sum),
        },
        this.state,
        wt,
        pi,
      );

    const changed = await isDirty(wt);
    if (!pi.ok && !changed) {
      s.lastError = pi.errorMessage ?? "pi failed";
      // No work landed, so the request was not fulfilled: re-queue it. A no_change outcome
      // IS fulfillment (a question-type prompt answered without file changes) — never
      // re-queue that, or such prompts would loop forever.
      this.requeueUnfulfilledPrompt(userPrompt);
      return { result: "error" };
    }
    if (!changed) {
      // No sentinel anywhere in the reply is either non-compliance or truncation —
      // diagnoseNoChange (src/no-change.ts) tells which, so the warning event below is
      // diagnosable on its own.
      const diagnosis = diagnoseNoChange(pi);
      if (!pi.nothingToDo) {
        logEvent(this.root, {
          loop: this.role,
          type: "warning",
          message:
            `pi finished without changes and without declaring nothing-to-do` +
            (diagnosis.notes.length ? ` (${diagnosis.notes.join(", ")})` : ""),
        });
      }
      // A cut-off run did real work and was NOT fulfilled: a director prompt goes back
      // to the inbox to rerun fresh; a role loop resumes the just-compacted session
      // next tick (see the cutOff handling in tick()).
      if (diagnosis.cutOff) this.requeueUnfulfilledPrompt(userPrompt);
      if (flow)
        recordFlow(
          this.root,
          flow.flow,
          flow.result,
          flow.result === "bug" ? extractSummary(pi.finalText) ?? undefined : undefined,
        );
      return { result: "no_change", cutOff: diagnosis.cutOff || undefined };
    }

    // The commit subject and body come from the reply's closing block. A run that changed files
    // without one — a cut-off final message, or plain non-compliance — gets one bounded follow-up
    // turn in its own session to produce it (the session still holds everything the run did);
    // only if that too yields nothing is the subject derived from the changed paths.
    let summary = extractSummary(pi.finalText);
    let body = extractCommitBody(pi.finalText);
    if (summary === null) {
      const followUp = await this.requestSummary(wt);
      if (followUp?.aborted) return this.finishAbortedTick(userPrompt, wt);
      if (followUp) {
        summary = extractSummary(followUp.finalText);
        body = body ?? extractCommitBody(followUp.finalText);
      }
      if (summary === null) summary = fallbackSummary(await changedFiles(wt), this.role, s.ticks);
      logEvent(this.root, {
        loop: this.role,
        type: "warning",
        message:
          `reply had no SUMMARY line — ` +
          (followUp && extractSummary(followUp.finalText) !== null
            ? "recovered it with a follow-up turn"
            : `follow-up gave none; subject derived from the changed files: "${summary}"`),
      });
    }

    // Friction as a signal (plans/refusal-and-thrash.md): a changed tick that burned more than
    // thrashTurns turns or thrashMinutes of wall clock is flagged high-friction — difficulty
    // suggests the work may not fit, so it goes to review marked and leaves a warning event.
    // Measured over this tick's main authoring run (a transient retry included via runRolePi),
    // like the trailer; conflict-resolution runs happen later inside merge().
    const minutes = (Date.now() - piStartedAt) / 60_000;
    // Friction is measured over this tick's authoring runs only — the review gate folds its
    // run into tickTurns AFTER the commit, so every friction artifact (flag, warning event,
    // trailer line, final summary) reads this pre-gate snapshot instead of the live counter.
    const authoringTurns = this.tickTurns;
    const highFriction =
      authoringTurns > this.config.thrashTurns || minutes > this.config.thrashMinutes;
    if (highFriction) {
      logEvent(this.root, {
        loop: this.role,
        type: "warning",
        message:
          `high-friction tick: ${authoringTurns} turns in ${Math.round(minutes)} min ` +
          `(thresholds: ${this.config.thrashTurns} turns / ${this.config.thrashMinutes} min)`,
      });
    }
    // The trailer is harness-stamped truth: turns and peak ctx over this tick's pre-commit
    // runs only (conflict-resolution and review runs fold after the commit). A high-friction
    // tick appends its Friction line here — both values are already computed above.
    const message = buildCommitMessage(
      `tumwater(${this.role}): ${summary}`,
      body,
      commitTrailer(this.role, s.ticks, authoringTurns, s.peakContextTokens, highFriction ? minutes : undefined),
    );
    const commit = await commitAll(wt, message);

    // Pin the commit by its landing ref BEFORE freeing the worktree (invariant 4), then hand it
    // to the land queue: from here on the review gate and the rebase run in _land-<role>, never
    // in this worktree (plans/merge-queue.md 2/5). A failed pin defers to next-tick recovery —
    // landing without a pin would lose the ref lifecycle this whole flow depends on. The
    // reviewer checks the author's claimed WHY/VERIFIED against the actual diff; no diff reaches
    // main unreviewed.
    if (!(await this.pinAndReset(wt, commit))) {
      s.lastError = "failed to pin the landing ref; left for next-tick recovery";
      return { result: "error", summary: s.lastError };
    }

    // The commit is pinned and the worktree is free: enqueue the landing and END the tick — the
    // orchestrator drains the queue on its single landing slot, outside the author semaphore, so
    // this slot is free the moment the work is committed (plans/merge-queue.md 3/5). The landing
    // runs the same gate + landing flow through runLandingPi/foldLandingUsage on this same state
    // object — recording the commit count, the outcome, and the reviewer spend into it — and logs
    // landed/land_failed; a non-terminal outcome keeps the pin for next-tick leftover recovery.
    // `commits` was NOT incremented above: it counts landed changes only.
    enqueueLanding(this.root, {
      role: this.role,
      sha: commit,
      tick: s.ticks,
      summary,
      body: body ? formatCommitBody(body) : undefined,
      highFriction: highFriction || undefined,
      enqueuedAt: Date.now(),
    });
    logEvent(this.root, { loop: this.role, type: "land_queued", commit, summary });
    // The flag's durable record is the Friction trailer line stamped on the commit above;
    // lastSummary and the tick_end event carry it too for dashboards and logs.
    const finalSummary = highFriction
      ? `${summary} (high friction: ${authoringTurns} turns / ${Math.round(minutes)}m)`
      : summary;
    if (flow) recordFlow(this.root, flow.flow, flow.result, flow.result === "bug" ? summary : undefined);
    return { result: "queued", summary: finalSummary, commit, highFriction };
  }
}
