import { spawn } from "node:child_process";
import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import type { TumwaterConfig } from "./config-schema.js";
import { ensureDir, ensureParentDir, rotateIfLarge } from "./files.js";
import { agentBinSourceLabel, resolveAgentBin, type ResolvedAgentBin } from "./readiness.js";
import { terminateChild, withoutLaunchServicesCheckIn } from "./process.js";
import { makeRunMarker, runMarkerEnv, sweepRunMarker } from "./run-marker.js";
import { piArgs } from "./pi-args.js";
import { PiStreamParser, STREAM_SEVERED } from "./pi-stream.js";
import type { PiRunResult } from "./pi-run-result.js";
import { commandBuffersOutput } from "./command-shape.js";
export type { BackendFailureKind } from "./pi-stream.js";

/** pi crashing on malformed JSON, as Node's JSON.parse phrases it on pi's stderr — five ticks in
 * the first 18 days died this way (one of them 2 h 39 m of director work on a fresh steering
 * prompt), each traced to a torn chunk from the model server rather than to the session. Matched
 * against the child's stderr at exit; exported for tests. */
export const TRANSIENT_PI_CRASH =
  /Unexpected end of JSON input|is not valid JSON|(Unterminated string|Unexpected non-whitespace|Expected ('|")|Bad (control|escaped) character)[^\n]* in JSON/;

/** Options for one non-interactive pi run (runPi). Exported so a caller that builds the
 * same wiring in several places (loop.ts's author run and SUMMARY follow-up) can share one
 * construction helper typed against this exact shape. */
export interface PiRunOptions {
  cwd: string;
  prompt: string;
  config: TumwaterConfig;
  sessionDir: string;
  sessionName: string;
  /** Resume the most recent session in sessionDir instead of starting fresh. Two users, both
   * within-tick: the transient retry (so the retry keeps the first attempt's partial progress)
   * and the review gate's verdict-recovery follow-up, which continues the just-finished
   * review's session to ask for a missing VERDICT line (src/review.ts, BUGS.md 2026-09-29).
   * Every tick otherwise starts a fresh session, so context never accumulates across ticks. */
  continueSession?: boolean;
  /** Raw pi JSON event lines are appended here for observability. */
  rawLogFile: string;
  signal?: AbortSignal;
  /** Label this run in the role's transcript (the review gate passes "review"): one compact
   * marker line is written to the raw log before any of pi's output, so every transcript
   * surface renders a labeled separator for it. No label → no write — author-run logs stay
   * byte-identical to today's shape. */
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
}

/** True when `sessionDir` holds at least one pi session file for --continue to resume.
 * Guards the resume-after-shutdown path: with nothing to resume (sessions pruned, or the
 * aborted run died before pi created one), the tick falls back to a fresh start. */
export function hasResumableSession(sessionDir: string): boolean {
  try {
    return fs.readdirSync(sessionDir).some((f) => f.endsWith(".jsonl"));
  } catch {
    return false; // Missing directory — nothing to resume.
  }
}

/** Prefix of PiRunResult.errorMessage when the pi process never started (no session file
 * is created for such a run). The resolved binary follows it, so a configured agentBin
 * reads "failed to spawn <bin>" rather than blaming an ambient "pi". */
const SPAWN_ERROR_PREFIX = "failed to spawn";

/** The spawn-error message for a resolved binary: the default source keeps today's text
 * ("failed to spawn pi: …"); a configured source names the binary and where it came from,
 * so a wrong agentBin does not read as "pi is broken". */
function spawnErrorMessage(resolved: ResolvedAgentBin, errMessage: string): string {
  const source =
    resolved.source === "default" ? "" : ` (resolved from ${agentBinSourceLabel(resolved.source)})`;
  return `${SPAWN_ERROR_PREFIX} ${resolved.bin}${source}: ${errMessage}`;
}

/** Run pi non-interactively in a worktree and distill the result. Never throws. */
export function runPi(opts: PiRunOptions): Promise<PiRunResult> {
  return new Promise((resolve) => {
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
    if (opts.label) {
      // The marker precedes this run's first pi event in file order — written to the same
      // stream stdout lines flow through, before spawn, so ordering is exact by construction;
      // on a failed spawn finish() still ends the stream and flushes it.
      rawLog.write(JSON.stringify({ type: "tumwater_run", label: opts.label }) + "\n");
    }
    const parser = new PiStreamParser(opts.onToolCallStart);
    // The run's cross-group attribution mark, minted before the spawn so the environment can
    // carry it and the exit sweep can name it.
    const runMarker = makeRunMarker();
    // Decode stdout incrementally instead of per chunk: a raw Buffer.toString("utf8")
    // replaces any multi-byte character whose bytes straddle two 'data' events with U+FFFD,
    // corrupting that line's text (commit subjects, summaries, transcripts). StringDecoder
    // holds back the incomplete trailing bytes until the next chunk completes them.
    const decoder = new StringDecoder("utf8");
    let stderr = "";
    let timedOut = false;
    let timedOutProgressing = false;
    let settled = false;

    // plans/portability.md §5/7: the agent binary is configurable. resolveAgentBin
    // normalizes path-shaped values to absolute (against the process cwd), so the spawn —
    // which runs with the worktree as cwd — lands on the same file the preflight checked.
    const resolved = resolveAgentBin(opts.config);
    const child = spawn(resolved.bin, [...piArgs({ ...opts, agentBin: resolved.bin }), opts.prompt], {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
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
      env: runMarkerEnv(withoutLaunchServicesCheckIn(process.env), runMarker),
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      // A deadline that fires on a run still making progress killed a slow run, not a hung
      // one: "recent progress" is the same window the quiet watchdog itself honors, so the
      // two watchdogs agree on what a healthy run looks like (BUGS.md 2026-09-29). A run
      // with no progress event at all — never emitted a byte, or bytes without one structured
      // event — keeps today's discard path: it has not demonstrably begun. Callback runs
      // after the sync declarations below, so quietMs/lastProgressAt are initialized here.
      timedOutProgressing = parser.progressCount > 0 && Date.now() - lastProgressAt <= quietMs;
      terminateChild(child);
    }, opts.config.tickTimeoutSeconds * 1000);

    let aborted = false;
    const onAbort = () => {
      aborted = true;
      terminateChild(child);
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();

    // Quiet watchdog: a healthy run makes PROGRESS continuously even when slow — messages
    // start and end, turns and tool calls complete. Prolonged lack of progress means a hung
    // tool (an interactive command waiting for input) or a zombie stream (a dead generation
    // whose connection drips content-free keepalive updates for hours) that would otherwise
    // burn the whole tick timeout. Raw output bytes deliberately do NOT reset the clock:
    // keepalives are bytes without progress. Checked on an interval against the wall clock,
    // so it also fires promptly after a machine sleep rather than pausing with a suspended
    // timer. The stall warning below rides the same interval: it needs no kill of its own,
    // only a periodic look at which open tool calls have gone silent.
    let lastProgressAt = Date.now();
    let lastProgressCount = 0;
    let quietKilled = false;
    const quietMs = opts.config.quietTimeoutSeconds * 1000;
    // A run that has not yet produced progress is starting, not hung: process creation and
    // model connect are legitimately slow on a loaded machine (a full test suite, a busy
    // fleet), and charging that startup latency as pi silence quiet-kills runs that never
    // had the chance to speak (BUGS.md 2026-09-23). The one extra quiet window that fix
    // granted a zero-progress run still false-killed under merge-check load: the kill runs
    // on an interval against the wall clock, so the firing check can predate the child's
    // first bytes entirely — fork/exec starved by the same load, or bytes already written
    // but not yet drained (a firing timer phase precedes the poll phase that delivers
    // stdout, and a suspended machine resumes the same way). The 2026-09-23 fix therefore
    // gave a byte-silent run no quiet kill at all, delegating its bound to the tick timeout
    // — which holds only while tickTimeoutSeconds is near the quiet window's scale (BUGS.md
    // 2026-09-29: the live 54000 s config left a wedged model connection 15 hours in a
    // concurrency slot). A zero-byte run now gets a finite bound of its own, independent of
    // the tick timeout: max(two quiet windows, 30 min). Startup latency under healthy load
    // stays far below it, so the runs the 2026-09-23 fix protected are still protected; a
    // run that is genuinely wedged before its first byte (dead connection, unscheduled
    // fork/exec) is reaped at half an hour instead of at the tick timeout. The false
    // positive it can cost — a machine so loaded the child has not been scheduled in 30
    // minutes — is a quiet kill, which resumes the session and the worktree's edits like
    // an interruption: a restart, not discarded work. Once bytes have flowed the run has
    // begun; bytes without progress keep the doubled window (the zombie-stream case), and
    // once real progress has landed quietTimeoutSeconds applies unchanged.
    let sawOutput = false;
    const zeroByteSilenceMs = Math.max(quietMs * 2, 30 * 60_000);
    const allowedSilenceMs = () =>
      parser.progressCount > 0 ? quietMs : sawOutput ? quietMs * 2 : zeroByteSilenceMs;
    // The stall warning's threshold (distinct from the kill above): one hung tool call is
    // surfaced by name even while sibling calls keep streaming, so total silence is not
    // required. One warning per stalled call — the interval keeps firing until the kill or
    // the call ends.
    const stallMs = Math.max(0, opts.config.toolCallStallSeconds) * 1000;
    const warnedStalledCalls = new Set<string>();
    const checkEveryMs = quietMs > 0 ? quietMs : stallMs;
    const quietCheck =
      checkEveryMs > 0
        ? setInterval(
            () => {
              if (parser.progressCount > lastProgressCount) {
                lastProgressCount = parser.progressCount;
                lastProgressAt = Date.now();
              } else if (quietMs > 0 && Date.now() - lastProgressAt > allowedSilenceMs()) {
                quietKilled = true;
                terminateChild(child);
              }
              if (stallMs > 0) {
                for (const call of parser.openToolCalls) {
                  if (warnedStalledCalls.has(call.id)) continue;
                  // A command whose stdout is piped or redirected holds its bytes away from
                  // pi until it exits, so "no output" there is the prescribed shape, not
                  // evidence of a hang — warn only when silence could mean something
                  // (BUGS.md 2026-09-28: the tick prompt tells every loop to pipe its
                  // verification through `tail`, and the resulting false alarms were the
                  // digest's top warning cluster, drowning real hangs). The call's full raw
                  // command is classified, never its display label: the label truncates at
                  // 32 chars, so an operator past that point would be invisible there.
                  if (commandBuffersOutput(call.command || call.label)) continue;
                  const silentMs = Date.now() - call.lastActivityAt;
                  if (silentMs >= stallMs) {
                    warnedStalledCalls.add(call.id);
                    // Whole minutes read cleaner in the feed; sub-minute thresholds stay in seconds.
                    const silent =
                      silentMs < 60_000
                        ? `${Math.round(silentMs / 1000)}s`
                        : `${Math.round(silentMs / 60_000)}m`;
                    opts.onToolCallStalled?.(`tool call stalled: ${call.label} — no output for ${silent}`);
                  }
                }
              }
            },
            Math.min(Math.max(checkEveryMs / 2, 250), 30_000),
          )
        : undefined;

    child.stdout.on("data", (chunk: Buffer) => {
      sawOutput = true; // any byte ends the starting phase, progress or not
      parser.feed(decoder.write(chunk), (line) => rawLog.write(line + "\n"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      // stderr is rare and meaningful (crash traces, warnings): treat it as progress.
      sawOutput = true;
      lastProgressAt = Date.now();
      stderr += chunk.toString("utf8");
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-64 * 1024);
    });

    const finish = (result: PiRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (quietCheck) clearInterval(quietCheck);
      opts.signal?.removeEventListener("abort", onAbort);
      // Resolve only once the raw log has flushed: writes complete on libuv's threadpool, so
      // resolving before 'finish' can leave the tail of <role>.pi.jsonl unwritten — a tick
      // that dies right after runPi settles (an abort during a restart drain, a supervisor
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
      retryAfterSeconds: parser.retryAfterSeconds,
      transientPiCrash: false,
      finalMessageContentless: parser.finalMessageContentless,
      compacted: parser.compacted,
      ...overrides,
    });

    child.on("error", (err) => {
      finish(resultFromParser({ errorMessage: spawnErrorMessage(resolved, err.message) }));
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
      parser.feed(decoder.end(), (line) => rawLog.write(line + "\n"));
      const failed =
        aborted ||
        timedOut ||
        quietKilled ||
        parser.stopReason === "error" ||
        (code !== 0 && !parser.finalText.trim());
      // A nonzero exit whose stderr ends in a JSON.parse failure is pi dying on a torn server
      // chunk: transient, retryable with --continue (the loop decides). Never set for a run the
      // harness itself killed — those have their own cause.
      const crashed = !aborted && !timedOut && !quietKilled && code !== 0 && TRANSIENT_PI_CRASH.test(stderr);
      // The provider severing the in-flight HTTP stream — undici's bare "terminated" — can
      // arrive on pi's stderr (pi dying on the cut, nonzero exit) as well as in a pi event
      // errorMessage (pi catching it): classify the stderr spelling through the same anchored
      // pattern, so either shape gets the same transientBackend treatment. Never on a run the
      // harness itself killed, and never when the JSON-parse crash pattern already named the
      // cause — one exit has one cause (BUGS.md 2026-09-30).
      const streamSevered =
        !aborted && !timedOut && !quietKilled && !crashed && STREAM_SEVERED.test(stderr.trim());
      finish(
        resultFromParser({
          ok: !failed,
          transientPiCrash: crashed,
          transientBackend: parser.transientBackend || streamSevered,
          backendKind: parser.backendFailureKind ?? (streamSevered ? "stream-severed" : undefined),
          errorMessage: aborted
            ? "aborted by harness shutdown"
            : quietKilled
              ? `killed as hung: no pi progress for over ${opts.config.quietTimeoutSeconds}s`
              : timedOut
                ? timedOutProgressing
                  ? `timed out after ${opts.config.tickTimeoutSeconds}s while still making progress — session and worktree edits preserved for resume`
                  : `timed out after ${opts.config.tickTimeoutSeconds}s`
                : (parser.errorMessage ?? (failed ? stderr.trim().slice(-500) || `pi exited ${code}` : undefined)),
          // Kept distinct on purpose: a hung tool call leaves its session and worktree edits
          // intact, so the loop resumes them (quiet_killed) instead of discarding them as an
          // unfulfilled timeout does. A deadline that fired on a run still making progress
          // gets the same treatment (BUGS.md 2026-09-29).
          timedOut,
          timedOutProgressing: timedOut && timedOutProgressing,
          quietKilled,
        }),
      );
    });
  });
}
