import type { TumwaterConfig } from "./config-schema.js";
import type { LoopState, PiRunResult, TickOutcome, TickResult } from "./types.js";
import { DIRECTOR_ROLE } from "./roles.js";
import { branchHead, isDirty, setRef } from "./git.js";
import { abortSync, ensureWorktree, resetWorktreeToMain } from "./worktree.js";
import { logEvent, warnEvent } from "./events.js";
import { hasResumableSession } from "./pi.js";
import { extractSummary } from "./commit-message.js";
import { buildResumePrompt } from "./prompt.js";
import { assembleTickPrompt } from "./tick-prompt.js";
import { buildConflictDiscardNote } from "./gate-prompts.js";
import { LoopPi } from "./loop-pi.js";

import { configForRole } from "./config-views.js";
import { applyConfigRequest } from "./config-write.js";
import { RETRIABLE_LANDING_RESULTS } from "./lander.js";
import { enqueueRolePrompt, takeQueuedPromptFile } from "./inbox.js";
import { stageTickLanding } from "./tick-stage.js";
import { ERROR_STREAK_WARN, QUIET_KILL_RESUME_LIMIT, applyTickOutcome, clearBackoff, loadLoopState, restoreMidTickWake, saveLoopState, zeroCounters } from "./state.js";
import { TickUsage } from "./tick-usage.js";
import { recoverLeftover, type LeftoverRecovery } from "./leftover.js";
import { bugfixMainRedNote, mainRedGate } from "./main-red.js";
import { mergeToMain } from "./merge.js";
import { diagnoseNoChange } from "./no-change.js";
import { handleRefusal, refusalContradiction } from "./refusal.js";
import { extractFlow } from "./reply-contract.js";
import { recordFlow } from "./qa-coverage.js";
import { landingRefName, sessionDir } from "./paths.js";
import { errorMessage, shortSha } from "./text.js";

