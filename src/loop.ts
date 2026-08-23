import type { TumwaterConfig, LoopState, PiRunResult, TickResult } from "./types.js";
import { DIRECTOR_ROLE, roleById } from "./roles.js";
import {
  abortMerge,
  aheadOfMain,
  commitAll,
  commitMergeResolution,
  conflictedFiles,
  ensureWorktree,
  ffMergeToMain,
  gitTry,
  hasConflictMarkers,
  headOf,
  isDirty,
  mergeMainIntoBranch,
  mergeMainLeaveConflicts,
  resetWorktreeToMain,
} from "./git.js";
import { withLock } from "./lock.js";
import { logEvent } from "./events.js";
import { SPAWN_ERROR_PREFIX, runPi } from "./pi.js";
import { buildConflictPrompt, buildDirectorPrompt, buildTickPrompt, extractSummary } from "./prompt.js";
import { readInitialPrompt } from "./readme.js";
import { configForRole } from "./config.js";
import { dequeuePrompt, enqueuePrompt } from "./inbox.js";
import { loadLoopState, nextBackoffSeconds, saveLoopState } from "./state.js";
import { mergeLockDir, piLogPath, sessionDir } from "./paths.js";

export interface TickOutcome {
  result: TickResult;
  summary?: string;
  commit?: string;
}

/** One role loop: owns a persistent worktree + branch and runs one tick at a time. */
export class LoopRunner {
  state: LoopState;
  /** The raw user prompt a director tick is executing, so an aborted tick can re-queue it. */
  private pendingUserPrompt: string | null = null;

  constructor(
    readonly root: string,
    readonly role: string,
    readonly config: TumwaterConfig,
    readonly mainBranch: string,
    readonly signal?: AbortSignal,
  ) {
    this.state = loadLoopState(root, role);
    this.state.running = false;
  }

  private save(): void {
    saveLoopState(this.root, this.state);
  }

  /** Decide the prompt for this tick, or null to skip (director with empty inbox). */
  private tickPrompt(): string | null {
    const initialPrompt = readInitialPrompt(this.root);
    if (this.role === DIRECTOR_ROLE) {
      const userPrompt = dequeuePrompt(this.root);
      if (!userPrompt) return null;
      this.pendingUserPrompt = userPrompt;
      return buildDirectorPrompt(userPrompt, initialPrompt);
    }
    const role = roleById(this.role);
    if (!role) throw new Error(`unknown role: ${this.role}`);
    return buildTickPrompt({
      role,
      initialPrompt,
      extraInstructions: this.config.roles[this.role]?.instructions,
    });
  }

  /** Merge the worktree branch into main under the shared merge lock. On conflict,
   * makes one pi-driven resolution attempt (outside the lock) before giving up. */
  private async merge(wt: string, summary: string): Promise<TickResult> {
    const first = await this.tryMerge(wt, summary);
    if (first !== "merge_conflict") return first;
    logEvent(this.root, { loop: this.role, type: "warning", message: "merge conflict — asking pi to resolve" });
    if (!(await this.resolveConflict(wt))) return "merge_conflict";
    return this.tryMerge(wt, summary);
  }

  private async tryMerge(wt: string, summary: string): Promise<TickResult> {
    return withLock(mergeLockDir(this.root), async () => {
      if (!(await mergeMainIntoBranch(wt, this.mainBranch))) return "merge_conflict";
      if (!(await ffMergeToMain(this.root, this.role, this.mainBranch))) return "merge_blocked";
      const commit = await headOf(this.root, this.mainBranch);
      logEvent(this.root, { loop: this.role, type: "merged", commit, summary });
      return "changed";
    });
  }

  /** Run pi for this loop in worktree `wt` with the shared per-loop wiring (role config,
   * session dir and resume flag, raw log) and fold the run's tokens/cost into the state. */
  private async runRolePi(wt: string, prompt: string, sessionName: string): Promise<PiRunResult> {
    const s = this.state;
    const pi = await runPi({
      cwd: wt,
      prompt,
      config: configForRole(this.config, this.role),
      sessionDir: sessionDir(this.root, this.role),
      sessionName,
      continueSession: s.hasSession,
      rawLogFile: piLogPath(this.root, this.role),
      signal: this.signal,
    });
    s.totalTokens += pi.totalTokens;
    s.totalCostUsd += pi.costUsd;
    return pi;
  }

  /** Re-run the conflicting merge leaving markers in place, let pi resolve them, and
   * conclude the merge. Returns true when the branch now contains a clean merge of main. */
  private async resolveConflict(wt: string): Promise<boolean> {
    const state = await mergeMainLeaveConflicts(wt, this.mainBranch);
    if (state === "clean") return true;
    if (state === "failed") return false;
    const files = await conflictedFiles(wt);
    const pi = await this.runRolePi(
      wt,
      buildConflictPrompt(this.role, files),
      `tumwater-${this.role}-${this.state.ticks}-conflict`,
    );
    if (!pi.ok || hasConflictMarkers(wt, files)) {
      await abortMerge(wt);
      return false;
    }
    await commitMergeResolution(wt);
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
      // Shutdown, not a verdict about the project: resume promptly on restart.
      s.nextRunAt = Date.now();
    } else {
      s.backoffSeconds = nextBackoffSeconds(s.backoffSeconds, this.config);
      s.nextRunAt = Date.now() + s.backoffSeconds * 1000;
    }
    // Self-heal from a poisoned session: whatever the error, repeated failures in a row
    // mean the accumulated context is more likely hurting than helping.
    if (outcome.result === "error") {
      s.consecutiveErrors = (s.consecutiveErrors ?? 0) + 1;
      if (s.consecutiveErrors >= 2 && s.hasSession) {
        s.hasSession = false;
        s.consecutiveErrors = 0;
        logEvent(this.root, {
          loop: this.role,
          type: "warning",
          message: "two consecutive error ticks — starting a fresh pi session next tick",
        });
      }
    } else if (outcome.result === "changed" || outcome.result === "no_change") {
      s.consecutiveErrors = 0;
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

    const prompt = this.tickPrompt();
    if (prompt === null) return { result: "skipped" };

    const wt = await ensureWorktree(this.root, this.role, this.mainBranch);
    await this.recoverLeftover(wt);
    await resetWorktreeToMain(wt, this.mainBranch);

    const pi = await this.runRolePi(wt, prompt, `tumwater-${this.role}-${s.ticks}`);

    // The run created (or extended) a session file; later ticks resume it. A spawn failure
    // never creates one, so don't mark the session resumable in that case.
    if (!pi.errorMessage?.startsWith(SPAWN_ERROR_PREFIX)) s.hasSession = true;

    // A session the provider rejects as too large can never be resumed successfully
    // (e.g. the model's real context is smaller than pi believes): drop it now.
    if (pi.contextExceeded && s.hasSession) {
      s.hasSession = false;
      logEvent(this.root, {
        loop: this.role,
        type: "warning",
        message: "provider rejected the context as too large — starting a fresh pi session next tick",
      });
    }

    // A killed run (shutdown or timeout) may leave half-done edits; never commit those.
    // The next tick's reset discards them.
    if (pi.aborted) {
      if (this.pendingUserPrompt) enqueuePrompt(this.root, this.pendingUserPrompt);
      return { result: "aborted" };
    }
    this.pendingUserPrompt = null;
    if (pi.timedOut) {
      s.lastError = pi.errorMessage ?? "timed out";
      return { result: "error" };
    }

    const changed = await isDirty(wt);
    if (!pi.ok && !changed) {
      s.lastError = pi.errorMessage ?? "pi failed";
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
