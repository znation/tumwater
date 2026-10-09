/** The backend-neutral agent runner (plans/agent-backends.md \"The seam\"): everything a run
 * needs regardless of which agent it drives — the spawn, the `tumwater_run` raw-log marker,
 * the watchdog wiring, abort, the group kill and marker sweep, stderr capture, and result
 * assembly. The backend (src/agent/agent-backend.ts, with pi in src/pi/pi-backend.ts) supplies
 * the argv/stdin/env, the native-to-canonical stdout translator, the stderr warning matcher,
 * and the exit classification. `runPi` (src/pi/pi.ts) is the thin alias the existing call sites
 * use, so a caller and its fakes are untouched by this split. */

import { spawn } from "node:child_process";
import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import type { ResolvedModelConfig } from "../config/config-views.js";
import { ensureDir, ensureParentDir, rotateIfLarge } from "../files/files.js";
import { agentBinSourceLabel, type ResolvedAgentBin } from "../pi/pi-bin.js";
import { runOnAbort, terminateChild } from "../process/process.js";
import { makeRunMarker, sweepRunMarker } from "../process/run-marker.js";
import type { PiRunKind } from "../pi/pi-event-line.js";
import { PiStreamParser } from "../pi/pi-stream.js";
import { startPiWatchdogs } from "../pi/pi-watchdogs.js";
import type { PiRunResult } from "../pi/pi-run-result.js";
import { DEFAULT_AGENT, agentBackend, registerAgentBackend } from "./agent-backend.js";
import { recordSession } from "./session-ledger.js";
import { piBackend } from "../pi/pi-backend.js";
import { claudeBackend } from "./claude/claude-backend.js";

/** How many trailing stderr characters are carried into the next chunk's warning match, so a
 * warning split across two `data` events is still seen. The warnings are short lines, so a few
 * hundred characters always cover a straddle. */
const STDERR_MATCH_TAIL = 512;

// The seam's adapters. Registering here — where the lookup happens — keeps the registration
// explicit and lets a test register a fake under its own id.
registerAgentBackend(piBackend);
registerAgentBackend(claudeBackend);

/** Prefix of PiRunResult.errorMessage when the agent process never started (no session file
 * is created for such a run). The resolved binary follows it, so a configured agentBin
 * reads "failed to spawn <bin>" rather than blaming an ambient "pi". */
const SPAWN_ERROR_PREFIX = "failed to spawn";

/** The spawn-error message for a resolved binary: the default source keeps today's text
 * ("failed to spawn pi: …"); a configured source names the binary and where it came from,
 * so a wrong agentBin does not read as "pi is broken". */
function spawnErrorMessage(
  resolved: ResolvedAgentBin,
  errMessage: string,
  binEnv: string,
): string {
  const source =
    resolved.source === "default"
      ? ""
      : ` (resolved from ${agentBinSourceLabel(resolved.source, binEnv)})`;
  return `${SPAWN_ERROR_PREFIX} ${resolved.bin}${source}: ${errMessage}`;
}

/** Options for one non-interactive agent run (runAgent / its runPi alias). Exported so a caller
 * that builds the same wiring in several places (loop.ts's author run and SUMMARY follow-up) can
 * share one construction helper typed against this exact shape. */
