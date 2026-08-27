import type { TumwaterConfig, LoopState, PiRunResult, TickResult } from "./types.js";
import { DIRECTOR_ROLE, roleById } from "./roles.js";
import {
  abortSync,
  aheadOfMain,
  commitAll,
  conflictedFiles,
  continueRebase,
  ensureWorktree,
  ffMergeToMain,
  gitTry,
  hasConflictMarkers,
  headOf,
  isDirty,
  rebaseOntoMain,
  rebaseOntoMainLeaveConflicts,
  resetWorktreeToMain,
} from "./git.js";
import { withLock } from "./lock.js";
import { logEvent } from "./events.js";
import { hasResumableSession, runPi } from "./pi.js";
import {
  buildConflictPrompt,
  buildDirectorPrompt,
  buildResumePrompt,
  buildTickPrompt,
  extractSummary,
  readPrinciples,
} from "./prompt.js";
import { readInitialPrompt } from "./readme.js";
import { configForRole } from "./config.js";
import { dequeuePrompt, enqueuePrompt } from "./inbox.js";
import { loadLoopState, nextBackoffSeconds, saveLoopState, zeroCounters } from "./state.js";
import { mergeLockDir, piLogPath, sessionDir } from "./paths.js";

export interface TickOutcome {
  result: TickResult;
  summary?: string;
  commit?: string;
}

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
   * the next tick's save would resurrect the pre-reset values on disk. */
  resetCounters(): void {
    this.state = zeroCounters(this.state);
    this.save();
  }

  /** Decide the prompt for this tick, or null to skip (director with empty inbox). */
  private tickPrompt(): string | null {
    const initialPrompt = readInitialPrompt(this.root);
    // The project's design principles ride along in every prompt — tick and director alike — so
    // all loops share one standard of taste. Empty when the repo has no PRINCIPLES.md.
    const principles = readPrinciples(this.root);
    if (this.role === DIRECTOR_ROLE) {
      const userPrompt = dequeuePrompt(this.root);
      if (!userPrompt) return null;
      this.pendingUserPrompt = userPrompt;
      return buildDirectorPrompt(userPrompt, initialPrompt, principles);
    }
    const role = roleById(this.role);
    if (!role) throw new Error(`unknown role: ${this.role}`);
    return buildTickPrompt({
      role,
      initialPrompt,
      principles,
      extraInstructions: this.config.roles[this.role]?.instructions,
    });
  }

  /** Land the worktree branch on main under the shared merge lock: rebase it onto main
   * (keeping history linear) and fast-forward. On conflict, makes one pi-driven resolution
   * attempt (outside the lock) before giving up. A routine conflict is normal operation,
   * not a warning: success lands as an ordinary `merged` event and failure surfaces via the
   * tick's merge_conflict result — no separate log line for the hand-off itself. */
  private async merge(wt: string, summary: string): Promise<TickResult> {
    const first = await this.tryMerge(wt, summary);
    if (first !== "merge_conflict") return first;
    if (!(await this.resolveConflict(wt))) return "merge_conflict";
    return this.tryMerge(wt, summary);
  }

  private async tryMerge(wt: string, summary: string): Promise<TickResult> {
    return withLock(mergeLockDir(this.root), async () => {
      if (!(await rebaseOntoMain(wt, this.mainBranch))) return "merge_conflict";
      if (!(await ffMergeToMain(this.root, this.role, this.mainBranch))) return "merge_blocked";
      const commit = await headOf(this.root, this.mainBranch);
      logEvent(this.root, { loop: this.role, type: "merged", commit, summary });
      return "changed";
    });
  }

  /** Fold one pi run's usage into the tick's counters (gen / peak ctx / cost). Every pi
   * run of a tick — main attempt, transient-timeout retry, conflict resolution — lands here
   * exactly once, so adding a usage field to PiRunResult touches this single place. */
  private foldUsage(run: PiRunResult): void {
    const s = this.state;
    s.generatedTokens += run.outputTokens;
    s.peakContextTokens = Math.max(s.peakContextTokens, run.peakContextTokens);
    s.totalCostUsd += run.costUsd;
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
      signal: this.signal,
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

  /** Re-run the conflicting rebase leaving markers in place, let pi resolve them, and
   * continue the rebase. Returns true when the branch now sits cleanly on top of main. */
  private async resolveConflict(wt: string): Promise<boolean> {
    const state = await rebaseOntoMainLeaveConflicts(wt, this.mainBranch);
    if (state === "clean") return true;
    if (state === "failed") return false;
    const files = await conflictedFiles(wt);
    const pi = await this.runRolePi(
      wt,
      buildConflictPrompt(this.role, files),
      `tumwater-${this.role}-${this.state.ticks}-conflict`,
    );
    if (!pi.ok || hasConflictMarkers(wt, files)) {
      await abortSync(wt);
      return false;
    }
    try {
      await continueRebase(wt);
    } catch {
      // The rebase stopped again — a second conflict, only possible when pi itself
      // authored extra commits during the tick. One resolution attempt per tick.
      await abortSync(wt);
      return false;
    }
    return true;
  }

  /** Salvage commits left on the branch by a previous run whose merge never landed. */
  private async recoverLeftover(wt: string): Promise<void> {
    const ahead = await aheadOfMain(wt, this.mainBranch).catch(() => 0);
    if (ahead <= 0) return;
    const result = await this.merge(wt, `recovered leftover work from ${this.role}`);
    if (result !== "changed") {
      logEvent(this.root, {
        loop: this.role,
        type: "warning",
        message: `discarding ${ahead} unmergeable leftover commit(s) (${result})`,
      });
    }
  }

  async tick(): Promise<TickOutcome> {
    const s = this.state;
    s.ticks += 1;
    // gen / peak ctx are per-tick windows, not lifetime totals (user decision 2026-08-25):
    // reset before the start-of-tick save so a working loop's columns grow live from 0 and
    // an idle loop's show its last completed tick. runRolePi accumulates every pi run of
    // this tick (main + transient-timeout retry + conflict resolution) into them, and the
    // end-of-tick save persists the finished run's totals.
    s.generatedTokens = 0;
    s.peakContextTokens = 0;
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

    s.running = false;
    s.lastTickEndedAt = Date.now();
    s.lastResult = outcome.result;
    if (outcome.summary) s.lastSummary = outcome.summary;
    if (outcome.result === "changed") {
      s.commits += 1;
      s.backoffSeconds = 0;
      s.nextRunAt = Date.now() + this.config.minTickIntervalSeconds * 1000;
    } else if (outcome.result === "skipped") {
      // Director idles until the inbox has work; no backoff bookkeeping.
      s.nextRunAt = Date.now() + this.config.minTickIntervalSeconds * 1000;
    } else if (outcome.result === "aborted") {
      // Shutdown, not a verdict about the project: resume promptly on restart. The pi
      // session and the worktree's uncommitted edits were left in place, so the next tick
      // picks up exactly where this one was interrupted (director ticks instead re-queue
      // their user prompt, which runs fresh).
      if (this.role !== DIRECTOR_ROLE) s.resumePending = true;
      s.nextRunAt = Date.now();
    } else {
      s.backoffSeconds = nextBackoffSeconds(s.backoffSeconds, this.config);
      s.nextRunAt = Date.now() + s.backoffSeconds * 1000;
    }
    s.lastMainHead = (await gitTry(this.root, "rev-parse", this.mainBranch)) ?? s.lastMainHead;
    this.save();
    logEvent(this.root, {
      loop: this.role,
      type: "tick_end",
      tick,
      result: outcome.result,
      summary: outcome.summary,
      error: s.lastError,
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
    const resuming = s.resumePending === true && hasResumableSession(sessionDir(this.root, this.role));
    s.resumePending = false;

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
      await this.recoverLeftover(wt);
      await resetWorktreeToMain(wt, this.mainBranch);
    }

    const pi = await this.runRolePi(wt, prompt, `tumwater-${this.role}-${s.ticks}`, resuming);

    // A killed run (shutdown or timeout) may leave half-done edits; never commit those.
    // The next tick's reset discards them.
    if (pi.aborted) {
      if (userPrompt) enqueuePrompt(this.root, userPrompt);
      return { result: "aborted" };
    }
    this.pendingUserPrompt = null;
    if (pi.timedOut) {
      s.lastError = pi.errorMessage ?? "timed out";
      // The request never ran to completion and no work landed: put it back so the next
      // tick retries it. (A killed run's half-done edits are discarded by the reset.)
      if (userPrompt) enqueuePrompt(this.root, userPrompt);
      return { result: "error" };
    }

    const changed = await isDirty(wt);
    if (!pi.ok && !changed) {
      s.lastError = pi.errorMessage ?? "pi failed";
      // No work landed, so the request was not fulfilled: re-queue it. A no_change outcome
      // IS fulfillment (a question-type prompt answered without file changes) — never
      // re-queue that, or such prompts would loop forever.
      if (userPrompt) enqueuePrompt(this.root, userPrompt);
      return { result: "error" };
    }
    if (!changed) {
      if (!pi.nothingToDo) {
        // No sentinel anywhere in the reply. Make the warning diagnosable: surface an
        // abnormal stopReason (e.g. "length" = truncated final message, so a cut-off
        // sentinel is distinguishable from plain non-compliance) and note when pi
        // produced no assistant text at all.
        const notes: string[] = [];
        if (pi.stopReason && pi.stopReason !== "stop") notes.push(`stopReason=${pi.stopReason}`);
        if (!pi.finalText.trim()) notes.push("no assistant text");
        // A final message with neither text nor a tool call means the generation was cut
        // off mid-stream, not that the model ignored the sentinel rule — typically pi
        // clamped max output tokens to what little space remained under the declared
        // context window and the provider reported the truncation as a normal stop.
        if (pi.finalMessageContentless)
          notes.push("final message had no text or tool call — likely cut off at the context ceiling");
        if (pi.compacted) notes.push("pi auto-compacted the session");
        logEvent(this.root, {
          loop: this.role,
          type: "warning",
          message:
            `pi finished without changes and without declaring nothing-to-do` +
            (notes.length ? ` (${notes.join(", ")})` : ""),
        });
      }
      return { result: "no_change" };
    }

    const summary = extractSummary(pi.finalText) ?? `${this.role} tick ${s.ticks}`;
    const message = `tumwater(${this.role}): ${summary}`;
    const commit = await commitAll(wt, message);
    const result = await this.merge(wt, summary);
    if (result !== "changed") s.lastError = `merge failed: ${result}`;
    return { result, summary, commit };
  }
}