/** One role loop: owns a persistent worktree + branch and runs one tick at a time. */
export class LoopRunner {
  state: LoopState;
  /** The current tumwater.json config. Not readonly on purpose: the orchestrator pushes a
   * freshly loaded config in here every poll cycle (live-reload), and every downstream read
   * goes through this, so one assignment steers provider/model/thinking/instructions,
   * tick intervals, backoff, and role enablement for subsequent ticks. */
  config: TumwaterConfig;
  /** The 429 observation from this loop's usage accounting (TickUsage.lastRateLimit,
   * src/tick-usage.ts): the orchestrator's fleet-wide 429-hold wiring reads it through the
   * runner (src/tick-timing.ts), so the field keeps its place on the runner's surface. */
  get lastRateLimit(): { at: number; retryAfterSeconds?: number } | undefined {
    return this.usage.lastRateLimit;
  }
  /** Per-tick and lifetime usage accounting (src/tick-usage.ts): the turns/cost windows the
   * commit trailer and tick_end event read, the lifetime totals folded into state, and the
   * 429 observation above. Grown through foldUsage — the once-per-run choke point. */
  private readonly usage = new TickUsage();
  /** The raw user prompt a director tick is executing, so an unfulfilled tick (abort,
   * timeout, or failure without changes) can re-queue it instead of losing the request. */
  private pendingUserPrompt: string | null = null;
  /** Per-tick abort controller, recreated at every tick start: `abortTick()` kills the
   * in-flight pi run without touching the harness shutdown signal (`this.signal`), which
   * would stop the whole fleet. */
  private tickAbort = new AbortController();
  /** Set by abortTick() when a user-initiated abort lands mid-tick: runTick's two abort
   * branches (author run, review gate) then diverge from shutdown semantics — worktree reset
   * to main, no director-prompt requeue, "user_aborted" result with normal backoff. Cleared
   * at the next tick start so a stale request can never leak into a later tick. */
  private userAborted = false;
  /** The landing failure this tick's leftover recovery is retrying, if any (a retriable lander
   * outcome that kept the pin, which recovery re-queued): set in finishRecoveryTick and
   * attached to the returned TickOutcome so applyTickOutcome can feed it into the error streak
   * even though the tick itself ends `queued` (BUGS.md 2026-09-21). Reset at every tick start. */
  private recoveryFailure?: string;
  /** This loop's pi-run plumbing (src/loop-pi.ts): shared per-run wiring, the transient
   * retry policy, and the SUMMARY follow-up. Host accessors are read live at every call, so
   * the orchestrator's config live-reload and the tick lifecycle need no notification path. */
  private readonly pi: LoopPi;

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
    this.state = loadLoopState(root, role);
    this.pi = new LoopPi({
      root: this.root,
      role: this.role,
      config: () => this.config,
      signal: this.signal,
      runSignal: () => this.runSignal(),
      warn: (message) => this.warn(message),
      foldUsage: (run) => this.foldUsage(run),
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

  /** The signal every pi run of the current tick watches: harness shutdown OR a per-tick user
   * abort (Node ≥ 20's AbortSignal.any). */
  private runSignal(): AbortSignal {
    return this.signal ? AbortSignal.any([this.signal, this.tickAbort.signal]) : this.tickAbort.signal;
  }

  /** Decide the prompt for this tick, or null to skip (director with empty inbox). */
  /** Assemble this tick's prompt via src/tick-prompt.ts (the prompt-content concern lives
   * there); the dequeued user request — the director's, or a per-role one — rides back so the
   * runner records it as pending — re-queued if the tick ends without fulfilling it. Null when
   * the loop has nothing to run (an empty director inbox); a role loop's assembly never
   * returns null. */
  private tickPrompt(): string | null {
    const assembled = assembleTickPrompt({ root: this.root, config: this.config, role: this.role, state: this.state });
    if (assembled === null) return null;
    if (assembled.userPrompt !== null) this.pendingUserPrompt = assembled.userPrompt;
    return assembled.prompt;
  }

  /** Put an unfulfilled user prompt back in the queue it came from so the next tick retries it
   * — the one place that policy lives, shared by every outcome that leaves the request undone
   * (abort, timeout, failure without changes, review abort, context-ceiling cut-off, red-main
   * gate). The queue is the role's own (the director's historical inbox for the director), so a
   * re-queued per-role request never leaks across loops. A fulfilled no_change never reaches
   * here: re-queueing it would loop the prompt forever. */
  private requeueUnfulfilledPrompt(userPrompt: string | null): void {
    if (userPrompt) enqueueRolePrompt(this.root, this.role, userPrompt);
  }

  /** Re-queue an unfulfilled prompt whose pi session the next tick will resume: the resumed
   * session still owns the request in its (compacted) context, so the re-queued copy is only
   * the durable store for a restart — the resume must reclaim exactly it as its own user
   * prompt (the resume's fulfillment consumes it; only its failure paths re-queue it) instead
   * of leaving it queued for a later fresh tick to run the same request twice. The queue file
   * is recorded so the reclaim takes that exact prompt whatever else was enqueued meanwhile.
   * Director ticks never resume — their re-queued prompt always reruns fresh — so they take
   * the plain path. */
  private requeuePromptForResume(userPrompt: string | null): void {
    if (!userPrompt) return;
    if (this.role === DIRECTOR_ROLE) {
      this.requeueUnfulfilledPrompt(userPrompt);
      return;
    }
    this.state.resumePromptFile = enqueueRolePrompt(this.root, this.role, userPrompt);
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
    // run its half-done edits are discarded by the next tick's reset). A role's re-queued
    // prompt rides the resume that follows (mid-review the fresh recovery dequeues it like any
    // other tick instead — the flag is cleared and never reclaimed there).
    this.requeuePromptForResume(userPrompt);
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
        config: this.config,
        tick: this.state.ticks,
        runPi: (w, prompt, sessionName) => this.pi.runRolePi(w, prompt, sessionName),
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
      this.warn(
        `failed to pin ${shortSha(sha)} by its landing ref — leaving the commit on the branch for next-tick recovery`,
      );
      return false;
    }
    await resetWorktreeToMain(wt, this.mainBranch);
    return true;
  }

  /** End a tick whose leftover recovery found work to salvage (src/leftover.ts) without an
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
    recovered: Exclude<LeftoverRecovery, { kind: "discarded" }>,
    userPrompt: string | null,
    wt: string,
    priorLandingFailure: string | undefined,
  ): Promise<TickOutcome> {
    this.pendingUserPrompt = null;
    this.requeueUnfulfilledPrompt(userPrompt);
    if (recovered.kind === "unpinned") {
      this.state.lastError = `failed to pin leftover ${shortSha(recovered.sha)} by its landing ref; left for next-tick recovery`;
      return { result: "error", summary: this.state.lastError, recoveredLeftover: true };
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
   * accounting itself lives in TickUsage.fold (src/tick-usage.ts); this keeps the once-per-run
   * choke point and the foldLandingUsage face on the runner, where LoopPi and the landing
   * wiring (src/landing-slot.ts) reach them. */
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
   * ReviewContext.tick; merge.ts keeps its conflict-resolver naming through LanderContext.runPi).
   * The plumbing itself lives in src/loop-pi.ts; this is the landing slot's public face. */
  async runLandingPi(wt: string, prompt: string, sessionName: string): Promise<PiRunResult> {
    return this.pi.runLandingPi(wt, prompt, sessionName);
  }

