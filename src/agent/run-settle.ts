/** The settlement half of a backend agent run (the split of src/agent/run-agent.ts along the
 * same seam the runner-run → runner-outcome split used): everything that happens after the
 * run's live feed — the spawn-`error` result, the `exit` orphan sweep, and the `close`-time
 * flush/reconcile/classify that builds the `PiRunResult`. run-agent.ts keeps the lifecycle
 * (setup, watchdogs, the feed), delegates its build-and-spawn stage to src/agent/run-spawn.ts,
 * its streaming pipeline to src/agent/run-stream.ts and its `error`/`exit`/`close` listeners
 * here, so the streaming half stays readable.
 *
 * Each handler takes the run's live state (`RunSettleState`, defined in run-agent.ts and
 * imported here only as a type) and reads what it closes over at the moment its event fires —
 * the live flags it needs are getters on that state. There is no runtime import cycle:
 * run-agent imports these functions at runtime, and this module imports only run-agent's type.
 */

import type { PiRunResult } from "../pi/pi-run-result.js";
import { backendBinConfigKey, backendBinSourceLabel, type ResolvedBackendBin } from "../pi/pi-bin.js";
import type { AgentBackend, AgentExitClassification } from "./agent-backend.js";
import { terminateChild } from "../process/process.js";
import { leftoversSweptMessage, sweepRunMarker } from "../process/run-marker.js";
import type { RunSettleState } from "./run-agent.js";

/** Prefix of PiRunResult.errorMessage when the agent process never started (no session file
 * is created for such a run). The resolved binary follows it, so a configured agentBin
 * reads "failed to spawn <bin>" rather than blaming an ambient "pi". */
const SPAWN_ERROR_PREFIX = "failed to spawn";

/** The spawn-error message for a resolved binary: the default source keeps today's text
 * ("failed to spawn pi: …"); a configured source names the binary and where it came from —
 * the backend's own env var and config key (backendBinConfigKey) — so a wrong
 * `backends.claude.bin` does not read as pi's legacy `agentBin`. */
function spawnErrorMessage(
  resolved: ResolvedBackendBin,
  errMessage: string,
  backend: AgentBackend,
): string {
  const source =
    resolved.source === "default"
      ? ""
      : ` (resolved from ${backendBinSourceLabel(resolved.source, backend.binEnv, backendBinConfigKey(backend.id))})`;
  return `${SPAWN_ERROR_PREFIX} ${resolved.bin}${source}: ${errMessage}`;
}

/** The failed result of a run that never started: all counters zero, all flags false. */
export function setupFailureResult(agent: string, message: string): PiRunResult {
  return {
    ok: false,
    finalText: "",
    nothingToDo: false,
    refused: false,
    agent,
    outputTokens: 0,
    promptTokens: 0,
    cacheReadTokens: 0,
    preEditPromptTokens: 0,
    peakContextTokens: 0,
    turns: 0,
    costUsd: 0,
    errorMessage: message,
    timedOut: false,
    timedOutProgressing: false,
    aborted: false,
    quietKilled: false,
    contextExceeded: false,
    transientServerTimeout: false,
    transientPiCrash: false,
    transientRateLimit: false,
    transientBackend: false,
    configError: false,
    finalMessageContentless: false,
    producedAssistantContent: false,
    compacted: false,
  };
}

/** Every PiRunResult is built here from what the parser has seen plus how the run ended, so
 * adding a field to PiRunResult touches this single place. The spawn-error path passes only
 * an errorMessage override: at that point no output ever arrived, so the parser holds exactly
 * its initial values — which is precisely what a failed spawn reports. */
