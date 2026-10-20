// vocabulary: plain
/** The backend-neutral agent runner (plans/agent-backends.md \"The seam\"): everything a run
 * needs regardless of which agent it drives — the spawn, the `tumwater_run` raw-log marker,
 * the watchdog wiring, abort, the group kill and marker sweep, stderr capture, and result
 * assembly. The backend (src/agent/agent-backend.ts, with pi in src/pi/pi-backend.ts) supplies
 * the argv/stdin/env, the native-to-canonical stdout translator, the stderr warning matcher,
 * and the exit classification. `runPi` (src/pi/pi.ts) is the thin alias the existing call sites
 * use, so a caller and its fakes are untouched by this split. */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ResolvedModelConfig } from "../config/config-views.js";
import { ensureDir, ensureParentDir, rotateIfLarge } from "../files/files.js";
import { agentBinConfigKey, agentBinSourceLabel, type ResolvedAgentBin } from "../pi/pi-bin.js";
import { runOnAbort, terminateChild } from "../process/process.js";
import { leftoversSweptMessage, makeRunMarker, sweepRunMarker } from "../process/run-marker.js";
import type { PiRunKind } from "../pi/pi-event-line.js";
import { PiStreamParser } from "../pi/pi-stream.js";
import { startPiWatchdogs } from "../pi/pi-watchdogs.js";
import type { PiRunResult } from "../pi/pi-run-result.js";
import { DEFAULT_AGENT, agentBackend, registerAgentBackend, type AgentBackend, type AgentRunSpec } from "./agent-backend.js";
import { recordSession } from "./session-ledger.js";
import { piBackend } from "../pi/pi-backend.js";
import { claudeBackend } from "./claude/claude-backend.js";
import { opencodeBackend } from "./opencode/opencode-backend.js";
import { seamImageInput } from "./image-input.js";
import { ensureNotesShim } from "./notes-shim.js";
import { nearestTumwaterRoot } from "../paths.js";
import { piModelsPath, readPiProviders } from "../pi/pi-models.js";

/** How many trailing stderr characters are carried into the next chunk's warning match, so a
 * warning split across two `data` events is still seen. The warnings are short lines, so a few
 * hundred characters always cover a straddle. */
const STDERR_MATCH_TAIL = 512;

/** The largest native stdout line the runner will buffer. A complete native event is one JSON
 * object; a line this long is already at the default whole-log cap (`logMaxBytes`, 16 MiB), so
 * continuing to buffer it can only be a malformed stream. Past it `feedCanonical` drops the
 * buffered line and skips input to the next newline, so a backend that streams bytes with no
 * newline — each byte resetting the quiet watchdog — cannot grow the buffer until the run
 * timeout (4 h by default) exhausts the harness's memory. */
export const MAX_NATIVE_LINE_CHARS = 16 * 1024 * 1024;

// The seam's adapters. Registering here — where the lookup happens — keeps the registration
// explicit and lets a test register a fake under its own id.
registerAgentBackend(piBackend);
registerAgentBackend(claudeBackend);
registerAgentBackend(opencodeBackend);

/** Prefix of PiRunResult.errorMessage when the agent process never started (no session file
 * is created for such a run). The resolved binary follows it, so a configured agentBin
 * reads "failed to spawn <bin>" rather than blaming an ambient "pi". */
const SPAWN_ERROR_PREFIX = "failed to spawn";

/** The spawn-error message for a resolved binary: the default source keeps today's text
 * ("failed to spawn pi: …"); a configured source names the binary and where it came from —
 * the backend's own env var and config key (agentBinConfigKey) — so a wrong
 * `backends.claude.bin` does not read as pi's legacy `agentBin`. */
function spawnErrorMessage(
  resolved: ResolvedAgentBin,
  errMessage: string,
  backend: AgentBackend,
): string {
  const source =
    resolved.source === "default"
      ? ""
      : ` (resolved from ${agentBinSourceLabel(resolved.source, backend.binEnv, agentBinConfigKey(backend.id))})`;
  return `${SPAWN_ERROR_PREFIX} ${resolved.bin}${source}: ${errMessage}`;
}