  /** Public face of foldUsage for the orchestrator's landing wiring: folds a landing pi run
   * (reviewer, conflict resolution) into the AUTHORING role's counters, so the fleet's daily
   * cost and the per-role usage windows attribute that spend to the role that authored the
   * work — no new counter semantics, just the same fold loop.ts applies to its tick runs. */
  foldLandingUsage(run: PiRunResult): void {
    this.foldUsage(run);
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
    this.usage.reset();
    this.recoveryFailure = undefined;
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
      // An exception between the dequeue/reclaim and the pi run leaves the request only in
      // the pending field — memory this failed tick is about to drop, with no outcome handler
      // left to re-queue it (the handlers run inside runTick, after the pi run). The queue is
      // the durable store, so the catch re-queues whatever is still pending, like every
      // unfulfilled outcome does; it is always null once a pi run has been accounted for.
      this.requeueUnfulfilledPrompt(this.pendingUserPrompt);
      this.pendingUserPrompt = null;
    }
    // A re-queued leftover's landing failure is not the tick's own result, so it rides the
    // outcome separately: applyTickOutcome feeds it into the error streak, and the warning
    // below names it — even though runTick cleared `lastError` so it never latched onto
    // `tick_end` (BUGS.md 2026-09-21).
    if (this.recoveryFailure !== undefined) outcome.recoveryFailure = this.recoveryFailure;

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
    // A wake consumed while this tick ran stamped the shared state in place, but the outcome
    // schedule above overwrites it (lastTickEndedAt past wokenAt, nextRunAt a fresh gap or
    // backoff out), so a plain `tumwater wake --role` with an empty queue would silently wait
    // out the whole interval (BUGS.md 2026-09-25). Re-apply it here — exactly like a wake
    // arriving one poll after the tick ended.
    restoreMidTickWake(s);
    this.save();
    // One warning per error episode (BUGS.md 2026-09-15: every loop failing identically
    // looked like a quiet fleet). applyTickOutcome increments the streak on error and
    // resets it on any other result, so the streak equals the threshold exactly once per
    // episode — the crossing — and re-warns only after a healthy tick re-armed it.
    if ((s.consecutiveErrors ?? 0) === ERROR_STREAK_WARN) {
      this.warn(
        `${s.consecutiveErrors} consecutive tick failures: ` +
          `${s.lastError ?? outcome.recoveryFailure ?? "unknown error"}`,
      );
    }
    // One warning per quiet-kill episode (BUGS.md 2026-09-18): a loop burning an hour per
    // tick with no output must not look like a sleeping loop. applyTickOutcome grows the
    // streak on each kill and resets it on any other result, so the crossing fires once;
    // the give-up (fresh session + backoff) follows on the next kill.
    if ((s.quietKillStreak ?? 0) === QUIET_KILL_RESUME_LIMIT) {
      this.warn(`${s.quietKillStreak} consecutive quiet kills (no progress): ${s.lastError ?? "unknown hang"}`);
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
      ...(this.usage.costUsd > 0 ? { costUsd: this.usage.costUsd } : {}),
    });
    return outcome;
  }

  private async runTick(): Promise<TickOutcome> {
    const s = this.state;
    // The last landing's failure, read before the clear below: a landing that failed
    // non-terminally kept its pin (the lander's own vocabulary — review_error, merge_conflict,
    // merge_blocked — with the detail it wrote into `lastError`), and when this tick's recovery
    // re-queues that pin, the failure must still feed the error streak (finishRecoveryTick).
    const priorLandingFailure =
      s.lastResult !== undefined && RETRIABLE_LANDING_RESULTS.has(s.lastResult)
        ? (s.lastError ?? `landing failed: ${s.lastResult}`)
        : undefined;
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
    // Reclaim the prompt the interrupted tick re-queued (requeuePromptForResume): the resumed
    // session still owns that request in its context, so this tick's outcome bookkeeping —
    // re-queue on unfulfilled, clear on fulfillment — must operate on the queue's copy, or a
    // fulfilling resume leaves it queued for a later fresh tick to run the same request twice.
    // The exact recorded file is taken, so an enqueue or cancel meanwhile cannot divert the
    // reclaim; a vanished file (cancelled) reclaims nothing. The flag is consumed even when
    // this tick does not resume: a fresh fallback re-derives its prompt from the queue like
    // any other tick, and a stale record must never survive into a later resume.
    const reclaimFile = s.resumePromptFile;
    s.resumePromptFile = undefined;
    if (resuming && reclaimFile) {
      const reclaimed = takeQueuedPromptFile(reclaimFile);
      if (reclaimed !== null) this.pendingUserPrompt = reclaimed;
    }

    // Why the resume: a named quiet-kill means the last run died on a stalled tool call (the
    // bridge then warns against re-running it unchanged); a cut-off streak means the last run
    // ran out of context and pi compacted the session (the bridge asks for the smallest finish);
    // otherwise a shutdown/crash.
    const resumeCause =
      pendingResumeCause === "hung-tool" ? "hung-tool" : (s.cutOffStreak ?? 0) > 0 ? "cut-off" : "restart";
    let prompt = resuming ? buildResumePrompt(this.role, resumeCause) : this.tickPrompt();
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
      // Salvage a commit a previous tick left unlanded (src/leftover.ts): recovery puts it back
      // on the land queue, so it lands through the orchestrator's landing pipeline — the same
      // gate as a fresh tick's change, and main keeps exactly one writer (an in-tick recovery
      // landing raced the slot's batches into `merge_blocked`). A salvaged leftover ENDS the
      // tick: the role holds one landing ref, and the leftover owns it until its landing
      // resolves. With nothing to salvage the branch holds nothing either, so the reset below
      // leaves pristine main for the red-main gate.
      const recovered = await recoverLeftover({
        root: this.root,
        role: this.role,
        mainBranch: this.mainBranch,
        tick: s.ticks,
        wt,
        mergeConflicts: s.mergeConflicts,
      });
      if (recovered?.kind === "discarded") {
        // The pin hit the conflict cap and is gone: nothing holds the role any more, so this
        // tick authors on a fresh main like any other — told what was dropped and why.
        s.mergeConflicts = undefined;
        s.conflictDiscard = { sha: recovered.sha, summary: recovered.summary, attempts: recovered.attempts, at: Date.now() };
        prompt += `\n\n${buildConflictDiscardNote(recovered.summary, recovered.attempts)}`;
      } else if (recovered) return this.finishRecoveryTick(recovered, userPrompt, wt, priorLandingFailure);
      await resetWorktreeToMain(wt, this.mainBranch);
      // Red-main baseline gate (src/main-red.ts): the worktree is pristine main right now —
      // verify main's own suite before spending an authoring run on top of it. Only roles whose
      // diff can carry code changes are blocked; resume ticks skip this by construction (their
      // worktree is not pristine main). The `bugfix` healer is exempt because its fix is the
      // fleet's only way back to green, so instead of blocking it we hand it the failure (PLANS.md
      // "Red-main handoff"): the same check runs, but a red main appends a <main-red> note to
      // this tick's prompt so it reproduces and fixes that failure rather than hunting blind.
      if (this.role === "bugfix") {
        const note = await bugfixMainRedNote(this.root, this.role, wt);
        if (note) prompt += `\n\n${note}`;
      } else {
        const blocked = await mainRedGate(this.root, this.role, wt);
        if (blocked) {
          // The dequeued prompt never ran: put it back in its queue before returning, so it is
          // not lost to a restart (the pending field is memory-only) or dropped by the next
          // tick's outcome handling — the queue is the durable store, and once main is green
          // the next tick dequeues it again (PLANS.md "Per-role prompts 1/2" criterion b).
          this.requeueUnfulfilledPrompt(userPrompt);
          this.pendingUserPrompt = null;
          return blocked;
        }
      }
    }

    const piStartedAt = Date.now();
    const pi = await this.pi.runRolePi(wt, prompt, `tumwater-${this.role}-${s.ticks}`, resuming);
    // The `qa` observer's reply ends with a result-carrying `FLOW:` line (plans/observer-roles.md
    // 2/2). Extracted once here, recorded only at the success returns below — an interrupted or
    // failed tick must not advance the rotation. The harness records it, never pi.
    const flow = this.role === "qa" ? extractFlow(pi.finalText) : null;

    // A killed run (shutdown or timeout) may leave half-done edits; never commit those.
    // The next tick's reset discards them.
    if (pi.aborted) return this.finishAbortedTick(userPrompt, wt);
    this.pendingUserPrompt = null;
    // Harness-mediated config writes (plans/portability.md §3/7): the director may have left a
    // config request in its worktree. Consume it here — after the abort return (a deliberate
    // abort still discards an unfulfilled request) and before every staging path (quiet-kill,
    // timeout, refusal, isDirty, commitAll) — so the request file never enters a diff or a
    // review prompt, and a quiet-killed/timeout re-run starts clean instead of losing the
    // request to the reset. Applied names are announced by the orchestrator's ~2 s live reload
    // (one config_changed event naming the keys); this tick logs only the rejection paths.
    if (this.role === DIRECTOR_ROLE) {
      const request = applyConfigRequest(this.root, wt);
      if (request) {
        if (request.error) this.warn(`config request rejected: ${request.error}`);
        if (request.ignored.length)
          this.warn(
            `config request ignored key(s): ${request.ignored.join(", ")} — only customLoops is accepted`,
          );
      }
    }
    if (pi.quietKilled) {
      // A hung tool call, not a slow run: the session and the worktree's edits are intact.
      // Preserve both — applyTickOutcome resumes them promptly like an interruption instead of
      // leaving hours of work for the next tick's reset to discard. Director ticks never resume;
      // their prompt goes back to the inbox to run fresh, as on any other unfulfilled kill.
      s.lastError = pi.errorMessage ?? "killed as hung";
      this.requeuePromptForResume(userPrompt);
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
    if (pi.refused) {
      // A refusal contradicted by its own reply — a SUMMARY beside non-markdown work — is
      // surfaced, not obeyed: the work is finished output a discard would destroy, so the
      // normal flow keeps it and the review gate judges it (BUGS.md 2026-09-23).
      const contradicted = await refusalContradiction(wt, pi.finalText);
      if (contradicted.length > 0) {
        this.warn(
          `refusal contradicted by its own reply: SUMMARY beside non-markdown work ` +
            `(${contradicted.slice(0, 3).join(", ")}) — keeping the work; the normal flow judges it`,
        );
      } else {
        return handleRefusal(
          {
            role: this.role,
            mainBranch: this.mainBranch,
            turns: this.usage.turns,
            merge: (w, sum) => this.merge(w, sum),
          },
          this.state,
          wt,
          pi,
        );
      }
    }

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
        this.warn(
          `pi finished without changes and without declaring nothing-to-do` +
            (diagnosis.notes.length ? ` (${diagnosis.notes.join(", ")})` : ""),
        );
      }
      // A cut-off run did real work and was NOT fulfilled: a director prompt goes back
      // to the inbox to rerun fresh; a role loop resumes the just-compacted session
      // next tick (see the cutOff handling in tick()).
      if (diagnosis.cutOff) this.requeuePromptForResume(userPrompt);
      // A cut-off run did real work but was truncated before declaring its outcome: the FLOW
      // line it left mid-stream is not a finished verdict, so recording it would advance the
      // rotation past a check that did not complete. Only a run that was not cut off records.
      if (flow && !diagnosis.cutOff)
        recordFlow(
          this.root,
          flow.flow,
          flow.result,
          flow.result === "bug" ? extractSummary(pi.finalText) ?? undefined : undefined,
        );
      return { result: "no_change", cutOff: diagnosis.cutOff || undefined };
    }

    // The commit is pinned and the worktree is free (src/tick-stage.ts): stage it for the
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
      state: s,
      config: this.config,
      tickTurns: this.usage.turns,
      userPrompt,
      wt,
      finalText: pi.finalText,
      flow,
      piStartedAt,
      warn: (message) => this.warn(message),
      requestSummary: (w) => this.pi.requestSummary(w),
      pinAndReset: (w, sha) => this.pinAndReset(w, sha),
      finishAbortedTick: () => this.finishAbortedTick(userPrompt, wt),
    });
  }
}
