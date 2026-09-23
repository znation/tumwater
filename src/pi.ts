import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { TumwaterConfig, PiRunResult } from "./types.js";
import { ensureDir, ensureParentDir, rotateIfLarge } from "./files.js";
import { agentBinSourceLabel, type ResolvedAgentBin } from "./readiness.js";
import { PiStreamParser } from "./pi-stream.js";

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
  /** Resume the most recent session in sessionDir instead of starting fresh. Used ONLY
   * for the within-tick transient retry (so the retry keeps the first attempt's partial
   * progress); every tick otherwise starts a fresh session, so context never accumulates
   * across ticks. */
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
}

/** Build the pi argv for one tick. Exported for tests. */
export function piArgs(
  opts: Pick<PiRunOptions, "config" | "sessionDir" | "sessionName" | "continueSession">,
): string[] {
  const { config } = opts;
  const args = ["--print", "--mode", "json", "--session-dir", opts.sessionDir];
  // Each role has its own session dir, so --continue resumes that role's session.
  if (opts.continueSession) args.push("--continue");
  else args.push("-n", opts.sessionName);
  if (config.provider) args.push("--provider", config.provider);
  if (config.model) args.push("--model", config.model);
  if (config.thinking) args.push("--thinking", config.thinking);
  args.push(...config.piArgs);
  return args;
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

/** Terminate a pi child and everything it started: SIGTERM to the process group now,
 * escalating to SIGKILL after 10 s if any of it is still alive. pi is spawned detached (its
 * own process group leader), so a negative PID reaches every tool-call grandchild — which a
 * single-PID kill leaves orphaned to launchd — while the harness's own group is never in the
 * blast radius. The escalation timer is unref'd so a clean exit does not keep the harness
 * process alive. Shared by the tick-timeout, quiet-watchdog, and harness-shutdown paths. */
function terminateChild(child: ChildProcess): void {
  signalTree(child, "SIGTERM");
  setTimeout(() => signalTree(child, "SIGKILL"), 10_000).unref();
}

/** Signal the child's whole process group, falling back to the child alone when the group is
 * already gone or the platform has no negative-PID kill (Windows). Never throws: a process
 * that died between the caller's decision and this call is the normal case. Shared with the
 * build check's process-group timeout (runScriptGroup in build-check.ts) — the same
 * "signal the tree, not just the direct child" guarantee in one home. */
export function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid == null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

/** Prefix of PiRunResult.errorMessage when the pi process never started (no session file
 * is created for such a run). The resolved binary follows it, so a configured agentBin
 * reads "failed to spawn <bin>" rather than blaming an ambient "pi". */
const SPAWN_ERROR_PREFIX = "failed to spawn";

/** Normalize a path-shaped agent binary against the harness process's cwd NOW, at
 * resolution time: the spawn runs with each tick's worktree as cwd, so a relative value
 * left as given would name a different file there than the run preflight and doctor (which
 * evaluate against the process cwd) had already accepted. An absolute path comes back
 * normalized; a bare name — no separator — is left for PATH resolution exactly as before.
 * No filesystem calls: the two preflight sites test resolvability, so resolution itself
 * stays trivially unit-testable. */
function absBin(value: string): string {
  return value.includes("/") ? path.resolve(value) : value;
}

/** Resolve which agent binary the harness spawns: TUMWATER_PI_BIN → config.agentBin →
 * "pi" (plans/portability.md §5/7). An empty or whitespace value falls through to the
 * next source, so `TUMWATER_PI_BIN= tumwater run` cannot wedge the fleet on a typo'd
 * export. This is precedence only — resolvability is checked at the preflight sites
 * (cmdRun and doctor), never here. */
export function resolveAgentBin(config: Pick<TumwaterConfig, "agentBin">): ResolvedAgentBin {
  const env = process.env.TUMWATER_PI_BIN?.trim();
  if (env) return { bin: absBin(env), source: "env" };
  const configured = config.agentBin?.trim();
  if (configured) return { bin: absBin(configured), source: "config" };
  return { bin: "pi", source: "default" };
}

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
    const parser = new PiStreamParser();
    // Decode stdout incrementally instead of per chunk: a raw Buffer.toString("utf8")
    // replaces any multi-byte character whose bytes straddle two 'data' events with U+FFFD,
    // corrupting that line's text (commit subjects, summaries, transcripts). StringDecoder
    // holds back the incomplete trailing bytes until the next chunk completes them.
    const decoder = new StringDecoder("utf8");
    let stderr = "";
    let timedOut = false;
    let settled = false;

    // plans/portability.md §5/7: the agent binary is configurable. resolveAgentBin
    // normalizes path-shaped values to absolute (against the process cwd), so the spawn —
    // which runs with the worktree as cwd — lands on the same file the preflight checked.
    const resolved = resolveAgentBin(opts.config);
    const child = spawn(resolved.bin, [...piArgs(opts), opts.prompt], {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      // Detached so pi leads its own process group: terminateChild signals the group, so a
      // killed tick's tool-call grandchildren die with it instead of leaking to launchd.
      detached: true,
    });

    const timeout = setTimeout(() => {
      timedOut = true;
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
    // had the chance to speak (BUGS.md 2026-09-23). Such a run gets one extra full quiet
    // window before the kill; once it has spoken, quietTimeoutSeconds applies unchanged.
    const allowedSilenceMs = () => (parser.progressCount > 0 ? quietMs : quietMs * 2);
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
      parser.feed(decoder.write(chunk), (line) => rawLog.write(line + "\n"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      // stderr is rare and meaningful (crash traces, warnings): treat it as progress.
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
      quietKilled: false,
      aborted,
      contextExceeded: parser.contextExceeded,
      transientServerTimeout: parser.transientServerTimeout,
      transientRateLimit: parser.transientRateLimit,
      retryAfterSeconds: parser.retryAfterSeconds,
      transientPiCrash: false,
      finalMessageContentless: parser.finalMessageContentless,
      compacted: parser.compacted,
      ...overrides,
    });

    child.on("error", (err) => {
      finish(resultFromParser({ errorMessage: spawnErrorMessage(resolved, err.message) }));
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
      finish(
        resultFromParser({
          ok: !failed,
          transientPiCrash: crashed,
          errorMessage: aborted
            ? "aborted by harness shutdown"
            : quietKilled
              ? `killed as hung: no pi progress for over ${opts.config.quietTimeoutSeconds}s`
              : timedOut
                ? `timed out after ${opts.config.tickTimeoutSeconds}s`
                : (parser.errorMessage ?? (failed ? stderr.trim().slice(-500) || `pi exited ${code}` : undefined)),
          // Kept distinct on purpose: a hung tool call leaves its session and worktree edits
          // intact, so the loop resumes them (quiet_killed) instead of discarding them as an
          // unfulfilled timeout does.
          timedOut,
          quietKilled,
        }),
      );
    });
  });
}