function resultFromParser(
  state: RunSettleState,
  overrides: Partial<PiRunResult>,
): PiRunResult {
  const parser = state.parser;
  return {
    ok: false,
    finalText: parser.finalText,
    nothingToDo: parser.declaredNothingToDo,
    refused: parser.refused,
    refusedReason: parser.refusedReason || undefined,
    verdictText: parser.verdictText || undefined,
    agent: state.backend.id,
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
    aborted: state.aborted(),
    contextExceeded: parser.contextExceeded,
    transientServerTimeout: parser.transientServerTimeout,
    transientRateLimit: parser.transientRateLimit,
    transientBackend: parser.transientBackend,
    backendKind: parser.backendFailureKind,
    configError: parser.configError,
    retryAfterSeconds: parser.retryAfterSeconds,
    transientPiCrash: false,
    fallbackClone: state.fallbackClone(),
    finalMessageContentless: parser.finalMessageContentless,
    producedAssistantContent: parser.producedAssistantContent,
    compacted: parser.compacted,
    budgetCapped: parser.budgetCapped,
    resumeMissing: parser.resumeMissing,
    billing: parser.billing,
    rateWindows: parser.rateWindows.length > 0 ? parser.rateWindows : undefined,
    usedOverage: parser.usedOverage,
    ...overrides,
  };
}

/** The run's `error` event: the process never spawned. Only the spawn-error cause is set; no
 * output ever arrived, so the parser still holds its initial values (what a failed spawn
 * reports), and `finish` settles the run so the `close` event no-ops. */
export function settleError(state: RunSettleState, err: Error): void {
  state.finish(
    resultFromParser(state, {
      errorMessage: spawnErrorMessage(state.resolved, err.message, state.backend),
    }),
  );
}

/** The run's `exit` event: sweep whatever the run (or a tool call it started) left running,
 * however the run ended, a normal exit included, in two passes:
 *
 * 1. The group pi led: pi exits before its orphans — a tool call's `(server &)` or
 *    `cd … && server &` is reparented to PID 1 but stays in pi's group — and the harness
 *    cannot rely on the model's own cleanup. On 'exit', not 'close': pi has just been reaped,
 *    so the pgid still names only its group (never reissued while a member lives), and an
 *    orphan holding pi's stdio open dies now instead of holding 'close' — and the run — open.
 *    Synchronous, so it adds nothing to the run's resolution; on the kill paths it re-sends a
 *    SIGTERM the group already had.
 *
 * 2. The marker sweep: pi 0.87.1's bash tool starts every command detached, in its own
 *    process group, so whatever a tool call backgrounds sits in a group whose leader is not
 *    pi and pass 1 never reaches it. Every process the run started carries the run's
 *    TUMWATER_RUN mark in its environment, so the same-user scan finds them wherever they
 *    were reparented. Fire-and-forget: one process-table scan, never awaited — the run
 *    resolves on pi's output, and the sweep's own SIGKILL escalation (10 s) is unref'd like
 *    signalTree's.
 */
export function settleExit(state: RunSettleState): void {
  terminateChild(state.child);
  void sweepRunMarker(state.runMarker)
    .then((n) => {
      const msg = leftoversSweptMessage(state.kind, n, state.wasKilled());
      if (msg) state.onLeftoversSwept?.(msg);
    })
    .catch(() => {});
}

/** Settle the run's `lastError` text in priority order: a failed blind image read names both
 * the file and the model (plans/image-input.md "Failing the run"), then the abort, quiet-kill
 * and timeout causes the watchdogs and signal path set, then the parser's own event-derived
 * error, else the raw stderr tail. Undefined for a run that simply ended with a message. */
function settleErrorMessage(
  state: RunSettleState,
  blindRead: string | undefined,
  failed: boolean,
  stderr: string,
  code: number | null,
): string | undefined {
  if (blindRead !== undefined) {
    return `read ${blindRead}, but ${state.config.model ?? "the model"} cannot read images`;
  }
  if (state.aborted()) return "stopped by tumwater shutdown";
  if (state.wd.quietKilled) {
    return `killed as hung: no agent progress for over ${state.config.quietTimeoutSeconds}s`;
  }
  if (state.wd.timedOut) {
    return state.wd.timedOutProgressing
      ? `timed out after ${state.wd.timeoutBudgetMs / 1000}s while still making progress — session and worktree edits preserved for resume`
      : `timed out after ${state.wd.timeoutBudgetMs / 1000}s`;
  }
  return (
    state.parser.errorMessage ??
    (failed ? stderr.trim().slice(-500) || `the agent exited ${code}` : undefined)
  );
}

/** Flush the tail the decoders and translator held back at stream end: the decoder's last
 * bytes and unterminated final line, then a batching backend's unclosed final assistant
 * message (which a killed run never closes with a later event). */
