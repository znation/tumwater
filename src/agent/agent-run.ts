/** The backend-neutral agent runner (plans/agent-backends.md \"The seam\"): everything a run
 * needs regardless of which agent it drives — the watchdog wiring, abort, and stderr capture.
 * The backend (src/agent/agent-backend.ts, with
 * pi in src/pi/pi-backend.ts) provides the argv/stdin/env, the native-to-canonical stdout
 * translator, the stderr warning
 * matcher, and the exit classification. This file keeps the coordinator — setup, the watchdog
 * wiring, abort, the child's stream-attachment and the settlement-state assembly — and
 * delegates the build-and-spawn stage (the marker,
 * parser, bin resolution, `prepare`, invocation and spawn) to src/agent/agent-spawn.ts, the
 * streaming pipeline (native-to-canonical stdout split, the stderr window, the stream-minted
 * session record and the settle/flush) to src/agent/agent-stream.ts, and the post-run settlement
 * (spawn-error result, exit orphan sweep, close-time reconcile and
 * classify) to src/agent/agent-settle.ts. `runPi` (src/pi/pi.ts) is the thin alias the existing
 * call sites use, so a caller and its fakes are untouched by this split. */

import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StringDecoder } from "node:string_decoder";
import type { ResolvedModelConfig } from "../config/config-views.js";
import { ensureDir, removeTree } from "../files/files.js";
import type { ResolvedBackendBin } from "../pi/pi-bin.js";
import { runOnAbort, terminateChild } from "../process/process.js";
import type { PiRunKind } from "../pi/pi-event-line.js";
import type { PiStreamParser } from "../pi/pi-stream.js";
import { startPiWatchdogs } from "../pi/pi-watchdogs.js";
import type { PiRunResult } from "../pi/pi-run-result.js";
import { DEFAULT_BACKEND, backendById, registerAgentBackend, type AgentBackend, type AgentInvocation, type AgentRunSpec, type StreamTranslator } from "./agent-backend.js";
import { errorMessage } from "../text/text.js";
import { piBackend } from "../pi/pi-backend.js";
import { claudeBackend } from "./claude/claude-backend.js";
import { codexBackend } from "./codex/codex-backend.js";
import { opencodeBackend } from "./opencode/opencode-backend.js";
import { setupFailureResult, settleClose, settleError, settleExit } from "./agent-settle.js";
import { openAppendLog, spawnPiRun, type AppendLog, type SpawnedRun } from "./agent-spawn.js";
import { createAgentStream } from "./agent-stream.js";

// The streaming pipeline's over-long-native-line cap stays reachable from here, the historical
// home the test suite still imports it from, even though the value now lives in agent-stream.ts.
export { MAX_NATIVE_LINE_CHARS } from "./agent-stream.js";

// The seam's adapters. Registering here — where the lookup happens — keeps the registration
// explicit and lets a test register a fake under its own id.
registerAgentBackend(piBackend);
registerAgentBackend(claudeBackend);
registerAgentBackend(opencodeBackend);
registerAgentBackend(codexBackend);

/** The live state a running agent shares with the settlement half (src/agent/agent-settle.ts):
 * what the `error`/`exit`/`close` handlers agent-settle owns read at the moment their event
 * fires. agent-run constructs it (the getters read through to the run's still-mutating feed
 * state — the stderr buffer, the fallback-clone flag, the settled/aborted/blind-read flags and
 * the kill classification), and agent-settle imports only this type, so there is no runtime
 * import cycle: agent-run imports agent-settle's handlers at runtime and agent-settle imports
 * nothing of agent-run's runtime surface. */