export interface PiRunOptions {
  cwd: string;
  prompt: string;
  /** The role/reviewer/fallback-resolved config view (configForRole, reviewRunConfig,
   * applyFallbackModel): its `model` is the concrete selector id — a tier map must be
   * resolved to the seam's tier before a run, and this type refuses to carry one. */
  config: ResolvedModelConfig;
  sessionDir: string;
  sessionName: string;
  /** Resume the most recent session in sessionDir instead of starting fresh — set by the runs
   * that continue an open session rather than open a fresh one: the transient retry (so the
   * retry keeps the first attempt's partial progress), the review gate's verdict-recovery
   * follow-up (the just-finished review's session, to ask for a missing VERDICT line —
   * src/review/review-followup.ts, BUGS.md 2026-09-29), the two author-side follow-up turns
   * requestSummary and requestStageFix (both via the shared requestFollowUp, to ask for a
   * missing SUMMARY or to fix the pre-queue self-check's findings), and the authoring resume
   * of a tick a harness interruption cut short (src/tick/tick-resume.ts's `resuming`).
   * Every other run starts a fresh session, so context never accumulates across ticks. */
  continueSession?: boolean;
  /** Raw pi JSON event lines are appended here for observability. */
  rawLogFile: string;
  signal?: AbortSignal;
  /** Which kind of run this is: the tick's own authoring run ("author") or the review/landing
   * gate's run ("gate"). Required, so every call site names it and the dashboards demultiplex
   * the role's interleaved runs by the raw-log marker instead of the run's worktree path
   * (plans/worktree-pool.md part 1/5). */
  kind: PiRunKind;
  /** Label this run in the role's transcript (the review gate passes "review"): written into
   * the run's one `tumwater_run` marker line before any of pi's output, so every transcript
   * surface renders a labeled separator for it. The marker is written for EVERY run (kind
   * included); a run with no label still gets one, and its separator renders unlabeled. */
  label?: string;
  /** Called once per stalled tool call when it has been open with no content-bearing update
   * for config.toolCallStallSeconds: the harness logs a warning event naming the command
   * while the quiet watchdog still counts down (the dashboards derive their own flag from the
   * raw log, so only the event needs wiring). */
  onToolCallStalled?: (message: string) => void;
  /** Called once per tool call as it starts, with pi's tool name and raw args (see
   * PiStreamParser) — the review gate collects its reviewer's calls through this to notice a
   * full-suite re-run the harness's green pre-check made redundant. */
  onToolCallStart?: (toolName: string, args: unknown) => void;
  /** The role notebook this run may write through the bundled `role_notes` tool, exported to
   * the child as TUMWATER_NOTES_PATH. Only authoring runs set it (LoopPi.runAuthoringPi);
   * review, landing, and conflict-resolution runs leave it unset, so the tool never registers
   * there (src/pi-extension/role-notes.ts). Undefined: no notebook. */
  notesPath?: string;
}

/** Run the configured agent backend non-interactively in a worktree and distill the result.
 * Never throws. */