function flushRunTail(state: RunSettleState): void {
  // Flush any bytes the decoder held back at stream end and any unterminated final line so the
  // tail is not lost, then let the translator flush its own pending canonical line(s) — a
  // batching backend's unclosed last assistant message, which a killed run never closes with a
  // later event.
  state.feedCanonical(state.decoder.end(), true);
  for (const canonical of state.translator.finalize?.() ?? []) state.parser.feed(canonical + "\n", state.onLine);
}

/** Reconcile the backend's post-run work (opencode's authoritative session export), only when
 * the run is not already settled (a failed spawn settles in the 'error' handler before
 * 'close') and was not killed — a killed run's session is half-done and no export should spend
 * its 10 s on it. Its lines are written and parsed like streamed ones, so they reach the raw
 * log and the parser's authoritative fold (run_cost/run_usage). */
function reconcileBackendAfterRun(state: RunSettleState, killed: boolean): void {
  // The backend's post-run reconciliation (opencode's authoritative session export), only when
  // the run is not already settled (a failed spawn settles in the 'error' handler before
  // 'close') and was not killed — a killed run's session is half-done and no export should
  // spend its 10 s on it. Its lines are written and parsed like streamed ones, so they reach
  // the raw log and the parser's authoritative fold (run_cost/run_usage).
  if (!state.settled() && !killed) {
    for (const canonical of state.backend.afterRun?.(state.runSpec, state.invocation, state.translator) ?? []) {
      state.parser.feed(canonical + "\n", state.onLine);
    }
  }
}

/** Whether the exit reads as failed: killed, a parser error stop, or a non-zero code with no
 * final text. */
function closeFailed(state: RunSettleState, code: number | null, killed: boolean): boolean {
  return (
    killed ||
    state.parser.stopReason === "error" ||
    (code !== 0 && !state.parser.finalText.trim())
  );
}

/** Whether the exit is a permanent config error — a non-killed exit with no transient pi crash
 * and no backend kind, whose parser flag or backend classification say config error. */
function closeConfigError(state: RunSettleState, cls: AgentExitClassification, killed: boolean): boolean {
  return (
    !killed &&
    cls.transientPiCrash !== true &&
    cls.backendKind === undefined &&
    (state.parser.configError || cls.configError === true)
  );
}

/** The run's `close` event: the process died and all its streams closed. Flush what the
 * decoders held back, reconcile the backend's post-run work, classify the exit cause, and
 * settle the run's result. */
export function settleClose(state: RunSettleState, code: number | null): void {
  const { backend } = state;
  flushRunTail(state);
  // A blind image read on an authoring run deliberately killed it, so its exit is a kill like
  // the watchdogs' — the half-done work is discarded.
  const killed = state.wasKilled();
  reconcileBackendAfterRun(state, killed);
  const failed = closeFailed(state, code, killed);
  // The backend classifies the exit's stderr (pi: the transient JSON-parse crash, a
  // provider-wide backend failure, a permanent config error). The runner merges that with the
  // parser's own event-derived flags — one exit has one cause.
  const stderr = state.stderr();
  const cls = backend.classifyExit({ code, stderr, killed });
  const stderrBackend = cls.backendKind;
  const configError = closeConfigError(state, cls, killed);
  const blindRead = state.blindRead();
  const errorMessage = settleErrorMessage(state, blindRead, failed, stderr, code);
  state.finish(
    resultFromParser(state, {
      ok: !failed,
      transientPiCrash: cls.transientPiCrash === true,
      transientBackend: state.parser.transientBackend || cls.transientBackend === true,
      backendKind: state.parser.backendFailureKind ?? stderrBackend,
      configError,
      // Kept distinct on purpose: a hung tool call leaves its session and worktree edits
      // intact, so the runner resumes them (quiet_killed) instead of discarding them as an
      // unfulfilled timeout does. A deadline that fired on a run still making progress gets
      // the same treatment (BUGS.md 2026-09-29).
      timedOut: state.wd.timedOut,
      timedOutProgressing: state.wd.timedOut && state.wd.timedOutProgressing,
      quietKilled: state.wd.quietKilled,
      imageBlind: state.parser.imageBlind,
      errorMessage,
    }),
  );
}