/** A best-effort append log: its parent is created and it is rotated when oversized before the
 * stream opens, and an 'error' event (EACCES, ENOSPC) flips `broken` so the caller can skip
 * waiting on a 'finish' that will never come. A broken log degrades to a lost log, never an
 * unhandled 'error' or a stuck run. Both the raw transcript and the backend-native debug log
 * use one. */
interface AppendLog {
  stream: fs.WriteStream;
  broken: boolean;
}

function openAppendLog(file: string, maxBytes: number): AppendLog {
  ensureParentDir(file);
  rotateIfLarge(file, maxBytes);
  const log: AppendLog = { stream: fs.createWriteStream(file, { flags: "a" }), broken: false };
  log.stream.on("error", () => {
    log.broken = true;
  });
  return log;
}

/** Options for one non-interactive agent run (runAgent / its runPi alias). Exported so a caller
 * that builds the same wiring in several places (runner-pi.ts's author run and SUMMARY follow-up)
 * can share one construction helper typed against this exact shape. */
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
   * of an agent run a harness interruption cut short (src/run/run-resume.ts's `resuming`).
   * Every other agent run starts a fresh session, so context never accumulates across them. */
  continueSession?: boolean;
  /** Raw pi JSON event lines are appended here for observability. */
  rawLogFile: string;
  /** The backend's native stdout lines (before translation) are appended here for debugging
   * (nativeLogPath). Written and rotated like rawLogFile; a broken native log is non-fatal
   * exactly as a broken raw log is. */
  nativeLogFile: string;
  signal?: AbortSignal;
  /** Which kind of run this is: the authoring run ("author") or the review/merge
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
  /** Called once after the end-of-run sweep when a run tumwater did not kill left marked
   * processes running, with the warning naming the run kind and the count signaled. */
  onLeftoversSwept?: (message: string) => void;
  /** Called once per translator warning after the run ends — a native event type the backend
   * could not map, and a result-less run's `cost_unknown` — and once mid-run when an over-long
   * native line (MAX_NATIVE_LINE_CHARS with no newline) is discarded, so the caller can surface
   * each in the event feed. A fully-mapped run reports none. */
  onAgentWarning?: (warning: string) => void;
  /** Called once per tool call as it starts, with pi's tool name and raw args (see
   * PiStreamParser) — the review gate collects its reviewer's calls through this to notice a
   * full-suite re-run the harness's green pre-check made redundant. */
  onToolCallStart?: (toolName: string, args: unknown) => void;
  /** The role notebook this run may write through the `tumwater-notes` command on PATH,
   * exported to the child as TUMWATER_NOTES_PATH. Only authoring runs set it (RunnerPi.
   * runAuthoringPi); review, merge, and conflict-resolution runs leave it unset, so the
   * command refuses to write there. Undefined: no notebook. */
  notesPath?: string;
  /** Called at settle when this run read an image its model cannot see (plans/image-input.md
   * "Detecting a blind read") — the caller's hook to log the `image_blind` event with its own
   * role/run context. The action follows the run's kind: an authoring run was killed and
   * carries `"fail"`, a gate run only records the read and carries `"logged"`. Called once,
   * with the blameable path. */
  onBlindRead?: (path: string, action: "fail" | "logged") => void;
  /** The remaining daily budget this run may spend, in USD, when the caller can cap it
   * (plans/agent-backends.md §7): the claude backend forwards it as `--max-budget-usd`, and
   * backends with no such flag ignore it. Undefined means no per-run cap. */
  maxBudgetUsd?: number;
}

/** Run the configured agent backend non-interactively in a worktree and distill the result.
 * Never throws. */
