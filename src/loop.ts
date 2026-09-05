import type { TumwaterConfig, LoopState, PiRunResult, TickOutcome, TickResult } from "./types.js";
import { DIRECTOR_ROLE, roleById } from "./roles.js";
import {
  abortSync,
  commitAll,
  ensureWorktree,
  git,
  gitTry,
  isDirty,
  resetWorktreeToMain,
} from "./git.js";
import { logEvent } from "./events.js";
import { hasResumableSession, runPi } from "./pi.js";
import {
  buildCommitMessage,
  commitTrailer,
  extractCommitBody,
  extractSummary,
  formatCommitBody,
} from "./commit-message.js";
import {
  buildDirectorPrompt,
  buildRejectedReviewNote,
  buildResumePrompt,
  buildTickPrompt,
  readPrinciples,
} from "./prompt.js";
import { readInitialPrompt } from "./readme.js";
import { configForRole } from "./config.js";
import { reviewAheadOfMain, type GateResult } from "./review.js";
import { dequeuePrompt, enqueuePrompt } from "./inbox.js";
import { applyTickOutcome, loadLoopState, recordDailyCost, saveLoopState, zeroCounters } from "./state.js";
import { recoverLeftover } from "./leftover.js";
import { mergeToMain } from "./merge.js";
import { diagnoseNoChange } from "./no-change.js";
import { handleRefusal } from "./refusal.js";
import { piLogPath, sessionDir } from "./paths.js";

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
      const role = roleById(this.role);
      if (!role) throw new Error(`unknown role: ${this.role}`);
      prompt = buildTickPrompt({
        role,
        initialPrompt,
        principles,
        extraInstructions: this.config.roles[this.role]?.instructions,
      });
    }
    // A change rejected in review is the only cross-tick memory of what was built and why it
    // failed — every tick starts a fresh session, so the full reasons ride along on the next
    // prompt until the role's next reviewed change replaces them.
    if (this.state.lastReview?.verdict === "reject") {
      prompt += `\n\n${buildRejectedReviewNote(this.state.lastReview.reasons)}`;
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

  /** Land the worktree branch on main (see src/merge.ts for the rebase → ff-merge → conflict-
   * retry flow): delegates with this loop's identity, tick number, and shared pi wiring so a
   * conflict-resolution run folds into this tick's counters like any other pi run. */
  private async merge(wt: string, summary: string): Promise<TickResult> {
    return mergeToMain(
      {
        root: this.root,
        role: this.role,
        mainBranch: this.mainBranch,
        tick: this.state.ticks,
        runPi: (w, prompt, sessionName) => this.runRolePi(w, prompt, sessionName),
      },
      wt,
      summary,
    );
  }

  /** Fold one pi run's usage into the tick's counters (gen / peak ctx / cost / turns). Every
   * pi run of a tick — main attempt, transient-timeout retry, conflict resolution — lands here
   * exactly once, so adding a usage field to PiRunResult touches this single place. */
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
  private async runRolePi(
    wt: string,
    prompt: string,
    sessionName: string,
    resume = false,
  ): Promise<PiRunResult> {
    const opts = {
      cwd: wt,
      prompt,
      config: configForRole(this.config, this.role),
      sessionDir: sessionDir(this.root, this.role),
      sessionName,
      continueSession: resume,
      rawLogFile: piLogPath(this.root, this.role),
      signal: this.runSignal(),
    };
    const pi = await runPi(opts);
    if (!pi.aborted && !pi.timedOut && pi.transientServerTimeout && !pi.ok) {
      logEvent(this.root, {
        loop: this.role,
        type: "warning",
        message:
          "model server timed out an idle predict stream (e.g. machine sleep) — retrying the pi run once",
      });
      // Within-tick continuity only: resume the session the first attempt created, so its
      // partial progress is not re-done. The next tick still starts fresh.
      const retry = await runPi({ ...opts, continueSession: true });
      this.foldUsage(pi);
      this.foldUsage(retry);
      return retry;
    }
    this.foldUsage(pi);
    return pi;
  }

  /** Run the adversarial review gate over everything ahead of main in `wt` (see
   * src/review.ts for exemption, verdict parsing, and failure policy). `commitBody` is the
   * author's claimed WHY/RISK/VERIFIED — the reviewer checks it against the diff.
   * `highFriction` flags a change whose authoring run burned more than the configured
   * turn/time thresholds; the flag rides along in the review prompt for extra scrutiny. */
  private async reviewGate(
    wt: string,
    summary?: string,
    commitBody?: string,
    sessionSuffix?: string,
    highFriction?: boolean,
  ): Promise<GateResult> {
    return reviewAheadOfMain(
      {
        root: this.root,
        role: this.role,
        wt,
        mainBranch: this.mainBranch,
        config: this.config,
        tick: this.state.ticks,
        sessionSuffix,
        signal: this.runSignal(),
      },
      this.state,
      summary,
      commitBody,
      highFriction,
    );
  }

  /** Run one full tick of this role loop: build (or resume) the prompt, run pi in the
   * worktree, commit and merge any changes it made, then schedule the next run from the
   * outcome — changed/skipped/cut-off ticks wait at least the minimum interval, an aborted
   * one resumes promptly on restart, everything else backs off. Never throws: a failed tick
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
      s.lastError = err instanceof Error ? err.message : String(err);
    }

    // Read main's current head while this tick is still reserved (running=true): the
    // applyTickOutcome below clears running, and a poll landing between that clear and a later
    // head update would see a stale lastMainHead and wake the loop again on the very move
    // that triggered this tick — a duplicate wake event plus an extra tick for one world change.
    s.lastMainHead = (await gitTry(this.root, "rev-parse", this.mainBranch)) ?? s.lastMainHead;
    // Record the outcome on state and schedule the next run (see src/state.ts for the
    // per-result policy: prompt retry, backoff, bounded cut-off resumes).
    applyTickOutcome(s, cfg, this.role, outcome);
    this.save();
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
    s.resumePending = false;
    // An interruption during the review gate leaves the author's work fully committed — there
    // is nothing left to finish in its session. Recover (and re-review) the leftover commits
    // via a fresh tick instead: continuing the author session would burn a run on finished
    // work, and any uncommitted edits are the reviewer's stray output, discarded by the fresh
    // path's reset below.
    const resuming = resumableSession && s.phase !== "review";

    const prompt = resuming ? buildResumePrompt(this.role) : this.tickPrompt();
    if (prompt === null) return { result: "skipped" };
    // The raw user prompt a director tick is executing (null for role loops), so an
    // unfulfilled outcome below can re-queue it. Captured before the field is cleared.
    const userPrompt = this.pendingUserPrompt;

    const wt = await ensureWorktree(this.root, this.role, this.mainBranch);
    if (resuming) {
      // Keep the interrupted run's uncommitted edits; clear only stray merge/rebase state.
      await abortSync(wt);
      logEvent(this.root, { loop: this.role, type: "resume" });
    } else {
      // Salvage commits a previous run's merge never landed (src/leftover.ts): they route
      // through the same review gate as fresh ticks, with this loop's shared wiring.
      const leftForRetry = await recoverLeftover(
        {
          root: this.root,
          role: this.role,
          mainBranch: this.mainBranch,
          reviewGate: (w) => this.reviewGate(w, undefined, undefined, "-recovery"),
          foldUsage: (run) => this.foldUsage(run),
          merge: (w, sum) => this.merge(w, sum),
        },
        wt,
      );
      if (leftForRetry) {
        // A failed (or aborted) recovery review deliberately left its commit on the branch for
        // re-review — bounded by the gate's strike cap. Keep it; discard only uncommitted stray
        // edits so the next tick reviews the combined ahead-of-main diff.
        await abortSync(wt);
        await git(wt, "reset", "--hard", "HEAD");
        await git(wt, "clean", "-fd");
      } else {
        await resetWorktreeToMain(wt, this.mainBranch);
      }
    }

    const piStartedAt = Date.now();
    const pi = await this.runRolePi(wt, prompt, `tumwater-${this.role}-${s.ticks}`, resuming);

    // A killed run (shutdown or timeout) may leave half-done edits; never commit those.
    // The next tick's reset discards them.
    if (pi.aborted) return this.finishAbortedTick(userPrompt, wt);
    this.pendingUserPrompt = null;
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
      return { result: "no_change", cutOff: diagnosis.cutOff || undefined };
    }

    const summary = extractSummary(pi.finalText) ?? `${this.role} tick ${s.ticks}`;
    // The commit body is the author's own explanation (WHY/RISK/VERIFIED, capped per field);
    // null or partial when the reply was non-compliant — subject + trailer still stand.
    const body = extractCommitBody(pi.finalText);

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

    // Adversarial review gate (src/review.ts): no diff reaches main unreviewed. Runs outside
    // the merge lock, before it — other loops keep merging while this one is under review.
    // The reviewer checks the author's claimed WHY/VERIFIED against the actual diff.
    const gate = await this.reviewGate(
      wt,
      summary,
      body ? formatCommitBody(body) : undefined,
      undefined,
      highFriction || undefined,
    );
    if (gate.run) this.foldUsage(gate.run);
    if (gate.aborted) return this.finishAbortedTick(userPrompt, wt);
    if (gate.decision === "rejected") {
      // The gate already reset the branch to main; its reasons ride along on this role's next
      // tick prompt via state.lastReview (see tickPrompt).
      return { result: "rejected", summary: gate.detail ?? "rejected in review" };
    }
    if (gate.decision === "failed") {
      // Fail closed: the commit stays on the branch for the next tick's recovery re-review
      // (bounded by the gate's strike cap). Backoff applies as for errors.
      s.lastError = `review failed: ${gate.detail}`;
      return { result: "review_error", summary: gate.detail };
    }

    const result = await this.merge(wt, summary);
    if (result !== "changed") s.lastError = `merge failed: ${result}`;
    // The flag's durable record is the Friction trailer line stamped on the commit above;
    // lastSummary and the tick_end event carry it too for dashboards and logs.
    const finalSummary = highFriction
      ? `${summary} (high friction: ${authoringTurns} turns / ${Math.round(minutes)}m)`
      : summary;
    return { result, summary: finalSummary, commit, highFriction };
  }
}