export interface RunSettleState {
  child: ChildProcess;
  resolved: ResolvedBackendBin;
  backend: AgentBackend;
  runMarker: string;
  parser: PiStreamParser;
  translator: StreamTranslator;
  decoder: StringDecoder;
  wd: ReturnType<typeof startPiWatchdogs>;
  finish: (result: PiRunResult) => void;
  feedCanonical: (text: string, final?: boolean) => void;
  onLine: (line: string) => void;
  runSpec: AgentRunSpec;
  invocation: AgentInvocation;
  stderr: () => string;
  fallbackClone: () => string | undefined;
  settled: () => boolean;
  blindRead: () => string | undefined;
  aborted: () => boolean;
  wasKilled: () => boolean;
  kind: PiRunKind;
  config: ResolvedModelConfig;
  onLeftoversSwept?: (message: string) => void;
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
   * for config.toolCallStallSeconds, and once per model request left unanswered that long: the
   * harness logs a warning event naming the command or the model while the quiet watchdog
   * still counts down (the dashboards derive their own flags from the raw log, so only the
   * event needs wiring). */
  onStallWarning?: (message: string) => void;
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
  /** The role notes this run may write through the `tumwater-notes` command on PATH,
   * exported to the child as TUMWATER_NOTES_PATH. Only authoring runs set it (RunnerPi.
   * runAuthoringPi); review, merge, and conflict-resolution runs leave it unset, so the
   * command refuses to write there. Undefined: no notes. */
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
 * Never throws: a setup failure (session dir, log file, scratch dir) resolves as a failed run
 * whose errorMessage names it. */
export function runAgent(opts: PiRunOptions): Promise<PiRunResult> {
  // An async executor so a backend's `prepare` step (the codex write guard resolving its trust
  // by spawning app-server) can be awaited before the synchronous invocation is built. A
  // `prepare` throw is caught and warned, never rejecting the run; a synchronous throw in the
  // build-and-spawn stage below (e.g. claude's invocation rejecting a run with no model)
  // rejects the run, matching what the Promise constructor did for a throw from a synchronous
  // executor.
  return new Promise(async (resolve, reject) => {
    // The `agent` selector is optional: default to pi, the historical backend. An unregistered
    // id also falls back to pi rather than rejecting the run.
    const backend = backendById(opts.config.agent ?? DEFAULT_BACKEND) ?? piBackend;
    let rawLog: AppendLog | undefined;
    let nativeLog: AppendLog | undefined;
    let runTmp: string;
    try {
      ensureDir(opts.sessionDir);
      // A broken raw log (EACCES, ENOSPC) must not crash the process on an unhandled 'error'
      // nor hang the run: openAppendLog marks it so finish() resolves without waiting for a
      // 'finish' that will never come — a lost transcript is acceptable, a stuck runner is not.
      rawLog = openAppendLog(opts.rawLogFile, opts.config.logMaxBytes);
      // The backend-native stdout, kept beside the canonical raw log for debugging: every
      // complete native line is written before it is translated, so the two logs line up. A
      // broken native log degrades to a lost debug log, never a stuck or failed run.
      nativeLog = openAppendLog(opts.nativeLogFile, opts.config.logMaxBytes);
      // A private TMPDIR per run: concurrent agents default to literal /tmp names, and a shared
      // per-user TMPDIR would still collide. Removed when the run settles.
      runTmp = fs.mkdtempSync(path.join(os.tmpdir(), "tumwater-run-"));
    } catch (err) {
      // Nothing is spawned yet: close what opened and fail the run instead of rejecting it.
      rawLog?.stream.end();
      nativeLog?.stream.end();
      resolve(setupFailureResult(backend.id, `could not prepare the agent run: ${errorMessage(err)}`));
      return;
    }
    try {
    // The whole build-and-spawn stage — the marker write, parser construction, run marker,
    // backend-bin resolution, notes shim, run spec, the backend's optional `prepare`, the
    // session-ledger record, translator/decoders, and the child spawn — now lives in
    // spawnPiRun (src/agent/agent-spawn.ts) and returns the SpawnedRun bundle. A synchronous
    // throw anywhere in it (a broken marker write, parser construction, backend.resolveBin,
    // claude's invocation rejecting a run with no model) propagates out of the await and is
    // rejected by the catch below, matching what a synchronous executor's throw used to get
    // from the Promise constructor.
    // A backend without a `prepare` step (pi, claude, opencode) builds and spawns synchronously
    // and hands the bundle straight back, so the `instanceof` below takes the sync leg and the
    // watchdogs (a setInterval registration) start in the same synchronous step the logical-clock
    // watchdog tests pin (they advance the fake clock immediately after runPi returns). A backend
    // WITH a `prepare` (codex) returns a promise that resolves after its trust is settled.
    const spawnedResult = spawnPiRun(backend, { raw: rawLog }, runTmp, opts);
    const spawned: SpawnedRun = spawnedResult instanceof Promise ? await spawnedResult : spawnedResult;
    // Bind the coordinator's objects from the bundle, then hand the stream-side objects (parser,
    // translator, decoders) to createAgentStream below, which owns them with the pipeline.
    const child = spawned.child;
    const resolved = spawned.resolved;
    const runSpec = spawned.runSpec;
    const invocation = spawned.invocation;
    const parser = spawned.parser;
    const translator = spawned.translator;
    const decoder = spawned.decoder;
    const runMarker = spawned.runMarker;
    const blindRead = spawned.blindRead;

    // The run's two watchdog clocks (src/pi/pi-watchdogs.ts): the run deadline and the quiet
    // watchdog (quiet-kill plus the stalled-tool-call warning). The flags their timers set
    // (timedOut/timedOutProgressing/quietKilled/sawOutput) read live off the returned handle.
    const wd = startPiWatchdogs({
      progressCount: () => parser.progressCount,
      openToolCalls: () => parser.openToolCalls,
      pendingReply: () => parser.pendingReply,
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
      onStallWarning: opts.onStallWarning,
    });

    let aborted = false;
    // A blind image read on an authoring run deliberately kills it, like the watchdogs do.
    const wasKilled = (): boolean => aborted || wd.timedOut || wd.quietKilled || blindRead() !== undefined;
    const onAbort = () => {
      aborted = true;
      terminateChild(child);
    };
    runOnAbort(opts.signal, onAbort);

    // The streaming pipeline — native-to-canonical stdout split with the over-long-line
    // discard, the stderr window and its fallback-clone warning matcher, the stream-minted
    // session's second ledger record, and the settle/flush that resolves the run — now lives
    // in src/agent/agent-stream.ts behind the AgentStream interface. agent-run only wires the
    // child's `data` events to it and binds its getters into the settlement state below.
    const stream = createAgentStream({
      opts,
      backend,
      spawned,
      wd,
      onAbort,
      rawLog,
      nativeLog,
      runTmp,
      resolve,
    });
    child.stdout?.on("data", (chunk: Buffer) => stream.feedStdout(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stream.feedStderr(chunk));

    // The run state the settlement-half handlers (agent-settle.ts) read when their event
    // fires. The getters read through to the run's still-mutating feed state, so a handler
    // sees the current value rather than a snapshot taken when its listener was registered.
    const state: RunSettleState = {
      child,
      resolved,
      backend,
      runMarker,
      parser,
      translator,
      decoder,
      wd,
      finish: stream.finish,
      feedCanonical: stream.feedCanonical,
      onLine: stream.onLine,
      runSpec,
      invocation,
      stderr: stream.stderr,
      fallbackClone: stream.fallbackClone,
      settled: stream.settled,
      blindRead: () => blindRead(),
      aborted: () => aborted,
      wasKilled: () => wasKilled(),
      kind: opts.kind,
      config: opts.config,
      onLeftoversSwept: opts.onLeftoversSwept,
    };

    child.on("error", (err) => {
      settleError(state, err);
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
      settleExit(state);
    });

    child.on("close", (code) => {
      settleClose(state, code);
    });
    } catch (err) {
      // A synchronous throw in the run's build-and-spawn stage (claude's invocation rejects a
      // run with no resolved model) rejects the run, preserving the contract a synchronous
      // executor's throw used to get from the Promise constructor. No child was spawned, so no
      // `error`/`close` ever fires and the settle path that removes the private TMPDIR
      // (agent-stream.ts's finish) never runs — remove it here, best-effort like finish does, so
      // a broken run does not leave a `tumwater-run-*` temp dir behind.
      try {
        removeTree(runTmp);
      } catch {
        /* left for the OS temp sweep */
      }
      // The two append-log streams opened before the build-and-spawn stage (the raw and
      // backend-native transcripts) are never handed to a stream-settlement path on this throw
      // — there is no child and no finish(), so nothing else would ever end them — end them
      // here best-effort (the same cleanup the outer setup-failure catch makes) or every
      // rejected run leaks two open transcript descriptors that accumulate in the
      // long-lived orchestrator process.
      try {
        rawLog?.stream.end();
        nativeLog?.stream.end();
      } catch {
        /* best-effort */
      }
      reject(err instanceof Error ? err : new Error(`runAgent: ${String(err)}`));
    }
  });
}

/** The historical name for the neutral runner: every existing call site, fake, and test keeps
 * calling `runPi`. */
export const runPi = runAgent;