export function runAgent(opts: PiRunOptions): Promise<PiRunResult> {
  return new Promise((resolve) => {
    // A config names no agent yet (part 4/7 adds the selector): default to pi, the historical
    // backend. An unregistered id also falls back to pi rather than rejecting the tick.
    const backend = agentBackend(opts.config.agent ?? DEFAULT_AGENT) ?? piBackend;
    ensureDir(opts.sessionDir);
    ensureParentDir(opts.rawLogFile);
    rotateIfLarge(opts.rawLogFile, opts.config.logMaxBytes);
    const rawLog = fs.createWriteStream(opts.rawLogFile, { flags: "a" });
    // A broken raw log (EACCES, ENOSPC) must not crash the process on an unhandled 'error'
    // nor hang the tick: mark it so finish() resolves without waiting for a 'finish' that
    // will never come — a lost transcript is acceptable, a stuck loop is not.
    let rawLogBroken = false;
    rawLog.on("error", () => {
      rawLogBroken = true;
    });
    // The marker precedes this run's first event in file order — written to the same stream
    // stdout lines flow through, before spawn, so ordering is exact by construction; on a
    // failed spawn finish() still ends the stream and flushes it. Exactly one per run: the
    // kind and agent are always there, the label only when the caller set one.
    {
      const marker: { type: "tumwater_run"; kind: PiRunKind; agent: string; label?: string } = {
        type: "tumwater_run",
        kind: opts.kind,
        agent: backend.id,
      };
      if (opts.label) marker.label = opts.label;
      rawLog.write(JSON.stringify(marker) + "\n");
    }
    const parser = new PiStreamParser(opts.onToolCallStart);
    // The run's cross-group attribution mark, minted before the spawn so the environment can
    // carry it and the exit sweep can name it.
    const runMarker = makeRunMarker();
    const resolved = backend.resolveBin(opts.config);
    const invocation = backend.invocation({
      cwd: opts.cwd,
      prompt: opts.prompt,
      config: opts.config,
      sessionDir: opts.sessionDir,
      sessionName: opts.sessionName,
      continueSession: opts.continueSession,
      kind: opts.kind,
      agentBin: resolved.bin,
      runMarker,
      notesPath: opts.notesPath,
    });
    // Record the run in the session ledger before its spawn, so a later resume can pick the
    // newest session of its own kind instead of whatever file is newest in the dir. The id is
    // the backend's own when it mints one ahead of the run (claude's UUID, or the resumed
    // record's id); pi mints none and keeps the session name.
    recordSession(opts.sessionDir, {
      agent: backend.id,
      id: invocation.sessionId ?? opts.sessionName,
      kind: opts.kind,
      name: opts.sessionName,
      cwd: opts.cwd,
      ...(opts.config.model !== undefined ? { model: opts.config.model } : {}),
      at: Date.now(),
    });
    const translator = backend.translator();
    // Decode stdout incrementally instead of per chunk: a raw Buffer.toString("utf8")
    // replaces any multi-byte character whose bytes straddle two 'data' events with U+FFFD,
    // corrupting that line's text (commit subjects, summaries, transcripts). StringDecoder
    // holds back the incomplete trailing bytes until the next chunk completes them.
    const decoder = new StringDecoder("utf8");
    // stderr gets its own incremental decoder for the same reason: the failure message and
    // the stderr-keyed matchers (crash, stream-severed, config) read this buffer, so a
    // character whose bytes straddle two 'data' events must not become U+FFFD.
    const stderrDecoder = new StringDecoder("utf8");
    let stderr = "";
    // The fallback-clone warning arrives at the START of a run, while `stderr` keeps only the
    // last 64 KiB; match each chunk (with a short carried tail for a straddle) so a chatty run
    // that pushes the warning out of that window still surfaces the mispriced id.
    let fallbackClone: string | undefined;
    let stderrTail = "";
    let settled = false;
    // The translator's native line buffer: feed the decoder's text through it and only complete
    // lines reach the translator, whose canonical output feeds the parser (and the raw log).
    let nativeTail = "";

    const child = spawn(resolved.bin, invocation.args, {
      cwd: opts.cwd,
      // The prompt-argv backends (pi) deliver no stdin and keep stdio[0] "ignore"; a backend
      // that feeds the prompt on stdin gets a pipe the runner writes and ends below.
      stdio: [invocation.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      // pi sets its process title at startup, and so does every npm its tool calls run: on
      // macOS each would register with LaunchServices and leak a launchservicesd port.
      // Detached so pi leads its own process group: terminateChild signals the group, so a
      // run's tool-call grandchildren — killed or finished — die with it instead of leaking
      // to launchd.
      detached: true,
      // The run's mark, inherited by every tool call and its descendants: pi 0.87.1's bash
      // tool spawns each command detached in its OWN group, so the group sweep below cannot
      // reach what a tool call backgrounds (BUGS.md 2026-09-30) — the mark is the only
      // attribution that follows a reparented orphan. Appended to any inherited mark so a
      // nested harness under test keeps the outer run's.
      env: invocation.env,
    });
    if (invocation.stdin !== undefined) child.stdin?.end(invocation.stdin);

    // The run's two watchdog clocks (src/pi/pi-watchdogs.ts): the tick deadline and the quiet
    // watchdog (quiet-kill plus the stalled-tool-call warning). The flags their timers set
    // (timedOut/timedOutProgressing/quietKilled/sawOutput) read live off the returned handle.
    const wd = startPiWatchdogs({
      progressCount: () => parser.progressCount,
      openToolCalls: () => parser.openToolCalls,
      tickTimeoutMs: opts.config.tickTimeoutSeconds * 1000,
      quietMs: opts.config.quietTimeoutSeconds * 1000,
      stallMs: Math.max(0, opts.config.toolCallStallSeconds) * 1000,
      // The gate's fresh-session runs (reviewer and conflict resolver) get one deadline
      // extension while they are still making progress: a large diff's review otherwise
      // times out mid-verification and the next attempt re-reads it from scratch
      // (BUGS.md 2026-10-07). Authoring runs resume their session next tick, so one
      // deadline stays right for them.
      extendOnProgress: opts.kind === "gate",
      kill: () => terminateChild(child),
      onToolCallStalled: opts.onToolCallStalled,
    });

    let aborted = false;
    const onAbort = () => {
      aborted = true;
      terminateChild(child);
    };
    runOnAbort(opts.signal, onAbort);

    // Quiet watchdog and its stall warning: src/pi/pi-watchdogs.ts.

    const onLine = (line: string) => rawLog.write(line + "\n");
    // Split native stdout into complete lines, translate each, and feed the canonical lines to
    // the parser (which also hands them to onLine for the raw log). A trailing partial native
    // line stays buffered exactly as the parser's own buffer once held it.
    const feedCanonical = (text: string) => {
      nativeTail += text;
      let start = 0;
      for (;;) {
        const nl = nativeTail.indexOf("\n", start);
        if (nl < 0) break;
        const line = nativeTail.slice(start, nl);
        start = nl + 1;
        for (const canonical of translator.translate(line)) parser.feed(canonical + "\n", onLine);
      }
      if (start > 0) nativeTail = nativeTail.slice(start);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      wd.noteByte();
      feedCanonical(decoder.write(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      // stderr is rare and meaningful (crash traces, warnings): treat it as progress.
      wd.noteStderr();
      const text = stderrDecoder.write(chunk);
      fallbackClone ??= backend.matchStderrWarning?.(text, stderrTail);
      stderrTail = (stderrTail + text).slice(-STDERR_MATCH_TAIL);
      stderr += text;
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-64 * 1024);
    });

    const finish = (result: PiRunResult) => {
      if (settled) return;
      settled = true;
      wd.stop();
      opts.signal?.removeEventListener("abort", onAbort);
      // Resolve only once the raw log has flushed: writes complete on libuv's threadpool, so
      // resolving before 'finish' can leave the tail of <role>.pi.jsonl unwritten — a tick
      // that dies right after runAgent settles (an abort during a restart drain, a supervisor
      // swap) loses its last lines, and under load readers see an empty or marker-only file.
      // end()'s callback fires on 'finish'; if the stream errors instead it never does, so
      // settle from 'error' too — a broken raw log degrades to a lost log, never a stuck tick.
      let resolved = false;
      const settle = () => {
        if (!resolved) {
          resolved = true;
          resolve(result);
        }
      };
      rawLog.on("error", settle);
      if (rawLogBroken) settle();
      else rawLog.end(settle);
    };

    // Every PiRunResult is built here from what the parser has seen plus how the run ended,
    // so adding a field to PiRunResult touches this single place. The spawn-error path passes
    // only an errorMessage override: at that point no output ever arrived, so the parser holds
    // exactly its initial values — which is precisely what a failed spawn reports.
    const resultFromParser = (overrides: Partial<PiRunResult>): PiRunResult => ({
      ok: false,
      finalText: parser.finalText,
      nothingToDo: parser.declaredNothingToDo,
      refused: parser.refused,
      refusedReason: parser.refusedReason || undefined,
      verdictText: parser.verdictText || undefined,
      outputTokens: parser.outputTokens,
      promptTokens: parser.promptTokens,
      cacheReadTokens: parser.cacheReadTokens,
      preEditPromptTokens: parser.preEditPromptTokens,
      firstEditTurn: parser.firstEditTurn,
      peakContextTokens: parser.peakContextTokens,
      turns: parser.turns,
      costUsd: parser.costUsd,
      stopReason: parser.stopReason,
      errorMessage: undefined,
      timedOut: false,
      timedOutProgressing: false,
      quietKilled: false,
      aborted,
      contextExceeded: parser.contextExceeded,
      transientServerTimeout: parser.transientServerTimeout,
      transientRateLimit: parser.transientRateLimit,
      transientBackend: parser.transientBackend,
      backendKind: parser.backendFailureKind,
      configError: parser.configError,
      retryAfterSeconds: parser.retryAfterSeconds,
      transientPiCrash: false,
      fallbackClone,
      finalMessageContentless: parser.finalMessageContentless,
      producedAssistantContent: parser.producedAssistantContent,
      compacted: parser.compacted,
      budgetCapped: parser.budgetCapped,
      resumeMissing: parser.resumeMissing,
      billing: parser.billing,
      rateWindows: parser.rateWindows.length > 0 ? parser.rateWindows : undefined,
      usedOverage: parser.usedOverage,
      ...overrides,
    });

    child.on("error", (err) => {
      finish(
        resultFromParser({
          errorMessage: spawnErrorMessage(resolved, err.message, backend.binEnv),
        }),
      );
    });

    // Sweep the run however it ended, a normal exit included, in two passes:
    //
    // 1. The group pi led: pi exits before its orphans — a tool call's `(server &)` or
    //    `cd … && server &` is reparented to PID 1 but stays in pi's group — and the harness
    //    cannot rely on the model's own cleanup (BUGS.md 2026-09-23: qa's unauthenticated
    //    `gui --all-interfaces` listened on the LAN for 7.5 hours after a tick that ended
    //    "Everything checked out"). On 'exit', not 'close': pi has just been reaped, so the
    //    pgid still names only its group (never reissued while a member lives), and an orphan
    //    holding pi's stdio open dies now instead of holding 'close' — and the run — open.
    //    Synchronous, so it adds nothing to the run's resolution; on the kill paths it
    //    re-sends a SIGTERM the group already had.
    //
    // 2. The marker sweep: pi 0.87.1's bash tool starts every command detached, in its own
    //    process group, so whatever a tool call backgrounds sits in a group whose leader is
    //    not pi and pass 1 never reaches it (BUGS.md 2026-09-30 — leaked servers and test
    //    workers outlived their ticks by hours). Every process the run started carries the
    //    run's TUMWATER_RUN mark in its environment, so the same-user scan finds them
    //    wherever they were reparented. Fire-and-forget: one process-table scan, never
    //    awaited — the run resolves on pi's output, and the sweep's own SIGKILL escalation
    //    (10 s) is unref'd like signalTree's.
    child.on("exit", () => {
      terminateChild(child);
      void sweepRunMarker(runMarker).catch(() => {});
    });

    child.on("close", (code) => {
      // Flush any bytes the decoder held back at stream end so a final line is not lost.
      feedCanonical(decoder.end());
      const killed = aborted || wd.timedOut || wd.quietKilled;
      const failed =
        killed ||
        parser.stopReason === "error" ||
        (code !== 0 && !parser.finalText.trim());
      // The backend classifies the exit's stderr (pi: the transient JSON-parse crash, a
      // provider-wide backend failure, a permanent config error). The runner merges that with
      // the parser's own event-derived flags — one exit has one cause.
      const cls = backend.classifyExit({ code, stderr, killed });
      const stderrBackend = cls.backendKind;
      const configError =
        !killed &&
        cls.transientPiCrash !== true &&
        stderrBackend === undefined &&
        (parser.configError || cls.configError === true);
      finish(
        resultFromParser({
          ok: !failed,
          transientPiCrash: cls.transientPiCrash === true,
          transientBackend: parser.transientBackend || cls.transientBackend === true,
          backendKind: parser.backendFailureKind ?? stderrBackend,
          configError,
          errorMessage: aborted
            ? "aborted by harness shutdown"
            : wd.quietKilled
              ? `killed as hung: no pi progress for over ${opts.config.quietTimeoutSeconds}s`
              : wd.timedOut
                ? wd.timedOutProgressing
                  ? `timed out after ${wd.timeoutBudgetMs / 1000}s while still making progress — session and worktree edits preserved for resume`
                  : `timed out after ${wd.timeoutBudgetMs / 1000}s`
                : (parser.errorMessage ?? (failed ? stderr.trim().slice(-500) || `pi exited ${code}` : undefined)),
          // Kept distinct on purpose: a hung tool call leaves its session and worktree edits
          // intact, so the loop resumes them (quiet_killed) instead of discarding them as an
          // unfulfilled timeout does. A deadline that fired on a run still making progress
          // gets the same treatment (BUGS.md 2026-09-29).
          timedOut: wd.timedOut,
          timedOutProgressing: wd.timedOut && wd.timedOutProgressing,
          quietKilled: wd.quietKilled,
        }),
      );
    });
  });
}

/** The historical name for the neutral runner: every existing call site, fake, and test keeps
 * calling `runPi`. */
export const runPi = runAgent;
