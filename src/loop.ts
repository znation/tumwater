import type { TumwaterConfig, LoopState, PiRunResult, TickResult } from "./types.js";
import { DIRECTOR_ROLE, roleById } from "./roles.js";
import {
  abortSync,
  aheadOfMain,
  changedFiles,
  commitAll,
  commitPathsAndDiscardRest,
  conflictedFiles,
  continueRebase,
  ensureWorktree,
  ffMergeToMain,
  git,
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
  buildCommitMessage,
  commitTrailer,
  extractCommitBody,
  extractSummary,
  formatCommitBody,
} from "./commit-message.js";
import {
  buildConflictPrompt,
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
import { loadLoopState, nextBackoffSeconds, saveLoopState, zeroCounters } from "./state.js";
import { mergeLockDir, piLogPath, sessionDir } from "./paths.js";

export interface TickOutcome {
  result: TickResult;
  summary?: string;
  commit?: string;
  /** The tick's authoring run burned more than the configured thrashTurns/thrashMinutes
   * thresholds (plans/refusal-and-thrash.md): difficulty is a signal, so the change went to
   * review flagged and a warning event was logged. */
  highFriction?: boolean;
  /** The run was truncated at the model's context ceiling before it could finish (a
   * no_change tick whose final message carried no text or tool call). The work so far
   * survives in the pi session, which pi compacted at end of run — so the loop resumes
   * it promptly instead of backing off as if the role were idle. */
  cutOff?: boolean;
}

/** Consecutive context-ceiling cut-offs after which a loop stops resuming the task and
 * falls back to a fresh tick: a task that outruns the ceiling on every attempt (even from
 * a freshly compacted context) is too big to converge, and each cycle costs an hour-plus
 * of model time on local hardware. */
const CUT_OFF_RESUME_LIMIT = 3;

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

  /** Fold one pi run's usage into the tick's counters (gen / peak ctx / cost / turns). Every
   * pi run of a tick — main attempt, transient-timeout retry, conflict resolution — lands here
   * exactly once, so adding a usage field to PiRunResult touches this single place. */
  private foldUsage(run: PiRunResult): void {
    const s = this.state;
    s.generatedTokens += run.outputTokens;
    s.peakContextTokens = Math.max(s.peakContextTokens, run.peakContextTokens);
    s.totalCostUsd += run.costUsd;
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
        signal: this.signal,
      },
      this.state,
      summary,
      commitBody,
      highFriction,
    );
  }

  /** Handle a refused tick (plans/refusal-and-thrash.md): the run declined its work and ended
   * with TUMWATER_REFUSED. Only the markdown objection note may land — it is the durable record
   * that blocks the entry for later ticks; any non-markdown half-work is discarded, tracked
   * edits via reset --hard and untracked files via clean -fd (the committed note is safe at
   * HEAD by then). A refusal with no note left resets the worktree cleanly and lets the reason
   * live in the event + lastSummary only. The note commit merges directly: md-only diffs are
   * review-exempt by construction under the gate's exemption patterns, so routing it through
   * the gate would burn nothing but add a failure mode for a record that is not code. */
  private async handleRefusal(wt: string, pi: PiRunResult): Promise<TickOutcome> {
    const s = this.state;
    const reason = (pi.refusedReason ?? "").trim() || "no reason given";
    const notes = (await changedFiles(wt)).filter((f) => f.toLowerCase().endsWith(".md"));
    let commit: string | undefined;
    if (notes.length > 0) {
      // Subject + trailer only — a refusal carries no WHY/RISK/VERIFIED body; the reason is
      // the subject, and the trailer's turn count is the same field the friction flag reads.
      const message = buildCommitMessage(
        `tumwater(${this.role}): refuse — ${reason}`,
        null,
        commitTrailer(this.role, s.ticks, this.tickTurns, s.peakContextTokens),
      );
      commit = (await commitPathsAndDiscardRest(wt, message, notes)) ?? undefined;
    }
    if (!commit) {
      // No note landed (none left, or nothing stageable): reset and keep the reason in the
      // event + lastSummary only.
      await resetWorktreeToMain(wt, this.mainBranch);
      return { result: "refused", summary: reason };
    }
    const result = await this.merge(wt, `refused: ${reason}`);
    if (result !== "changed") s.lastError = `refusal note merge failed: ${result}`;
    return { result: "refused", summary: reason, commit };
  }

  /** Salvage commits left on the branch by a previous run whose merge never landed. Leftovers
   * route through the SAME review gate as fresh ticks — every path that can move a commit into
   * main reviews the full ahead-of-main diff first, so no crash or abort path smuggles
   * unreviewed work in (see src/review.ts). Returns true when the leftover was deliberately
   * left on the branch for re-review (a failed review under the strike cap) so the caller keeps
   * it instead of resetting to main. */
  private async recoverLeftover(wt: string): Promise<boolean> {
    const ahead = await aheadOfMain(wt, this.mainBranch).catch(() => 0);
    if (ahead <= 0) return false;
    const gate = await this.reviewGate(wt, undefined, undefined, "-recovery");
    if (gate.run) this.foldUsage(gate.run);
    // Shutdown mid-review: fail closed — the commit stays for next time. A reject already reset
    // to main inside the gate; a failure below the strike cap leaves the commit on purpose.
    if (gate.aborted) return true;
    if (gate.decision === "rejected") return false;
    if (gate.decision === "failed") {
      // At/over the strike cap the gate already discarded the leftover — nothing left to keep.
      return (await aheadOfMain(wt, this.mainBranch).catch(() => 0)) > 0;
    }
    const result = await this.merge(wt, `recovered leftover work from ${this.role}`);
    if (result !== "changed") {
      logEvent(this.root, {
        loop: this.role,
        type: "warning",
        message: `discarding ${ahead} unmergeable leftover commit(s) (${result})`,
      });
    }
    return false; // merged or warned-and-left-to-the-reset: caller resets to main as usual
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
    // The review gate persists phase="review" around its run so a dashboard mid-review shows
    // "reviewing". A completed tick clears it so the label never lingers — except an aborted
    // one: there the interruption hit mid-review, and the next launch must recover (and
    // re-review) the committed work fresh instead of resuming an author session whose task is
    // already committed.
    if (outcome.result !== "aborted") s.phase = undefined;
    s.lastTickEndedAt = Date.now();
    s.lastResult = outcome.result;
    if (outcome.summary) s.lastSummary = outcome.summary;
    if (outcome.result === "changed") {
      s.commits += 1;
      s.backoffSeconds = 0;
      s.nextRunAt = Date.now() + cfg.minTickIntervalSeconds * 1000;
    } else if (outcome.result === "rejected") {
      // The reviewer objected and the gate already reset the branch: the author should address
      // the recorded reasons on its next eligible tick, not sleep through them — schedule like
      // a change without counting a commit (nothing landed).
      s.backoffSeconds = 0;
      s.nextRunAt = Date.now() + cfg.minTickIntervalSeconds * 1000;
    } else if (outcome.result === "skipped") {
      // Director idles until the inbox has work; no backoff bookkeeping.
      s.nextRunAt = Date.now() + cfg.minTickIntervalSeconds * 1000;
    } else if (outcome.result === "aborted") {
      // Shutdown, not a verdict about the project: resume promptly on restart. The pi
      // session and the worktree's uncommitted edits were left in place, so the next tick
      // picks up exactly where this one was interrupted (director ticks instead re-queue
      // their user prompt, which runs fresh).
      if (this.role !== DIRECTOR_ROLE) s.resumePending = true;
      s.nextRunAt = Date.now();
    } else if (outcome.cutOff && this.role !== DIRECTOR_ROLE && (s.cutOffStreak ?? 0) < CUT_OFF_RESUME_LIMIT) {
      // Truncated at the context ceiling, not idle: the hour(s) of work survive in the
      // session pi just compacted, so resume it promptly instead of idle-backing-off.
      // Each resume restarts from the compacted (small) context, so repeated cut-offs on
      // one task still converge — but a task that outruns the ceiling every single time
      // would cycle forever, so after CUT_OFF_RESUME_LIMIT consecutive cut-offs the loop
      // gives up on it and falls back to a fresh tick with normal backoff.
      s.cutOffStreak = (s.cutOffStreak ?? 0) + 1;
      s.resumePending = true;
      s.nextRunAt = Date.now() + cfg.minTickIntervalSeconds * 1000;
    } else {
      s.backoffSeconds = nextBackoffSeconds(s.backoffSeconds, this.config);
      s.nextRunAt = Date.now() + s.backoffSeconds * 1000;
    }
    if (!outcome.cutOff) s.cutOffStreak = 0;
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
      const leftForRetry = await this.recoverLeftover(wt);
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

    // A refusal is a decision, not a failure: even when pi's exit was abnormal, the sentinel
    // and any note it left are the run's verdict — classify what it left behind.
    if (pi.refused) return await this.handleRefusal(wt, pi);

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
      const cutOff = !pi.nothingToDo && pi.finalMessageContentless;
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
      // A cut-off run did real work and was NOT fulfilled: a director prompt goes back
      // to the inbox to rerun fresh; a role loop resumes the just-compacted session
      // next tick (see the cutOff handling in tick()).
      if (cutOff && userPrompt) enqueuePrompt(this.root, userPrompt);
      return { result: "no_change", cutOff: cutOff || undefined };
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
    const highFriction =
      this.tickTurns > this.config.thrashTurns || minutes > this.config.thrashMinutes;
    if (highFriction) {
      logEvent(this.root, {
        loop: this.role,
        type: "warning",
        message:
          `high-friction tick: ${this.tickTurns} turns in ${Math.round(minutes)} min ` +
          `(thresholds: ${this.config.thrashTurns} turns / ${this.config.thrashMinutes} min)`,
      });
    }
    // The trailer is harness-stamped truth: turns and peak ctx over this tick's pre-commit
    // runs only (conflict-resolution and review runs fold after the commit).
    const message = buildCommitMessage(
      `tumwater(${this.role}): ${summary}`,
      body,
      commitTrailer(this.role, s.ticks, this.tickTurns, s.peakContextTokens),
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
    if (gate.aborted) {
      // Shutdown mid-review: fail closed — the commit stays on the branch and the next launch
      // re-reviews it via the combined ahead-of-main diff. Re-queue a director prompt like any
      // other unfulfilled abort.
      if (userPrompt) enqueuePrompt(this.root, userPrompt);
      return { result: "aborted" };
    }
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
    // The friction flag rides along in lastSummary and the tick_end event too — until commit
    // bodies carry a dedicated trailer line, those are where it stays visible.
    const finalSummary = highFriction
      ? `${summary} (high friction: ${this.tickTurns} turns / ${Math.round(minutes)}m)`
      : summary;
    return { result, summary: finalSummary, commit, highFriction };
  }
}