export function runAgent(opts: PiRunOptions): Promise<PiRunResult> {
  return new Promise((resolve) => {
    // The `agent` selector is optional: default to pi, the historical backend. An unregistered
    // id also falls back to pi rather than rejecting the run.
    const backend = agentBackend(opts.config.agent ?? DEFAULT_AGENT) ?? piBackend;
    ensureDir(opts.sessionDir);
    // A broken raw log (EACCES, ENOSPC) must not crash the process on an unhandled 'error'
    // nor hang the run: openAppendLog marks it so finish() resolves without waiting for a
    // 'finish' that will never come — a lost transcript is acceptable, a stuck runner is not.
    const rawLog = openAppendLog(opts.rawLogFile, opts.config.logMaxBytes);
    // The backend-native stdout, kept beside the canonical raw log for debugging: every
    // complete native line is written before it is translated, so the two logs line up. A
    // broken native log degrades to a lost debug log, never a stuck or failed run.
    const nativeLog = openAppendLog(opts.nativeLogFile, opts.config.logMaxBytes);
    // The marker precedes this run's first event in file order — written to the same stream
    // stdout lines flow through, before spawn, so ordering is exact by construction; on a
    // failed spawn finish() still ends the stream and flushes it. Exactly one per run: the
    // kind, agent and start time are always there, the label only when the caller set one
    // (`history <role> <n> --transcript` selects a run's segments by this ts).
    {
      const marker: { type: "tumwater_run"; kind: PiRunKind; agent: string; ts: number; label?: string } = {
        type: "tumwater_run",
        kind: opts.kind,
        agent: backend.id,
        ts: Date.now(),
      };
      if (opts.label) marker.label = opts.label;
      rawLog.stream.write(JSON.stringify(marker) + "\n");
    }
    // The first blind image read an authoring run made (plans/image-input.md "Detecting a
    // blind read"): the path, plus an indirection to the child so the parser's parse-time
    // callback (which fires during feed, after spawn) can kill it. Unset for a gate run,
    // which only records the read. Declared before the parser so its onBlindRead closure
    // (which assigns them at parse time, after spawn) can reference them.
    let blindRead: string | undefined;
    let terminateRun: (() => void) | undefined;
    const parser = new PiStreamParser(opts.onToolCallStart, {
      // The seam's effective image input (src/agent/image-input.ts): a text-only seam makes
      // every image read blind even when pi adds no note — a claim its doctor probe proved
      // false — which the parser checks against its own note rule.
      imageInput: seamImageInput(opts.config, readPiProviders(piModelsPath())),
      onBlindRead: (path) => {
        // Kill an authoring run at once, before the agent goes on working from a picture it
        // never saw (terminateChild is what the watchdogs use). Gate runs (reviewer,
        // resolver) only record the read and keep going.
        if (opts.kind === "author") {
          blindRead = path;
          terminateRun?.();
        }
      },
    });
    // The run's cross-group attribution mark, minted before the spawn so the environment can
    // carry it and the exit sweep can name it.
    const runMarker = makeRunMarker();
    const resolved = backend.resolveBin(opts.config);
    // Install the notes shim under the team root's `.tumwater/bin` so every backend's run finds
    // `tumwater-notes` first on PATH (notes-shim.ts). A failure to write it logs one warning and
    // the run goes on without it — notes would then be unwritable by the command, but the run
    // itself is not blocked.
    let binDir: string | undefined;
    try {
      // Install the shim only under a real team root — the nearest ancestor holding a
      // `.tumwater`. A session dir with no such ancestor (a lab script, a smoke run, a
      // prompt-lab replay) must never mint one: nearestTumwaterRoot is undefined then, and the
      // run goes on without the shim, exactly as if the install had failed — writing
      // `<fallback>/.tumwater` from a run created a phantom harness root in a shared directory
      // and broke every other suite on the host (BUGS.md 2026-10-18).
      const root = nearestTumwaterRoot(opts.sessionDir);
      if (root !== undefined) binDir = ensureNotesShim(root);
    } catch {
      opts.onAgentWarning?.("could not install the tumwater-notes shim; this run will not find tumwater-notes on PATH");
    }
    const runSpec: AgentRunSpec = {
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
      ...(binDir !== undefined ? { binDir } : {}),
      ...(opts.maxBudgetUsd !== undefined ? { maxBudgetUsd: opts.maxBudgetUsd } : {}),
    };
    const invocation = backend.invocation(runSpec);
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
    // `nativeOverflow` marks a buffered line that passed MAX_NATIVE_LINE_CHARS without a newline:
    // its remainder is skipped to the next newline so it can never be mistaken for an event.
    let nativeTail = "";
    let nativeOverflow = false;

    // A private TMPDIR per run: concurrent agents default to literal /tmp names, and a shared
    // per-user TMPDIR would still collide. Removed when the run settles.
    const runTmp = fs.mkdtempSync(path.join(os.tmpdir(), "tumwater-run-"));
    const child = spawn(resolved.bin, invocation.args, {
      cwd: opts.cwd,
      // A backend that feeds the prompt on stdin (every registered one) gets a pipe the runner
      // writes and ends below; one that returns no stdin keeps stdio[0] "ignore".
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
      env: { ...invocation.env, TMPDIR: runTmp },
    });
    if (invocation.stdin !== undefined) {
      // A backend that dies before draining its stdin — an immediately-failing startup such as
      // an unknown flag, an unresumable session, or a not-logged-in exit — leaves this write
      // nothing to feed. Once the prompt exceeds the OS pipe buffer the write then fails EPIPE,
      // and an unhandled 'error' event on the stdin stream is thrown from the event loop and
      // takes the whole process (the whole team) down. The child's own exit status and stderr
      // already report why the run died, so swallowing the failed write adds no silence the
      // caller needs to break; git.ts's patchId carries the same guard for a patch-id that
      // dies before reading its input.
      child.stdin?.on("error", () => {});
      child.stdin?.end(invocation.stdin);
    }
    // Armed now that the child exists, so the parser's parse-time onBlindRead (fires during
    // feed, always after spawn) can reach it.
    terminateRun = () => terminateChild(child);

    // The run's two watchdog clocks (src/pi/pi-watchdogs.ts): the run deadline and the quiet
    // watchdog (quiet-kill plus the stalled-tool-call warning). The flags their timers set
    // (timedOut/timedOutProgressing/quietKilled/sawOutput) read live off the returned handle.
    const wd = startPiWatchdogs({
      progressCount: () => parser.progressCount,
      openToolCalls: () => parser.openToolCalls,
      runTimeoutMs: opts.config.runTimeoutSeconds * 1000,
      quietMs: opts.config.quietTimeoutSeconds * 1000,
      stallMs: Math.max(0, opts.config.toolCallStallSeconds) * 1000,
      // The run's backend id: claude never sends content updates, so the watchdog judges its
      // every open call by the buffered wall-clock threshold (plans/agent-backends.md).
      agent: backend.id,
      // The gate's fresh-session runs (reviewer and conflict resolver) get one deadline
      // extension while they are still making progress: a large diff's review otherwise
      // times out mid-verification and the next attempt re-reads it from scratch
      // (BUGS.md 2026-10-07). Authoring agent runs resume their session on the next one, so one
      // deadline stays right for them.
      extendOnProgress: opts.kind === "gate",
      kill: () => terminateChild(child),
      onToolCallStalled: opts.onToolCallStalled,
    });

    let aborted = false;
    // A blind image read on an authoring run deliberately kills it, like the watchdogs do.
    const wasKilled = (): boolean => aborted || wd.timedOut || wd.quietKilled || blindRead !== undefined;
    const onAbort = () => {
      aborted = true;
      terminateChild(child);
    };
    runOnAbort(opts.signal, onAbort);

    // Quiet watchdog and its stall warning: src/pi/pi-watchdogs.ts.

    const onLine = (line: string) => rawLog.stream.write(line + "\n");
    // Write one complete native line and feed its translation to the parser (which also hands
    // the canonical lines to onLine for the raw log).
    const emitNativeLine = (line: string) => {
      if (!nativeLog.broken) nativeLog.stream.write(line + "\n");
      for (const canonical of translator.translate(line)) parser.feed(canonical + "\n", onLine);
    };
    // Split native stdout into complete lines, translate each, and feed the canonical lines to
    // the parser (which also hands them to onLine for the raw log). A trailing partial native
    // line stays buffered exactly as the parser's own buffer once held it. On the final flush
    // (`final`), a remaining tail is emitted as one line: a backend may close after flushing a
    // complete JSON event but not its newline terminator, and dropping that tail loses the
    // run's authoritative result (cost, final text). A genuinely truncated fragment parses as
    // no data (parseJsonObject → []), so this can only recover the last event.
    const feedCanonical = (text: string, final = false) => {
      // A buffered overflow: discard this line's remainder up to (and including) its newline, so
      // the stream resynchronizes on the next real event line instead of emitting a truncated one.
      if (nativeOverflow) {
        const nl = text.indexOf("\n");
        if (nl < 0) return;
        nativeOverflow = false;
        text = text.slice(nl + 1);
      }
      nativeTail += text;
      let start = 0;
      for (;;) {
        const nl = nativeTail.indexOf("\n", start);
        if (nl < 0) break;
        emitNativeLine(nativeTail.slice(start, nl));
        start = nl + 1;
      }
      if (start > 0) nativeTail = nativeTail.slice(start);
      if (nativeTail.length > MAX_NATIVE_LINE_CHARS) {
        // No newline within the cap: drop the line and warn. On the final flush there is no
        // remainder to skip, so only the buffer is cleared.
        nativeTail = "";
        if (!final) {
          nativeOverflow = true;
          opts.onAgentWarning?.(
            `native output line exceeded ${MAX_NATIVE_LINE_CHARS / (1024 * 1024)} MiB without a newline and was discarded`,
          );
        }
      } else if (final && nativeTail !== "") {
        emitNativeLine(nativeTail);
        nativeTail = "";
      }
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
      // A blind image read (plans/image-input.md "Detecting a blind read"): surface it to the
      // caller once, at settle, with the action its kind earned — the authoring run was killed
      // ("fail"), a gate run only recorded it ("logged"). The caller logs the image_blind event
      // with its own role/run context.
      if (parser.imageBlind) {
        opts.onBlindRead?.(parser.imageBlind.path, opts.kind === "author" ? "fail" : "logged");
      }
      // Best-effort: an unremovable scratch dir (read-only subdir, a straggler still writing) must
      // not throw out of the close handler before the run's result resolves.
      try {
        fs.rmSync(runTmp, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        /* left for the OS temp sweep */
      }
      wd.stop();
      opts.signal?.removeEventListener("abort", onAbort);
      // Surface the translator's per-run warnings once, after all native lines were fed.
      for (const warning of translator.warnings?.() ?? []) opts.onAgentWarning?.(warning);
      // Resolve only once the logs have flushed: writes complete on libuv's threadpool, so
      // resolving before 'finish' can leave the tail of <role>.pi.jsonl (or the native log)
      // unwritten — a run that dies right after runAgent settles (an abort during a restart
      // drain, a supervisor swap) loses its last lines. end()'s callback fires on 'finish';
      // if a stream errors instead it never does, so settle from 'error' too — a broken log
      // degrades to a lost log, never a stuck run.
      let resolved = false;
      const settle = () => {
        if (!resolved) {
          resolved = true;
          resolve(result);
        }
      };
      let pending = 0;
      const flushed = () => {
        pending -= 1;
        if (pending === 0) settle();
      };
      for (const log of [rawLog, nativeLog]) {
        log.stream.on("error", settle);
        if (!log.broken) {
          pending += 1;
          log.stream.end(flushed);
        }
      }
      if (pending === 0) settle();
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
          errorMessage: spawnErrorMessage(resolved, err.message, backend),
        }),
      );
    });

    // Sweep the run however it ended, a normal exit included, in two passes:
    //
    // 1. The group pi led: pi exits before its orphans — a tool call's `(server &)` or
    //    `cd … && server &` is reparented to PID 1 but stays in pi's group — and the harness
    //    cannot rely on the model's own cleanup (BUGS.md 2026-09-23: qa's unauthenticated
    //    `gui --all-interfaces` listened on the LAN for 7.5 hours after a run that ended
    //    "Everything checked out"). On 'exit', not 'close': pi has just been reaped, so the
    //    pgid still names only its group (never reissued while a member lives), and an orphan
    //    holding pi's stdio open dies now instead of holding 'close' — and the run — open.
    //    Synchronous, so it adds nothing to the run's resolution; on the kill paths it
    //    re-sends a SIGTERM the group already had.
    //
    // 2. The marker sweep: pi 0.87.1's bash tool starts every command detached, in its own
    //    process group, so whatever a tool call backgrounds sits in a group whose leader is
    //    not pi and pass 1 never reaches it (BUGS.md 2026-09-30 — leaked servers and test
    //    workers outlived their runs by hours). Every process the run started carries the
    //    run's TUMWATER_RUN mark in its environment, so the same-user scan finds them
    //    wherever they were reparented. Fire-and-forget: one process-table scan, never
    //    awaited — the run resolves on pi's output, and the sweep's own SIGKILL escalation
    //    (10 s) is unref'd like signalTree's.
    child.on("exit", () => {
      terminateChild(child);
      void sweepRunMarker(runMarker)
        .then((n) => {
          const msg = leftoversSweptMessage(opts.kind, n, wasKilled());
          if (msg) opts.onLeftoversSwept?.(msg);
        })
        .catch(() => {});
    });

    child.on("close", (code) => {
      // Flush any bytes the decoder held back at stream end and any unterminated final line
      // so the tail is not lost, then let the translator flush its own pending canonical
      // line(s) — a batching backend's unclosed last assistant message, which a killed run
      // never closes with a later event.
      feedCanonical(decoder.end(), true);
      for (const canonical of translator.finalize?.() ?? []) parser.feed(canonical + "\n", onLine);
      // A blind image read on an authoring run deliberately killed it (terminateRun above),
      // so its exit is a kill like the watchdogs' — the half-done work is discarded.
      const killed = wasKilled();
      // The backend's post-run reconciliation (opencode's authoritative session export), only
      // when the run is not already settled (a failed spawn settles in the 'error' handler
      // before 'close') and was not killed — a killed run's session is half-done and no export
      // should spend its 10 s on it. Its lines are written and parsed like streamed ones, so
      // they reach the raw log and the parser's authoritative fold (run_cost/run_usage).
      if (!settled && !killed) {
        for (const canonical of backend.afterRun?.(runSpec, invocation, translator) ?? []) {
          parser.feed(canonical + "\n", onLine);
        }
      }
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
      // The blind-read failure names both the file and the model (plans/image-input.md
      // "Failing the run"): take it over any generic exit text so lastError is actionable.
      const errorMessage = blindRead !== undefined
        ? `read ${blindRead}, but ${opts.config.model ?? "the model"} cannot read images`
        : aborted
          ? "stopped by tumwater shutdown"
          : wd.quietKilled
            ? `killed as hung: no agent progress for over ${opts.config.quietTimeoutSeconds}s`
            : wd.timedOut
              ? wd.timedOutProgressing
                ? `timed out after ${wd.timeoutBudgetMs / 1000}s while still making progress — session and worktree edits preserved for resume`
                : `timed out after ${wd.timeoutBudgetMs / 1000}s`
              : (parser.errorMessage ?? (failed ? stderr.trim().slice(-500) || `the agent exited ${code}` : undefined));
      finish(
        resultFromParser({
          ok: !failed,
          transientPiCrash: cls.transientPiCrash === true,
          transientBackend: parser.transientBackend || cls.transientBackend === true,
          backendKind: parser.backendFailureKind ?? stderrBackend,
          configError,
          // Kept distinct on purpose: a hung tool call leaves its session and worktree edits
          // intact, so the runner resumes them (quiet_killed) instead of discarding them as an
          // unfulfilled timeout does. A deadline that fired on a run still making progress
          // gets the same treatment (BUGS.md 2026-09-29).
          timedOut: wd.timedOut,
          timedOutProgressing: wd.timedOut && wd.timedOutProgressing,
          quietKilled: wd.quietKilled,
          imageBlind: parser.imageBlind,
          errorMessage,
        }),
      );
    });
  });
}

/** The historical name for the neutral runner: every existing call site, fake, and test keeps
 * calling `runPi`. */
export const runPi = runAgent;
